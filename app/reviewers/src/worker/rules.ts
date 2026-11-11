// What a reader may write, judged the way the private server judges it (design/app/serve.py:
// reviewer_string, reviewer_message, REVIEWER_NAME_RE, EMAIL_RE, MESSAGE_RE), so a comment this
// Worker accepts is one the private server stores. The review files are line-based, so a line a
// reader writes must never read as the start of someone else's message.

// Every field a reader sends is bounded to what a real comment needs, so one account cannot fill the
// database or the founders' repository: the longest paragraph in any article is under 1,000 characters.
const TEXT_MAX = 5000;            // characters in one comment or reply
export const QUOTE_MAX = 500;            // the words the comment is on
export const AFFIX_MAX = 200;            // the words either side of them
export const BLOCK_MAX = 2000;           // the paragraph they are in
export const VERSION_MAX = 64;
export const REFERS_MAX = 500;
export const FRESH_MAX = 10;             // new comments plus replies in one save
export const PER_MINUTE = 30;            // new comments plus replies per reader per minute
export const PER_DAY = 200;              // and per day
export const THREADS_PER_ARTICLE = 50;   // threads one reader may start on one article

export const ARTICLE_RE = /^articles\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/article\.md$/;
const ARTICLE_FOLDER_RE = /^articles\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/$/;

// The space's synthetic article for trying sharing, never shared or listed: its folder in the
// TEST_ARTICLE var (wrangler.toml [vars]), such as "articles/zz-test/", as the space's
// .descant/config.json testArticle names it. None: no article is set apart.
export function testArticle(env: { TEST_ARTICLE?: unknown }): string {
  const named = typeof env.TEST_ARTICLE === "string" ? env.TEST_ARTICLE.trim() : "";
  return ARTICLE_FOLDER_RE.test(named) && !named.includes("..") ? named : "";
}

export function isTestArticle(env: { TEST_ARTICLE?: unknown }, path: string): boolean {
  const prefix = testArticle(env);
  return prefix !== "" && path.startsWith(prefix);
}
// Python's EMAIL_RE, applied to the lowercased address.
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
// Python's REVIEWER_NAME_RE: a letter first, then letters, digits, spaces, dots, apostrophes and
// hyphens, at most 40 characters, ending on a letter, digit or dot. Nothing either grammar the name
// is written into gives a meaning to (`*`, `<`, `:`, a newline).
const NAME_RE = /^[\p{L}](?:[\p{L}\p{N}_ .'-]{0,38}[\p{L}\p{N}_.])?$/u;
// Every character Python's str.splitlines() ends a line on, apart from \n, plus the other C0 controls,
// and the byte-order mark (which JavaScript's trim() strips and Python's strip() keeps).
const UNSAFE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x85\u2028\u2029\ufeff]/;
// The line that opens one person's message in a review file.
const MESSAGE_RE = /^\*\*(.+?)\*\*,\s*(\d{4}-\d{2}-\d{2})(?:\s+\((.*?)\))?:\s*$/;

export class Refused extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const length = (s: string) => [...s].length;

/** A string a reader sent, refused if it could break the review file's lines. */
export function readerString(value: unknown, limit: number, what: string): string {
  const text = plain(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (UNSAFE_RE.test(text)) throw new Refused(400, "unsafe-text", `${what} contains a control character`);
  if (length(text) > limit) throw new Refused(413, "too-long", `${what} is longer than ${limit} characters`);
  return text;
}

/** A comment or reply as the reader typed it, tidied the way the private server stores it. */
export function readerMessage(value: unknown): string {
  let text = readerString(value, TEXT_MAX, "the comment");
  text = text.split("\n").map((line) => line.trimEnd()).join("\n").trim();
  if (!text) throw new Refused(400, "empty", "the comment is empty");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (MESSAGE_RE.test(t) || t.startsWith("_Re-anchored ")) {
      throw new Refused(400, "unsafe-text", "a line of the comment reads like the start of someone's message; reword that line");
    }
  }
  return text;
}

/** Python's `str(value or "")` for the values a page sends. */
export function plain(value: unknown): string {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return "";
  return typeof value === "string" ? value : String(value);
}

// Letters that look like Latin ones, folded to them, so "Аda" (a Cyrillic А) reads as "ada"; and the
// digits people use for letters.
const LOOKALIKE: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "з": "3", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h", "ӏ": "l", "ɑ": "a",
  "ɡ": "g", "ı": "i", "ȷ": "j", "ℓ": "l", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o",
  "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
};

