"""Private release candidates. No target, push, or deploy is enabled by default."""
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
sys.path.insert(0, str(Path(__file__).resolve().parent))
import space_config  # noqa: E402  the writing space's own values
import tempfile
import uuid
from urllib.parse import unquote, urlparse


class Refused(Exception):
    def __init__(self, message, code=422):
        super().__init__(message)
        self.code = code


def unfinished(body, writers):
    """Whether body still holds an internal note or an editorial marker: %%, a wiki link, a
    writer's [NAME: ...] marker (space_config.marker_re()), TODO, TK, FIXME or a 1Password reference."""
    if re.search(r'%%|\[\[(?!\^)|\[(?:TODO|TK|FIXME)\b|\b(?:TODO|FIXME|TK)\b|op://', body):
        return True
    return bool(space_config.marker_re(writers).search(body))


def no_em_dash(owner):
    """Whether the owner's articles go out without em dashes (config.json noEmDashWriters)."""
    listed = space_config.value('noEmDashWriters') or []
    return isinstance(listed, list) and owner in listed


def command(repo, *args, timeout=60):
    try:
        result = subprocess.run(args, cwd=repo, capture_output=True, text=True, timeout=timeout,
                                stdin=subprocess.DEVNULL, env=dict(os.environ, CI='1'))
    except (OSError, subprocess.TimeoutExpired):
        raise Refused('A publication command could not finish. Check the private server log.', 503)
    if result.returncode:
        # Commands may print credentials. Keep their output out of responses and logs.
        label = ' '.join(args) if args in (('npm', 'run', 'check'), ('npm', 'run', 'verify'), ('npm', 'test'), ('npm', 'ci', '--no-audit', '--no-fund')) else Path(str(args[0])).name
        raise Refused('Publication check failed: ' + label, 422)
    return result.stdout.strip()


def head(repo):
    return command(repo, 'git', 'rev-parse', 'HEAD')


def landed_commit(repo, before, changes):
    """Return the new commit only when it holds every intended byte (or deletion).

    An unreadable Git state raises, leaving working bytes alone rather than
    guessing that a commit failed and rolling back something already saved.
    """
    sha = head(repo)
    if sha == before:
        return None
    for path, data in changes.items():
        exists = command(repo, 'git', 'ls-tree', '--name-only', sha, '--', path)
        if not exists:
            if data is not None: return None
        elif data is None:
            return None
        else:
            blob = subprocess.run(['git', '-C', str(repo), 'show', sha + ':' + path], capture_output=True, timeout=20)
            if blob.returncode: raise Refused('Git could not verify this save. Its working files are retained.', 503)
            if blob.stdout != data: return None
    return sha


def frontmatter(text):
    match = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n', text, re.S)
    if not match:
        raise Refused('Article front matter is missing.')
    fields = {}
    for line in match[1].splitlines():
        if line and not line[0].isspace() and ':' in line:
            key, value = line.split(':', 1)
            if key in fields:
                raise Refused('Article front matter has a duplicate field.')
            value = value.strip()
            try: value = json.loads(value)
            except ValueError: value = value.strip("'\"")
            fields[key] = value
    return fields, text[match.end():], match[1]


