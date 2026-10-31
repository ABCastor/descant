"""The private local graph, computed from working files without returning their prose."""
import csv
import hashlib
import re
from urllib.parse import unquote, urlsplit

import publication
import space_config


def tags(fields, raw):
    value = fields.get("tags", [])
    if isinstance(value, str):
        if value.startswith("[") and value.endswith("]"):
            value = next(csv.reader([value[1:-1]], skipinitialspace=True), [])
        elif not value:
            block = re.search(r"(?m)^tags:\s*\n((?:[ \t]+-.*\n?)+)", raw)
            value = re.findall(r"(?m)^[ \t]+-\s*(.*?)\s*$", block[1]) if block else []
        else:
            value = [value]
    return {str(tag).strip().strip("'\"") for tag in value if str(tag).strip()} if isinstance(value, list) else set()


def link_targets(body):
    # Examples in code and internal comments do not create connections.
    body = re.sub(r"(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$", "", body)
    body = re.sub(r"<!--[\s\S]*?-->|%%[\s\S]*?%%|`[^`\n]*`", "", body)
    targets = set()
    hosts = space_config.site_hosts()
    for match in re.finditer(r"(?<!!)\[[^\]\n]*\]\(\s*<?([^\s)>]+)", body):
        try:
            url = urlsplit(match[1])
        except ValueError:
            continue
        if url.netloc and url.hostname not in hosts:
            continue
        if url.scheme and url.scheme not in ("https", "http"):
            continue
        writing = re.fullmatch(r"/writing/([^/]+)/?", unquote(url.path))
        if writing:
            targets.add(writing[1])
    for match in re.finditer(r"\[\[([^\]\n]+)\]\]", body):
        target = match[1].split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            targets.add(target)
    return targets


def local_graph(root, centre_path, folders, safe, live_record):
    articles, aliases = {}, {}
    for folder in folders:
        path = (folder / "article.md").relative_to(root).as_posix()
        source = safe(root, path)
        if source is None:
            continue
        try:
            data = source.read_bytes()
            fields, body, raw = publication.frontmatter(data.decode("utf-8"))
        except (OSError, UnicodeError, publication.Refused):
            continue
        slug = str(fields.get("slug") or folder.name)
        title = str(fields.get("title") or slug)
        receipt = live_record(path)
        live = {"site": receipt["site"], "matches": receipt.get("article_sha256") == hashlib.sha256(data).hexdigest()} if receipt else None
        articles[path] = {"kind": "article", "path": path, "title": title, "slug": slug,
                          "live": "live-matching" if live and live["matches"] else "live-changed" if live else "none",
                          "draft": fields.get("published") is not True,
                          "receipt": live, "tags": tags(fields, raw), "targets": link_targets(body)}
        for alias in (title, folder.name, path, path[:-3]):
            aliases.setdefault(alias.casefold(), path)
    # A public slug wins over an ambiguous title or folder alias.
    for path, article in articles.items():
        aliases[article["slug"].casefold()] = path
    if centre_path not in articles:
        raise FileNotFoundError(centre_path)
    links = {path: {aliases.get(target.casefold(), "missing:" + target) for target in article["targets"]}
             for path, article in articles.items()}
    centre = articles[centre_path]
    nodes, edges = [], []
    for path, article in articles.items():
        if path == centre_path:
            continue
        outgoing, incoming = path in links[centre_path], centre_path in links[path]
        shared = sorted(centre["tags"] & article["tags"])
        if not (outgoing or incoming or shared):
            continue
        nodes.append({key: article[key] for key in ("kind", "path", "title", "slug", "live", "draft")})
        if outgoing or incoming:
            edges.append({"from": centre_path if outgoing else path, "to": path if outgoing else centre_path,
                          "kind": "link", "both": outgoing and incoming})
        for tag in shared:
            edges.append({"from": centre_path, "to": path, "kind": "tag", "tag": tag})
    for target in sorted(links[centre_path]):
        if target.startswith("missing:"):
            nodes.append({"kind": "missing", "slug": target[len("missing:"):]})
            edges.append({"from": centre_path, "to": target, "kind": "link", "both": False})
    sources = []
    materials = safe(root, centre_path.rsplit("/", 1)[0] + "/materials")
    if materials and materials.is_dir():
        for file in sorted(materials.rglob("*")):
            path = centre_path.rsplit("/", 1)[0] + "/materials/" + file.relative_to(materials).as_posix()
            checked = safe(root, path)
            if checked is not None and checked.is_file():
                sources.append({"kind": "material", "name": file.relative_to(materials).as_posix(),
                                "path": path, "size": checked.stat().st_size})
    return {"centre": {key: centre[key] for key in ("path", "title", "slug")} | {"live": centre["receipt"]},
            "nodes": nodes, "sources": sources, "edges": edges}
