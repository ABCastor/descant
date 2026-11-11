// Reading Descant's tables: who someone is, what they may read, what is shared, and a reader's
// threads as their page shows them.

import { actionSlotRows, projectActions, type ActionSlotMap, type Actor } from "./actions.ts";
import { founderNamesFrom } from "./rules.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  /** SHA-256, 64 hex characters, of the token the private server sends on /sync/*. */
  SHARE_TOKEN_SHA256: string;
  /** The public origin, for the links this Worker hands out. */
  APP_URL?: string;
  /** "off" where the plan cannot derive passwords (Workers Free): sign-in is by email code only. */
  PASSWORD_SIGNIN?: string;
  /** Fixed HTTPS tunnel origin of the separate authenticated writer listener. Off if absent. */
  WRITER_ORIGIN?: string;
  /** The writers' founder keys, comma separated (writers.ts). None if absent: no one is a writer. */
  WRITERS?: string;
  /** The space's synthetic sharing test article folder (rules.ts testArticle). None if absent. */
  TEST_ARTICLE?: string;
  /** Cloudflare sender; only account-verified destinations can receive mail. */
  MAIL?: SendEmail;
  FROM_ADDRESS?: string;
  /** Edge admission limiter configured in production, absent in isolated test environments. */
  PUBLIC_REQUESTS?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

export interface Person {
  id: string;
  name: string;
  email: string;
  secret: string;
  createdAt: string;
  lastSeenAt: string | null;
  sessionsFrom: number;
  emailVerifiedAt: string | null;
  color?: string | null;
}

export interface Article {
  path: string;
  title: string;
  owner: string;
  status: string;
  phase: string;
  ord: number;
  markdown: string | null;
  versionSha: string | null;
  versionWhen: string | null;
}

export interface Message {
  messageRef?: string;
  writer?: string;
  actions?: unknown;
  id?: string;
  principal?: string;
  model?: string;
  color?: string;
  author: string;
  text: string;
  created: string;
  by: string;
  basis: string;
  offer: unknown;
}

export interface LegacyMessage {
  commentId: string;
  kind: "thread" | "reply";
  principal?: string;
  model?: string;
  color?: string;
  author: string;
  text: string;
  created: string;
  by: string;
  anchor?: Anchor;
  refersTo?: string;
}

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  blockText: string;
  version: string;
  more?: AnchorPart[];
}

/** A passage's part in one following paragraph (comments.js anchorParts()). */
export interface AnchorPart {
  quote: string;
  suffix: string;
  blockText: string;
}

/** The later parts tidied as comments.js anchorParts() and serve.py comment_parts() tidy them:
 *  at most ten, each with words. None at all is an anchor of before, with no `more`. */
export function anchorParts(v: unknown): AnchorPart[] {
  const list = Array.isArray(v) ? (v as unknown[]) : [];
  return list.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).quote === "string" && !!(p as Record<string, unknown>).quote)
    .slice(0, 10)
    .map((p) => ({ quote: p.quote as string, suffix: typeof p.suffix === "string" ? p.suffix : "", blockText: typeof p.blockText === "string" ? p.blockText : "" }));
}

/** A thread in the exact shape serve.py's comment_document gives the page. */
export interface Thread {
  messageRef?: string;
  writer?: string;
  actions?: unknown;
  statusActions?: unknown;
  id: string;
  clientId?: string;
  legacyMessages?: LegacyMessage[];
  anchor: Anchor;
  principal?: string;
  model?: string;
  color?: string;
  author: string;
  by: string;
  text: string;
  created: string;
  replies: Message[];
  done: boolean;
  status: string;
  note: string;
  reanchoredFrom: string;
  refersTo: string;
}

interface CommentRow {
  seq: number;
  id: string;
  threadId: number;
  kind: "thread" | "reply";
  personId: string;
  name: string;
  email: string;
  text: string;
  anchor: string | null;
  refersTo: string | null;
  created: string;
  createdAt: string;
  syncedGen: number | null;
  refused: number;
  color?: string | null;
}

