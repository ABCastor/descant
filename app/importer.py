"""Import from Ulysses and Obsidian: the server half.

The page reads the writer's library or vault (it never writes back to it) and turns
each sheet or note into one item: the article's words, its tags, goal and group, its
pictures and notes, and the comments that belong to passages. This module checks one
item and saves it as an article through the app's own commit path, in one commit.

Repeating an import is safe. Each imported article keeps `.import.json` beside its
article.md: the source key, the fingerprint of what came in, and the bytes it wrote.
The same item again changes nothing. A changed item replaces the article only while
the article is still exactly what the import wrote; once the writer has changed it in
Descant, the newer source text goes beside it as a version (drafts/<writer>/), and the
writer takes from it what they want. Nothing the writer wrote in Descant is replaced.
"""
import base64
import datetime
import hashlib
import json
import re
import unicodedata

SOURCES = {"ulysses": "Ulysses", "obsidian": "Obsidian"}
KEY_RE = re.compile(r"^(ulysses|obsidian):[0-9a-f]{8,64}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
FOLDER_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MATERIAL_RE = re.compile(r"^(images|documents|other|notes)/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
COMMENT_ID_RE = re.compile(r"^[0-9a-f]{8,40}$")
YAML_KEY_RE = re.compile(r"^([^\s:#'\"][^:]*?)[ \t]*:(?:[ \t]|$)")
RECORD = ".import.json"
GOAL_TYPES = ("at-least", "at-most", "about", "daily")
GOAL_UNITS = ("words", "characters", "sentences", "paragraphs", "pages", "reading-time")
# The fields Descant writes itself. Extra front matter from a source never sets them.
MANAGED = frozenset(("title", "subtitle", "slug", "order", "status", "phase", "owner", "language", "date",
                     "published", "site", "tags", "chip", "group", "goal", "goal-type", "goal-unit", "goal-due"))
LIMITS = {"body": 2 * 1024 * 1024, "materials": 60, "comments": 300, "extra": 300, "tags": 60, "plan": 2000}


class Refused(ValueError):
    """An item the server will not save, with the sentence the receipt shows."""


def line_text(value, limit, what, required=False):
    text = value if isinstance(value, str) else ""
    if required and not text.strip():
        raise Refused("%s is missing" % what)
    if len(text) > limit or re.search(r"[\x00-\x1f\x7f\u2028\u2029]", text):
        raise Refused("%s must be one line of at most %d characters" % (what, limit))
    return " ".join(text.split())


def check_item(item, app):
    """The item as the server will save it, or Refused."""
    if not isinstance(item, dict):
        raise Refused("each item must be an object")
    key = item.get("key")
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise Refused("the item has no valid source key")
    source = key.split(":", 1)[0]
    if item.get("source") != source:
        raise Refused("the item names a different source than its key")
    fingerprint = item.get("fingerprint")
    if not isinstance(fingerprint, str) or not HEX64_RE.fullmatch(fingerprint):
        raise Refused("the item has no fingerprint")
    folder = item.get("folder")
    if not isinstance(folder, str) or not FOLDER_RE.fullmatch(folder) or len(folder) > 72:
        raise Refused("the item's folder name is not lowercase letters, digits and hyphens")
    title = app.article_title(line_text(item.get("title"), 200, "the title", required=True))
    if not title:
        raise Refused("the title holds control characters")
    group = line_text(item.get("group") or "", 300, "the group")
    date = item.get("date") or ""
    if date and (not isinstance(date, str) or not DATE_RE.fullmatch(date)):
        raise Refused("the date is not YYYY-MM-DD")
    tags = item.get("tags") or []
    if not isinstance(tags, list) or len(tags) > LIMITS["tags"]:
        raise Refused("tags must be a list of at most %d" % LIMITS["tags"])
    tags = [line_text(tag, 80, "a tag", required=True) for tag in tags]
    goal = item.get("goal")
    if goal is not None:
        if not isinstance(goal, dict) or type(goal.get("target")) is not int or not 0 < goal["target"] <= 10 ** 7 \
                or goal.get("type") not in GOAL_TYPES or goal.get("unit") not in GOAL_UNITS \
                or (goal.get("due") and not DATE_RE.fullmatch(str(goal["due"]))):
            raise Refused("the goal is not a target, a type and a unit")
    extra = item.get("extra") or []
    if not isinstance(extra, list) or len(extra) > LIMITS["extra"]:
        raise Refused("the extra front matter must be a list of lines")
    for line in extra:
        if not isinstance(line, str) or len(line) > 2000 or re.search(r"[\x00-\x08\x0a-\x1f\x7f]", line) \
                or line.rstrip() == "---" or line != line.rstrip():
            raise Refused("an extra front matter line is not one plain line")
        found = YAML_KEY_RE.match(line)
        if line[:1] not in (" ", "\t", "-", "#") and not found:
            raise Refused("an extra front matter line is not a key or its continuation")
        if found and found.group(1).strip().strip("'\"").lower() in MANAGED:
            raise Refused("extra front matter cannot set Descant's own field “%s”" % found.group(1))
    if extra and extra[0][:1] in (" ", "\t", "-"):
        raise Refused("the extra front matter starts in the middle of a field")
    body = item.get("body")
    if not isinstance(body, str) or not body.strip() or len(body.encode("utf-8")) > LIMITS["body"]:
        raise Refused("the text is empty or larger than 2 MB")
    if "\r" in body or "\x00" in body:
        raise Refused("the text holds carriage returns or NUL characters")
    if re.search(r"(?m)^[ \t]+$|[ \t]+$", body):
        raise Refused("a line of the text ends in spaces")
    materials = [check_material(material, app) for material in (item.get("materials") or [])]
    if len(materials) > LIMITS["materials"]:
        raise Refused("an item carries at most %d files" % LIMITS["materials"])
    if len({path for path, _ in materials}) != len(materials):
        raise Refused("two files have the same name")
    comments = item.get("comments") or []
    if not isinstance(comments, list) or len(comments) > LIMITS["comments"]:
        raise Refused("an item carries at most %d comments" % LIMITS["comments"])
    checked = []
    for comment in comments:
        if not isinstance(comment, dict) or not isinstance(comment.get("id"), str) or not COMMENT_ID_RE.fullmatch(comment["id"]):
            raise Refused("each comment needs an id")
        text = comment.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise Refused("each comment needs its words")
        anchor = {name: comment.get(name) if isinstance(comment.get(name), str) else "" for name in ("quote", "prefix", "suffix", "block")}
        if any(len(value) > 4000 for value in anchor.values()):
            raise Refused("a comment's passage is too long")
        checked.append({"id": comment["id"], "text": "\n".join(part.rstrip() for part in text.strip().split("\n")), **anchor})
    return {"key": key, "source": source, "fingerprint": fingerprint, "folder": folder, "title": title,
            "group": group, "date": date, "tags": tags, "goal": goal, "extra": extra,
            "body": body if body.endswith("\n") else body + "\n", "materials": materials, "comments": checked}


def check_material(material, app):
    """(materials/<group>/<name>, bytes) for one file, its bytes sniffed, never its name trusted."""
    if not isinstance(material, dict) or not isinstance(material.get("path"), str) or not MATERIAL_RE.fullmatch(material["path"]):
        raise Refused("a file name is not plain letters, digits, dots, hyphens or underscores")
    path = material["path"]
    if "text" in material:
        if not isinstance(material["text"], str):
            raise Refused("a note is not text")
        blob = material["text"].encode("utf-8")
    else:
        match = re.match(r"^data:[^;,]*(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$", str(material.get("data") or ""))
        if not match:
            raise Refused("%s is not one base64 file" % path)
        try:
            blob = base64.b64decode(match.group(1), validate=True)
        except ValueError:
            raise Refused("%s is not valid base64" % path)
    if not blob:
        raise Refused("%s is empty" % path)
    if len(blob) > app.MAX_UPLOAD:
        raise Refused("%s is larger than %d MB" % (path, app.MAX_UPLOAD // (1024 * 1024)))
    actual = app.sniff_upload(blob)
    group = path.split("/", 1)[0]
    if group == "notes":
        if actual != "text/plain" or not path.endswith(".md"):
            raise Refused("%s is not a Markdown note" % path)
        if re.search(rb"[ \t]+(?:\n|$)", blob):
            raise Refused("a line of %s ends in spaces" % path)
    elif app.resource_group(actual) != group:
        raise Refused("%s holds %s, which belongs in %s" % (path, actual, app.resource_group(actual)))
    return "materials/" + path, blob


# ------------------------------------------------------------------ the record

def records(app):
    """{key: (folder, record)} for every imported article this repository holds."""
    out = {}
    try:
        folders = sorted(d for d in (app.REPO_ROOT / "articles").iterdir() if d.is_dir() and (d / "article.md").is_file())
    except OSError:
        return out
    for folder in folders:
        target = folder / RECORD
        if not target.is_file() or target.is_symlink():
            continue
        try:
            record = json.loads(target.read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and isinstance(record.get("key"), str) and record["key"] not in out:
            out[record["key"]] = (folder, record)
    return out


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def state_of(found, fingerprint):
    """new, same, update (the article is still what the import wrote) or edited."""
    if not found:
        return "new"
    folder, record = found
    if record.get("fingerprint") == fingerprint:
        return "same"
    try:
        current = (folder / "article.md").read_bytes()
    except OSError:
        return "edited"
    return "update" if sha256(current) == record.get("article") else "edited"


def plan(entries, app):
    """What a write of each {key, fingerprint} would do, without writing anything."""
    if not isinstance(entries, list) or len(entries) > LIMITS["plan"]:
        raise Refused("a plan names at most %d items" % LIMITS["plan"])
    known = records(app)
    out = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("key"), str) or not KEY_RE.fullmatch(entry["key"]):
            raise Refused("each planned item needs its source key")
        found = known.get(entry["key"])
        answer = {"key": entry["key"], "state": state_of(found, str(entry.get("fingerprint") or ""))}
        if found:
            answer.update(folder=found[0].name, path=(found[0] / "article.md").relative_to(app.REPO_ROOT).as_posix(),
                          title=article_field(found[0], "title"))
        out.append(answer)
    return out


def article_field(folder, name):
    try:
        text = (folder / "article.md").read_text("utf-8")
    except (OSError, UnicodeError):
        return ""
    head = re.match(r"\A---\n([\s\S]*?)\n---\n", text)
    found = head and re.search(r"(?m)^" + re.escape(name) + r":[ \t]*(.*)$", head.group(1))
    return found.group(1).strip().strip("'\"") if found else ""


# ------------------------------------------------------------------ the article

def yaml_string(value):
    return json.dumps(value, ensure_ascii=False)


def slug_base(title):
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_title).strip("-")[:50].strip("-") or "untitled"


def free_slug(title, app):
    """A slug no article uses yet, from the title, with a number when one is taken."""
    taken = set()
    try:
        for folder in (app.REPO_ROOT / "articles").iterdir():
            if folder.is_dir():
                taken.add(re.sub(r"^\d{2}-", "", folder.name))
                slug = article_field(folder, "slug")
                if slug:
                    taken.add(slug)
    except OSError:
        pass
    base = slug_base(title)
    slug, n = base, 2
    while slug in taken:
        slug, n = "%s-%d" % (base, n), n + 1
    return slug


def next_order(app):
    orders = [0]
    try:
        for folder in (app.REPO_ROOT / "articles").iterdir():
            value = article_field(folder, "order") if folder.is_dir() else ""
            if re.fullmatch(r"\d{1,6}", value):
                orders.append(int(value))
    except OSError:
        pass
    return max(orders) + 1


def article_text(item, fixed):
    """article.md for an item. `fixed` holds what the article keeps across imports:
    slug, order, owner, status, phase, published, language and date."""
    lines = ["---", "title: '%s'" % item["title"].replace("'", "\u2019"), "slug: " + fixed["slug"],
             "order: %s" % fixed["order"], "status: " + fixed["status"], "phase: " + fixed["phase"],
             "owner: " + fixed["owner"], "language: " + fixed["language"], "date: " + fixed["date"],
             "published: " + fixed["published"]]
    if item["tags"]:
        lines.append("tags:")
        lines.extend("  - " + yaml_string(tag) for tag in item["tags"])
    if item["group"]:
        lines.append("group: " + yaml_string(item["group"]))
    goal = item["goal"]
    if goal:
        lines.extend(["goal: %d" % goal["target"], "goal-type: " + goal["type"], "goal-unit: " + goal["unit"]])
        if goal.get("due"):
            lines.append("goal-due: " + goal["due"])
    lines.extend(item["extra"])
    lines.extend(["---", ""])
    return "\n".join(lines) + "\n" + item["body"]


def kept_fields(folder):
    """The fields a founder owns, read off the article the import wrote before."""
    out = {}
    for name in ("slug", "order", "owner", "status", "phase", "published", "language", "date"):
        out[name] = article_field(folder, name)
    return out


def comment_files_for(item, review, who, app, existing_clients, today):
    """{path: bytes} for the item's comments that are not in the article yet."""
    changes = {}
    highest = 0
    try:
        highest = max([int(target.name.split("-", 1)[0]) for target in app.comment_files(review)] or [0])
    except (OSError, ValueError):
        raise Refused("the article's comments could not be read just now")
    name = app.AUTHORS.get(who, who).split("<", 1)[0].strip() or who
    for comment in item["comments"]:
        client = "import-" + comment["id"]
        if client in existing_clients:
            continue
        highest += 1
        identifier = "%03d" % highest
        thread = app.canonical_comment({
            "clientId": client, "author": name, "by": "human", "text": comment["text"], "created": today,
            "anchor": {"quote": comment["quote"], "prefix": comment["prefix"], "suffix": comment["suffix"],
                       "blockText": comment["block"]}}, identifier)
        thread["writer"] = "founder:" + who
        thread["messageRef"] = "froot:" + client
        slug = app.comment_slug(comment["text"])
        document = {"thread": thread, "slug": slug, "source": "descant-import", "preamble": ""}
        changes[review / (identifier + "-" + slug + ".md")] = app.render_comment(document, thread).encode("utf-8")
        existing_clients.add(client)
    return changes


def imported_clients(review, app):
    clients = set()
    if not review.is_dir():
        return clients
    for target in app.comment_files(review):
        found = re.search(r'(?m)^client_id: (".*")$', target.read_text("utf-8"))
        if found:
            try:
                clients.add(json.loads(found.group(1)))
            except ValueError:
                pass
    return clients


def version_path(folder, who, source, today):
    base = folder / "drafts" / who
    stem = "%s-from-%s" % (today, source)
    target, n = base / (stem + ".md"), 2
    while target.exists():
        target, n = base / ("%s-%d.md" % (stem, n)), n + 1
    return target


def write(item, who, app, people):
    """Save one checked item. Returns what happened, for the receipt."""
    today = datetime.date.today().isoformat()
    label = SOURCES[item["source"]]
    known = records(app)
    found = known.get(item["key"])
    state = state_of(found, item["fingerprint"])
    if state == "same":
        folder = found[0]
        return {"state": "same", "folder": folder.name, "path": (folder / "article.md").relative_to(app.REPO_ROOT).as_posix(),
                "title": article_field(folder, "title") or item["title"]}
    if found:
        folder, record = found
    else:
        folder, record = app.REPO_ROOT / "articles" / item["folder"], {}
        if folder.exists():
            raise Refused("another article already uses the folder %s" % item["folder"])
        if app.sandbox_path(app.REPO_ROOT, "articles/" + item["folder"]) is None:
            raise Refused("that folder would leave the articles")
    article = folder / "article.md"
    changes = {}
    kept_materials = []
    written_materials = dict(record.get("materials") or {})
    for relative, blob in item["materials"]:
        target = folder / relative
        if target.is_symlink() or app.sandbox_path(folder, relative) is None:
            raise Refused("%s would leave the article folder" % relative)
        if target.is_file():
            current = target.read_bytes()
            if current == blob:
                written_materials[relative] = sha256(blob)
                continue
            if written_materials.get(relative) != sha256(current):
                kept_materials.append(relative)       # the writer's own copy stays
                continue
        changes[target] = blob
        written_materials[relative] = sha256(blob)
    draft = None
    comments_added = 0
    if state == "edited":
        # The writer has changed this article in Descant: their text stays, and the
        # source's newer text goes beside it as a version to take from.
        draft = version_path(folder, who, item["source"], today)
        base = app.git("log", "-1", "--format=%H", "--", article.relative_to(app.REPO_ROOT).as_posix()).stdout.strip()
        header = "---\ntitle: %s\nby: %s\nbase: %s\n---\n\n" % (
            yaml_string("From " + label + ", " + today), yaml_string(label + " import, for " + who), base)
        changes[draft] = (header + item["body"]).encode("utf-8")
        article_sha = record.get("article")
    else:
        if found:
            fixed = kept_fields(folder)
        else:
            fixed = {"slug": free_slug(item["title"], app), "order": str(next_order(app)), "owner": who,
                     "status": "candidate", "phase": "draft", "published": "false", "language": "en",
                     "date": item["date"] or today}
        text = article_text(item, fixed).encode("utf-8")
        changes[article] = text
        article_sha = sha256(text)
        review = folder / "review"
        comment_changes = comment_files_for(item, review, who, app, imported_clients(review, app), today)
        comments_added = len(comment_changes)
        changes.update(comment_changes)
    record = {"source": item["source"], "key": item["key"], "fingerprint": item["fingerprint"],
              "article": article_sha, "materials": dict(sorted(written_materials.items())), "imported": today}
    changes[folder / RECORD] = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    verb = {"new": "Import", "update": "Update", "edited": "Add a version of"}[state]
    subject = "%s %s from %s" % (verb, folder.name, label)
    try:
        sha = app.commit_files(changes, subject, people, writing_save=article.relative_to(app.REPO_ROOT).as_posix())
    except BaseException:
        if not found and folder.is_dir() and not any(folder.rglob("*.md")):
            for leftover in sorted(folder.rglob("*"), reverse=True):
                if leftover.is_dir() and not any(leftover.iterdir()):
                    leftover.rmdir()
            if not any(folder.iterdir()):
                folder.rmdir()
        raise
    return {"state": {"new": "created", "update": "updated", "edited": "kept"}[state], "folder": folder.name,
            "path": article.relative_to(app.REPO_ROOT).as_posix(), "title": item["title"], "sha": sha,
            "comments": comments_added, "kept": kept_materials,
            **({"version": draft.relative_to(app.REPO_ROOT).as_posix()} if draft else {})}


def attach(key, material, who, app, people):
    """One more file for an article already imported (a picture too large to travel with it)."""
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise Refused("the file names no imported item")
    found = records(app).get(key)
    if not found:
        raise Refused("import the article before its files")
    folder, record = found
    relative, blob = check_material(material, app)
    target = folder / relative
    if target.is_symlink() or app.sandbox_path(folder, relative) is None:
        raise Refused("%s would leave the article folder" % relative)
    materials = dict(record.get("materials") or {})
    if target.is_file():
        current = target.read_bytes()
        if current == blob:
            return {"state": "same", "path": relative}
        if materials.get(relative) != sha256(current):
            return {"state": "kept", "path": relative}
    materials[relative] = sha256(blob)
    record = dict(record, materials=dict(sorted(materials.items())))
    changes = {target: blob, folder / RECORD: (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8")}
    sha = app.commit_files(changes, "Add %s to %s from %s" % (target.name, folder.name, SOURCES[record.get("source")] if record.get("source") in SOURCES else "an import"),
                           people, writing_save=(folder / "article.md").relative_to(app.REPO_ROOT).as_posix())
    return {"state": "created", "path": relative, "sha": sha}
