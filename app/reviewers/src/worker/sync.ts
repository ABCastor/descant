// The private server's side door. The private server calls these, outbound, with the shared token;
// nothing here ever calls it. Only the token's SHA-256 is configured (SHARE_TOKEN_SHA256), and a
// presented token is compared in constant time.
//
//   GET  /sync/state                 which articles are shared, who granted each, and the comment cursor
//   POST /sync/push                  every article's metadata; text and reader threads for shared ones
//   GET  /sync/comments?after=<n>    readers' comments and replies after the cursor
//   POST /sync/ack                   which of those are now in the repository (or could not be)
//   POST /sync/admin-link            a one-time founder link, 5 minutes

import { actionSync } from "./actions.ts";
import { sharing } from './sharing.ts';
import { ARTICLE_RE, carriesNotes, isTestArticle, testArticle } from "./rules.ts";
import { newToken, sameText, sha256Hex } from "./session.ts";
import { sharedPaths, type Env } from "./store.ts";
import { json } from "./web.ts";
import { WRITER_KEY, isWriter } from "./writers.ts";

export const FOUNDER_LINK_MINUTES = 5;
const PUSH_MAX = 8 * 1024 * 1024;
const TEXT_MAX = 1_500_000;
const PAGE = 100;
const FIELD = 20_000;

export async function authorised(req: Request, env: Env): Promise<boolean> {
  const want = (env.SHARE_TOKEN_SHA256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;          // no token configured: nobody
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{32,256})$/.exec(req.headers.get("Authorization") ?? "");
  if (!m) return false;
  return sameText(await sha256Hex(m[1]), want);
}

export async function syncRoute(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await authorised(req, env))) return json({ error: "unauthorized" }, 401);
  const route = url.pathname;
  if (["/sync/action","/sync/actions","/sync/actions/ack","/sync/action-state"].includes(route)) return actionSync(req,env,url);
  if (route === '/sync/sharing' && req.method === 'POST') return sharing(req,env,url);
  if (route === "/sync/state" && req.method === "GET") return state(env);
  if (route === "/sync/push" && req.method === "POST") return push(req, env);
  if (route === "/sync/comments" && req.method === "GET") return pull(env, url);
  if (route === "/sync/ack" && req.method === "POST") return ack(req, env);
  if (route === "/sync/admin-link" && req.method === "POST") return adminLink(req, env, url);
  return json({ error: "not-found" }, 404);
}

async function cursor(db: D1Database): Promise<number> {
  const r = await db.prepare(
    "SELECT COALESCE((SELECT MIN(seq) - 1 FROM comments WHERE syncedGen IS NULL), (SELECT MAX(seq) FROM comments), 0) AS c",
  ).first<{ c: number }>();
  return Number(r?.c ?? 0);
}

/** Who granted each shared article: the founders behind its grants and its live links. The private
 * server sends an article's text only when its current owner allows every one of them. */
async function grantedBy(db: D1Database): Promise<Record<string, string[]>> {
  const { results } = await db.prepare(
    `SELECT path, grantedBy AS who FROM grants
     UNION
     SELECT ia.path, i.createdBy FROM invite_articles ia JOIN invites i ON i.id = ia.inviteId
     WHERE i.revokedAt IS NULL AND i.usesLeft > 0 AND i.expiresAt > ?
     ORDER BY 1, 2`,
  ).bind(new Date().toISOString()).all<{ path: string; who: string }>();
  const out: Record<string, string[]> = {};
  for (const r of results) (out[r.path] ??= []).push(r.who);
  return out;
}

async function state(env: Env): Promise<Response> {
  return json({ shared: await sharedPaths(env.DB), grantedBy: await grantedBy(env.DB), cursor: await cursor(env.DB) });
}

