#!/usr/bin/env python3
"""Build Typewell pages with the Python standard library.

The private shell loads article text and history from serve.py. --sample embeds only
synthetic fixtures; --public-reviewer writes a placeholder page and checks that no
article paragraph travels with it. Engine assets and Typewell's theme are inlined;
remote font links retain their declared network URLs."""

import argparse
import base64
import datetime
import hashlib
import json
import re
import subprocess
import sys
from html import escape
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))
import space_config  # noqa: E402  the space's own people and values
REPO_ROOT = APP_DIR.parents[1]
ENGINE = APP_DIR / "engine"
WORLDS = APP_DIR / "worlds"
SAMPLE = ENGINE / "sample" / "sample.md"



# A world's six named colours, light ramp and dark ramp, straight out of its theme.css.
# fonts.js wants PRESETS (a whole level ramp each), not swatches, so the six below are
# rotated into six ramps: preset N leads with the world's colour N and the rest follow in
# the world's own order. Every preset is therefore the world's palette, differently led.
LEVEL_DECL_RE = re.compile(r"^--level-([1-6])\s*:\s*(.+)$")
SCHEME_DECL_RE = re.compile(r"^color-scheme\s*:\s*(.+)$")


NOT_RE = re.compile(r":not\([^)]*\)")
COMMENT_RE = re.compile(r"/\*[\s\S]*?\*/")


def _theme_of(context):
    """light, dark, or None (meaning: the file's base theme) for one CSS context.

    `:not([data-theme="light"])` inside a dark media query names both themes in one
    selector, and it means the opposite of what it says, so the exclusions come out
    before anything is matched."""
    flat = NOT_RE.sub("", context).lower().replace(" ", "")
    if 'data-theme="light"' in flat or "prefers-color-scheme:light" in flat:
        return "light"
    if 'data-theme="dark"' in flat or "prefers-color-scheme:dark" in flat:
        return "dark"
    return None


def ramp_from_theme(world):
    """Read heading colours from their enclosing CSS scheme.

A brace stack assigns declarations to their theme; bare :root declarations use the
file's color-scheme. Reading the theme avoids a second palette table that can drift."""
    css = WORLDS / world / "theme.css"
    if not css.exists():
        return None
    text = COMMENT_RE.sub(" ", css.read_text("utf-8"))
    found = {"light": {}, "dark": {}, "base": {}}
    base_scheme = "light"
    stack, buf = [], []
    for ch in text:
        if ch == "{":
            stack.append("".join(buf))
            buf = []
            continue
        if ch == "}":
            if stack:
                stack.pop()
            buf = []
            continue
        if ch != ";":
            buf.append(ch)
            continue
        decl = "".join(buf).strip()
        buf = []
        context = " ".join(stack)
        where = _theme_of(context)
        scheme = SCHEME_DECL_RE.match(decl)
        if scheme and where is None:
            base_scheme = "dark" if "dark" in scheme.group(1).lower() else "light"
            continue
        level = LEVEL_DECL_RE.match(decl)
        if level:
            found[where or "base"][level.group(1)] = level.group(2).strip()
    light = dict(found["light"])
    dark = dict(found["dark"])
    (dark if base_scheme == "dark" else light).update(found["base"])
    if len(light) != 6 or len(dark) != 6:
        return None
    order = [str(i) for i in range(1, 7)]
    named = re.search(r"/\*\s*levels:\s*([^*]+)\*/", css.read_text("utf-8"))
    names = [n.strip() for n in named.group(1).split(",")] if named else []
    if len(names) != 6:
        names = ["level %s" % i for i in order]
    return {"names": names, "light": [light[i] for i in order], "dark": [dark[i] for i in order]}


def heading_presets(world):
    ramp = ramp_from_theme(world)
    if ramp is None:
        raise SystemExit(
            "%s/theme.css must declare --level-1..6 in BOTH themes; that ramp is the "
            "world's own and nothing else may state it. (A hand-written table used to "
            "live here and disagreed with two themes.)" % world)
    out = []
    for i, name in enumerate(ramp["names"]):
        out.append({
            "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
            "label": name[:1].upper() + name[1:],
            "colors": ramp["light"][i:] + ramp["light"][:i],
            "dark": ramp["dark"][i:] + ramp["dark"][:i],
        })
    return out

PEOPLE = [{"name": "You"}, {"name": "Your agent", "kind": "agent"}]

LINK_RE = re.compile(r"""<link\b[^>]*?rel=["']stylesheet["'][^>]*?>""", re.I)
HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.I)
SCRIPT_RE = re.compile(r"""<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>\s*</script>""", re.I)
DATA_RE = re.compile(r"""(<script[^>]*id=["']castor-data["'][^>]*>)([\s\S]*?)(</script>)""", re.I)
REMOTE = ("http://", "https://", "//")
# Engine files every world loads, placed just before app.js in the shell so no shell has
# to list them: keep.js is the on-device journal app.js saves through.
ENGINE_BEFORE_APP = ("keep.js", "subtitle.js", "language.js", "publication.js", "publish-state.js", "share.js", "agent-tray.js", "checking.js", "offline.js", "touch-layout.js", "links.js", "reader-shell.js")
APP_SCRIPT_RE = re.compile(r"""<script\b[^>]*\bsrc=["']([^"']*/)engine/app\.js["'][^>]*>\s*</script>""", re.I)


