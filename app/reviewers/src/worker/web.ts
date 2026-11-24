// The plumbing every response shares: escaping, the plain house page, the security headers, and the
// check that a POST came from this site's own pages.

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The house look kept plain: the system font, the product's name with its typed terracotta
// asterisk, 1 px lines. The stylesheet is public/descant.css, so these pages need no inline style.
// The page reaches under a phone's status bar and home indicator (viewport-fit=cover) and its paper
// colours the browser around it, so the screen is one surface. Sign-in pages (auth) are one narrow
// column under the product's name.
// The one script these pages run. iOS shows a button's :active press under a finger only when the
// page listens for touches; this listener does nothing and never holds a scroll (passive). The pages'
// policy allows it alone, by its hash (PAGE_CSP).
const PRESS = "document.addEventListener('touchstart',function(){},{passive:true,capture:true})";
const PRESS_HASH = "sha256-QB/xoQhM52IzteDF9g1nhiba5VsZKvPp02XDjCSE48M=";

export function page(title: string, body: string, status = 200, headers: Record<string, string> = {}, layout: "plain" | "auth" = "plain"): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F7F4EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/descant.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>${PRESS}</script>
</head>
<body class="${layout}">
<header class="brand"><a href="/">Descant<span class="ast">*</span></a><span class="brand-line" aria-hidden="true"><span class="brand-dot"></span></span></header>
<main>
${body}
</main>
</body>
</html>
`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

export function redirect(to: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ Location: to });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status, headers });
}

/** A plain page with one paragraph: what happened, in words. */
export function message(title: string, text: string, status: number, extra = ""): Response {
  return page(title, `<h1>${esc(title)}</h1>\n<p>${esc(text)}</p>\n${extra}`, status, {}, "auth");
}

// Pages made here run one script, the touch listener above, and nothing else; the reader's page
// carries its own policy (index.ts).
const PAGE_CSP = `default-src 'none'; script-src '${PRESS_HASH}'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

/** The headers every answer carries, whatever made it. */
export function secure(res: Response, csp = PAGE_CSP, cache = "no-store"): Response {
  const r = new Response(res.body, res);
  const h = r.headers;
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", csp);
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Strict-Transport-Security", "max-age=31536000");
  if (!h.has("Cache-Control")) h.set("Cache-Control", cache);
  return r;
}

/**
 * True when a POST came from one of this site's own pages. The cookies are SameSite=Lax, so a
 * cross-site POST never carries them; this is the second lock. A fetch from the page sends its
 * Origin; a plain form under `Referrer-Policy: no-referrer` sends `Origin: null`, and then the
 * browser's own Sec-Fetch-Site must say same-origin. Anything else is refused.
 */
export function sameSite(req: Request): boolean {
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") return false;
  if (origin === new URL(req.url).origin) return true;
  return (origin === null || origin === "null") && site === "same-origin";
}

/** A form's fields, each one string, cut at `max` characters. */
export async function formOf(req: Request): Promise<(name: string, max?: number) => string> {
  const kind = (req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  let form: FormData | undefined;
  if (kind === "application/x-www-form-urlencoded" || kind === "multipart/form-data") {
    try {
      form = await req.formData();
    } catch {
      form = undefined;
    }
  }
  return (name: string, max = 1000) => {
    const v = form?.get(name);
    return typeof v === "string" ? v.slice(0, max) : "";
  };
}

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