def digest_tree(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise Refused('The preview contains a symbolic link.')
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def safe_url(value):
    value = unquote(value).strip()
    parsed = urlparse(value)
    if re.fullmatch(r'#[A-Za-z0-9_-]+', value): return value
    if value.startswith('/') and not value.startswith('//') and not re.search(r'(^|/)\.\.(/|$)', value):
        return value
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
        raise Refused('Replace private or local links before preparing publication.')
    host = parsed.hostname.lower()
    if '.' not in host or host.endswith(('.ts.net', '.local', '.localhost', '.internal', '.test')) or parsed.username or parsed.password:
        raise Refused('Replace private or local links before preparing publication.')
    try:
        if not ipaddress.ip_address(host).is_global:
            raise Refused('Replace private or local links before preparing publication.')
    except ValueError: pass
    return value


class Publication:
    def __init__(self, source, config, authors, on_source_commit=None, lock=None):
        self.source = Path(source).resolve()
        self.config = config or {}
        self.authors = authors
        self.on_source_commit = on_source_commit
        self.lock = lock or threading.RLock()
        git_dir = command(self.source, 'git', 'rev-parse', '--absolute-git-dir')
        self.store = Path(git_dir) / 'descant-publication'
        self.store.mkdir(mode=0o700, exist_ok=True)

    def founder(self, who):
        if who not in self.authors or not re.fullmatch(r'[^<>\n]+ <[^<>\s@]+@[^<>\s]+>', self.authors.get(who, '')):
            raise Refused('Only a configured founder can prepare or publish.', 403)

    def target(self):
        if not self.config.get('repo'):
            raise Refused('Publication is not set up. Ask a founder to set the site target.', 503)
        repo = Path(self.config['repo']).resolve()
        if repo == self.source or not repo.is_dir():
            raise Refused('The configured site checkout is unavailable.', 503)
        branch = self.config.get('branch')
        remote = self.config.get('push_remote')
        if remote:
            if not isinstance(remote, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', remote):
                raise Refused('Choose a named private site remote.', 503)
            url = command(repo, 'git', 'remote', 'get-url', remote)
            parsed = urlparse(url)
            # The one private site remote this space names (its server site's receiver, space_config.py).
            server = space_config.server_site()
            site_path = self.config.get('site_remote_path') or (server['receiver']['remotePath'] if server else '')
            private_ssh = bool(site_path) and parsed.scheme == 'ssh' and bool(parsed.hostname) and ('.' not in parsed.hostname or parsed.hostname.endswith('.ts.net')) and parsed.path.endswith(site_path)
            local_test = not parsed.scheme and Path(url).is_absolute() and Path(url).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
            if not (private_ssh or local_test):
                raise Refused('Publishing uses the private site remote this writing space names, or a disposable local origin.', 503)
        if not branch or command(repo, 'git', 'branch', '--show-current') != branch:
            raise Refused('The site checkout must be on the configured branch.', 409)
        if command(repo, 'git', 'status', '--porcelain'):
            raise Refused('The site checkout has unsaved changes.', 409)
        return repo

    def blob(self, sha, path):
        result = subprocess.run(['git', '-C', str(self.source), 'show', sha + ':' + path], capture_output=True)
        if result.returncode: raise Refused('The saved article or asset is unavailable.')
        return result.stdout

    def source_text(self, path, sha):
        if not re.fullmatch(r'articles/[^/.][^/]*/article\.md', path or '') or not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
            raise Refused('Open and save an article before preparing publication.', 400)
        command(self.source, 'git', 'rev-parse', '--verify', sha + '^{commit}')
        text = self.blob(sha, path).decode('utf-8')
        if command(self.source, 'git', 'status', '--porcelain', '--', path):
            raise Refused('Save the article before preparing publication.', 409)
        current = self.blob('HEAD', path).decode('utf-8')
        if current != text or (self.source / path).read_text() != text:
            raise Refused('Draft changed since preview. Prepare again.', 409)
        return text

    def save_record(self, record):
        folder = self.store / record['id']
        target = folder / 'record.json'
        temp = folder / 'record.tmp'
        temp.write_text(json.dumps(record, indent=2) + '\n')
        temp.replace(target)

    def record(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{32}', identifier):
            raise Refused('Prepare a publication first.', 404)
        try: return json.loads((self.store / identifier / 'record.json').read_text())
        except (OSError, ValueError): raise Refused('Prepare a publication first.', 404)

    def status(self, path):
        records = []
        for p in self.store.glob('*/record.json'):
            record = json.loads(p.read_text())
            if record['path'] == path: records.append(record)
        server = space_config.server_site()
        details = {'configured': bool(self.config.get('repo')), 'current_source': head(self.source),
                   'site_name': server['name'] if server else ''}
        fields, _, _ = frontmatter(self.blob('HEAD', path).decode('utf-8'))
        slug = fields.get('slug', '')
        if self.config.get('repo') and isinstance(slug, str) and re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
            existing = Path(self.config['repo']) / 'src/content/articles' / (slug + '.md')
            details['site_existing'] = existing.is_file()
            if existing.is_file(): details['site_metadata'] = frontmatter(existing.read_text())[0]
        if not records: return details
        record = max(records, key=lambda x: x['created'])
        answer = self.public(record)
        answer.update(details)
        answer['changed'] = False
        if record.get('descant_commit'):
            answer['changed'] = self.blob('HEAD', path) != self.blob(record['descant_commit'], path) or bool(command(self.source, 'git', 'status', '--porcelain', '--', path))
        else:
            try: self.source_text(path, record['source'])
            except Refused: answer['changed'] = True
        return answer

    def public(self, record):
        server = space_config.server_site()
        return {key: record[key] for key in ('id', 'source', 'site_base', 'title', 'slug', 'changes', 'metadata', 'created',
                'site_commit', 'descant_commit', 'deployment', 'viewed') if key in record} | {
                    'preview': '/publication/' + record['id'] + '/writing/' + record['slug'] + '/',
                    'url': server['liveBase'] + record['slug'] + '/' if server else '',
                    'site_name': server['name'] if server else ''}

    def prepare(self, path, sha, who, metadata):
        self.founder(who)
        repo = self.target()
        pending = self.status(path)
        if pending.get('site_commit') and not pending.get('descant_commit'):
            raise Refused('Retry the saved publication before preparing another.', 409)
        text = self.source_text(path, sha)
        fields, body, _ = frontmatter(text)
        site, server = fields.get('site'), space_config.server_site()
        if not server:
            raise Refused('Publication is not set up. Ask a founder to set the site target.', 503)
        if site and site != server['name']:
            raise Refused('This article is for %s. Publish it with design/app/tools/publish-personal on the Mac.' % site)
        if not all(k in fields for k in ('title', 'slug', 'owner', 'phase', 'published', 'status')):
            raise Refused('Article front matter is incomplete.')
        slug = fields['slug']
        if not isinstance(slug, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
            raise Refused('The article needs a stable public slug.')
        if not isinstance(fields['title'], str) or not fields['title'].strip():
            raise Refused('The article needs a title.')
        if (self.source / 'check.sh').is_file():
            command(self.source, str(self.source / 'check.sh'), '--writing-save', path)
        if fields['status'] == 'candidate':
            raise Refused('A founder must decide this candidate article before publication.')
        if fields['owner'] not in (*self.authors, 'both', 'unassigned') or fields['published'] not in (True, False):
            raise Refused('Article ownership or publication state is invalid.')
        if unfinished(body, self.authors):
            raise Refused('Resolve internal notes and editorial markers before publication.')
        if no_em_dash(fields['owner']) and '\u2014' in body:
            raise Refused('Em dash found')
        if len(re.findall(r'^\s*```', body, re.M)) % 2:
            raise Refused('Close the code fence before publication.')
        references = re.findall(r'\[\^([^\]]+)\](?!:)', body)
        definitions = re.findall(r'^\[\^([^\]]+)\]:', body, re.M)
        if set(references) != set(definitions) or len(definitions) != len(set(definitions)):
            raise Refused('Footnotes do not resolve exactly once.')
        if not isinstance(metadata, dict): raise Refused('Review the site summary and chip first.')
        summary, chip, tags = metadata.get('summary'), metadata.get('chip'), metadata.get('tags', [])
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 2000:
            raise Refused('Write a public summary.')
        if chip not in ('wave', 'slap', 'pet', 'heart', 'skunk'):
            raise Refused('Choose a chip act for the site.')
        if not isinstance(tags, list) or len(tags) > 12 or any(not isinstance(t, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', t) for t in tags):
            raise Refused('Tags use lowercase words with hyphens.')
        for value in (summary, fields['title']):
            if re.search(r'%%|\[\[|op://|https?://', value):
                raise Refused('Use plain public text for the title and summary.')
        relative = 'src/content/articles/' + slug + '.md'
        existing = repo / relative
        old_fields, old_header = {}, ''
        if existing.exists():
            if not metadata.get('replace'):
                raise Refused('This URL already exists. Confirm that this is a correction.')
            old_fields, _, old_header = frontmatter(existing.read_text())
        for file in (repo / 'src/content/articles').rglob('*.md'):
            if file == existing: continue
            other, _, _ = frontmatter(file.read_text())
            if other.get('chip') == chip: raise Refused('That chip act is already used by another site article.')
        exports = {}
        if len(re.findall(r'!\[', body)) != len(re.findall(r'!\[[^\]]*\]\([^\n)]+\)', body)):
            raise Refused('Use inline Markdown images with alt text before publication.')
        approved = metadata.get('assets', [])
        if not isinstance(approved, list) or any(not isinstance(a, str) for a in approved):
            raise Refused('Choose which image files may become public.')
        used = []
        def image(match):
            alt, name = match.group(1), match.group(2)
            if not alt.strip(): raise Refused('Every image needs alt text.')
            if name.startswith(('http:', 'https:', '/')):
                safe_url(name)
                return match.group(0)
            if name not in approved or not re.fullmatch(r'(?:images|attachments)/[a-zA-Z0-9._-]+\.(?:png|jpg|jpeg|gif|webp)', name):
                raise Refused('Approve each local image explicitly. Only PNG, JPEG, GIF and WebP files may be exported.')
            source_path = str(Path(path).parent / name)
            if command(self.source, 'git', 'status', '--porcelain', '--', source_path):
                raise Refused('Save the approved image before preparing publication.', 409)
            result = subprocess.run(['git', '-C', str(self.source), 'show', sha + ':' + source_path], capture_output=True)
            if result.returncode: raise Refused('An approved image is missing from the saved version.')
            blob = result.stdout
            valid = blob.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'GIF87a', b'GIF89a')) or (blob[:4] == b'RIFF' and blob[8:12] == b'WEBP')
            if not valid or len(blob) > 3 * 1024 * 1024: raise Refused('An approved image is invalid or larger than 3 MB.')
            dest = 'public/descant/' + slug + '/' + Path(name).name
            if dest in exports and exports[dest] != blob: raise Refused('Two approved images have the same public filename.')
            exports[dest] = blob
            used.append(source_path)
            return '![' + alt + '](/descant/' + slug + '/' + Path(name).name + ')'
        body = re.sub(r'!\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)', image, body)
        # Reject raw HTML, whose URLs and hidden content cannot be reviewed as Markdown.
        for tag in re.findall(r'<([^>]+)>', body):
            if tag.startswith(('https://', 'http://')): safe_url(tag)
            else: raise Refused('Convert raw HTML to Markdown before publication.')
        for link in re.findall(r'\]\(([^\s)]+)', body) + re.findall(r'^\s*\[(?!\^)[^\]]+\]:\s*(\S+)', body, re.M):
            safe_url(link)
        date = old_fields.get('date') or pending.get('metadata', {}).get('date') or datetime.date.today().isoformat()
        output = dict(title=fields['title'], summary=summary.strip(), chip=chip, tags=tags, date=date,
                      full=bool(old_fields.get('full', False)))
        header = old_header
        for key, value in output.items():
            line = key + ': ' + (str(value) if key in ('chip', 'date') else json.dumps(value, ensure_ascii=False))
            if re.search(r'^' + key + r':', header, re.M):
                header = re.sub(r'^' + key + r':[^\n]*', lambda _: line, header, flags=re.M)
            else: header += ('\n' if header else '') + line
        # The site renders its own title. Omit only an identical opening title;
        # other headings and the saved source remain unchanged.
        public_body = body.lstrip()
        title_line = '# ' + fields['title'].strip()
        if public_body == title_line or public_body.startswith(title_line + '\n'):
            public_body = public_body[len(title_line):].lstrip('\n')
        exports[relative] = ('---\n' + header + '\n---\n\n' + public_body.strip() + '\n').encode()
        identifier = uuid.uuid4().hex
        folder = self.store / identifier
        folder.mkdir(mode=0o700)
        snapshot = folder / 'site'
        base = head(repo)
        command(folder, 'git', 'clone', '--quiet', '--no-hardlinks', str(repo), str(snapshot))
        command(snapshot, 'git', 'checkout', '--quiet', base)
        for filename, blob in exports.items():
            destination = snapshot / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(blob)
        if (snapshot / 'package-lock.json').exists():
            command(snapshot, 'npm', 'ci', '--no-audit', '--no-fund', timeout=600)
        for args in (('npm', 'run', 'check'), ('npm', 'run', 'verify'), ('npm', 'test')):
            command(snapshot, *args, timeout=900)
        if not (snapshot / 'dist/writing' / slug / 'index.html').is_file():
            raise Refused('The site build did not produce this article.')
        for link in re.findall(r'\]\(([^\s)]+)', body) + re.findall(r'^\s*\[(?!\^)[^\]]+\]:\s*(\S+)', body, re.M):
            parsed = urlparse(unquote(link))
            if link.startswith('/') and not link.startswith('//'):
                target = (snapshot / 'dist' / parsed.path.lstrip('/')).resolve()
                if not target.is_relative_to((snapshot / 'dist').resolve()) or not (target.is_file() or (target / 'index.html').is_file()):
                    raise Refused('A link points to a missing public page or image.')
        # The site's build deliberately updates its edge cache validator on every build.
        manifest = 'src/data/assets.json'
        if (repo / manifest).is_file() and (snapshot / manifest).read_bytes() != (repo / manifest).read_bytes():
            old = json.loads((repo / manifest).read_text())
            new = json.loads((snapshot / manifest).read_text())
            if {k: v for k, v in old.items() if k != 'built'} != {k: v for k, v in new.items() if k != 'built'}:
                raise Refused('Site checks changed generated assets. Fix the site separately.')
            exports[manifest] = (snapshot / manifest).read_bytes()
        # All other generated changes must stay out of the release.
        command(snapshot, 'git', 'add', '--', *exports)
        changes = command(snapshot, 'git', 'diff', '--cached', '--name-only').splitlines()
        if not changes:
            raise Refused('This article export is already current on the site.')
        if not set(changes).issubset(exports) or command(snapshot, 'git', 'diff', '--name-only'):
            raise Refused('Site checks changed files outside this publication. Fix the site separately.')
        record = dict(id=identifier, path=path, source=sha, site_base=base, title=fields['title'], slug=slug,
                      changes=changes, metadata=output, created=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      repo=str(repo), config=self.config, assets=used, export_hash={p: hashlib.sha256(b).hexdigest() for p, b in exports.items()},
                      build_hash=digest_tree(snapshot / 'dist'))
        with self.lock:
            self.source_text(path, sha)
            if head(self.target()) != base:
                raise Refused('The site changed while preparing. Prepare again.', 409)
            record['created'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.save_record(record)
        return self.public(record)

    def preview_file(self, identifier, relative):
        record = self.record(identifier)
        root = self.store / identifier / 'site/dist'
        target = (root / unquote(relative)).resolve()
        if not target.is_relative_to(root.resolve()): raise Refused('No such preview file.', 404)
        if target.is_dir(): target /= 'index.html'
        if not target.is_file(): raise Refused('No such preview file.', 404)
        if target == root / 'writing' / record['slug'] / 'index.html':
            record['viewed'] = True
            self.save_record(record)
        return target

    def verify_candidate(self, record):
        if record['config'] != self.config:
            raise Refused('Publication setup changed. Prepare again.', 409)
        snapshot = self.store / record['id'] / 'site'
        if head(snapshot) != record['site_base'] or sorted(command(snapshot, 'git', 'diff', 'HEAD', '--name-only').splitlines()) != sorted(record['changes']):
            raise Refused('Preview site code changed. Prepare again.', 409)
        for filename, digest in record['export_hash'].items():
            target = snapshot / filename
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise Refused('Preview files changed. Prepare again.', 409)
        if digest_tree(snapshot / 'dist') != record['build_hash']:
            raise Refused('Preview build changed. Prepare again.', 409)
        return snapshot

    def publish(self, identifier, who, confirmed):
        with self.lock:
            record, repo, snapshot = self.commit_release(identifier, who, confirmed)
        return self.finish(record, repo, snapshot)

    def commit_release(self, identifier, who, confirmed):
        self.founder(who)
        if confirmed is not True:
            raise Refused('Confirm Publish this version first.', 403)
        record = self.record(identifier)
        if not record.get('viewed'):
            raise Refused('Open the private preview before publishing.', 409)
        latest = self.status(record['path'])
        if latest.get('id') != identifier:
            raise Refused('A newer preview exists. Prepare again.', 409)
        snapshot = self.verify_candidate(record)
        repo = self.target()
        expected = record.get('site_commit') or record['site_base']
        # Recover the tiny crash window between a Git commit and its local receipt.
        if head(repo) != expected:
            message = command(repo, 'git', 'show', '-s', '--format=%B')
            if not record.get('site_commit') and 'Descant-Preview: ' + identifier in message:
                changed = command(repo, 'git', 'diff', '--name-only', record['site_base'], 'HEAD').splitlines()
                if sorted(changed) != sorted(record['changes']): raise Refused('The site changed. Prepare again.', 409)
                for filename, digest in record['export_hash'].items():
                    if hashlib.sha256((repo / filename).read_bytes()).hexdigest() != digest:
                        raise Refused('The site changed. Prepare again.', 409)
                record['site_commit'] = head(repo)
                self.save_record(record)
            else: raise Refused('The site changed. Prepare again.', 409)
        if record.get('descant_commit'):
            # A retry acknowledges the recorded release; it never republishes newer prose.
            return record, repo, snapshot
        original = self.blob(record['source'], record['path']).decode('utf-8')
        fields, _, _ = frontmatter(original)
        end = original.index('\n---', 4)
        after = re.sub(r'^published:\s*(?:false|true)\s*$', 'published: true', original[:end], flags=re.M) + original[end:]
        receipt = command(self.source, 'git', 'log', '-1', '--format=%H', '--fixed-strings', '--grep=Descant-Preview: ' + identifier)
        recovered = bool(receipt) and self.blob(receipt, record['path']).decode('utf-8') == after
        if not recovered:
            self.source_text(record['path'], record['source'])
        for path in record['assets']:
            if not recovered and (self.blob('HEAD', path) != self.blob(record['source'], path) or command(self.source, 'git', 'status', '--porcelain', '--', path)):
                raise Refused('An approved image changed. Prepare again.', 409)
        if not record.get('site_commit'):
            before = {filename: (repo / filename).read_bytes() if (repo / filename).exists() else None for filename in record['changes']}
            changes = {filename: (snapshot / filename).read_bytes() for filename in record['changes']}
            before_sha = head(repo)
            try:
                for filename in record['changes']:
                    target = repo / filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(changes[filename])
                command(repo, 'git', 'add', '--', *record['changes'])
                subject = ('Correct: ' if fields['published'] else 'Publish: ') + record['title']
                trailers = 'Descant-Source: ' + record['source'] + '\nDescant-Preview: ' + identifier + '\nPrincipal: ' + who + '\nActor: human\nBasis: instruction'
                command(repo, 'git', 'commit', '--author', self.authors[who], '-m', subject, '-m', trailers, '--', *record['changes'])
            except Refused:
                if not landed_commit(repo, before_sha, changes):
                    for filename, blob in before.items():
                        target = repo / filename
                        if blob is None:
                            target.unlink(missing_ok=True)
                        else: target.write_bytes(blob)
                    command(repo, 'git', 'reset', '--quiet', '--', *record['changes'])
                    raise
            record['site_commit'] = head(repo)
            record['publisher'] = who
            self.save_record(record)
        if recovered:
            record['descant_commit'] = receipt
        elif after == original:
            # Corrections still leave a source-side publication receipt in Git.
            command(self.source, 'git', 'commit', '--allow-empty', '--only', '--author', self.authors[who],
                    '-m', 'Record publication: ' + record['title'], '-m',
                    'Descant-Preview: ' + identifier + '\nSite-Commit: ' + record['site_commit'] + '\nPrincipal: ' + who + '\nActor: human\nBasis: instruction')
            record['descant_commit'] = head(self.source)
        else:
            target = self.source / record['path']
            before_sha = head(self.source)
            target.write_text(after)
            try:
                command(self.source, 'git', 'commit', '--author', self.authors[who], '-m', 'Record publication: ' + record['title'],
                        '-m', 'Descant-Preview: ' + identifier + '\nSite-Commit: ' + record['site_commit'] + '\nPrincipal: ' + who + '\nActor: human\nBasis: instruction', '--', record['path'])
            except Refused:
                if not landed_commit(self.source, before_sha, {record['path']: after.encode('utf-8')}):
                    target.write_text(original)
                    raise Refused('The site commit is saved, but Descant could not record it. Retry Publish.', 503)
            record['descant_commit'] = head(self.source)
        record['deployment'] = 'not configured'
        self.save_record(record)
        if self.on_source_commit: self.on_source_commit()
        return record, repo, snapshot

    def finish(self, record, repo, snapshot):
        remote = self.config.get('push_remote')
        deploy = self.config.get('deploy')
        if remote and not record.get('pushed'):
            audit = self.config.get('publish_audit')
            if not isinstance(audit, list) or not audit or any(not isinstance(x, str) for x in audit):
                raise Refused('The site commit is saved. Configure the publish audit before pushing.', 503)
            command(repo, *audit, timeout=120)
            # Push the pinned commit only, never whichever HEAD is now at the checkout.
            command(repo, 'git', 'push', '--', remote, record['site_commit'] + ':refs/heads/' + self.config['branch'], timeout=120)
            record['pushed'] = True
            self.save_record(record)
        if deploy and record.get('deployment') != 'command succeeded':
            if not isinstance(deploy, list) or not deploy or any(not isinstance(x, str) for x in deploy):
                raise Refused('The site commit is saved. The deploy command must be an argument list.', 503)
            # Deploy exactly the immutable dist that the founder saw, with that site's code.
            try: command(snapshot, *deploy, timeout=900)
            except Refused:
                record['deployment'] = 'failed; site commit saved'
                self.save_record(record)
                raise Refused('The site commit is saved. Deployment failed; retry Publish. The live site has not been verified.', 503)
            record['deployment'] = 'command succeeded'
            self.save_record(record)
        return self.public(record)