# ------------------------------------------------------------------ git helpers

def git(*args):
    out = subprocess.run(["git", "-C", str(REPO_ROOT), *args],
                         capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), out.stderr.strip()))
    return out.stdout


def git_show(ref, path):
    return git("show", "%s:%s" % (ref, path))










# ------------------------------------------------------------------ the payload

def frontmatter_title(markdown, fallback="Untitled"):
    m = re.match(r"^---\n([\s\S]*?)\n---", markdown or "")
    if m:
        t = re.search(r"^title:\s*(.+)$", m.group(1), re.M)
        if t:
            return t.group(1).strip().strip("'\"")
    h = re.search(r"^#\s+(.+)$", markdown or "", re.M)
    return h.group(1).strip() if h else fallback


def body_blocks(markdown):
    """Blank-line chunks of the body, markers stripped. Only used to seed comments.

    A block carrying an internal marker is skipped: an anchor must never drag a writer's
    name or a note-to-self out of the source and into the embedded, shipped data.
    """
    body = re.sub(r"^---\n[\s\S]*?\n---\n", "", markdown or "")
    out = []
    for chunk in re.split(r"\n\s*\n", body):
        raw = chunk.strip()
        if not raw or raw.startswith(("#", ">", "|", "```", "---", "![", "%%")):
            continue
        if "%%" in raw or space_config.marker_re(flags=re.I).search(raw):
            continue
        plain = re.sub(r"\[\[([^\]|]*\|)?([^\]]*)\]\]", r"\2", raw)
        plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain)
        plain = re.sub(r"[*_`~=]", "", plain)
        plain = re.sub(r"\s+", " ", plain).strip()
        if len(plain) > 60:
            out.append(plain)
    return out


def seed_comments(markdown, version_id):
    """Three synthetic threads, anchored to phrases that really occur in the piece."""
    texts = [
        "This is the line the whole piece rests on. Does it arrive early enough?",
        "The claim is stronger here than the source behind it. Soften it, or cite it.",
        "Keep or cut? It says the paragraph above again in other words.",
    ]
    authors = ["You", "Your agent", "You"]
    blocks = body_blocks(markdown)
    picks = [blocks[i] for i in (1, 4, 8) if i < len(blocks)]
    picks = picks or blocks[:3]
    comments = []
    for i, block in enumerate(picks[:3]):
        words = block.split(" ")
        quote = " ".join(words[:7])
        at = block.find(quote)
        comments.append({
            "id": "c%d" % (i + 1),
            "anchor": {
                "quote": quote,
                "prefix": block[max(0, at - 32):at],
                "suffix": block[at + len(quote):at + len(quote) + 32],
                "blockText": block,
                "version": version_id,
            },
            "author": authors[i],
            "text": texts[i],
            "created": "2026-08-22",
            "replies": ([{"author": "Your agent", "text": "One sentence of advice would go here.",
                          "created": "2026-08-22", "by": "agent", "basis": "synthetic"}] if i == 1 else []),
            "done": False,
            "synthetic": True,
        })
    return comments


SAMPLE_MEDIA = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
FILE_MIME = {**SAMPLE_MEDIA, ".pdf": "application/pdf", ".md": "text/markdown",
             ".txt": "text/plain", ".canvas": "application/json"}


def sample_media():
    """Every image under engine/sample/, keyed by the ways the sample refers to it."""
    out = {}
    root = SAMPLE.parent
    if not root.exists():
        return out
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SAMPLE_MEDIA:
            continue
        mime = SAMPLE_MEDIA[path.suffix.lower()]
        url = "data:%s;base64,%s" % (mime, base64.b64encode(path.read_bytes()).decode("ascii"))
        rel = path.relative_to(root).as_posix()
        for key in (rel, path.name, path.stem):
            out.setdefault(key, url)
    return out


def preview_kind(path):
    suffix = Path(path).suffix.lower()
    if suffix in SAMPLE_MEDIA:
        return "image"
    if suffix == ".pdf":
        return "pdf"
    if suffix in (".md", ".txt"):
        return "markdown"
    if suffix == ".canvas":
        return "canvas"
    return "file"


def thumbnail_data(path, blob):
    """A small real render where the browser can scale it without a decoder here.

    The stdlib has no JPEG decoder and no general PNG resizer. Small rasters stay
    byte-exact; a raster over 200 KB gets the typed one-stroke placeholder in files.js.
    SVG remains vector data and is embedded only below 64 KB.
    """
    suffix = Path(path).suffix.lower()
    if suffix == ".svg" and len(blob) <= 64 * 1024:
        return "data:image/svg+xml;base64,%s" % base64.b64encode(blob).decode("ascii")
    if suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp") and len(blob) <= 200 * 1024:
        mime = SAMPLE_MEDIA[suffix]
        return "data:%s;base64,%s" % (mime, base64.b64encode(blob).decode("ascii"))
    return None


