// The public writer has its own namespace and founder identity, independent of
// reader sessions. Only this server supplies the per-founder origin credential.
import { authenticatedFounder } from "./founder-password.ts";
import type { Env } from "./store.ts";
import { sha256Hex } from "./session.ts";
import { json, redirect, secure } from "./web.ts";

const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 24 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const READ = new Set(["whoami", "pieces", "piece", "piece/live", "site-tags", "drafts", "comments", "search", "mentions", "graph", "canvas", "files/content", "publication", "sync", "save-status", "offline"]);
const WRITE = new Set(["piece", "pieces/new", "drafts", "comments", "comments/action", "mentions/read", "files/mkdir", "files/upload", "files/move", "files/order", "share/admin-link", "share/article", "agent/batch"]);
const STATIC: Record<string, string> = {
  "/write/": "text/html; charset=utf-8",
  "/write/sw.js": "text/javascript; charset=utf-8",
  "/write/manifest.webmanifest": "application/manifest+json",
  "/write/favicon.svg": "image/svg+xml",
  "/write/favicon.ico": "image/x-icon",
  ...Object.fromEntries(["apple-touch-icon.png", "castor-192.png", "castor-512.png", "castor-maskable-512.png"].map(n => ["/write/icons/" + n, "image/png"])),
  ...Object.fromEntries(["literata.woff2", "randosans-500-sharpie.woff2", "sourceserif4.woff2", "sourceserif4-italic.woff2", "commissioner.woff2", "martianmono.woff2", "newsreader.woff2"].map(n => ["/write/fonts/" + n, "font/woff2"])),
};

export async function knownFounder(req: Request, env: Env): Promise<string | undefined> {
  return (await authenticatedFounder(req, env))?.subject;
}

export async function originCredential(sha256: string, principal: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(sha256), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("descant.writer.v1:" + principal)));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > limit) throw new Error("body-limit");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function fail(reason: string, status: number, headers: Record<string, string> = {}): Response {
  return secure(json({ ok: false, reason, error: reason }, status, headers), undefined, "private, no-store");
}

function headerParts(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  return quoted ? [] : [...parts, value.slice(start).trim()];
}

interface AssetGeneration { assets: string; files: Record<string, string> }
const assetName = (path: string): string => path === "/write/" ? "index.html" : path.slice("/write/".length);
const ASSET_NAMES = [...Object.keys(STATIC).map(assetName), "app.csp.json"];

async function assetGeneration(env: Env, url: URL): Promise<AssetGeneration | undefined> {
  try {
    const response = await env.ASSETS.fetch(new Request(new URL("/write/asset-generation.json", url.origin)));
    if (response.status !== 200) return undefined;
    const listed = JSON.parse(new TextDecoder().decode(await bounded(response.body, 4096))) as { v?: unknown; assets?: unknown; files?: unknown };
    if (listed.v !== 1 || typeof listed.assets !== "string" || !/^[a-f0-9]{64}$/.test(listed.assets) || !listed.files || typeof listed.files !== "object" || Array.isArray(listed.files)) return undefined;
    const files = listed.files as Record<string, unknown>;
    if (Object.keys(files).length !== ASSET_NAMES.length || !ASSET_NAMES.every(name => Object.hasOwn(files, name) && typeof files[name] === "string" && /^[a-f0-9]{64}$/.test(files[name]))) return undefined;
    return { assets: listed.assets, files: files as Record<string, string> };
  } catch { return undefined; }
}

async function writerCsp(env: Env, url: URL): Promise<string | undefined> {
  try {
    const hashes = await env.ASSETS.fetch(new Request(new URL("/write/app.csp.json", url.origin)));
    if (hashes.status !== 200) return undefined;
    const listed = JSON.parse(new TextDecoder().decode(await bounded(hashes.body, 64 * 1024))) as { scripts?: unknown };
    const scripts = listed.scripts;
    if (!Array.isArray(scripts) || !scripts.length || !scripts.every(h => typeof h === "string" && /^sha256-[A-Za-z0-9+/]{43}=$/.test(h))) return undefined;
    return ["default-src 'none'", "script-src " + scripts.map(h => "'" + h + "'").join(" "), "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data: blob:", "connect-src 'self' http://127.0.0.1:47231", "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");
  } catch { return undefined; }
}

async function offlineAssetsMatch(content: Uint8Array, generation: AssetGeneration, env: Env, url: URL): Promise<boolean> {
  try {
    const payload = JSON.parse(new TextDecoder().decode(content)) as { chunks?: unknown };
    if (!Array.isArray(payload.chunks)) return false;
    let csp: string | undefined;
    for (const row of payload.chunks) {
      if (!row || typeof row.url !== "string") return false;
      if (row.url.startsWith("/write/api/")) continue;
      if (!Object.hasOwn(STATIC, row.url) || row.sha256 !== generation.files[assetName(row.url)]) return false;
      if (row.url === "/write/") {
        csp ??= await writerCsp(env, url);
        if (!csp || row.headers?.["Content-Security-Policy"] !== csp) return false;
      }
    }
    return true;
  } catch { return false; }
}

