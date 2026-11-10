// Reader sign-in uses emailed codes; legacy accounts require a founder recovery link and inbox proof.

import { CODE_MINUTES, codePage } from "./code-page.ts";
import { requestFounderCode, verifyFounderCode } from "./founder-auth.ts";
import { founderSessionCookie, passwordsOn } from './founder-password.ts';
import { clearFailures, guessKeys, reserveTry, waitWords } from "./attempts.ts";
import { emailProblem, foldEmail, foldName, nameProblem } from "./rules.ts";
import {
  FOUNDER_COOKIE, READER_COOKIE, READER_DAYS, cookie, emailCodeHash, founderMaxAge, newToken, randomId, sameText, sha256Hex, signSession,
} from "./session.ts";
import { founderNames, inviteState, personByEmail, type Env, type Person } from "./store.ts";
import { esc, formOf, message, page, redirect } from "./web.ts";

export async function readerCookie(env: Env, personId: string, at = Date.now()): Promise<string> {
  return cookie(READER_COOKIE, await signSession(env.SESSION_SECRET, "v1", personId, READER_DAYS * 86_400, at), READER_DAYS * 86_400);
}

const signedInAs = async (env: Env, personId: string, to = "/", at = Date.now()) => redirect(to, [await readerCookie(env, personId, at)]);

// ------------------------------------------------------------------------------------ sign in

const canEmail = (env: Env) => !!env.MAIL && !!env.FROM_ADDRESS;

function signInPage(env: Env, writing = false): Response {
  const title = writing ? "Sign in to write" : "Sign in";
  return page(title + " · Descant", `<h1>${title}</h1>
${canEmail(env) ? `<p>${writing ? "Use your writing-account email." : "Use your account email address."}</p>
<form method="post" action="/signin" class="stack">
<label>Email <input type="email" name="email" autocomplete="email" required maxlength="254"></label>
<button type="submit">Email me a code</button>
</form>` : `<p>Email is unavailable. Ask the person who invited you to try again later.</p>`}
${passwordsOn(env) ? `<p><a href="/signin/password">Sign in to write with a password</a></p>
` : ""}<p class="quiet">${writing ? "Reader invitations use a separate account." : "If you used a password before, ask the person who invited you for a recovery link."}</p>`);
}

export async function signInRoute(req: Request, env: Env): Promise<Response> {
  return emailCodeRoute(req, env, false);
}

export function signOutRoute(req: Request): Response {
  if (req.method !== "POST") {
    return page("Sign out · Descant", `<h1>Sign out</h1>
<form method="post" action="/signout"><button type="submit">Sign out of Descant</button></form>`);
  }
  return redirect("/signin", [cookie(READER_COOKIE, "", 0), cookie(FOUNDER_COOKIE, "", 0)]);
}

// --------------------------------------------------------------------------------- invitations

interface Invite { id: string; label: string; email: string | null; createdBy: string; expiresAt: string; usesLeft: number; revokedAt: string | null }

const GONE: Record<string, [string, string]> = {
  used: ["This link has been used", "Each invitation link works only as many times as it was made for, and this one has been used up. Ask the person who sent it for a new one."],
  expired: ["This link has expired", "Invitation links work for a limited time, and this one's time is over. Ask the person who sent it for a new one."],
  revoked: ["This link was withdrawn", "The person who made this link has withdrawn it. Ask them for a new one if you still need it."],
};

async function inviteOf(env: Env, token: string): Promise<{ invite: Invite; articles: { path: string; title: string }[] } | undefined> {
  const invite = await env.DB.prepare("SELECT id, label, email, createdBy, expiresAt, usesLeft, revokedAt FROM invites WHERE tokenHash=?").bind(await sha256Hex(token)).first<Invite>();
  if (!invite) return undefined;
  const { results } = await env.DB.prepare(
    `SELECT ia.path, COALESCE(a.title, ia.path) AS title FROM invite_articles ia LEFT JOIN articles a ON a.path = ia.path
     WHERE ia.inviteId = ? ORDER BY CASE WHEN a.ord > 0 THEN a.ord ELSE 999 END, ia.path`,
  ).bind(invite.id).all<{ path: string; title: string }>();
  return { invite, articles: results };
}

