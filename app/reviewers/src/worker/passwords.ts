// Narrowed from Logbook: random salt, versioned PBKDF2, equal-work unknown-account check.
// The Workers runtime completes 600,000 iterations within its limits (measured in workerd).
import { sameText } from './session.ts';
export const PBKDF2_ITERATIONS = 600_000;
export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 256;
const enc = new TextEncoder();
const fold = (password: string) => password.normalize('NFC');
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, v => parseInt(v, 16));
const STORED = /^pbkdf2-sha256\$600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const DUMMY = `pbkdf2-sha256$600000$${'0'.repeat(32)}$${'0'.repeat(64)}`;
export function passwordProblem(password: string): string | undefined {
  const length = [...fold(password)].length;
  return length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : length > PASSWORD_MAX ? `Use at most ${PASSWORD_MAX} characters.` : undefined;
}
async function derive(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(fold(password)), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: bytes(salt) }, key, 256)));
}
export async function hashPassword(password: string): Promise<string> {
  if (passwordProblem(password)) throw new Error('Password length out of bounds');
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt}$${await derive(password, salt)}`;
}
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  // Never silently truncate a password, or derive unbounded attacker-controlled input.
  if (passwordProblem(password)) return false;
  const match = STORED.exec(stored ?? '');
  const parsed = match ?? STORED.exec(DUMMY)!;
  const equal = sameText(await derive(password, parsed[1]), parsed[2]);
  return !!match && equal;
}
