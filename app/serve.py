#!/usr/bin/env python3
"""Serve design/app over loopback, including the prototype's bounded write APIs.

Python 3 standard library only. Binds 127.0.0.1 always, and with --tailnet also the
machine's own Tailscale address, so an iPad or a phone on the founder's tailnet can open
the page. It never binds 0.0.0.0, never reads an environment token, and never prints one.

    GET  /api/piece?path=<repo-relative>                   -> the piece live: markdown, versions, files
    GET  /api/comments?path=<repo-relative article>        -> its review threads in UI shape
    GET  /api/search?q=<2 to 100 characters>               -> titles, text and comments of every article
    POST /api/piece                                       -> one checked human save, one attributed commit
    POST /api/comments                                    -> changed review threads, one attributed commit
    POST /api/review                                       -> appends the body to design/app/reviews/<world>.json
    POST /api/review/asset                                 -> writes one resized pin image under reviews/assets/
    POST /api/pieces/new                                  -> a founder starts a new article from its title, one commit
    POST /api/files/mkdir                                  -> creates a folder in the piece folder
    POST /api/files/upload                                 -> stores one size-capped, byte-sniffed file
    POST /api/files/move                                   -> moves one article entry or puts it in a resource group
    POST /api/files/order                                  -> writes <folder>/.order in Git
    GET  /api/files/content?piece=<folder>&path=<relative> -> reads one article file
    PUT  /api/canvas?piece=<folder>                        -> writes <article>/workspace.canvas
    GET  /api/canvas?piece=<folder>                        -> that file, or an empty JSON Canvas
    GET  /api/whoami                                       -> {"role": "founder"}
    POST /api/share/admin-link                             -> a one-time link into Descant's dashboard

Only paths under articles/ or design/app/engine/sample/ can be read through git.

--share-to URL connects this server to Descant, the public Worker in design/app/reviewers/
where outside readers comment on what a founder shares with them. Every request goes OUT from
here (see share_cycle); nothing on this server accepts a request from Descant.

--reviewer-port N adds a separate listener on 127.0.0.1 ONLY, for outside reviewers who
arrive through Cloudflare Access (see ReviewerHandler). It trusts one header for identity,
admits only the addresses in CASTOR_REVIEWERS, serves the synthetic sample page and
nothing else static, and lets a reviewer read and comment on the pieces shared with them.
"""

import argparse
import base64
import difflib
import datetime
import gzip
import hashlib
import hmac
import json
import math
import os
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import shutil
import signal
import secrets
import socket
import unicodedata
import urllib.error
import urllib.request
from html.parser import HTMLParser
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie, CookieError
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

APP_DIR = Path(__file__).resolve().parent          # design/app
sys.path.insert(0, str(APP_DIR))
import publication
import space_config
REPO_ROOT = APP_DIR.parents[1]                     # the repository root
REVIEWS = APP_DIR / "reviews"
REVIEW_ASSETS = REVIEWS / "assets"

ALLOWED_PREFIXES = ("articles/", "design/app/engine/sample/")
WORLD_RE = re.compile(r"[^a-z0-9-]")
MAX_BODY = 5 * 1024 * 1024
MAX_UPLOAD = 3 * 1024 * 1024
TAILSCALE = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
NO_STORE = (".html", ".js", ".css")
COMPRESSIBLE = ("text/", "application/json", "image/svg+xml", "text/javascript")
GZIP_FLOOR = 1024                       # below this the header costs more than it saves
_GZIP_CACHE = {}                        # (path, mtime, size) -> compressed bytes
_GZIP_CACHE_MAX = 24
FILES_ROOT_OVERRIDE = None
WRITE_LOCK = threading.RLock()
READ_ONLY_CAPTURE = threading.local()



def site_tag_url(site):
    """[url, format] of a configured site's public tag source (space_config.py sites), or None."""
    entry = space_config.site(site)
    return [entry["tagsFrom"]["url"], entry["tagsFrom"]["format"]] if entry and entry["tagsFrom"] else None


def sites_refusal():
    names = [entry["name"] for entry in space_config.sites()]
    if not names:
        return "No publishing site is set up for this writing space."
    return "Choose " + (names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]) + "."


def preview_origin():
    """The origin of the server Publish site, whose absolute links a private preview keeps inside itself."""
    entry = space_config.server_site()
    return "/".join(entry["liveBase"].split("/", 3)[:3]) + "/" if entry else ""

_SITE_TAG_CACHE = {}
_SITE_TAG_LOCK = threading.Lock()
_TAG_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


class SiteTagHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = set()
        self.found = False

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key == "data-filter":
                self.found = True
                if value != "all" and value and _TAG_RE.fullmatch(value):
                    self.tags.add(value)


class _SameSiteRedirect(urllib.request.HTTPRedirectHandler):
    """A tag source may redirect within its own site (www, trailing slash), never elsewhere."""
    def __init__(self, host):
        self.allowed = (host, "www." + host)

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlparse(newurl)
        if target.scheme != "https" or target.hostname not in self.allowed:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open_tag_source(request, host, timeout):
    return urllib.request.build_opener(_SameSiteRedirect(host)).open(request, timeout=timeout)


def live_site_tags(site):
    """Only the configured public URL, a bounded read, and no invented absence on failure."""
    with _SITE_TAG_LOCK:
        cached = _SITE_TAG_CACHE.get(site)
        if cached and time.monotonic() - cached[0] < 600:
            return cached[1]
        tags = None
        source = site_tag_url(site)
        try:
            if not source:
                raise ValueError("No tag source")
            url, kind = source
            host = urlparse(url).hostname
            request = urllib.request.Request(url, headers={"Accept": "text/html" if kind == "html" else "application/rss+xml", "User-Agent": "Descant/1.0"})
            with _open_tag_source(request, host, timeout=3) as response:
                if urlparse(response.geturl()).hostname not in (host, "www." + host):
                    raise ValueError("Unexpected tag source")
                data = response.read(2 * 1024 * 1024 + 1)
                if len(data) > 2 * 1024 * 1024:
                    raise ValueError("Tag source too large")
            if kind == "html":
                parsed = SiteTagHTML()
                parsed.feed(data.decode("utf-8"))
                if not parsed.found:
                    raise ValueError("Tag index unavailable")
                tags = parsed.tags
            else:
                feed = ET.fromstring(data)
                if feed.tag.rsplit('}', 1)[-1] != 'rss':
                    raise ValueError("Tag feed unavailable")
                tags = {node.text.strip() for node in feed.iter() if node.tag.rsplit('}', 1)[-1] == "category"
                        and node.text and _TAG_RE.fullmatch(node.text.strip())}
        except (OSError, ValueError, ET.ParseError, urllib.error.URLError):
            pass
        _SITE_TAG_CACHE[site] = (time.monotonic(), tags)
        return tags


def site_tags(site):
    counts = {}
    for article in (REPO_ROOT / "articles").glob("*/article.md"):
        if article.is_symlink() or article.parent.is_symlink():
            continue
        try:
            fields, _, header = publication.frontmatter(article.read_text("utf-8"))
            target = fields.get("site")
            if not target:
                try:
                    target = json.loads((article.parent / "live.json").read_text("utf-8")).get("site")
                except (OSError, ValueError, AttributeError):
                    pass
            target = target or space_config.default_site(fields)
            if target != site:
                continue
            value = fields.get("tags", [])
            if isinstance(value, list):
                tags = value
            elif isinstance(value, str) and value.startswith("[") and value.endswith("]"):
                tags = [tag.strip().strip("'\"") for tag in value[1:-1].split(",")]
            else:
                block = re.search(r"^tags:[ \t]*(?:#.*)?\n((?:[ \t]+[^\n]*\n?|\n)*)", header, re.M)
                tags = re.findall(r"^[ \t]*-[ \t]+([^\n]+)", block[1], re.M) if block else []
                tags = [tag.strip().strip("'\"") for tag in tags]
            for tag in set(tag for tag in tags if isinstance(tag, str) and _TAG_RE.fullmatch(tag)):
                counts[tag] = counts.get(tag, 0) + 1
        except (OSError, ValueError, publication.Refused):
            continue
    live = live_site_tags(site)
    return {"site": site, "liveAvailable": live is not None,
            "tags": [{"tag": tag, "onSite": live is not None and tag in live, "count": counts.get(tag, 0)}
                     for tag in sorted(set(counts) | (live or set()))]}
PUBLICATION_LOCK = threading.Lock()
PUBLICATION_APPROVALS = {}
FILES_LOCK = WRITE_LOCK
from agent import interface as agent_interface

RESOURCE_GROUPS = {"images": "images", "documents": "documents", "other": "other"}


def _agent_app():
    from types import SimpleNamespace
    return SimpleNamespace(**globals())


def git(*args, timeout=20):
    done = subprocess.run(
        ["git", "-C", str(REPO_ROOT), *args],
        capture_output=True, text=True, timeout=timeout,
    )
    # With --sync, the repository this app writes to is a clone of the shared one, and a
    # commit that stays here is a commit the other founder never sees. So every commit
    # the app makes is pushed at once; a push that loses a race rebases and tries again.
    if args and args[0] == "commit" and done.returncode == 0:
        sync_push()
    return done


# --sync: this checkout follows its upstream. It pulls before it answers (at most every
# PULL_EVERY seconds, and always before a write) and pushes after every commit, so the
# app is an overhead on the shared repository rather than a side copy of it.
#
# A push that fails or stalls never undoes the commit it follows: the commit stays, the
# push is marked pending, and a background thread pushes again, waiting PUSH_RETRY_FIRST
# seconds and doubling to PUSH_RETRY_MAX, until it lands.
SYNC = {"on": False, "last_pull": 0.0, "last_error": "", "push_pending": False, "retrying": False,
        "push_sha": "", "push_at": "", "push_error": ""}
SYNC_LOCK = threading.Lock()
RETRY_LOCK = threading.Lock()
PULL_EVERY = 8
PUSH_WAIT = float(os.environ.get("CASTOR_PUSH_WAIT") or 40)   # seconds for one push, pull or rebase
PUSH_RETRY_FIRST = 2
PUSH_RETRY_MAX = 60


def _git_raw(*args, timeout=40):
    """git in its own process group, so a timeout also ends what git started (ssh, a
    hook) and the call returns when the timeout says, not when the last child exits."""
    process = subprocess.Popen(["git", "-C", str(REPO_ROOT), *args], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        process.communicate()
        raise
    return subprocess.CompletedProcess(process.args, process.returncode, out, err)


def sync_pull(force=False):
    if not SYNC["on"]:
        return
    if not force:
        # A read does not wait for the network: the pull (~0.7 s to the forge) runs
        # beside it, and the reader sees the checkout as it stands, at most one pull
        # behind. Writes pass force=True and pull first, so a save never builds on
        # stale state; its base check refuses anything older anyway.
        if time.time() - SYNC["last_pull"] < PULL_EVERY or SYNC.get("pulling"):
            return
        SYNC["pulling"] = True
        SYNC["last_pull"] = time.time()

        def _background():
            try:
                _sync_pull_now(background=True)
            finally:
                SYNC["pulling"] = False
        threading.Thread(target=_background, daemon=True).start()
        return
    _sync_pull_now()


def _sync_pull_now(background=False):
    if background:
        # Only checkout inspection/application needs WRITE_LOCK. Never wait for
        # WRITE_LOCK while holding SYNC_LOCK: saves and pushes take the opposite
        # order, and a save can already hold the outer reentrant writer lock.
        def clean():
            status = _git_raw("status", "--porcelain", "--untracked-files=no")
            if status.returncode or status.stdout.strip():
                SYNC["last_error"] = ("pull: " + status.stderr.strip()[:200] if status.returncode
                                      else "pull held back: uncommitted changes in the checkout")
                print("  sync: " + SYNC["last_error"])
                return False
            return True

        def upstream():
            branch = _git_raw("symbolic-ref", "--quiet", "--short", "HEAD")
            if branch.returncode: return None
            name = branch.stdout.strip()
            remote = _git_raw("config", "--get", "branch." + name + ".remote")
            merge = _git_raw("config", "--get", "branch." + name + ".merge")
            if remote.returncode or merge.returncode: return None
            return name, remote.stdout.strip(), merge.stdout.strip()

        with WRITE_LOCK:
            SYNC["last_pull"] = time.time()
            if not clean(): return
            target = upstream()
            if not target:
                SYNC["last_error"] = "pull held back: the branch has no configured upstream"
                print("  sync: " + SYNC["last_error"])
                return
        with SYNC_LOCK:
            fetched = _git_raw("fetch", "--quiet", target[1], target[2])
            if fetched.returncode:
                SYNC["last_error"] = "pull: " + fetched.stderr.strip()[:200]
                print("  sync: " + SYNC["last_error"])
                return
            fetched_head = _git_raw("rev-parse", "--verify", "FETCH_HEAD")
            if fetched_head.returncode:
                SYNC["last_error"] = "pull: " + fetched_head.stderr.strip()[:200]
                print("  sync: " + SYNC["last_error"])
                return
            revision = fetched_head.stdout.strip()
        with WRITE_LOCK:
            if not clean(): return
            if upstream() != target:
                SYNC["last_error"] = "pull held back: the branch or upstream changed during fetch"
                print("  sync: " + SYNC["last_error"])
                return
            # Pin the fetched commit: another coordinated fetch may replace
            # FETCH_HEAD after SYNC_LOCK is released. Divergence still refuses.
            pulled = _git_raw("merge", "--ff-only", "--quiet", revision)
            SYNC["last_error"] = "" if pulled.returncode == 0 else "pull: " + pulled.stderr.strip()[:200]
            if SYNC["last_error"]: print("  sync: " + SYNC["last_error"])
        return
    with WRITE_LOCK, SYNC_LOCK:
        SYNC["last_pull"] = time.time()
        dirty = _git_raw("status", "--porcelain", "--untracked-files=no").stdout.strip()
        if dirty:
            SYNC["last_error"] = "pull held back: uncommitted changes in the checkout"
            print("  sync: " + SYNC["last_error"])
            return
        pulled = _git_raw("pull", "--ff-only", "--quiet")
        SYNC["last_error"] = "" if pulled.returncode == 0 else "pull: " + pulled.stderr.strip()[:200]
        if SYNC["last_error"]:
            print("  sync: " + SYNC["last_error"])


def _push_once():
    """One push of HEAD; a push that lost a race rebases and tries once more. True when
    the upstream has HEAD. Raises on a timeout or a git that cannot start."""
    with WRITE_LOCK, SYNC_LOCK:
        pushed = _git_raw("push", "--quiet", "origin", "HEAD", timeout=PUSH_WAIT)
        if pushed.returncode != 0:
            rebased = _git_raw("pull", "--rebase", "--quiet", timeout=PUSH_WAIT)
            if rebased.returncode != 0:
                _git_raw("rebase", "--abort", timeout=PUSH_WAIT)
                SYNC["last_error"] = "push lost a race and the rebase failed: " + rebased.stderr.strip()[:160]
                print("  sync: " + SYNC["last_error"])
                return False
            pushed = _git_raw("push", "--quiet", "origin", "HEAD", timeout=PUSH_WAIT)
        SYNC["last_error"] = "" if pushed.returncode == 0 else "push: " + pushed.stderr.strip()[:200]
        SYNC["push_error"] = SYNC["last_error"]
        if pushed.returncode == 0:
            SYNC["push_sha"] = _git_raw("rev-parse", "HEAD").stdout.strip()
            SYNC["push_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        if SYNC["last_error"]:
            print("  sync: " + SYNC["last_error"])
        return pushed.returncode == 0


def _try_push():
    try:
        return _push_once()
    except (OSError, subprocess.SubprocessError) as error:
        SYNC["last_error"] = "push did not finish: " + str(error)[:200]
        SYNC["push_error"] = SYNC["last_error"]
        print("  sync: " + SYNC["last_error"])
        return False


def sync_push():
    """Share the commit just made. Never raises: a push that fails or stalls leaves the
    commit and the working file as they are, marks the push pending and retries it in
    the background. True when the upstream has HEAD."""
    if not SYNC["on"]:
        return True
    if _try_push():
        SYNC["push_pending"] = False
        return True
    SYNC["push_pending"] = True
    _retry_push_later()
    return False


def _retry_push_later():
    with RETRY_LOCK:
        if SYNC["retrying"]:
            return
        SYNC["retrying"] = True

    def _loop():
        wait = PUSH_RETRY_FIRST
        while True:
            time.sleep(wait)
            if SYNC["push_pending"] and _try_push():
                SYNC["push_pending"] = False
                print("  sync: the pending push landed")
            with RETRY_LOCK:
                if not SYNC["push_pending"]:
                    SYNC["retrying"] = False
                    return
            wait = min(wait * 2, PUSH_RETRY_MAX)

    threading.Thread(target=_loop, daemon=True).start()


def git_blob(ref_path, timeout=20, commit="HEAD"):
    return subprocess.run(
        ["git", "-C", str(REPO_ROOT), "show", "%s:%s" % (commit, ref_path)],
        capture_output=True, timeout=timeout,
    )


def save_evidence(path, sha):
    """Prove the requested article commit and its presence on the upstream branch."""
    history = None
    if SHA_RE.fullmatch(sha or ""):
        commit = _git_raw("show", "-s", "--format=%H%n%cI", sha)
        blob = git_blob_at(sha, path)
        if commit.returncode == 0 and blob.returncode == 0:
            rows = commit.stdout.strip().splitlines()
            if len(rows) == 2:
                history = {"sha": rows[0], "at": rows[1]}
    shared = {"ok": False, "at": "", "reason": "Waiting for the article’s save."}
    if history:
        if not SYNC["on"]:
            shared["reason"] = "Shared backup is off on this server. The commit stays here."
        else:
            upstream = _git_raw("rev-parse", "--verify", "@{upstream}")
            has = (upstream.returncode == 0 and
                   _git_raw("merge-base", "--is-ancestor", history["sha"], upstream.stdout.strip()).returncode == 0)
            if has:
                pushed_here = (bool(SYNC["push_at"] and SYNC["push_sha"]) and
                               _git_raw("merge-base", "--is-ancestor", history["sha"], SYNC["push_sha"]).returncode == 0)
                shared = {"ok": True, "at": SYNC["push_at"] if pushed_here else datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          "checked": not pushed_here}
            else:
                shared["reason"] = ("The shared server has not confirmed this commit. Retrying automatically."
                                    if SYNC["push_pending"] else "The shared server has not confirmed this commit. The next save sends it again.")
                if SYNC["push_error"]:
                    shared["reason"] = "The shared server could not take the backup. Retrying automatically."
    return {"path": path, "history": history, "shared": shared}


def git_blob_at(sha, path):
    return _git_raw("show", sha + ":" + path)






def safe_path(value):
    """A repo-relative path we are willing to read through git, or None."""
    if not value:
        return None
    value = value.lstrip("/")
    if ".." in value.split("/") or "\x00" in value:
        return None
    if not value.startswith(ALLOWED_PREFIXES):
        return None
    return value


def safe_world(value):
    world = WORLD_RE.sub("", str(value or "").lower()).strip("-")
    return world or "unknown"


def safe_piece(value):
    """An existing piece folder inside the repository, without symlink components."""
    value = str(value or "").strip()
    if not value or value.startswith("/") or "\\" in value or "\x00" in value or \
            any(part in ("", ".", "..") for part in value.split("/")):
        return None
    if not safe_path(value + "/.castor-probe"):
        return None
    target = sandbox_path(REPO_ROOT, value)
    if target is None or not (target / "article.md").is_file() or (target / "article.md").is_symlink():
        return None
    return value


def sandbox_root(piece):
    """The legacy store, used only for the one-time import."""
    return FILES_ROOT_OVERRIDE if FILES_ROOT_OVERRIDE is not None else REVIEWS / "files-sandbox" / piece


def sandbox_path(root, relative, allow_root=False):
    """Resolve a relative path inside one folder, rejecting every symlink."""
    value = str(relative or "").strip()
    if not value:
        return root.resolve() if allow_root and not root.is_symlink() else None
    if value.startswith("/") or "\\" in value or "\x00" in value or \
            any(part in ("", ".", "..", ".git") for part in value.split("/")):
        return None
    if root.is_symlink():
        return None
    target = root
    for part in value.split("/"):
        target = target / part
        if target.is_symlink():
            return None
    resolved_root = root.resolve()
    target = target.resolve()
    return target if target != resolved_root and resolved_root in target.parents else None


def commit_files(changes, subject, people=None, trailers=None, move=None):
    """Commit exact bounded bytes, including an unchanged candidate retained by a crash."""
    if getattr(READ_ONLY_CAPTURE, 'active', False):
        raise ValueError('offline-read-only')
    relative = [target.relative_to(REPO_ROOT).as_posix() for target in changes]
    before = {target: target.read_bytes() if target.is_file() else None for target in changes}
    desired = dict(zip(relative, changes.values()))

    def blobs(ref):
        # Enumerate first: a missing path is a deletion, an unreadable Git state
        # is a refusal. Read object bytes without text/newline conversion.
        listing = git("ls-files", "--stage", "-z", "--", *relative) if ref == ":" else \
            git("ls-tree", "-z", ref, "--", *relative)
        if listing.returncode:
            raise ValueError("Git could not verify this save; its files are retained")
        state = dict.fromkeys(relative)
        for entry in listing.stdout.split("\0"):
            if not entry:
                continue
            metadata, name = entry.split("\t", 1)
            mode, middle, last = metadata.split()
            oid = middle if ref == ":" else last
            if name not in state or mode not in ("100644", "100755") or \
                    (ref == ":" and last != "0"):
                raise ValueError("the requested Git paths changed; this save waits")
            blob = subprocess.run(["git", "-C", str(REPO_ROOT), "cat-file", "blob", oid],
                                  capture_output=True, timeout=20)
            if blob.returncode:
                raise ValueError("Git could not read this save; its files are retained")
            state[name] = blob.stdout
        return state

    def staged_paths():
        staged = git("diff", "--cached", "--name-only", "--no-renames", "-z")
        if staged.returncode:
            raise ValueError("Git could not inspect staged work; this save waits")
        return set(filter(None, staged.stdout.split("\0")))

    before_sha = git("rev-parse", "HEAD").stdout.strip()
    recorded = blobs(before_sha)
    expected_staging = {name for name in relative if recorded[name] != desired[name]}
    staged = staged_paths()
    retained = all(before[target] == data for target, data in changes.items())
    if staged and (staged != expected_staging or blobs(":") != desired or not retained):
        raise ValueError("the repository has changed or unrelated staged work; this save waits")
    if recorded == desired:
        if not retained:
            raise ValueError("the working files differ from this saved version; this save waits")
        return before_sha
    author, identity = session_commit(people or writing_session(FOUNDERS[0]))
    try:
        if move and not retained:
            if not move[0].exists() or move[1].exists():
                raise ValueError("the retained move changed; this save waits")
            moved = git("mv", "--", *[path.relative_to(REPO_ROOT).as_posix() for path in move])
            if moved.returncode:
                raise ValueError("Git could not move that file: " + moved.stderr.strip())
        for target, data in changes.items():
            if retained:
                continue
            if data is None:
                if target.is_file():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(target, data)
        # A move or retained deletion may already have removed the source from
        # the index. Git add cannot name that absent path again.
        index = blobs(":")
        pending = staged_paths()
        if pending and (pending != expected_staging or index != desired):
            raise ValueError("the staged candidate changed; this save waits")
        staging = [name for name in relative if desired[name] is not None or index[name] is not None]
        if staging and not staged:
            added = git("add", "--", *staging)
            if added.returncode:
                raise ValueError("Git could not stage this save: " + added.stderr.strip())
        gate = subprocess.run([str(REPO_ROOT / "check.sh")], cwd=REPO_ROOT,
                              capture_output=True, text=True, timeout=60)
        if gate.returncode:
            raise ValueError("the repository gate refused this save: " + (gate.stdout + gate.stderr)[-600:])
        if staged_paths() != expected_staging or blobs(":") != desired or any(
                (target.read_bytes() if target.is_file() else None) != data for target, data in changes.items()):
            raise ValueError("the save candidate changed before commit; its files are retained")
        saved = git("commit", *author, "-m", subject, "-m", trailers or identity, "--", *relative, timeout=40)
        if saved.returncode:
            raise ValueError("Git could not commit this save: " + saved.stderr.strip())
        sha = git("rev-parse", "HEAD").stdout.strip()
        if blobs(sha) != desired:
            raise ValueError("the exact save bytes are not committed")
        return sha
    except (OSError, ValueError, subprocess.TimeoutExpired):
        landed = publication.landed_commit(REPO_ROOT, before_sha, desired)
        if landed:
            return landed
        # A failed recovery keeps the pre-existing candidate/index available for
        # another retry. A changed HEAD or index is never ours to roll back.
        if staged or git("rev-parse", "HEAD").stdout.strip() != before_sha:
            raise
        index = blobs(":")
        current_staged = staged_paths()
        for target, data in before.items():
            name = target.relative_to(REPO_ROOT).as_posix()
            current = target.read_bytes() if target.is_file() else None
            if current != changes[target] or index[name] not in (desired[name], recorded[name]):
                continue
            if name in current_staged:
                git("reset", "-q", "HEAD", "--", name)
            if data is None:
                if target.is_file():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(target, data)
        raise


def in_git_history(data):
    """True when these exact bytes are already a blob somewhere in the repository."""
    sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
    return _git_raw("cat-file", "-e", sha).returncode == 0


def initialise_sandbox(piece):
    """Use the real folder and import legacy files once, preserving conflicts as materials."""
    root = sandbox_path(REPO_ROOT, piece)
    if root is None:
        raise ValueError("that piece folder contains a symlink")
    legacy = sandbox_root(piece)
    marker = root / ".files-migrated.json"
    if legacy.is_symlink():
        raise ValueError("the legacy Files folder is a symlink; migration waits")
    if not legacy.exists() or marker.exists():
        return root
    if getattr(READ_ONLY_CAPTURE, 'active', False):
        raise ValueError('offline-migration-needed')
    changes = {}
    for source in sorted(legacy.rglob("*")):
        if source.is_symlink():
            raise ValueError("the legacy Files folder contains a symlink; migration waits")
        if not source.is_file():
            continue
        relative = source.relative_to(legacy).as_posix()
        target = sandbox_path(root, relative)
        if target is None:
            raise ValueError("a legacy file leaves the piece folder; migration waits")
        data = source.read_bytes()
        if in_git_history(data):
            continue
        if target.is_file():
            if target.read_bytes() == data:
                continue
            target = sandbox_path(root, "materials/legacy-sandbox/" + relative)
            if target is None or target.exists():
                raise ValueError("a legacy migration conflict needs a founder's choice")
        changes[target] = data
    changes[marker] = b'{"imported": true}\n'
    commit_files(changes, "Import the legacy workspace and files for " + root.name,
                 trailers="Principal: %s\nActor: descant-migration\nBasis: autonomous" % default_owner())
    return root


def sniff_upload(blob):
    """Return a content type from bytes. The filename is deliberately irrelevant."""
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if blob.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if blob.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    if blob.startswith(b"%PDF-"):
        return "application/pdf"
    if blob.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return "application/zip"
    if len(blob) >= 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WAVE":
        return "audio/wav"
    if blob.startswith(b"ID3") or (len(blob) > 1 and blob[0] == 0xff and blob[1] & 0xe0 == 0xe0):
        return "audio/mpeg"
    if len(blob) >= 12 and blob[4:8] == b"ftyp":
        return "video/mp4"
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        return "application/octet-stream"
    if "\x00" in text:
        return "application/octet-stream"
    stripped = text.lstrip("\ufeff\t\r\n ")
    if re.match(r"^(?:<\?xml[^>]*>\s*)?(?:<!--.*?-->\s*)*<svg\b", stripped,
                re.I | re.S):
        return "image/svg+xml"
    if stripped[:1] in ("{", "["):
        try:
            json.loads(stripped)
            return "application/json"
        except ValueError:
            pass
    return "text/plain"


def compatible_type(declared, actual):
    declared = str(declared or "").lower().split(";", 1)[0].strip()
    if declared in ("", "application/octet-stream"):
        return True
    if declared == actual:
        return True
    if actual == "text/plain" and declared in ("text/markdown", "text/x-markdown"):
        return True
    if actual == "application/json" and declared in ("text/plain", "text/markdown"):
        return True
    return False


def resource_group(content_type):
    if content_type.startswith("image/"):
        return "images"
    if content_type.startswith("text/") or content_type in ("application/pdf", "application/json"):
        return "documents"
    return "other"


def canonical_name(name, content_type):
    raw = str(name or "").strip()
    if not raw or raw != Path(raw).name or raw in (".", "..") or "\x00" in raw or \
            any(ord(ch) < 32 for ch in raw):
        return None
    suffixes = {
        "image/png": (".png",), "image/jpeg": (".jpg", ".jpeg"),
        "image/gif": (".gif",), "image/webp": (".webp",), "image/svg+xml": (".svg",),
        "application/pdf": (".pdf",), "application/json": (".json", ".canvas"),
        "application/zip": (".zip",), "audio/wav": (".wav",),
        "audio/mpeg": (".mp3",), "video/mp4": (".mp4",),
        "text/plain": (".txt", ".md"),
    }
    allowed = suffixes.get(content_type)
    if not allowed:
        return raw
    if Path(raw).suffix.lower() in allowed:
        return raw
    stem = Path(raw).stem if Path(raw).suffix else raw
    return (stem or "resource") + allowed[0]


def unique_path(folder, name):
    target = folder / name
    if not target.exists():
        return target
    stem, suffix = Path(name).stem, Path(name).suffix
    for number in range(2, 10000):
        candidate = folder / ("%s-%d%s" % (stem, number, suffix))
        if not candidate.exists():
            return candidate
    return None


def file_entry_for_sandbox(root, target, piece, content_type=None, thumbnail=None):
    relative = target.relative_to(root).as_posix()
    actual = content_type or sniff_upload(target.read_bytes())
    preview = "image" if actual.startswith("image/") else \
        "pdf" if actual == "application/pdf" else \
        "canvas" if target.suffix.lower() == ".canvas" else \
        "markdown" if actual.startswith("text/") or actual == "application/json" else "file"
    entry = {
        "path": relative, "name": target.name, "kind": "file", "type": actual,
        "preview": preview, "group": resource_group(actual), "size": target.stat().st_size,
        "date": datetime.date.today().isoformat(),
        "url": "/api/files/content?piece=%s&path=%s" % (relative_url(piece), relative_url(relative)),
    }
    if thumbnail:
        entry["thumbnail"] = thumbnail
    return entry


def sandbox_files(piece):
    """List the article folder, including empty folders and tracked ordering."""
    root = initialise_sandbox(piece)
    entries = []
    for target in sorted(root.rglob("*")):
        relative = target.relative_to(root).as_posix()
        if relative == "drafts" or relative.startswith("drafts/"):
            continue
        if sandbox_path(root, relative) is None or target.name in (".order", ".gitkeep", ".files-migrated.json"):
            continue
        if target.is_dir():
            entries.append({"path": relative, "name": target.name, "kind": "folder"})
        elif target.is_file():
            entries.append(file_entry_for_sandbox(root, target, piece))
    return entries


def files_order(piece):
    root = initialise_sandbox(piece)
    order = {}
    for target in root.rglob(".order"):
        if sandbox_path(root, target.relative_to(root).as_posix()) is None:
            continue
        try:
            values = json.loads(target.read_text("utf-8"))
            if isinstance(values, list) and all(isinstance(name, str) for name in values):
                order["" if target.parent == root else target.parent.relative_to(root).as_posix()] = values
        except (ValueError, OSError):
            continue
    return order


def relative_url(value):
    from urllib.parse import quote
    return quote(str(value), safe="")


# ------------------------------------------------------- the piece, read live
#
# /api/piece is the page's other way in: instead of the data build.py embedded, the
# shell asks the server for the piece as the repository holds it right now, plus the
# last few commits that touched it as the saves rail's versions. Read-only, and only
# for the two prefixes above.

# Read-only, and read by the writing turn so the craft lives in one place rather than
# being copied into a prompt that then drifts from it.
# A person's save or comment carries that person as the commit author, whichever
# machine the app runs on: on the shared server the checkout's own identity is the
# app's, and blame would otherwise credit the app with every word a founder typed.
# The people live in data, not code: the writing space's .descant/people.json (or
# CASTOR_PEOPLE; see space_config.py), {"key": "Name <email>", ...}. With no entry the
# checkout's own identity is used.
def _load_people():
    data = space_config.people()
    return {k: v for k, v in data.items() if isinstance(v, str) and re.match(r"^[^<>]+ <[^<>@\s]+@[^<>\s]+>$", v)}


AUTHORS = _load_people()
# The writers of this installation, in people.json's order (a key is 1 to 24 lowercase
# letters, digits or -: space_config.WRITER_KEY). A space that names nobody has one writer, "writer".
WRITER_KEY_RE = re.compile(space_config.WRITER_KEY + r"\Z")
FOUNDERS = tuple(key for key in AUTHORS if space_config.is_writer_key(key)) or ("writer",)
WRITER_PATTERN = "|".join(re.escape(key) for key in FOUNDERS)
WRITERS_SAID = " or ".join(FOUNDERS) if len(FOUNDERS) < 3 else ", ".join(FOUNDERS[:-1]) + " or " + FOUNDERS[-1]


def default_owner():
    """The writer answerable for an article that names no owner: the first one in people.json."""
    return FOUNDERS[0]


def author_args(who):
    identity = AUTHORS.get(who)
    return ["--author", identity] if identity else []


# A writing session: the people at one save, the one at the keyboard first. The page
# sends `who` as a list of writer keys and {"name", "email"} for anyone else (one
# writer's key on its own is still accepted). The rules match app.js's guestProblem().
GUEST_EMAIL_RE = re.compile(
    r"^[^\s@<>()\[\],;:\"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$")
SESSION_MAX = 8


def _identity_email(identity):
    found = re.search(r"<([^<>]+)>$", identity or "")
    return found.group(1).lower() if found else ""


def writing_session(value):
    """[("<writer key>", None) | ("guest", "Name <email>"), ...] in order, or ValueError."""
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, list) or not 1 <= len(items) <= SESSION_MAX:
        raise ValueError("who must name the people writing, the one at the keyboard first")
    founder_emails = {_identity_email(identity) for identity in AUTHORS.values()} - {""}
    people, seen = [], set()
    for item in items:
        if isinstance(item, str):
            key = item.strip().lower()
            if key not in FOUNDERS:
                raise ValueError("a writer is " + WRITERS_SAID)
            person, mark = (key, None), key
        elif isinstance(item, dict):
            name = " ".join(str(item.get("name") or "").split())
            email = str(item.get("email") or "").strip()
            if not 1 <= len(name) <= 60 or re.search(r"[<>\x00-\x1f\x7f]", name) or not re.search(r"\w", name):
                raise ValueError("a name is 1 to 60 characters, with letters and no < or >")
            if len(email) > 254 or not GUEST_EMAIL_RE.fullmatch(email):
                raise ValueError("that email is not one the server can record")
            if email.lower() in founder_emails:
                raise ValueError("a writer is ticked as " + WRITERS_SAID + ", not added as someone else")
            person, mark = ("guest", "%s <%s>" % (name, email)), email.lower()
        else:
            raise ValueError("each person is " + ", ".join(FOUNDERS) + ", or a name with an email")
        if mark not in seen:
            seen.add(mark)
            people.append(person)
    if not any(kind in FOUNDERS for kind, _ in people):
        raise ValueError("every save names " + WRITERS_SAID)
    return people


def session_commit(people):
    """(author args, trailers) for one save by a writing session."""
    kind, identity = people[0]
    author = author_args(kind) if kind in FOUNDERS else ["--author", identity]
    present = [k for k, _ in people if k in FOUNDERS]
    principal = "both" if len(FOUNDERS) == 2 and set(present) == set(FOUNDERS) else present[0]
    lines = ["Principal: %s" % principal, "Actor: human", "Basis: instruction"]
    for other_kind, other in people[1:]:
        named = AUTHORS.get(other_kind) if other_kind in FOUNDERS else other
        if named:
            lines.append("Co-authored-by: %s" % named)
    return author, "\n".join(lines)
DEFAULT_PIECE = os.environ.get("CASTOR_DEFAULT_PIECE", "articles/01-why-castor/article.md")
PIECE_COMMITS = 12                              # saves shown in the rail
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
DRAFT_RE = re.compile(r"^articles/[^/]+/drafts/(" + WRITER_PATTERN + r")/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$")
ARTICLE_RE = re.compile(r"^articles/[^/]+/article\.md$")
SAY_LOCK = WRITE_LOCK                     # one loop turn at a time; git is shared
COMMENTS_LOCK = WRITE_LOCK                # one review-folder commit at a time
LOCKED_PIECES = frozenset(p for p in os.environ.get("CASTOR_LOCKED", "").split(",") if p.strip())
IMAGE_SUFFIXES = (".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp")
EMBED_RE = re.compile(r"!\[\[([^\]|#]+)((?:\|[^\]]*)?)\]\]")
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)")
# An Actor trailer naming a model means the agent made the save; anything else, or no
# trailer at all, means the writer. The role is read off the commit, never guessed.
MODEL_RE = re.compile(r"\b(claude|gpt|gemini|llama|mistral|deepseek|codex|sonnet|opus|haiku|fable)[-\w.]*", re.I)