export interface ClientReceipt {
  clientId: string;
  kind: "thread" | "reply";
  threadId: number;
  commentId: string;
  payload: string;
}

export async function clientReceipts(db: D1Database, personId: string, path: string): Promise<ClientReceipt[]> {
  return (await db.prepare("SELECT clientId, kind, threadId, commentId, payload FROM client_receipts WHERE personId=? AND path=?")
    .bind(personId, path).all<ClientReceipt>()).results;
}

export const getPerson = (db: D1Database, id: string) => db.prepare("SELECT * FROM people WHERE id=?").bind(id).first<Person>();
export const personByEmail = (db: D1Database, email: string) => db.prepare("SELECT * FROM people WHERE email=?").bind(email).first<Person>();

export async function allArticles(db: D1Database): Promise<Article[]> {
  return (await db.prepare("SELECT * FROM articles ORDER BY CASE WHEN ord > 0 THEN ord ELSE 999 END, path").all<Article>()).results;
}

export async function founders(db: D1Database): Promise<{ key: string; name: string }[]> {
  return (await db.prepare("SELECT key, name FROM founders ORDER BY key").all<{ key: string; name: string }>()).results;
}

export async function founderNames(db: D1Database): Promise<Set<string>> {
  return founderNamesFrom(await founders(db));
}