def file_entry(path, size, date, blob=None):
    suffix = Path(path).suffix.lower()
    entry = {
        "path": path,
        "kind": "file",
        "size": int(size or 0),
        "date": date or "unknown date",
        "type": FILE_MIME.get(suffix, "application/octet-stream"),
        "preview": preview_kind(path),
    }
    if blob is not None:
        thumb = thumbnail_data(path, blob)
        if thumb:
            entry["thumbnail"] = thumb
    return entry


def sample_file_entries():
    root = SAMPLE.parent
    entries = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        stat = path.stat()
        blob = path.read_bytes() if preview_kind(rel) == "image" else None
        date = datetime.datetime.fromtimestamp(stat.st_mtime).date().isoformat()
        entries.append(file_entry(rel, stat.st_size, date, blob))
    return entries




EMBED_RE = re.compile(r"!\[\[([^\]|#]+)((?:\|[^\]]*)?)\]\]")
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)")


def inline_sample_images(markdown, media):
    """Rewrite the sample's embeds to data URLs for the files that really exist."""
    if not media:
        return markdown

    def look(name):
        name = name.strip()
        return media.get(name) or media.get(name.rsplit("/", 1)[-1]) or \
            media.get(name.rsplit("/", 1)[-1].rsplit(".", 1)[0])

    def do_embed(m):
        url = look(m.group(1))
        if not url:
            return m.group(0)
        # ![[file|420]] has no Markdown equivalent that keeps the width, so it stays
        # an embed and md.js is handed a src it can render.
        return "![[%s%s]]" % (url, m.group(2))

    def do_image(m):
        url = look(m.group(2))
        return m.group(0) if not url else "![%s](%s%s)" % (m.group(1), url, m.group(3))

    return IMAGE_RE.sub(do_image, EMBED_RE.sub(do_embed, markdown))





def live_piece():
    """The article a browser with none open yet starts on: the space's firstArticle when it is
    there, else its first article by folder name; "" in a space with no article."""
    named = space_config.first_article()
    if named and (REPO_ROOT / named).is_file():
        return named
    found = sorted(p.relative_to(REPO_ROOT).as_posix() for p in (REPO_ROOT / "articles").glob("*/article.md"))
    return found[0] if found else ""


def build_data(world, sample):
    if not sample:
        data = public_reviewer_data(world)
        data['versions'][0]['markdown'] = '# Descant\n\nOpen the writing app on its server to read an article.\n'
        data['livePiece'] = live_piece()
        founders = space_config.people()
        data['people'] = [{'id': key, 'name': identity.split(' <')[0], 'color': founders.get('_colors', {}).get(key)}
                          for key, identity in founders.items() if isinstance(identity, str)] + [p for p in PEOPLE if p.get('kind') == 'agent']
        # A personal installation (someone's own Descant, made by tools/personal-package)
        # says so in install.json beside this file; Castor's own checkout has none.
        install = APP_DIR / 'install.json'
        if install.is_file():
            data['install'] = json.loads(install.read_text('utf-8'))
        return data
    if sample:
        markdown = inline_sample_images(SAMPLE.read_text("utf-8"), sample_media())
        versions = [{
            "id": "v1", "label": "the sample", "author": "the writer", "when": "2026-08-22",
            "summary": "A synthetic piece that exercises every form the engine renders.",
            "markdown": markdown,
        }]
        file_entries = sample_file_entries()
        piece = {"title": frontmatter_title(markdown, "The sample piece"),
                 "folder": "design/app/engine/sample",
                 "files": [entry["path"] for entry in file_entries],
                 "fileEntries": file_entries}
        pieces = [piece["title"]]
    return {
        "piece": piece,
        "versions": versions,
        "current": versions[-1]["id"],
        "pieces": pieces,
        "comments": seed_comments(markdown, versions[-1]["id"]),
        "canvas": {"nodes": [], "edges": []},
        "agentNotes": {},
        "pieceSources": {},
        "people": PEOPLE,
        "headingPresets": heading_presets(world),
        "world": world,
    }


# ------------------------------------------------------------------- inlining

def read_local(base, href):
    target = (base / href).resolve()
    if not target.exists():
        return None
    return target.read_text("utf-8")


TAB_MARK = """<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#FAF9F4" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141311" media="(prefers-color-scheme: dark)">
"""


def with_tab_mark(html):
    """Put the icon links just before </head>, once."""
    if 'rel="icon"' in html or "</head>" not in html:
        return html
    return html.replace("</head>", TAB_MARK + "</head>", 1)



