// Sessions without a library: a cookie signed with HMAC-SHA-256 through Web Crypto, and one-time
// tokens of which only the SHA-256 is stored. Copied from the logbook's session.ts and narrowed.
//
// Two kinds of session, each signed over its own prefix so one can never pass for the other:
//   reader   __Host-descant=v1.<personId>.<expiry>.<signature>          30 days, refreshed while in use
//   founder  __Host-descant_founder=f2.<key>.<email digest>.<generation>.<auth ms>.<expiry>.<signature> 30 days
// Old f1 cookies retain their original 12h expiry, until a password change revokes them.
// The __Host- prefix makes the browser keep each cookie for this exact host, over https only, so no
// other host on the same site can set or overwrite one.

import { WRITER_KEY, WRITER_KEY_SOURCE } from './writers.ts';

const FOUNDER_SESSION = new RegExp('^(f2\\.(' + WRITER_KEY_SOURCE + ')\\.([a-f0-9]{64})\\.([\\w-]+)\\.(\\d+)\\.(\\d+))\\.([\\w-]+)$');

const enc = new TextEncoder();
export const READER_DAYS = 30;
export const FOUNDER_HOURS = 12;
export const FOUNDER_DAYS = 30;
export const READER_COOKIE = "__Host-descant";
export const FOUNDER_COOKIE = "__Host-descant_founder";
export type Kind = "v1" | "f1";

async function key(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET missing or shorter than 32 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(secret: string, kind: Kind, subject: string, seconds: number, now = Date.now()): Promise<string> {
  if (!/^[\w-]+$/.test(subject)) throw new Error("subject must be word characters");
  const payload = `${kind}.${subject}.${Math.floor(now / 1000) + seconds}`;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** The session's subject and expiry, or undefined when forged, altered, of the other kind, malformed or expired. */
export async function verifySession(
  secret: string,
  kind: Kind,
  value: string | undefined,
  now = Date.now(),
): Promise<{ subject: string; expires: number } | undefined> {
  const m = /^((v1|f1)\.([\w-]+)\.(\d+))\.([\w-]+)$/.exec(value ?? "");
  if (!m || m[2] !== kind) return undefined;
  const sig = fromB64url(m[5]);
  if (!sig || !(await crypto.subtle.verify("HMAC", await key(secret), sig, enc.encode(m[1])))) return undefined;
  const expires = Number(m[4]) * 1000;
  return expires > now ? { subject: m[3], expires } : undefined;
}

export const signedInAt = (expires: number): number => expires - READER_DAYS * 86_400_000;

/** Always Secure: plain http is redirected before any cookie is set (index.ts), and browsers treat
 * http://localhost and http://127.0.0.1 as secure for local development. */
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** A fresh one-time token (goes in the link) and its hash (goes in the database). 32 random bytes. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await sha256Hex(token) };
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A short code cannot be guessed offline from D1 without the Worker's signing secret. */
export async function emailCodeHash(secret: string, challenge: string, code: string): Promise<string> {
  const tag = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`descant-email-code:${challenge}:${code}`));
  return [...new Uint8Array(tag)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal strings, in time that does not depend on where they first differ. */
export function sameText(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

/** A random id: a letter and `bytes` random bytes in hex. */
export function randomId(prefix: string, bytes = 12): string {
  return prefix + [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export interface FounderSession { subject: string; emailSha256: string; generation: string; authenticatedAt: number; expires: number }
/** New founder sessions carry their actual authentication time and credential generation. */
export async function signFounderSession(secret: string, subject: string, emailSha256: string, generation: string, authenticatedAt: number, now = Date.now()): Promise<string> {
  // The key's format only: whether it names a writer is checked against WRITERS by the callers.
  if (!WRITER_KEY.test(subject) || !/^[a-f0-9]{64}$/.test(emailSha256) || !/^[\w-]+$/.test(generation)) throw new Error('Invalid founder identity');
  const payload = `f2.${subject}.${emailSha256}.${generation}.${authenticatedAt}.${Math.floor(now / 1000) + FOUNDER_DAYS * 86400}`;
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(payload))))}`;
}
export async function verifyFounderSession(secret: string, value: string | undefined, now = Date.now()): Promise<FounderSession | undefined> {
  const m = FOUNDER_SESSION.exec(value ?? '');
  if (!m) return undefined;
  const authenticatedAt = Number(m[5]), expires = Number(m[6]) * 1000;
  if (!Number.isSafeInteger(authenticatedAt) || authenticatedAt > now || !Number.isSafeInteger(expires) || expires <= now || expires > now + FOUNDER_DAYS * 86400000) return undefined;
  const sig = fromB64url(m[7]);
  if (!sig || !await crypto.subtle.verify('HMAC', await key(secret), sig, enc.encode(m[1]))) return undefined;
  return { subject: m[2], emailSha256: m[3], generation: m[4], authenticatedAt, expires };
}