def build_module():
    """build.py's own file-entry shape, so Files reads the same fields either way."""
    try:
        if str(APP_DIR) not in sys.path:
            sys.path.insert(0, str(APP_DIR))
        import build
        return build
    except Exception:
        return None


def piece_folder(path):
    return (REPO_ROOT / path).parent


def served_media(folder):
    """Image name -> the URL this server already serves it at (only under design/app/)."""
    out = {}
    try:
        folder.relative_to(APP_DIR)
    except ValueError:
        return out
    if not folder.is_dir():
        return out
    for p in sorted(folder.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        url = "/" + p.relative_to(APP_DIR).as_posix()
        rel = p.relative_to(folder).as_posix()
        for k in (rel, p.name, p.stem):
            out.setdefault(k, url)
    return out


def point_media(markdown, media):
    """Rewrite the piece's image references at the served URL. The file on disk is untouched."""
    if not media:
        return markdown

    def look(name):
        name = name.strip()
        return media.get(name) or media.get(name.rsplit("/", 1)[-1]) or \
            media.get(name.rsplit("/", 1)[-1].rsplit(".", 1)[0])

    def do_embed(m):
        url = look(m.group(1))
        return m.group(0) if not url else "![[%s%s]]" % (url, m.group(2))

    def do_image(m):
        url = look(m.group(2))
        return m.group(0) if not url else "![%s](%s%s)" % (m.group(1), url, m.group(3))

    return IMAGE_RE.sub(do_image, EMBED_RE.sub(do_embed, markdown))


def unpoint_media(submitted, original, media):
    """Undo point_media on text coming back from the page, for references the file already had.

    The page is served image references at their served URLs, so a save would write
    those URLs into the file. Each reference in the file on disk is pointed the way
    it was served, and that served form is swapped back for what the file said. A
    reference the writer typed new is left exactly as typed.
    """
    if not media:
        return submitted
    back = {}
    for pattern in (EMBED_RE, IMAGE_RE):
        for match in pattern.finditer(original):
            written = match.group(0)
            served = point_media(written, media)
            if served != written:
                back[served] = written
    for served in sorted(back, key=len, reverse=True):
        submitted = submitted.replace(served, back[served])
    return submitted


def author_role(body):
    m = re.search(r"^\s*Actor:\s*(.+?)\s*$", body or "", re.M)
    if not m:
        return "the writer"
    return "the agent" if MODEL_RE.search(m.group(1)) else "the writer"


def first_clause(subject):
    text = str(subject or "").strip()
    for sep in (":", ";", " — ", ","):
        if sep in text:
            text = text.split(sep)[0].strip()
            break
    return (text[:80].rstrip() + "...") if len(text) > 80 else (text or "a save")


def piece_versions(path, media):
    """The last commits touching the file, oldest first, each with its whole text."""
    out = git("log", "-n", str(PIECE_COMMITS),
              "--format=%H%x1f%cI%x1f%s%x1f%b%x1f%an%x1e", "--", path)
    if out.returncode != 0:
        return []
    versions = []
    for record in out.stdout.split("\x1e"):
        record = record.strip("\n")
        if not record.strip():
            continue
        parts = record.split("\x1f")
        if len(parts) < 3:
            continue
        sha, when, subject = parts[0].strip(), parts[1], parts[2]
        body = parts[3] if len(parts) > 3 else ""
        shown = git("show", "%s:%s" % (sha, path))
        if shown.returncode != 0:
            continue                       # the file did not exist at that commit
        principal = re.search(r"^Principal:\s*(" + WRITER_PATTERN + r"|both)\s*$", body, re.M)
        versions.append({
            "id": sha[:12], "sha": sha, "label": first_clause(subject),
            "author": author_role(body), "when": when, "summary": subject,
            "who": parts[4].strip() if len(parts) > 4 else "Unknown author",
            "authorRole": "agent" if author_role(body) == "the agent" else "human",
            "principal": principal.group(1) if principal else None,
            "markdown": point_media(shown.stdout, media),
        })
    versions.reverse()                     # newest last, the shape changes.js reads
    return versions


def piece_files(folder):
    build = build_module()
    entries = []
    if not folder.is_dir():
        return entries
    for p in sorted(x for x in folder.rglob("*") if x.is_file()):
        rel = p.relative_to(folder).as_posix()
        stat = p.stat()
        date = datetime.datetime.fromtimestamp(stat.st_mtime).date().isoformat()
        if build:
            blob = p.read_bytes() if build.preview_kind(rel) == "image" else None
            entries.append(build.file_entry(rel, stat.st_size, date, blob))
        else:
            entries.append({"path": rel, "kind": "file", "size": stat.st_size,
                            "date": date, "type": "application/octet-stream", "preview": "file"})
    return entries


def article_path(value):
    """The one writable source shape, after the reader's existing path guard."""
    path = safe_path(value)
    return path if path and ARTICLE_RE.fullmatch(path) else None


def draft_path(value):
    path = str(value or "")
    match = DRAFT_RE.fullmatch(path)
    if not match or not safe_piece(path.split("/drafts/", 1)[0]):
        return None
    return path if sandbox_path(REPO_ROOT, path) is not None else None


def draft_header(markdown):
    match = FRONTMATTER_RE.match(markdown)
    return match.group(0) if match else ""


def draft_entry(path):
    text = (REPO_ROOT / path).read_text("utf-8")
    head = share_frontmatter(text)
    match = re.search(r"(?m)^title: (.+)$", draft_header(text))
    title = match[1] if match else Path(path).stem
    try:
        title = json.loads(title)
    except ValueError:
        pass
    return {"path": path, "title": title, "person": DRAFT_RE.fullmatch(path)[1],
            "hidden": head.get("hidden") == "true", "moved": head.get("moved") == "true",
            "sha": git("log", "-1", "--format=%H", "--", path).stdout.strip()}


def draft_current(path, base):
    """The exact file at the loaded commit still matches disk and HEAD."""
    if not SHA_RE.fullmatch(str(base or "")):
        return False
    target = REPO_ROOT / path
    loaded = git_blob_at(base, path)
    current = git_blob(path)
    return (target.is_file() and loaded.returncode == current.returncode == 0
            and loaded.stdout.encode("utf-8") == current.stdout == target.read_bytes())


def draft_splice(markdown, start, end, text):
    """Browser offsets use UTF-16; refuse split surrogate pairs and metadata edits."""
    raw = markdown.encode("utf-16-le")
    if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(raw) // 2:
        raise ValueError("Choose a position or passage in the article first.")
    try:
        result = raw[:start * 2].decode("utf-16-le") + text + raw[end * 2:].decode("utf-16-le")
    except UnicodeDecodeError:
        raise ValueError("The selected position splits a character. Choose it again.")
    if draft_header(markdown) != draft_header(result) or not founder_markers_survive(markdown, result):
        raise ValueError("Choose a passage in the article body.")
    return result


def comment_scalar(value):
    """The fixture subset of YAML: JSON strings plus plain one-line scalars."""
    value = value.strip()
    if value.startswith('"'):
        try:
            return json.loads(value)
        except ValueError:
            pass
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


MESSAGE_RE = re.compile(r"^\*\*(.+?)\*\*,\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?)(?:\s+\((.*?)\))?:\s*$")


def comment_files(folder):
    """Discover every numeric thread, including 1000+, with one file per ID."""
    files, seen = [], set()
    for target in sorted(folder.glob('[0-9]*-*.md')):
        match = re.fullmatch(r'([0-9]+)-.*\.md', target.name)
        if not match:
            continue
        identifier = match[1]
        if int(identifier) <= 0 or identifier != '%03d' % int(identifier) or identifier in seen:
            raise ValueError('review filenames need unique, positive, padded numeric thread IDs')
        seen.add(identifier)
        files.append(target)
    return files


def comment_document(target, text=None):
    """Parse one review file without treating its note as a person's reply.

    `text` parses content that is not on disk yet, so a write can be checked to read
    back as exactly what was meant before it is made."""
    if text is None:
        text = target.read_text("utf-8")
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("comment file has no frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError("comment frontmatter is not closed") from error
    meta, anchor = {}, {}
    in_anchor = False
    for line in lines[1:end]:
        if line == "anchor:":
            in_anchor = True
            continue
        match = re.match(r"^(  )?([a-z_]+):\s*(.*)$", line)
        if not match:
            continue
        key, value = match.group(2), comment_scalar(match.group(3))
        if match.group(1) and in_anchor:
            anchor[key] = value
        elif not match.group(1):
            in_anchor = False
            meta[key] = value

    filename = re.fullmatch(r'([0-9]+)-.*\.md', target.name) if target else None
    if filename and str(meta.get('thread') or '') != filename[1]:
        raise ValueError('the review filename and thread ID disagree')

    body = lines[end + 1:]
    heading = next((i for i, line in enumerate(body) if line.startswith("# ")), None)
    if heading is None:
        raise ValueError("comment file has no heading")
    starts = [(i, MESSAGE_RE.match(line)) for i, line in enumerate(body) if MESSAGE_RE.match(line)]
    if not starts:
        raise ValueError("comment file has no person block")

    note = ""
    messages = []
    for number, (start, match) in enumerate(starts):
        stop = starts[number + 1][0] if number + 1 < len(starts) else len(body)
        content = body[start + 1:stop]
        kept = []
        for line in content:
            stripped = line.strip()
            if stripped.startswith("_Re-anchored ") and stripped.endswith("_"):
                note = stripped[1:-1]
                continue
            if stripped == "---" and any(
                    item.strip().startswith("_Re-anchored ") for item in content):
                continue
            kept.append(line)
        message = "\n".join(kept).strip()
        qualifier = [part.strip() for part in (match.group(3) or "").split(",") if part.strip()]
        kind = "agent" if "agent" in qualifier else "human"
        identity = next((part[6:] for part in qualifier if part.startswith("reply:")), None)
        basis = ", ".join(part for part in qualifier if part not in ("agent", "human") and not part.startswith(("reply:","message:","writer:","principal:","model:","color:")))
        messages.append({
            **(reply_identity({"id": identity}) if identity else {}),
            **({"messageRef": next(part[8:] for part in qualifier if part.startswith("message:"))} if any(part.startswith("message:") for part in qualifier) else {}),
            **({"writer": next(part[7:] for part in qualifier if part.startswith("writer:"))} if any(part.startswith("writer:") for part in qualifier) else {}),
            **comment_display_fields({key: next((part[len(key) + 1:] for part in qualifier if part.startswith(key + ":")), None) for key in ("principal", "model", "color")}),
            "author": match.group(1), "created": match.group(2), "by": kind,
            "basis": basis, "text": message, "offer": None,
        })

    raw_status = str(meta.get("status") or "open")
    first = messages[0]
    thread = {
        "id": str(meta.get("thread") or ""),
        **comment_display_fields(meta),
        "anchor": {
            "quote": str(anchor.get("quote") or ""),
            "prefix": str(anchor.get("prefix") or ""),
            "suffix": str(anchor.get("suffix") or ""),
            "blockText": str(anchor.get("block") or ""),
            "version": str(anchor.get("version") or ""),
            **({"chosenPlace": comment_place(anchor.get("chosenPlace"))} if comment_place(anchor.get("chosenPlace")) else {}),
        },
        "author": str(meta.get("author") or first["author"] or "You"),
        "by": "agent" if meta.get("by") == "agent" else (
            "human" if meta.get("by") == "human" else ""),
        "text": first["text"],
        "created": str(meta.get("created") or first["created"]),
        "replies": messages[1:],
        "done": raw_status != "open",
        "status": raw_status,
        "note": note,
        "reanchoredFrom": str(anchor.get("reanchored_from") or ""),
        "refersTo": str(anchor.get("refers_to") or ""),
    }
    if meta.get("message_ref"):
        thread["messageRef"] = str(meta["message_ref"])
    if meta.get("writer"):
        thread["writer"] = str(meta["writer"])
    if meta.get("client_id"):
        thread["clientId"] = str(meta["client_id"])
    if anchor.get("chosen_place"):
        try:
            place = comment_place(json.loads(anchor["chosen_place"]))
            if place:
                thread["anchor"]["chosenPlace"] = place
        except (ValueError, TypeError):
            pass
    first_start = starts[0][0]
    preamble = "\n".join(body[heading + 1:first_start]).strip()
    return {
        "thread": thread, "slug": str(meta.get("slug") or target.stem.split("-", 1)[-1]),
        "source": str(meta.get("source") or "castor-writing-app"),
        "preamble": preamble,
    }


def comment_threads(path):
    folder = piece_folder(path) / "review"
    if not folder.is_dir():
        return []
    documents = [comment_document(target) for target in comment_files(folder)]
    return [document["thread"] for document in documents]



# Comment actions use immutable per-operation Git records. Shared thread revisions
# belong to Descant; importing its event is a later durability boundary.
COMMENT_REACTIONS = ("agree",)  # "question" was removed in round 1030: it carried no meaning a reply does not


def valid_comment_action_json(value):
    """The exact receipt must survive JSON and strict UTF-8 serialization."""
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            try: item.encode("utf-8")
            except UnicodeError: return False
        elif isinstance(item, float):
            if not math.isfinite(item): return False
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif item is not None and not isinstance(item, (bool, int)):
            return False
    return True


def comment_action_events(path, committed_only=False):
    records = []
    folder = piece_folder(path) / "review/actions"
    for target in sorted(folder.glob("*.md")):
        raw = target.read_text("utf-8")
        try:
            event = json.loads(raw.split("```json\n", 1)[1].rsplit("\n```", 1)[0])
            if not isinstance(event, dict) or not valid_comment_action_json(event): raise ValueError("a comment action record has an unknown shape")
            strings = ("id", "actorKey", "requestHash", "path", "slot", "created", "authority")
            request, state = event.get("request"), event.get("state")
            rev = event.get("resultRev")
            if any(not isinstance(event.get(k), str) or not event[k] for k in strings) or not isinstance(request, dict) or not isinstance(state, dict) or not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
                raise ValueError("a comment action record has incomplete fields")
            if event.get("threadId") is None or not isinstance(request.get("opId"), str) or not re.fullmatch(r"[-A-Za-z0-9_]{1,100}", request["opId"]) or request.get("path") != path or event["path"] != path or str(request.get("threadId")) != str(event["threadId"]) or event["authority"] not in ("git", "descant"):
                raise ValueError("a comment action request identity changed")
            slot = event["slot"]
            if slot == "status": valid_state = isinstance(state.get("done"), bool) and isinstance(state.get("status"), str)
            elif slot.startswith("message:"): valid_state = isinstance(state.get("text"), str) and isinstance(state.get("withdrawn"), bool)
            elif slot.startswith("reaction:"): valid_state = isinstance(state.get("active"), bool)
            else: valid_state = False
            if not valid_state: raise ValueError("a comment action state has an unknown shape")
            if event.get("id") != target.stem: raise ValueError("a comment action identity changed")
            if not committed_only or comment_action_committed(path, event): records.append(event)
        except (ValueError, IndexError):
            raise ValueError("a comment action record is unreadable")
    return records


def comment_action_bytes(event):
    if not valid_comment_action_json(event): raise ValueError("a comment action contains invalid JSON values")
    return ("# Comment action\n\nOriginal messages stay unchanged. This event records the selected action and its resulting state.\n\n```json\n" +
            json.dumps(event, ensure_ascii=False, allow_nan=False, sort_keys=True, indent=2) + "\n```\n").encode("utf-8")


def comment_action_committed(path, event):
    target = piece_folder(path) / "review/actions" / (event["id"] + ".md")
    expected = comment_action_bytes(event)
    recorded = git_blob(target.relative_to(REPO_ROOT).as_posix())
    return target.is_file() and not target.is_symlink() and target.read_bytes() == expected and recorded.returncode == 0 and recorded.stdout == expected


def commit_comment_action(target, data, subject, people, trailers, companions=None):
    """Recover only an exact operation file, never changed or unrelated staged work."""
    relative = target.relative_to(REPO_ROOT).as_posix()
    if companions:
        if target.exists() and (target.is_symlink() or target.read_bytes() != data):
            raise ValueError("the retained action file changed; this save waits")
        commit_files({target: data, **companions}, subject, people=people, trailers=trailers)
        return
    if not target.exists():
        commit_files({target: data}, subject, people=people, trailers=trailers)
    else:
        if target.is_symlink() or target.read_bytes() != data: raise ValueError("the retained action file changed; this save waits")
        recorded = git_blob(relative)
        if recorded.returncode == 0:
            if recorded.stdout != data: raise ValueError("the committed action identity conflicts; this save waits")
            return
        staged = git("diff", "--cached", "--name-only").stdout.splitlines()
        if any(name != relative for name in staged): raise ValueError("the repository has unrelated staged work; this save waits")
        index = subprocess.run(["git", "-C", str(REPO_ROOT), "show", ":" + relative], capture_output=True, timeout=20)
        if relative in staged and (index.returncode or index.stdout != data):
            raise ValueError("the staged action file changed; this save waits")
        author, identity = session_commit(people)
        gate = subprocess.run([str(REPO_ROOT / "check.sh")], cwd=REPO_ROOT, capture_output=True, text=True, timeout=60)
        if gate.returncode: raise ValueError("the repository gate refused this action: " + (gate.stdout + gate.stderr)[-600:])
        added = git("add", "--", relative)
        if added.returncode: raise ValueError("Git could not stage this action: " + added.stderr.strip())
        try:
            saved = git("commit", *author, "-m", subject, "-m", trailers or identity, "--", relative, timeout=40)
            if saved.returncode: raise ValueError("Git could not commit this action: " + saved.stderr.strip())
        except (OSError, ValueError, subprocess.TimeoutExpired):
            recorded = git_blob(relative)
            if recorded.returncode or recorded.stdout != data: raise
    recorded = git_blob(relative)
    if recorded.returncode or recorded.stdout != data: raise ValueError("the exact action bytes are not committed")


def private_action_answer(answer, identifier):
    if isinstance(answer.get("thread"), dict): answer["thread"]["id"] = identifier
    request = answer.get("receipt", {}).get("request")
    if isinstance(request, dict): request["threadId"] = identifier
    return answer


def comment_action_projection(path, thread, who=None, events=None):
    thread = json.loads(json.dumps(thread))
    key = "founder:" + who if who in FOUNDERS else ""
    if events is None: events = comment_action_events(path, committed_only=True)
    events = [e for e in events if e.get("localThreadId", e.get("threadId")) == thread["id"]]
    slots = {}
    for event in events:
        slot = event.get("localSlot", event["slot"])
        if event["resultRev"] > slots.get(slot, {}).get("resultRev", 0): slots[slot] = event
    state = slots.get("status")
    if state: thread.update(state["state"])
    thread["statusActions"] = {"rev": state["resultRev"] if state else 0, "canResolve": bool(key)}
    for index, message in enumerate([thread] + thread["replies"]):
        ref = message.get("messageRef") or ("local-root:" + thread["id"] if index == 0 else "local-reply:" + str(message.get("id") or index))
        message["messageRef"] = ref
        event = slots.get("message:" + ref)
        withdrawn = bool(event and event["state"].get("withdrawn"))
        reactions = {}
        for reaction in COMMENT_REACTIONS:
            mine = slots.get("reaction:" + ref + ":" + key + ":" + reaction)
            count = sum(bool(e["state"].get("active")) for slot, e in slots.items() if slot.startswith("reaction:" + ref + ":") and slot.endswith(":" + reaction))
            reactions[reaction] = {"count": count, "active": bool(mine and mine["state"].get("active")), "rev": mine["resultRev"] if mine else 0}
        owns = bool(key and message.get("writer") == key and message.get("by") == "human")
        message["actions"] = {"messageRef": ref, "rev": event["resultRev"] if event else 0, "withdrawn": withdrawn,
                              "permissions": {"edit": owns, "withdraw": owns, "react": bool(key)}, "reactions": reactions}
        if event: message["text"] = "Comment withdrawn." if withdrawn else event["state"]["text"]
    return thread


def comment_projected_threads(path, events=None):
    raw_events = comment_action_events(path)
    if events is None: events = [e for e in raw_events if comment_action_committed(path, e)]
    return [comment_action_projection(path, t, events=events) for t in comment_threads(path)] if raw_events else comment_threads(path)


def comment_action_document(path, who, events=None):
    if events is None: events = comment_action_events(path, committed_only=True)
    threads, receipts = [], []
    targets = [comment_document(t) for t in comment_files(piece_folder(path) / "review")]
    private_ids = {m.group(1): d["thread"]["id"] for d in targets for m in [DESCANT_SOURCE_RE.match(d["source"])] if m}
    descant_ids = list(private_ids.keys())
    remote_map = {}
    shared_actions = None
    authority = "git"

    if descant_ids and SHARE.get("url") and SHARE.get("ready"):
        try:
            for i in range(0, len(descant_ids), 50):
                chunk = descant_ids[i:i + 50]
                answer = share_call("GET", "/sync/action-state?path=" + quote(path, safe="") + "&threadIds=" + ",".join(chunk) + "&who=" + who)
                if not isinstance(answer, dict):
                    raise ShareError("invalid action-state response")
                if shared_actions is None:
                    shared_actions = answer.get("commentActions")
                for item in answer.get("threads") or []:
                    if isinstance(item, dict) and "threadId" in item:
                        remote_map[str(item["threadId"])] = item.get("thread")
        except ShareError:
            remote_map = None

    for doc in targets:
        source = DESCANT_SOURCE_RE.match(doc["source"])
        if source:
            # Shared actions have one revision authority. An unavailable Worker
            # cannot be replaced by an independent local CAS or an enabled UI.
            if remote_map is None or not SHARE.get("url") or not SHARE.get("ready"):
                projected = comment_action_projection(path, doc["thread"], events=events)
                projected["statusActions"]["canResolve"] = False
                threads.append(projected)
                continue
            projected = remote_map.get(source.group(1))
            if not projected: raise ValueError("the shared comment state could not be confirmed")
            projected = dict(projected)
            projected["id"] = doc["thread"]["id"]
            threads.append(projected)
            authority = "descant"
        else:
            threads.append(comment_action_projection(path, doc["thread"], who, events=events))
    if authority == "descant" and shared_actions and isinstance(shared_actions.get("receipts"), list):
        for receipt in shared_actions["receipts"]:
            request = dict(receipt.get("request") or {})
            if request.get("threadId") in private_ids:
                request["threadId"] = private_ids[request["threadId"]]
                receipts.append(dict(receipt, request=request))
    for event in events:
        if event["actorKey"] != "founder:" + who: continue
        authority_of_event = event.get("authority")
        request = dict(event["request"])
        if authority_of_event == "descant":
            local_id = private_ids.get(str(event["threadId"]))
            if not local_id or event.get("localThreadId") != local_id: continue
            request["threadId"] = local_id
        elif authority_of_event != "git": continue
        receipts.append({"opId": request["opId"], "request": request, "resultRev": event["resultRev"], "authority": authority_of_event, "gitDurable": True})
    return {"threads": threads, "commentActions": {"version": 1, "authority": authority,
        "actor": {"kind": "founder-capability", "id": who}, "accessEpoch": "founder", "reactionKeys": list(COMMENT_REACTIONS), "receipts": list({r["opId"]:r for r in receipts}.values())}}


def preserve_action_managed(path, previous, submitted, who=None, events=None):
    """An old complete-list request cannot write over versioned action state."""
    projected = comment_action_projection(path, previous, events=events)
    submitted = json.loads(json.dumps(submitted))
    if submitted.get("author") != previous["author"] or submitted.get("by") != previous["by"]:
        raise CommentRefused(409, "immutable-author", "A saved message keeps its original author.")
    if submitted.get("text") not in (previous["text"], projected["text"]):
        raise CommentRefused(409, "action-required", "Use the versioned comment action to edit saved words.")
    # Even an exact old original is never a rewrite of the current projection.
    submitted["text"] = previous["text"]
    if bool(submitted.get("done")) != projected["done"] or comment_status(submitted) != projected["status"]:
        raise CommentRefused(409, "action-required", "Use the versioned comment action to change saved status.")
    submitted["done"], submitted["status"] = previous["done"], previous["status"]
    by_id = {r.get("id"): r for r in projected["replies"] if r.get("id")}
    raw = {r.get("id"): r for r in previous["replies"] if r.get("id")}
    for message in submitted.get("replies") or []:
        saved = by_id.get(message.get("id"))
        if saved:
            original = raw[message["id"]]
            # A selected founder's create always stamps the configured author.
            # Retrying the original composer alias must acknowledge that stamp.
            if original.get("writer") == "founder:" + str(who) and message.get("by") == "human":
                message["author"] = original["author"]
            if message.get("text") not in (original["text"], saved["text"]):
                if original.get("by") == "agent":
                    raise CommentRefused(422, "agent-attribution-required", "Generated words require an attributed agent commit.")
                raise CommentRefused(409, "action-required", "Use the versioned action to edit saved replies.")
            message["text"] = original["text"]
    return submitted

def descant_action_store(events):
    stored = []
    known = descant_known_ids()
    with COMMENTS_LOCK:
        for event in events:
            # Legacy service events may precede request validation. Retain them
            # unacknowledged there, without blocking later importable events.
            if not isinstance(event, dict) or not valid_comment_action_json(event): continue
            path = article_path(event.get("path"))
            if not path or not (REPO_ROOT / path).is_file() or not re.fullmatch(r"a[0-9a-f]{32}", str(event.get("id") or "")): continue
            original_file = next((t for t in comment_files(piece_folder(path) / "review")
                if comment_document(t)["source"] == "descant:" + str(event.get("threadId"))), None)
            if not original_file: continue  # Original message import must land first.
            original = git_blob(original_file.relative_to(REPO_ROOT).as_posix())
            if original.returncode: continue
            document = comment_document(None, original.stdout.decode("utf-8"))
            if document["source"] != "descant:" + str(event.get("threadId")): continue
            event = dict(event, localThreadId=document["thread"]["id"], authority="descant")
            target_message = event.get("target")
            if target_message:
                messages = [document["thread"]] + document["thread"]["replies"]
                selected_index = next((i for i,m in enumerate(messages) if m.get("messageRef") == target_message["messageRef"]), None)
                if selected_index is None and target_message["messageRef"] in known:
                    if target_message["kind"] == "thread": selected_index = 0
                    else:
                        matches = [i for i,m in enumerate(messages[1:], 1) if all(m.get(k) == target_message.get(k) for k in ("text", "author", "by", "created"))]
                        identities = target_message.get("matchingIds") or []
                        if len(matches) == len(identities) and set(identities).issubset(known): selected_index = matches[identities.index(target_message["messageRef"])]
                if selected_index is None: continue  # No acknowledgement of an unimported or ambiguous target.
                index, selected = selected_index, messages[selected_index]
                ref = selected.get("messageRef") or ("local-root:" + document["thread"]["id"] if index == 0 else "local-reply:" + str(selected.get("id") or index))
                if event["slot"].startswith("message:"): event["localSlot"] = "message:" + ref
                elif event["slot"].startswith("reaction:"): event["localSlot"] = "reaction:" + ref + event["slot"][len("reaction:" + target_message["messageRef"]):]
            target = piece_folder(path) / "review/actions" / (event["id"] + ".md")
            data = comment_action_bytes(event)
            # Exact event ID is the import receipt. A previously committed event
            # is not rewritten merely because its service ack was dropped.
            if target.exists():
                try: existing = json.loads(target.read_text().split("```json\n", 1)[1].rsplit("\n```", 1)[0])
                except (ValueError, IndexError, UnicodeError): continue
                if not isinstance(existing, dict) or not valid_comment_action_json(existing): continue
                # JSON types are part of the receipt: Python equates True with
                # 1 and False with 0. Ignore only the service's durability bit.
                if comment_action_bytes({k:v for k,v in existing.items() if k != "gitDurable"}) == comment_action_bytes({k:v for k,v in event.items() if k != "gitDurable"}):
                    data = comment_action_bytes(existing)
                    if target.read_bytes() != data: continue
                    if comment_action_committed(path, existing):
                        stored.append(event["id"])
                        continue
                else: continue
            owner = share_owner((REPO_ROOT / path).read_text("utf-8")) or default_owner()
            actor = event["actorKey"]
            principal = actor[8:] if actor.startswith("founder:") else owner
            if actor.startswith("reader:"):
                identity = descant_reader({"author": event.get("actor")})
                if not identity: continue
                people = writing_session([{"name":identity[0],"email":identity[1]}, principal])
            else:
                people = writing_session(principal)
            try:
                commit_comment_action(target, data, "Keep a shared comment action", people=people,
                    trailers="Principal: %s\nActor: human\nBasis: review\nComment-Actor: %s\nComment-Action: %s" % (principal, actor, event["id"]))
                stored.append(event["id"])
            except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                print("  descant: a comment action waits for Git: " + str(error)[-400:])
                continue
    return stored


def listed_article_folders():
    """Every articles/<folder>/ holding article.md, sorted by name, except the test fixture.

    INDEX.md documents the articles; the files themselves decide what is listed."""
    try:
        folders = sorted(d for d in (REPO_ROOT / "articles").iterdir()
                         if d.is_dir() and (d / "article.md").is_file()
                         and d.relative_to(REPO_ROOT).as_posix() + "/" != SHARE_TEST_PIECE)
    except OSError:
        return []
    return folders


def article_title(value):
    """A typed title on one line with typographic quotes, or '' when it holds control characters."""
    text = str(value if value is not None else "")
    if re.search(r"[\x00-\x1f\x7f]", text):
        return ""
    text = " ".join(text.split()).replace("'", "\u2019")
    return re.sub(r'"', lambda m: "\u201c" if m.start() == 0 or text[m.start() - 1] in " ([{\u2014" else "\u201d", text)


def new_article(title, who, today):
    """(folder name, article.md text) for a founder's new article, or ValueError.

    The number follows the highest real article (90 and above are practice and test
    pieces); the slug comes from the title, with a suffix when one is taken."""
    title = article_title(title)
    if not title or len(title) > 120:
        raise ValueError("an article title is 1 to 120 characters on one line")
    owner = str(who or "").strip().lower()
    if owner not in FOUNDERS:
        raise ValueError("a writer is " + WRITERS_SAID)
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_title).strip("-")[:50].strip("-") or "untitled"
    folders = []
    try:
        folders = [d.name for d in (REPO_ROOT / "articles").iterdir() if d.is_dir()]
    except OSError:
        pass
    numbers = [int(m.group(1)) for m in (re.match(r"^(\d{2})-", name) for name in folders) if m and int(m.group(1)) < 90]
    number = max(numbers, default=0) + 1
    if number >= 90:
        raise ValueError("there is no free article number below 90")
    taken = {re.sub(r"^\d{2}-", "", name) for name in folders}
    slug, n = base, 2
    while slug in taken:
        slug, n = "%s-%d" % (base, n), n + 1
    # Single-quoted YAML takes every character literally, and the title holds no straight quote
    # (article_title made them typographic), so every reader shows exactly these words.
    quoted = "'" + title + "'"
    text = ("---\ntitle: %s\nslug: %s\norder: %d\nstatus: candidate\nphase: draft\nowner: %s\n"
            "language: en\ndate: %s\npublished: false\n---\n\n# %s\n") % (quoted, slug, number, owner, today, title)
    return "%02d-%s" % (number, slug), text


# The search box (GET /api/search): a query of 2 to 100 characters, matched without regard
# to case, at most 50 hits. Titles come first; the text and the comments share what is
# left, one of each in turn, so a common word in the text never crowds out every comment.
SEARCH_MIN = 2
SEARCH_MAX = 100
SEARCH_HITS = 50


# The Markdown a reader never sees, taken out of a snippet: at a line's start the quote
# marks, a heading's hashes, a list's bullet or number, a task box, a callout's tag and a
# footnote's own label; anywhere, footnote references, emphasis and code marks, the %%
# around a writer's note, and a link's address and brackets (its words stay).
SNIPPET_LEAD_RE = re.compile(r"^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)?"
                             r"(?:\[[ xX]\][ \t]+)?(?:\[![A-Za-z]+\][+-]?[ \t]*)?(?:\[\^[^\]]+\]:[ \t]*)?")
SNIPPET_WIKI_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]")
SNIPPET_LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
SNIPPET_DROP_RE = re.compile(r"\[\^[^\]]+\]|\*{1,3}|~~|==|%%|`+"
                             r"|(?<![A-Za-z0-9])_{1,3}(?=\S)|(?<=\S)_{1,3}(?![A-Za-z0-9])")