SIGNATURE_JS = ENGINE / "signature.js"
TOPBAR = ENGINE / "topbar.html"
FOOTLINE = ENGINE / "footline.html"
THEME_EARLY = ENGINE / "theme-early.js"
MANIFEST = APP_DIR / "manifest.webmanifest"
PRODUCT_NAME_RE = re.compile(r'^\s*var PRODUCT_NAME = "([^"\\]+)";', re.M)
SLOTS = (('<header id="topbar" class="mast"></header>', TOPBAR),
         ('<footer id="footline" class="footline"></footer>', FOOTLINE))
SHELL_TITLE_RE = re.compile(r"<title>Castor\s*·\s*")


def product_name():
    found = PRODUCT_NAME_RE.search(SIGNATURE_JS.read_text("utf-8"))
    if not found:
        raise SystemExit('engine/signature.js must name the product on one line: var PRODUCT_NAME = "...";')
    return found.group(1)


def with_signature(html, name, missing, reviewer=False):
    """The window title, the header and the footer line, the early theme, and signature.js."""
    html = SHELL_TITLE_RE.sub(lambda m: "<title>%s* · " % escape(name), html, count=1)
    for slot, part in SLOTS:
        if slot in html:
            filled = part.read_text("utf-8").strip().replace("{{product}}", escape(name))
            if "{{castor-full}}" in filled:
                filled = filled.replace("{{castor-full}}", (ENGINE / "castor-footer.html").read_text("utf-8").strip())
            html = html.replace(slot, filled, 1)
        else:
            missing.append("the %s: the shell has no %s" % (part.name, slot))
    early = "<script>\n/* ../../engine/theme-early.js */\n%s\n</script>\n" % THEME_EARLY.read_text("utf-8")
    if "</head>" in html:
        html = html.replace("</head>", early + "</head>", 1)
    else:
        missing.append("the early theme: the shell has no </head>")
    signature = SIGNATURE_JS.read_text("utf-8")
    if reviewer:
        signature = signature.replace("var publicWriter = publicData && publicData.publicWriter === true;", "var publicWriter = true;")
        signature = signature.replace("var base = '/logos/' + logo + '/';", "")
        signature = signature.replace("publicWriter ? publicData.identityMarks[theme] : base + 'mark-' + theme + '.svg'", "publicData.identityMarks[theme]")
        signature = re.sub(r"    if \(publicWriter\) return;\n[\s\S]*?^  }", "  }", signature, count=1, flags=re.M)
        # Reader hosts have neither install assets nor the private logo experiments.
        for function in ("registerWorker",):
            signature = re.sub(r"^  function " + function + r"\(\) \{[\s\S]*?^  }\n", "", signature, flags=re.M)
            signature = re.sub(r"^.*\b" + function + r"(?:\(\)|\);).*$", "", signature, flags=re.M)
    script = "<script>\n/* ../../engine/signature.js */\n%s\n</script>\n" % signature
    at = html.rfind("</body>")
    return html[:at] + script + html[at:] if at >= 0 else html + script


