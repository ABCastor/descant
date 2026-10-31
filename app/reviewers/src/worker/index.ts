// Descant: outside readers read and comment on the articles the founders share with them by name.
// One Worker, no framework. It holds only what a founder shared; the private writing app pushes
// that here and pulls the comments back, always calling out (sync.ts), never called.

import { adminRoute } from "./admin.ts";
import { authenticatedFounder, founderPasswordSettings, founderPasswordSignIn } from './founder-password.ts';
import { emailCodeRoute, founderLinkRoute, joinRoute, readerCookie, resetRoute, signInRoute, signOutRoute } from "./auth.ts";
import { readerApi } from "./reader.ts";
import { FOUNDER_COOKIE, READER_COOKIE, READER_DAYS, readCookie, signedInAt, verifySession } from "./session.ts";
import { syncRoute } from "./sync.ts";
import { knownFounder, writerRoute } from "./writer.ts";
import { getPerson, readable, type Env, type Person } from "./store.ts";
import { json, message, page, redirect, sameSite, secure } from "./web.ts";

export type { Env } from "./store.ts";

// The only files served from public/, by the address the page asks for them at.
const FILES: Record<string, { file: string; type: string; cache?: string }> = {
  "/descant.css": { file: "/descant.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  "/favicon.svg": { file: "/favicon.svg", type: "image/svg+xml" },
  "/favicon.ico": { file: "/favicon.ico", type: "image/x-icon" },
  "/icons/apple-touch-icon.png": { file: "/icons/apple-touch-icon.png", type: "image/png" },
  "/fonts/literata.woff2": { file: "/fonts/literata.woff2", type: "font/woff2" },
  "/fonts/randosans-500-sharpie.woff2": { file: "/fonts/randosans-500-sharpie.woff2", type: "font/woff2" },
};
const TOKEN = "([A-Za-z0-9_-]{43})";
const LAST_SEEN_MS = 15 * 60_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      console.error(String(err).slice(0, 300));
      return secure(message("Something went wrong", "That could not be done. Nothing was changed; try again in a moment.", 500));
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const post = req.method === "POST";

  // Only https, so a code or a session never crosses the network in clear. This machine's own
  // loopback (wrangler dev) is the one exception.
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    url.protocol = "https:";
    return secure(redirect(url.toString(), [], 301));
  }

  // The private server, with its token: no cookies, no pages.
  if (path.startsWith("/sync/")) return secure(await syncRoute(req, env, url));
  if (path === "/write" || path.startsWith("/write/")) return writerRoute(req, env, url);

  if (req.method !== "GET" && req.method !== "HEAD" && !post) return secure(json({ error: "method-not-allowed" }, 405, { Allow: "GET, POST" }));
  // A POST from anywhere but this site's own pages changes nothing.
  if (post && !sameSite(req)) {
    return secure(path.startsWith("/api/")
      ? json({ ok: false, reason: "cross-site", error: "That request came from another site." }, 403)
      : message("Refused", "That form came from another site, so nothing was done.", 403));
  }

  const file = FILES[path];
  if (file && !post) return asset(env, url, file.file, file.type, file.cache);
  if (path === "/robots.txt") return secure(new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } }));

  // Reject excess public traffic before any database read. The platform supplies
  // this address; arbitrary cookies or supplied user IDs cannot split the bucket.
  // A generous shared-address allowance keeps the small invited cohort usable.
  if (env.PUBLIC_REQUESTS) {
    const allowed = await env.PUBLIC_REQUESTS.limit({ key: req.headers.get("CF-Connecting-IP") || "unknown" });
    if (!allowed.success) return secure(json({ ok: false, reason: "rate-limited", error: "Too many requests. Your unsent words are kept; try again in a minute." }, 429, { "Retry-After": "60" }));
  }

  const who = await reader(req, env);
  const person = who?.person ?? null;
  const refresh = async (res: Response): Promise<Response> => {
    const out = secure(res);
    if (who && who.expires - Date.now() < (READER_DAYS - 1) * 86_400_000) out.headers.append("Set-Cookie", await readerCookie(env, who.person.id));
    return out;
  };

  if (path === "/signin") return secure(await signInRoute(req, env));
  if (path === '/signin/password') return secure(await founderPasswordSignIn(req, env));
  if (path === '/admin/password') return secure(await founderPasswordSettings(req, env));
  if (path === "/signin/code" || path === "/signin/code/verify") return secure(await emailCodeRoute(req, env, path.endsWith("/verify")));
  if (path === "/signout") return secure(signOutRoute(req));
  let m = new RegExp(`^/join/${TOKEN}$`).exec(path);
  if (m) return secure(await joinRoute(req, env, m[1], person));
  m = new RegExp(`^/reset/${TOKEN}$`).exec(path);
  if (m) return secure(await resetRoute(req, env, m[1]));
  m = new RegExp(`^/founder/${TOKEN}$`).exec(path);
  // Only a GET spends a founder's link: a HEAD (a link checker, a preview) leaves it unused.
  if (m && req.method === "GET") return secure(await founderLinkRoute(env, m[1]));

  if (path === "/admin" || path.startsWith("/admin/")) {
    const founder = await authenticatedFounder(req, env);
    if (!founder) return secure(message("Founders only", "Open People and sharing from the writing app's command palette; it opens this page signed in.", 401));
    return secure(await adminRoute(req, env, url, founder.subject));
  }

  if (path.startsWith("/api/")) {
    if (!person) return secure(json({ ok: false, reason: "signed-out", error: "Sign in again." }, 401));
    return refresh(await readerApi(req, env, url, person));
  }

  if (path === "/read") return secure(redirect("/read/" + url.search, [], 301));
  if (path === "/read/" && !post) {
    if (!person) return secure(redirect("/signin"));
    return refresh(await readerPage(env, url));
  }

  if (path === "/" && !post) {
    if (env.WRITER_ORIGIN && await knownFounder(req, env)) return secure(redirect("/write/"));
    if (person) {
      const first = (await readable(env.DB, person.id))[0];
      if (first) return refresh(redirect("/read/?live=" + encodeURIComponent(first.path).replace(/%2F/g, "/")));
      return refresh(page("Descant", `<h1>Nothing is shared with you right now</h1>
<p>${"When someone shares an article with you, it opens here."}</p>
<form method="post" action="/signout"><button type="submit">Sign out</button></form>`));
    }
    if (await authenticatedFounder(req, env)) return secure(redirect("/admin"));
    return secure(redirect("/signin"));
  }
  return secure(path.startsWith("/api/") ? json({ error: "not-found" }, 404) : message("Not found", "There is nothing at this address.", 404));
}

