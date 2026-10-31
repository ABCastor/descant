"""Comments-only program API and the durable mention queue. No model or secrets here."""
import copy
import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path

def writers(app):
    """The installation's writers: serve.py FOUNDERS, read from the space's people file."""
    return tuple(getattr(app, 'FOUNDERS', None) or ())


def aliases(app):
    """@agent, and each writer's key and first name, lowercased."""
    out = {'agent': 'agent'}
    for key in writers(app):
        out[key] = key
        first = (getattr(app, 'AUTHORS', {}).get(key) or '').split(' <')[0].split()
        if first:
            out.setdefault(first[0].lower(), key)
    return out


def recipients(text, app=None):
    # Code examples and email addresses do not notify anyone.
    text = re.sub(r'```[\s\S]*?```|`[^`]*`', '', str(text))
    names = aliases(app)
    pattern = re.compile(
        r'(?<![\w@])@(' + '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r')(?![\w.-])', re.I)
    return list(dict.fromkeys(names[m.group(1).lower()] for m in pattern.finditer(text)))


def queue_path(app):
    # A personal installation (install.json, made by tools/personal-package) keeps its app in
    # an ignored folder, so its queue lives in the writing space. Read at call time: the
    # server's directories can be pointed elsewhere after import (the test harnesses do).
    if (app.APP_DIR / 'install.json').is_file():
        return app.REPO_ROOT / '.mentions.json'
    return app.APP_DIR / 'mentions.json'


def queue(app, committed_only=False):
    target = queue_path(app)
    raw = recorded_bytes(app, target) if committed_only else (target.read_bytes() if target.exists() else None)
    return json.loads(raw) if raw is not None else {'events': [], 'read': {}}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def mention_change(app, path, before, after, who, manual_agent=False, operation=None):
    """New human tags only, committed atomically with their review file."""
    state = queue(app)
    count = len(state['events'])
    if operation and any(e.get('operation') == operation['id'] for e in state['events']):
        return queue_path(app), encoded(state)
    for identifier, document in after.items():
        thread = document['thread']
        old = before.get(identifier, {}).get('thread')
        previous = [old] + old['replies'] if old else []
        for index, message in enumerate([thread] + thread['replies']):
            if message.get('by') == 'agent':
                continue
            was = (old if index == 0 else next((m for m in previous[1:] if app.same_reply(m, message)), None))
            seen = recipients(was['text'], app) if was else []
            for recipient in recipients(message['text'], app):
                # Only server-stamped founder messages may request a model call.
                # A reviewer's body can carry a forged `who`, never this stamp.
                if recipient == 'agent' and message.get('writer') != 'founder:' + who:
                    continue
                if recipient in seen or recipient == who or (manual_agent and recipient == 'agent'):
                    continue
                event = {'id': len(state['events']) + 1, 'recipient': recipient,
                    'path': path, 'thread': identifier, 'message': message.get('id') or 'root',
                    'author': message['author'], 'principal': who, 'text': message['text'],
                    'created': operation['created'] if operation else datetime.datetime.now(datetime.timezone.utc).isoformat()}
                if operation: event['operation'] = operation['id']
                state['events'].append(event)
    return (queue_path(app), encoded(state)) if len(state['events']) != count else None


def article(app, value):
    path = app.article_path(value)
    if not path or not app.safe_piece(str(Path(path).parent)):
        raise ValueError('an existing article path is required')
    return path


def context(app, path):
    path = article(app, path)
    root = (app.REPO_ROOT / path).parent
    files, omitted, size = {}, [], 0
    for entry in sorted(root.rglob('*')):
        relative = entry.relative_to(root).as_posix()
        safe = app.sandbox_path(root, relative)
        if not safe or not safe.is_file():
            continue
        if any(part.startswith('.') for part in entry.relative_to(root).parts) or safe.suffix.lower() not in ('.md', '.txt', '.canvas'):
            omitted.append(relative)
            continue
        if safe.stat().st_size > 100_000 or size + safe.stat().st_size > 600_000:
            omitted.append(relative)
            continue
        try:
            content = safe.read_text('utf-8')
        except UnicodeError:
            omitted.append(relative)
            continue
        files[relative] = content
        size += safe.stat().st_size
    # The complete article is separate even if it exceeds the folder context limit.
    return {'path': path, 'sha': app.git('rev-parse', 'HEAD').stdout.strip(), 'markdown': (app.REPO_ROOT / path).read_text('utf-8'),
            'threads': app.comment_threads(path), 'files': files, 'omitted': omitted}


def recorded_bytes(app, target):
    relative = target.relative_to(app.REPO_ROOT).as_posix()
    listing = app.git('ls-tree', '-z', 'HEAD', '--', relative)
    if listing.returncode:
        raise ValueError('Git cannot verify the retained file')
    if not listing.stdout:
        return None
    stored = subprocess.run(['git', '-C', str(app.REPO_ROOT), 'show', 'HEAD:' + relative], capture_output=True, timeout=20)
    if stored.returncode:
        raise ValueError('Git cannot read the recorded file')
    return stored.stdout