async function writerAsset(req: Request, env: Env, url: URL, principal: string): Promise<Response> {
  const shell = url.pathname === "/write/";
  try {
    const response = await env.ASSETS.fetch(new Request(new URL(shell ? "/write/index.html" : url.pathname, url.origin)));
    if (response.status !== 200) return fail("writer-assets-unavailable", shell ? 503 : 404);
    // Fonts and icons rarely change: the browser keeps them a week. The page and
    // its worker are always checked first, and come back as 304 when unchanged.
    const lasting = url.pathname.startsWith("/write/fonts/") || url.pathname.startsWith("/write/icons/");
    const headers = new Headers({ "Content-Type": STATIC[url.pathname], "Cache-Control": lasting ? "private, max-age=604800" : "private, no-cache", "X-Descant-Account": "founder:" + principal });
    if (shell) {
      const csp = await writerCsp(env, url);
      if (!csp) return fail("writer-assets-unavailable", 503);
      headers.set("Content-Security-Policy", csp);
    }
    if (url.pathname === "/write/sw.js") {
      headers.set("Service-Worker-Allowed", "/write");
      headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'");
    }
    const generation = await assetGeneration(env, url);
    if (shell || url.pathname === "/write/sw.js") {
      if (!generation) return fail("writer-assets-unavailable", 503);
      headers.set("X-Descant-Assets", generation.assets);
    }
    // The page's policy comes from another file, so its tag is the whole release's.
    const fileHash = generation && (shell ? generation.assets : generation.files[assetName(url.pathname)]);
    if (fileHash) {
      // One tag per file version and founder: another founder's copy never matches.
      const account = (await sha256Hex("descant-writer-etag:" + principal)).slice(0, 16);
      const tag = '"' + fileHash.slice(0, 32) + "." + account + '"';
      headers.set("ETag", tag);
      // If-None-Match compares weakly (RFC 9110): the edge may mark the tag weak when it compresses.
      if (headerParts(req.headers.get("If-None-Match") || "", ",").some(part => part.replace(/^W\//, "") === tag)) {
        await response.body?.cancel().catch(() => {});
        return secure(new Response(null, { status: 304, headers }));
      }
    }
    const content = await bounded(response.body, MAX_RESPONSE);
    return secure(new Response(req.method === "HEAD" ? null : content, { headers }));
  } catch { return fail("writer-assets-unavailable", 503); }
}

export async function writerRoute(req: Request, env: Env, url: URL): Promise<Response> {
  if (env.PUBLIC_REQUESTS && !(await env.PUBLIC_REQUESTS.limit({ key: req.headers.get("CF-Connecting-IP") || "unknown" })).success) return fail("rate-limited", 429, { "Retry-After": "60" });
  const principal = await knownFounder(req, env);
  if (!principal) {
    const document = req.method === "GET" && ["/write", "/write/"].includes(url.pathname)
      && headerParts(req.headers.get("Accept") || "", ",").some(member => {
        const [type, ...params] = headerParts(member, ";");
        const weights = params.filter(param => /^q=/i.test(param));
        const weight = weights.length ? weights[0].slice(2) : "1";
        return type?.toLowerCase() === "text/html" && weights.length <= 1
          && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight) && Number(weight) > 0;
      });
    return document ? secure(redirect("/signin?write=1"), undefined, "private, no-store") : fail("founder-required", 401);
  }
  // The writer answers only on the address the deployment names (APP_URL in its wrangler config).
  if (!env.APP_URL) return fail("writer-not-configured", 503);
  const publicOrigin = env.APP_URL;
  if (url.origin !== new URL(publicOrigin).origin) return fail("invalid-host", 403);
  const originHeader = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  // A signed-in founder may follow an external navigation into the shell.
  // Controlled Chrome navigations report destination empty. Frame-ancestors
  // blocks embedding; API calls and mutations still require the site's page.
  const entry = req.method === "GET" && ["/write", "/write/"].includes(url.pathname)
    && originHeader === null && ["cross-site", "same-site"].includes(site || "")
    && req.headers.get("Sec-Fetch-Mode") === "navigate" && ["document", "empty"].includes(req.headers.get("Sec-Fetch-Dest") || "");
  if ((originHeader !== null && originHeader !== url.origin) || (!entry && site !== null && !["same-origin", "none"].includes(site))) return fail("cross-site", 403);
  const mutation = req.method === "POST" || req.method === "PUT";
  if (mutation && originHeader !== url.origin) return fail("cross-site", 403);
  if (req.method !== "GET" && req.method !== "HEAD" && !mutation) return fail("method-not-allowed", 405);
  if (url.pathname === "/write") return secure(redirect("/write/" + url.search), undefined, "private, no-store");
  if (/%|\\|\/\/|(?:^|\/)\.\.?($|\/)/.test(url.pathname)) return fail("not-found", 404);
  const api = url.pathname.startsWith("/write/api/") ? url.pathname.slice("/write/api/".length) : "";
  const staticFile = Object.hasOwn(STATIC, url.pathname);
  const allowed = req.method === "GET" ? staticFile || READ.has(api)
    : req.method === "HEAD" ? staticFile
    : req.method === "POST" ? WRITE.has(api) : api === "canvas";
  if (!allowed) return fail("not-found", 404);
  if (staticFile) return writerAsset(req, env, url, principal);
  if (!env.WRITER_ORIGIN || !/^[0-9a-f]{64}$/.test(env.SHARE_TOKEN_SHA256)) return fail("writer-not-configured", 503);
  let origin: URL;
  try { origin = new URL(env.WRITER_ORIGIN); } catch { return fail("writer-not-configured", 503); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return fail("writer-not-configured", 503);
  // Who is asking is this Worker's answer: it authenticated the founder above, and
  // the origin's reply is a function of that principal alone. Asking the origin
  // would put a tunnel round trip before every article read. The offline check's
  // live admission still goes to the origin, which compares asset generations. X-Descant-Identity
  // tells the page's service worker that the origin was not asked, so this answer never lifts a
  // denial the origin gave or renews the device's offline grant (writer-sw.js).
  if (req.method === "GET" && api === "whoami" && req.headers.get("X-Descant-Flight-Online") !== "1") {
    return secure(json({ role: "founder", id: "founder:" + principal, who: principal, publicWriter: true }, 200, { "X-Descant-Account": "founder:" + principal, "X-Descant-Identity": "edge" }), undefined, "private, no-store");
  }
  if (mutation && req.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") return fail("json-only", 415);
  if (Number(req.headers.get("Content-Length") || 0) > MAX_BODY) return fail("body-too-large", 413);
  let body: Uint8Array | undefined;
  try { if (mutation) body = await bounded(req.body, MAX_BODY); } catch { return fail("body-too-large", 413); }
  const headers = new Headers({ Authorization: "Bearer " + await originCredential(env.SHARE_TOKEN_SHA256, principal) });
  // Explicitly negotiate gzip with the private Python origin. Bound the decoded
  // stream below; a compressed Content-Length is not a decoded size limit.
  headers.set("Accept-Encoding", "gzip");
  if (mutation) headers.set("Content-Type", "application/json");
  if (req.method === "GET" && req.headers.get("X-Descant-Flight-Online") === "1") headers.set("X-Descant-Flight-Online", "1");
  // Preserve a proved browser Origin; never fabricate one for a cross-site caller.
  if (originHeader) headers.set("Origin", originHeader);
  const upstream = new URL(url.pathname + url.search, origin);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  let phase = "headers";
  const trace = (event: string, detail: Record<string, string | number> = {}) => {
    // Temporary transport diagnosis. No account, URLs, credentials or source text.
    if (api === "offline") console.log("descant-offline-transfer", { event, phase, ms: Date.now() - started, ...detail });
  };
  try {
    const result = await Promise.race([
      (async () => {
        const response = await fetch(upstream, { method: req.method, headers, body, redirect: "manual", signal: controller.signal });
        const encoding = response.headers.get("Content-Encoding") || "identity";
        trace("headers", { status: response.status, length: Number(response.headers.get("Content-Length") || 0), encoding: ["gzip", "br", "identity"].includes(encoding) ? encoding : "other" });
        if (response.status >= 300 && response.status < 400) return fail("origin-redirect-refused", 502);
        let generation: AssetGeneration | undefined;
        if (response.ok && headers.get("X-Descant-Flight-Online") === "1") {
          phase = "generation";
          generation = await assetGeneration(env, url);
          if (!generation || response.headers.get("X-Descant-Assets") !== generation.assets) {
            await response.body?.cancel().catch(() => {});
            return fail("asset-generation-mismatch", 409);
          }
        }
        phase = "body";
        const content = await bounded(response.body, MAX_RESPONSE);
        trace("body", { bytes: content.byteLength });
        phase = "assets";
        if (generation && api === "offline" && !await offlineAssetsMatch(content, generation, env, url)) return fail("offline-assets-mismatch", 409);
        trace("checked");
        // A password reset during the upstream call must not reveal a fresh bridge link.
        if ((api === "share/admin-link" || api === "share/article") && await knownFounder(req, env) !== principal) return fail("founder-required", 401);
        const clean = new Headers({ "Cache-Control": "private, no-store", "X-Descant-Account": "founder:" + principal });
        if (generation) clean.set("X-Descant-Assets", generation.assets);
        for (const key of ["Content-Type", "Content-Security-Policy", "Content-Disposition", "X-Descant-Snapshot"]) {
          const value = response.headers.get(key);
          if (value) clean.set(key, value);
        }
        if (url.pathname === "/write/sw.js") clean.set("Service-Worker-Allowed", "/write");
        return secure(new Response(req.method === "HEAD" || response.status === 204 ? null : content, { status: response.status, headers: clean }));
      })(),
      new Promise<Response>(resolve => { timer = setTimeout(() => { trace("timeout"); controller.abort(); resolve(fail("origin-timeout", 504)); }, api === "offline" ? 90_000 : TIMEOUT_MS); }),
    ]);
    return result;
  } catch { trace("error"); return fail("writer-unavailable", 502); }
  finally { if (timer) clearTimeout(timer); }
}
