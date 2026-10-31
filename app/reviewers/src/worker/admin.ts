// The founders' dashboard: one page. People (who has an account, what each can read, and the means
// to take any of it away or make a reset link), Links (the invitations, made here and shown once),
// and Articles (what can be shared, and who reads each). A founder grants only what is theirs to
// grant (rules.ts mayShare); taking access away is open to either founder.

import { RESET_HOURS } from "./auth.ts";
import { emailProblem, foldEmail, labelProblem, isTestArticle, mayShare } from "./rules.ts";
import { FOUNDER_COOKIE, cookie, newToken, randomId } from "./session.ts";
import { allArticles, founders, inviteState, type Article, type Env } from "./store.ts";
import { day, esc, message, page, redirect } from "./web.ts";

export const INVITE_DAYS = 14;
const MAX_USES = 50;
const MAX_DAYS = 60;

interface Shown { kind: "link" | "reset"; url: string; who: string }

export async function adminRoute(req: Request, env: Env, url: URL, founder: string): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const post = req.method === "POST";
  if (path === "/admin" && !post) return dashboard(env, founder);
  if (!post) return message("Not found", "There is nothing at this address.", 404);
  if (path === "/admin/signout") return redirect("/", [cookie(FOUNDER_COOKIE, "", 0)]);
  const form = await req.formData().catch(() => new FormData());
  const field = (name: string, max = 200) => {
    const v = form.get(name);
    return typeof v === "string" ? v.slice(0, max) : "";
  };
  const db = env.DB;
  const now = new Date();

  if (path === "/admin/links") {
    const label = field("label", 120).replace(/\s+/g, " ").trim();
    const email = foldEmail(field("email", 254));
    const wanted = [...new Set(form.getAll("article").filter((v): v is string => typeof v === "string"))];
    const uses = Number(field("uses", 4) || "1");
    const days = Number(field("days", 4) || String(INVITE_DAYS));
    const made = await makeInvitation(env, url, founder, label, email, wanted, uses, days);
    if ('problems' in made) return dashboard(env, founder, undefined, made.problems, 400);
    return dashboard(env, founder, { kind: "link", url: made.url, who: label });
  }

  const link = /^\/admin\/links\/(i[0-9a-f]{24})\/revoke$/.exec(path);
  if (link) {
    await db.prepare("UPDATE invites SET revokedAt=? WHERE id=? AND revokedAt IS NULL").bind(now.toISOString(), link[1]).run();
    return redirect("/admin#links");
  }

  const person = /^\/admin\/people\/(p[0-9a-f]{24})\/(remove|reset|articles\/remove)$/.exec(path);
  if (person) {
    const [, id, act] = person;
    const who = await db.prepare("SELECT name FROM people WHERE id=?").bind(id).first<{ name: string }>();
    if (!who) return redirect("/admin#people");
    if (act === "remove") {
      // The account goes and every way in with it; what they already wrote stays with the founders.
      await db.batch([
        db.prepare("DELETE FROM grants WHERE personId=?").bind(id),
        db.prepare("DELETE FROM onetime WHERE kind='reset' AND subject=?").bind(id),
        db.prepare("DELETE FROM people WHERE id=?").bind(id),
      ]);
      return redirect("/admin#people");
    }
    if (act === "articles/remove") {
      await db.prepare("DELETE FROM grants WHERE personId=? AND path=?").bind(id, field("path", 200)).run();
      return redirect("/admin#people");
    }
    const { token, hash } = await newToken();
    await db.batch([
      db.prepare("DELETE FROM onetime WHERE kind='reset' AND subject=?").bind(id),
      db.prepare("INSERT INTO onetime (tokenHash, kind, subject, createdBy, createdAt, expiresAt) VALUES (?, 'reset', ?, ?, ?, ?)")
        .bind(hash, id, founder, now.toISOString(), new Date(now.getTime() + RESET_HOURS * 3_600_000).toISOString()),
    ]);
    return dashboard(env, founder, { kind: "reset", url: `${origin(env, url)}/reset/${token}`, who: who.name });
  }
  return message("Not found", "There is nothing at this address.", 404);
}

const origin = (env: Env, url: URL) => (env.APP_URL || url.origin).replace(/\/$/, "");