/** Every article a person can read now, or that a live link would let someone read. */
export async function sharedPaths(db: D1Database, now = new Date()): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT path FROM grants
     UNION
     SELECT ia.path FROM invite_articles ia JOIN invites i ON i.id = ia.inviteId
     WHERE i.revokedAt IS NULL AND i.usesLeft > 0 AND i.expiresAt > ?
     ORDER BY 1`,
  ).bind(now.toISOString()).all<{ path: string }>();
  return results.map((r) => r.path);
}

/** The articles a reader may open now: granted to them, and with text pushed. */
export async function readable(db: D1Database, personId: string): Promise<Article[]> {
  const { results } = await db.prepare(
    `SELECT a.* FROM articles a JOIN grants g ON g.path = a.path
     WHERE g.personId = ? AND a.markdown IS NOT NULL
     ORDER BY CASE WHEN a.ord > 0 THEN a.ord ELSE 999 END, a.path`,
  ).bind(personId).all<Article>();
  return results;
}

export async function mayRead(db: D1Database, personId: string, path: string): Promise<Article | undefined> {
  const a = await db.prepare(
    "SELECT a.* FROM articles a JOIN grants g ON g.path = a.path WHERE g.personId = ? AND a.path = ? AND a.markdown IS NOT NULL",
  ).bind(personId, path).first<Article>();
  return a ?? undefined;
}

type InviteState = "live" | "used" | "expired" | "revoked";
export function inviteState(i: { usesLeft: number; expiresAt: string; revokedAt: string | null }, now = new Date()): InviteState {
  if (i.revokedAt) return "revoked";
  if (i.usesLeft <= 0) return "used";
  if (i.expiresAt <= now.toISOString()) return "expired";
  return "live";
}

const EMPTY_ANCHOR: Anchor = { quote: "", prefix: "", suffix: "", blockText: "", version: "" };

function anchorOf(raw: string | null): Anchor {
  try {
    const a = JSON.parse(raw ?? "{}") as Partial<Anchor>, more = anchorParts(a.more);
    return { quote: a.quote ?? "", prefix: a.prefix ?? "", suffix: a.suffix ?? "", blockText: a.blockText ?? "", version: a.version ?? "", ...(more.length ? { more } : {}) };
  } catch {
    return { ...EMPTY_ANCHOR };
  }
}

const storedColor = (c: CommentRow) => typeof c.color === "string" && /^#[0-9a-fA-F]{6}$/.test(c.color) ? { color:c.color } : {};

const messageOf = (c: CommentRow): Message => ({ ...storedColor(c), author: c.name, text: c.text, created: c.created, by: "human", basis: "", offer: null });

type ThreadRow = { id: number; personId: string; snap: string | null; gen: number | null };

/** One thread in the exact shape the page knows, before any action projection. */
function buildThread(t: ThreadRow, own: CommentRow[], receipts: ClientReceipt[], identity: Map<string, string>, message: (c: CommentRow) => Message): Thread | undefined {
  const start = own.find((c) => c.kind === "thread");
  const replies = own.filter((c) => c.kind === "reply");
  let thread: Thread | undefined;
  if (t.snap) {
    try {
      thread = { ...(JSON.parse(t.snap) as Thread), id: String(t.id) };
      const gen = t.gen ?? 0;
      const later = replies.filter((c) => c.refused || c.syncedGen === null || c.syncedGen >= gen);
      // Repository snapshots omit browser IDs. Reattach them in message order,
      // consuming each immutable stored message once, including repeated words.
      const accepted = replies.filter((c) => !later.includes(c));
      let offset = 0;
      thread.replies = thread.replies.map((r) => {
        const index = accepted.findIndex((c, i) => i >= offset && (c.id === r.messageRef || c.name === r.author && c.text === r.text && c.created === r.created && r.by === "human"));
        if (index < 0) return r;
        offset = index + 1;
        const { color: _untrustedColor, ...original } = r;
        return { ...original, ...storedColor(accepted[index]), author:accepted[index].name, by:"human", messageRef:accepted[index].id, writer:"reader:"+accepted[index].personId, ...(identity.has(accepted[index].id) ? { id: identity.get(accepted[index].id) } : {}) };
      });
      thread.replies = [...thread.replies, ...later.map(message)];
    } catch {
      thread = undefined;
    }
  }
  if (!thread && start) {
    thread = {
      id: String(t.id), anchor: anchorOf(start.anchor), author: start.name, by: "human", text: start.text,
      created: start.created, replies: replies.map(message), done: false, status: "open", note: "",
      reanchoredFrom: "", refersTo: start.refersTo ?? "",
    };
  }
  if (!thread) return undefined;
  const root = receipts.find((r) => r.kind === "thread" && r.threadId === t.id);
  if (root) thread.clientId = root.clientId;
  // Old accepted messages have no browser receipt. Keep their immutable
  // original words available even after the repository edits a snapshot.
  const legacy = own.filter(c => !identity.has(c.id)).map((c): LegacyMessage => ({
    commentId: c.id, kind: c.kind, author: c.name, text: c.text, created: c.created, by: "human",
    ...(c.kind === "thread" ? { anchor: anchorOf(c.anchor), refersTo: c.refersTo ?? "" } : {})
  }));
  if (legacy.length) thread.legacyMessages = legacy;
  if (start) { delete thread.color; Object.assign(thread,storedColor(start)); thread.messageRef=start.id;thread.writer="reader:"+start.personId;thread.author=start.name;thread.by="human"; }
  return thread;
}

/** Project a whole set of built threads with one read of their action slots, whatever their readers. */
async function projectThreads(db: D1Database, out: Thread[], actor?: Actor, immutableLegacy = false): Promise<Thread[]> {
  if (!out.length) return out;
  const ids = out.map((t) => Number(t.id));
  const slots = new Map<number, ActionSlotMap>();
  const gather = async (chunk: number[]) => {
    const { results } = await db.prepare(`SELECT threadId, slot, rev, state FROM comment_action_slots WHERE threadId IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ threadId: number; slot: string; rev: number; state: string }>();
    for (const r of results) {
      let known = slots.get(r.threadId);
      if (!known) slots.set(r.threadId, known = new Map());
      known.set(r.slot, { rev: r.rev, state: r.state });
    }
  };
  for (let i = 0; i < ids.length; i += 90) await gather(ids.slice(i, i + 90));
  // Reading does not initialize durable action state. Missing slots are revision zero;
  // the first real operation inserts only its target before the existing CAS.
  for (const thread of out) {
    let known = slots.get(Number(thread.id));
    if (!known) { known = new Map(); slots.set(Number(thread.id), known); }
    if (!actor && !known.size) continue;
    for (const [,slot,state] of actionSlotRows(thread,known)) known.set(slot,{rev:0,state});
  }
  return Promise.all(out.map((thread) => {
    const known = slots.get(Number(thread.id)) ?? new Map();
    if (!actor && !known.size) return thread;
    return projectActions(thread, actor, immutableLegacy, known);
  }));
}

