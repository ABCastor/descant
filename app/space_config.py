"""An installation's own values live in its writing space, never in the app.

The writing space is the git repository the app runs in: two folders above this one
(design/app in a full checkout, .descant/app in a personal install). Its .descant/
folder holds:

    people.json   the writers, {"key": "Name <email>", ..., "_colors": {"key": "#hex"}}
    config.json   everything else, each key optional:
        publicOrigin     the https origin of the reader service (the Worker) whose pages
                         talk to this server; --share-to sets it too
        shareTokenFile   where the token for that service is kept, outside the repository
                         (default ~/.config/descant/share-token)
        reviewersFile    the reviewers' access list, outside the repository
                         (default ~/.config/descant/reviewers.json)
        sites            the sites Publish can target, in the order the picker lists them:
                         [{"name": "site.example",          the host, and the article's site: value
                           "liveBase": "https://site.example/writing/",  where a slug goes live
                           "tagsFrom": {"url": "...", "format": "html" | "rss"},  tag suggestions
                           "tagsRequired": true,            Publish waits for one tag
                           "chip": true,                    articles with a chip: default here
                           "default": true,                 every other article defaults here
                           "receiver": {"kind": "receive-script", "repo": "~/site-checkout",
                                        "remotePath": "/you/site.git"}  or
                                       {"kind": "personal-repo", "path": "~/site-checkout"}}]
                         A space with none still works; Publish says no site is set up.
        siteRemotePath   older name for the receive-script site's receiver.remotePath
        agentPolicy      files, relative to the space, that /api/agent/policy hands an agent
                         reviewer (default none)
        noEmDashWriters  writer keys whose articles Publish refuses while they hold an em dash
        firstArticle     the article a browser with none open yet starts on, such as
                         "articles/01-welcome/article.md" (default: the first by folder name)
        testArticle      a synthetic article folder for trying sharing, such as
                         "articles/zz-test/": never shared or listed for readers (default none)

Environment variables still win: CASTOR_PEOPLE (a people file), CASTOR_SHARE_TOKEN_FILE, CASTOR_REVIEWERS,
DESCANT_PUBLIC_ORIGIN, and DESCANT_CONFIG_DIR (another folder instead of .descant/).
Examples: people.example.json and config.example.json beside this file.
"""

import json
import os
import re
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
SPACE = APP_DIR.parents[1]


def config_dir():
    return Path(os.environ.get("DESCANT_CONFIG_DIR") or SPACE / ".descant")


def people_file():
    """CASTOR_PEOPLE, else the space's .descant/people.json, else people.json beside the app
    (where installs made before round 1030 keep it)."""
    named = os.environ.get("CASTOR_PEOPLE")
    if named:
        return Path(named)
    space = config_dir() / "people.json"
    return space if space.is_file() else APP_DIR / "people.json"


_warned = set()


def _read(path):
    """A JSON object from path, or {}. A file that exists but cannot be used is named
    on stderr once, since its defaults would otherwise replace it without a word."""
    try:
        data = json.loads(path.read_text("utf-8"))
        if isinstance(data, dict):
            return data
        problem = "it is not a JSON object"
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        problem = str(error)
    if str(path) not in _warned:
        _warned.add(str(path))
        print("descant: ignoring %s (%s); using the defaults instead" % (path, problem), file=sys.stderr)
    return {}


def people():
    """The raw people file, or {} when there is none or it cannot be read."""
    return _read(people_file())


def config():
    return _read(config_dir() / "config.json")


# The one rule for a writer's key, shared by the install (serve.py, engine/people.js) and the
# comment service (reviewers/src/worker/writers.ts), which spell the same pattern and the same
# reserved words: an article's owner may be "both" or "unassigned", so no writer is.
WRITER_KEY = r"[a-z][a-z0-9-]{0,23}"
RESERVED_KEYS = ("both", "unassigned")


def is_writer_key(key):
    return isinstance(key, str) and bool(re.fullmatch(WRITER_KEY, key)) and key not in RESERVED_KEYS


def writers():
    """{key: "Name <email>"} for each writer the people file names, in its order."""
    return {key: identity for key, identity in people().items()
            if isinstance(identity, str) and is_writer_key(key)}


def marker_words(keys=None):
    """The words a writer's editorial marker opens with, as in [ADA: decide this]: each
    writer's key and first name in capitals. keys narrows them to those writers."""
    found = writers()
    words = set()
    for key in (found if keys is None else keys):
        words.add(key.upper())
        words.update(first.upper() for first in (found.get(key) or "").split("<", 1)[0].split()[:1])
    return sorted(words, key=lambda w: (-len(w), w))