def write_manifest(name):
    """What Chrome reads to install the app. The icons are the Castor logo exactly as
    castor-identity/logo ships it (192 scaled from castor-1024.png by sips, 512 copied),
    and, where a platform masks the icon to its own shape and fills what is transparent,
    the same logo on the paper ground inside the mask's safe circle."""
    manifest = {
        "id": "/",
        "name": name,
        "short_name": name,
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#FAF9F4",
        "theme_color": "#FAF9F4",
        "icons": [
            {"src": "/icons/castor-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icons/castor-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icons/castor-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
    }
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    if not MANIFEST.exists() or MANIFEST.read_text("utf-8") != text:
        MANIFEST.write_text(text, "utf-8")


def with_engine_extras(shell, reviewer=False):
    """Each of ENGINE_BEFORE_APP as a script tag right before app.js's, unless listed."""
    if reviewer:
        # Readers cannot open Changes. Its founder-only demonstration is not a
        # reader asset, and must not leak into the public shell.
        shell = re.sub(r'<script\b[^>]*\bsrc=["\'][^"\']*/engine/changes\.js["\'][^>]*>\s*</script>', '', shell, flags=re.I)
    def add(m):
        tags = "".join('<script src="%sengine/%s"></script>\n' % (m.group(1), name)
                       for name in ENGINE_BEFORE_APP if "engine/" + name not in shell and not (reviewer and name == "offline.js"))
        return tags + m.group(0)
    shell = APP_SCRIPT_RE.sub(add, shell, count=1)
    if "engine/export.js" not in shell:
        shell = re.sub(r'(<script\b[^>]*\bsrc=[\"\']([^\"\']*/)engine/editor\.js[\"\'][^>]*>\s*</script>)',
                       lambda m: '<script src="%sengine/export.js"></script>\n' % m.group(2) + m.group(1), shell, count=1)
    return shell


def inline(shell, base, world, data, reviewer=False):
    missing = []
    shell = with_engine_extras(shell, reviewer=reviewer)

    def do_link(m):
        found = HREF_RE.search(m.group(0))
        href = found.group(1) if found else ""
        if not href or href.startswith(REMOTE):
            return m.group(0)                       # Google Fonts stay as they are
        css = read_local(base, href)
        if css is None:
            missing.append(href)
            return m.group(0)
        return "<style>\n/* %s */\n%s\n</style>" % (href, css)

    def do_script(m):
        src = m.group(2)
        if src.startswith(REMOTE):
            return m.group(0)
        js = read_local(base, src)
        if js is None:
            missing.append(src)
            return m.group(0)
        attrs = ''
        if src.endswith('/app.js') and data.get('livePiece'):
            attrs = ' data-live="1" data-piece="%s"' % escape(data['livePiece'], quote=True)
        return "<script%s>\n/* %s */\n%s\n</script>" % (attrs, src, js)

    out = LINK_RE.sub(do_link, shell)
    out = SCRIPT_RE.sub(do_script, out)
    out = with_tab_mark(out)
    out = with_signature(out, product_name(), missing, reviewer=reviewer)

    payload = json.dumps(data, ensure_ascii=False, indent=1).replace("</", "<\\/")
    if DATA_RE.search(out):
        out = DATA_RE.sub(lambda m: m.group(1) + "\n" + payload + "\n" + m.group(3), out, count=1)
    else:
        missing.append("a <script id=\"castor-data\"> block in shell.html")
        block = '<script id="castor-data" type="application/json">\n%s\n</script>\n' % payload
        out = out.replace("</body>", block + "</body>") if "</body>" in out else out + block
    return strip_page_comments(out), missing


def build_world(world_dir, sample):
    world = world_dir.name
    shell = world_dir / "shell.html"
    if not shell.exists():
        print("  %-10s no shell.html yet, so nothing to build." % world)
        return None
    data = build_data(world, sample)
    html, missing = inline(shell.read_text("utf-8"), world_dir, world, data)
    out_dir = APP_DIR / world
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ("sample.html" if sample else "index.html")
    out.write_text(html.rstrip("\n") + "\n", "utf-8")
    for m in missing:
        print("  %-10s could not inline %s" % (world, m))
    print("  %-10s %s  %.1f KB" % (world, out.relative_to(APP_DIR), len(html.encode("utf-8")) / 1024))
    return out



PUBLIC_WORLD = "typewell"
PUBLIC_OUT = APP_DIR / "reviewers" / "public"
PUBLIC_FILES = ("favicon.ico", "favicon.svg", "icons/apple-touch-icon.png",
                "fonts/literata.woff2", "fonts/randosans-500-sharpie.woff2",
                "fonts/sourceserif4.woff2", "fonts/sourceserif4-italic.woff2",
                "fonts/commissioner.woff2", "fonts/martianmono.woff2",
                "fonts/newsreader.woff2")
PUBLIC_PLACEHOLDER = "# Descant\n\nSign in to read what was shared with you.\n"
INLINE_SCRIPT_RE = re.compile(r"<script\b([^>]*)>([\s\S]*?)</script>", re.I)
MANIFEST_LINK_RE = re.compile(r'<link rel="manifest"[^>]*>\n?')
LEAK_WINDOW = 60                       # letters and digits in a row that count as a quotation


def public_reviewer_data(world):
    return {
        "piece": {"title": "Descant", "folder": "", "files": [], "fileEntries": []},
        "versions": [{"id": "v1", "label": "placeholder", "author": "the writer", "when": "",
                      "summary": "", "markdown": PUBLIC_PLACEHOLDER}],
        "current": "v1",
        "pieces": [],
        "comments": [],
        "canvas": {"nodes": [], "edges": []},
        "agentNotes": {},
        "pieceSources": {},
        "people": [],
        "headingPresets": heading_presets(world),
        "world": world,
    }


def letters(text):
    """Only the letters and digits, lowercased: a quotation survives any escaping this way."""
    return re.sub(r"[^0-9a-z]", "", text.lower())


def article_paragraphs():
    """(path, paragraph) for every body paragraph of every article.md that git HEAD holds."""
    out = []
    for path in git("ls-tree", "-r", "--name-only", "HEAD", "articles").splitlines():
        if not re.fullmatch(r"articles/[^/]+/article\.md", path):
            continue
        body = re.sub(r"^---\n[\s\S]*?\n---\n", "", git_show("HEAD", path))
        for line in body.splitlines():
            if len(letters(line)) >= LEAK_WINDOW:
                out.append((path, line.strip()))
    return out


def leaked_paragraphs(html, paragraphs):
    """The paragraphs whose opening (or middle) run of letters appears anywhere in the page."""
    flat = letters(html)
    found = []
    for path, line in paragraphs:
        run = letters(line)
        middle = len(run) // 2
        if run[:LEAK_WINDOW] in flat or run[middle:middle + LEAK_WINDOW] in flat:
            found.append((path, line[:80]))
    return found


def script_hashes(html):
    """'sha256-<base64>' of each inline script the browser runs (the JSON data block is not one)."""
    import hashlib
    hashes = []
    for attrs, body in INLINE_SCRIPT_RE.findall(html):
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        kind = re.search(r"""\btype\s*=\s*["']?([^"'\s>]+)""", attrs, re.I)
        if kind and kind.group(1).lower() not in ("text/javascript", "module", "application/javascript"):
            continue
        text = body.replace("\r\n", "\n").replace("\r", "\n")
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        hashes.append("sha256-" + base64.b64encode(digest).decode("ascii"))
    return hashes


# A lexer removes comments and code indentation without rewriting literal contents.
# Line breaks stay because JavaScript can insert semicolons at them.

JS_REGEX_AFTER = set("(,=:[!&|?{};+-*%<>~^")
JS_REGEX_AFTER_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void",
                        "throw", "instanceof", "yield", "await", "control-close"}


def trim_code_space(out):
    while out and out[-1] in (" ", "\t"):
        out.pop()


def _js_scan(src, i, out, in_expression):
    """Copy code from src[i:] to out without its comments; stop at the brace that closes a
    template literal's ${...} when in_expression. Returns the index reached."""
    n, depth, prev = len(src), 0, ""
    parens = []
    while i < n:
        c = src[i]
        if in_expression:
            if c == "{":
                depth += 1
            elif c == "}":
                if depth == 0:
                    return i
                depth -= 1
        if c in " \t\r\n":
            if c in "\r\n":
                trim_code_space(out)
            if c not in " \t" or (out and not out[-1].endswith(("\n", "\r"))):
                out.append(c)
            i += 1
            continue
        if c == "/" and src.startswith("//", i):
            end = src.find("\n", i)
            i = n if end < 0 else end
            continue
        if c == "/" and src.startswith("/*", i):
            end = src.find("*/", i + 2)
            end = n if end < 0 else end + 2
            if "\n" in src[i:end]:
                trim_code_space(out)
                out.append("\n")
            else:
                out.append(" ")
            i = end
            continue
        if c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1])
            i, prev = j + 1, "string"
            continue
        if c == "`":
            out.append("`")
            i += 1
            while i < n and src[i] != "`":
                if src[i] == "\\":
                    out.append(src[i:i + 2])
                    i += 2
                elif src.startswith("${", i):
                    out.append("${")
                    i = _js_scan(src, i + 2, out, True)
                    out.append("}")
                    i += 1
                else:
                    out.append(src[i])
                    i += 1
            out.append("`")
            i, prev = i + 1, "string"
            continue
        if c == "/" and (prev == "" or prev in JS_REGEX_AFTER or prev in JS_REGEX_AFTER_WORDS):
            j, in_class = i + 1, False
            while j < n and src[j] != "\n":
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == "[":
                    in_class = True
                elif src[j] == "]":
                    in_class = False
                elif src[j] == "/" and not in_class:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            out.append(src[i:j])
            i, prev = j, "regex"
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"):
                j += 1
            out.append(src[i:j])
            i, prev = j, src[i:j]
            continue
        out.append(c)
        if c == "(":
            parens.append(prev in {"if", "while", "for", "with", "switch", "catch"})
        control_close = c == ")" and parens and parens.pop()
        i, prev = i + 1, "control-close" if control_close else c
    return i


