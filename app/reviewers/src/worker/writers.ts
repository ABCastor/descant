// The writers of this writing space: the keys of its people file in the WRITERS var
// (wrangler.toml [vars]), such as "ada,jean-luc". Never written in code. With no WRITERS no one is a writer.

// The install's writer-key rule (space_config.WRITER_KEY in the app): a lowercase letter, then up
// to 23 lowercase letters, digits or hyphens. The founder sync (sync.ts) and sessions (session.ts)
// use it too.
export const WRITER_KEY_SOURCE = "[a-z][a-z0-9-]{0,23}";
export const WRITER_KEY = new RegExp("^" + WRITER_KEY_SOURCE + "$");
// Article owner values that are not a person.
const RESERVED = new Set(["both", "unassigned"]);

export function writers(env: { WRITERS?: string }): string[] {
  const out: string[] = [];
  for (const key of (env.WRITERS ?? "").split(/[\s,]+/)) if (WRITER_KEY.test(key) && !RESERVED.has(key) && !out.includes(key)) out.push(key);
  return out;
}

export function isWriter(env: { WRITERS?: string }, key: unknown): key is string {
  return typeof key === "string" && writers(env).includes(key);
}

/** The writers as a bound SQL list: "(?,?)" and its values. "(NULL)" matches nothing. */
export function writerList(env: { WRITERS?: string }): { sql: string; keys: string[] } {
  const keys = writers(env);
  return { sql: keys.length ? "(" + keys.map(() => "?").join(",") + ")" : "(NULL)", keys };
}