/** The signed-in reader, or undefined: a valid session, an account that still exists, and no reset since. */
async function reader(req: Request, env: Env): Promise<{ person: Person; expires: number } | undefined> {
  const session = await verifySession(env.SESSION_SECRET, "v1", readCookie(req.headers.get("Cookie"), READER_COOKIE));
  if (!session) return undefined;
  const person = await getPerson(env.DB, session.subject);
  if (!person || signedInAt(session.expires) < person.sessionsFrom * 1000) return undefined;
  const now = Date.now();
  if (!person.lastSeenAt || now - Date.parse(person.lastSeenAt) > LAST_SEEN_MS) {
    await env.DB.prepare("UPDATE people SET lastSeenAt=? WHERE id=?").bind(new Date(now).toISOString(), person.id).run();
  }
  return { person, expires: session.expires };
}

async function asset(env: Env, url: URL, file: string, type: string, cache = "public, max-age=86400"): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(file, url.origin)));
  if (!res.ok) return secure(message("Not found", "There is nothing at this address.", 404));
  return secure(new Response(res.body, { headers: { "Content-Type": type } }), undefined, cache);
}

/**
 * The founders' own app, built in reviewer mode with no article inside it (build.py
 * --public-reviewer). It runs only the inline scripts whose hashes the build listed beside it.
 */
async function readerPage(env: Env, url: URL): Promise<Response> {
  const [html, hashes] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL("/app.html", url.origin))),
    env.ASSETS.fetch(new Request(new URL("/app.csp.json", url.origin))),
  ]);
  let scripts: string[] = [];
  try {
    const listed = hashes.ok ? ((await hashes.json()) as { scripts?: unknown }).scripts : [];
    scripts = Array.isArray(listed) ? listed.filter((h): h is string => typeof h === "string" && /^sha256-[A-Za-z0-9+/]{43}=$/.test(h)) : [];
  } catch {
    scripts = [];
  }
  if (!html.ok || !scripts.length) return message("Not ready", "The reading page is not ready on this server yet.", 503);
  const csp = [
    "default-src 'none'",
    `script-src ${scripts.map((h) => `'${h}'`).join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join("; ");
  return new Response(html.body, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "Cache-Control": "no-cache" } });
}