def marker_re(keys=None, flags=0):
    """A pattern for a writer's editorial marker: [NAME followed by a colon, a space, an em dash
    or a closing bracket that does not open a link, so [ADA: ...], [ADA — ...] and [ADA] are
    markers and [ADA](https://...) is a link. One that matches nothing when there are no writers."""
    words = marker_words(keys)
    return re.compile(r"\[(?:%s)(?=[:\s\u2014]|\](?!\())" % "|".join(map(re.escape, words)) if words else r"(?!)", flags)


def public_origin():
    """DESCANT_PUBLIC_ORIGIN, else publicOrigin; "" when neither names one."""
    return str(os.environ.get("DESCANT_PUBLIC_ORIGIN") or value("publicOrigin") or "").rstrip("/")


def value(key, default=None):
    found = config().get(key)
    return default if found in (None, "") else found


ARTICLE_PATH = re.compile(r"articles/[A-Za-z0-9][A-Za-z0-9._-]{0,99}/article\.md")
ARTICLE_FOLDER = re.compile(r"articles/[A-Za-z0-9][A-Za-z0-9._-]{0,99}/")


def first_article():
    """firstArticle: the article a browser with none open yet starts on; "" when unnamed."""
    named = value("firstArticle")
    return named if isinstance(named, str) and ARTICLE_PATH.fullmatch(named) and ".." not in named else ""


def test_article():
    """testArticle: the folder, ending in "/", of the space's synthetic sharing test article,
    which is never shared or listed for readers; "" when the space has none."""
    named = value("testArticle")
    return named if isinstance(named, str) and ARTICLE_FOLDER.fullmatch(named) and ".." not in named else ""


def is_test_article(path):
    prefix = test_article()
    return bool(prefix) and isinstance(path, str) and path.startswith(prefix)


def _site(entry):
    """A usable site entry, or None. Its name is the host its liveBase serves on."""
    if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
        return None
    from urllib.parse import urlsplit
    base = entry.get("liveBase")
    if not isinstance(base, str) or not base.endswith("/"):
        return None
    def https_host(value):
        try:
            url = urlsplit(value)
            return url.hostname if url.scheme == "https" else None
        except ValueError:
            return None
    if https_host(base) != entry["name"].lower():
        return None
    tags = entry.get("tagsFrom")
    if not (isinstance(tags, dict) and isinstance(tags.get("url"), str) and https_host(tags["url"])
            and tags.get("format") in ("html", "rss")):
        tags = None
    receiver = entry.get("receiver") if isinstance(entry.get("receiver"), dict) else {}
    return {"name": entry["name"], "liveBase": base, "tagsFrom": tags,
            "tagsRequired": entry.get("tagsRequired") is True, "chip": entry.get("chip") is True,
            "default": entry.get("default") is True, "receiver": dict(receiver)}


def sites():
    """The sites Publish can target (config.json sites), each checked; [] when there are none."""
    found = [site for site in map(_site, value("sites") or []) if site] if isinstance(value("sites"), list) else []
    legacy = value("siteRemotePath")
    if legacy:
        for site in found:
            if site["receiver"].get("kind") == "receive-script" and not site["receiver"].get("remotePath"):
                site["receiver"]["remotePath"] = legacy
                break
    return found


def site(name):
    return next((entry for entry in sites() if entry["name"] == name), None)


def default_site(fields):
    """The site an article without a site: value goes to: the chip site for an article with a
    chip, else the default site, else the first one; "" when the space names none."""
    listed = sites()
    if fields.get("chip"):
        chosen = next((entry for entry in listed if entry["chip"]), None)
        if chosen:
            return chosen["name"]
    chosen = next((entry for entry in listed if entry["default"]), None) or (listed[0] if listed else None)
    return chosen["name"] if chosen else ""


def site_hosts():
    """Hosts whose /writing/ links point at this space's own articles."""
    return {entry["name"].lower() for entry in sites()}


def server_site():
    """The site the private server's own Publish flow (publication.py) writes to: the one whose
    receiver names a private remote path. None when no site does."""
    return next((entry for entry in sites() if entry["receiver"].get("remotePath")), None)


def client_sites():
    """What the Publish sheet needs to know about each site, and nothing about where it lives."""
    return [{"name": entry["name"], "tagsRequired": entry["tagsRequired"], "chip": entry["chip"],
             "default": entry["default"]} for entry in sites()]