def strip_js_comments(src):
    out = []
    _js_scan(src, 0, out, False)
    trim_code_space(out)
    return "".join(out)


def strip_css_comments(src):
    out, i, n = [], 0, len(src)
    while i < n:
        if src.startswith("/*", i):
            end = src.find("*/", i + 2)
            i = n if end < 0 else end + 2
            out.append(" ")
            continue
        if src[i] in "'\"":
            j = i + 1
            while j < n and src[j] != src[i] and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1])
            i = j + 1
            continue
        if src[i] in "\r\n":
            trim_code_space(out)
        if src[i] not in " \t" or (out and not out[-1].endswith(("\n", "\r"))):
            out.append(src[i])
        i += 1
    trim_code_space(out)
    return "".join(out)


BLOCK_RE = re.compile(r"(<script\b[^>]*>)([\s\S]*?)(</script>)|(<style\b[^>]*>)([\s\S]*?)(</style>)", re.I)


def strip_page_comments(html):
    """The page with no HTML, CSS or script comments; the JSON data block is left as it is."""
    out, at = [], 0
    for m in BLOCK_RE.finditer(html):
        out.append(re.sub(r"<!--[\s\S]*?-->", "", html[at:m.start()]))
        if m.group(1):
            body = m.group(2) if "application/json" in m.group(1).lower() else strip_js_comments(m.group(2))
            out.append(m.group(1) + body + m.group(3))
        else:
            out.append(m.group(4) + strip_css_comments(m.group(5)) + m.group(6))
        at = m.end()
    out.append(re.sub(r"<!--[\s\S]*?-->", "", html[at:]))
    return "".join(out)