/** A name reduced to plain lowercase Latin letters, in words: what it looks like, not how it is spelled. */
function nameWords(name: string): string[] {
  const folded = [...name.normalize("NFKC").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join("")
    .normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[0-9]/g, (d) => LOOKALIKE[d] ?? d);
  return folded.split(/[^a-z]+/).filter(Boolean);
}

/**
 * Whether a reader's name would read as a founder's: refused when the name, with its spacing and
 * punctuation gone, is a founder's key, first name or full name; when any word of it is a founder's
 * key or first name; or when an initial is followed by a founder's surname ("A. Lovelace").
 */
function looksLikeFounder(name: string, founders: Set<string>): boolean {
  const words = nameWords(name);
  if (!words.length) return false;
  if (founders.has(words.join(""))) return true;
  if (words.some((w) => founders.has(w))) return true;
  for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) if (founders.has(words[i][0] + words[j])) return true;
  return false;
}

/** The reader's name as it will be signed in review files, or why it cannot be. */
export function nameProblem(name: string, founderNames: Set<string>): string | undefined {
  if (!NAME_RE.test(name) || UNSAFE_RE.test(name)) {
    return "Use your name as people know it: letters, spaces, dots, apostrophes and hyphens, at most 40 characters.";
  }
  if (looksLikeFounder(name, founderNames)) return "That name reads as one of the founders'. Use your own.";
  return undefined;
}

export const foldName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
export const foldEmail = (s: string) => s.trim().toLowerCase();

export function emailProblem(email: string): string | undefined {
  return EMAIL_RE.test(email) ? undefined : "Use an email address like name@example.com.";
}

/** What a reader's name may not reduce to, as nameWords spells it: each founder's key, first name,
 * full name, and initial plus surname. */
export function founderNamesFrom(founders: { key: string; name: string }[]): Set<string> {
  const out = new Set(["both"]);
  for (const f of founders) {
    out.add(nameWords(f.key).join(""));
    const words = nameWords(f.name);
    if (!words.length) continue;
    out.add(words[0]);
    out.add(words.join(""));
    if (words.length > 1) out.add(words[0][0] + words[words.length - 1]);
  }
  out.delete("");
  return out;
}

// Internal notes, in the grammar the reader page itself hides (engine/md.js): %%a writer note%%, a
// marker addressed to people in capitals ([NAME: ...], **[WRITERS: ...]**), and HTML comments.
// The private server strips them before anything leaves it; Descant refuses to keep any that remain.
const NOTE_RES = [/%%/, /(^|[^[])\[[A-Z][A-Z0-9 ]+:/, /<!--/];
export const carriesNotes = (markdown: string): boolean => NOTE_RES.some((re) => re.test(markdown));

/** Only letters and digits, lowercased, link targets dropped: the words as a reader sees them. */
export function wordsOf(markdown: string): string {
  return markdown.normalize("NFKC").toLowerCase()
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Whether a founder may grant an article: one whose owner is that founder, both, unassigned or
 * missing; never another founder's; never the space's synthetic sharing test article (testArticle).
 */
export function mayShare(env: { TEST_ARTICLE?: unknown }, founder: string, article: { path: string; owner: string } | undefined | null): boolean {
  if (!article || !ARTICLE_RE.test(article.path) || isTestArticle(env, article.path)) return false;
  return article.owner === founder || article.owner === "both" || article.owner === "unassigned" || article.owner === "";
}

/** A short label a founder gives a link ("Ada"): one line, no control characters. */
export function labelProblem(label: string): string | undefined {
  if (!label) return "Give the link a label, such as the name of the person it is for.";
  if (length(label) > 60 || UNSAFE_RE.test(label) || /[\n\t]/.test(label)) return "A label is one line of at most 60 characters.";
  return undefined;
}
