// Rate limits for code requests and guesses, shared across address and network keys.
const enc = new TextEncoder();

export const FREE_TRIES = 5;
const MAX_WAIT_S = 15 * 60;
const DAY_MS = 86_400_000;

export const waitSeconds = (failures: number): number => (failures < FREE_TRIES ? 0 : Math.min(2 ** (failures - FREE_TRIES + 1), MAX_WAIT_S));

// waitSeconds(count) as SQL, over the stored row's own count.
const WAIT_SQL = (() => {
  let sql = `CASE WHEN signin_failures.count < ${FREE_TRIES} THEN 0`;
  for (let n = FREE_TRIES; waitSeconds(n) < MAX_WAIT_S; n++) sql += ` WHEN signin_failures.count = ${n} THEN ${waitSeconds(n)}`;
  return sql + ` ELSE ${MAX_WAIT_S} END`;
})();

async function short(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The counters a try is judged by: the address typed and the network address. */
export async function guessKeys(req: Request, typed: string): Promise<string[]> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  return [`name:${await short(typed.trim().toLowerCase())}`, `ip:${await short(ip)}`];
}

/**
 * Counts one try against every key, or refuses it: 0 when the try may go ahead (and is now counted),
 * otherwise the seconds to wait. Each key is taken in ONE statement, an upsert that only updates when
 * the wait since that key's most recent try is over, so two parallel tries can never both take the last
 * free slot. Nothing is hashed and nothing more is written for a refused try.
 */
export async function reserveTry(db: D1Database, keys: string[], now = new Date()): Promise<number> {
  const ms = now.getTime();
  const dayAgo = ms - DAY_MS;
  for (const key of keys) {
    const taken = await db.prepare(
      `INSERT INTO signin_failures (key, count, lastAt, lastMs) VALUES (?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN signin_failures.lastMs < ? THEN 1 ELSE signin_failures.count + 1 END,
         lastAt = excluded.lastAt, lastMs = excluded.lastMs
       WHERE signin_failures.lastMs < ? OR ? >= signin_failures.lastMs + (${WAIT_SQL}) * 1000
       RETURNING count`,
    ).bind(key, now.toISOString(), ms, dayAgo, dayAgo, ms).first<{ count: number }>();
    if (!taken) {
      const row = await db.prepare("SELECT count, lastMs FROM signin_failures WHERE key = ?").bind(key).first<{ count: number; lastMs: number }>();
      return Math.max(1, Math.ceil(((row?.lastMs ?? ms) + waitSeconds(row?.count ?? 0) * 1000 - ms) / 1000));
    }
  }
  await db.prepare("DELETE FROM signin_failures WHERE lastMs < ?").bind(dayAgo).run();
  return 0;
}

export async function clearFailures(db: D1Database, keys: string[]): Promise<void> {
  await db.prepare(`DELETE FROM signin_failures WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).run();
}

/** "12 seconds", "3 minutes": how long a refused try must wait. */
export const waitWords = (s: number): string => (s < 90 ? `${s} ${s === 1 ? "second" : "seconds"}` : `${Math.ceil(s / 60)} minutes`);
