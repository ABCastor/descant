/* Shared working drafts. Visibility is a convenience, never an access boundary. */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {});
  var banner, body, entries = [], showHidden = false, pending = null, position = null;
  var busy = false, message = '', request = 0, mounted = false;
  var names = Castor.people ? Castor.people.names() : {};
  function path() { return Castor.piecePath ? Castor.piecePath() : ''; }
  function piece() { return path().split('/drafts/')[0].replace(/\/article\.md$/, ''); }
  function who() { return Castor.who && Castor.who.get(); }
  function node(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function button(text, work) {
    var n = node('button', text, 'drafts-button'); n.type = 'button'; n.disabled = busy;
    n.addEventListener('click', work); return n;
  }
  function call(url, payload) {
    return global.fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (data) { if (!r.ok) throw new Error(data.error || 'The draft could not be saved.'); return data; });
    });
  }
  function openDraft(target) {
    return Castor.pieces.open(target).then(function (opened) {
      if (!opened) throw new Error('The draft could not be opened.');
      Castor.panels.close('drafts');
    });
  }
  function saved() {
    return Castor.saver.flush().then(function () {
      var snapshot = Castor.saver.snapshot();
      if (snapshot.path !== path() || (Castor.saver.state() !== 'locked' && (!snapshot.base || !snapshot.clean))) throw new Error('Save the current text before continuing.');
      return snapshot;
    });
  }
  function act(work) {
    if (busy) return Promise.resolve();
    busy = true; message = ''; render();
    return Promise.resolve().then(work).catch(function (e) { message = e.message || 'The draft could not be saved.'; })
      .then(function () { busy = false; render(); });
  }
  function refresh() {
    renderBanner();
    if (!body) return Promise.resolve();
    var wanted = ++request, folder = piece(), person = who();
    if (!/^articles\/[^/]+$/.test(folder) || !names[person]) { entries = []; render(); return Promise.resolve(); }
    return call('/api/drafts?piece=' + encodeURIComponent(folder) + '&who=' + person + (showHidden ? '&hidden=1' : ''))
      .then(function (data) {
        if (wanted !== request || folder !== piece() || person !== who()) return;
        entries = data.drafts || []; render();
      }).catch(function (e) { if (wanted === request) { entries = []; message = e.message; render(); } });
  }
  function capture() {
    if (!pending || path() !== piece() + '/article.md') return;
    var range = Castor.editor.getSourceRange();
    if (range && range.unsupported) { position = null; return; }
    if (range) position = { start: range.start, end: range.end, text: Castor.editor.getSource() };
  }
  function prepare(entry) {
    return act(function () {
      return saved().then(function (snapshot) {
        if (snapshot.path === entry.path) entry = Object.assign({}, entry, { sha: snapshot.base });
        return Castor.pieces.open(piece() + '/article.md');
      }).then(function (opened) {
        if (!opened) throw new Error('The article could not be opened.');
        pending = entry; position = null;
        message = 'Place the caret or select a passage within one paragraph, then move the draft.';
        Castor.panels.close('drafts');
      });
    });
  }
  function move() {
    capture();
    if (!position || !pending || path() !== piece() + '/article.md') {
      message = 'Place the caret or select a passage within one paragraph first.'; render(); return Promise.resolve();
    }
    var at = position, entry = pending, folder = piece(), readOnly = Castor.editor.isReadOnly();
    return act(function () {
      return saved().then(function (snapshot) {
        if (Castor.editor.getSource() !== at.text) throw new Error('The text changed. Choose the position again.');
        Castor.editor.setReadOnly(true);
        return call('/api/drafts', { action: 'move', piece: folder, path: entry.path, who: who(), base: entry.sha,
          articleBase: snapshot.base, start: at.start, end: at.end });
      }).then(function () {
        pending = null; position = null; message = 'Moved into the article. The original stays in Git.';
        return Castor.app.reload();
      }).finally(function () { Castor.editor.setReadOnly(readOnly); }).then(refresh);
    });
  }
  function visibility(entry) {
    var readOnly = Castor.editor.isReadOnly();
    return act(function () {
      return saved().then(function (snapshot) {
        if (snapshot.path === entry.path) Castor.editor.setReadOnly(true);
        return call('/api/drafts', { action: 'hide', piece: piece(), path: entry.path, who: who(),
          base: snapshot.path === entry.path ? snapshot.base : entry.sha, hidden: !entry.hidden });
      }).then(function () { return path() === entry.path ? Castor.app.reload() : null; }).finally(function () { Castor.editor.setReadOnly(readOnly); }).then(refresh);
    });
  }
  function renderBanner() {
    var article = document.getElementById('page-article');
    if (!article || !article.parentNode) return;
    if (!banner) { banner = node('div', null, 'drafts-context'); article.parentNode.insertBefore(banner, article); }
    banner.textContent = '';
    var draft = Castor.app.data.piece.draft;
    banner.hidden = !draft && !pending;
    if (draft) {
      banner.appendChild(node('span', 'Draft: ' + draft.title + ' (' + names[draft.person] + ')'));
      banner.appendChild(button('Back to article', function () {
        return act(function () { return saved().then(function () { return Castor.pieces.open(piece() + '/article.md'); }); });
      }));
      if (!draft.moved) banner.appendChild(button('Choose place in article', function () { return prepare(draft); }));
    } else if (pending) {
      banner.appendChild(node('span', 'Place the caret or select a passage for ' + pending.title + '.'));
      banner.appendChild(button('Move into the article', move));
      banner.appendChild(button('Cancel move', function () { pending = null; position = null; message = ''; render(); }));
    }
  }
  function render() {
    renderBanner();
    if (!body) return;
    body.textContent = '';
    body.appendChild(node('p', 'Try text here before moving it into the article. Drafts never go to outside readers.', 'drafts-note'));
    body.appendChild(node('p', 'Hidden is not secret. Both founders can read every draft in the repository.', 'drafts-note'));
    if (message) { var notice = node('p', message, 'drafts-note'); notice.setAttribute('role', 'status'); body.appendChild(notice); }
    if (!names[who()]) { body.appendChild(node('p', 'Choose who is writing to open drafts.', 'drafts-note')); return; }
    if (pending) {
      var target = node('div', null, 'drafts-actions');
      target.appendChild(node('p', 'Moving: ' + pending.title));
      target.appendChild(button('Move into the article', move));
      target.appendChild(button('Cancel move', function () { pending = null; position = null; message = ''; render(); }));
      body.appendChild(target);
    }
    if (path().indexOf('/drafts/') >= 0) body.appendChild(button('Back to article', function () {
      return act(function () { return saved().then(function () { return Castor.pieces.open(piece() + '/article.md'); }); });
    }));
    var form = node('form', null, 'drafts-create'), title = node('input');
    title.type = 'text'; title.placeholder = 'Draft title'; title.maxLength = 100; title.required = true;
    title.setAttribute('aria-label', 'Draft title'); title.disabled = busy;
    form.appendChild(title); var create = button('New draft', function () {}); create.type = 'submit'; form.appendChild(create);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); var name = title.value.trim(); if (!name) return;
      return act(function () { return saved().then(function () {
        return call('/api/drafts', { action: 'create', piece: piece(), who: who(), title: name });
      }).then(function (entry) { return openDraft(entry.path); }).then(refresh); });
    }); body.appendChild(form);
    var label = node('label', null, 'drafts-hidden'), check = node('input');
    check.type = 'checkbox'; check.checked = showHidden; check.disabled = busy;
    check.addEventListener('change', function () { showHidden = check.checked; refresh(); });
    label.appendChild(check); label.appendChild(node('span', "Show the other founder's hidden drafts")); if (Object.keys(names).length > 1) body.appendChild(label);
    Object.keys(names).forEach(function (person) {
      body.appendChild(node('h3', names[person], 'drafts-person'));
      var listed = entries.filter(function (entry) { return entry.person === person; });
      if (!listed.length) body.appendChild(node('p', 'No drafts yet.', 'drafts-note'));
      listed.forEach(function (entry) {
        var row = node('div', null, 'drafts-row');
        row.appendChild(button(entry.title, function () { return act(function () {
          return saved().then(function () { return openDraft(entry.path); });
        }); }));
        if (entry.hidden) row.appendChild(node('span', 'Hidden', 'drafts-note'));
        if (entry.moved) row.appendChild(node('span', 'Moved into article', 'drafts-note'));
        else row.appendChild(button('Choose place in article', function () { return prepare(entry); }));
        if (entry.person === who()) row.appendChild(button(entry.hidden ? 'Show' : 'Hide', function () { return visibility(entry); }));
        body.appendChild(row);
      });
    });
  }
  Castor.drafts = {
    mount: function () {
      if (mounted || (Castor.role && Castor.role.reviewer)) return;
      mounted = true;
      Castor.panels.register('drafts', { title: 'Drafts', ready: true, mount: function (el) { body = el; render(); refresh(); } });
      ['piece:open', 'live:reload', 'who:set'].forEach(function (event) {
        Castor.bus.on(event, function () {
          position = null;
          if (pending && pending.path.split('/drafts/')[0] !== piece()) pending = null;
          refresh();
        });
      });
      document.addEventListener('selectionchange', capture);
      renderBanner();
    },
    refresh: refresh
  };
})(window);
