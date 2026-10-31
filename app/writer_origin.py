"""A separate, credential-gated listener for the public writer proxy.

The trusted Tailnet handler remains separate. This listener never falls through to
SimpleHTTPRequestHandler, directory listings, repository files or agent posting/context APIs.
"""
import hashlib
import hmac
import io
import json
import os
import re
import tempfile
from urllib.parse import parse_qs, urlsplit

GET_ROUTES = {
    "/api/pieces": "api_pieces", "/api/piece": "api_piece", "/api/piece/live": "api_piece_live",
    "/api/drafts": "api_drafts_get", "/api/comments": "api_comments",
    "/api/site-tags": "api_site_tags",
    "/api/search": "api_search", "/api/mentions": "api_mentions",
    "/api/graph": "api_graph",
    "/api/canvas": "api_canvas_get", "/api/files/content": "api_files_content",
    "/api/publication": "api_publication", "/api/offline": "api_offline",
}
POST_ROUTES = {
    "/api/piece": "api_piece_write", "/api/drafts": "api_drafts_write",
    "/api/comments": "api_comments_write", "/api/comments/action": "api_comment_action",
    "/api/mentions/read": "api_mentions_read", "/api/files/mkdir": "api_files_mkdir",
    "/api/files/upload": "api_files_upload", "/api/files/move": "api_files_move",
    "/api/files/order": "api_files_order", "/api/agent/batch": "api_agent_batch",
    "/api/share/article": "api_share_article", "/api/pieces/new": "api_pieces_new",
}
STATIC = {"/": "index.html", "/sw.js": "@worker", "/manifest.webmanifest": "manifest.webmanifest",
          "/favicon.ico": "favicon.ico", "/favicon.svg": "favicon.svg",
          **{"/icons/" + n: "icons/" + n for n in ("apple-touch-icon.png", "castor-192.png", "castor-512.png", "castor-maskable-512.png")},
          **{"/fonts/" + n: "fonts/" + n for n in ("literata.woff2", "randosans-500-sharpie.woff2", "sourceserif4.woff2", "sourceserif4-italic.woff2", "commissioner.woff2", "martianmono.woff2", "newsreader.woff2")}}


def public_origin(app):
    """The reader service's origin, whose pages are the only ones that may talk to this
    writer: DESCANT_PUBLIC_ORIGIN, else --share-to, else the space's publicOrigin."""
    import space_config
    value = os.environ.get("DESCANT_PUBLIC_ORIGIN") or getattr(app, "SHARE", {}).get("url") or space_config.value("publicOrigin") or ""
    return str(value).rstrip("/")


def credential(token_sha256, principal):
    """Same lowercase hex key/message contract as the Worker; never browser-visible."""
    return hmac.new(token_sha256.encode("ascii"), ("descant.writer.v1:" + principal).encode("ascii"), hashlib.sha256).hexdigest()


def asset_generation(app):
    """Actual served frontend bytes, never a stored sidecar or cached fingerprint."""
    names = ["sw.js" if name == "@worker" else name for name in STATIC.values()] + ["app.csp.json"]
    generation = hashlib.sha256(b"descant.writer.assets.v1\x00")
    for name in sorted(names):
        target = app.APP_DIR / ("writer-sw.js" if name == "sw.js" else "public-writer/" + name)
        generation.update(name.encode("utf-8") + b"\x00")
        generation.update(hashlib.sha256(target.read_bytes()).digest())
    return generation.hexdigest()


def snapshot(app):
    """Fingerprint canonical inputs and executable assets while WRITE_LOCK is held."""
    revision = hashlib.sha256(app.git('rev-parse', 'HEAD').stdout.strip().encode('ascii'))
    revision.update(asset_generation(app).encode('ascii'))
    roots = ((app.REPO_ROOT / 'articles', app.REPO_ROOT),
             (app.APP_DIR / 'public-writer', app.APP_DIR))
    for root, base in roots:
        for file in sorted(root.rglob('*')):
            if file.is_file() and not file.is_symlink():
                revision.update(file.relative_to(base).as_posix().encode('utf-8'))
                revision.update(b'\x00'); revision.update(hashlib.sha256(file.read_bytes()).digest())
    return revision.hexdigest()


