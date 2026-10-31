// The reviewer API, for a signed-in reader: the same requests and answers as serve.py's
// ReviewerHandler, so the founders' own page runs unchanged in its reviewer mode. A reader lists
// and reads only the articles granted to them, sees only the threads they started (with every
// reply in them), starts a thread and replies; anything else is 404.

import {
  AFFIX_MAX, ARTICLE_RE, BLOCK_MAX, FRESH_MAX, PER_DAY, PER_MINUTE, QUOTE_MAX, REFERS_MAX, THREADS_PER_ARTICLE, VERSION_MAX,
  Refused, plain, readerMessage, readerString, wordsOf, foldEmail,
} from "./rules.ts";
import { actionRoute, metadata } from "./actions.ts";
import { randomId, sha256Hex } from "./session.ts";
import { clientReceipts, mayRead, pyIso, readable, readerThreads, type Anchor, type ClientReceipt, type LegacyMessage, type Env, type Person, type Thread } from "./store.ts";
import { json, sameSite } from "./web.ts";
import { isWriter } from "./writers.ts";

const BODY_MAX = 2 * 1024 * 1024;

export async function readerApi(req: Request, env: Env, url: URL, person: Person): Promise<Response> {
  const path = url.pathname;
  if (req.method === "GET") {
    if (path === "/api/whoami") {
      // A navigation hint, never a founder credential. The writer authenticates afresh.
      const founders = env.WRITER_ORIGIN ? (await env.DB.prepare("SELECT key FROM founders WHERE emailSha256=?")
        .bind(await sha256Hex(foldEmail(person.email))).all<{ key: string }>()).results : [];
      const writingApp = founders.length === 1 && isWriter(env, founders[0].key);
      return json({ role: "reviewer", name: person.name, id: person.id, ...(person.color ? { color: person.color } : {}), ...(writingApp ? { writingApp: true } : {}) });
    }
    if (path === "/api/pieces") return pieces(env, person);
    const asked = url.searchParams.getAll("path");
    // One path, or none: a second parameter must not smuggle another article past the check.
    const piecePath = asked.length === 1 && ARTICLE_RE.test(asked[0]) ? asked[0] : "";
    if (path === "/api/piece") return piece(env, person, piecePath);
    if (path === "/api/comments") return comments(env, person, piecePath, url.searchParams.get("actions") === "1");
  }
  if (req.method === "POST" && path === "/api/profile") return profile(req, env, person);
  if (req.method === "POST" && path === "/api/comments/action") return actionRoute(req,env,{kind:"reader",id:person.id},person);
  if (req.method === "POST" && path === "/api/comments") return post(req, env, person);
  return json({ ok: false, reason: "not-found", error: "Not found." }, 404);
}