function joinPage(env: Env, token: string, inv: { invite: Invite; articles: { title: string }[] }, signedIn: Person | null, o: { name?: string; email?: string; createError?: string } = {}, status = 200): Response {
  const list = inv.articles.map((a) => `<li>${esc(a.title)}</li>`).join("");
  const action = `/join/${esc(token)}`;
  const mine = signedIn
    ? `<section>
<h2>You are signed in as ${esc(signedIn.name)}</h2>
<form method="post" action="${action}"><input type="hidden" name="action" value="add"><button type="submit">Add ${inv.articles.length === 1 ? "it" : "them"} to my account</button></form>
<p class="quiet">Not you? <a href="/signout">Sign out</a> first.</p>
</section>`
    : `<section>
<h2>Create your account</h2>
${o.createError ? `<p class="err" role="alert">${esc(o.createError)}</p>` : ""}
${canEmail(env) ? `<form method="post" action="${action}" class="stack">
<input type="hidden" name="action" value="create">
<label>Your name <input name="name" autocomplete="name" required maxlength="40" value="${esc(o.name ?? "")}"></label>
<label>Email <input type="email" name="email" autocomplete="email" required value="${esc(o.email ?? inv.invite.email ?? "")}" readonly></label>
<p class="quiet">Your name signs your comments. We will email a code to verify your address.</p>
<button type="submit">Email me a code</button>
</form>` : `<p>Email verification is unavailable. Ask the person who invited you to try again later.</p>`}
</section>
<section>
<h2>I already have an account</h2>
${canEmail(env) ? `<form method="post" action="${action}" class="stack">
<input type="hidden" name="action" value="code">
<input type="hidden" name="email" value="${esc(inv.invite.email)}">
<button type="submit">Email me a code</button>
</form>` : ""}
<p class="quiet">If you used a password before, ask the person who invited you for a recovery link.</p>
</section>`;
  return page("An invitation · Descant", `<h1>You are invited to read and comment</h1>
<p>This link opens ${inv.articles.length === 1 ? "this article" : "these articles"}:</p>
<ul class="titles">${list}</ul>
${mine}`, status);
}

/** The batch that spends one use of the link and grants its articles. A use past zero fails the batch. */
function useInvite(db: D1Database, invite: Invite, personId: string, now: string, codeHash?: string): D1PreparedStatement[] {
  const gate = codeHash ? " AND EXISTS (SELECT 1 FROM email_codes WHERE tokenHash=? AND usedAt=?)" : "";
  const args = codeHash ? [codeHash, now] : [];
  return [
    db.prepare("UPDATE invites SET usesLeft = usesLeft - 1 WHERE id = ?" + gate).bind(invite.id, ...args),
    // The trigger refuses an invitation withdrawn or expired before the batch ran.
    db.prepare(
      `INSERT OR IGNORE INTO grants (personId, path, grantedBy, createdAt) SELECT ?, path, ?, ? FROM invite_articles
       WHERE inviteId = ? AND EXISTS (SELECT 1 FROM invites WHERE id = ? AND revokedAt IS NULL AND expiresAt > ?)` + gate,
    ).bind(personId, invite.createdBy, now, invite.id, invite.id, now, ...args),
  ];
}