// Shared by the dashboard and the writer's article sheet. Access semantics stay identical.
export async function makeInvitation(env: Env, url: URL, founder: string, label: string, email: string, wanted: string[], uses = 1, days = INVITE_DAYS): Promise<{url: string} | {problems: string[]}> {
  const db = env.DB, now = new Date();
  const articles = new Map((await allArticles(db)).map((a) => [a.path, a]));
  const problems: string[] = [];
  const lp = labelProblem(label), ep = emailProblem(email);
  if (lp) problems.push(lp);
  if (ep) problems.push(ep);
  if (!wanted.length) problems.push('Choose at least one article.');
  for (const p of wanted) if (!mayShare(env, founder, articles.get(p))) problems.push(`You cannot share ${articles.get(p)?.title ?? p}: it is another founder's, or it cannot be shared.`);
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES) problems.push(`A link works from 1 to ${MAX_USES} times.`);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) problems.push(`A link lasts from 1 to ${MAX_DAYS} days.`);
  if (problems.length) return {problems};
  const {token, hash} = await newToken(), id = randomId('i');
  await db.batch([
    db.prepare('INSERT INTO invites (id, tokenHash, label, email, createdBy, createdAt, expiresAt, usesLeft) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, hash, label, email, founder, now.toISOString(), new Date(now.getTime() + days * 86_400_000).toISOString(), uses),
    ...wanted.map(p => db.prepare('INSERT INTO invite_articles (inviteId, path) VALUES (?, ?)').bind(id, p)),
  ]);
  return {url: `${origin(env, url)}/join/${token}`};
}