def reader_people():
    """The writers as the reader page shows them: key, first name and colour, never a surname
    or an email. The page needs them to tell a writer's reply from a reader's."""
    found = space_config.people()
    out = []
    for key, identity in space_config.writers().items():
        words = identity.split("<", 1)[0].split()
        if not words:
            continue
        person = {"id": key, "name": words[0]}
        color = found.get("_colors", {}).get(key) if isinstance(found.get("_colors"), dict) else None
        if isinstance(color, str):
            person["color"] = color
        out.append(person)
    return out


def build_public_reviewer(out_dir):
    world_dir = WORLDS / PUBLIC_WORLD
    shell = world_dir / "shell.html"
    if not shell.is_file():
        raise SystemExit("no %s world to build the reader page from" % PUBLIC_WORLD)
    data = public_reviewer_data(PUBLIC_WORLD)
    data["publicReviewer"] = True
    data["people"] = reader_people()
    data["identityMarks"] = {theme: "data:image/svg+xml;base64," + base64.b64encode((APP_DIR / "logos/2" / ("mark-" + theme + ".svg")).read_bytes()).decode("ascii") for theme in ("light", "dark")}
    html, missing = inline(shell.read_text("utf-8"), world_dir, PUBLIC_WORLD, data, reviewer=True)
    if missing:
        raise SystemExit("the reader page could not inline: %s" % ", ".join(missing))
    # Readers do not install the app, and Descant serves no manifest.
    html = MANIFEST_LINK_RE.sub("", html).replace("\r\n", "\n").replace("\r", "\n")
    html = html.rstrip("\n") + "\n"
    leaks = leaked_paragraphs(html, article_paragraphs())
    if leaks:
        raise SystemExit("REFUSED: the reader page would carry article text:\n" +
                         "\n".join("  %s: %s" % hit for hit in leaks))
    hashes = script_hashes(html)
    if not hashes:
        raise SystemExit("the reader page has no inline script to allow; nothing was written")
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "app.html").write_text(html, "utf-8")
    (out_dir / "app.csp.json").write_text(json.dumps({"scripts": hashes}, indent=1) + "\n", "utf-8")
    for name in PUBLIC_FILES:
        target = out_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((APP_DIR / name).read_bytes())
    print("  reader page %s  %.1f KB, %d inline scripts allowed by hash, no article text" % (
        out_dir / "app.html", len(html.encode("utf-8")) / 1024, len(hashes)))
    return out_dir / "app.html"