export async function joinRoute(req: Request, env: Env, token: string, signedIn: Person | null): Promise<Response> {
  const inv = await inviteOf(env, token);
  if (!inv) return message("This link does not work", "There is no invitation at this address. Check that the whole link was copied, or ask the person who sent it for a new one.", 404);
  const now = new Date();
  const st = inviteState(inv.invite, now);
  if (st !== "live") return message(GONE[st][0], GONE[st][1], 410);
  if (!inv.invite.email) return message("Ask for a new invitation", "This older link has no invited email address. Ask the founder for a new invitation addressed to you.", 410);
  if (req.method !== "POST") return joinPage(env, token, inv, signedIn);

  const field = await formOf(req);
  const action = field("action", 20);
  const at = now.toISOString();
  const db = env.DB;
  const spend = async (personId: string, extra: D1PreparedStatement[] = []): Promise<boolean> => {
    try {
      await db.batch([...extra, ...useInvite(db, inv.invite, personId, at)]);
      return true;
    } catch {
      return false;
    }
  };

  if (action === "add" && signedIn) {
    if (signedIn.email !== inv.invite.email) return message("This invitation is for another address", "Sign in with the address the founder invited.", 403);
    if (!signedIn.emailVerifiedAt) return requestCode(req, env, signedIn.email, { person: signedIn, invite: inv.invite });
    if (!(await spend(signedIn.id))) return message(GONE.used[0], GONE.used[1], 410);
    return redirect("/");
  }
  if (action === "create" || action === "code" || action === "signin") {
    const name = foldName(field("name", 200));
    const email = foldEmail(field("email", 254));
    const again = (error: string, status = 400) => joinPage(env, token, inv, null, { name, email, createError: error }, status);
    const existing = await personByEmail(db, email);
    const problem = emailProblem(email) ?? (!existing ? nameProblem(name, await founderNames(db)) : undefined);
    if (problem) return again(problem);
    if (await db.prepare("SELECT 1 FROM founders WHERE emailSha256 = ?").bind(await sha256Hex(email)).first()) {
      return again("That address belongs to one of the founders. Use your own.");
    }
    if (email !== inv.invite.email) return again("This invitation is for another address. Use the address the founder invited.", 403);
    if (existing && action === "create") return again('An account with that email already exists. Use "I already have an account" below.');
    if (existing && !existing.emailVerifiedAt) return again("Ask the person who invited you for a recovery link for this older account.", 403);
    return requestCode(req, env, email, { person: existing ?? undefined, invite: inv.invite, name });
  }
  return joinPage(env, token, inv, signedIn, {}, 400);
}

// -------------------------------------------------------------------------------- email codes

interface EmailCode {
  tokenHash: string; codeHash: string; email: string; personId: string | null; inviteId: string | null;
  name: string; secret: string; recoveryHash: string | null; sessionsFrom: number; expiresAt: string; attempts: number;
}