function parseBody(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function bodyOf(req: Request, max: number): Promise<Record<string, unknown> | undefined> {
  const raw = await req.text();
  return raw.length > max ? undefined : parseBody(raw);
}

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

function threadOf(v: unknown, env: Env): string | undefined {
  // The thread exactly as the review file reads (serve.py comment_document), keeping only the
  // fields the page knows, each a string of bounded size.
  if (!v || typeof v !== "object") return undefined;
  const t = v as Record<string, unknown>;
  const a = (t.anchor && typeof t.anchor === "object" ? t.anchor : {}) as Record<string, unknown>;
  const s = (x: unknown) => str(x ?? "", FIELD) ?? "";
  const replies = Array.isArray(t.replies) ? t.replies : [];
  const display = (m: Record<string, unknown>) => ({
    ...(isWriter(env, m.principal) ? { principal:m.principal } : {}),
    ...(typeof m.model === 'string' && /^[A-Za-z0-9._:/+-]{1,80}$/.test(m.model) ? { model:m.model } : {}),
    ...(typeof m.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.color) ? { color:m.color } : {}),
  });
  return JSON.stringify({
    ...display(t), id: "",
    anchor: { quote: s(a.quote), prefix: s(a.prefix), suffix: s(a.suffix), blockText: s(a.blockText), version: s(a.version) },
    messageRef:s(t.messageRef),writer:s(t.writer),author: s(t.author), by: t.by === "agent" ? "agent" : t.by === "human" ? "human" : "", text: s(t.text), created: s(t.created),
    replies: replies.map((r) => {
      const m = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return { ...display(m), id:s(m.id),messageRef:s(m.messageRef),writer:s(m.writer),author: s(m.author), text: s(m.text), created: s(m.created), by: m.by === "agent" ? "agent" : m.by === "human" ? "human" : "", basis: s(m.basis), offer: null };
    }),
    done: !!t.done, status: s(t.status) || "open", note: s(t.note), reanchoredFrom: s(t.reanchoredFrom), refersTo: s(t.refersTo),
  });
}

// One JSON bind carries many rows without spending a statement per article.
// Keep each UTF-8 value below D1's 2 MB limit; oversized pushes are refused
// before the atomic batch, so the sender retains its last acknowledged state.
function jsonRows(rows: unknown[]): string[] | undefined {
  const chunks: string[] = [];
  let parts: string[] = [], size = 2;
  for (const row of rows) {
    const part = JSON.stringify(row), bytes = new TextEncoder().encode(part).length;
    if (bytes + 2 > 1_800_000) return undefined;
    if (size + bytes + 1 > 1_800_000 && parts.length) {
      chunks.push('[' + parts.join(',') + ']'); parts = []; size = 2;
    }
    parts.push(part); size += bytes + 1;
  }
  if (parts.length) chunks.push('[' + parts.join(',') + ']');
  return chunks;
}

/**
 * What the repository holds now. Metadata replaces the article list; text and threads are taken
 * only for articles that are shared at this moment, and an article no longer shared loses its text.
 */