def append(app, body):
    path = article(app, body.get('path'))
    actor = body.get('actor', '')
    if not isinstance(actor, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}', actor) or actor.lower() in ('human', 'you', 'both') + tuple(k for k in aliases(app) if k != 'agent'):
        raise ValueError('actor must name the agent, never a human')
    principal = body.get('principal')
    if principal not in writers(app):
        raise ValueError('principal must be one of the writers: ' + ', '.join(writers(app)))
    if 'model' in body and body['model'] != actor:
        raise ValueError('model must exactly match the declared actor')
    text = body.get('text')
    request_id = body.get('request_id')
    if not isinstance(text, str) or not text.strip() or len(text) > 30_000:
        raise ValueError('text must be 1 to 30000 characters')
    if any(app.MESSAGE_RE.match(line) for line in text.splitlines()):
        raise ValueError('text cannot contain a forged comment signature')
    app.reply_identity({'id': request_id})
    if not request_id:
        raise ValueError('request_id is required for safe retries')
    folder = (app.REPO_ROOT / path).parent / 'review'
    documents = [(target, app.comment_document(target)) for target in app.comment_files(folder)]
    identifier = str(body.get('thread') or '')
    if identifier:
        found = next(((target, doc) for target, doc in documents if doc['thread']['id'] == identifier), None)
        if not found:
            raise app.CommentRefused(404, 'unknown-thread', 'there is no such thread')
        target, document = found
        thread = copy.deepcopy(document['thread'])
        match = next((r for r in thread['replies'] if r.get('id') == request_id), None)
    else:
        found = next(((target, doc) for target, doc in documents if doc['thread'].get('clientId') == request_id), None)
        if found:
            target, document = found
            thread = copy.deepcopy(document['thread'])
            match = thread
        else:
            quote = body.get('quote') or ''
            if not isinstance(quote, str) or (quote and quote not in (app.REPO_ROOT / path).read_text('utf-8')):
                raise ValueError('quote must occur in the article')
            identifier = '%03d' % (max([int(doc['thread']['id']) for _, doc in documents] or [0]) + 1)
            thread = app.canonical_comment({'clientId': request_id, 'author': actor, 'by': 'agent',
                'principal': principal, 'model': actor, 'text': text, 'anchor': {'quote': quote}}, identifier)
            slug = app.comment_slug(text)
            target = folder / (identifier + '-' + slug + '.md')
            document = {'slug': slug, 'source': 'descant-agent', 'preamble': ''}
            match = None
    if match:
        if match['text'] != text or match['author'] != actor or match['by'] != 'agent' or match.get('principal') != principal or match.get('model') != actor:
            raise app.CommentRefused(409, 'request-conflict', 'this request_id already holds different words or attribution')
        current = target.read_bytes()
        committed = recorded_bytes(app, target)
        if committed != current:
            # A crash may leave only our exact new root or appended reply. Derive
            # that candidate from the request and HEAD, never adopt edited originals.
            if body.get('thread') and committed is not None:
                original = app.comment_document(target, committed.decode('utf-8'))
                expected = copy.deepcopy(original['thread'])
                if any(r.get('id') == request_id for r in expected['replies']):
                    raise app.CommentRefused(409, 'retained-comment-changed', 'the recorded comment has local changes; retry waits')
                expected['replies'].append(match)
                candidate = app.render_comment(original, expected).encode()
            elif not body.get('thread') and committed is None:
                expected = app.canonical_comment({'clientId':request_id,'author':actor,'by':'agent',
                    'principal':principal,'model':actor,'text':text,'created':match['created'],
                    'anchor':{'quote':body.get('quote') or ''}}, thread['id'])
                candidate = app.render_comment({'slug':app.comment_slug(text),'source':'descant-agent','preamble':''}, expected).encode()
            else:
                raise app.CommentRefused(409, 'retained-comment-changed', 'the recorded comment has local changes; retry waits')
            if current != candidate:
                raise app.CommentRefused(409, 'retained-comment-changed', 'other review changes are retained; retry waits')
        sha = app.commit_files({target:current}, 'Agent comment on ' + folder.parent.name,
            people=app.writing_session(principal), trailers='Principal: %s\nActor: %s\nBasis: instruction' % (principal, actor))
        return {'ok': True, 'thread': thread, 'sha':sha}
    if body.get('thread'):
        if recorded_bytes(app, target) != target.read_bytes():
            raise app.CommentRefused(409, 'original-comment-changed', 'the original review has local changes; append waits')
        thread['replies'].append({'id': request_id, 'author': actor, 'by': 'agent', 'principal': principal, 'model': actor,
            'created': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'text': text,
            'basis': 'the article, sources and thread', 'offer': None})
    rendered = app.render_comment(document, thread)
    checked = app.comment_document(target, rendered)['thread']
    message = checked['replies'][-1] if body.get('thread') else checked
    if checked['text'] != thread['text'] or checked['replies'] != thread['replies'] or message.get('principal') != principal or message.get('model') != actor:
        raise ValueError('comment text does not round-trip through Markdown')
    sha = app.commit_files({target: rendered.encode()}, 'Agent comment on ' + folder.parent.name,
        people=app.writing_session(principal), trailers='Principal: %s\nActor: %s\nBasis: instruction' % (principal, actor))
    return {'ok': True, 'thread': checked, 'sha': sha}