def handler_for(app):
    class WriterHandler(app.Handler):
        def end_headers(self):
            if getattr(self, '_writer_principal', None) and self.headers.get('X-Descant-Flight-Online') == '1':
                # Every preparation response names the same canonical generation.
                # dispatch holds WRITE_LOCK across the read and this fingerprint.
                try:
                    revision = snapshot(app)
                    generation = asset_generation(app)
                    if generation == getattr(self, '_writer_assets_start', None):
                        self.send_header('X-Descant-Snapshot', revision)
                        self.send_header('X-Descant-Assets', generation)
                except OSError:
                    # A successful response with incomplete frontend files has
                    # no generation proof; the edge refuses flight preparation.
                    pass
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.send_header("X-Frame-Options", "DENY")
            if getattr(self, "_writer_principal", None):
                self.send_header("X-Descant-Account", "founder:" + self._writer_principal)
            # Handler's caching rules must never add a public cache policy.
            self._cached_headers_sent = True
            super().end_headers()

        def may_read(self, path):
            return bool(app.article_path(path) or app.draft_path(path))

        def reply(self, code, payload, content_type="application/json; charset=utf-8", headers=None):
            route = self.path.split("?", 1)[0]
            def entry(value):
                if not isinstance(value, dict): return value
                result = dict(value)
                for key in ("url", "thumbnail"):
                    url = result.get(key)
                    if isinstance(url, str) and url.startswith("/api/files/content?"):
                        result[key] = "/write" + url
                return result
            # Editor source, versions, offsets, receipts, comments, canvas and
            # metadata are exact canonical data. Only explicit file entry URL
            # fields use the public namespace; rendering resolves source links.
            if isinstance(payload, dict) and route == "/api/piece":
                payload = dict(payload)
                if isinstance(payload.get("files"), list): payload["files"] = [entry(v) for v in payload["files"]]
            if isinstance(payload, dict) and route in ("/api/files/upload", "/api/files/mkdir", "/api/files/move", "/api/canvas") and "entry" in payload:
                payload = {**payload, "entry": entry(payload["entry"])}
            if route == "/api/files/content":
                headers = {**(headers or {}), "Content-Security-Policy": "sandbox; default-src 'none'"}
                if content_type not in ("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"):
                    headers["Content-Disposition"] = "attachment"
            return super().reply(code, payload, content_type, headers)

        def authenticated(self):
            self._writer_principal = None
            try:
                sha = hashlib.sha256(app.share_token().encode("utf-8")).hexdigest()
            except app.ShareError:
                self.reply(503, {"error": "writer-not-configured"})
                return False
            value = self.headers.get("Authorization", "")
            matched = None
            for principal in app.FOUNDERS:
                if hmac.compare_digest(value.encode("utf-8"), ("Bearer " + credential(sha, principal)).encode("ascii")):
                    matched = principal
            if not matched or matched not in app.AUTHORS:
                self.reply(401, {"error": "unauthorized"})
                return False
            origin = os.environ.get("WRITER_ORIGIN", "")
            parsed = urlsplit(origin)
            if parsed.scheme != "https" or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
                self.reply(503, {"error": "writer-not-configured"})
                return False
            if self.headers.get("Host", "") != parsed.netloc:
                self.reply(403, {"error": "invalid-host"})
                return False
            public = public_origin(app)
            if not public:
                self.reply(503, {"error": "writer-not-configured"})
                return False
            browser = self.headers.get("Origin")
            if browser is not None and browser != public:
                self.reply(403, {"error": "cross-site"})
                return False
            if self.command in ("POST", "PUT") and browser != public:
                self.reply(403, {"error": "cross-site"})
                return False
            self._writer_principal = matched
            return True

        def identity_matches(self, value):
            try:
                return app.writing_session(value)[0][0] == self._writer_principal
            except (ValueError, TypeError):
                return False

        def dispatch(self):
            # Freeze the complete response, including its checked generation,
            # under the save lock. A slow public connection must not hold that
            # lock while sending already captured bytes.
            wire = self.wfile
            # Large attachments already exist as bytes in the read handler.
            # Spool their wire copy privately rather than double their heap use.
            with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as captured:
                with app.WRITE_LOCK:
                    self.wfile = captured
                    try:
                        result = self.dispatch_locked()
                    finally:
                        self.wfile = wire
                captured.seek(0)
                while chunk := captured.read(64 * 1024):
                    wire.write(chunk)
                return result

        def dispatch_locked(self):
            if not self.authenticated(): return
            if self.headers.get('X-Descant-Flight-Online') == '1':
                try: self._writer_assets_start = asset_generation(app)
                except OSError: self._writer_assets_start = None
            parsed = urlsplit(self.path)
            # No alternate encodings, separators or normalization escape hatches.
            if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith("/write/") or re.search(r"[%\\\x00-\x20]|//|(?:^|/)\.\.?(/|$)", parsed.path):
                return self.reply(404, {"error": "not-found"})
            route = parsed.path[len("/write"):]
            self.path = route + ("?" + parsed.query if parsed.query else "")
            if self.command in ("GET", "HEAD") and route in STATIC:
                name = STATIC[route]
                target = app.APP_DIR / ("writer-sw.js" if name == "@worker" else "public-writer/" + name)
                if not target.is_file(): return self.reply(503, {"error": "writer-not-built"})
                headers = {}
                if route == "/sw.js":
                    headers["Service-Worker-Allowed"] = "/write"
                    headers["Content-Security-Policy"] = "default-src 'self'; connect-src 'self'; script-src 'self'"
                if route == "/":
                    try:
                        hashes = json.loads((app.APP_DIR / "public-writer/app.csp.json").read_text("utf-8"))["scripts"]
                        if not hashes or not all(re.fullmatch(r"sha256-[A-Za-z0-9+/]{43}=", h) for h in hashes): raise ValueError()
                    except (OSError, KeyError, ValueError, TypeError):
                        return self.reply(503, {"error": "writer-not-built"})
                    headers["Content-Security-Policy"] = "; ".join(("default-src 'none'", "script-src " + " ".join("'" + h + "'" for h in hashes), "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data: blob:", "connect-src 'self' http://127.0.0.1:47231", "worker-src 'self'", "manifest-src 'self'", "frame-src 'none'", "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"))
                kind = "text/html; charset=utf-8" if route == "/" else self.guess_type(str(target))
                return self.reply(200, b"" if self.command == "HEAD" else target.read_bytes(), kind, headers)
            if self.command == "HEAD": return self.reply(405, {"error": "method-not-allowed"})
            if self.command == "GET" and route == "/api/whoami":
                return self.reply(200, {"role": "founder", "id": "founder:" + self._writer_principal,
                                       "who": self._writer_principal, "publicWriter": True})
            if self.command == "GET" and route == "/api/sync":
                return self.reply(200, {"on": app.SYNC["on"], "error": app.SYNC["last_error"], "pending": bool(app.SYNC["push_pending"])})
            if self.command == "GET" and route == "/api/save-status":
                path = (self.query().get("path") or [""])[0]
                if not self.may_read(path): return self.reply(403, {"error": "unreadable"})
                return self.reply(200, app.save_evidence(path, (self.query().get("sha") or [""])[0]))
            routes = GET_ROUTES if self.command == "GET" else POST_ROUTES if self.command == "POST" else {"/api/canvas": "api_canvas_put"} if self.command == "PUT" else {}
            method = routes.get(route)
            if self.command == "POST" and route == "/api/share/admin-link": method = "writer_admin_link"
            if not method: return self.reply(404 if self.command in ("GET", "POST", "PUT") else 405, {"error": "not-found"})
            query = parse_qs(parsed.query, keep_blank_values=True)
            if "who" in query:
                values = query["who"]
                try: named = json.loads(values[0]) if values[0].startswith(("[", '"')) else values[0]
                except (ValueError, IndexError): named = None
                if len(values) != 1 or not self.identity_matches(named):
                    return self.reply(403, {"error": "principal-mismatch"})
            if self.command in ("POST", "PUT"):
                if self.headers.get("Transfer-Encoding") or (self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json"):
                    return self.reply(415, {"error": "json-only"})
                try: length = int(self.headers.get("Content-Length", "0"))
                except ValueError: length = 0
                if not 0 < length <= app.MAX_BODY: return self.reply(413, {"error": "body-too-large-or-empty"})
                raw = self.rfile.read(length)
                try: body = json.loads(raw)
                except (ValueError, UnicodeError): return self.reply(400, {"error": "invalid-json"})
                if not isinstance(body, dict): return self.reply(400, {"error": "invalid-json"})
                if self.command == "POST" and not self.identity_matches(body.get("who")):
                    return self.reply(403, {"error": "principal-mismatch"})
                if self.command == "PUT" and "who" not in query:
                    return self.reply(403, {"error": "principal-required"})
                if route == "/api/comments":
                    # In /write a saved @agent tag is itself the request. Older
                    # shells send manual delivery even though their tray was hidden.
                    body.pop("agent_delivery", None)
                    raw = json.dumps(body).encode("utf-8")
                    self.headers.replace_header("Content-Length", str(len(raw)))
                self.rfile = io.BytesIO(raw)
            app.sync_pull(force=self.command in ("POST", "PUT"))
            return getattr(self, method)()

        def writer_admin_link(self):
            if not app.SHARE["url"]: return self.reply(404, {"error": "sharing-off"})
            try:
                answer = app.share_call("POST", "/sync/admin-link", {"founder": self._writer_principal})
            except app.ShareError:
                return self.reply(502, {"error": "sharing-unavailable"})
            url = (answer or {}).get("url", "")
            if not re.fullmatch(re.escape(app.SHARE["url"]) + r"/founder/[A-Za-z0-9_-]{43}", str(url)):
                return self.reply(502, {"error": "invalid-sharing-answer"})
            return self.reply(200, {"ok": True, "url": url})

        do_GET = dispatch
        do_HEAD = dispatch
        do_POST = dispatch
        do_PUT = dispatch
        do_OPTIONS = dispatch
        do_DELETE = dispatch
        do_PATCH = dispatch
        do_TRACE = dispatch
        do_CONNECT = dispatch

    return WriterHandler