async function push(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  const body = raw.length > PUSH_MAX ? undefined : parseBody(raw);
  if (!body || !Array.isArray(body.articles) || !Array.isArray(body.founders) || !Array.isArray(body.shared)) {
    return json({ error: "bad-request", detail: "founders, articles and shared must be lists" }, 400);
  }
  const db = env.DB;
  const founders = (body.founders as unknown[]).flatMap((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const key = str(o.key, 24);
    const name = str(o.name, 120);
    const mail = str(o.emailSha256, 64);
    return key && WRITER_KEY.test(key) && name !== undefined
      ? [{ key, name: name.trim(), emailSha256: mail && /^[0-9a-f]{64}$/.test(mail) ? mail : null }] : [];
  });
  const articles = (body.articles as unknown[]).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const path = str(o.path, 200);
    if (!path || !ARTICLE_RE.test(path)) return [];
    const order = typeof o.order === "number" && Number.isFinite(o.order) ? Math.trunc(o.order) : 0;
    return [{ path, title: str(o.title, 300) ?? path, owner: str(o.owner, 32) ?? "", status: str(o.status, 32) ?? "", phase: str(o.phase, 32) ?? "", order }];
  });
  if (!founders.length || !articles.length) return json({ error: "bad-request", detail: "no founders or no articles" }, 400);

  // A complete push whose validated bytes and worker-shared state are the last stored ones changes nothing.
  // The digest of those bytes combined with current sharing tuples is the marker, and the stable counts
  // were stored with the push that made the state.
  const sharing = await grantedBy(db);
  const sharedNow = Object.keys(sharing).sort();
  // The test article is policy the push applies, so a changed TEST_ARTICLE is a real push.
  const digest = await sha256Hex(raw + ":" + JSON.stringify(sharing) + ":" + testArticle(env));
  const expectedSharing = Object.entries(sharing).flatMap(([path, people]) => people.map(who => [path, who]));
  const marker = await db.prepare(
    `WITH current_sharing AS (
      SELECT path,grantedBy AS who FROM grants UNION
      SELECT ia.path,i.createdBy FROM invite_articles ia JOIN invites i ON i.id=ia.inviteId
      WHERE i.revokedAt IS NULL AND i.usesLeft>0 AND i.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ), expected_sharing AS (SELECT json_extract(value,'$[0]') AS path,json_extract(value,'$[1]') AS who FROM json_each(?))
    SELECT (SELECT value FROM sync_meta WHERE key='pushHash') AS hash,
      (SELECT value FROM sync_meta WHERE key='pushSummary') AS summary,
      NOT(EXISTS(SELECT path,who FROM current_sharing EXCEPT SELECT path,who FROM expected_sharing) OR
          EXISTS(SELECT path,who FROM expected_sharing EXCEPT SELECT path,who FROM current_sharing)) AS sharingUnchanged`,
  ).bind(JSON.stringify(expectedSharing)).first<{ hash: string | null; summary: string | null; sharingUnchanged: number }>();
  if (marker?.hash === digest && !marker.sharingUnchanged) return json({error:'sharing-changed'},409);
  if (marker?.hash === digest && marker.sharingUnchanged) {
    try {
      const summary = JSON.parse(marker.summary ?? "") as { articles?: unknown; texts?: unknown; refused?: unknown };
      if (Number.isSafeInteger(summary.articles) && Number.isSafeInteger(summary.texts) && Array.isArray(summary.refused))
        return json({ ok: true, articles: summary.articles, texts: summary.texts, refused: summary.refused });
    } catch {
      // A damaged marker falls through to a real push.
    }
  }

  // First what the repository says now: the founders, the articles and their owners. A grant or a
  // live link that the article's CURRENT owner would not allow (it became another founder's, or it
  // left the repository) goes with it, before anything below decides what is shared.
  // The space's test article is pruned too: never shared, whatever a grant says.
  const test = testArticle(env);
  const notAllowed = `SELECT path FROM articles a WHERE a.path = %s AND a.owner NOT IN ('', 'unassigned', 'both') AND a.owner <> %s`;
  // A revoke, grant or invite expiry between the read and this transaction must
  // abort this push rather than retain text on a sharing decision that expired.
  // The existing gen key deliberately rejects a stale-sharing guard by uniqueness.
  const sharingGuard = db.prepare(`WITH current_sharing AS (
    SELECT path, grantedBy AS who FROM grants UNION
    SELECT ia.path, i.createdBy FROM invite_articles ia JOIN invites i ON i.id=ia.inviteId
    WHERE i.revokedAt IS NULL AND i.usesLeft>0 AND i.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  ), expected_sharing AS (
    SELECT json_extract(value,'$[0]') AS path, json_extract(value,'$[1]') AS who FROM json_each(?)
  ) INSERT INTO sync_meta (key,value) SELECT 'gen','0' WHERE
    EXISTS (SELECT path,who FROM current_sharing EXCEPT SELECT path,who FROM expected_sharing) OR
    EXISTS (SELECT path,who FROM expected_sharing EXCEPT SELECT path,who FROM current_sharing)`)
    .bind(JSON.stringify(expectedSharing));
  const founderRows = jsonRows(founders), articleRows = jsonRows(articles);
  const articlePaths = JSON.stringify(articles.map(a => a.path));
  if (!founderRows || !articleRows || new TextEncoder().encode(articlePaths).length > 1_800_000)
    return json({ error:'push-too-large' },413);
  const stmts: D1PreparedStatement[] = [
    sharingGuard,
    db.prepare("DELETE FROM founders"),
    ...founderRows.map(rows => db.prepare("INSERT INTO founders (key,name,emailSha256) SELECT json_extract(value,'$.key'),json_extract(value,'$.name'),json_extract(value,'$.emailSha256') FROM json_each(?)").bind(rows)),
    db.prepare("DELETE FROM articles WHERE path NOT IN (SELECT value FROM json_each(?))").bind(articlePaths),
    ...articleRows.map(rows => db.prepare(`INSERT INTO articles (path,title,owner,status,phase,ord,markdown,versionSha,versionWhen)
      SELECT json_extract(value,'$.path'),json_extract(value,'$.title'),json_extract(value,'$.owner'),json_extract(value,'$.status'),json_extract(value,'$.phase'),json_extract(value,'$.order'),NULL,NULL,NULL FROM json_each(?) WHERE true
      ON CONFLICT(path) DO UPDATE SET title=excluded.title,owner=excluded.owner,status=excluded.status,phase=excluded.phase,ord=excluded.ord`).bind(rows)),
    db.prepare(`DELETE FROM grants WHERE path NOT IN (SELECT path FROM articles) OR (? <> '' AND instr(path, ?) = 1) OR EXISTS (${notAllowed.replace("%s", "grants.path").replace("%s", "grants.grantedBy")})`)
      .bind(test, test),
    db.prepare(`DELETE FROM invite_articles WHERE path NOT IN (SELECT path FROM articles) OR (? <> '' AND instr(path, ?) = 1) OR EXISTS (${notAllowed.replace("%s", "invite_articles.path").replace("%s", "(SELECT createdBy FROM invites WHERE id = invite_articles.inviteId)")})`)
      .bind(test, test),
  ];

  const known = new Set(articles.map((a) => a.path));
  // Apply the same ownership rule the pruning statements use, without committing
  // metadata before text. The whole logical push is one atomic D1 batch.
  const incoming = new Map(articles.map(a => [a.path,a]));
  const shared = new Set(sharedNow.filter(p => {
    const article = incoming.get(p);
    return known.has(p) && !isTestArticle(env, p) && article && (sharing[p] || []).some(who =>
      !article.owner || ['unassigned','both'].includes(article.owner) || article.owner === who);
  }));
  const { results: ours } = await db.prepare("SELECT id, path FROM threads").all<{ id: number; path: string }>();
  const threadPath = new Map(ours.map((t) => [String(t.id), t.path]));
  stmts.push(db.prepare("UPDATE sync_meta SET value = value + 1 WHERE key = 'gen'"));
  const texts = new Set<string>();
  const snapshots: { id: number; path: string; thread: string }[] = [];
  const textRows: { path: string; markdown: string; sha: string | null; when: string | null }[] = [];
  const refused: string[] = [];
  for (const x of body.shared as unknown[]) {
    const o = (x ?? {}) as Record<string, unknown>;
    const path = str(o.path, 200);
    const markdown = str(o.markdown, TEXT_MAX);
    if (!path || markdown === undefined || !shared.has(path) || texts.has(path)) continue;   // never kept for an unshared article
    // The private server strips internal notes before it sends; one that is still there means the
    // text is not fit to leave, so it is not kept at all.
    if (carriesNotes(markdown)) {
      refused.push(path);
      continue;
    }
    texts.add(path);
    const v = (o.version ?? {}) as Record<string, unknown>;
    const sha = str(v.sha, 64);
    textRows.push({ path, markdown, sha:sha && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null, when:str(v.when,40) ?? null });
    for (const item of Array.isArray(o.threads) ? (o.threads as unknown[]) : []) {
      const t = (item ?? {}) as Record<string, unknown>;
      const id = str(t.descant, 20);
      const thread = threadOf(t.thread, env);
      // Only a thread a reader started here, on this article.
      if (!id || !thread || threadPath.get(id) !== path) continue;
      snapshots.push({ id: Number(id), path, thread });
    }
  }
  const keep = [...texts], keepJson = JSON.stringify(keep);
  const encodedTexts = jsonRows(textRows), encodedSnapshots = jsonRows(snapshots);
  if (!encodedTexts || !encodedSnapshots || new TextEncoder().encode(keepJson).length > 1_800_000)
    return json({ error:'push-too-large' },413);
  for (const rows of encodedTexts) stmts.push(db.prepare(`UPDATE articles SET
    markdown=json_extract(v.value,'$.markdown'),versionSha=json_extract(v.value,'$.sha'),versionWhen=json_extract(v.value,'$.when')
    FROM json_each(?) v WHERE articles.path=json_extract(v.value,'$.path')`).bind(rows));
  stmts.push(db.prepare("DELETE FROM snapshots WHERE path IN (SELECT value FROM json_each(?))").bind(keepJson));
  for (const rows of encodedSnapshots) stmts.push(db.prepare(`INSERT OR REPLACE INTO snapshots(threadId,path,thread,gen)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.path'),json_extract(value,'$.thread'),(SELECT value FROM sync_meta WHERE key='gen') FROM json_each(?)`).bind(rows));
  // An article not shared now keeps no text and no thread copies.
  stmts.push(db.prepare("UPDATE articles SET markdown=NULL,versionSha=NULL,versionWhen=NULL WHERE path NOT IN (SELECT value FROM json_each(?))").bind(keepJson));
  stmts.push(db.prepare("DELETE FROM snapshots WHERE path NOT IN (SELECT value FROM json_each(?))").bind(keepJson));
  stmts.push(db.prepare("INSERT INTO sync_meta (key, value) VALUES ('pushHash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(digest));
  stmts.push(db.prepare("INSERT INTO sync_meta (key, value) VALUES ('pushSummary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ articles: articles.length, texts: keep.length, refused })));
  // Three reads preceded this transaction. Never execute an over-quota prefix.
  if (stmts.length + 3 > 50) return json({ error:'push-too-large' },413);
  await db.batch(stmts);
  return json({ ok: true, articles: articles.length, texts: keep.length, refused });
}

async function pull(env: Env, url: URL): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!Number.isSafeInteger(after) || after < 0) return json({ error: "bad-request", detail: "after must be a whole number" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT c.seq, c.id, c.kind, c.threadId, t.path, c.name, c.email, c.color, c.created, c.text, c.anchor, c.refersTo, c.syncedGen, r.clientId
     FROM comments c JOIN threads t ON t.id = c.threadId LEFT JOIN client_receipts r ON r.commentId=c.id WHERE c.seq > ? ORDER BY c.seq LIMIT ?`,
  ).bind(after, PAGE + 1).all<{ seq: number; id: string; kind: string; threadId: number; path: string; name: string; email: string; color: string | null; created: string; text: string; anchor: string | null; refersTo: string | null; syncedGen: number | null; clientId?:string }>();
  const page = results.slice(0, PAGE);
  return json({
    comments: page.map((c) => ({
      seq: c.seq, id: c.id, ...(url.searchParams.get('identities')==='1'?{clientId:c.clientId}:{}), kind: c.kind, thread: String(c.threadId), path: c.path,
      author: { name: c.name, email: c.email, ...(typeof c.color === "string" && /^#[0-9a-fA-F]{6}$/.test(c.color) ? { color:c.color } : {}) }, created: c.created, text: c.text,
      ...(c.kind === "thread" ? { anchor: JSON.parse(c.anchor ?? "{}"), refersTo: c.refersTo ?? "" } : {}),
      synced: c.syncedGen !== null,
    })),
    more: results.length > PAGE,
  });
}

async function ack(req: Request, env: Env): Promise<Response> {
  const body = await bodyOf(req, 256 * 1024);
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^c[0-9a-f]{32}$/.test(x)).slice(0, 1000) : []);
  if (!body) return json({ error: "bad-request" }, 400);
  const stored = ids(body.stored);
  const refused = ids(body.refused);
  const db = env.DB;
  const mark = (list: string[], flag: number) => {
    const chunks: D1PreparedStatement[] = [];
    for (let offset = 0; offset < list.length; offset += 99) {
      const chunk = list.slice(offset, offset + 99);
      chunks.push(db.prepare(`UPDATE comments SET syncedGen = (SELECT value FROM sync_meta WHERE key='gen'), refused = ? WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(flag, ...chunk));
    }
    return chunks;
  };
  const stmts = [...mark(stored, 0), ...mark(refused, 1)];
  if (stmts.length) {
    stmts.push(db.prepare("DELETE FROM sync_meta WHERE key='pushHash'"));
    await db.batch(stmts);
  }
  return json({ ok: true, cursor: await cursor(db) });
}