async function profile(req: Request, env: Env, person: Person): Promise<Response> {
  const refuse = (status: number, reason: string) => json({ ok: false, reason }, status);
  if ((req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return refuse(415, "json-only");
  if (!sameSite(req)) return refuse(403, "cross-site");
  const raw = await req.text();
  if (raw.length > 4096) return refuse(400, "bad-profile");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return refuse(400, "bad-profile"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse(400, "bad-profile");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.reviewer_id !== "string" || !body.reviewer_id ||
      typeof body.color !== "string" || body.color.length !== 7 || !/^#[A-Fa-f0-9]{6}$/.test(body.color)) return refuse(400, "bad-profile");
  if (body.reviewer_id !== person.id) return refuse(409, "reviewer-identity-mismatch");
  const result = await env.DB.prepare("UPDATE people SET color=? WHERE id=?").bind(body.color, person.id).run();
  if (!result.meta.changes) return refuse(409, "profile-unavailable");
  return json({ ok: true, id: person.id, color: body.color });
}

function legacyView(threads:Thread[]):Thread[] { return threads.map(t=>{const copy:any={...t,replies:t.replies.map(r=>{const m:any={...r};delete m.actions;delete m.messageRef;delete m.writer;return m;})};delete copy.actions;delete copy.statusActions;delete copy.messageRef;delete copy.writer;return copy;}); }
const notShared = () => json({ ok: false, reason: "not-found", error: "There is no such article here." }, 404);

async function pieces(env: Env, person: Person): Promise<Response> {
  const list = await readable(env.DB, person.id);
  return json(list.map((a) => ({
    path: a.path, folder: a.path.replace(/\/article\.md$/, ""), title: a.title, order: a.ord,
    status: a.status, phase: a.phase, owner: a.owner, locked: true,
  })));
}

async function piece(env: Env, person: Person, path: string): Promise<Response> {
  const a = path ? await mayRead(env.DB, person.id, path) : undefined;
  if (!a || a.markdown === null) return notShared();
  const sha = a.versionSha ?? "";
  const id = sha ? sha.slice(0, 12) : "shared";
  // One version: the text as shared. The history of saves stays on the private server.
  const version = { id, sha, label: "as shared", author: "the writer", when: a.versionWhen ?? "", summary: "", markdown: a.markdown };
  return json({
    path: a.path, title: a.title, folder: a.path.replace(/\/article\.md$/, ""), markdown: a.markdown,
    versions: [version], current: id, files: [], pieces: [a.title], locked: true,
  });
}

async function comments(env: Env, person: Person, path: string, actions=false): Promise<Response> {
  if (!path || !(await mayRead(env.DB, person.id, path))) return notShared();
  const actor={kind:"reader" as const,id:person.id};
  const threads=await readerThreads(env.DB,person.id,path,actions?actor:undefined);
  return json(actions?{threads,commentActions:await metadata(env,actor,path)}:legacyView(threads));
}

// --------------------------------------------------------------- comparing what the page sent

const by = (v: unknown) => (v === "agent" ? "agent" : v === "human" ? "human" : "");

function status(t: Record<string, unknown>): string {
  const done = !!t.done;
  const raw = plain(t.status).trim().toLowerCase();
  if (done && raw === "open") return "answered";
  if (!done) return "open";
  return raw || "answered";
}

function anchorFrom(v: unknown): Anchor {
  const a = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { quote: plain(a.quote), prefix: plain(a.prefix), suffix: plain(a.suffix), blockText: plain(a.blockText), version: plain(a.version) };
}

/** serve.py canonical_comment(), less the replies and the id: what an existing thread must still say. */
function head(t: Record<string, unknown> | Thread): string {
  const r = t as Record<string, unknown>;
  const s = status(r);
  return JSON.stringify({
    anchor: anchorFrom(r.anchor), author: plain(r.author) || "You", by: by(r.by), text: plain(r.text),
    created: plain(r.created), done: s !== "open", status: s, note: plain(r.note),
    reanchoredFrom: plain(r.reanchoredFrom), refersTo: plain(r.refersTo),
  });
}

function reply(v: unknown): string {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return JSON.stringify({ author: plain(r.author) || "You", text: plain(r.text), created: plain(r.created), by: by(r.by), basis: plain(r.basis), offer: r.offer ?? null });
}

interface NewMessage { text: string; clientId: string; payload: string }
interface NewThread extends NewMessage { id: number; anchor: Anchor; refersTo: string; replies: NewMessage[] }
interface NewReply extends NewMessage { threadId: number }

function clientId(v: unknown): string {
  return readerString(v, 200, "the message identity");
}
function rootPayload(t: Record<string, unknown>): string {
  return JSON.stringify({ anchor: anchorFrom(t.anchor), text: readerMessage(t.text), author: plain(t.author) || "You", by: by(t.by), refersTo: plain(t.refersTo) });
}
function replyPayload(v: unknown): string {
  const r = v && typeof v === "object" ? v as Record<string, unknown> : {};
  return JSON.stringify({ text: readerMessage(r.text), author: plain(r.author) || "You", by: by(r.by), basis: plain(r.basis), offer: r.offer ?? null });
}

async function post(req: Request, env: Env, person: Person): Promise<Response> {
  const refuse = (status: number, reason: string, error: string) => json({ ok: false, reason, error }, status);
  // Only the reader page itself can post: a form or a no-cors fetch from another site cannot send
  // application/json without a preflight, which is never answered, and the Origin must be ours.
  const kind = (req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (kind !== "application/json") return refuse(415, "json-only", "comments are sent as application/json");
  if (!sameSite(req)) return refuse(403, "cross-site", "a comment can only come from the reader page itself");
  const raw = await req.text();
  if (raw.length > BODY_MAX) return refuse(413, "too-long", "that save is too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return refuse(400, "bad-request", "the body is not JSON");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.threads) || body.threads.length > 500) {
    return refuse(400, "bad-request", "threads must be one complete list");
  }
  if (body.reviewer_id !== person.id) {
    return refuse(403, "reviewer-identity-mismatch", "Sign in as the original reader to send these comments. Your words stay on this device.");
  }
  const path = typeof body.path === "string" && ARTICLE_RE.test(body.path) ? body.path : "";
  const article = path ? await mayRead(env.DB, person.id, path) : undefined;
  if (!article) return refuse(404, "not-found", "There is no such article here.");
  const words = wordsOf(article.markdown ?? "");

  let current = new Map((await readerThreads(env.DB, person.id, path, undefined, true)).map((t) => [t.id, t]));
  const receipts = new Map((await clientReceipts(env.DB, person.id, path)).map((r) => [r.clientId, r]));
  // A commit between these reads can expose its receipt after an empty root
  // list. Reread once rather than refusing a valid acknowledgement.
  if ([...receipts.values()].some(r => !current.has(String(r.threadId)))) {
    current = new Map((await readerThreads(env.DB, person.id, path, undefined, true)).map(t => [t.id, t]));
  }
  const seenMessages = new Set<string>();
  const seen = new Set<string>();
  const fresh: NewThread[] = [];
  const replies: NewReply[] = [];
  let count = 0;
  function bound(id: string, kind: ClientReceipt["kind"], payload: string, threadId?: number): ClientReceipt | undefined {
    if (!id) return;
    if (seenMessages.has(id)) throw new Refused(409, "duplicate-message", "the submitted list repeats a message identity");
    seenMessages.add(id);
    const receipt = receipts.get(id);
    if (receipt && (receipt.kind !== kind || receipt.payload !== payload || (threadId !== undefined && receipt.threadId !== threadId))) {
      throw new Refused(409, "client-replay-conflict", "This message identity already belongs to different words. Your words remain on this device.");
    }
    return receipt;
  }
  function separate(value: unknown, kind: "thread" | "reply", candidates: { thread: Thread; message?: Thread["replies"][number]; index?: number; original?: LegacyMessage }[]): void {
    const intent = value && typeof value === "object" ? (value as Record<string, unknown>).legacyReconciliation : null;
    if (!candidates.length && !intent) return;
    const candidate = intent && typeof intent === "object" ? (intent as Record<string, unknown>).candidate : null;
    const c = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    const matches = candidates.some(was => {
      if (was.original && JSON.stringify(c.original) !== JSON.stringify(was.original)) return false;
      if (kind === "thread") {
        const t = c.thread && typeof c.thread === "object" ? c.thread as Record<string, unknown> : {};
        return c.kind === kind && plain(t.id) === was.thread.id && head(t) === head(was.thread);
      }
      return c.kind === kind && c.threadId === was.thread.id && c.index === was.index && reply(c.message) === reply(was.message);
    });
    if (!matches) throw new Refused(409, "legacy-reconciliation-required", "Choose how to reconcile the saved and pending words in Comments. Both copies remain on your device.");
  }
  function newReply(value: unknown, threadId: number): NewReply | undefined {
    const r = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const id = clientId(r.id), payload = replyPayload(r);
    if (bound(id, "reply", payload, threadId)) return;
    const saved = current.get(String(threadId));
    separate(r, "reply", (saved?.legacyMessages ?? []).filter(m => m.kind === "reply" && m.author === person.name && m.text === readerMessage(r.text))
      .map(original => ({ thread: saved!, message: { ...original, basis: "", offer: null }, index: -1, original })));
    return { threadId, text: readerMessage(r.text), clientId: id, payload };
  }
  try {
    for (const item of body.threads as unknown[]) {
      if (!item || typeof item !== "object") throw new Refused(400, "bad-request", "each thread must be an object");
      const t = item as Record<string, unknown>;
      const id = plain(t.id);
      if (seen.has(id)) throw new Refused(409, "duplicate-thread", "the submitted list repeats thread " + id);
      seen.add(id);
      const list = Array.isArray(t.replies) ? (t.replies as unknown[]) : [];
      if (/^\d+$/.test(id)) {
        const was = current.get(id);
        if (!was) throw new Refused(409, "unknown-thread", `thread ${id} is not one of yours`);
        // An existing thread may only grow: every field and every earlier reply exactly as it is.
        const kept = was.replies.map(reply);
        const matches = (value: unknown, i: number) => {
          if (reply(value) === kept[i]) return true;
          const incoming = value && typeof value === "object" ? value as Record<string, unknown> : {};
          const replyId = clientId(incoming.id), saved = was.replies[i];
          const receipt = replyId && receipts.get(replyId);
          return !!receipt && saved.id === replyId && receipt.kind === "reply" && receipt.threadId === Number(id) && receipt.payload === replyPayload(incoming);
        };
        if (head(t) !== head(was) || list.length < kept.length || kept.some((r, i) => !matches(list[i], i))) {
          throw new Refused(403, "reviewer-cannot-edit", "A reader can start a comment or add a reply. What is already written stays as it is.");
        }
        // Existing prefix IDs are also reserved, so a duplicate cannot be appended.
        for (const r of list.slice(0, kept.length)) {
          const identity = clientId((r as Record<string, unknown> | null)?.id);
          if (identity) {
            if (seenMessages.has(identity)) throw new Refused(409, "duplicate-message", "the submitted list repeats a message identity");
            seenMessages.add(identity);
          }
        }
        for (const r of list.slice(kept.length)) {
          const added = newReply(r, Number(id));
          if (added) { replies.push(added); count++; }
        }
      } else {
        const identity = clientId(t.clientId || id), payload = rootPayload(t);
        const receipt = bound(identity, "thread", payload);
        if (receipt) {
          if (!current.has(String(receipt.threadId))) throw new Refused(409, "unknown-thread", "the original thread is unavailable");
          for (const r of list) {
            const added = newReply(r, receipt.threadId);
            if (added) { replies.push(added); count++; }
          }
          if (count > FRESH_MAX) throw new Refused(413, "too-many", `that is more than ${FRESH_MAX} new comments and replies in one save`);
          continue;
        }
        separate(t, "thread", [...current.values()].flatMap(thread => (thread.legacyMessages ?? []).filter(m => m.kind === "thread" && m.author === person.name &&
          m.text === readerMessage(t.text) && JSON.stringify(m.anchor) === JSON.stringify(anchorFrom(t.anchor))).map(original => ({ thread, original }))));
        const a = anchorFrom(t.anchor);
        const anchor: Anchor = {
          quote: readerString(a.quote, QUOTE_MAX, "the quoted passage"), prefix: readerString(a.prefix, AFFIX_MAX, "the words before it"),
          suffix: readerString(a.suffix, AFFIX_MAX, "the words after it"), blockText: readerString(a.blockText, BLOCK_MAX, "its paragraph"),
          version: readerString(a.version, VERSION_MAX, "the version"),
        };
        // A comment is on words of this article: a quote that is not in its text is refused.
        const quoted = wordsOf(anchor.quote);
        if (quoted && !words.includes(quoted)) {
          throw new Refused(400, "quote-not-found", "the words this comment is on are not in the article");
        }
        const threadId = newThreadId();
        fresh.push({
          id: threadId, anchor, text: readerMessage(t.text), clientId: identity, payload,
          refersTo: readerString(t.refersTo, REFERS_MAX, "what the comment points at"),
          replies: list.map((r) => newReply(r, threadId)).filter((r): r is NewReply => !!r),
        });
        count += 1 + list.length;
      }
      if (count > FRESH_MAX) throw new Refused(413, "too-many", `that is more than ${FRESH_MAX} new comments and replies in one save`);
    }
  } catch (err) {
    if (err instanceof Refused) return refuse(err.status, err.reason, err.message);
    throw err;
  }
  if (!count) return json({ ok: true, threads: legacyView([...current.values()]), changed: 0 });

  const now = new Date();
  const at = now.toISOString();
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const stamp = pyIso(now);
  const today = stamp.slice(0, 10);
  const db = env.DB;
  // The limits are checked INSIDE each insert, in the same statement: over a limit, the insert writes
  // NULL into a NOT NULL column, the statement fails, and the whole save rolls back. Two parallel
  // saves cannot both pass a count that only one of them fits under.
  const stmts: D1PreparedStatement[] = [];
  const receiptStatements: D1PreparedStatement[] = [];
  const insert = (threadId: number, kind: "thread" | "reply", message: NewMessage, created: string, anchor: Anchor | null, refersTo: string | null) => {
    const commentId = randomId("c", 16);
    stmts.push(db.prepare(
      `INSERT INTO comments (id, threadId, kind, personId, name, email, color, text, anchor, refersTo, created, createdAt)
       SELECT ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN (SELECT COUNT(*) FROM comments WHERE personId = ? AND createdAt > ?) < ${PER_MINUTE}
               AND (SELECT COUNT(*) FROM comments WHERE personId = ? AND createdAt > ?) < ${PER_DAY} THEN ? ELSE NULL END,
         ?, ?, ?, ?`,
    ).bind(commentId, threadId, kind, person.id, person.name, person.email, person.color ?? null, person.id, minuteAgo, person.id, dayAgo, message.text,
      anchor ? JSON.stringify(anchor) : null, refersTo, created, at));
    if (message.clientId) receiptStatements.push(db.prepare("INSERT INTO client_receipts (personId, path, clientId, kind, threadId, commentId, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(person.id, path, message.clientId, kind, threadId, commentId, message.payload));
  };
  for (const t of fresh) {
    stmts.push(db.prepare(
      `INSERT INTO threads (id, path, personId, createdAt)
       SELECT ?, CASE WHEN (SELECT COUNT(*) FROM threads WHERE personId = ? AND path = ?) < ${THREADS_PER_ARTICLE} THEN ? ELSE NULL END, ?, ?`,
    ).bind(t.id, person.id, path, path, person.id, at));
    insert(t.id, "thread", t, stamp, t.anchor, t.refersTo);
    for (const r of t.replies) insert(t.id, "reply", r, today, null, null);
  }
  for (const r of replies) insert(r.threadId, "reply", r, today, null, null);
  try {
    // Reserve identities before charging quota: a concurrent exact retry must
    // hit its unique receipt first, even when the first save filled the quota.
    await db.batch(receiptStatements.concat(stmts));
  } catch (err) {
    const why = String(err);
    // A parallel save may have committed the same identity after our read. Its
    // unique receipt rolls this entire batch back. Retry in a fresh invocation:
    // rereading and writing again here can exceed the per-request database limit.
    if (why.includes("client_receipts.personId")) {
      return refuse(409, "concurrent-save", "Another save arrived at the same time. Retry these exact comments; your words remain on this device.");
    }
    if (why.includes("threads.path")) {
      return refuse(429, "too-many-threads", `You have started ${THREADS_PER_ARTICLE} threads on this article, which is as many as one reader can.`);
    }
    if (why.includes("comments.text")) {
      return refuse(429, "slow-down", `That is more than ${PER_MINUTE} comments in a minute, or ${PER_DAY} in a day. Wait, then send it again.`);
    }
    throw err;
  }
  return json({ ok: true, threads: legacyView(await readerThreads(db, person.id, path, undefined, true)), changed: fresh.length + new Set(replies.map((r) => r.threadId)).size });
}

/** A thread's number: random, so it says nothing about anyone else's threads. Up to 15 digits. */
function newThreadId(): number {
  const b = crypto.getRandomValues(new Uint8Array(6));
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return 100_000 + (n % 900_000_000_000_000);
}
