// Founder authority is checked here for dashboard and writer, never through reader cookies.
import { clearFailures, guessKeys, reserveTry, waitWords } from './attempts.ts';
import { emailProblem, foldEmail } from './rules.ts';
import { hashPassword, PASSWORD_MAX, passwordProblem, verifyPassword } from './passwords.ts';
import { FOUNDER_COOKIE, FOUNDER_DAYS, FOUNDER_HOURS, READER_COOKIE, cookie, randomId, readCookie, sha256Hex, signFounderSession, verifyFounderSession, verifySession, type FounderSession } from './session.ts';
import type { Env } from './store.ts';
import { isWriter } from './writers.ts';
import { esc, formOf, message, page, redirect, sameSite } from './web.ts';
const RECENT_MS = 10 * 60_000;
interface Identity { key: string; emailSha256: string; generation: string | null; secret: string | null; credentialEmail: string | null }
const identitySql = `SELECT f.key,f.emailSha256,c.generation,c.secret,c.emailSha256 AS credentialEmail FROM founders f LEFT JOIN founder_credentials c ON c.founderKey=f.key`;
async function identity(env: Env, subject: string): Promise<Identity | null> {
  return env.DB.prepare(identitySql + ' WHERE f.key=? AND (SELECT COUNT(*) FROM founders WHERE emailSha256=f.emailSha256)=1').bind(subject).first<Identity>();
}
/** Legacy f1 remains valid for its original 12h, until credentials are changed. */
export async function authenticatedFounder(req: Request, env: Env, now = Date.now()): Promise<FounderSession | undefined> {
  const value = readCookie(req.headers.get('Cookie'), FOUNDER_COOKIE);
  const modern = await verifyFounderSession(env.SESSION_SECRET, value, now);
  const legacy = modern ? undefined : await verifySession(env.SESSION_SECRET, 'f1', value, now);
  const subject = modern?.subject ?? legacy?.subject;
  if (!subject || !isWriter(env, subject)) return undefined;
  const live = await identity(env, subject);
  if (!live || !/^[a-f0-9]{64}$/.test(live.emailSha256)) return undefined;
  if (modern) return modern.emailSha256 === live.emailSha256 && modern.generation === (live.generation ?? 'none') ? modern : undefined;
  if (!legacy || live.generation || legacy.expires > now + FOUNDER_HOURS * 3600000) return undefined;
  return { subject, emailSha256: live.emailSha256, generation: 'none', authenticatedAt: 0, expires: legacy.expires };
}
/** Inbox/password proof is recent. A private bridge link authenticates access, not a password change. */
export async function founderSessionCookie(env: Env, subject: string, recentlyVerified = false, expectedGeneration?: string, expectedEmail?: string): Promise<string | undefined> {
  const live = await identity(env, subject);
  if (!live || !isWriter(env, subject) || !/^[a-f0-9]{64}$/.test(live.emailSha256)) return undefined;
  if (expectedGeneration !== undefined && (live.generation ?? 'none') !== expectedGeneration) return undefined;
  if (expectedEmail !== undefined && live.emailSha256 !== expectedEmail) return undefined;
  const now = Date.now();
  return cookie(FOUNDER_COOKIE, await signFounderSession(env.SESSION_SECRET, subject, live.emailSha256, live.generation ?? 'none', recentlyVerified ? now : 0, now), FOUNDER_DAYS * 86400);
}
const GENERIC = 'The email or password did not match. Try again, or use an email code.';
function loginPage(error = '', status = 200): Response {
  return page('Sign in to write · Descant', `<h1>Sign in to write</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/signin/password" class="stack">
<label>Email <input type="email" name="email" autocomplete="username" required maxlength="254"></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required maxlength="${PASSWORD_MAX}"></label>
<button type="submit">Sign in</button></form>
<p><a href="/signin?write=1">Use an email code instead</a></p>`, status);
}
export async function founderPasswordSignIn(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return loginPage();
  if (!sameSite(req)) return message('Refused', 'That form came from another site, so nothing was done.', 403);
  const field = await formOf(req), email = foldEmail(field('email', 255)), password = field('password', 2049);
  const keys = (await guessKeys(req, email)).map(k => 'password:' + k);
  const wait = await reserveTry(env.DB, keys);
  if (wait) return loginPage(`Too many tries. Wait ${waitWords(wait)}, then try again.`, 429);
  const digest = await sha256Hex(email);
  const rows = (await env.DB.prepare(identitySql + ' WHERE f.emailSha256=?').bind(digest).all<Identity>()).results;
  const live = rows.length === 1 && isWriter(env, rows[0].key) ? rows[0] : null;
  const stored = live?.credentialEmail === digest ? live.secret : null;
  const verified = await verifyPassword(password, stored);
  if (!verified || !live || emailProblem(email)) return loginPage(GENERIC, 401);
  // Re-read generation in an atomic claim after the expensive derivation, so a concurrent reset wins.
  const still = await env.DB.prepare(`SELECT f.key FROM founders f JOIN founder_credentials c ON c.founderKey=f.key
    WHERE f.key=? AND f.emailSha256=? AND c.emailSha256=? AND c.generation=? AND c.secret=?
    AND (SELECT COUNT(*) FROM founders WHERE emailSha256=?)=1`).bind(live.key,digest,digest,live.generation,stored,digest).first();
  if (!still) return loginPage(GENERIC, 401);
  // Sign the generation that was verified, never a newly rotated one.
  const now = Date.now();
  const value = await signFounderSession(env.SESSION_SECRET, live.key, digest, live.generation!, now, now);
  await clearFailures(env.DB, keys);
  return redirect('/write/', [cookie(FOUNDER_COOKIE, value, FOUNDER_DAYS * 86400), cookie(READER_COOKIE, '', 0)]);
}
function settingsPage(hasPassword: boolean, recent: boolean, error = '', status = 200): Response {
  return page('Writing password · Descant', `<p><a href="/admin">People and sharing</a> · <a href="/write/">Writing</a></p>
<h1>${hasPassword ? 'Change password' : 'Set password'}</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
${!recent ? `<p>Confirm it is you before changing your password.</p>
${hasPassword ? `<form method="post" action="/admin/password" class="stack"><input type="hidden" name="action" value="confirm">
<label>Current password <input type="password" name="current" autocomplete="current-password" required maxlength="${PASSWORD_MAX}"></label>
<button type="submit">Confirm</button></form>` : ''}
<p><a href="/signin?write=1">Confirm with an email code</a></p>` : `<form method="post" action="/admin/password" class="stack">
<input type="hidden" name="action" value="save">
<label>New password <input type="password" name="password" autocomplete="new-password" required minlength="15" maxlength="${PASSWORD_MAX}"></label>
<p class="quiet">Use 15–256 characters. A few unrelated words work well. Your other writing sessions will be signed out.</p>
<button type="submit">${hasPassword ? 'Change password' : 'Set password'}</button></form>`}
<p><a href="/signin?write=1">Email-code sign-in stays available</a></p>`, status);
}
export async function founderPasswordSettings(req: Request, env: Env): Promise<Response> {
  if (req.method === 'POST' && !sameSite(req)) return message('Refused', 'That form came from another site, so nothing was done.', 403);
  const session = await authenticatedFounder(req, env);
  if (!session) return message('Founders only', 'Sign in to your writing account first.', 401, '<p><a href="/signin?write=1">Sign in to write</a></p>');
  const live = await identity(env, session.subject);
  if (!live) return message('Sign in again', 'Your writing account changed. Sign in with an email code.', 401);
  const hasPassword = !!live.secret && live.credentialEmail === session.emailSha256;
  const recent = session.authenticatedAt > 0 && Date.now() - session.authenticatedAt < RECENT_MS;
  if (req.method !== 'POST') {
    if (new URL(req.url).searchParams.get('saved') === '1') return page('Password saved · Descant', '<h1>Password saved</h1><p>Your other writing sessions have been signed out. Email-code sign-in stays available.</p><p><a href="/write/">Return to writing</a></p>');
    return settingsPage(hasPassword, recent);
  }
  const field = await formOf(req), action = field('action', 20);
  if (action === 'confirm' && hasPassword) {
    const keys = (await guessKeys(req, session.emailSha256)).map(k => 'password:' + k);
    const wait = await reserveTry(env.DB, keys);
    if (wait) return settingsPage(hasPassword, false, `Too many tries. Wait ${waitWords(wait)}, then try again.`, 429);
    if (!await verifyPassword(field('current', 2049), live.secret)) return settingsPage(hasPassword, false, 'That password did not match.', 401);
    await clearFailures(env.DB, keys);
    // Preserve the checked generation: concurrent password changes cannot grant a new proof.
    const now = Date.now();
    const value = await signFounderSession(env.SESSION_SECRET, session.subject, session.emailSha256, session.generation, now, now);
    return redirect('/admin/password', [cookie(FOUNDER_COOKIE, value, FOUNDER_DAYS * 86400)]);
  }
  if (action !== 'save' || !recent) return settingsPage(hasPassword, false, 'Confirm it is you first. Confirmation lasts 10 minutes.', 401);
  const password = field('password', 2049), problem = passwordProblem(password);
  if (problem) return settingsPage(hasPassword, true, problem, 400);
  const secret = await hashPassword(password), generation = randomId('g');
  const at = new Date().toISOString();
  // Compare-and-swap: one reset wins, and founder metadata must still match the verified proof.
  const save = env.DB.prepare(`INSERT INTO founder_credentials (founderKey,emailSha256,secret,generation,updatedAt)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM founders WHERE key=? AND emailSha256=?)
    AND (SELECT COUNT(*) FROM founders WHERE emailSha256=?)=1
    AND COALESCE((SELECT generation FROM founder_credentials WHERE founderKey=?),'none')=?
    ON CONFLICT(founderKey) DO UPDATE SET emailSha256=excluded.emailSha256,secret=excluded.secret,generation=excluded.generation,updatedAt=excluded.updatedAt`).bind(session.subject,session.emailSha256,secret,generation,at,session.subject,session.emailSha256,session.emailSha256,session.subject,session.generation);
  const gate = 'EXISTS (SELECT 1 FROM founder_credentials WHERE founderKey=? AND generation=?)';
  const [result] = await env.DB.batch([save,
    env.DB.prepare(`UPDATE founder_email_codes SET expiresAt=? WHERE founderKey=? AND usedAt IS NULL AND ${gate}`).bind(at,session.subject,session.subject,generation),
    env.DB.prepare(`UPDATE onetime SET usedAt=? WHERE kind='founder' AND subject=? AND usedAt IS NULL AND ${gate}`).bind(at,session.subject,session.subject,generation),
  ]);
  if (result.meta.changes !== 1) return message('Sign in again', 'Your account changed while the password was being saved. Sign in with an email code and try again.', 409);
  const now = Date.now();
  const value = await signFounderSession(env.SESSION_SECRET, session.subject, session.emailSha256, generation, now, now);
  return redirect('/admin/password?saved=1', [cookie(FOUNDER_COOKIE, value, FOUNDER_DAYS * 86400), cookie(READER_COOKIE, '', 0)]);
}