async function dashboard(env: Env, founder: string, shown?: Shown, problems: string[] = [], status = 200): Promise<Response> {
  const db = env.DB;
  const now = new Date();
  const [articles, team, people, grants, invites, inviteArticles] = await Promise.all([
    allArticles(db),
    founders(db),
    db.prepare("SELECT id, name, email, createdAt, lastSeenAt FROM people ORDER BY createdAt").all<{ id: string; name: string; email: string; createdAt: string; lastSeenAt: string | null }>(),
    db.prepare("SELECT personId, path FROM grants ORDER BY path").all<{ personId: string; path: string }>(),
    db.prepare("SELECT id, label, createdBy, createdAt, expiresAt, usesLeft, revokedAt FROM invites ORDER BY createdAt DESC").all<{ id: string; label: string; createdBy: string; createdAt: string; expiresAt: string; usesLeft: number; revokedAt: string | null }>(),
    db.prepare("SELECT inviteId, path FROM invite_articles").all<{ inviteId: string; path: string }>(),
  ]);
  const titleOf = new Map(articles.map((a) => [a.path, a.title]));
  const title = (p: string) => esc(titleOf.get(p) ?? p);
  const me = team.find((f) => f.key === founder)?.name.split(" ")[0] || founder;
  const nameOf = (key: string) => esc(team.find((f) => f.key === key)?.name.split(" ")[0] || key);
  const visible = articles.filter((a) => !isTestArticle(env, a.path));
  const mine = visible.filter((a) => mayShare(env, founder, a));

  const shownBlock = shown
    ? `<section class="shown" role="status">
<h2>${shown.kind === "link" ? `The link for ${esc(shown.who)}` : `A recovery link for ${esc(shown.who)}`}</h2>
<p>Copy it now: it is shown only this once. ${shown.kind === "link" ? "Send the invitation yourself. Descant emails a code when the reader joins." : `It works once, for ${RESET_HOURS} hours.`}</p>
<p><input class="copy" readonly value="${esc(shown.url)}" aria-label="The link"></p>
</section>`
    : "";
  const problemBlock = problems.length ? `<div class="err" role="alert"><p>Nothing was made:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";

  const peopleRows = people.results.map((p) => {
    const theirs = grants.results.filter((g) => g.personId === p.id);
    const reads = theirs.length
      ? `<ul class="plain">${theirs.map((g) => `<li>${title(g.path)} <form method="post" action="/admin/people/${esc(p.id)}/articles/remove" class="inline"><input type="hidden" name="path" value="${esc(g.path)}"><button type="submit" class="small">Remove</button></form></li>`).join("")}</ul>`
      : `<span class="quiet">nothing</span>`;
    return `<tr>
<td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${day(p.createdAt)}</td><td>${day(p.lastSeenAt) || "never"}</td><td>${reads}</td>
<td><form method="post" action="/admin/people/${esc(p.id)}/reset" class="inline"><button type="submit" class="small">Make a recovery link</button></form>
<form method="post" action="/admin/people/${esc(p.id)}/remove" class="inline"><button type="submit" class="small danger">Remove person</button></form></td>
</tr>`;
  }).join("");

  const linkRows = invites.results.map((i) => {
    const st = inviteState(i, now);
    const paths = inviteArticles.results.filter((x) => x.inviteId === i.id).map((x) => title(x.path)).join(", ");
    return `<tr>
<td>${esc(i.label)}</td><td>${paths}</td><td>${i.usesLeft}</td><td>${day(i.expiresAt)}</td><td>${st}</td><td>${nameOf(i.createdBy)}</td>
<td>${st === "live" ? `<form method="post" action="/admin/links/${esc(i.id)}/revoke" class="inline"><button type="submit" class="small danger">Revoke</button></form>` : ""}</td>
</tr>`;
  }).join("");

  const articleRows = visible.map((a: Article) => {
    const readers = grants.results.filter((g) => g.path === a.path).map((g) => esc(people.results.find((p) => p.id === g.personId)?.name ?? "?"));
    const pending = invites.results.filter((i) => inviteState(i, now) === "live" && inviteArticles.results.some((x) => x.inviteId === i.id && x.path === a.path)).map((i) => `${esc(i.label)} (link)`);
    const who = [...readers, ...pending];
    return `<tr><td>${esc(a.title)}</td><td>${esc(a.owner || "unassigned")}</td><td>${mayShare(env, founder, a) ? "yes" : "no"}</td><td>${who.length ? who.join(", ") : `<span class="quiet">nobody</span>`}</td></tr>`;
  }).join("");

  const choices = mine.length
    ? mine.map((a) => `<label class="check"><input type="checkbox" name="article" value="${esc(a.path)}"> ${esc(a.title)}</label>`).join("\n")
    : `<p class="quiet">No article is yours to share yet. The list comes from the writing app within half a minute of it starting.</p>`;

  return page("People and sharing · Descant", `<div class="bar"><h1>People and sharing</h1>
<a href="/admin/password">Password</a>
<form method="post" action="/admin/signout" class="inline"><span class="quiet">${esc(me)}</span> <button type="submit" class="small">Sign out</button></form></div>
${shownBlock}${problemBlock}
<section id="people">
<h2>People</h2>
${people.results.length ? `<div class="wide"><table><thead><tr><th>Name</th><th>Email</th><th>Joined</th><th>Last seen</th><th>Can read</th><th></th></tr></thead><tbody>${peopleRows}</tbody></table></div>` : `<p class="quiet">Nobody has an account yet. Make a link below and send it.</p>`}
</section>
<section id="links">
<h2>Links</h2>
${invites.results.length ? `<div class="wide"><table><thead><tr><th>Label</th><th>Articles</th><th>Uses left</th><th>Expires</th><th>State</th><th>Made by</th><th></th></tr></thead><tbody>${linkRows}</tbody></table></div>` : ""}
<form method="post" action="/admin/links" class="stack make">
<h3>Make a link</h3>
<label>For <input name="label" required maxlength="60" placeholder="Ada"></label>
<label>Email <input type="email" name="email" autocomplete="email" required maxlength="254" placeholder="ada@example.com"></label>
<p class="quiet">The reader must use the address you invite.</p>
<p class="quiet">With Cloudflare's free mail sender, this address must already be a verified destination in your Cloudflare account. Otherwise the reader cannot receive the code to join.</p>
<fieldset><legend>Articles it opens</legend>
${choices}
</fieldset>
<div class="row"><label>Uses <input type="number" name="uses" value="1" min="1" max="${MAX_USES}"></label>
<label>Days <input type="number" name="days" value="${INVITE_DAYS}" min="1" max="${MAX_DAYS}"></label></div>
<button type="submit">Make the link</button>
</form>
</section>
<section id="articles">
<h2>Articles</h2>
<div class="wide"><table><thead><tr><th>Article</th><th>Owner</th><th>Yours to share</th><th>Who can read it</th></tr></thead><tbody>${articleRows}</tbody></table></div>
</section>`, status);
}
