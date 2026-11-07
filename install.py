#!/usr/bin/env python3
"""Install Descant for one writer: a fresh git writing space with the app inside it.

    python3 install.py --name "Your Name" --email you@example.com [--dir ~/Descant] [--port 8790]
    python3 install.py --update [--dir ~/Descant]      after a newer copy of the app arrives

Makes <dir> (it must not exist yet, or be empty), with:
    articles/          your writing, plain Markdown, one folder per article
    check.sh           the gate every save passes
    PUBLISHING.md      how your own agent can wire Publish to where you publish
    descant            starts the app (Descant.command does the same on a Mac, by double-click)
    .descant/app/      the app itself, ignored by git
    .descant/people.json  you, as the writer whose name signs each save
and makes the first commit, signed with your name. Nothing is sent anywhere: the app runs on
127.0.0.1 only and the space has no git remote until you add one.

Needs Python 3.9 or newer and git. Works on macOS and Linux.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY_TOKEN = "__DESCANT_WRITER_KEY__"
NAME_TOKEN = "__DESCANT_WRITER_FIRST__"
PERSON_COLOR = "#8d5031"          # terracotta, Descant's colour for a person
EMAIL_RE = re.compile(r"^[^\s@<>()\[\],;:\"\\]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                      r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$")

LAUNCHER = """#!/bin/sh
# Start Descant for this writing space, then open it in the browser. Stop it with Ctrl+C.
case "$0" in */*) cd "${0%%/*}" || exit 1 ;; esac
PORT="${DESCANT_PORT:-%(port)d}"
URL="http://127.0.0.1:$PORT/"
( sleep 1.5
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."; fi ) &
# With an upstream branch (a private remote your agent added), every save is also pushed there.
SYNC=""
if git rev-parse --verify -q '@{upstream}' >/dev/null 2>&1; then SYNC="--sync"; fi
exec %(python)s .descant/app/serve.py --port "$PORT" $SYNC
"""


def fail(message):
    sys.exit("Descant was not installed: " + message)


def run(args, cwd, env=None):
    done = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, env=env)
    if done.returncode != 0:
        fail("%s failed:\n%s" % (" ".join(args[:3]), (done.stderr or done.stdout).strip()[-800:]))
    return done.stdout


def writer_key(name):
    first = name.split()[0].lower()
    key = re.sub(r"[^a-z0-9-]", "", first.encode("ascii", "ignore").decode("ascii"))
    return key[:24] if re.fullmatch(r"[a-z][a-z0-9-]*", key or "") else "writer"


def update(space):
    """Replace the app inside an existing writing space; the writing, its history and the
    writer (.descant/people.json) stay as they are."""
    descant = space / ".descant"
    if not (descant / "app" / "serve.py").is_file():
        fail("%s has no Descant app to update. Install it first, without --update." % space)
    old_people = descant / "app" / "people.json"
    if old_people.is_file() and not (descant / "people.json").exists():
        shutil.copy2(old_people, descant / "people.json")      # an install that kept people.json beside the app
    fresh, previous = descant / "app.new", descant / "app.previous"
    for leftover in (fresh, previous):
        if leftover.exists():
            fail("%s is left from an earlier update; remove it and run this again." % leftover)
    shutil.copytree(HERE / "app", fresh)
    install = descant / "app" / "install.json"
    if install.is_file():
        shutil.copy2(install, fresh / "install.json")
    (descant / "app").rename(previous)
    fresh.rename(descant / "app")
    shutil.rmtree(previous)                                    # the old app code, reproducible from git
    shutil.copy2(HERE / "VERSION", descant / "VERSION")
    run([sys.executable, str(descant / "app" / "build.py"), "--world", "typewell"], space)
    print("Descant in %s is updated to %s." % (space, (HERE / "VERSION").read_text("utf-8").strip()))


def main():
    ap = argparse.ArgumentParser(description="Install Descant: a fresh writing space with your name.")
    ap.add_argument("--update", action="store_true", help="replace the app in an existing writing space with this copy")
    ap.add_argument("--name", help='your name as it should sign your commits, e.g. "Ada Lovelace"')
    ap.add_argument("--email", help="the email your commits carry")
    ap.add_argument("--dir", default="~/Descant", help="where the writing space goes (default ~/Descant)")
    ap.add_argument("--port", type=int, default=8790, help="the local port the app listens on (default 8790)")
    args = ap.parse_args()
    if args.update:
        return update(Path(os.path.expanduser(args.dir)).resolve())
    if not args.name or not args.email:
        fail("give your name and email: --name \"Your Name\" --email you@example.com")

    if sys.version_info < (3, 9):
        fail("Python 3.9 or newer is needed; this is %s." % sys.version.split()[0])
    if not shutil.which("git"):
        fail("git is not installed. On a Mac run: xcode-select --install. On Linux install git with your package manager.")
    name = " ".join(args.name.split())
    if not name or len(name) > 60 or re.search(r"[<>\x00-\x1f\x7f]", name):
        fail("the name must be 1 to 60 characters, without < or >.")
    email = args.email.strip()
    if not EMAIL_RE.match(email):
        fail("that email does not look complete.")
    if not 0 < args.port < 65536:
        fail("the port must be between 1 and 65535.")
    space = Path(os.path.expanduser(args.dir)).resolve()
    # On a Mac ~/descant and ~/Descant are one folder: the space must not be this copy of the app.
    here = HERE.resolve()
    if space == here or here in space.parents or space in here.parents or (space.exists() and os.path.samefile(space, here)):
        fail("%s holds this copy of Descant itself. Choose another place with --dir." % space)
    if space.exists() and (not space.is_dir() or any(space.iterdir())):
        fail("%s already exists and is not empty. Choose another place with --dir." % space)

    key, first = writer_key(name), name.split()[0]
    # Everything is made in a sibling folder and moved into place at the end, so a failed
    # install leaves nothing half-made where the space should be.
    final = space
    space = final.parent / (final.name + ".installing")
    if space.exists():
        fail("%s is left from an earlier attempt; remove it and run this again." % space)
    space.mkdir(parents=True)
    shutil.copytree(HERE / "space", space, dirs_exist_ok=True)
    guide = space / "AGENT-GUIDE.md"          # how the public repository ships AGENTS.md
    if guide.is_file():
        guide.rename(space / "AGENTS.md")
    app = space / ".descant" / "app"
    shutil.copytree(HERE / "app", app)
    shutil.copy2(HERE / "VERSION", space / ".descant" / "VERSION")
    (space / ".descant" / "people.json").write_text(json.dumps({key: "%s <%s>" % (name, email), "_colors": {key: PERSON_COLOR}},
                                                ensure_ascii=False, indent=2) + "\n", "utf-8")
    (app / "install.json").write_text(json.dumps({"kind": "personal", "writer": key}, indent=2) + "\n", "utf-8")
    for article in (space / "articles").rglob("*.md"):
        text = article.read_text("utf-8")
        if KEY_TOKEN in text or NAME_TOKEN in text:
            article.write_text(text.replace(KEY_TOKEN, key).replace(NAME_TOKEN, first), "utf-8")
    launcher = space / "descant"
    launcher.write_text(LAUNCHER % {"port": args.port, "python": sys.executable}, "utf-8")
    launcher.chmod(0o755)
    if sys.platform == "darwin":
        command = space / "Descant.command"
        command.write_text('#!/bin/sh\nexec "$(dirname "$0")/descant"\n', "utf-8")
        command.chmod(0o755)
    (space / "check.sh").chmod(0o755)

    run(["git", "init", "-q"], space)
    run(["git", "symbolic-ref", "HEAD", "refs/heads/main"], space)
    run(["git", "config", "user.name", name], space)
    run(["git", "config", "user.email", email], space)
    run(["git", "add", "-A"], space)
    run(["git", "commit", "-q", "-m", "Start my writing space\n\nPrincipal: %s\nActor: human\nBasis: instruction" % key], space)
    run([sys.executable, str(app / "build.py"), "--world", "typewell"], space)
    if final.exists():
        final.rmdir()                     # checked empty above
    space.rename(final)
    space, launcher = final, final / "descant"

    print("Descant is installed in %s, writing as %s." % (space, name))
    print("Start it: %s" % ((space / "Descant.command") if sys.platform == "darwin" else launcher))
    print("Then it opens http://127.0.0.1:%d/ in your browser. Stop it with Ctrl+C in its window." % args.port)


if __name__ == "__main__":
    main()
