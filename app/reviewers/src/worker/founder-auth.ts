// Inbox proof maps to the private server's exact founder digest, never a chosen
// principal. Founder challenges cannot create or recover reader identities.
import { clearFailures, guessKeys, reserveTry, waitWords } from "./attempts.ts";
import { CODE_MINUTES, codePage } from "./code-page.ts";
import { READER_COOKIE, cookie, emailCodeHash, newToken, randomId, sameText, sha256Hex } from "./session.ts";
import { founderSessionCookie } from './founder-password.ts';
import type { Env } from "./store.ts";
import { isWriter, writerList } from "./writers.ts";
import { message, redirect } from "./web.ts";

interface FounderCode {
  tokenHash: string; codeHash: string; founderKey: string | null; emailSha256: string;
  expiresAt: string; attempts: number; usedAt: string | null;
  generation: string;
}
const invalid = () => message("This code no longer works", "It expired, was used, or had too many guesses. Ask for a new code.", 410);
const codeHash = (env: Env, token: string, value: string) => emailCodeHash(env.SESSION_SECRET, "founder:" + token, value);

/** Undefined leaves the established reader sign-in path unchanged. */
export async function requestFounderCode(req: Request, env: Env, email: string): Promise<Response | undefined> {
  const digest = await sha256Hex(email);
  const rows = (await env.DB.prepare("SELECT key FROM founders WHERE emailSha256=?").bind(digest).all<{ key: string }>()).results;
  if (!rows.length) return undefined;
  if (!env.MAIL || !env.FROM_ADDRESS) return message("Email is unavailable", "Ask the person who invited you to try again later. No sign-in code can be sent right now.", 503);
  const wait = await reserveTry(env.DB, (await guessKeys(req, email)).map(k => `mail:${k}`));
  if (wait) return message("Too many requests", `Wait ${waitWords(wait)}, then try again.`, 429);
  const founder = rows.length === 1 && isWriter(env, rows[0].key) ? rows[0].key : null;
  const { token, hash } = await newToken();
  const now = Date.now(), at = new Date(now).toISOString();
  const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await env.DB.prepare("DELETE FROM founder_email_codes WHERE expiresAt < ?").bind(at).run();
  const credential = founder ? await env.DB.prepare('SELECT generation FROM founder_credentials WHERE founderKey=?').bind(founder).first<{ generation: string }>() : null;
  await env.DB.prepare("INSERT INTO founder_email_codes (tokenHash,codeHash,founderKey,emailSha256,expiresAt,generation) VALUES (?,?,?,?,?,?)")
    .bind(hash, await codeHash(env, token, founder ? digits : randomId("decoy", 32)), founder, digest, new Date(now + CODE_MINUTES * 60_000).toISOString(), credential?.generation ?? 'none').run();
  if (founder) {
    try {
      await env.MAIL.send({ from: { email: env.FROM_ADDRESS, name: "Descant" }, to: email, subject: "Your Descant sign-in code",
        text: `Your Descant code is ${digits}.\n\nEnter it on the page where you asked for it. It works once, for ${CODE_MINUTES} minutes.\n\nIf you did not ask for this code, ignore this email.` });
    } catch {
      // Even an eventually delivered failed send cannot leave a working code.
      // Its public answer stays identical to an unknown address's challenge.
      await env.DB.prepare("UPDATE founder_email_codes SET codeHash=?,founderKey=NULL WHERE tokenHash=?")
        .bind(await codeHash(env, token, randomId("decoy", 32)), hash).run();
    }
  }
  return codePage(token, "", 200, new URL(req.url).pathname);
}

/** Claim once, with the live unique key/digest mapping inside the SQL write. */
export async function verifyFounderCode(req: Request, env: Env, token: string, value: string, back: string): Promise<Response | undefined> {
  const hash = await sha256Hex(token);
  const found = await env.DB.prepare("SELECT tokenHash FROM founder_email_codes WHERE tokenHash=?").bind(hash).first();
  if (!found) return undefined;
  const at = new Date().toISOString();
  const valid = "tokenHash=? AND usedAt IS NULL AND expiresAt>? AND attempts<5";
  const live = await env.DB.prepare("SELECT emailSha256 FROM founder_email_codes WHERE " + valid).bind(hash, at).first<{ emailSha256: string }>();
  if (!live) return invalid();
  // The identity bucket survives requesting a new challenge or changing IP.
  // The IP bucket is shared with the established reader-code guess limit.
  const keys = (await guessKeys(req, live.emailSha256)).map(k => `code:${k}`);
  const wait = await reserveTry(env.DB, keys);
  if (wait) return codePage(token, `Too many tries. Wait ${waitWords(wait)}, then try again.`, 429, back);
  const row = await env.DB.prepare("UPDATE founder_email_codes SET attempts=attempts+1 WHERE " + valid + " RETURNING *")
    .bind(hash, at).first<FounderCode>();
  if (!row) return invalid();
  if (!sameText(row.codeHash, await codeHash(env, token, value))) return codePage(token, "That code does not match. Try again.", 401, back);
  let claimed: { founderKey: string } | null;
  const writer = writerList(env);
  try {
    claimed = await env.DB.prepare(
      `UPDATE founder_email_codes SET usedAt=? WHERE tokenHash=? AND codeHash=? AND usedAt IS NULL AND expiresAt>? AND attempts<=5
       AND founderKey IN ${writer.sql}
       AND EXISTS (SELECT 1 FROM founders WHERE key=founder_email_codes.founderKey AND emailSha256=founder_email_codes.emailSha256)
       AND generation=COALESCE((SELECT generation FROM founder_credentials WHERE founderKey=founder_email_codes.founderKey),'none')
       AND (SELECT COUNT(*) FROM founders WHERE emailSha256=founder_email_codes.emailSha256)=1 RETURNING founderKey`,
    ).bind(at, hash, row.codeHash, at, ...writer.keys).first<{ founderKey: string }>();
  } catch { return invalid(); }
  if (!claimed) return invalid();
  await clearFailures(env.DB, keys);
  const session = await founderSessionCookie(env, claimed.founderKey, true, row.generation, row.emailSha256);
  if (!session) return invalid();
  return redirect("/write/", [session, cookie(READER_COOKIE, "", 0)]);
}