def plain_line(line):
    """One Markdown line as a reader sees it: the Markdown taken out, spaces run together."""
    keep = [True] * len(line)

    def drop(a, b):
        for i in range(a, b):
            keep[i] = False

    lead = SNIPPET_LEAD_RE.match(line)
    if lead:
        drop(0, lead.end())
    for found in list(SNIPPET_WIKI_RE.finditer(line)) + list(SNIPPET_LINK_RE.finditer(line)):
        drop(found.start(), found.start(1))
        drop(found.end(1), found.end())
    for found in SNIPPET_DROP_RE.finditer(line):
        drop(found.start(), found.end())
    return " ".join("".join(c for i, c in enumerate(line) if keep[i]).split())


def utf16(text):
    """A string's length as the page counts it (JavaScript strings are UTF-16)."""
    return len(text.encode("utf-16-le")) // 2


def search_snippet(line, needle):
    """Where one line's words hold `needle` (lower case): (snippet, [start, end]), the words
    around the match with an ellipsis where the line goes on and the match's place in them,
    counted as the page counts. The words are the line's as a reader sees them, so a search
    finds "jagged frontier" in "*jagged frontier*" and a snippet never shows the Markdown.
    None when they do not hold it."""
    plain = plain_line(line)
    at = plain.lower().find(needle)
    if at < 0:
        return None
    first, last = at, at + len(needle)
    start = max(0, first - 40)
    end = min(len(plain), last + 80)
    if 0 < start < len(plain) and plain[start] == " ":
        start += 1
    if start < end < len(plain) and plain[end - 1] == " ":
        end -= 1
    lead = "…" if start > 0 else ""
    snippet = lead + plain[start:end] + ("…" if end < len(plain) else "")
    a = len(lead) + first - start
    return snippet, [utf16(snippet[:a]), utf16(snippet[:a + last - first])]


def frontmatter_end(lines):
    """The index of the line closing the frontmatter, or -1 when there is none."""
    if not lines or lines[0] != "---":
        return -1
    try:
        return lines.index("---", 1)
    except ValueError:
        return -1


def search_article(path, folder, title, markdown, needle):
    """(title hits, text hits, comment hits) for one article; `needle` is lower case."""
    titles, texts, comments = [], [], []
    lines = markdown.splitlines()
    end = frontmatter_end(lines)
    if needle in title.lower():
        line = next((n + 1 for n, text in enumerate(lines[:end + 1]) if text.startswith("title:")), 1)
        at = title.lower().find(needle)
        titles.append({"path": path, "title": title, "kind": "title", "snippet": title, "line": line,
                       "match": [utf16(title[:at]), utf16(title[:at + len(needle)])]})
    for n, text in enumerate(lines):
        if n <= end:
            continue
        found = search_snippet(text, needle)
        if found:
            texts.append({"path": path, "title": title, "kind": "text",
                          "snippet": found[0], "match": found[1], "line": n + 1})
    review = folder / "review"
    targets = comment_files(review)
    for target in targets:
        try:
            raw = target.read_text("utf-8")
            thread = comment_document(target, raw)["thread"]
        except (OSError, UnicodeError, ValueError):
            continue
        rows = raw.splitlines()
        author = None
        for n in range(frontmatter_end(rows) + 1, len(rows)):
            text = rows[n]
            opened = MESSAGE_RE.match(text)
            if opened:
                author = opened.group(1)
                continue
            plain = text.strip()
            # Only what people wrote: never the heading, the quoted passage before the
            # first message, a separator, or the app's re-anchoring note.
            if author is None or not plain or plain == "---" or (
                    plain.startswith("_Re-anchored ") and plain.endswith("_")):
                continue
            found = search_snippet(text, needle)
            if found:
                comments.append({"path": path, "title": title, "kind": "comment",
                                 "snippet": found[0], "match": found[1], "line": n + 1,
                                 "file": target.relative_to(REPO_ROOT).as_posix(),
                                 "thread": thread["id"], "author": author,
                                 "quote": thread["anchor"]["quote"]})
    return titles, texts, comments


def comment_slug(text):
    words = re.findall(r"[a-z0-9]+", str(text or "").lower())[:7]
    return "-".join(words) or "comment"


def comment_status(thread, previous=None):
    done = bool(thread.get("done"))
    raw = str(thread.get("status") or "").strip().lower()
    if done and raw == "open":
        return "answered"
    if not done:
        return "open"
    if raw:
        return raw
    if previous and previous.get("status") and previous.get("status") != "open":
        return previous["status"]
    return "answered"


def reply_identity(reply):
    value = reply.get("id")
    if value is None:
        return {}
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise ValueError("a reply id must be 1 to 80 letters, numbers, underscores or hyphens")
    return {"id": value}


def same_reply(a, b):
    if a.get("id") and b.get("id"):
        return a["id"] == b["id"]
    return all(a.get(key) == b.get(key) for key in ("author", "created", "text"))


def comment_display_fields(message):
    """Optional recorded provenance and chosen colour, never inferred from a legacy name."""
    fields = {}
    principal = message.get("principal")
    model = message.get("model")
    color = message.get("color")
    if principal in FOUNDERS:
        fields["principal"] = principal
    if isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9._:/+-]{1,80}", model):
        fields["model"] = model
    if isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        fields["color"] = color
    return fields