async function requestCode(req: Request, env: Env, email: string, o: { person?: Person; invite?: Invite; name?: string; recoveryHash?: string } = {}): Promise<Response> {
  if (!canEmail(env)) return message("Email is unavailable", "Ask the person who invited you to try again later. No sign-in code can be sent right now.", 503);
  const wait = await reserveTry(env.DB, (await guessKeys(req, email)).map(k => `mail:${k}`));
  if (wait) return message("Too many requests", `Wait ${waitWords(wait)}, then try again.`, 429);
  const { token, hash } = await newToken();
  const back = new URL(req.url).pathname;
  // Decoys follow the same wrong-guess path but can never match a six-digit submission.
  const eligible = !!(o.person || o.invite);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const digits = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const codeHash = await emailCodeHash(env.SESSION_SECRET, token, eligible ? digits : randomId("decoy", 32));
  const secret = o.person?.secret ?? "";
  await env.DB.prepare("DELETE FROM email_codes WHERE expiresAt < ?").bind(at).run();
  await env.DB.prepare("INSERT INTO email_codes (tokenHash,codeHash,email,personId,inviteId,name,secret,sessionsFrom,expiresAt,recoveryHash) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(hash, codeHash, email, o.person?.id ?? null, o.invite?.id ?? null, o.name ?? "", secret, o.person?.sessionsFrom ?? 0, new Date(now + CODE_MINUTES * 60_000).toISOString(), o.recoveryHash ?? null).run();
  if (!eligible) return codePage(token, "", 200, back);
  try {
    await env.MAIL!.send({ from: { email: env.FROM_ADDRESS!, name: "Descant" }, to: email, subject: "Your Descant sign-in code",
      text: `Your Descant code is ${digits}.\n\nEnter it on the page where you asked for it. It works once, for ${CODE_MINUTES} minutes.\n\nIf you did not ask for this code, ignore this email.` });
  } catch {
    // Returning sign-in must not reveal whether an address exists through delivery errors.
    if (!o.invite && !o.recoveryHash) {
      await env.DB.prepare("UPDATE email_codes SET codeHash=?,personId=NULL,name='',secret='',sessionsFrom=0 WHERE tokenHash=?")
        .bind(await emailCodeHash(env.SESSION_SECRET, token, randomId("decoy", 32)), hash).run();
      return codePage(token, "", 200, back);
    }
    await env.DB.prepare("DELETE FROM email_codes WHERE tokenHash=?").bind(hash).run();
    return message("The code could not be sent", "No account or access was added. Ask the person who invited you to check email delivery, then try again.", 503);
  }
  return codePage(token, "", 200, back);
}

export async function emailCodeRoute(req: Request, env: Env, verify: boolean): Promise<Response> {
  if (!verify) {
    if (req.method !== "POST") return signInPage(env, new URL(req.url).searchParams.get("write") === "1");
    const field = await formOf(req);
    const rawEmail = field("email", 255);
    const email = foldEmail(rawEmail);
    const problem = emailProblem(email);
    if (rawEmail.length > 254 || problem) return message("Check your email address", problem ?? "Use an email address of at most 254 characters.", 400);
    const founder = await requestFounderCode(req, env, email);
    if (founder) return founder;
    const person = await personByEmail(env.DB, email);
    return requestCode(req, env, email, { person: person?.emailVerifiedAt ? person : undefined });
  }
  if (req.method !== "POST") return redirect("/signin");
  const field = await formOf(req);
  const token = field("challenge", 44);
  const back = field("back", 100);
  const invalid = () => message("This code no longer works", "It expired, was used, or had too many guesses. Ask for a new code.", 410);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return invalid();
  const code = field("code", 7);
  if (!/^[0-9]{6}$/.test(code)) return codePage(token, "That code does not match. Try again.", 401, back);
  const founder = await verifyFounderCode(req, env, token, code, back);
  if (founder) return founder;
  const at = new Date().toISOString();
  const hash = await sha256Hex(token);
  const valid = "tokenHash=? AND usedAt IS NULL AND expiresAt>? AND attempts<5";
  const live = await env.DB.prepare("SELECT email FROM email_codes WHERE " + valid).bind(hash, at).first<{ email: string }>();
  if (!live) return invalid();
  // Founder, reader and unknown addresses share a stable guess limit across fresh challenges.
  const keys = (await guessKeys(req, await sha256Hex(live.email))).map(k => `code:${k}`);
  const wait = await reserveTry(env.DB, keys);
  if (wait) return codePage(token, `Too many tries. Wait ${waitWords(wait)}, then try again.`, 429, back);
  const row = await env.DB.prepare("UPDATE email_codes SET attempts=attempts+1 WHERE tokenHash=? AND usedAt IS NULL AND expiresAt>? AND attempts<5 RETURNING *")
    .bind(hash, at).first<EmailCode>();
  if (!row) return invalid();
  if (!sameText(row.codeHash, await emailCodeHash(env.SESSION_SECRET, token, code))) return codePage(token, "That code does not match. Try again.", 401, back);
  const person = row.personId ? await personByEmail(env.DB, row.email) : null;
  if (row.personId && (!person || person.id !== row.personId || person.secret !== row.secret || person.sessionsFrom !== row.sessionsFrom)) return invalid();
  const inv = row.inviteId ? await env.DB.prepare("SELECT * FROM invites WHERE id=?").bind(row.inviteId).first<Invite>() : null;
  if (row.inviteId && (!inv || inv.email !== row.email || inviteState(inv) !== "live")) return invalid();
  if (!person && !inv) return invalid();
  // Founder identities and naming rules may have changed while the reader checked their inbox.
  if (await env.DB.prepare("SELECT 1 FROM founders WHERE emailSha256=?").bind(await sha256Hex(row.email)).first()) return invalid();
  if (!person && nameProblem(row.name, await founderNames(env.DB))) return invalid();
  const from = row.recoveryHash ? Math.max(Math.floor(Date.now() / 1000), person?.sessionsFrom ?? 0) + 1 : person?.sessionsFrom ?? 0;
  const id = person?.id ?? randomId("p");
  try {
    const kept = await env.DB.batch([
      // The trigger rechecks the live challenge, account and invitation inside this transaction.
      env.DB.prepare("UPDATE email_codes SET usedAt=? WHERE tokenHash=?").bind(at, hash),
      ...(row.recoveryHash ? [env.DB.prepare("UPDATE onetime SET usedAt=? WHERE tokenHash=? AND kind='reset' AND EXISTS (SELECT 1 FROM email_codes WHERE tokenHash=? AND usedAt=?)").bind(at, row.recoveryHash, hash, at)] : []),
      person
        ? env.DB.prepare("UPDATE people SET emailVerifiedAt=?,secret='',sessionsFrom=? WHERE id=? AND EXISTS (SELECT 1 FROM email_codes WHERE tokenHash=? AND usedAt=?)").bind(at, from, id, hash, at)
        : env.DB.prepare("INSERT INTO people (id,name,email,secret,createdAt,lastSeenAt,emailVerifiedAt) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM email_codes WHERE tokenHash=? AND usedAt=?)").bind(id, row.name, row.email, "", at, at, at, hash, at),
      ...(inv ? useInvite(env.DB, inv, id, at, hash) : []),
    ]);
    if (!kept[0].meta.changes) return invalid();
  } catch { return invalid(); }
  await clearFailures(env.DB, keys);
  return signedInAs(env, id, "/", Math.max(Date.now(), from * 1000));
}

// --------------------------------------------------------------------------- account recovery

export const RESET_HOURS = 24;

export async function resetRoute(req: Request, env: Env, token: string): Promise<Response> {
  const hash = await sha256Hex(token);
  const now = new Date();
  const link = await env.DB.prepare("SELECT subject, expiresAt, usedAt FROM onetime WHERE tokenHash=? AND kind='reset'").bind(hash).first<{ subject: string; expiresAt: string; usedAt: string | null }>();
  const person = link ? await env.DB.prepare("SELECT * FROM people WHERE id=?").bind(link.subject).first<Person>() : null;
  if (!link || !person || link.usedAt || link.expiresAt <= now.toISOString()) {
    return message("This recovery link does not work", "It has been used, it has expired, or it was never made. Ask the person who invited you for a new one.", 410);
  }
  if (req.method !== "POST") return page("Recover your account · Descant", `<h1>Recover your account</h1>
<p>For ${esc(person.name)} (${esc(person.email)}). Verify your inbox to use email codes from now on.</p>
<form method="post" action="/reset/${esc(token)}" class="stack">
<button type="submit">Email me a code</button>
</form>
<p class="quiet">Your comments and shared articles stay with your account. Your other devices will be signed out after verification.</p>`);
  return requestCode(req, env, person.email, { person, recoveryHash: hash });
}

// ---------------------------------------------------------------------------- a founder's link

export async function founderLinkRoute(env: Env, token: string): Promise<Response> {
  const hash = await sha256Hex(token);
  const at = new Date().toISOString();
  const row = await env.DB.prepare("SELECT subject,founderGeneration AS generation,founderEmailSha256 AS emailSha256,founderSignedInAt AS signedInAt FROM onetime WHERE tokenHash=? AND kind='founder'").bind(hash).first<{ subject: string; generation: string | null; emailSha256: string | null; signedInAt: number | null }>();
  // One use and five minutes, decided in one statement so two opens cannot both succeed.
  const spent = row?.generation && row.emailSha256
    ? await env.DB.prepare("UPDATE onetime SET usedAt=? WHERE tokenHash=? AND kind='founder' AND usedAt IS NULL AND expiresAt > ? AND EXISTS (SELECT 1 FROM founders WHERE key=onetime.subject AND emailSha256=onetime.founderEmailSha256) AND COALESCE((SELECT generation FROM founder_credentials WHERE founderKey=onetime.subject),'none')=onetime.founderGeneration").bind(at, hash, at).run()
    : undefined;
  if (!row || spent?.meta.changes !== 1) {
    return message("This link has been used or has expired", "A founder's link opens the dashboard once, within five minutes. Choose People and sharing in the writing app again for a new one.", 410);
  }
  // A link made from a writing session opens one that ends when that session's year ends.
  if (row.signedInAt !== null && founderMaxAge(row.signedInAt) <= 0) return message("Your sign-in has ended", "A sign-in to write lasts a year. Sign in again, then choose People and sharing.", 401, '<p><a href="/signin?write=1">Sign in to write</a></p>');
  const value = await founderSessionCookie(env, row.subject, false, row.generation!, row.emailSha256!, row.signedInAt ?? undefined);
  if (!value) return message('Founders only', 'This writing account is no longer available.', 401);
  return redirect("/admin", [value]);
}