def batch(app, body):
    """A deliberate send is one immutable queue event, retried by its request ID."""
    path = article(app, body.get('path'))
    who, mode, identifiers, request_id = (body.get(k) for k in ('who', 'mode', 'threads', 'request_id'))
    if who not in writers(app) or mode not in ('tagged', 'everything', 'both'):
        raise ValueError('choose a founder and Tagged only, Everything or Both')
    if not isinstance(identifiers, list) or not identifiers or len(identifiers) > 200 or any(not isinstance(i, str) for i in identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError('choose 1 to 200 distinct saved notes')
    app.reply_identity({'id': request_id})
    if not request_id:
        raise ValueError('request_id is required for safe retries')
    request = {'path': path, 'who': who, 'mode': mode, 'threads': identifiers}
    target = queue_path(app)
    current = target.read_bytes() if target.is_file() else None
    committed = recorded_bytes(app, target)
    state = queue(app)
    old = next((e for e in state['events'] if e.get('request_id') == request_id or request_id in e.get('request_ids', [])), None)
    if old and old.get('request') != request:
        raise app.CommentRefused(409, 'request-conflict', 'this request already holds a different batch')
    retained = None
    if current != committed:
        base = json.loads(committed) if committed is not None else {'events': [], 'read': {}}
        if not old or any(e.get('request_id') == request_id or request_id in e.get('request_ids', []) for e in base['events']):
            raise app.CommentRefused(409, 'original-queue-changed', 'the recorded queue has local changes; send waits')
        original = next((e for e in base['events'] if e.get('id') == old.get('id')), None)
        if original:
            # A lost response may retain only our one added alias on a committed
            # immutable event. Never adopt its altered principal or snapshot.
            expected = copy.deepcopy(base)
            event = next(e for e in expected['events'] if e['id'] == original['id'])
            event.setdefault('request_ids', []).append(request_id)
            if current != encoded(expected):
                raise app.CommentRefused(409, 'original-queue-changed', 'other queue changes are retained; send waits')
            app.commit_files({target: current}, 'Confirm the same agent batch', people=app.writing_session(who))
            return {'ok': True, 'id':event['id'], 'thread':event['thread']}
        retained = old
        state = base
    elif old:
        app.commit_files({target:current}, 'Confirm the saved agent batch', people=app.writing_session(who))
        return {'ok': True, 'id':old['id'], 'thread':old['thread']}
    threads = {t['id']: t for t in app.comment_threads(path)}
    notes = []
    for identifier in identifiers:
        thread = threads.get(identifier)
        if not thread or thread['done']:
            raise ValueError('a chosen note is missing or marked done; reload and choose again')
        messages = [m for m in [thread] + thread['replies'] if m.get('by') != 'agent' and m.get('text', '').strip()]
        if not messages:
            raise ValueError('choose notes written by people')
        notes.append({'id': identifier, 'anchor': thread['anchor'], 'text': messages[0]['text'],
                      'messages': messages, 'tagged': any('agent' in recipients(m['text']) for m in messages)})
    questions = notes if mode == 'everything' else [n for n in notes if n['tagged']]
    if not questions:
        raise ValueError('no chosen notes tag @agent; choose Everything or tag a note')
    context_notes = [n for n in notes if not n['tagged']] if mode == 'both' else []
    snapshot = {'mode': mode, 'questions': questions, 'context': context_notes}
    article_revision = hashlib.sha256((app.REPO_ROOT / path).read_bytes()).hexdigest()
    # COMMENTS_LOCK serializes this comparison, including HTTP browsers without Web Locks.
    old = next((e for e in state['events'] if e.get('request') == request and e.get('batch') == snapshot and e.get('article_revision') == article_revision), None)
    if old:
        if retained:
            raise app.CommentRefused(409, 'retained-batch-changed', 'the retained batch differs from the current source; send waits')
        old.setdefault('request_ids', []).append(request_id)
        app.commit_files({queue_path(app): encoded(state)}, 'Confirm the same agent batch', people=app.writing_session(who))
        return {'ok': True, 'id': old['id'], 'thread': old['thread']}
    event = {'id': len(state['events']) + 1, 'recipient': 'agent', 'path': path,
             'thread': questions[0]['id'], 'principal': who, 'author': who,
             'text': 'Review these notes together.', 'request_id': request_id, 'request': request,
             'batch': snapshot,
             'article_revision': article_revision,
             'created': retained.get('created') if retained else datetime.datetime.now(datetime.timezone.utc).isoformat()}
    state['events'].append(event)
    if retained and current != encoded(state):
        raise app.CommentRefused(409, 'retained-batch-changed', 'the retained batch differs from these exact notes; send waits')
    app.commit_files({queue_path(app): encoded(state)}, 'Send notes to the agent', people=app.writing_session(who))
    return {'ok': True, 'id': event['id'], 'thread': event['thread']}