async function adminLink(req: Request, env: Env, url: URL): Promise<Response> {
  const body = await bodyOf(req, 4096);
  const founder = typeof body?.founder === "string" ? body.founder : "";
  const known = founder && WRITER_KEY.test(founder)
    ? await env.DB.prepare("SELECT f.key,f.emailSha256,COALESCE(c.generation,'none') AS generation FROM founders f LEFT JOIN founder_credentials c ON c.founderKey=f.key WHERE f.key=? AND (SELECT COUNT(*) FROM founders WHERE emailSha256=f.emailSha256)=1").bind(founder).first<{ key: string; emailSha256: string; generation: string }>()
    : null;
  if (!known) return json({ error: "unknown-founder", detail: "That founder is not one the last push named." }, 400);
  const { token, hash } = await newToken();
  const now = new Date();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM onetime WHERE expiresAt < ?").bind(now.toISOString()),
    env.DB.prepare("INSERT INTO onetime (tokenHash,kind,subject,createdBy,createdAt,expiresAt,founderEmailSha256,founderGeneration) SELECT ?, 'founder', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM founders WHERE key=? AND emailSha256=?) AND COALESCE((SELECT generation FROM founder_credentials WHERE founderKey=?),'none')=?")
      .bind(hash, founder, founder, now.toISOString(), new Date(now.getTime() + FOUNDER_LINK_MINUTES * 60_000).toISOString(),known.emailSha256,known.generation,founder,known.emailSha256,founder,known.generation),
  ]);
  if (inserted.meta.changes !== 1) return json({error:"founder-changed"},409);
  return json({ url: `${(env.APP_URL || url.origin).replace(/\/$/, "")}/founder/${token}`, minutes: FOUNDER_LINK_MINUTES });
}