/** Threads in the page's shape from their rows, comments and client receipts, with actions projected. */
function assembleThreads(db: D1Database, threads: ThreadRow[], rows: CommentRow[], receipts: ClientReceipt[], actor: Actor | undefined, immutableLegacy: boolean): Promise<Thread[]> {
  const identity = new Map(receipts.map((r) => [r.commentId, r.clientId]));
  const message = (c: CommentRow): Message => ({ ...messageOf(c), messageRef:c.id, writer:"reader:"+c.personId, ...(identity.has(c.id) ? { id: identity.get(c.id) } : {}) });
  const out: Thread[] = [];
  for (const t of threads) {
    const thread = buildThread(t, rows.filter((c) => c.threadId === t.id), receipts, identity, message);
    if (thread) out.push(thread);
  }
  return projectThreads(db, out, actor, immutableLegacy);
}

export async function readerThreads(db: D1Database, personId: string, path: string, actor?: Actor, immutableLegacy = false): Promise<Thread[]> {
  const { results: threads } = await db.prepare(
    `SELECT t.id, s.thread AS snap, s.gen AS gen FROM threads t LEFT JOIN snapshots s ON s.threadId = t.id
     WHERE t.personId = ? AND t.path = ? ORDER BY t.createdAt, t.id`,
  ).bind(personId, path).all<{ id: number; snap: string | null; gen: number | null }>();
  if (!threads.length) return [];
  const { results: rows } = await db.prepare(
    `SELECT c.* FROM comments c JOIN threads t ON t.id = c.threadId WHERE t.personId = ? AND t.path = ? ORDER BY c.seq`,
  ).bind(personId, path).all<CommentRow>();
  const receipts = await clientReceipts(db, personId, path);
  return assembleThreads(db, threads.map((t) => ({ ...t, personId })), rows, receipts, actor, immutableLegacy);
}

/** The requested threads of one article, whoever their readers, in one bounded read. */
export async function readerThreadsByIds(db: D1Database, path: string, ids: number[], actor?: Actor, immutableLegacy = false): Promise<Thread[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const { results: threads } = await db.prepare(
    `SELECT t.id, t.personId, s.thread AS snap, s.gen AS gen FROM threads t LEFT JOIN snapshots s ON s.threadId = t.id
     WHERE t.path = ? AND t.id IN (${marks}) ORDER BY t.createdAt, t.id`,
  ).bind(path, ...ids).all<ThreadRow>();
  if (!threads.length) return [];
  const { results: rows } = await db.prepare(
    `SELECT c.* FROM comments c WHERE c.threadId IN (${marks}) ORDER BY c.seq`,
  ).bind(...ids).all<CommentRow>();
  const owners = [...new Set(threads.map((t) => t.personId))];
  const { results: receipts } = await db.prepare(
    `SELECT clientId, kind, threadId, commentId, payload FROM client_receipts WHERE path = ? AND personId IN (${owners.map(() => "?").join(",")})`,
  ).bind(path, ...owners).all<ClientReceipt>();
  return assembleThreads(db, threads, rows, receipts, actor, immutableLegacy);
}

/** Python's ISO form with an explicit UTC offset, to the second: what a thread file carries. */
export const pyIso = (d: Date): string => d.toISOString().slice(0, 19) + "+00:00";