def build_public_writer(out_dir, edge_out=None):
    """The ordinary engine, with no eagerly embedded article and explicit writer URLs."""
    world_dir = WORLDS / PUBLIC_WORLD
    data = build_data(PUBLIC_WORLD, False)
    data["publicWriter"] = True
    data["identityMarks"] = {theme: "data:image/svg+xml;base64," + base64.b64encode((APP_DIR / "logos/2" / ("mark-" + theme + ".svg")).read_bytes()).decode("ascii") for theme in ("light", "dark")}
    html, missing = inline((world_dir / "shell.html").read_text("utf-8"), world_dir,
                           PUBLIC_WORLD, data)
    if missing:
        raise SystemExit("writer could not inline: %s" % ", ".join(missing))
    # The approved site's variable faces, copied byte-for-byte into fonts/.
    # Public writer preparation includes them, so its typography needs no network.
    html = re.sub(r'<link\b[^>]*\bhref=["\x27]https://fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?', "", html)
    faces = (("Newsreader", "newsreader.woff2", "400 600", "normal"),
             ("Source Serif 4", "sourceserif4.woff2", "200 900", "normal"),
             ("Source Serif 4", "sourceserif4-italic.woff2", "200 900", "italic"),
             ("Commissioner", "commissioner.woff2", "100 900", "normal"),
             ("Martian Mono", "martianmono.woff2", "100 800", "normal"))
    css = "\n".join('@font-face{font-family:"%s";src:url("/fonts/%s") format("woff2");font-weight:%s;font-style:%s;font-display:swap}' % face for face in faces)
    html = html.replace("</head>", '<style id="writer-local-fonts">\n' + css + "\n</style>\n</head>", 1)
    # Stamp URLs in the build, never intercept global fetch at runtime. Repo-relative
    # article paths remain data; only absolute app endpoint/asset URLs are changed.
    for prefix in ("/api/", "/fonts/", "/icons/", "/logos/", "/favicon.",
                   "/manifest.webmanifest", "/sw.js"):
        html = re.sub(r"(?<!/write)" + re.escape(prefix), lambda m: "/write" + m.group(0), html)
    html = html.replace("{ scope: '/' }", "{ scope: '/write' }")
    # Browser manifest loads omit cookies unless credentials are explicit, even
    # on this origin. An anonymous manifest401 must not revoke a valid writer.
    html = html.replace('<link rel="manifest" href="/write/manifest.webmanifest">',
                        '<link rel="manifest" href="/write/manifest.webmanifest" crossorigin="use-credentials">')
    html = html.rstrip("\n") + "\n"
    if leaked_paragraphs(html, article_paragraphs()):
        raise SystemExit("REFUSED: the public writer embeds article text")
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.html").write_text(html, "utf-8")
    (out_dir / "app.csp.json").write_text(json.dumps({"scripts": script_hashes(html)}) + "\n", "utf-8")
    for name in PUBLIC_FILES + ("icons/castor-192.png", "icons/castor-512.png", "icons/castor-maskable-512.png"):
        target = out_dir / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((APP_DIR / name).read_bytes())
    manifest = {"id": "/write/", "name": product_name(), "short_name": product_name(),
                "start_url": "/write/", "scope": "/write/", "display": "standalone",
                "background_color": "#FAF9F4", "theme_color": "#FAF9F4",
                "icons": [{"src": "/write/icons/" + name, "sizes": size, "type": "image/png"}
                          for name, size in (("castor-192.png", "192x192"), ("castor-512.png", "512x512"))]}
    (out_dir / "manifest.webmanifest").write_text(json.dumps(manifest) + "\n", "utf-8")
    (out_dir / "sw.js").write_bytes((APP_DIR / "writer-sw.js").read_bytes())
    names = PUBLIC_FILES + ("icons/castor-192.png", "icons/castor-512.png",
                            "icons/castor-maskable-512.png", "index.html",
                            "app.csp.json", "manifest.webmanifest", "sw.js")
    generation = hashlib.sha256(b"descant.writer.assets.v1\x00")
    files = {}
    for name in sorted(names):
        digest = hashlib.sha256((out_dir / name).read_bytes()).digest()
        files[name] = digest.hex()
        generation.update(name.encode("utf-8") + b"\x00")
        generation.update(digest)
    (out_dir / "asset-generation.json").write_text(json.dumps({"v": 1, "assets": generation.hexdigest(), "files": files}) + "\n", "utf-8")
    # The Worker serves these only through its founder-guarded /write/ allowlist.
    # Keep the loopback origin bundle and the edge bundle byte-identical.
    if edge_out is not None:
        edge_out = Path(edge_out).resolve()
        for name in names + ("asset-generation.json",):
            target = edge_out / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((out_dir / name).read_bytes())
    print("  writer page %s, no article text, /write/ URLs" % (out_dir / "index.html"))
    return out_dir / "index.html"


def main():
    ap = argparse.ArgumentParser(
        prog="build.py",
        description="Inline the engine, a world's theme and the article's history into one self-contained file.")
    ap.add_argument("--world", help="build only this world (default: every world under design/app/worlds/)")
    ap.add_argument("--sample", action="store_true",
                    help="build from engine/sample/sample.md instead of the article; writes <world>/sample.html")
    ap.add_argument("--public-reviewer", metavar="DIR", nargs="?", const=str(PUBLIC_OUT),
                    help=("write Descant's reader page, the typewell world in reviewer mode with no article "
                          "inside it, to DIR/app.html (default %s)" % PUBLIC_OUT.relative_to(APP_DIR)))
    ap.add_argument("--public-writer", metavar="DIR", nargs="?", const=str(APP_DIR / "public-writer"),
                    help="write the authenticated /write/ shell without article text")
    args = ap.parse_args()

    if args.public_reviewer:
        build_public_reviewer(args.public_reviewer)

    if args.public_writer:
        # Combined builds use the reader's deployment directory. A standalone
        # custom output remains scratch; the normal writer build also targets ASSETS.
        edge_out = Path(args.public_reviewer) / "write" if args.public_reviewer else (
            PUBLIC_OUT / "write" if Path(args.public_writer).resolve() == APP_DIR / "public-writer" else None)
        build_public_writer(args.public_writer, edge_out=edge_out)

    if args.public_reviewer or args.public_writer:
        return 0

    if not WORLDS.exists():
        print("No design/app/worlds/ yet, so there is nothing to build.")
        return 0
    dirs = sorted(d for d in WORLDS.iterdir()
                  if d.is_dir() and (d / "shell.html").is_file() and (d / "theme.css").is_file())
    if args.world:
        dirs = [d for d in dirs if d.name == args.world]
        if not dirs:
            print("No world named %r under design/app/worlds/ yet, so there is nothing to build." % args.world)
            return 0
    if not dirs:
        print("design/app/worlds/ holds no world folders yet, so there is nothing to build.")
        return 0

    write_manifest(product_name())
    which = bool(args.sample)
    print("Building %s%s" % (", ".join(d.name for d in dirs),
          " from the sample piece" if args.sample else ""))
    built = 0
    for d in dirs:
        try:
            if build_world(d, which):
                built += 1
        except RuntimeError as err:
            print("  %-10s %s" % (d.name, err))
    if not built:
        print("Nothing was built. The shells are another builder's; run this again once they exist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