def canonical_comment(thread, identifier, previous=None):
    """Server-side equivalent of comments.js normalise(), without random defaults."""
    if not isinstance(thread, dict):
        raise ValueError("each thread must be an object")
    anchor = thread.get("anchor") if isinstance(thread.get("anchor"), dict) else {}
    replies = []
    reply_ids = set()
    for reply in thread.get("replies") or []:
        if not isinstance(reply, dict):
            raise ValueError("each reply must be an object")
        identity = reply_identity(reply)
        if identity:
            if identity["id"] in reply_ids:
                raise ValueError("a reply id can appear only once in a thread")
            reply_ids.add(identity["id"])
        replies.append({
            **identity,
            **comment_display_fields(reply),
            **({key: reply[key] for key in ("messageRef", "writer") if isinstance(reply.get(key), str)}),
            "author": str(reply.get("author") or "You"),
            "text": str(reply.get("text") or ""),
            "created": str(reply.get("created") or ""),
            "by": "agent" if reply.get("by") == "agent" else (
                "human" if reply.get("by") == "human" else ""),
            "basis": str(reply.get("basis") or ""),
            "offer": reply.get("offer") if reply.get("offer") is not None else None,
        })
    status = comment_status(thread, previous)
    client_id = (previous or {}).get("clientId") or thread.get("clientId")
    if not client_id and str(thread.get("id") or "") and not str(thread["id"]).isdigit():
        client_id = thread["id"]
    if client_id is not None and (not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", client_id)):
        raise ValueError("a comment client id must be 1 to 80 letters, numbers, underscores or hyphens")
    return {
        **({"clientId": client_id} if client_id else {}),
        **comment_display_fields(previous or thread),
        **({key: (previous or thread)[key] for key in ("messageRef", "writer") if isinstance((previous or thread).get(key), str)}),
        "id": str(identifier),
        "anchor": {
            "quote": str(anchor.get("quote") or ""),
            "prefix": str(anchor.get("prefix") or ""),
            "suffix": str(anchor.get("suffix") or ""),
            "blockText": str(anchor.get("blockText") or ""),
            "version": str(anchor.get("version") or ""),
            **({"chosenPlace": comment_place(anchor.get("chosenPlace"))} if comment_place(anchor.get("chosenPlace")) else {}),
        },
        "author": str(thread.get("author") or "You"),
        "by": "agent" if thread.get("by") == "agent" else (
            "human" if thread.get("by") == "human" else ""),
        "text": str(thread.get("text") or ""),
        "created": str(thread.get("created") or datetime.datetime.now(datetime.timezone.utc).isoformat()),
        "replies": replies,
        "done": status != "open",
        "status": status,
        "note": str(thread.get("note") or ""),
        "reanchoredFrom": str(thread.get("reanchoredFrom") or ""),
        "refersTo": str(thread.get("refersTo") or ""),
    }


def comment_place(value):
    """An explicit choice bound to the text at one position, or None."""
    if not isinstance(value, dict) or not isinstance(value.get("blockId"), str) or \
            not isinstance(value.get("blockText"), str):
        return None
    start, end = value.get("start"), value.get("end")
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= utf16(value["blockText"]):
        return None
    return {"blockId": value["blockId"], "blockText": value["blockText"], "start": start, "end": end,
            **({"docHash": value["docHash"]} if type(value.get("docHash")) is int else {})}


def comment_quote(value):
    return json.dumps(str(value or ""), ensure_ascii=False)


def render_comment(document, thread):
    """Render the fixture grammar canonically; parsing it yields the same UI object."""
    anchor = thread["anchor"]
    lines = [
        "---", "thread: %s" % thread["id"], "slug: %s" % document["slug"],
        "status: %s" % thread["status"], "author: %s" % thread["author"],
        "by: %s" % (thread["by"] or "human"), "created: %s" % thread["created"],
        "source: %s" % document["source"],
        *([key + ": " + comment_quote(value) for key, value in comment_display_fields(thread).items()]),
        *(["message_ref: %s" % comment_quote(thread["messageRef"])] if thread.get("messageRef") else []),
        *(["writer: %s" % comment_quote(thread["writer"])] if thread.get("writer") else []),
        *(["client_id: %s" % comment_quote(thread["clientId"])] if thread.get("clientId") else []),
        "anchor:",
        "  quote: %s" % comment_quote(anchor.get("quote")),
        "  prefix: %s" % comment_quote(anchor.get("prefix")),
        "  suffix: %s" % comment_quote(anchor.get("suffix")),
        "  block: %s" % comment_quote(anchor.get("blockText")),
        "  version: %s" % comment_quote(anchor.get("version")),
    ]
    if anchor.get("chosenPlace"):
        lines.append("  chosen_place: %s" % comment_quote(json.dumps(anchor["chosenPlace"], ensure_ascii=False)))
    if thread.get("reanchoredFrom"):
        lines.append("  reanchored_from: %s" % comment_quote(thread["reanchoredFrom"]))
    if thread.get("refersTo"):
        lines.append("  refers_to: %s" % comment_quote(thread["refersTo"]))
    lines.extend(["---", "", "# %s. %s" % (thread["id"], document["slug"].replace("-", " "))])
    if document.get("preamble"):
        lines.extend(["", document["preamble"]])

    lines.extend(message_lines(thread, thread["created"], first=True))
    if thread.get("note"):
        lines.extend(["", "---", "", "_%s_" % thread["note"]])
    for reply in thread["replies"]:
        lines.extend(message_lines(reply, thread["created"]))
    return "\n".join(lines).rstrip() + "\n"


def message_lines(message, fallback_created, first=False):
    """One person's block in a review file: a blank line, the signature line, the text."""
    created = str(message.get("created") or fallback_created)
    if first:
        created = created[:10]
    qualifier = []
    if not first:
        qualifier.append(message.get("by") or "human")
        if message.get("id"):
            qualifier.append("reply:" + message["id"])
        if message.get("messageRef"):
            qualifier.append("message:" + message["messageRef"])
        if message.get("writer"):
            qualifier.append("writer:" + message["writer"])
        qualifier.extend(key + ":" + value for key, value in comment_display_fields(message).items())
        if message.get("basis"):
            qualifier.append(message["basis"])
    suffix = " (%s)" % ", ".join(qualifier) if qualifier else ""
    return ["", "**%s**, %s%s:" % (message["author"], created, suffix), "", message["text"]]


def protected_frontmatter(markdown):
    """All protected values, including duplicates, so no YAML trick hides a change."""
    values = {key: [] for key in ("owner", "phase", "published", "status")}
    lines = str(markdown or "").splitlines()
    if not lines or lines[0] != "---":
        return values
    for line in lines[1:]:
        if line == "---":
            break
        match = re.match(r"^(owner|phase|published|status):[ \t]*(.*?)[ \t]*$", line)
        if match:
            values[match.group(1)].append(match.group(2))
    return values


def agent_policy():
    """{file name: text} for each file the space's config.json lists under agentPolicy (paths
    relative to the space, inside it, Markdown only); {} when it lists none."""
    out = {}
    listed = space_config.value("agentPolicy") or []
    for rel in listed if isinstance(listed, list) else []:
        target = (REPO_ROOT / str(rel)).resolve()
        if target.suffix == ".md" and target.is_relative_to(REPO_ROOT.resolve()) and target.is_file():
            out[target.name] = target.read_text("utf-8")
    return out


def marker_lines(markdown):
    """Lines holding a writer's marker ([NAME: ...], space_config.marker_re()), with their
    counts, so duplicates are preserved as well as their exact bytes."""
    found = {}
    marker = space_config.marker_re(FOUNDERS)
    for line in str(markdown or "").splitlines(keepends=True):
        if marker.search(line):
            found[line] = found.get(line, 0) + 1
    return found


def founder_markers_survive(before, after):
    old, new = marker_lines(before), marker_lines(after)
    return all(new.get(line, 0) >= count for line, count in old.items())


def markdown_paragraphs(markdown):
    """Blank-line blocks after frontmatter: a mechanical unit, not a meaning guess."""
    text = str(markdown or "")
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            text = text[end + 5:]
    return [part.strip() for part in re.split(r"\n[ \t]*\n+", text) if part.strip()]


def paragraph_counts(before, after):
    old, new = markdown_paragraphs(before), markdown_paragraphs(after)
    changed = added = removed = 0
    for tag, a0, a1, b0, b1 in difflib.SequenceMatcher(None, old, new).get_opcodes():
        if tag == "insert":
            added += b1 - b0
        elif tag == "delete":
            removed += a1 - a0
        elif tag == "replace":
            paired = min(a1 - a0, b1 - b0)
            changed += paired
            removed += (a1 - a0) - paired
            added += (b1 - b0) - paired
    return changed, added, removed


def count_phrase(number, action):
    words = ("zero", "one", "two", "three", "four", "five", "six", "seven",
             "eight", "nine", "ten", "eleven", "twelve")
    amount = words[number] if number < len(words) else str(number)
    noun = "paragraph" if number == 1 else "paragraphs"
    return "%s %s %s" % (amount, noun, action)


def mechanical_subject(before, after):
    changed, added, removed = paragraph_counts(before, after)
    parts = []
    for number, action in ((changed, "changed"), (added, "added"), (removed, "removed")):
        if number:
            parts.append(count_phrase(number, action))
    if not parts:
        if before != after and FRONTMATTER_RE.sub("", before, count=1) == FRONTMATTER_RE.sub("", after, count=1):
            sub = lambda text: re.search(r"^subtitle:.*$", (FRONTMATTER_RE.match(text) or [""])[0], re.M)
            if (sub(before) and sub(before)[0]) != (sub(after) and sub(after)[0]):
                return "Subtitle set" if sub(after) else "Subtitle removed"
            return "Details changed"
        return "No paragraphs changed"
    sentence = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return sentence[0].upper() + sentence[1:]


def atomic_write(target, data):
    """Replace one file from its own directory, so a short write cannot truncate it."""
    handle = tempfile.NamedTemporaryFile("wb", dir=str(target.parent),
                                         prefix=".castor-write-", delete=False)
    temporary = Path(handle.name)
    try:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.chmod(temporary, target.stat().st_mode if target.exists() else 0o644)
        os.replace(temporary, target)
    finally:
        try:
            handle.close()
        except OSError:
            pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


# ------------------------------------------------------------ the agent's turn





def one_sentence(text, fallback, limit=160):
    """One line, cut at a word if it runs long: a commit subject is read, not parsed."""
    line = " ".join(str(text or "").split())
    if not line:
        return fallback
    if len(line) <= limit:
        return line
    cut = line[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return (cut or line[:limit].rstrip()) + "..."





















# --------------------------------------------------------------- reviewer mode
#
# An outside reviewer (a friend who asked to read an article) reaches the app through a
# public hostname behind Cloudflare Access. Access authenticates them by email and
# forwards the address in one header; a tunnel carries the request to a SECOND listener,
# bound to 127.0.0.1 only and served by ReviewerHandler. The founders' listeners never
# read that header, so nothing a reviewer sends can make them a founder.
#
# The access list lives OUTSIDE the repository, because it holds outsiders' addresses
# and the repository is pushed on every save:
#   {"reviewers": {"ada@example.com": {"name": "Ada", "invited_by": "<writer key>",
#                                      "pieces": ["articles/01-why-castor/article.md"]}}}
# It is read again on every request, so removing someone takes effect at once.

REVIEWERS_DEFAULT = "~/.config/descant/reviewers.json"     # the space's config.json may name another
REVIEWER_HEADER = "Cf-Access-Authenticated-User-Email"
EMAIL_RE = re.compile(r"^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$")
# The name is written as the author inside the review file's own grammar and into a git
# author line, so it holds letters, digits, spaces, dots, apostrophes and hyphens, and
# nothing that either grammar gives a meaning to (`*`, `<`, `:`, a newline).
REVIEWER_NAME_RE = re.compile(r"^[^\W\d_](?:[\w .'-]{0,38}[\w.])?$")
PRINCIPALS = FOUNDERS + ("both",)           # the writer answerable for a reviewer
SAMPLE_PAGE = APP_DIR / "typewell" / "sample.html"
# The only static files a reviewer gets beside the review page. None carries writing.
REVIEWER_FILES = ("favicon.ico", "favicon.svg", "manifest.webmanifest", "sw.js",
                  "icon-180.png", "icon-192.png", "icon-512.png")
REVIEWER_FOLDERS = {"icons": (".png", ".svg", ".ico"), "fonts": (".woff2", ".woff")}
ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$")
REVIEW_TEXT_MAX = 8000                      # characters in one comment or reply
REVIEW_ANCHOR_MAX = 20000                   # characters in one anchor field (a paragraph)
REVIEW_FRESH_MAX = 10                       # new comments plus replies in one save
# Every character str.splitlines() ends a line on, apart from \n, plus the other C0
# controls. The review-file parser splits with splitlines(), so one of these inside a
# reviewer's text would start a line the reviewer never typed: a forged signature.
UNSAFE_CHARS_RE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x85  ]")


class CommentRefused(Exception):
    """A comment save refused before anything was written."""

    def __init__(self, code, reason, error):
        super().__init__(error)
        self.code = code
        self.payload = {"ok": False, "reason": reason, "error": error}


def founder_names():
    """Names a reviewer may not carry, so no reviewer's words can pass as a founder's."""
    names = set(PRINCIPALS)
    for key, identity in AUTHORS.items():
        full = identity.split("<", 1)[0].strip().lower()
        names.update([key.lower(), full, full.split(" ", 1)[0]])
    return names


def reviewer_entry(entry):
    """One reviewer's record, or None if any part of it is not what it must be."""
    if not isinstance(entry, dict):
        return None
    name = entry.get("name").strip() if isinstance(entry.get("name"), str) else ""
    if not REVIEWER_NAME_RE.match(name) or name.lower() in founder_names():
        return None
    if entry.get("invited_by") not in PRINCIPALS or not isinstance(entry.get("pieces"), list):
        return None
    allowed = []
    for piece in entry["pieces"]:
        path = article_path(piece) if isinstance(piece, str) else None
        if path and path not in allowed:        # anything that is not an article grants nothing
            allowed.append(path)
    return {"name": name, "invited_by": entry["invited_by"], "pieces": allowed}


def reviewers_file():
    return Path(os.environ.get("CASTOR_REVIEWERS") or space_config.value("reviewersFile") or REVIEWERS_DEFAULT).expanduser()


def _unique_keys(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("a key appears twice")
    return dict(pairs)


def load_reviewers():
    """email -> reviewer (None for a refused record), or None when nobody may enter.

    Fails closed on everything: a missing, unreadable or unparsable file, a repeated key,
    the wrong shape, and a file inside the repository, which would leave with a push."""
    try:
        source = reviewers_file().resolve()
        if source == REPO_ROOT or REPO_ROOT in source.parents:
            return None
        data = json.loads(source.read_text("utf-8"), object_pairs_hook=_unique_keys)
    except (OSError, ValueError, RuntimeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("reviewers"), dict):
        return None
    table = {}
    for email, entry in data["reviewers"].items():
        key = str(email).strip().lower()
        # Two spellings of one address leave it unclear which record applies: neither.
        table[key] = None if key in table else reviewer_entry(entry)
    return table


def reviewer_string(value, limit, what):
    """A string a reviewer sent, refused if it could break the review file's lines."""
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if UNSAFE_CHARS_RE.search(text):
        raise CommentRefused(400, "unsafe-text", "%s contains a control character" % what)
    if len(text) > limit:
        raise CommentRefused(413, "too-long", "%s is longer than %d characters" % (what, limit))
    return text


def reviewer_message(value):
    """A comment or reply as the reviewer typed it, tidied the way the gate wants it.

    Refused if a line would read, once stored, as the start of someone else's message
    or as a note about the thread: the file's grammar is line-based, so that line would
    put words in a founder's mouth."""
    text = reviewer_string(value, REVIEW_TEXT_MAX, "the comment")
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip()
    if not text:
        raise CommentRefused(400, "empty", "the comment is empty")
    for line in text.split("\n"):
        if MESSAGE_RE.match(line.strip()) or line.strip().startswith("_Re-anchored "):
            raise CommentRefused(400, "unsafe-text",
                                 "a line of the comment reads like the start of someone's "
                                 "message; reword that line")
    return text


def reviewer_asset(route):
    """The file behind one of the few static routes a reviewer may load, or None."""
    parts = route.lstrip("/").split("/")
    if len(parts) == 1 and parts[0] in REVIEWER_FILES:
        folder = APP_DIR
    elif len(parts) == 2 and parts[0] in REVIEWER_FOLDERS and ASSET_NAME_RE.match(parts[1]) \
            and parts[1].lower().endswith(REVIEWER_FOLDERS[parts[0]]):
        folder = APP_DIR / parts[0]
    else:
        return None
    try:
        target = (folder / parts[-1]).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return str(target) if target.is_file() and target.parent == folder.resolve() else None


def file_errors(method):
    """Return a refused save to the browser rather than dropping the connection."""
    def guarded(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            return self.reply(422, {"saved": False, "error": str(error)[:800]})
    return guarded


class Handler(SimpleHTTPRequestHandler):
    server_version = "CastorDesign/1"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".canvas": "application/json",
        ".md": "text/markdown; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    # ---------------------------------------------------------------- plumbing

    def log_message(self, fmt, *args):          # one compact line, never a body
        print("  %s %s" % (self.command or "-", (self.path or "-").split("?")[0]))

    def end_headers(self):
        path = urlparse(self.path or "").path
        if not self._cached_headers_sent and (path.endswith(NO_STORE) or path.endswith("/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    _cached_headers_sent = False

    def static_hit(self, target=None):
        """Serve one file compressed, and answer an unchanged one with 304.

        Returns True when it handled the request. Anything it does not recognise
        falls through to SimpleHTTPRequestHandler untouched. `target` names the file
        outright instead of translating the request path (the reviewer listener).
        """
        route = urlparse(self.path or "").path
        target = target or self.translate_path(self.path)
        if os.path.isdir(target):
            if not route.endswith("/"):
                return False                # let the base class do the redirect
            target = os.path.join(target, "index.html")
        try:
            st = os.stat(target)
        except OSError:
            return False
        if not os.path.isfile(target):
            return False

        key = (target, int(st.st_mtime), st.st_size)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        self._cached_headers_sent = True
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return True

        ctype = self.guess_type(target)
        # Whether to compress is the CLIENT's answer, never the cache's. Reading the
        # cache first served gzipped bytes to a caller that had asked for identity --
        # with the right header on them, so only a client that genuinely cannot
        # decompress would have found out, which is the worst way to find out.
        encoding = None
        wants = "gzip" in (self.headers.get("Accept-Encoding") or "")
        if wants and st.st_size >= GZIP_FLOOR and ctype.startswith(COMPRESSIBLE):
            body = _GZIP_CACHE.get(key)
            if body is None:
                with open(target, "rb") as fh:
                    body = gzip.compress(fh.read(), 6)
                if len(_GZIP_CACHE) >= _GZIP_CACHE_MAX:
                    _GZIP_CACHE.clear()     # a build replaces every world at once
                _GZIP_CACHE[key] = body
            encoding = "gzip"
        else:
            with open(target, "rb") as fh:
                body = fh.read()

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    def reply(self, code, payload, content_type="application/json; charset=utf-8", headers=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        # A piece with its twelve versions is ~200 KB of JSON, read over the tailnet on
        # every open; gzip takes it to a fraction, the same way the static pages go.
        gzipped = len(body) > 1024 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gzipped:
            body = gzip.compress(body, 6)
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def query(self):
        return parse_qs(urlparse(self.path or "").query, keep_blank_values=True)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length)

    # ----------------------------------------------------- who is asking (hooks)
    #
    # The founders' answers, unchanged. ReviewerHandler overrides these and nothing in
    # the routes below them, so a reviewer's read or comment runs the same code as a
    # founder's with a narrower identity, never a copy of it that could drift.

    def may_read(self, path):
        """Whether this caller may read (and comment on) the piece at `path`."""
        return True

    def piece_locked(self, path):
        return path in LOCKED_PIECES

    def live_files(self, piece_name):
        """The piece's Files sandbox, listed live (initialising it on first use)."""
        with FILES_LOCK:
            return sandbox_files(piece_name)

    def comment_identity(self, body):
        """Who a comment save is recorded as: (identity, None), or (None, (code, payload))."""
        who = str(body.get("who") or "").strip().lower()
        if who not in FOUNDERS:
            return None, (400, {"ok": False, "reason": "invalid-who",
                                "error": "who must be one of the writers in people.json"})
        return {"author": author_args(who), "subject": "Comments on %s",
                "trailers": "Principal: %s\nActor: human\nBasis: instruction" % who,
                "source": "castor-writing-app"}, None

    def comment_base(self, submitted, identifier, previous=None):
        """The submitted thread in canonical form; raises CommentRefused."""
        try:
            return canonical_comment(submitted, identifier, previous)
        except ValueError as error:
            raise CommentRefused(400, "bad-request", str(error))

    def comment_thread(self, submitted, identifier, previous=None):
        """The thread to store for one submitted thread; raises CommentRefused.

        A founder's save carries only typed words: a message marked as generated
        needs an attributed agent commit, never this endpoint's human one."""
        thread = self.comment_base(submitted, identifier, previous)
        messages = [thread] + thread["replies"]
        for index, message in enumerate(messages):
            old = (previous if index == 0 else next((reply for reply in previous["replies"] if same_reply(reply, message)), None)) if previous else None
            if (message.get("by") == "agent" or (old and old.get("by") == "agent")) and \
                    (not old or any(message.get(key) != old.get(key) for key in ("text", "author", "by"))):
                raise CommentRefused(422, "agent-attribution-required",
                                     "generated words require an attributed agent commit")
        selected = getattr(self, "_comment_actor", None)
        if selected in FOUNDERS:
            if previous is None and thread["by"] == "human":
                thread["author"] = AUTHORS.get(selected, selected).split("<", 1)[0].strip()
                thread["writer"] = "founder:" + selected
                thread["messageRef"] = "froot:" + (thread.get("clientId") or str(identifier))
            fresh_count = 0
            for message in thread["replies"]:
                old = next((r for r in (previous or {}).get("replies", []) if same_reply(r, message)), None)
                if old is None and not message.get("id"):
                    old = next((r for r in (previous or {}).get("replies", []) if not r.get("id") and r.get("writer") == "founder:" + selected and message.get("by") == "human" and
                                all(r.get(k) == message.get(k) for k in ("created", "text"))), None)
                if old:
                    if old.get("writer") == "founder:" + selected and message.get("by") == "human": message["author"] = old["author"]
                    for field in ("messageRef", "writer"):
                        if field in old: message[field] = old[field]
                        else: message.pop(field, None)
                elif message["by"] == "human":
                    message["author"] = AUTHORS.get(selected, selected).split("<", 1)[0].strip()
                    message["writer"] = "founder:" + selected
                    message["messageRef"] = "freply:" + (message.get("id") or str(identifier) + ":" + str(len((previous or {}).get("replies", [])) + fresh_count))
                    fresh_count += 1
        if previous:
            # A stale founder tab appends its replies to the current saved thread.
            replies = list(previous.get("replies") or [])
            for reply in thread["replies"]:
                match = next((old for old in replies if same_reply(old, reply)), None)
                if match and any(match.get(key) != reply.get(key) for key in ("text", "author", "by")):
                    raise CommentRefused(409, "reply-conflict", "A reply identity already holds different words or an author.")
                if match is None:
                    replies.append(reply)
            thread["replies"] = replies
        return thread

    def comment_render(self, document, thread, before=None):
        """The bytes the thread's file will hold. `before` is its current content, if any."""
        return render_comment(document, thread).encode("utf-8")

    # ------------------------------------------------------------------ routes

    def do_GET(self):
        route = urlparse(self.path or "").path
        if route.startswith("/api/"):
            sync_pull()
        if route == "/api/sync":
            return self.reply(200, {"on": SYNC["on"], "error": SYNC["last_error"],
                                    "pending": bool(SYNC["push_pending"])})
        if route == "/api/save-status":
            named = (self.query().get("path") or [""])[0]
            path = article_path(named) or draft_path(named)
            if not path or not self.may_read(path):
                return self.reply(403, {"error": "that article is not readable here"})
            sha = (self.query().get("sha") or [""])[0]
            return self.reply(200, save_evidence(path, sha))
        if route == "/api/publication":
            return self.api_publication()
        if route.startswith("/publication/"):
            return self.publication_preview()
        if route == "/api/whoami":
            return self.reply(200, {"role": "founder"})
        if route == "/api/drafts":
            return self.api_drafts_get()
        if route == "/api/piece":
            return self.api_piece()
        if route == "/api/piece/live":
            return self.api_piece_live()
        if route == "/api/site-tags":
            return self.api_site_tags()
        if route == "/api/pieces":
            return self.api_pieces()
        if route == "/api/search":
            return self.api_search()
        if route == "/api/graph":
            return self.api_graph()
        if route == "/api/agent/context":
            return self.api_agent_get()
        if route == "/api/agent/policy":
            return self.reply(200, agent_policy())
        if route == "/api/mentions":
            return self.api_mentions()
        if route == "/api/comments":
            return self.api_comments()
        if route == "/api/canvas":
            return self.api_canvas_get()
        if route == "/api/files/content":
            return self.api_files_content()
        if route in ("/", "/index.html"):
            # A plain entry lets the account-scoped browser resume choose the article.
            # An explicit article query remains authoritative.
            query = urlparse(self.path).query
            self.send_response(302)
            self.send_header("Location", "/typewell/" + ("?" + query if query else ""))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        self._cached_headers_sent = False
        if self.static_hit():
            return None
        self._cached_headers_sent = False
        return super().do_GET()

    def api_site_tags(self):
        if getattr(self, "reviewer", None):
            return self.reply(403, {"error": "Only founders can read site tags."})
        site = (self.query().get("site") or [""])[0]
        if not space_config.site(site):
            return self.reply(400, {"error": sites_refusal()})
        return self.reply(200, site_tags(site))

    def cross_site_refused(self):
        """True after refusing a write that a page on another site could send (a form or a no-cors post)."""
        kind = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if kind != "application/json":
            self.reply(415, {"ok": False, "reason": "json-only"})
            return True
        origin = self.headers.get("Origin")
        if ((self.headers.get("Sec-Fetch-Site") or "same-origin").lower() not in ("same-origin", "none")
                or (origin and urlparse(origin).netloc.lower() != (self.headers.get("Host") or "").lower())):
            self.reply(403, {"ok": False, "reason": "cross-site"})
            return True
        return False

    def do_POST(self):
        route = urlparse(self.path or "").path
        if route in ("/api/piece", "/api/comments", "/api/comments/action", "/api/drafts", "/api/agent/comment", "/api/agent/batch", "/api/mentions/read", "/api/pieces/new") or route.startswith("/api/files/"):
            sync_pull(force=True)
        if route == "/api/publication/publish":
            return self.api_publication_publish()
        if route == "/api/publication/prepare":
            return self.api_publication_prepare()
        if route == "/api/publication/approve":
            return self.api_publication_approve()
        if route == "/api/drafts":
            return self.api_drafts_write()
        if route == "/api/piece":
            return self.api_piece_write()
        if route == "/api/agent/comment":
            return self.api_agent_write()
        if route == "/api/agent/batch":
            return self.api_agent_batch()
        if route == "/api/mentions/read":
            return self.api_mentions_read()
        if route == "/api/comments/action":
            if self.cross_site_refused(): return None
            return self.api_comment_action()
        if route == "/api/comments":
            return self.api_comments_write()
        if route == "/api/review":
            return self.api_review()
        if route == "/api/review/asset":
            return self.api_review_asset()
        if route == "/api/pieces/new":
            if self.cross_site_refused(): return None
            return self.api_pieces_new()
        if route == "/api/files/mkdir":
            return self.api_files_mkdir()
        if route == "/api/files/upload":
            return self.api_files_upload()
        if route == "/api/files/move":
            return self.api_files_move()
        if route == "/api/files/order":
            return self.api_files_order()
        if route == "/api/share/article":
            return self.api_share_article()
        if route == "/api/share/admin-link":
            return self.api_share_admin_link()
        return self.reply(404, {"error": "no such route"})

    def do_PUT(self):
        sync_pull(force=True)
        if urlparse(self.path or "").path == "/api/canvas":
            return self.api_canvas_put()
        return self.reply(404, {"error": "no such route"})



    def publication_service(self):
        source = os.environ.get("CASTOR_PUBLICATION_CONFIG")
        config = {}
        if source:
            try:
                config = json.loads(Path(source).read_text("utf-8"))
                if not isinstance(config, dict): raise ValueError()
            except (OSError, ValueError):
                raise publication.Refused("The publication configuration is unreadable.", 503)
        return publication.Publication(REPO_ROOT, config, AUTHORS, sync_push if SYNC['on'] else None, WRITE_LOCK)

    def api_publication(self):
        path = article_path((self.query().get("path") or [""])[0])
        if not path: return self.reply(400, {"error": "Open an article first."})
        try:
            return self.reply(200, self.publication_service().status(path))
        except publication.Refused as error:
            return self.reply(error.code, {"ok": False, "error": str(error)})

    def publication_body(self):
        if (self.headers.get("Content-Type") or "").split(";", 1)[0] != "application/json":
            raise publication.Refused("Publication actions use JSON.", 415)
        if (self.headers.get("Sec-Fetch-Site") or "same-origin") not in ("same-origin", "none"):
            raise publication.Refused("Open publication from Descant.", 403)
        origin = self.headers.get("Origin")
        if origin and origin not in ("http://" + self.headers.get("Host", ""), "https://" + self.headers.get("Host", "")):
            raise publication.Refused("Open publication from Descant.", 403)
        try:
            body = json.loads(self.read_body() or b"{}")
            if not isinstance(body, dict): raise ValueError()
        except (ValueError, TypeError):
            raise publication.Refused("Publication actions need one JSON object.", 400)
        service = self.publication_service()
        service.founder(body.get("who"))
        path = article_path(body.get("path"))
        if not path or self.piece_locked(path):
            raise publication.Refused("This article cannot be published here.", 403)
        return service, body

    def api_publication_prepare(self):
        try:
            service, body = self.publication_body()
            sync_pull(force=True)
            result = service.prepare(body["path"], body.get("source"), body["who"], body.get("metadata"))
            return self.reply(200, {"ok": True, **result})
        except publication.Refused as error:
            return self.reply(error.code, {"ok": False, "error": str(error)})

    def api_publication_approve(self):
        try:
            service, body = self.publication_body()
            hashes = service.config.get("approval_sha256") or {}
            expected = hashes.get(body["who"]) if isinstance(hashes, dict) else None
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise publication.Refused("A founder must set up publication keys first.", 503)
            key = body.get("key")
            if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key) or not hmac.compare_digest(hashlib.sha256(key.encode()).hexdigest(), expected):
                raise publication.Refused("The publication key does not match this founder.", 403)
            record = service.record(body.get("id"))
            if record["path"] != body["path"] or not record.get("viewed"):
                raise publication.Refused("Open this article's private preview first.", 409)
            session, token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            with PUBLICATION_LOCK:
                now = time.monotonic()
                for old in list(PUBLICATION_APPROVALS):
                    if PUBLICATION_APPROVALS[old]["until"] <= now:
                        del PUBLICATION_APPROVALS[old]
                PUBLICATION_APPROVALS[token] = {"session": session, "id": record["id"], "who": body["who"],
                                               "config": service.config, "until": now + 600}
            cookie = "descant-publication=" + session + "; HttpOnly; SameSite=Strict; Path=/api/publication/publish; Max-Age=600"
            if (self.headers.get("Origin") or "").startswith("https://"):
                cookie += "; Secure"
            return self.reply(200, {"ok": True, "approval": token}, headers={"Set-Cookie": cookie})
        except publication.Refused as error:
            return self.reply(error.code, {"ok": False, "error": str(error)})

    def publication_approval(self, service, body):
        try:
            cookies = SimpleCookie(self.headers.get("Cookie") or "")
            session = cookies["descant-publication"].value
        except (CookieError, KeyError):
            session = ""
        token = body.get("approval")
        approval = PUBLICATION_APPROVALS.get(token) if isinstance(token, str) else None
        if not approval or approval["until"] <= time.monotonic() or approval["id"] != body.get("id") or \
                approval["who"] != body["who"] or approval["config"] != service.config or \
                not hmac.compare_digest(approval["session"], session):
            raise publication.Refused("Enter your publication key to approve this version.", 403)
        del PUBLICATION_APPROVALS[token]

    def api_publication_publish(self):
        try:
            service, body = self.publication_body()
            record = service.record(body.get("id"))
            if record["path"] != body["path"]:
                raise publication.Refused("This preview belongs to another article.", 409)
            sync_pull(force=True)
            with PUBLICATION_LOCK:
                self.publication_approval(service, body)
                result = service.publish(body["id"], body["who"], body.get("confirm"))
            return self.reply(200, {"ok": True, **result})
        except publication.Refused as error:
            return self.reply(error.code, {"ok": False, "error": str(error)})

    def publication_preview(self):
        try:
            match = re.fullmatch(r"/publication/([a-f0-9]{32})/(.*)", urlparse(self.path).path)
            if not match: raise publication.Refused("No such preview.", 404)
            identifier, relative = match.groups()
            with WRITE_LOCK:
                target = self.publication_service().preview_file(identifier, relative)
            content = target.read_bytes()
            kind = self.guess_type(str(target))
            prefix = "/publication/" + identifier
            if target.suffix in (".html", ".css", ".js", ".json"):
                text = content.decode("utf-8")
                # Root-relative site resources stay inside this private candidate.
                text = re.sub(r"([\"'])/(?!/)", lambda m: m[1] + prefix + "/", text)
                text = re.sub(r"url\(/(?!/)", "url(" + prefix + "/", text)
                if preview_origin():
                    text = text.replace(preview_origin(), prefix + "/")
                content = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Robots-Tag", "noindex, nofollow")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "connect-src 'none'; form-action 'none'; frame-ancestors 'self'")
            self.end_headers()
            self.wfile.write(content)
        except publication.Refused as error:
            return self.reply(error.code, {"ok": False, "error": str(error)})

    _offline_packs = {}  # At most one <=64 MiB generation per founder, for 120 seconds.

    def api_offline(self):
        """Founder-only, bounded pages of exact existing GET responses.

        Never takes a caller-selected path. The private writer dispatcher holds
        WRITE_LOCK; a source fingerprint before/after also detects external edits.
        Pages contain at most 6 MiB of raw bytes, even when one object is larger.
        """
        import copy
        import io
        import writer_origin
        from types import SimpleNamespace
        source_app = SimpleNamespace(REPO_ROOT=REPO_ROOT, APP_DIR=APP_DIR, git=git)
        principal = getattr(self, '_writer_principal', None)
        if principal not in FOUNDERS:
            return self.reply(401, {"error": "founder-required"})
        query = self.query()
        cursor = (query.get('cursor') or ['0'])[0]
        expected = (query.get('snapshot') or [''])[0]
        if set(query) - {'cursor', 'snapshot'} or any(len(v) != 1 for v in query.values()) or \
                not re.fullmatch(r'0|[1-9][0-9]{0,7}', cursor) or \
                (expected and not re.fullmatch(r'[a-f0-9]{64}', expected)) or (cursor != '0' and not expected):
            return self.reply(400, {"error": "invalid-offline-page"})
        limit, page_size = 64 * 1024 * 1024, 6 * 1024 * 1024
        if int(cursor) % page_size or int(cursor) >= limit:
            return self.reply(400, {"error": "invalid-offline-page"})
        records, total, drafts, threads = [], 0, 0, 0
        original_path = self.path
        prior_read_only = getattr(READ_ONLY_CAPTURE, 'active', False)
        READ_ONLY_CAPTURE.active = True
        try:
            # Existing read methods can import a legacy sandbox and commit it.
            # Offline preparation is read-only: inspect EVERY listed article before
            # capture or cache reuse, even when a legacy change leaves HEAD intact.
            preflight = self.pieces_payload()
            if not isinstance(preflight, list) or not 0 < len(preflight) <= 50:
                raise ValueError('offline-article-list-invalid')
            for article in preflight:
                path = article.get('path') if isinstance(article, dict) else None
                if not isinstance(path, str) or not re.fullmatch(r'articles/[A-Za-z0-9._-]{1,80}/article\.md', path) or not safe_piece(path[:-11]):
                    raise ValueError('offline-article-path-invalid')
                root = sandbox_path(REPO_ROOT, path[:-11])
                marker = root / '.files-migrated.json'
                legacy = sandbox_root(path[:-11])
                legacy_base = REVIEWS if FILES_ROOT_OVERRIDE is None else legacy.parent
                relative = legacy.relative_to(legacy_base).as_posix()
                if sandbox_path(legacy_base, relative) is None or marker.is_symlink() or marker.exists() and not marker.is_file():
                    return self.reply(422, {"error": "offline-files-unsafe"})
                if legacy.exists() and not marker.exists():
                    return self.reply(409, {"error": "offline-migration-needed"})
            generation = writer_origin.snapshot(source_app)
            if expected and expected != generation:
                return self.reply(409, {"error": "offline-snapshot-changed"})

            now = time.monotonic()
            for owner, old in list(self._offline_packs.items()):
                if old['until'] < now: del self._offline_packs[owner]
            retained = self._offline_packs.get(principal)
            if retained and retained['snapshot'] == generation:
                records, total, articles, drafts, threads = (retained[k] for k in
                    ('records', 'total', 'articles', 'drafts', 'threads'))
            else:
                def capture(url, method=None):
                    # Reuse the writer's existing response construction, including
                    # URL projection, attachment sandbox headers and shell CSP.
                    held = copy.copy(self)
                    held.path = url[len('/write'):]
                    held.wfile = io.BytesIO()
                    headers, codes = {}, []
                    held.send_response = lambda code, *args: codes.append(code)
                    held.send_header = lambda name, value: headers.__setitem__(name, str(value))
                    held.end_headers = lambda: None
                    if method:
                        getattr(held, method)()
                    else:
                        held.path = url
                        held.dispatch_locked()
                    if codes != [200]:
                        raise ValueError('offline-resource-unavailable')
                    body = held.wfile.getvalue()
                    if headers.get('Content-Encoding') == 'gzip': body = gzip.decompress(body)
                    nonlocal total
                    total += len(body)
                    if len(records) >= 10000: raise ValueError('offline-object-limit')
                    if total > limit: raise OverflowError('offline-pack-too-large')
                    kept_headers = {k: v for k, v in headers.items() if k in
                                    ('Content-Type', 'Content-Security-Policy', 'Content-Disposition')}
                    records.append((url, body, kept_headers))
                    return json.loads(body) if 'application/json' in headers.get('Content-Type', '') else None

                def api(route, method, **params):
                    from urllib.parse import urlencode
                    return capture('/write/api/' + route + ('?' + urlencode(sorted(params.items())) if params else ''), method)

                # whoami is intentionally constructed identically to the writer gate.
                identity = {"role": "founder", "id": "founder:" + principal,
                            "who": principal, "publicWriter": True}
                body = json.dumps(identity).encode('utf-8')
                records.append(('/write/api/whoami', body, {'Content-Type': 'application/json; charset=utf-8'}))
                total += len(body)
                articles = api('pieces', 'api_pieces')
                if articles != preflight:
                    return self.reply(409, {"error": "offline-snapshot-changed"})
                if not isinstance(articles, list) or not 0 < len(articles) <= 50:
                    raise ValueError('offline-article-list-invalid')
                for route in writer_origin.STATIC:
                    if route != '/sw.js': capture('/write' + route)
                for article in articles:
                    path = article.get('path') if isinstance(article, dict) else None
                    if not isinstance(path, str) or not re.fullmatch(r'articles/[A-Za-z0-9._-]{1,80}/article\.md', path):
                        raise ValueError('offline-article-path-invalid')
                    piece = api('piece', 'api_piece', path=path)
                    if not isinstance(piece, dict) or piece.get('path') != path or not isinstance(piece.get('markdown'), str) or not isinstance(piece.get('files'), list):
                        raise ValueError('offline-article-invalid')
                    comments = api('comments', 'api_comments', path=path, actions=1, who=principal)
                    if not isinstance(comments, dict) or not isinstance(comments.get('threads'), list):
                        raise ValueError('offline-comments-invalid')
                    threads += len(comments['threads'])
                    folder = path[:-11]
                    for file in piece['files']:
                        relative = file.get('path') if isinstance(file, dict) else None
                        if not isinstance(relative, str) or relative.startswith('/') or re.search(r'(?:^|/)\.\.(?:/|$)', relative) or file.get('kind') not in ('file', 'folder'):
                            raise ValueError('offline-file-invalid')
                        if file['kind'] == 'file': api('files/content', 'api_files_content', piece=folder, path=relative)
                    workspace = api('canvas', 'api_canvas_get', state=1, piece=folder)
                    if not isinstance(workspace, dict) or not isinstance(workspace.get('canvas'), dict) or not isinstance(workspace['canvas'].get('nodes'), list) or not isinstance(workspace['canvas'].get('edges'), list) or not isinstance(workspace.get('version'), str):
                        raise ValueError('offline-workspace-invalid')
                    for hidden in (False, True):
                        params = dict(piece=folder, who=principal)
                        if hidden: params['hidden'] = 1
                        listed = api('drafts', 'api_drafts_get', **params)
                        if not isinstance(listed, dict) or not isinstance(listed.get('drafts'), list):
                            raise ValueError('offline-drafts-invalid')
                        if hidden:
                            for draft in listed['drafts']:
                                target = draft.get('path') if isinstance(draft, dict) else None
                                if not isinstance(target, str) or not target.startswith(folder + '/drafts/') or not target.endswith('.md') or re.search(r'(?:^|/)\.\.(?:/|$)', target) or drafts >= 500:
                                    raise ValueError('offline-draft-invalid')
                                held = api('piece', 'api_piece', path=target)
                                if not isinstance(held, dict) or held.get('path') != target or not isinstance(held.get('markdown'), str) or not isinstance(held.get('files'), list):
                                    raise ValueError('offline-draft-copy-invalid')
                                drafts += 1
                if writer_origin.snapshot(source_app) != generation:
                    return self.reply(409, {"error": "offline-snapshot-changed"})
                self._offline_packs[principal] = dict(snapshot=generation, until=time.monotonic() + 120,
                    records=records, total=total, articles=articles, drafts=drafts, threads=threads)
            # Byte cursor is bounded by total data; empty objects still get rows.
            offset, end, chunks = int(cursor), min(int(cursor) + page_size, total), []
            if offset >= total: raise ValueError('offline-cursor-invalid')
            at = 0
            bundle = hashlib.sha256()
            for url, body, headers in records:
                size, sha = len(body), hashlib.sha256(body).hexdigest()
                bundle.update(json.dumps([url, headers, size, sha], sort_keys=True).encode('utf-8'))
                first, last = max(offset, at), min(end, at + size)
                if first < last or size == 0 and offset <= at < end:
                    chunks.append(dict(url=url, headers=headers, size=size, sha256=sha,
                                       offset=first - at, bytes=base64.b64encode(body[first - at:last - at]).decode('ascii')))
                at += size
            if writer_origin.snapshot(source_app) != generation:
                return self.reply(409, {"error": "offline-snapshot-changed"})
            self.path = original_path
            return self.reply(200, dict(v=1, account='founder:' + principal, snapshot=generation,
                                       bundle=bundle.hexdigest(), total=total, cursor=offset,
                                       next=end if end < total else None, objects=len(records),
                                       articles=len(articles), drafts=drafts, threads=threads, chunks=chunks))
        except OverflowError:
            self.path = original_path
            return self.reply(413, {"error": "offline-pack-too-large"})
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            self.path = original_path
            return self.reply(422, {"error": "offline-pack-incomplete"})
        finally:
            READ_ONLY_CAPTURE.active = prior_read_only

    def api_pieces(self):
        """Every article this repository holds, in order, for the tab strip."""
        return self.reply(200, self.pieces_payload())

    def pieces_payload(self):
        build = build_module()
        out = []
        for folder in listed_article_folders():
            path = (folder / "article.md").relative_to(REPO_ROOT).as_posix()
            if not self.may_read(path):
                continue
            try:
                markdown = (folder / "article.md").read_text("utf-8")
            except (OSError, UnicodeError):
                continue
            head = {}
            if markdown.startswith("---"):
                end = markdown.find("\n---", 3)
                if end > 0:
                    for line in markdown[3:end].split("\n"):
                        if ":" in line:
                            k, _, v = line.partition(":")
                            head[k.strip()] = v.strip().strip('"').strip("'")
            title = (build.frontmatter_title(markdown, folder.name) if build else None) or head.get("title") or folder.name
            try:
                order = int(head.get("order", "0"))
            except ValueError:
                order = 0
            out.append({
                "path": path,
                "folder": folder.relative_to(REPO_ROOT).as_posix(),
                "title": title,
                "order": order,
                "status": head.get("status", ""),
                "phase": head.get("phase", ""),
                "owner": head.get("owner", ""),
                "locked": self.piece_locked(path),
                "live": bool(self.article_live_record(path)),
            })
        out.sort(key=lambda p: (p["order"] or 999, p["folder"]))
        return out

    def api_graph(self):
        if hasattr(self, "reviewer"):
            return self.reply(403, {"error": "Only founders can read the links and working notes."})
        path = article_path((self.query().get("path") or [""])[0])
        if not path or not path.startswith("articles/") or not self.may_read(path):
            return self.reply(403, {"error": "Choose an article to see its links."})
        try:
            import graph  # loaded on first use, so the server still starts from its own files alone
            with WRITE_LOCK:
                data = graph.local_graph(REPO_ROOT, path, listed_article_folders(), sandbox_path, self.article_live_record)
            return self.reply(200, data)
        except FileNotFoundError:
            return self.reply(404, {"error": "This article is not available."})
        except OSError:
            return self.reply(503, {"error": "Links could not load. Try again."})

    def api_search(self):
        """Every listed article's title, text and review comments, searched for one query.

        Read-only. Answers {"query", "hits", "more"}; each hit is {path, title, kind, snippet,
        line, match}, where kind is "title", "text" or "comment", line is 1-based in the file
        the match is in, the snippet is the line's words without their Markdown, and match is
        [start, end] of the words found inside the snippet. A comment hit also names that
        file, its thread, who wrote the line and the passage the thread is anchored to."""
        query = " ".join(((self.query().get("q") or [""])[0]).split())
        if not SEARCH_MIN <= len(query) <= SEARCH_MAX:
            return self.reply(400, {"ok": False, "reason": "bad-query",
                                    "error": "a search is %d to %d characters" % (SEARCH_MIN, SEARCH_MAX)})
        needle = query.lower()
        build = build_module()
        titles, texts, comments = [], [], []
        for folder in listed_article_folders():
            path = (folder / "article.md").relative_to(REPO_ROOT).as_posix()
            if not self.may_read(path):
                continue
            try:
                markdown = (folder / "article.md").read_text("utf-8")
            except (OSError, UnicodeError):
                continue
            title = (build.frontmatter_title(markdown, folder.name) if build else None) or folder.name
            found = search_article(path, folder, title, markdown, needle)
            titles += found[0]
            texts += found[1]
            comments += found[2]
        hits = titles[:SEARCH_HITS]
        shown_texts, shown_comments = [], []
        while len(hits) + len(shown_texts) + len(shown_comments) < SEARCH_HITS and (
                len(shown_texts) < len(texts) or len(shown_comments) < len(comments)):
            if len(shown_texts) < len(texts):
                shown_texts.append(texts[len(shown_texts)])
            if (len(hits) + len(shown_texts) + len(shown_comments) < SEARCH_HITS
                    and len(shown_comments) < len(comments)):
                shown_comments.append(comments[len(shown_comments)])
        hits = hits + shown_texts + shown_comments
        total = len(titles) + len(texts) + len(comments)
        return self.reply(200, {"query": query, "hits": hits, "more": total > len(hits)})

    @file_errors
    def api_piece(self):
        """The piece as the repository holds it now, with its real saves."""
        path = safe_path((self.query().get("path") or [""])[0])
        if not path or not self.may_read(path):
            return self.reply(403, {"error": "that path is not readable through this server"})
        if "/drafts/" in path and not draft_path(path):
            return self.reply(403, {"error": "that draft path is not readable"})
        folder = piece_folder(path)
        working = REPO_ROOT / path
        media = served_media(folder)
        if working.is_file():
            article_bytes = working.read_bytes()
            markdown = point_media(article_bytes.decode("utf-8"), media)
        else:
            shown = git_blob(path)
            if shown.returncode != 0:
                return self.reply(404, {"error": "there is no such piece in this repository"})
            article_bytes = shown.stdout
            markdown = point_media(article_bytes.decode("utf-8"), media)
        versions = piece_versions(path, media)
        build = build_module()
        title = draft_entry(path)["title"] if draft_path(path) else (build.frontmatter_title(markdown, folder.name) if build else folder.name)
        piece_name = path.split("/drafts/", 1)[0] if draft_path(path) else folder.relative_to(REPO_ROOT).as_posix()
        files = self.live_files(piece_name)
        return self.reply(200, {
            "path": path,
            "title": title,
            "folder": piece_name,
            "markdown": markdown,
            "versions": versions,
            "current": versions[-1]["id"] if versions else None,
            "files": files,
            "fileOrder": files_order(piece_name) if files else {},
            "draft": draft_entry(path) if draft_path(path) else None,
            "pieces": [title],
            "locked": self.piece_locked(path),
            "articleTabs": self.pieces_payload(),
            "save": save_evidence(path, versions[-1]["sha"] if versions else ""),
            "live": self.article_live_record(path),
            "sites": [] if hasattr(self, "reviewer") else space_config.client_sites(),
            "article_sha256_now": hashlib.sha256(article_bytes).hexdigest(),
        })

    def article_live_record(self, path):
        if not article_path(path) or hasattr(self, "reviewer"):
            return None
        target = (REPO_ROOT / path).parent / "live.json"
        try:
            if target.is_symlink() or target.stat().st_size > 16384:
                return None
            record = json.loads(target.read_text("utf-8"))
            if not isinstance(record, dict) or not space_config.site(record.get("site")):
                return None
            # Receipts contain only the public deployment fields, never arbitrary data.
            return {key: record.get(key) for key in ("site", "url", "slug", "title", "published_at", "article_sha256", "commit")}
        except (OSError, ValueError):
            return None

    def api_piece_live(self):
        path = article_path((self.query().get("path") or [""])[0])
        if not path or not self.may_read(path) or hasattr(self, "reviewer"):
            return self.reply(403, {"error": "Only founders can read the published version."})
        record = self.article_live_record(path)
        commit = record.get("commit") if record else None
        if not record or record.get("article_sha256") is None:
            return self.reply(404, {"error": "The published version is unknown."})
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
            return self.reply(422, {"error": "The publication record has no valid commit."})
        shown = git_blob(path, commit=commit)
        if shown.returncode:
            return self.reply(404, {"error": "The published version is not in this clone yet."})
        if hashlib.sha256(shown.stdout).hexdigest() != record["article_sha256"]:
            return self.reply(409, {"error": "The publication record does not match its saved version."})
        return self.reply(200, {"path": path, "commit": commit, "markdown": point_media(shown.stdout.decode("utf-8"), served_media(piece_folder(path)))})







    @file_errors
    def api_drafts_get(self):
        query = self.query()
        piece = safe_piece((query.get("piece") or [""])[0])
        who = (query.get("who") or [""])[0]
        if not piece or who not in FOUNDERS:
            return self.reply(400, {"error": "Choose an article and who is writing."})
        entries = []
        with WRITE_LOCK:
            for target in sorted((REPO_ROOT / piece / "drafts").glob("*/*.md")):
                path = target.relative_to(REPO_ROOT).as_posix()
                if not draft_path(path):
                    continue
                entry = draft_entry(path)
                if entry["hidden"] and entry["person"] != who and (query.get("hidden") or [""])[0] != "1":
                    continue
                entries.append(entry)
        return self.reply(200, {"drafts": entries})

    @file_errors
    def api_drafts_write(self):
        raw = self.read_body()
        body = json.loads(raw.decode("utf-8")) if raw else None
        if not isinstance(body, dict):
            return self.reply(400, {"error": "The body must be one draft action."})
        piece = safe_piece(body.get("piece"))
        who = body.get("who")
        if not piece or who not in FOUNDERS:
            return self.reply(400, {"error": "Choose an article and who is writing."})
        with WRITE_LOCK:
            action = body.get("action")
            if action == "create":
                title = " ".join(str(body.get("title") or "").split())
                if not 1 <= len(title) <= 100:
                    return self.reply(400, {"error": "Give the draft a title, up to 100 characters."})
                name = datetime.date.today().isoformat() + "-" + comment_slug(title)
                root = sandbox_path(REPO_ROOT, piece + "/drafts/" + who)
                if root is None:
                    return self.reply(403, {"error": "That drafts folder contains a symlink."})
                target = unique_path(root, name + ".md")
                if target is None or sandbox_path(REPO_ROOT, target.relative_to(REPO_ROOT).as_posix()) is None:
                    return self.reply(403, {"error": "That draft path is unavailable."})
                path = target.relative_to(REPO_ROOT).as_posix()
                text = "---\ntitle: " + json.dumps(title, ensure_ascii=False) + "\nhidden: false\nmoved: false\n---\n"
                sha = commit_files({target: text.encode("utf-8")}, "Create draft " + target.name, writing_session(who))
                return self.reply(200, dict(draft_entry(path), ok=True, sha=sha))
            path = draft_path(body.get("path"))
            if not path or not path.startswith(piece + "/drafts/"):
                return self.reply(403, {"error": "Choose a draft belonging to this article."})
            if not draft_current(path, body.get("base")):
                return self.reply(409, {"error": "The draft changed. Open it again before continuing."})
            target = REPO_ROOT / path
            text = target.read_text("utf-8")
            header = draft_header(text)
            if action == "hide":
                if DRAFT_RE.fullmatch(path)[1] != who or type(body.get("hidden")) is not bool:
                    return self.reply(403, {"error": "Only the draft's person can change its visibility."})
                replacement = re.sub(r"(?m)^hidden: (true|false)$", "hidden: " + str(body["hidden"]).lower(), header)
                sha = commit_files({target: (replacement + text[len(header):]).encode("utf-8")},
                                   ("Hide draft " if body["hidden"] else "Show draft ") + target.name, writing_session(who))
            elif action == "move":
                article = piece + "/article.md"
                if article in LOCKED_PIECES:
                    return self.reply(423, {"error": "The article is locked by another writer."})
                if not draft_current(article, body.get("articleBase")) or draft_entry(path)["moved"]:
                    return self.reply(409, {"error": "The article changed or this draft was already moved. Open it again."})
                content = text[len(header):].lstrip("\n")
                if not content.strip():
                    return self.reply(400, {"error": "Write something in the draft first."})
                article_target = REPO_ROOT / article
                merged = draft_splice(article_target.read_text("utf-8"), body.get("start"), body.get("end"), content)
                moved = re.sub(r"(?m)^moved: false$", "moved: true", header) + text[len(header):]
                sha = commit_files({article_target: merged.encode("utf-8"), target: moved.encode("utf-8")},
                                   "Move draft " + target.name + " into the article", writing_session(who))
            else:
                return self.reply(400, {"error": "Unknown draft action."})
            return self.reply(200, dict(draft_entry(path), ok=True, sha=sha))

    def api_agent_get(self):
        try:
            with COMMENTS_LOCK:
                return self.reply(200, agent_interface.context(_agent_app(),
                    (self.query().get("path") or [""])[0]))
        except (OSError, ValueError) as error:
            return self.reply(400, {"error": str(error)})

    def api_agent_write(self):
        try:
            raw = self.read_body()
            if raw is None:
                raise ValueError("empty or oversized body")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError("the body must be an object")
            with COMMENTS_LOCK:
                result = agent_interface.append(_agent_app(), body)
            return self.reply(200, result)
        except CommentRefused as error:
            return self.reply(error.code, error.payload)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            return self.reply(400, {"error": str(error)})

    def api_agent_batch(self):
        try:
            raw = self.read_body()
            body = json.loads(raw) if raw else None
            if not isinstance(body, dict):
                raise ValueError("the body must be an object")
            with COMMENTS_LOCK:
                return self.reply(200, agent_interface.batch(_agent_app(), body))
        except CommentRefused as error:
            return self.reply(error.code, error.payload)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            return self.reply(400, {"error": str(error)})

    def api_mentions(self):
        try:
            since = int((self.query().get("since") or ["0"])[0])
            who = (self.query().get("who") or [""])[0]
            if since < 0 or who not in ("", "agent") + FOUNDERS:
                raise ValueError("invalid mention cursor or recipient")
            with COMMENTS_LOCK:
                state = agent_interface.queue(_agent_app(), committed_only=True)
            events = [e for e in state["events"] if not e.get("retired") and e["id"] > since and (not who or e["recipient"] == who)]
            return self.reply(200, {"mentions": events, "cursor": len(state["events"]), "read": state["read"].get(who, 0)})
        except (OSError, ValueError) as error:
            return self.reply(400, {"error": str(error)})

    def api_mentions_read(self):
        try:
            raw = self.read_body()
            body = json.loads(raw) if raw else None
            if not isinstance(body, dict):
                raise ValueError("the body must be an object")
            who, cursor = body.get("who"), body.get("cursor")
            if who not in FOUNDERS or type(cursor) is not int or cursor < 0:
                raise ValueError("a founder and nonnegative cursor are required")
            with COMMENTS_LOCK:
                state = agent_interface.queue(_agent_app())
                if cursor > len(state["events"]):
                    raise ValueError("cursor is ahead of the mention queue")
                state["read"][who] = max(cursor, state["read"].get(who, 0))
                commit_files({agent_interface.queue_path(_agent_app()): agent_interface.encoded(state)},
                             "Read Descant mentions", people=writing_session(who))
            return self.reply(200, {"ok": True, "read": state["read"][who]})
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            return self.reply(400, {"error": str(error)})

    def api_comments(self):
        """Review files in the exact object shape comments.js normalises."""
        path = article_path((self.query().get("path") or [""])[0])
        if not path or not self.may_read(path):
            return self.reply(403, {"error": "only an article path has review threads"})
        if not (REPO_ROOT / path).is_file():
            return self.reply(404, {"error": "there is no such article"})
        try:
            with COMMENTS_LOCK:
                if (self.query().get("actions") or [""])[0] == "1" and not isinstance(self, ReviewerHandler):
                    who = (self.query().get("who") or [""])[0]
                    if who not in FOUNDERS: return self.reply(403, {"ok": False, "reason": "writer-unconfirmed"})
                    return self.reply(200, comment_action_document(path, who))
                return self.reply(200, comment_projected_threads(path))
        except (OSError, UnicodeError, ValueError) as error:
            return self.reply(422, {"error": "a review thread could not be parsed: " + str(error)[:200]})

    def api_comment_action(self):
        raw = self.read_body()
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict) or not valid_comment_action_json(body):
                return self.reply(400, {"ok": False, "reason": "bad-request"})
            path = article_path(body.get("path"))
            who = body.get("who")
            op = body.get("opId")
            action = body.get("action")
            if not path or who not in FOUNDERS or not isinstance(op, str) or not re.fullmatch(r"[-A-Za-z0-9_]{1,100}", op) or body.get("accessEpoch") != "founder" or action not in ("edit", "withdraw", "restore", "reaction", "resolve", "reopen"):
                return self.reply(400, {"ok": False, "reason": "bad-request"})
            if not self.may_read(path) or not (REPO_ROOT / path).is_file(): return self.reply(403, {"ok": False, "reason": "not-allowed"})
            base = body.get("baseRev")
            if not isinstance(base, int) or isinstance(base, bool) or base < 0: return self.reply(400, {"ok": False, "reason": "bad-request"})
        except (ValueError, TypeError, AttributeError): return self.reply(400, {"ok": False, "reason": "bad-request"})
        with COMMENTS_LOCK:
            doc = next((comment_document(t) for t in comment_files(piece_folder(path) / "review") if comment_document(t)["thread"]["id"] == body.get("threadId")), None)
            if not doc: return self.reply(403, {"ok": False, "reason": "not-allowed"})
            shared = DESCANT_SOURCE_RE.match(doc["source"])
            if shared:
                if not SHARE.get("url") or not SHARE.get("ready"): return self.reply(503, {"ok": False, "reason": "shared-authority-unavailable"})
                outgoing = dict(body, threadId=shared.group(1))
                # Release the private lock before the importer takes it. The D1
                # operation is already authoritative if later Git durability fails.
            else: outgoing = None
            if not shared:
                try: events = comment_action_events(path)
                except (ValueError, OSError, UnicodeError): return self.reply(409, {"ok": False, "reason": "operation-conflict"})
                committed = [e for e in events if comment_action_committed(path, e)]
                actor = "founder:" + who
                fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                prior = next((e for e in events if e["actorKey"] == actor and e["request"]["opId"] == op), None)
                current = comment_action_projection(path, doc["thread"], who, events=committed)
                if prior:
                    if prior["requestHash"] != fingerprint: return self.reply(409, {"ok": False, "reason": "operation-conflict"})
                    if prior in committed:
                        return self.reply(200, {"ok": True, "receipt": {"opId": op, "request": prior["request"], "resultRev": prior["resultRev"], "authority": "git", "gitDurable": True}, "thread": current})
                elif len(committed) != len(events):
                    return self.reply(422, {"ok": False, "reason": "save-failed", "error": "A retained action awaits its exact retry before another action."})
                is_status = action in ("resolve", "reopen")
                message = next((m for m in [current] + current["replies"] if m["messageRef"] == body.get("messageRef")), None)
                if not is_status and (message is None or action != "reaction" and not message["actions"]["permissions"]["edit"]):
                    return self.reply(403, {"ok": False, "reason": "not-allowed"})
                if action == "reaction" and (body.get("reaction") not in COMMENT_REACTIONS or not isinstance(body.get("active"), bool)):
                    return self.reply(400, {"ok": False, "reason": "bad-request"})
                slot = "status" if is_status else ("reaction:" + message["messageRef"] + ":" + actor + ":" + body["reaction"] if action == "reaction" else "message:" + message["messageRef"])
                history = [e for e in committed if e.get("localThreadId", e.get("threadId")) == current["id"] and e["slot"] == slot]
                latest = max(history, key=lambda e: e["resultRev"], default=None)
                rev = latest["resultRev"] if latest else 0
                if base != rev: return self.reply(409, {"ok": False, "reason": "stale-action", "thread": current})
                original = next((m for m in [doc["thread"]] + doc["thread"]["replies"] if m.get("messageRef", "local-root:" + doc["thread"]["id"]) == body.get("messageRef")), message)
                state = dict(latest["state"]) if latest else ({"done": current["done"], "status": current["status"]} if is_status else {"active": False} if action == "reaction" else {"text": original["text"], "withdrawn": False})
                if is_status: state = {"done": action == "resolve", "status": "answered" if action == "resolve" else "open"}
                elif action == "reaction": state = {"active": body["active"]}
                elif action == "edit":
                    try: state["text"] = reviewer_message(body.get("text"))
                    except CommentRefused as refused: return self.reply(refused.code, dict(refused.payload, ok=False))
                else: state["withdrawn"] = action == "withdraw"
                identifier = prior["id"] if prior else "a" + secrets.token_hex(16)
                event = {"id": identifier, "actorKey": actor, "request": body, "requestHash": fingerprint, "threadId": current["id"], "path": path, "slot": slot,
                         "resultRev": rev + 1, "state": state, "created": prior["created"] if prior else datetime.datetime.now(datetime.timezone.utc).isoformat(), "authority": "git"}
                target = piece_folder(path) / "review/actions" / (identifier + ".md")
                if prior and comment_action_bytes(prior) != comment_action_bytes(event):
                    return self.reply(409, {"ok": False, "reason": "operation-conflict"})
                after = comment_action_projection(path, doc["thread"], who, events=committed + [event])
                mention = agent_interface.mention_change(_agent_app(), path, {current["id"]: {"thread": current}},
                    {after["id"]: {"thread": after}}, who, operation=event) if action == "edit" else None
                try: commit_comment_action(target, comment_action_bytes(event), "Keep a comment action", people=writing_session(who),
                    trailers="Principal: %s\nActor: human\nBasis: instruction\nComment-Action: %s" % (who, identifier),
                    companions=dict([mention]) if mention else None)
                except (ValueError, OSError, subprocess.TimeoutExpired) as error: return self.reply(422, {"ok": False, "reason": "save-failed", "error": str(error)[:200]})
                # The synchronous commit/push may rebase onto newer action state.
                committed = comment_action_events(path, committed_only=True)
                return self.reply(200, {"ok": True, "receipt": {"opId": op, "request": body, "resultRev": rev+1, "authority": "git", "gitDurable": True}, "thread": comment_action_projection(path, doc["thread"], who, events=committed)})
        answer = None
        try:
            answer = private_action_answer(share_action_call(outgoing), doc["thread"]["id"])
            if not answer.get("ok"): return self.reply(answer.pop("httpStatus", 409), answer)
            sync_comment_actions()
            answer = private_action_answer(share_action_call(outgoing), doc["thread"]["id"])
            return self.reply(200 if answer.get("receipt", {}).get("gitDurable") else 202, answer)
        except ShareError:
            if answer and answer.get("ok"):
                return self.reply(202, answer)
            return self.reply(503, {"ok": False, "reason": "shared-authority-unavailable", "error": "This operation may already be accepted. Retry its original operation identity."})

    def api_comments_write(self):
        """Create new thread files and rewrite only submitted threads that changed."""
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "empty or oversized body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "the body is not JSON"})
        if not isinstance(body, dict) or not isinstance(body.get("threads"), list):
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "threads must be one complete list"})
        path = article_path(body.get("path"))
        if not path:
            return self.reply(403, {"ok": False, "reason": "not-an-article",
                                    "error": "only articles/<slug>/article.md has review threads"})
        if not self.may_read(path):
            return self.reply(403, {"ok": False, "reason": "not-shared",
                                    "error": "that piece is not shared with you"})
        if not (REPO_ROOT / path).is_file():
            return self.reply(404, {"ok": False, "reason": "not-found",
                                    "error": "there is no such article"})
        identity, refusal = self.comment_identity(body)
        self._comment_actor = body.get("who") if not isinstance(self, ReviewerHandler) else None
        if refusal:
            return self.reply(*refusal)
        if not COMMENTS_LOCK.acquire(timeout=5):
            return self.reply(409, {"ok": False, "reason": "busy",
                                    "error": "another comment save is still finishing"})
        try:
            folder = piece_folder(path) / "review"
            folder.mkdir(parents=True, exist_ok=True)
            existing_documents = {}
            existing_targets = {}
            try:
                events = comment_action_events(path, committed_only=True)
                for target in comment_files(folder):
                    document = comment_document(target)
                    identifier = document["thread"]["id"]
                    existing_documents[identifier] = document
                    existing_targets[identifier] = target
            except (OSError, UnicodeError, ValueError) as error:
                return self.reply(422, {"ok": False, "reason": "parse-failed",
                                        "error": "a review thread could not be parsed: " + str(error)[:200]})

            previous_documents = dict(existing_documents)
            submitted_ids = set()
            highest = max([int(identifier) for identifier in existing_documents] or [0])
            changes = []
            for submitted in body["threads"]:
                if not isinstance(submitted, dict):
                    return self.reply(400, {"ok": False, "reason": "bad-request",
                                            "error": "each thread must be an object"})
                raw_id = str(submitted.get("id") or "")
                if raw_id in submitted_ids:
                    return self.reply(409, {"ok": False, "reason": "duplicate-thread",
                                            "error": "the submitted list repeats thread " + raw_id})
                submitted_ids.add(raw_id)
                previous_document = existing_documents.get(raw_id)
                if not raw_id.isdigit():
                    previous_document = next((doc for doc in existing_documents.values()
                                              if doc["thread"].get("clientId") == raw_id), None)
                    if previous_document:
                        # A pending retry keeps the accepted root, including server-stamped identity.
                        previous = previous_document["thread"]
                        retry = self.comment_base(submitted, previous["id"])
                        if previous.get("writer") == "founder:" + str(self._comment_actor) and retry["by"] == "human":
                            retry["author"] = previous["author"]
                        if any(retry[key] != previous[key] for key in ("text", "author", "by")):
                            raise CommentRefused(409, "comment-conflict", "A comment identity already holds different words or an author.")
                        replies = list(previous["replies"])
                        for reply in retry["replies"]:
                            match = next((r for r in replies if same_reply(r, reply)), None)
                            if match and any(match.get(key) != reply.get(key) for key in ("text", "author", "by")):
                                raise CommentRefused(409, "reply-conflict", "A reply identity already holds different words or an author.")
                            if match is None:
                                replies.append(reply)
                        submitted = dict(previous, replies=replies)
                        raw_id = previous["id"]
                if raw_id.isdigit() and previous_document is None:
                    return self.reply(409, {"ok": False, "reason": "unknown-thread",
                                            "error": "numeric thread %s is not on disk" % raw_id})
                if previous_document is None:
                    highest += 1
                    identifier = "%03d" % highest
                    thread = self.comment_thread(submitted, identifier)
                    slug = comment_slug(thread["text"])
                    document = {"thread": thread, "slug": slug,
                                "source": identity["source"], "preamble": ""}
                    target = folder / (identifier + "-" + slug + ".md")
                    changes.append((target, None, self.comment_render(document, thread)))
                    existing_documents[identifier] = document
                    existing_targets[identifier] = target
                    continue
                previous = previous_document["thread"]
                if isinstance(self, ReviewerHandler):
                    thread = self.comment_thread(submitted, raw_id, previous,
                        projected=comment_action_projection(path, previous, events=events))
                else:
                    submitted = preserve_action_managed(path, previous, submitted, self._comment_actor, events=events)
                    thread = self.comment_thread(submitted, raw_id, previous)
                if thread == previous:
                    continue
                document = dict(previous_document)
                document["thread"] = thread
                target = existing_targets[raw_id]
                before = target.read_bytes()
                changes.append((target, before, self.comment_render(document, thread, before)))
                existing_documents[raw_id] = document

            mention = agent_interface.mention_change(_agent_app(), path, previous_documents, existing_documents, str(body.get("who") or ""), manual_agent=body.get("agent_delivery") == "manual")
            if mention:
                target, rendered = mention
                target.parent.mkdir(parents=True, exist_ok=True)
                changes.append((target, target.read_bytes() if target.exists() else None, rendered))

            if not changes:
                threads = comment_projected_threads(path, events=events)
                return self.reply(200, {"ok": True, "threads": threads, "changed": 0})

            written = []
            before_sha = git("rev-parse", "HEAD").stdout.strip()
            try:
                for target, before, rendered in changes:
                    atomic_write(target, rendered)
                    written.append((target, before))
                gate = subprocess.run([str(REPO_ROOT / "check.sh")], cwd=str(REPO_ROOT),
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, timeout=60)
                if gate.returncode != 0:
                    raise RuntimeError("completion gate refused the comments:\n" + gate.stdout)
                relative = [target.relative_to(REPO_ROOT).as_posix() for target, _, _ in changes]
                added = git("add", "--", *relative)
                if added.returncode != 0:
                    raise RuntimeError("git could not stage the comment files: " + added.stderr.strip())
                article_slug = piece_folder(path).name
                committed = git("commit", *identity["author"],
                                "-m", identity["subject"] % article_slug,
                                "-m", identity["trailers"], "--", *relative, timeout=40)
                if committed.returncode != 0:
                    raise RuntimeError("git could not commit the comments: " + committed.stderr.strip())
            except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
                intended = {target.relative_to(REPO_ROOT).as_posix(): data for target, _, data in changes}
                if not publication.landed_commit(REPO_ROOT, before_sha, intended):
                    relative = [target.relative_to(REPO_ROOT).as_posix() for target, _ in written]
                    if relative:
                        git("reset", "-q", "HEAD", "--", *relative)
                    for target, before in reversed(written):
                        if before is None:
                            try:
                                target.unlink()
                            except FileNotFoundError:
                                pass
                        else:
                            atomic_write(target, before)
                    return self.reply(422, {"ok": False, "reason": "save-failed",
                                            "error": str(error)[:800]})

            # Never return the validation snapshot after a commit/push/rebase.
            events = comment_action_events(path, committed_only=True)
            refreshed = comment_projected_threads(path, events=events)
            return self.reply(200, {"ok": True, "threads": refreshed,
                                    "changed": len(changes), "sha": git("rev-parse", "HEAD").stdout.strip()})
        except CommentRefused as refused:
            # Raised only by the hooks, which all run while `changes` is being built,
            # so a refusal always arrives before the first file is touched.
            return self.reply(refused.code, refused.payload)
        finally:
            COMMENTS_LOCK.release()

    def api_piece_write(self):
        """Save one human-authored article version, or refuse before losing context."""
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "empty or oversized body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "the body is not JSON"})
        if not isinstance(body, dict):
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "the body must be one object"})

        path = article_path(body.get("path")) or draft_path(body.get("path"))
        if not path:
            return self.reply(403, {"ok": False, "reason": "not-an-article",
                                    "error": "only articles/<slug>/article.md is writable"})
        if path in LOCKED_PIECES:
            return self.reply(423, {"ok": False, "reason": "locked",
                                    "error": "another writer is in this piece right now"})

        markdown = body.get("markdown")
        if not isinstance(markdown, str):
            return self.reply(400, {"ok": False, "reason": "bad-request",
                                    "error": "markdown must be one complete text value"})
        base = str(body.get("base") or "").strip().lower()
        if not SHA_RE.fullmatch(base):
            return self.reply(400, {"ok": False, "reason": "invalid-base",
                                    "error": "base must be the commit sha that was loaded"})
        try:
            people = writing_session(body.get("who"))
        except ValueError as error:
            return self.reply(400, {"ok": False, "reason": "invalid-who", "error": str(error)})

        if not SAY_LOCK.acquire(timeout=5):
            return self.reply(409, {"ok": False, "reason": "busy",
                                    "error": "another save is still finishing"})
        try:
            target = REPO_ROOT / path
            if not target.is_file():
                return self.reply(404, {"ok": False, "reason": "not-found",
                                        "error": "there is no such article"})

            dirty = git("diff", "--quiet", "--", path)
            if dirty.returncode == 1:
                return self.reply(409, {"ok": False, "reason": "changed-on-disk",
                                        "error": "the file changed on disk outside this editor"})
            if dirty.returncode != 0:
                return self.reply(500, {"ok": False, "reason": "git-failed",
                                        "error": "git could not inspect the working file"})

            resolved_base = git("rev-parse", "--verify", base + "^{commit}")
            if resolved_base.returncode != 0:
                return self.reply(400, {"ok": False, "reason": "invalid-base",
                                        "error": "base is not a commit in this repository"})
            base = resolved_base.stdout.strip()
            head = git("rev-parse", "HEAD")
            if head.returncode != 0:
                return self.reply(500, {"ok": False, "reason": "git-failed",
                                        "error": "git could not read the current commit"})
            current_sha = head.stdout.strip()
            if current_sha != base:
                moved = git("diff", "--quiet", base + ".." + current_sha, "--", path)
                if moved.returncode == 1:
                    return self.reply(409, {"ok": False, "reason": "moved-under-you",
                                            "error": "the piece moved since you loaded it",
                                            "sha": current_sha,
                                            "markdown": target.read_text("utf-8")})
                if moved.returncode != 0:
                    return self.reply(400, {"ok": False, "reason": "invalid-base",
                                            "error": "base cannot be compared with the current commit"})

            before = target.read_bytes()
            try:
                before_text = before.decode("utf-8")
            except UnicodeDecodeError:
                return self.reply(422, {"ok": False, "reason": "not-markdown",
                                        "error": "the current article is not UTF-8"})
            markdown = unpoint_media(markdown, before_text, served_media(piece_folder(path)))
            if draft_path(path) and draft_header(before_text) != draft_header(markdown):
                return self.reply(403, {"ok": False, "reason": "draft-metadata", "error": "Use the Drafts panel to change draft visibility."})
            if not founder_markers_survive(before_text, markdown):
                return self.reply(403, {"ok": False, "reason": "founder-marker",
                                        "error": "every existing line with a writer's marker ([NAME: ...]) must survive byte-identically"})
            if protected_frontmatter(before_text) != protected_frontmatter(markdown):
                return self.reply(403, {"ok": False, "reason": "frontmatter-is-the-founders",
                                        "error": "owner, phase, published and status change outside this route"})
            if markdown.encode("utf-8") == before:
                return self.reply(400, {"ok": False, "reason": "no-change",
                                        "error": "the submitted article is already current", "sha": current_sha,
                                        "save": save_evidence(path, current_sha)})

            subject = one_sentence(body.get("subject"), "", limit=200)
            if not subject:
                subject = ("Save draft " + Path(path).name) if draft_path(path) else mechanical_subject(before_text, markdown)
            submitted = markdown.encode("utf-8")
            try:
                atomic_write(target, submitted)
            except OSError as error:
                return self.reply(500, {"ok": False, "reason": "write-failed",
                                        "error": "the article could not be written atomically: " + str(error)[:200]})
            try:
                gate = subprocess.run([str(REPO_ROOT / "check.sh"), "--writing-save", path], cwd=str(REPO_ROOT),
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, timeout=60)
            except (OSError, subprocess.TimeoutExpired) as error:
                atomic_write(target, before)
                return self.reply(422, {"ok": False, "reason": "gate-failed",
                                        "error": "the repository gate could not run",
                                        "stdout": str(error)})
            if gate.returncode != 0:
                atomic_write(target, before)
                return self.reply(422, {"ok": False, "reason": "gate-failed",
                                        "error": "the repository gate refused this save",
                                        "stdout": gate.stdout})

            author, trailers = session_commit(people)
            failure = ""
            try:
                committed = git("commit", *author,
                                "-m", subject, "-m", trailers, "--", path, timeout=40)
                if committed.returncode != 0:
                    failure = "git could not commit this save: " + committed.stderr.strip()[:300]
            except (OSError, subprocess.TimeoutExpired) as error:
                failure = "git could not run the commit: " + str(error)[:200]
            # The working file goes back only when no commit holds this text. A commit that
            # landed stays with its file, whatever happened after it.
            if failure and not self.committed(path, current_sha, submitted):
                atomic_write(target, before)
                return self.reply(500, {"ok": False, "reason": "commit-failed", "error": failure})
            sha = git("rev-parse", "HEAD").stdout.strip()
            media = served_media(piece_folder(path))
            answer = {"ok": True, "sha": sha, "versions": piece_versions(path, media),
                      "save": save_evidence(path, sha)}
            if SYNC["on"] and SYNC["push_pending"]:
                answer["push"] = "pending"
            return self.reply(200, answer)
        finally:
            SAY_LOCK.release()

    def committed(self, path, before_sha, data):
        """HEAD has moved past `before_sha` and holds exactly `data` at `path`."""
        try:
            head = git("rev-parse", "HEAD")
            if head.returncode != 0 or head.stdout.strip() == before_sha:
                return False
            shown = git_blob(path)
            return shown.returncode == 0 and shown.stdout == data
        except (OSError, subprocess.SubprocessError):
            return False




    def api_review(self):
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"error": "empty or oversized body"})
        try:
            note = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "the body is not JSON"})
        if not isinstance(note, dict):
            return self.reply(400, {"error": "the body must be one note object"})
        world = safe_world(note.get("world"))
        REVIEWS.mkdir(parents=True, exist_ok=True)
        target = REVIEWS / ("%s.json" % world)
        notes = []
        if target.exists():
            try:
                loaded = json.loads(target.read_text("utf-8"))
                if isinstance(loaded, list):
                    notes = loaded
            except ValueError:
                notes = []
        note["world"] = world
        notes.append(note)
        target.write_text(json.dumps(notes, indent=2, ensure_ascii=False) + "\n", "utf-8")
        return self.reply(200, {"saved": True, "count": len(notes), "file": target.name})

    def api_review_asset(self):
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"error": "empty or oversized body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "the body is not JSON"})
        if not isinstance(body, dict):
            return self.reply(400, {"error": "the body must be one asset object"})
        match = re.match(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)$", str(body.get("image") or ""))
        if not match:
            return self.reply(400, {"error": "the image must be a PNG or JPEG data URL"})
        try:
            image = base64.b64decode(match.group(2), validate=True)
        except (ValueError, base64.binascii.Error):
            return self.reply(400, {"error": "the image data is not valid base64"})
        ext = "png" if match.group(1) == "png" else "jpg"
        signature_ok = image.startswith(b"\x89PNG\r\n\x1a\n") if ext == "png" else image.startswith(b"\xff\xd8\xff")
        if not signature_ok or len(image) > 3 * 1024 * 1024:
            return self.reply(400, {"error": "the image is invalid or too large"})
        world = safe_world(body.get("world"))
        pin_id = re.sub(r"[^A-Za-z0-9_-]", "", str(body.get("pinId") or ""))[:80] or "pin"
        REVIEW_ASSETS.mkdir(parents=True, exist_ok=True)
        name = "%s-%s.%s" % (world, pin_id, ext)
        target = REVIEW_ASSETS / name
        target.write_bytes(image)
        return self.reply(200, {"saved": True, "path": "/reviews/assets/%s" % name, "bytes": len(image)})

    @file_errors
    def api_canvas_put(self):
        piece = safe_piece((self.query().get("piece") or [""])[0])
        if not piece:
            return self.reply(403, {"error": "that piece folder is outside the files sandbox source"})
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"error": "empty or oversized body"})
        try:
            canvas = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "the body is not JSON"})
        if not isinstance(canvas, dict) or not isinstance(canvas.get("nodes", []), list) or \
                not isinstance(canvas.get("edges", []), list):
            return self.reply(400, {"error": "the canvas must contain node and edge lists"})
        with FILES_LOCK:
            root = initialise_sandbox(piece)
            target = sandbox_path(root, "workspace.canvas")
            if target is None:
                return self.reply(403, {"error": "the canvas path leaves the piece folder"})
            query = self.query()
            named = (query.get("who") or [""])[0]
            who = writing_session(json.loads(named) if named.startswith(("[", '"')) else named)
            current = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else ""
            if "base" in query and (query["base"] or [""])[0] != current:
                return self.reply(409, {"saved": False, "error": "the workspace changed in Git; your unsaved copy stays in this browser"})
            sha = commit_files({target: raw}, "Save the workspace for " + root.name, who)
            entry = file_entry_for_sandbox(root, target, piece, "application/json")
        return self.reply(200, {"saved": True, "file": target.name, "bytes": len(raw), "entry": entry, "sha": sha, "version": hashlib.sha256(raw).hexdigest()})

    @file_errors
    def api_canvas_get(self):
        piece = safe_piece((self.query().get("piece") or [""])[0])
        if not piece:
            return self.reply(403, {"error": "that piece folder is outside the files sandbox source"})
        with FILES_LOCK:
            root = initialise_sandbox(piece)
            target = sandbox_path(root, "workspace.canvas")
            if target is None:
                return self.reply(403, {"error": "the canvas path leaves the piece folder"})
            raw = target.read_bytes() if target.is_file() else None
            if "state" in self.query():
                return self.reply(200, {"canvas": json.loads(raw) if raw else {"nodes": [], "edges": []},
                                        "version": hashlib.sha256(raw).hexdigest() if raw else ""})
        return self.reply(200, raw or b'{"nodes": [], "edges": []}')

    @file_errors
    def api_files_content(self):
        q = self.query()
        piece = safe_piece((q.get("piece") or [""])[0])
        if not piece:
            return self.reply(403, {"error": "that piece folder is outside the files sandbox source"})
        with FILES_LOCK:
            root = initialise_sandbox(piece)
            target = sandbox_path(root, (q.get("path") or [""])[0])
            if target is None:
                return self.reply(403, {"error": "that file path leaves the piece folder"})
            if not target.is_file():
                return self.reply(404, {"error": "there is no such file in the sandbox"})
            raw = target.read_bytes()
            content_type = sniff_upload(raw)
        return self.reply(200, raw, content_type)

    def files_body(self):
        raw = self.read_body()
        if raw is None:
            return None, (400, {"error": "empty or oversized body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, (400, {"error": "the body is not JSON"})
        if not isinstance(body, dict):
            return None, (400, {"error": "the body must be an object"})
        piece = safe_piece(body.get("piece"))
        if not piece:
            return None, (403, {"error": "that piece folder is outside the files sandbox source"})
        body["piece"] = piece
        try:
            body["session"] = writing_session(body.get("who"))
        except ValueError as error:
            return None, (400, {"error": str(error)})
        return body, None

    @file_errors
    def api_files_upload(self):
        body, error = self.files_body()
        if error:
            return self.reply(*error)
        match = re.match(r"^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$",
                         str(body.get("data") or ""))
        if not match:
            return self.reply(400, {"error": "the upload must be one base64 data URL"})
        try:
            blob = base64.b64decode(match.group(2), validate=True)
        except (ValueError, base64.binascii.Error):
            return self.reply(400, {"error": "the upload is not valid base64"})
        if not blob:
            return self.reply(400, {"error": "the upload is empty"})
        if len(blob) > MAX_UPLOAD:
            return self.reply(413, {"error": "the upload is larger than %d bytes" % MAX_UPLOAD})
        actual = sniff_upload(blob)
        declared = body.get("type") or match.group(1)
        if not compatible_type(declared, actual):
            return self.reply(415, {"error": "the file bytes are %s, not %s" % (actual, declared)})
        group = resource_group(actual)
        requested_group = str(body.get("group") or "").strip().lower()
        if requested_group and requested_group not in RESOURCE_GROUPS:
            return self.reply(400, {"error": "there is no such resource group"})
        if requested_group and requested_group != group:
            return self.reply(415, {"error": "that file belongs in %s" % group})
        name = canonical_name(body.get("name"), actual)
        if not name:
            return self.reply(403, {"error": "that filename leaves the piece folder"})
        with FILES_LOCK:
            root = initialise_sandbox(body["piece"])
            folder = sandbox_path(root, "materials/" + RESOURCE_GROUPS[group])
            if folder is None:
                return self.reply(403, {"error": "that resource group leaves the piece folder"})
            folder.mkdir(parents=True, exist_ok=True)
            target = unique_path(folder, name)
            if target is None or sandbox_path(root, target.relative_to(root).as_posix()) != target.resolve():
                return self.reply(403, {"error": "that upload path leaves the piece folder"})
            sha = commit_files({target: blob}, "Add " + name + " to " + root.name, body["session"])
            thumbnail = str(body.get("data")) if actual.startswith("image/") and len(blob) <= 200 * 1024 else None
            entry = file_entry_for_sandbox(root, target, body["piece"], actual, thumbnail)
            print("  files upload %s :: %s (%s)" % (root.name, target.relative_to(root), actual))
        return self.reply(200, {"saved": True, "entry": entry, "sha": sha})

    @file_errors
    def api_pieces_new(self):
        """POST {who, title}: a new article folder with its article.md, committed."""
        raw = self.read_body()
        if raw is None:
            return self.reply(400, {"error": "empty or oversized body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "the body is not JSON"})
        if not isinstance(body, dict):
            return self.reply(400, {"error": "the body must be an object"})
        try:
            session = writing_session(body.get("who"))
            with FILES_LOCK:
                folder, text = new_article(body.get("title"), session[0][0], datetime.date.today().isoformat())
                target = REPO_ROOT / "articles" / folder / "article.md"
                if target.parent.exists():
                    return self.reply(409, {"error": "that article folder already exists"})
                target.parent.mkdir(parents=True)
                try:
                    sha = commit_files({target: text.encode("utf-8")}, "Start " + folder, session)
                except BaseException:
                    # A refused save leaves no empty folder holding the number.
                    if target.parent.is_dir() and not any(target.parent.iterdir()):
                        target.parent.rmdir()
                    raise
        except ValueError as error:
            return self.reply(400, {"saved": False, "error": str(error)})
        print("  new article %s" % folder)
        path = target.relative_to(REPO_ROOT).as_posix()
        return self.reply(200, {"saved": True, "path": path, "folder": "articles/" + folder, "sha": sha,
                                "title": article_title(body.get("title"))})

    @file_errors
    def api_files_mkdir(self):
        body, error = self.files_body()
        if error:
            return self.reply(*error)
        name = str(body.get("name") or "").strip()
        if not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name:
            return self.reply(403, {"error": "that folder name would leave the piece folder"})
        with FILES_LOCK:
            root = initialise_sandbox(body["piece"])
            parent_text = str(body.get("parent") or "")
            parent = sandbox_path(root, parent_text, allow_root=True)
            target = sandbox_path(root, "/".join(filter(None, (parent_text, name))))
            if parent is None or target is None:
                return self.reply(403, {"error": "that path leaves the piece folder"})
            if not parent.exists() or not parent.is_dir():
                return self.reply(404, {"error": "the parent folder does not exist in the sandbox"})
            if target.exists() and not target.is_dir():
                return self.reply(409, {"error": "a file already has that name"})
            target.mkdir(exist_ok=True)
            sha = commit_files({target / ".gitkeep": b""}, "Create " + name + " in " + root.name, body["session"])
            print("  files mkdir %s :: %s" % (root.name, target.relative_to(root)))
        return self.reply(200, {"saved": True, "path": target.relative_to(root).as_posix(),
                                "folder": root.name, "sha": sha})

    @file_errors
    def api_files_move(self):
        body, error = self.files_body()
        if error:
            return self.reply(*error)
        with FILES_LOCK:
            root = initialise_sandbox(body["piece"])
            source = sandbox_path(root, body.get("source"))
            group = str(body.get("group") or "").strip().lower()
            if group:
                if group not in RESOURCE_GROUPS:
                    return self.reply(403, {"error": "that resource group does not exist"})
                if source is None:
                    return self.reply(403, {"error": "that move leaves the piece folder"})
                group_folder = sandbox_path(root, "materials/" + RESOURCE_GROUPS[group])
                if group_folder is None:
                    return self.reply(403, {"error": "that move leaves the piece folder"})
                group_folder.mkdir(parents=True, exist_ok=True)
                destination = sandbox_path(root, "materials/%s/%s" % (RESOURCE_GROUPS[group], source.name))
            else:
                destination = sandbox_path(root, body.get("destination"))
            if source is None or destination is None:
                return self.reply(403, {"error": "that move leaves the piece folder"})
            if not source.exists():
                return self.reply(404, {"error": "the source does not exist in the sandbox"})
            if group and source.is_dir():
                return self.reply(403, {"error": "only a file can move into a resource group"})
            actual_group = resource_group(sniff_upload(source.read_bytes())) if group else None
            if group and actual_group != group:
                return self.reply(415, {"error": "the file bytes belong in %s" % actual_group})
            if source == destination:
                return self.reply(200, {"saved": True, "path": source.relative_to(root).as_posix(),
                                        "folder": root.name, "sha": git("rev-parse", "HEAD").stdout.strip()})
            if destination.exists():
                return self.reply(409, {"error": "the destination already exists"})
            if source.is_dir() and source in destination.parents:
                return self.reply(403, {"error": "a folder cannot be moved inside itself"})
            if not destination.parent.exists() or not destination.parent.is_dir():
                return self.reply(404, {"error": "the destination folder does not exist in the sandbox"})
            paths = sorted(source.rglob("*")) if source.is_dir() else [source]
            if any(path.is_symlink() for path in paths):
                return self.reply(403, {"error": "a move cannot contain a symlink"})
            if source == root / "article.md" or source == root / "workspace.canvas" or source == root / "review":
                return self.reply(403, {"error": "that file is required by the writing app"})
            changes = {}
            for path in paths:
                if path.is_file():
                    next_path = destination / path.relative_to(source) if source.is_dir() else destination
                    changes[path] = None
                    changes[next_path] = path.read_bytes()
            sha = commit_files(changes, "Move " + source.name + " to " + destination.relative_to(root).as_posix(),
                               body["session"], move=(source, destination))
            print("  files move %s :: %s -> %s" % (
                root.name, source.relative_to(root), destination.relative_to(root)))
        return self.reply(200, {"saved": True, "path": destination.relative_to(root).as_posix(),
                                "folder": root.name, "sha": sha})

    @file_errors
    def api_files_order(self):
        body, error = self.files_body()
        if error:
            return self.reply(*error)
        order = body.get("order")
        if not isinstance(order, list) or any(
                not isinstance(name, str) or not name or name in (".", "..") or
                "/" in name or "\\" in name or "\x00" in name for name in order):
            return self.reply(403, {"error": "the order contains a path outside its folder"})
        with FILES_LOCK:
            root = initialise_sandbox(body["piece"])
            folder_text = str(body.get("folder") or "")
            folder = sandbox_path(root, folder_text, allow_root=True)
            if folder is None:
                return self.reply(403, {"error": "that order file leaves the piece folder"})
            if not folder.exists() or not folder.is_dir():
                return self.reply(404, {"error": "the ordered folder does not exist in the sandbox"})
            target = sandbox_path(root, "/".join(filter(None, (folder_text, ".order"))))
            if target is None:
                return self.reply(403, {"error": "that order file leaves the piece folder"})
            sha = commit_files({target: (json.dumps(order, ensure_ascii=False, indent=2) + "\n").encode("utf-8")},
                               "Order the files in " + root.name, body["session"])
            print("  files order %s :: %s" % (root.name, target.relative_to(root)))
        return self.reply(200, {"saved": True, "count": len(order), "folder": root.name, "sha": sha})

    def api_share_article(self):
        """Founder-only article access list and named-email invitation, never anonymous access."""
        if getattr(self, "reviewer", None):
            return self.reply(403, {"error": "Only a founder can manage sharing."})
        principal = getattr(self, "_writer_principal", None)
        if not principal:
            host = (self.headers.get("Host") or "").strip().lower()
            origin = (self.headers.get("Origin") or "").strip().lower()
            if host not in SHARE["hosts"] or origin not in {"http://" + host, "https://" + host} | SHARE["origins"]:
                return self.reply(403, {"error": "Open Share from the writing app's own page."})
        if (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
            return self.reply(415, {"error": "Send sharing details as JSON."})
        try:
            body = json.loads(self.read_body() or b"")
        except (ValueError, UnicodeError):
            body = None
        if not isinstance(body, dict): return self.reply(400, {"error": "Invalid sharing request."})
        who = body.get("who")
        # Same founder boundary as admin-link: a trusted local founder, or the signed writer.
        if not isinstance(who, str) or who not in AUTHORS or principal and who != principal:
            return self.reply(403, {"error": "Only the signed-in founder can manage sharing."})
        if not SHARE["url"]:
            return self.reply(404, {"error": "Sharing is not set up on this server. Ask your agent to configure the reader connection."})
        path = body.get("path")
        if not isinstance(path, str) or not article_path(path): return self.reply(400, {"error": "Choose an article to share."})
        try:
            target = (REPO_ROOT / path).resolve()
            target.relative_to(REPO_ROOT.resolve())
            owner = share_owner(target.read_text("utf-8"))
        except (ValueError, OSError):
            return self.reply(404, {"error": "This article is not available for sharing."})
        action = body.get("action")
        if action not in ("read", "invite"): return self.reply(400, {"error": "Unknown sharing action."})
        outgoing = {"path": path, "founder": who, "action": action}
        if action == "invite":
            if path.startswith(SHARE_TEST_PIECE) or not share_allowed(owner, [who]):
                return self.reply(403, {"error": "Only the owner can share this article."})
            label, email = body.get("label"), body.get("email")
            if not isinstance(label, str) or not label.strip() or len(label) > 60 or not isinstance(email, str) or len(email) > 254 or not EMAIL_RE.fullmatch(email.strip().lower()):
                return self.reply(400, {"error": "Enter a name and a valid email address."})
            outgoing.update(label=label.strip(), email=email.strip().lower())
        if not SHARE["ready"]:
            SHARE_WAKE.set()
            return self.reply(503, {"error": "The reader connection is starting. Try again in a moment."})
        try:
            answer = share_call("POST", "/sync/sharing", outgoing)
        except ShareError:
            return self.reply(502, {"error": "Sharing could not be loaded. Try again, or check the reader connection."})
        if not isinstance(answer, dict): return self.reply(502, {"error": "The reader connection returned an invalid answer."})
        if action == "invite":
            if not re.fullmatch(re.escape(SHARE["url"]) + r"/join/[A-Za-z0-9_-]{43}", str(answer.get("url", ""))):
                return self.reply(502, {"error": "The reader connection returned an invalid link."})
            # Never take SHARE_LOCK while writer dispatch holds WRITE_LOCK: the
            # background pull takes them in the opposite order. Let it send the
            # newly shared text after this request has released the save lock.
            SHARE_WAKE.set()
            answer["warning"] = "Comment link ready. The article is syncing to the reader site. Copy the link before closing."
        return self.reply(200, answer)

    def api_share_admin_link(self):
        """A one-time link into Descant's dashboard for one founder, minted by Descant on request.

        Only the founders' listeners route here (ReviewerHandler refuses every POST but
        /api/comments). The body names the founder by their key in people.json; Descant
        answers with a link that works once, for five minutes.

        The request must name this server by one of its own host names (no DNS rebinding: a
        page on another site that rebinds its name to this address still sends that name) and
        come from this app's own page (its Origin). What it does NOT establish is which founder
        is asking: anyone who can reach the founders' listener, which means anyone on the tailnet,
        may ask for either founder's link, exactly as they may save as either founder. Tailnet
        membership is the founder check; "never another founder's article" guards against a
        mistake, not against the other founder."""
        if not SHARE["url"]:
            return self.reply(404, {"ok": False, "reason": "sharing-off",
                                    "error": "Sharing is off on this server: it was started without --share-to."})
        host = (self.headers.get("Host") or "").strip().lower()
        origin = (self.headers.get("Origin") or "").strip().lower()
        if host not in SHARE["hosts"] or origin not in {"http://" + host, "https://" + host} | SHARE["origins"]:
            return self.reply(403, {"ok": False, "reason": "not-this-app",
                                    "error": "Ask from the writing app's own page."})
        kind = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if kind != "application/json":
            return self.reply(415, {"ok": False, "reason": "json-only", "error": "send the founder as application/json"})
        raw = self.read_body()
        try:
            body = json.loads((raw or b"").decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            body = None
        who = str((body or {}).get("who") or "").strip().lower() if isinstance(body, dict) else ""
        if who not in AUTHORS:
            return self.reply(400, {"ok": False, "reason": "invalid-who",
                                    "error": "who must be a founder named in people.json"})
        try:
            if not SHARE["ready"]:
                share_cycle()                   # Descant learns the founders from a push
            answer = share_call("POST", "/sync/admin-link", {"founder": who})
        except ShareError as error:
            return self.reply(502, {"ok": False, "reason": "descant-unreachable", "error": str(error)})
        except Exception as error:              # a first cycle that failed for another reason
            print("  descant: the first exchange failed: %s: %s" % (type(error).__name__, str(error)[:200]))
            return self.reply(502, {"ok": False, "reason": "descant-failed",
                                    "error": "The first exchange with Descant failed; the server log says why."})
        url = str((answer or {}).get("url") or "") if isinstance(answer, dict) else ""
        if not re.fullmatch(re.escape(SHARE["url"]) + r"/founder/[A-Za-z0-9_-]{43}", url):
            return self.reply(502, {"ok": False, "reason": "descant-answer",
                                    "error": "Descant answered with something that is not one of its links."})
        return self.reply(200, {"ok": True, "url": url})


class ReviewerHandler(Handler):
    """The listener an outside reviewer reaches, and everything they can reach.

    main() binds it to 127.0.0.1 and nowhere else; the Cloudflare tunnel connects there.
    Every request is identified first, and anything not named in the routes below is
    refused, so a route added to Handler later stays the founders' until someone adds
    it here on purpose.

    A reviewer may open the review page (the synthetic sample build, which carries no
    article and no history), list and read the pieces shared with them with their
    saves, read those pieces' review threads, start a thread and reply to one. They
    may not save text, change or close a thread, or use Files, Assist, the agent,
    history, authorship, the canvas, undo, the design-review notes, or any other route.
    """

    reviewer = None
    fresh = 0

    # ---------------------------------------------------------------- identity

    def reviewer_id(self):
        return 'reviewer-' + hashlib.sha256(self.reviewer['email'].encode()).hexdigest()

    def identify(self):
        values = [str(value).strip().lower() for value in (self.headers.get_all(REVIEWER_HEADER) or [])]
        if not values:
            return None, "no %s header" % REVIEWER_HEADER
        if len(set(values)) != 1 or not EMAIL_RE.match(values[0]):
            return None, "the identity header is not one plain address"
        table = load_reviewers()
        if table is None:
            return None, "the access list %s is missing, unreadable or malformed" % reviewers_file()
        if not table.get(values[0]):
            return None, "%s is not on the access list (or its record is invalid)" % values[0]
        return dict(table[values[0]], email=values[0]), None

    def admitted(self):
        self.reviewer, why = self.identify()
        if self.reviewer is None:
            print("  reviewer refused: %s" % why)
            self.refuse(403, "not-a-reviewer",
                        "You are not on the list of reviewers for this site. Ask the person "
                        "who invited you to add the address you signed in with.")
            return False
        return True

    # ---------------------------------------------------------------- plumbing

    def log_message(self, fmt, *args):
        name = self.reviewer["name"] if self.reviewer else "-"
        print("  reviewer %s %s %s" % (name, self.command or "-", (self.path or "-").split("?")[0]))

    def end_headers(self):
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def reply(self, code, payload, content_type="application/json; charset=utf-8"):
        # A failure deeper in the app (the repository gate, git, a thread that will not
        # parse) can quote files the reviewer must not see. They get the fact of it; the
        # detail goes to the server's log, where the founders can read it.
        if code >= 422 and code != 503 and isinstance(payload, dict):
            print("  reviewer %s: %s %s" % (self.reviewer and self.reviewer["name"], code,
                                            str(payload.get("error"))[:800]))
            payload = {"ok": False, "reason": payload.get("reason") or "failed",
                       "error": "The server could not do that. The founders can see why in its log."}
        return Handler.reply(self, code, payload, content_type)

    def refuse(self, code, reason, message):
        if urlparse(self.path or "").path.startswith("/api/"):
            return Handler.reply(self, code, {"ok": False, "reason": reason, "error": message})
        return Handler.reply(self, code, message.encode("utf-8"), "text/plain; charset=utf-8")

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ------------------------------------------------------------------ routes

    def do_GET(self):
        if not self.admitted():
            return None
        parsed = urlparse(self.path or "")
        route = parsed.path
        if route.startswith("/api/"):
            if route not in ("/api/whoami", "/api/pieces", "/api/piece", "/api/comments"):
                return self.refuse(403, "reviewer-refused", "a reviewer cannot use this")
            sync_pull()
            if route == "/api/whoami":
                return self.reply(200, {"role": "reviewer", "name": self.reviewer["name"], "id": self.reviewer_id()})
            if route == "/api/pieces":
                return self.api_pieces()
            if route == "/api/piece":
                return self.api_piece()
            return self.api_comments()
        if route in ("/", "/index.html"):
            if not self.reviewer["pieces"]:
                return self.refuse(403, "nothing-shared", "Nothing has been shared with you to review yet.")
            return self.redirect("/review/?live=" + quote(self.reviewer["pieces"][0], safe="/"))
        if route == "/review":
            query = parsed.query if re.fullmatch(r"[A-Za-z0-9._~%/=&+-]*", parsed.query) else ""
            return self.redirect("/review/" + ("?" + query if query else ""))
        if route in ("/review/", "/review/index.html"):
            # The built world pages carry the article and its history inside them, so a
            # reviewer is only ever given the SAMPLE build, which carries neither, and the
            # page reads the shared piece live through the routes above.
            self._cached_headers_sent = False
            if SAMPLE_PAGE.is_file() and self.static_hit(str(SAMPLE_PAGE)):
                return None
            print("  reviewer page missing: build it with "
                  "python3 design/app/build.py --sample --world typewell")
            return self.refuse(503, "not-built", "The review page is not ready on this server yet.")
        asset = reviewer_asset(route)
        if asset:
            self._cached_headers_sent = False
            if self.static_hit(asset):
                return None
        return self.refuse(404, "not-found", "Not found.")

    def do_POST(self):
        if not self.admitted():
            return None
        route = urlparse(self.path or "").path
        if route != "/api/comments":
            return self.refuse(403 if route.startswith("/api/") else 404,
                               "reviewer-refused", "a reviewer cannot use this")
        # Only the review page itself can post. A form or a no-cors fetch from another
        # site cannot send application/json without a CORS preflight, which this server
        # never answers; a browser also says outright when a request is cross-site.
        kind = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if kind != "application/json":
            return self.refuse(415, "json-only", "comments are sent as application/json")
        if (self.headers.get("Sec-Fetch-Site") or "same-origin").lower() not in ("same-origin", "none"):
            return self.refuse(403, "cross-site", "a comment can only come from the review page itself")
        sync_pull(force=True)
        self.fresh = 0
        return self.api_comments_write()

    def do_PUT(self):
        sync_pull(force=True)
        if not self.admitted():
            return None
        return self.refuse(403, "reviewer-refused", "a reviewer cannot use this")

    def do_HEAD(self):
        # SimpleHTTPRequestHandler's HEAD would answer for any file under design/app.
        self.send_response(405)
        self.send_header("Allow", "GET, POST")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ------------------------------------------------- the hooks, narrowed

    def may_read(self, path):
        return path in self.reviewer["pieces"]

    def piece_locked(self, path):
        return True                             # a reviewer never saves text

    def live_files(self, piece_name):
        return []                               # materials/ and the Files sandbox stay the founders'

    def comment_identity(self, body):
        # The body's `who` is ignored: a reviewer is who the access list says they are.
        person = self.reviewer
        if body.get('reviewer_id') != self.reviewer_id():
            return None, (403, {"ok": False, "reason": "reviewer-identity-mismatch", "error": "Sign in as the original reader to send these comments. Your words stay on this device."})
        return {"author": ["--author", "%s <%s>" % (person["name"], person["email"])],
                "subject": "Comments from %s, a reviewer, on %%s" % person["name"],
                "trailers": "Principal: %s\nActor: reviewer %s\nBasis: review"
                            % (person["invited_by"], person["name"]),
                "source": "reviewer"}, None

    def count_fresh(self, number):
        self.fresh += number
        if self.fresh > REVIEW_FRESH_MAX:
            raise CommentRefused(413, "too-many", "that is more than %d new comments and "
                                                  "replies in one save" % REVIEW_FRESH_MAX)

    def comment_thread(self, submitted, identifier, previous=None, projected=None):
        # Every message the reviewer sends is rewritten as theirs and human below.
        thread = self.comment_base(submitted, identifier, previous)
        name = self.reviewer["name"]
        now = datetime.datetime.now(datetime.timezone.utc)
        if previous is None:
            # A new thread is wholly the reviewer's: their name, open, dated by the
            # server, and no note or re-anchoring record, which only the founders keep.
            anchor = {key: reviewer_string(value, REVIEW_ANCHOR_MAX, "the quoted passage")
                      for key, value in thread["anchor"].items()}
            thread.pop("writer", None)
            thread.pop("messageRef", None)
            thread.update(anchor=anchor, author=name, by="human",
                          text=reviewer_message(thread["text"]),
                          created=now.isoformat(timespec="seconds"), status="open", done=False,
                          note="", reanchoredFrom="",
                          refersTo=reviewer_string(thread["refersTo"], 500, "what the comment points at"))
            fresh, thread["replies"] = thread["replies"], []
            self.count_fresh(1)
        else:
            # The browser echoes the current action projection. Check it exactly,
            # then append to the raw originals, without persisting display state.
            expected = self.comment_base(projected, identifier, previous) if projected is not None else previous
            kept = expected["replies"]
            head = {key: value for key, value in thread.items() if key != "replies"}
            was = {key: value for key, value in expected.items() if key != "replies"}
            if head != was or thread["replies"][:len(kept)] != kept:
                raise CommentRefused(403, "reviewer-cannot-edit",
                                     "A reviewer can start a comment or add a reply. What is "
                                     "already written stays as it is.")
            fresh = thread["replies"][len(kept):]
            thread = dict(previous, replies=list(previous["replies"]))
        self.count_fresh(len(fresh))
        for reply in fresh:
            thread["replies"].append({**reply_identity(reply), "author": name, "text": reviewer_message(reply["text"]),
                                      "created": now.date().isoformat(), "by": "human",
                                      "basis": "", "offer": None})
        return thread

    def comment_render(self, document, thread, before=None):
        if before is None:
            data = Handler.comment_render(self, document, thread)
        else:
            # A reply is APPENDED to the file, never a re-render of it, so a reviewer's
            # commit on a founder's thread is pure additions, which is what a founder
            # checking it needs to see at a glance. (A re-render also restyles the file.)
            old = before.decode("utf-8")
            count = len(comment_document(None, old)["thread"]["replies"])
            lines = []
            for reply in thread["replies"][count:]:
                lines.extend(message_lines(reply, thread["created"]))
            data = (old.rstrip("\n") + "\n" + "\n".join(lines) + "\n").encode("utf-8")
        try:
            back = comment_document(None, data.decode("utf-8"))["thread"]
        except ValueError:
            back = None
        if back != thread:
            raise CommentRefused(422, "not-stored-as-written",
                                 "the comment could not be stored exactly as written")
        return data


# ------------------------------------------------------------ sharing with Descant
#
# --share-to <url> connects this server to Descant (design/app/reviewers/), the public Worker
# where outside readers read and comment on what a founder shared with them by name. The
# connection only goes OUT from here: a background thread, every SHARE_EVERY seconds and
# within a few seconds of any commit that touches a shared article or its threads, runs
# share_cycle():
#
#   1. GET  /sync/state              which articles are shared, and the comment cursor
#   2. POST /sync/push               every article's metadata (no text); for SHARED articles
#                                    only, the Markdown as HEAD holds it, its version, and the
#                                    threads readers started there with all their replies
#   3. GET  /sync/comments?after=N   readers' new comments and replies; each is written into the
#                                    article's review/ files with the comment-store functions
#                                    above and committed per reader and article, the reader as
#                                    author, Principal the article's owner (the first writer when unassigned),
#                                    Actor human, Basis review, one Descant-Comment trailer per id
#   4. POST /sync/ack                the ids now in the repository (and any that cannot be), then
#                                    one more push so the reader sees the stored copy
#
# A comment id already in a Descant-Comment trailer is never written again, so a retry after a
# lost acknowledgement does not duplicate it. A reader's thread file carries
# `source: descant:<thread id>`, which is how a reply finds its thread and how a thread is
# known to be a reader's. The token is read from CASTOR_SHARE_TOKEN_FILE, else the space's
# shareTokenFile (space_config.py), else the default below; it must sit outside the repository; it is sent only to the --share-to origin, never
# across a redirect, and never printed.

SHARE_TOKEN_DEFAULT = "~/.config/descant/share-token"
SHARE_EVERY = 30                                # seconds between cycles when nothing moves
SHARE_TICK = 2                                  # how often HEAD is looked at
SHARE = {"url": "", "error": "", "ready": False, "shared": None, "allowed": set(), "held": None, "hosts": set(), "origins": set()}
SHARE_LOCK = threading.Lock()                   # one cycle at a time
SHARE_WAKE = threading.Event()
SHARE_TEST_PIECE = "articles/99-test-piece/"
SHARE_USER_AGENT = "castor-writing-app/1"
DESCANT_SOURCE_RE = re.compile(r"^descant:(\d{1,16})$")
DESCANT_ID_RE = re.compile(r"^c[0-9a-f]{32}$")
DESCANT_TRAILER_RE = re.compile(r"^Descant-Comment:\s*(c[0-9a-f]{32})\s*$", re.M)
DESCANT_THREAD_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")
DESCANT_REPLY_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# What a reader may send, bounded as Descant bounds it (design/app/reviewers/src/worker/rules.ts).
DESCANT_LIMITS = {"quote": 500, "prefix": 200, "suffix": 200, "blockText": 2000, "version": 64}
DESCANT_TEXT_MAX = 5000
# Internal notes, in the grammar the reader page hides (engine/md.js): %%a writer note%%, a marker
# addressed to people in capitals ([NAME: ...], **[WRITERS: ...]**), and HTML comments.
NOTE_SPAN_RE = re.compile(r"%%[\s\S]*?%%")
NOTE_MARKER_RE = re.compile(r"(\*\*)?(?<!\[)\[[A-Z][A-Z0-9 ]+:[^\]\n]*\](\*\*)?")
NOTE_HTML_RE = re.compile(r"<!--[\s\S]*?-->")
NOTE_LEFT_RE = re.compile(r"%%|<!--|(^|[^\[])\[[A-Z][A-Z0-9 ]+:", re.M)
FRONTMATTER_RE = re.compile(r"\A---\n[\s\S]*?\n---\n")
# Letters that look like Latin ones, and the digits people use for letters: a reader's name is
# compared with the founders' as it looks, not as it is spelled.
LOOKALIKE = {
    "а": "a", "в": "b", "е": "e", "ё": "e", "з": "3", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c",
    "т": "t", "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "һ": "h",
    "ӏ": "l", "ɑ": "a", "ɡ": "g", "ı": "i", "ȷ": "j", "ℓ": "l", "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i",
    "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "0": "o", "1": "i", "3": "e",
    "4": "a", "5": "s", "7": "t", "8": "b",
}
SHARE_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{32,256}$")


class ShareError(Exception):
    """Descant could not be reached, or answered with something unusable. Never carries the token."""


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None                             # the token never follows a redirect anywhere


def share_target(value):
    """The Worker's origin: https, or http on this machine's loopback only (the tests' stub)."""
    parsed = urlparse(str(value or "").strip())
    local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
    if not ((parsed.scheme == "https" and parsed.hostname) or local) or parsed.username or \
            parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("--share-to takes an https origin, such as https://reader.example.com")
    return "%s://%s" % (parsed.scheme, parsed.netloc)


def share_token_file():
    return Path(os.environ.get("CASTOR_SHARE_TOKEN_FILE") or space_config.value("shareTokenFile") or SHARE_TOKEN_DEFAULT).expanduser()


def share_token():
    path = share_token_file().resolve()
    if path == REPO_ROOT or REPO_ROOT in path.parents:
        raise ShareError("the share token file is inside the repository, so it is not used")
    try:
        token = path.read_text("utf-8").strip()
    except (OSError, UnicodeError):
        raise ShareError("the share token file %s cannot be read" % path)
    if not SHARE_TOKEN_RE.match(token):
        raise ShareError("the share token file %s does not hold one token" % path)
    return token


def share_call(method, route, body=None, timeout=25):
    """One request to Descant with the token; the parsed JSON answer, or ShareError."""
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(SHARE["url"] + route, data=data, method=method)
    request.add_header("Authorization", "Bearer " + share_token())
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", SHARE_USER_AGENT)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    where = "%s %s" % (method, route.split("?", 1)[0])
    try:
        with urllib.request.build_opener(_RefuseRedirects).open(request, timeout=timeout) as response:
            raw = response.read(32 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        raise ShareError("%s answered %d" % (where, error.code))
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise ShareError("%s failed: %s" % (where, str(getattr(error, "reason", error))[:160]))
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ShareError("%s did not answer with JSON" % where)


def share_action_call(body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SHARE["url"] + "/sync/action", data=data, method="POST")
    req.add_header("Authorization", "Bearer " + share_token())
    req.add_header("User-Agent", SHARE_USER_AGENT)
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.build_opener(_RefuseRedirects).open(req, timeout=25) as response:
            return json.loads(response.read(1024 * 1024).decode())
    except urllib.error.HTTPError as error:
        try: answer = json.loads(error.read(1024 * 1024).decode())
        except (ValueError, UnicodeError): raise ShareError("shared action refused")
        answer["httpStatus"] = error.code
        return answer
    except (urllib.error.URLError, OSError, ValueError): raise ShareError("shared action did not answer")


def share_frontmatter(markdown):
    head = {}
    if markdown.startswith("---"):
        end = markdown.find("\n---", 3)
        if end > 0:
            for line in markdown[3:end].split("\n"):
                if ":" in line:
                    key, _, value = line.partition(":")
                    head.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return head


def share_articles():
    """[(path, markdown)] for every article.md git HEAD holds."""
    listed = git("ls-tree", "-r", "--name-only", "HEAD", "articles")
    out = []
    for path in (listed.stdout.splitlines() if listed.returncode == 0 else []):
        if not ARTICLE_RE.fullmatch(path):
            continue
        blob = git_blob(path)
        if blob.returncode == 0:
            try:
                out.append((path, blob.stdout.decode("utf-8")))
            except UnicodeDecodeError:
                continue
    return out


def descant_threads(path):
    """The threads readers started on one article, each with every reply, as the files read."""
    folder = piece_folder(path) / "review"
    out = []
    for target in comment_files(folder):
        try:
            document = comment_document(target)
        except (OSError, UnicodeError, ValueError):
            continue
        found = DESCANT_SOURCE_RE.match(document["source"])
        if found:
            out.append({"descant": found.group(1), "thread": document["thread"]})
    return out


def share_owner(markdown):
    """The article's owner as the founders' own gate reads it (anchored frontmatter lines only):
    a writer key, both, unassigned, "" when there is none, and "ambiguous" when the frontmatter says
    it more than once, which nobody may share."""
    owners = protected_frontmatter(markdown)["owner"]
    if len(owners) > 1:
        return "ambiguous"
    return owners[0].strip().strip('"').strip("'").lower() if owners else ""


def share_allowed(owner, granters):
    """Whether an article may leave: someone granted it, and its CURRENT owner allows every one
    of the founders who did (their own article, or one owned by both or by nobody). The same rule
    Descant applies when a link is made, applied here again where the truth lives."""
    if not granters or any(g not in AUTHORS for g in granters):
        return False
    if owner in ("", "unassigned", "both"):
        return True
    return all(g == owner for g in granters)


def share_public_text(markdown):
    """The article as an outside reader may have it: only subtitle metadata, no %%writer notes%%, no
    founder markers, no HTML comments. None when anything of the kind is left (an unclosed note),
    so the article does not leave at all."""
    header = FRONTMATTER_RE.match(markdown)
    subtitle = ""
    if header:
        line = re.search(r"^subtitle:[ \t]*(.*)$", header.group(0), re.M)
        if line:
            value = line[1].strip()
            try:
                value = json.loads(value)
            except ValueError:
                value = value.strip("'\"").replace("''", "'")
            if isinstance(value, str) and not re.search(r"[\r\n\x00-\x1f]", value):
                subtitle = value
    text = FRONTMATTER_RE.sub("", markdown, count=1)
    text = NOTE_HTML_RE.sub("", text)
    text = NOTE_SPAN_RE.sub("", text)
    text = NOTE_MARKER_RE.sub("", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip("\n") + "\n"
    if NOTE_LEFT_RE.search(text) or NOTE_LEFT_RE.search(subtitle):
        return None
    return ("---\nsubtitle: " + json.dumps(subtitle, ensure_ascii=False) + "\n---\n\n" if subtitle else "") + text


def share_payload(shared, granted):
    """What Descant may hold, and the articles allowed to leave.

    Every article's metadata goes; text and reader threads go only for an article that Descant
    lists as shared AND whose current owner allows every founder who granted it, and only with
    the internal notes taken out. Returns (payload, allowed paths)."""
    build = build_module()
    articles, texts, allowed, held = [], [], set(), []
    for path, markdown in share_articles():
        head = share_frontmatter(markdown)
        owner = share_owner(markdown)
        folder = Path(path).parent.name
        try:
            order = int(head.get("order", "0"))
        except ValueError:
            order = 0
        articles.append({
            "path": path,
            "title": (build.frontmatter_title(markdown, folder) if build else None) or head.get("title") or folder,
            "owner": owner, "status": head.get("status", ""),
            "phase": head.get("phase", ""), "order": order,
        })
        if path not in shared or path.startswith(SHARE_TEST_PIECE):
            continue
        public = share_public_text(markdown)
        if not share_allowed(owner, granted.get(path) or []) or public is None:
            held.append(path)
            continue
        allowed.add(path)
        log = git("log", "-1", "--date=short", "--format=%H%x1f%ad", "--", path)
        sha, _, when = log.stdout.strip().partition("\x1f")
        texts.append({"path": path, "markdown": public, "version": {"sha": sha, "when": when},
                      "threads": descant_threads(path)})
    if held != SHARE.get("held"):
        SHARE["held"] = held
        if held:
            print("  descant: held back, its owner does not allow every grant or a note will not come out: %s"
                  % ", ".join(held))
    founders = [{"key": key, "name": identity.split("<", 1)[0].strip(),
                 "emailSha256": hashlib.sha256(founder_email(identity).encode("utf-8")).hexdigest()}
                for key, identity in sorted(AUTHORS.items())]
    return {"founders": founders, "articles": articles, "shared": texts}, allowed


def founder_email(identity):
    found = re.search(r"<([^<>]+)>", identity)
    return found.group(1).strip().lower() if found else ""


def name_words(name):
    """A name reduced to plain lowercase Latin letters, in words (rules.ts nameWords)."""
    folded = "".join(LOOKALIKE.get(ch, ch) for ch in unicodedata.normalize("NFKC", name).lower())
    folded = "".join(ch for ch in unicodedata.normalize("NFKD", folded) if not unicodedata.category(ch).startswith("M"))
    folded = "".join(LOOKALIKE.get(ch, ch) if ch.isdigit() else ch for ch in folded)
    return [word for word in re.split(r"[^a-z]+", folded) if word]


def looks_like_founder(name):
    """Whether a reader's name reads as a founder's: the whole name, any word of it, or an initial
    and a surname, against each founder's key, first name, full name and initial plus surname."""
    names = {"both"}
    for key, identity in AUTHORS.items():
        names.add("".join(name_words(key)))
        words = name_words(identity.split("<", 1)[0])
        if words:
            names.update([words[0], "".join(words)])
            if len(words) > 1:
                names.add(words[0][0] + words[-1])
    names.discard("")
    words = name_words(name)
    if not words:
        return False
    if "".join(words) in names or any(word in names for word in words):
        return True
    return any(words[i][0] + words[j] in names for i in range(len(words)) for j in range(i + 1, len(words)))


def descant_known_ids():
    """Every Descant comment id already recorded in a commit trailer."""
    out = git("log", "--format=%B%x00", "-E", "--grep=^Descant-Comment: c[0-9a-f]{32}", "HEAD", timeout=60)
    return set(DESCANT_TRAILER_RE.findall(out.stdout)) if out.returncode == 0 else set()


def descant_reader(comment):
    """(name, email) of a comment's reader, or None when either could not be signed in a file."""
    author = comment.get("author") if isinstance(comment.get("author"), dict) else {}
    name = str(author.get("name") or "").strip()
    email = str(author.get("email") or "").strip().lower()
    if not REVIEWER_NAME_RE.fullmatch(name) or UNSAFE_CHARS_RE.search(name) or \
            name.lower() in founder_names() or looks_like_founder(name) or not EMAIL_RE.fullmatch(email):
        return None
    if email in {founder_email(identity) for identity in AUTHORS.values()}:
        return None                             # a reader never signs a commit as a founder
    return name, email


def descant_refused_ids():
    out = git("log", "--format=%B", "--grep=^Descant-Refused: ", "HEAD", timeout=60)
    return set(re.findall(r"^Descant-Refused: (c[0-9a-f]{32})$", out.stdout, re.M)) if out.returncode == 0 else set()


def descant_refuse(comment, reason):
    """Keep the exact refused input and reason in Git before acknowledging it."""
    path = article_path(str(comment.get("path") or ""))
    piece = str(Path(path).parent) if path else ""
    folder = sandbox_path(REPO_ROOT, piece) if safe_piece(piece) else None
    if folder is None:
        folder = REPO_ROOT / "articles/refused-reader-comments"
    target = sandbox_path(REPO_ROOT, (folder / "review" / ("refused-" + comment["id"] + ".md")).relative_to(REPO_ROOT).as_posix())
    if target is None:
        return False
    # JSON escapes newlines and control characters in untrusted fields and keeps their bytes reversible.
    written = {key: comment[key] for key in ("id", "path", "thread", "kind", "created", "text", "anchor", "refersTo") if key in comment}
    author = comment.get("author") if isinstance(comment.get("author"), dict) else {}
    written["claimedName"] = author.get("name", "")
    # Account identifiers stay in the account store; the full written comment stays here.
    record = {"reason": reason, "comment": written}
    data = ("# Refused reader comment\n\n" + reason + "\n\n" +
            "    " + json.dumps(record, ensure_ascii=True) + "\n").encode("utf-8")
    owner = share_owner((REPO_ROOT / path).read_text("utf-8")) if path and (REPO_ROOT / path).is_file() else default_owner()
    try:
        with COMMENTS_LOCK:
            commit_files({target: data}, "Keep a refused reader comment for " + folder.name,
                         trailers="Principal: %s\nActor: descant-import\nBasis: review\nDescant-Refused: %s" %
                                  (owner or default_owner(), comment["id"]))
        return True
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False                            # no acknowledgement until the file reaches Git


def descant_store(comments):
    """Write readers' comments into the review files. Returns (stored ids, refused ids).

    Grouped per article and reader, one commit each. An id already in a trailer counts as
    stored without being written again. A group that cannot be committed (the gate, git) is
    left for the next cycle and neither stored nor refused."""
    known = descant_known_ids()
    known_refused = descant_refused_ids()
    stored, refused = [], []
    groups = {}
    for comment in comments:
        identifier = str(comment.get("id") or "")
        if not DESCANT_ID_RE.match(identifier):
            continue
        if identifier in known:
            stored.append(identifier)
            continue
        if identifier in known_refused:
            refused.append(identifier)
            continue
        path = article_path(str(comment.get("path") or ""))
        reader = descant_reader(comment)
        # Only an article shared and allowed to leave at this moment takes readers' comments.
        if not path or path not in (SHARE.get("allowed") or set()) or not (REPO_ROOT / path).is_file() or reader is None:
            print("  descant: comment %s refused: its article or its reader cannot be recorded" % identifier)
            if descant_refuse(comment, "its article or its reader cannot be recorded"):
                refused.append(identifier)
            continue
        groups.setdefault((path,) + reader, []).append(comment)
    for (path, name, email), batch in groups.items():
        done, bad = descant_commit(path, name, email, batch)
        stored.extend(done)
        refused.extend(bad)
    return stored, refused


def descant_commit(path, name, email, batch):
    """One reader's comments on one article, written and committed as one change."""
    if not COMMENTS_LOCK.acquire(timeout=30):
        return [], []
    try:
        folder = piece_folder(path) / "review"
        folder.mkdir(parents=True, exist_ok=True)
        files, by_thread = {}, {}
        try:
            for target in comment_files(folder):
                document = comment_document(target)
                files[document["thread"]["id"]] = target
                found = DESCANT_SOURCE_RE.match(document["source"])
                if found:
                    by_thread[found.group(1)] = document["thread"]["id"]
        except (OSError, UnicodeError, ValueError) as error:
            print("  descant: a review thread on %s does not parse, so nothing is written yet: %s"
                  % (path, str(error)[:160]))
            return [], []
        highest = max([int(key) for key in files if key.isdigit()] or [0])
        changes = {}                            # target -> (bytes before or None, bytes to write)
        written, already, bad = [], [], []
        for comment in batch:
            identifier = comment["id"]
            thread_key = str(comment.get("thread") or "")
            try:
                if not re.fullmatch(r"\d{1,16}", thread_key):
                    raise CommentRefused(400, "bad-thread", "the comment names no thread")
                created = str(comment.get("created") or "")
                if comment.get("kind") == "thread":
                    if thread_key in by_thread:
                        already.append(identifier)
                        continue
                    if not DESCANT_THREAD_TIME_RE.match(created):
                        raise CommentRefused(400, "bad-time", "the thread carries no time")
                    anchor = comment.get("anchor") if isinstance(comment.get("anchor"), dict) else {}
                    highest += 1
                    number = "%03d" % highest
                    thread = canonical_comment({"messageRef": comment["id"], "clientId": comment.get("clientId"), "anchor": anchor, "author": name, "by": "human",
                                                **comment_display_fields(comment.get("author") or {}),
                                                "text": "", "created": created, "replies": [],
                                                "status": "open", "done": False}, number)
                    thread["anchor"] = {key: reviewer_string(value, DESCANT_LIMITS[key], "the quoted passage")
                                        for key, value in thread["anchor"].items()}
                    thread["text"] = reviewer_string(reviewer_message(comment.get("text")), DESCANT_TEXT_MAX, "the comment")
                    thread["refersTo"] = reviewer_string(comment.get("refersTo"), 500, "what the comment points at")
                    document = {"thread": thread, "slug": comment_slug(thread["text"]),
                                "source": "descant:%s" % thread_key, "preamble": ""}
                    data = render_comment(document, thread).encode("utf-8")
                    if comment_document(None, data.decode("utf-8"))["thread"] != thread:
                        raise CommentRefused(422, "not-stored-as-written", "the thread would not read back as written")
                    target = folder / ("%s-%s.md" % (number, document["slug"]))
                    changes[target] = (None, data)
                    files[number] = target
                    by_thread[thread_key] = number
                elif comment.get("kind") == "reply":
                    number = by_thread.get(thread_key)
                    if number is None:
                        raise CommentRefused(404, "no-thread", "the thread this replies to is not in the repository")
                    if not DESCANT_REPLY_DATE_RE.match(created):
                        raise CommentRefused(400, "bad-time", "the reply carries no date")
                    target = files[number]
                    before, current = changes.get(target, (None, None))
                    if current is None:
                        before = current = target.read_bytes()
                    old = current.decode("utf-8")
                    previous = comment_document(None, old)["thread"]
                    message = {"messageRef": comment["id"], **({"id": comment["clientId"]} if comment.get("clientId") else {}), "author": name, "created": created, "by": "human", "basis": "", "offer": None,
                               **comment_display_fields(comment.get("author") or {}),
                               "text": reviewer_string(reviewer_message(comment.get("text")), DESCANT_TEXT_MAX, "the comment")}
                    # Appended, never a re-render: a reader's commit on a thread is pure additions.
                    data = (old.rstrip("\n") + "\n" + "\n".join(message_lines(message, previous["created"]))
                            + "\n").encode("utf-8")
                    if comment_document(None, data.decode("utf-8"))["thread"] != \
                            dict(previous, replies=previous["replies"] + [message]):
                        raise CommentRefused(422, "not-stored-as-written", "the reply would not read back as written")
                    changes[target] = (before, data)
                else:
                    raise CommentRefused(400, "bad-kind", "the comment is neither a thread nor a reply")
                written.append(identifier)
            except (CommentRefused, OSError, UnicodeError, ValueError) as refusal:
                why = refusal.payload["error"] if isinstance(refusal, CommentRefused) else str(refusal)[:160]
                print("  descant: comment %s refused: %s" % (identifier, why))
                if descant_refuse(comment, why):
                    bad.append(identifier)
        if not changes:
            return already, bad

        done = []
        before_sha = git("rev-parse", "HEAD").stdout.strip()
        try:
            for target, (before, data) in changes.items():
                atomic_write(target, data)
                done.append((target, before))
            gate = subprocess.run([str(REPO_ROOT / "check.sh")], cwd=str(REPO_ROOT),
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
            if gate.returncode != 0:
                raise RuntimeError("the completion gate refused them:\n" + gate.stdout[-600:])
            relative = [target.relative_to(REPO_ROOT).as_posix() for target in changes]
            added = git("add", "--", *relative)
            if added.returncode != 0:
                raise RuntimeError("git could not stage them: " + added.stderr.strip()[:200])
            owner = share_owner((REPO_ROOT / path).read_text("utf-8")) or default_owner()
            trailers = "Principal: %s\nActor: human\nBasis: review\n%s" % (
                owner, "\n".join("Descant-Comment: %s" % identifier for identifier in written))
            committed = git("commit", "--author", "%s <%s>" % (name, email),
                            "-m", "Comments from %s, a reader, on %s" % (name, piece_folder(path).name),
                            "-m", trailers, "--", *relative, timeout=40)
            if committed.returncode != 0:
                raise RuntimeError("git could not commit them: " + committed.stderr.strip()[:200])
        except (OSError, subprocess.TimeoutExpired, RuntimeError) as error:
            intended = {target.relative_to(REPO_ROOT).as_posix(): data for target, (_, data) in changes.items()}
            if not publication.landed_commit(REPO_ROOT, before_sha, intended):
                relative = [target.relative_to(REPO_ROOT).as_posix() for target, _ in done]
                if relative:
                    git("reset", "-q", "HEAD", "--", *relative)
                for target, before in reversed(done):
                    if before is None:
                        try:
                            target.unlink()
                        except FileNotFoundError:
                            pass
                    else:
                        atomic_write(target, before)
                print("  descant: %d comments on %s held for the next cycle: %s" % (len(written), path, str(error)[:600]))
                return already, bad
        print("  descant: %d comments from a reader on %s committed" % (len(written), path))
        return already + written, bad
    finally:
        COMMENTS_LOCK.release()


def sync_comment_actions():
    """Walk bounded pending pages; start again each cycle to revisit retained events."""
    cursor = 0
    through = None
    while True:
        route = "/sync/actions?after=%d" % cursor + ("&through=%d" % through if through is not None else "")
        page = share_call("GET", route)
        if not isinstance(page, dict): raise ShareError("the action page could not be confirmed")
        stored = descant_action_store(page.get("actions") or [])
        if stored: share_call("POST", "/sync/actions/ack", {"stored": stored})
        if not page.get("more"): return
        following = page.get("cursor")
        if not isinstance(following, int) or isinstance(following, bool) or following <= cursor:
            raise ShareError("the pending action cursor did not advance")
        if through is None:
            through = page.get("through")
            if not isinstance(through, int) or isinstance(through, bool) or through < following:
                raise ShareError("the pending action boundary could not be confirmed")
        if following > through: raise ShareError("the pending action cursor exceeded its boundary")
        cursor = following


def share_cycle():
    """One exchange with Descant: state, push, pull and store, acknowledge, push again."""
    with SHARE_LOCK:
        state = share_call("GET", "/sync/state")
        if not isinstance(state, dict) or not isinstance(state.get("shared"), list):
            raise ShareError("GET /sync/state answered with something that is not a state")
        shared = {p for p in state["shared"] if isinstance(p, str) and article_path(p)
                  and not p.startswith(SHARE_TEST_PIECE)}
        listed = state.get("grantedBy") if isinstance(state.get("grantedBy"), dict) else {}
        granted = {path: [g for g in who if isinstance(g, str)] for path, who in listed.items()
                   if isinstance(path, str) and isinstance(who, list)}
        cursor = state.get("cursor")
        cursor = cursor if isinstance(cursor, int) and not isinstance(cursor, bool) and cursor >= 0 else 0
        SHARE["shared"] = shared
        payload, SHARE["allowed"] = share_payload(shared, granted)
        answer = share_call("POST", "/sync/push", payload)
        if isinstance(answer, dict) and answer.get("refused"):
            print("  descant: refused to keep, notes still in the text: %s" % ", ".join(map(str, answer["refused"])))
        SHARE["ready"] = True
        page = share_call("GET", "/sync/comments?identities=1&after=%d" % cursor)
        fresh = [c for c in (page.get("comments") or []) if isinstance(c, dict) and not c.get("synced")] \
            if isinstance(page, dict) else []
        if fresh:
            sync_pull(force=True)
            stored, refused = descant_store(fresh)
            if stored or refused:
                share_call("POST", "/sync/ack", {"stored": stored, "refused": refused})
                share_call("POST", "/sync/push", share_payload(shared, granted)[0])
        sync_comment_actions()
        if isinstance(page, dict) and page.get("more"):
            SHARE_WAKE.set()
        SHARE["error"] = ""


def share_touched(old, new):
    """Whether the commits between two HEADs touched a shared article or its threads."""
    shared = SHARE["shared"]
    if shared is None:
        return True
    if not shared:
        return False
    changed = git("diff", "--name-only", old, new, "--", "articles")
    if changed.returncode != 0:
        return True
    folders = {str(Path(p).parent) + "/" for p in shared}
    return any(name.startswith(tuple(folders)) for name in changed.stdout.splitlines())


def share_loop():
    head = _git_raw("rev-parse", "HEAD").stdout.strip()
    due = 0.0
    while True:
        woken = SHARE_WAKE.wait(SHARE_TICK)
        SHARE_WAKE.clear()
        now_head = _git_raw("rev-parse", "HEAD").stdout.strip()
        moved = bool(head and now_head and now_head != head and share_touched(head, now_head))
        if woken or moved or time.time() >= due:
            try:
                share_cycle()
            except ShareError as error:
                if str(error) != SHARE["error"]:
                    print("  descant: " + str(error))
                SHARE["error"] = str(error)
            except Exception as error:          # the loop outlives any one bad cycle
                SHARE["error"] = "%s: %s" % (type(error).__name__, str(error)[:200])
                print("  descant: the cycle failed: " + SHARE["error"])
            due = time.time() + SHARE_EVERY
            now_head = _git_raw("rev-parse", "HEAD").stdout.strip()
        head = now_head or head


def share_hosts(port, address):
    """Every name this server answers to, with its port: loopback, its tailnet address, its own
    host name and its MagicDNS names, and any in CASTOR_HOSTS (comma-separated)."""
    names = {"127.0.0.1", "localhost", "[::1]", socket.gethostname().lower(), socket.gethostname().split(".")[0].lower()}
    if address:
        names.add(address)
    if TAILSCALE.exists():
        try:
            status = json.loads(subprocess.run([str(TAILSCALE), "status", "--json"], capture_output=True,
                                               text=True, timeout=8).stdout or "{}")
            own = status.get("Self") or {}
            dns = str(own.get("DNSName") or "").rstrip(".").lower()
            if dns:
                names.update([dns, dns.split(".")[0]])
            if own.get("HostName"):
                names.add(str(own["HostName"]).lower())
        except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
            pass
    names.update(n.strip().lower() for n in os.environ.get("CASTOR_HOSTS", "").split(",") if n.strip())
    names.discard("")
    return {"%s:%d" % (name, port) for name in names} | {name for name in names if "." in name and not name[0].isdigit()}


def tailnet_address():
    global TAILSCALE
    if not TAILSCALE.exists() and shutil.which("tailscale"):
        TAILSCALE = Path(shutil.which("tailscale"))
    if not TAILSCALE.exists():
        print("  Tailscale is not installed here, so only 127.0.0.1 is served.")
        return None
    try:
        out = subprocess.run([str(TAILSCALE), "ip", "-4"], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.SubprocessError):
        print("  Tailscale did not answer, so only 127.0.0.1 is served.")
        return None
    address = (out.stdout or "").strip().splitlines()
    address = address[0].strip() if address else ""
    if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", address):
        print("  Tailscale gave no address, so only 127.0.0.1 is served.")
        return None
    return address


def serve_on(host, port, handler=None):
    httpd = ThreadingHTTPServer((host, port), handler or Handler)
    httpd.daemon_threads = True
    return httpd


def main():
    global FILES_ROOT_OVERRIDE
    ap = argparse.ArgumentParser(
        prog="serve.py",
        description=("Serve design/app and its bounded prototype APIs. Files, uploads, moves, and "
                     "workspace.canvas write attributed commits into the piece folder."),
        epilog=("Uploads are decoded to at most %d bytes and checked from their bytes, not their filename. "
                "The default listener is loopback only; --tailnet adds this machine's Tailscale IPv4.") % MAX_UPLOAD,
    )
    ap.add_argument("--port", type=int, default=8790, help="port to listen on (default 8790)")
    ap.add_argument("--tailnet", action="store_true",
                    help="also listen on this machine's Tailscale IPv4, for the iPad and the phone")
    ap.add_argument("--files-root", type=Path,
                    help=("legacy Files folder to import once into the repository "
                          "(default: design/app/reviews/files-sandbox/<piece>/)"))
    ap.add_argument("--sync", action="store_true",
                    help="pull from the upstream before answering and push after every commit")
    ap.add_argument("--reviewer-port", type=int,
                    help=("also serve outside reviewers on 127.0.0.1:N only (the Cloudflare tunnel's "
                          "end), admitting the addresses in CASTOR_REVIEWERS, else the space's reviewersFile (default %s)" % REVIEWERS_DEFAULT))
    ap.add_argument("--writer-port", type=int,
                    help="also serve the credential-gated public writer on loopback only")
    ap.add_argument("--share-to", metavar="URL",
                    help=("exchange shared articles and readers' comments with Descant at this https origin, "
                          "every %d seconds and after commits to shared articles; the token is read from "
                          "CASTOR_SHARE_TOKEN_FILE (default %s). Off unless given." % (SHARE_EVERY, SHARE_TOKEN_DEFAULT)))
    args = ap.parse_args()
    if args.reviewer_port is not None and (args.reviewer_port == args.port or not 0 < args.reviewer_port < 65536):
        ap.error("--reviewer-port must be a valid port different from --port")
    if args.writer_port is not None and (args.writer_port in (args.port, args.reviewer_port) or not 0 < args.writer_port < 65536):
        ap.error("--writer-port must be a valid port different from other listeners")
    if args.share_to:
        try:
            SHARE["url"] = share_target(args.share_to)
        except ValueError as error:
            ap.error(str(error))
    SYNC["on"] = bool(args.sync)
    FILES_ROOT_OVERRIDE = args.files_root.resolve() if args.files_root else None

    socketserver.TCPServer.allow_reuse_address = True
    servers = [serve_on("127.0.0.1", args.port)]
    urls = ["http://127.0.0.1:%d/" % args.port]
    if args.writer_port is not None:
        import writer_origin
        servers.append(serve_on("127.0.0.1", args.writer_port, writer_origin.handler_for(sys.modules[__name__])))

    tailnet_ip = None
    if args.tailnet:
        address = tailnet_ip = tailnet_address()
        if address:
            try:
                servers.append(serve_on(address, args.port))
                urls.append("http://%s:%d/" % (address, args.port))
            except OSError as err:
                print("  Could not listen on %s (%s); loopback only." % (address, err))

    if args.reviewer_port is not None:
        # Loopback and nothing else, whatever --tailnet says: the only way in for a
        # reviewer is the tunnel, which authenticates them before it connects here.
        servers.append(serve_on("127.0.0.1", args.reviewer_port, ReviewerHandler))
        table = load_reviewers()
        print("Reviewers · http://127.0.0.1:%d/ · access list %s · %s%s" % (
            args.reviewer_port, reviewers_file(),
            "missing, unreadable, malformed or inside the repository: nobody is admitted"
            if table is None else "%d admitted" % sum(1 for entry in table.values() if entry),
            "" if SAMPLE_PAGE.is_file() else
            " · review page not built (python3 design/app/build.py --sample --world typewell)"))

    if SHARE["url"]:
        SHARE["hosts"] = share_hosts(args.port, tailnet_ip)
        # An explicitly configured HTTPS tailnet proxy keeps its browser Origin even
        # when its upstream Host is loopback. Host checks still refuse rebinding.
        SHARE["origins"] = {o.strip().lower() for o in os.environ.get("CASTOR_SHARE_ORIGINS", "").split(",")
                            if re.fullmatch(r"https://[a-z0-9.-]+\.ts\.net(?::[0-9]{1,5})?", o.strip().lower())}
        try:
            share_token()
            token_state = "token file found"
        except ShareError as error:
            token_state = str(error) + "; nothing is exchanged until it is fixed"
        print("Descant · %s · %s · every %d s" % (SHARE["url"], token_state, SHARE_EVERY))
        threading.Thread(target=share_loop, daemon=True).start()

    print("Castor design app · %s · serving %s · git root %s" % (" and ".join(urls), APP_DIR, REPO_ROOT))
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        for s in servers:
            s.server_close()


if __name__ == "__main__":
    main()
