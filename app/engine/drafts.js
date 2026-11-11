/* Versions. A is the article, the only text that publishes; other
   versions are whole texts kept beside it in drafts/<writer>/, or a saved point
   from history. Versions are read side by side in aligned rows, and a paragraph
   taken from one is an ordinary save of the article. Finish puts unused
   versions away: a commit removes the file and its text stays in history. */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {}), D = global.document;
  var MAX = 3, STALE = 14 * 864e5, LETTERS = 'ABC';
  var P = { body: null, entries: [], away: [], chosen: null, busy: false, message: '', request: 0, mounted: false };
  var V = null, screen = null, banner = null, inertNodes = [];
  var names = Castor.people ? Castor.people.names() : {};
  function path() { return Castor.piecePath ? Castor.piecePath() : ''; }
  function piece() { return path().split('/drafts/')[0].replace(/\/article\.md$/, ''); }
  function articlePath() { return piece() + '/article.md'; }
  function who() { return Castor.who && Castor.who.get(); }
  function data() { return (Castor.app && Castor.app.data) || {}; }
  function mode() { var app = D.getElementById('app'); return (app && app.dataset && app.dataset.mode) || 'desktop'; }
  function node(tag, text, cls) {
    var n = D.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function button(text, work, cls) {
    var n = node('button', text, cls || 'versions-button'); n.type = 'button';
    n.addEventListener('click', work); return n;
  }
  function call(url, payload) {
    return global.fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : { cache: 'no-store' }).then(function (r) {
      // A reply that is not JSON: offline, the service worker's plain text; online, a server error. Say which.
      return r.json().catch(function () { throw online() ? new Error('The server answered with an error (' + r.status + ').') : offline(); })
        .then(function (body) { if (!r.ok) throw new Error(body.error || 'The version could not be saved.'); return body; });
    }, function () {
      if (!online()) throw offline();
      var e = new Error('The server did not answer.'); e.unanswered = true; throw e;
    });
  }
  function online() { return !(global.navigator && global.navigator.onLine === false); }
  function offline() { var e = new Error('Versions need a connection.'); e.offline = true; return e; }
  /* A version an agent wrote but did not commit has no commit to name in Taken-from:
     or to put away from. The writer's own is committed first (only that file); another
     writer's says why it cannot be used yet. */
  function recorded(o) {
    var e = o.entry;
    if (!e || (e.recorded !== false && e.sha)) return Promise.resolve();
    if (!mine(e)) return Promise.reject(new Error((names[e.person] || e.person) + '’s version is not committed yet. Ask their agent to commit it.'));
    return call(Castor.endpoints.api('drafts'), { action: 'record', piece: piece(), who: who(), path: e.path, markdown: e.markdown }).then(function (got) {
      e.sha = got.sha; e.recorded = true; o.origin = e.path + '@' + got.sha;
    });
  }
  function mine(entry) { return !!entry && entry.person === who(); }
  function day(when) {
    var d = new Date(when);
    return isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  }
  // A save is named by when it was made, short: today its time ("14:32"), another day its date
  // and time ("9 Nov 14:32"), another year with the year. Saves in one minute add seconds.
  function moment(when, seconds) {
    var d = new Date(when), now = new Date();
    if (!isFinite(d.getTime())) return '';
    var time = d.toLocaleTimeString('en-GB', seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString('en-GB', d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + time;
  }
  function blocksOf(markdown) {
    // Compared as plain LF text: a CRLF version's front matter and paragraphs read as anyone's.
    return Castor.md.parse(String(markdown || '').replace(/\r\n?/g, '\n')).blocks.filter(function (b) { return b.type !== 'frontmatter'; });
  }
  function agentish(text) { return /\b(claude|gpt|gemini|llama|mistral|deepseek|codex|sonnet|opus|haiku|fable|kimi|agent)/i.test(text || ''); }

  /* --- what can be compared ------------------------------------------------- */
  function saves() {
    var list = (data().versions || []).slice(0, -1).reverse().slice(0, 6), minutes = list.map(function (save) { return moment(save.when); });
    return list.map(function (save, i) {
      var twice = minutes[i] && minutes.indexOf(minutes[i]) !== minutes.lastIndexOf(minutes[i]);
      return { key: 'save:' + save.sha, title: ('Saved ' + moment(save.when, twice)).trim(), by: save.who || 'Unknown', when: save.when,
        markdown: save.markdown, origin: articlePath() + '@' + save.sha, agent: save.authorRole === 'agent', history: true };
    });
  }
  // A by: line may open with a writer's key; show their name.
  function byLine(entry) { return (entry.by || entry.person).replace(/^[a-z0-9-]+\b/, function (k) { return names[k] || k; }); }
  function fileVersion(entry) {
    return { key: 'file:' + entry.path, title: entry.title, by: byLine(entry), when: entry.date,
      markdown: entry.markdown, origin: entry.path + '@' + entry.sha, agent: agentish(entry.by), entry: entry };
  }
  function awayVersion(entry) {
    return { key: 'away:' + entry.path + '@' + entry.sha, title: entry.title, by: byLine(entry),
      when: entry.removed, markdown: entry.markdown, origin: entry.path + '@' + entry.sha, agent: agentish(entry.by), history: true, away: entry };
  }
  function candidates() { return P.entries.map(fileVersion).concat(saves(), P.away.map(awayVersion)); }
  function chosen() {
    if (!P.chosen) return [];
    var known = candidates().map(function (c) { return c.key; });
    P.chosen = P.chosen.filter(function (k) { return known.indexOf(k) >= 0; });
    return P.chosen;
  }

  /* --- the panel ------------------------------------------------------------ */
  function act(work) {
    if (P.busy) return Promise.resolve();
    P.busy = true; P.message = ''; render();
    return Promise.resolve().then(work).catch(function (e) { P.message = e.message || 'The version could not be saved.'; })
      .then(function () { P.busy = false; render(); });
  }
  function saved() {
    return Castor.saver.flush().then(function () {
      var snap = Castor.saver.snapshot();
      if (snap.path !== path() || (Castor.saver.state() !== 'locked' && (!snap.base || !snap.clean))) throw new Error('Save the current text before continuing.');
      return snap;
    });
  }
  function refresh() {
    renderBanner();
    var wanted = ++P.request, folder = piece(), person = who();
    if (!/^articles\/[^/]+$/.test(folder) || !names[person]) { P.entries = []; P.away = []; render(); return Promise.resolve(); }
    return call(Castor.endpoints.api('drafts?piece=') + encodeURIComponent(folder) + '&who=' + person + '&away=1').then(function (got) {
      if (wanted !== P.request || folder !== piece() || person !== who()) return;
      P.entries = got.drafts || []; P.away = got.away || [];
      // First choice: this writer's own versions, newest first. Another writer's is one tap away.
      if (!P.chosen) P.chosen = P.entries.filter(mine).sort(function (x, y) { return x.path < y.path ? 1 : -1; })
        .slice(0, MAX - 1).map(function (e) { return 'file:' + e.path; });
      if (P.unlisted) P.message = '';
      P.unlisted = false;
      render();
      if (Castor.capsule && Castor.capsule.arrange) Castor.capsule.arrange();
    }).catch(function (e) { if (wanted === P.request) { P.entries = []; P.away = []; P.unlisted = true; P.message = e.message; render(); } });
  }
  function versionRow(c, letter, on) {
    var row = node('div', null, 'versions-row'), pick = node('button', null, 'versions-pick');
    pick.type = 'button'; pick.setAttribute('role', 'checkbox'); pick.setAttribute('aria-checked', String(on));
    var full = !on && chosen().length >= MAX - 1;
    pick.disabled = P.busy || !c || full;
    if (!c) pick.setAttribute('aria-disabled', 'true');
    pick.appendChild(node('span', letter || '', 'versions-chip' + (c && c.agent ? ' is-agent' : '')));
    var words = node('span', null, 'versions-words');
    words.appendChild(node('b', c ? c.title : 'This article'));
    words.appendChild(node('span', c ? [c.by, day(c.when)].filter(Boolean).join(' · ') : 'The text that publishes'));
    pick.appendChild(words);
    if (c) pick.addEventListener('click', function () {
      var list = chosen(), at = list.indexOf(c.key);
      if (at >= 0) list.splice(at, 1); else if (list.length < MAX - 1) list.push(c.key);
      render();
    });
    row.appendChild(pick);
    return row;
  }
  // iOS opens the keyboard over the bottom of the sheet, and on a first focus resizes the view twice.
  // While the field has focus, each resize brings it to the middle once the sheet has settled.
  function aboveKeyboard(input) {
    var vv = global.visualViewport, timer = 0;
    if (!vv || !global.matchMedia || !global.matchMedia('(pointer: coarse)').matches) return;
    function place() { if (D.activeElement === input && input.scrollIntoView) input.scrollIntoView({ block: 'center' }); }
    function settle() { global.clearTimeout(timer); timer = global.setTimeout(place, 250); }
    function stop() { global.clearTimeout(timer); vv.removeEventListener('resize', settle); input.removeEventListener('blur', stop); }
    vv.addEventListener('resize', settle); input.addEventListener('blur', stop);
    settle();
  }
  function render() {
    renderBanner();
    var body = P.body;
    if (!body) return;
    var scope = JSON.stringify([path(), who()]), form = body.querySelector('.versions-create');
    if (form && form.versionScope === scope) {
      Array.prototype.slice.call(body.children).forEach(function (child) { if (child !== form) child.remove(); });
      form.children[0].disabled = P.busy;
      form.children[1].disabled = P.busy || P.unlisted;
    } else { body.textContent = ''; form = null; }
    var beforeForm = true;
    function append(child) {
      if (form && form.parentNode === body && beforeForm) body.insertBefore(child, form);
      else body.appendChild(child);
    }
    append(node('p', 'Read versions side by side and take paragraphs into the article. A is the article: the text that publishes.', 'versions-note'));
    if (P.message) { var notice = node('p', P.message, 'versions-note'); notice.setAttribute('role', 'status'); append(notice); }
    if (!names[who()]) { append(node('p', 'Choose who is writing to open versions.', 'versions-note')); return; }
    if (P.unlisted) return;  // the listing failed: say why, and claim nothing about what versions exist
    var list = chosen(), letter = function (key) { var i = list.indexOf(key); return i < 0 ? '' : LETTERS[i + 1]; };
    append(node('h3', 'Open versions', 'versions-group'));
    append(versionRow(null, 'A', true));
    P.entries.forEach(function (entry) {
      var c = fileVersion(entry), row = versionRow(c, letter(c.key), list.indexOf(c.key) >= 0), tools = node('div', null, 'versions-tools');
      tools.appendChild(button('Edit', function () { return act(function () { return saved().then(function () { return open(entry.path); }); }); }, 'versions-link'));
      // Only the writer's own, and never the file open in the editor.
      if (mine(entry) && entry.path !== path() && Date.now() - new Date(entry.date).getTime() >= STALE) {
        tools.appendChild(node('span', 'Open since ' + day(entry.date) + '.', 'versions-note'));
        tools.appendChild(button('Put away?', function () { return act(function () { return putAway(entry); }); }, 'versions-link'));
      }
      row.appendChild(tools); append(row);
    });
    if (!P.entries.length) append(node('p', 'No other versions yet. An agent’s rewrite, or a copy you make to try another way, appears here.', 'versions-note'));
    if (!form) {
      form = node('form', null, 'versions-create'); form.versionScope = scope;
      var title = node('input');
      title.type = 'text'; title.placeholder = 'Name of a new version'; title.maxLength = 100; title.required = true;
      title.setAttribute('aria-label', 'Name of a new version'); title.disabled = P.busy;
      title.addEventListener('focus', function () { aboveKeyboard(title); });
      var create = button('Copy the article', function () {}); create.type = 'submit'; create.disabled = P.busy;
      form.appendChild(title); form.appendChild(create);
      form.addEventListener('submit', function (e) {
        e.preventDefault(); var name = title.value.trim(); if (!name) return;
        return act(function () {
          return saved().then(function () { return call(Castor.endpoints.api('drafts'), { action: 'create', piece: piece(), who: who(), title: name, copy: true }); })
            .then(function (entry) { return open(entry.path); });
        });
      });
      append(form);
    }
    beforeForm = false;
    var history = saves().concat(P.away.map(awayVersion));
    if (history.length) append(node('h3', 'From history', 'versions-group'));
    history.forEach(function (c) {
      var row = versionRow(c, letter(c.key), list.indexOf(c.key) >= 0);
      if (c.away && mine(c.away)) {
        var tools = node('div', null, 'versions-tools');
        tools.appendChild(node('span', 'Put away ' + day(c.when) + '.', 'versions-note'));
        tools.appendChild(button('Bring back', function () { return act(function () {
          return call(Castor.endpoints.api('drafts'), { action: 'restore', piece: piece(), who: who(), path: c.away.path, sha: c.away.sha }).then(refresh);
        }); }, 'versions-link'));
        row.appendChild(tools);
      }
      append(row);
    });
    var go = button(list.length ? 'Compare ' + (list.length + 1) + ' versions' : 'Choose a version to compare', function () { compare(); }, 'versions-go');
    go.disabled = P.busy || !list.length || path() !== articlePath();
    append(go);
  }
  function open(target) {
    return Castor.pieces.open(target).then(function (opened) {
      if (!opened) throw new Error('The version could not be opened.');
      Castor.panels.close('drafts');
    });
  }
  function putAway(entry) {
    return saved().then(function () { return recorded({ entry: entry }); }).then(function () { return call(Castor.endpoints.api('drafts'), { action: 'away', piece: piece(), who: who(), path: entry.path, base: entry.sha }); }).then(function () {
      P.message = 'Put away: ' + entry.title + '. Its text stays in history, under From history.';
      return refresh();
    });
  }
  function renderBanner() {
    var app = D.getElementById('app'), editing = !!(data().piece && data().piece.draft);
    // Only A publishes: with a version open, the bar has nothing to publish.
    if (app) { if (editing) app.setAttribute('data-editing-version', ''); else app.removeAttribute('data-editing-version'); }
    var article = D.getElementById('page-article');
    if (!article || !article.parentNode) return;
    if (!banner) { banner = node('div', null, 'drafts-context'); article.parentNode.insertBefore(banner, article); }
    banner.textContent = '';
    var draft = data().piece && data().piece.draft;
    banner.hidden = !draft;
    if (!draft) return;
    banner.appendChild(node('span', 'Version: ' + draft.title));
    banner.appendChild(button('Back to article', function () {
      return act(function () { return saved().then(function () { return Castor.pieces.open(articlePath()); }); });
    }));
    banner.appendChild(button('Compare with the article', function () {
      var key = 'file:' + draft.path;
      return act(function () {
        return saved().then(function () { return Castor.pieces.open(articlePath()); }).then(refresh).then(function () { P.chosen = [key]; compare(); });
      });
    }));
  }

  /* --- the comparison ------------------------------------------------------- */
  function compare() {
    if (path() !== articlePath() || !Castor.diff || !Castor.diff.align) return;
    var pool = candidates(), list = chosen().map(function (k) { return pool.filter(function (c) { return c.key === k; })[0]; }).filter(Boolean);
    if (!list.length) return;
    return saved().then(function () {
      V = Object.assign({ other: 0, saving: false }, build(list.map(function (c, i) { return Object.assign({ letter: LETTERS[i + 1], blocks: blocksOf(c.markdown) }, c); })));
      if (Castor.panels && Castor.panels.close) Castor.panels.close('drafts');
      show();
    }).catch(function (e) { P.message = e.message; render(); });
  }
  // Rows from the article as it is saved now. Invisible blocks (link definitions) get no row.
  function build(versions) {
    var source = Castor.editor.getSource(), blocks = blocksOf(source);
    var rows = Castor.diff.align(blocks, versions.map(function (o) { return o.blocks; }));
    rows.forEach(function (row) {
      row.visible = row.a.some(function (i) { return blocks[i].html; }) || row.cells.some(function (cell, v) { return cell.some(function (j) { return versions[v].blocks[j].html; }); });
      row.differs = row.visible && row.cells.some(function (cell, v) { return text(versions[v].blocks, cell) !== text(blocks, row.a); });
    });
    return { source: source, expected: source, blocks: blocks, versions: versions, rows: rows, results: {}, carried: {}, show: {}, current: -1, message: '' };
  }
  function text(blocks, indices) { return indices.map(function (i) { return blocks[i].source; }).join('\n\n'); }
  function differing() { return V.rows.map(function (row, r) { return row.differs ? r : -1; }).filter(function (r) { return r >= 0; }); }
  function decided(r) { return V.results[r] != null || V.carried[r] != null; }
  function show() {
    var app = D.getElementById('app') || D.body;
    if (!screen) {
      screen = node('section', null, 'versions-screen'); screen.setAttribute('aria-label', 'Compare versions');
      screen.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'j' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) { e.preventDefault(); next(); }
      });
      app.appendChild(screen);
    }
    inertNodes = Array.prototype.filter.call(app.children, function (n) { return n !== screen && !n.inert; });
    inertNodes.forEach(function (n) { n.inert = true; });
    screen.hidden = false; app.setAttribute('data-versions', 'open');
    paint();
    var back = screen.querySelector('.versions-back'); if (back) back.focus();
  }
  function close() {
    V = null;
    if (screen) { screen.hidden = true; screen.textContent = ''; }
    inertNodes.forEach(function (n) { n.inert = false; }); inertNodes = [];
    var app = D.getElementById('app'); if (app) app.removeAttribute('data-versions');
    refresh();
  }
  function openInArticle(source) {
    close();
    var ed = Castor.editor, b = ed.getBlocks && ed.getBlocks().filter(function (x) { return x.source === source; })[0];
    if (!b || !ed.focusBlock) return;
    ed.focusBlock(b.id, 0);
    var n = D.querySelector && D.querySelector('#page-article [data-block-id="' + b.id + '"]');
    if (n && n.scrollIntoView) n.scrollIntoView({ block: 'center' });
  }
  function columns() {
    if (mode() === 'phone') return [];
    if (mode() === 'tablet') return [V.other];
    return V.versions.map(function (o, v) { return v; });
  }
  function chip(o, agent) { return node('span', o, 'versions-chip' + (agent ? ' is-agent' : '')); }
  function cellHtml(blocks, indices) {
    return indices.map(function (i) { return (blocks[i].html || '').replace(/ (?:data-block-id|id)="[^"]*"/g, ''); }).join('');
  }
  // Word marks: B's inserted words lit, a small mark where A's words are gone.
  function mark(el, ops) {
    var walker = D.createTreeWalker(el, 4), nodes = [], at = 0, n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: at }); at += n.data.length; }
    var spans = [], pos = 0;
    ops.forEach(function (op) {
      if (op.op === 'eq') pos += op.text.length;
      else if (op.op === 'ins') { if (op.text.trim()) spans.push({ start: pos + op.text.length - op.text.trimStart().length, end: pos + op.text.length }); pos += op.text.length; }
      else if (op.text.trim()) spans.push({ start: pos, end: pos, cut: op.text.trim() });
    });
    spans.reverse().forEach(function (s) {
      var hit = nodes.filter(function (x) { return x.start <= s.start && s.start <= x.start + x.node.data.length; }).pop();
      if (!hit) return;
      var range = D.createRange(), end = Math.min(s.end - hit.start, hit.node.data.length);
      range.setStart(hit.node, s.start - hit.start); range.setEnd(hit.node, s.cut ? s.start - hit.start : end);
      var wrap = node(s.cut ? 'span' : 'mark', null, s.cut ? 'versions-cut' : 'versions-ins');
      if (s.cut) { wrap.setAttribute('role', 'img'); wrap.setAttribute('aria-label', 'Cut: ' + s.cut); wrap.title = s.cut; }
      try { if (s.cut) range.insertNode(wrap); else range.surroundContents(wrap); } catch (e) { /* a mark never costs the text */ }
    });
  }
  function label(row, v) {
    var o = V.versions[v], a = row.a.length, x = row.cells[v].length;
    if (!x) return a ? 'Not in ' + o.letter : 'Nothing here';
    if (!a) return V.blocks.some(function (b) { return b.source === o.blocks[row.cells[v][0]].source; }) ? 'Only here in ' + o.letter + '; A has it elsewhere' : 'Only in ' + o.letter;
    if (text(o.blocks, row.cells[v]) === text(V.blocks, row.a)) return 'Same as A';
    if (a === 1 && x > 1) return 'Split in ' + x + ' in ' + o.letter;
    if (a > 1 && x === 1) return a + ' paragraphs joined in ' + o.letter;
    var ops = Castor.diff.words(text(V.blocks, row.a), text(o.blocks, row.cells[v]));
    var changed = ops.filter(function (op) { return op.op !== 'eq'; }).reduce(function (n, op) { return n + op.text.length; }, 0);
    return changed < text(V.blocks, row.a).length * .5 ? 'Edited' : 'Rewritten';
  }
  function takeButton(r, v) {
    var row = V.rows[r], o = V.versions[v], cell = row.cells[v];
    if (!row.differs) return null;
    if (V.results[r] === v || V.carried[r] === v) return node('span', 'In the article', 'versions-in');
    if (!cell.length && !row.a.length) return null;
    var words = !cell.length ? 'Leave it out, as ' + o.letter + ' does' : row.a.length ? 'Use ' + o.letter + ' here' : 'Add ' + o.letter + '’s paragraph';
    var b = button(words, function () { take(r, v, b); }, 'versions-take');
    b.disabled = V.saving;
    return b;
  }
  function aCell(r) {
    var row = V.rows[r], cell = node('div', null, 'versions-cell'), meta = node('p', null, 'versions-meta'), result = V.results[r];
    cell.setAttribute('data-v', 'A');
    if (result == null && typeof V.carried[r] === 'number') {
      // A footnote a taken paragraph cites: it came along, and goes with that paragraph's Undo.
      result = V.carried[r];
      meta.appendChild(chip(V.versions[result].letter, V.versions[result].agent));
      meta.appendChild(D.createTextNode('Came with ' + V.versions[result].letter + '’s paragraph'));
    } else if (typeof result === 'number') {
      meta.appendChild(chip(V.versions[result].letter, V.versions[result].agent));
      meta.appendChild(D.createTextNode('From ' + V.versions[result].letter + ' · '));
      meta.appendChild(button('Undo', function () { take(r, null); }, 'versions-link'));
    } else if (result === 'keep') {
      meta.appendChild(D.createTextNode('Kept A · '));
      meta.appendChild(button('Change', function () { delete V.results[r]; paint(); }, 'versions-link'));
    } else if (row.differs) meta.appendChild(button(row.a.length ? 'Keep A' : 'Keep it out', function () { V.results[r] = 'keep'; paint(); }, 'versions-link'));
    var shown = typeof result === 'number' ? { blocks: V.versions[result].blocks, cell: row.cells[result] } : { blocks: V.blocks, cell: row.a };
    // A is read-only here; editing happens in the article, on the same paragraph.
    if (row.differs && shown.cell.length) meta.appendChild(button('Open in article', function () { openInArticle(shown.blocks[shown.cell[0]].source); }, 'versions-link versions-open'));
    cell.appendChild(meta);
    var body = node('div', null, 'versions-text');
    if (shown.cell.length) body.innerHTML = cellHtml(shown.blocks, shown.cell);
    else { body.textContent = typeof result === 'number' ? 'Left out' : 'Not in the article'; body.className += ' is-empty'; }
    cell.appendChild(body);
    return cell;
  }
  function vCell(r, v) {
    var row = V.rows[r], o = V.versions[v], cell = node('div', null, 'versions-cell'), meta = node('p', null, 'versions-meta');
    cell.setAttribute('data-v', o.letter);
    if (row.differs) meta.textContent = label(row, v);
    cell.appendChild(meta);
    var body = node('div', null, 'versions-text' + (row.differs ? '' : ' is-same'));
    if (row.cells[v].length) {
      body.innerHTML = cellHtml(o.blocks, row.cells[v]);
      if (row.differs && row.a.length && /^Edited/.test(meta.textContent)) {
        var a = node('div'); a.innerHTML = cellHtml(V.blocks, row.a);
        mark(body, Castor.diff.words(a.textContent, body.textContent));
      }
    } else { body.textContent = 'Nothing here'; body.className += ' is-empty'; }
    cell.appendChild(body);
    var take = takeButton(r, v); if (take) cell.appendChild(take);
    return cell;
  }
  function head() {
    var bar = node('header', null, 'versions-head'), phone = mode() === 'phone';
    var back = button(phone ? '' : 'Back to article', close, 'versions-back');
    back.setAttribute('aria-label', 'Back to article'); bar.appendChild(back);
    var all = differing(), decidedWords = all.filter(decided).length + ' of ' + all.length + ' decided';
    // On a phone the counter is the title.
    bar.appendChild(node('h1', phone ? decidedWords : (data().piece && data().piece.title || 'Article') + ' · ' + (V.versions.length + 1) + ' versions'));
    var count = node('span', phone ? '' : decidedWords, 'versions-count'); count.setAttribute('role', 'status'); bar.appendChild(count);
    var nextButton = button(phone ? 'Next' : 'Next difference', next, 'versions-next'); nextButton.setAttribute('aria-keyshortcuts', 'j'); nextButton.disabled = !all.length; bar.appendChild(nextButton);
    bar.appendChild(button('Done', finish, 'versions-done'));
    return bar;
  }
  function paint() {
    if (!V || !screen) return;
    var scroller = screen.querySelector('.versions-scroll'), top = scroller ? scroller.scrollTop : 0;
    screen.textContent = ''; screen.setAttribute('data-mode', mode());
    screen.appendChild(head());
    if (V.message) { var note = node('p', V.message, 'versions-message'); note.setAttribute('role', 'alert'); screen.appendChild(note); }
    var scroll = node('div', null, 'versions-scroll'), cols = columns();
    scroll.style.setProperty('--n', String(cols.length + 1));
    if (cols.length) {
      var heads = node('div', null, 'versions-cols');
      var aHead = node('div'); aHead.appendChild(chip('A')); aHead.appendChild(node('b', 'A · This article'));
      aHead.appendChild(node('small', 'The text that publishes')); heads.appendChild(aHead);
      cols.forEach(function (v) {
        var o = V.versions[v], h = node('div');
        h.appendChild(chip(o.letter, o.agent)); h.appendChild(node('b', o.letter + ' · ' + o.title));
        h.appendChild(node('small', [o.by, day(o.when)].filter(Boolean).join(' · ')));
        if (mode() === 'tablet' && V.versions.length > 1) {
          var seg = node('div', null, 'versions-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Second column');
          V.versions.forEach(function (other, k) { var s = button(other.letter + ' · ' + other.title, function () { V.other = k; paint(); }, 'versions-option'); s.setAttribute('aria-pressed', String(k === v)); seg.appendChild(s); });
          h.appendChild(seg);
        }
        heads.appendChild(h);
      });
      scroll.appendChild(heads);
    }
    V.rows.forEach(function (row, r) {
      if (!row.visible) return;
      var el = node('div', null, 'versions-rowline' + (row.differs ? ' differs' : '') + (r === V.current ? ' is-current' : ''));
      el.setAttribute('data-row', String(r));
      if (!cols.length && row.differs) {
        var pickV = V.show[r] == null ? -1 : V.show[r], seg = node('div', null, 'versions-seg');
        seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Show version');
        [-1].concat(V.versions.map(function (o, v) { return v; })).forEach(function (v) {
          var o = v < 0 ? { letter: 'A', title: 'Article' } : V.versions[v];
          var s = button(o.letter + ' · ' + (v < 0 ? 'Article' : o.title), function () { V.show[r] = v; V.current = r; paint(); }, 'versions-option');
          s.setAttribute('aria-pressed', String(v === pickV)); seg.appendChild(s);
        });
        el.appendChild(seg);
        el.appendChild(pickV < 0 ? aCell(r) : vCell(r, pickV));
      } else {
        el.appendChild(aCell(r));
        cols.forEach(function (v) { el.appendChild(vCell(r, v)); });
      }
      scroll.appendChild(el);
    });
    screen.appendChild(scroll);
    scroll.scrollTop = top;
  }
  function next() {
    var all = differing(), open = all.filter(function (r) { return !decided(r); }), pool = open.length ? open : all;
    if (!pool.length) return;
    V.current = pool.filter(function (r) { return r > V.current; })[0];
    if (V.current == null) V.current = pool[0];
    paint();
    var scroll = screen.querySelector('.versions-scroll'), row = screen.querySelector('[data-row="' + V.current + '"]'), heads = screen.querySelector('.versions-cols');
    if (scroll && row && row.getBoundingClientRect) scroll.scrollTo({ top: scroll.scrollTop + row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - (heads ? heads.offsetHeight : 0), behavior: 'smooth' });
  }

  /* A take is an ordinary save of the whole article; the commit records where
     the paragraph came from. Undo is a save of the article's own text back. */
  function take(r, v, control) {
    if (!V || V.saving) return;
    var before = Object.assign({}, V.results);
    if (v == null) delete V.results[r]; else V.results[r] = v;
    var markdown, info = {};
    try { markdown = Castor.diff.compose(V.source, V.blocks, V.rows, V.results, V.versions.map(function (o) { return o.blocks; }), info); }
    catch (e) { V.results = before; V.message = e.message; paint(); return; }
    var subject = v == null ? 'Undo a paragraph taken from another version' : 'Use a paragraph from ' + V.versions[v].letter + ', ' + V.versions[v].title;
    V.saving = true; V.message = '';
    if (control) { control.textContent = 'Saving…'; control.classList.add('castor-pending'); control.setAttribute('aria-busy', 'true'); }
    var readOnly = Castor.editor.isReadOnly && Castor.editor.isReadOnly();
    Castor.saver.flush().then(function () { return v == null ? null : recorded(V.versions[v]); }).then(function () {
      var snap = Castor.saver.snapshot(), origin = v == null ? [] : [V.versions[v].origin];
      if (snap.path !== articlePath() || !snap.base || !snap.clean || Castor.editor.getSource() !== V.expected) throw new Error('The article changed while comparing. Open the comparison again.');
      if (Castor.editor.setReadOnly) Castor.editor.setReadOnly(true);
      return call(Castor.endpoints.api('piece'), { path: articlePath(), markdown: markdown, base: snap.base, who: who(), subject: subject, taken: origin });
    }).then(function () {
      V.expected = markdown; V.carried = info.carried || {};
      return Castor.app.reload();
    }).catch(function (e) {
      if (V) { V.results = before; V.message = e.unanswered ? 'The server did not answer, so this take may not be saved. Check the article before taking it again.' : 'Not saved: ' + e.message + ' The article is as it was.'; }
    }).then(function () {
      if (Castor.editor.setReadOnly) Castor.editor.setReadOnly(!!readOnly);
      if (!V) return;
      V.saving = false; V.current = r; paint();
    });
  }
  // A save from elsewhere starts the comparison again from the saved article.
  function reloaded() {
    if (!V || V.saving || path() !== articlePath()) return;
    if (Castor.editor.getSource() === V.expected) return;
    V = Object.assign(V, build(V.versions), { message: 'The article changed elsewhere, so the comparison starts again from the saved article.' });
    paint();
  }

  /* --- finishing ------------------------------------------------------------ */
  // WebKit paints the article's comment washes onto text in Finish (its heading). The comparison
  // covers the article, so the washes are lifted while Finish is open. A wash the comments
  // repainted meanwhile is newer and stays.
  function liftWashes() {
    var reg = global.CSS && global.CSS.highlights, kept = [];
    if (!reg) return function () {};
    reg.forEach(function (h, k) { if (/^castor-comment-/.test(k)) kept.push([k, h]); });
    kept.forEach(function (e) { reg.delete(e[0]); });
    return function () { kept.forEach(function (e) { if (!reg.has(e[0])) reg.set(e[0], e[1]); }); };
  }
  function finish() {
    if (!V) return;
    var dialog = node('dialog', null, 'versions-finish'), keep = {};
    dialog.setAttribute('aria-label', 'Finish comparing');
    dialog.appendChild(node('h2', 'Finish comparing'));
    var used = {};
    Object.keys(V.results).forEach(function (r) { var v = V.results[r]; if (typeof v === 'number') used[v] = (used[v] || 0) + 1; });
    var parts = Object.keys(used).map(function (v) { return used[v] + (used[v] === 1 ? ' paragraph' : ' paragraphs') + ' from ' + V.versions[v].letter; });
    dialog.appendChild(node('p', parts.length ? 'The article now has ' + parts.join(' and ') + '. Everything else is as it was.' : 'You took nothing, so the article is unchanged.'));
    dialog.appendChild(node('p', 'Put away takes a version off the list. Its text stays in history, under Versions, From history.', 'versions-note'));
    V.versions.forEach(function (o, v) {
      var row = node('div', null, 'versions-keep');
      row.appendChild(chip(o.letter, o.agent));
      var words = node('span', null, 'versions-words'); words.appendChild(node('b', o.letter + ' · ' + o.title));
      var own = mine(o.entry);
      if (o.entry && !own) keep[v] = true;
      words.appendChild(node('span', !o.entry ? 'A point in history. It stays there.' : !own ? (names[o.entry.person] || o.entry.person) + '’s version. It stays open.'
        : used[v] ? used[v] + (used[v] === 1 ? ' paragraph' : ' paragraphs') + ' used' : 'Nothing used'));
      row.appendChild(words);
      if (own) {
        var seg = node('div', null, 'versions-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', o.title);
        ['Put away', 'Keep'].forEach(function (word) {
          var b = button(word, function () { keep[v] = word === 'Keep'; Array.prototype.forEach.call(seg.children, function (s) { s.setAttribute('aria-pressed', String(s === b)); }); }, 'versions-option');
          b.setAttribute('aria-pressed', String(word === 'Put away')); seg.appendChild(b);
        });
        row.appendChild(seg);
      }
      dialog.appendChild(row);
    });
    var status = node('p', '', 'versions-note'); status.setAttribute('role', 'status'); dialog.appendChild(status);
    var foot = node('div', null, 'versions-foot');
    foot.appendChild(button('Keep comparing', function () { dialog.close(); }));
    var go = button('Finish', function () {
      go.disabled = true; go.textContent = 'Putting away…'; go.classList.add('castor-pending'); go.setAttribute('aria-busy', 'true');
      V.versions.filter(function (o, v) { return o.entry && !keep[v]; }).reduce(function (chain, o) {
        return chain.then(function () { return recorded(o); }).then(function () { return call(Castor.endpoints.api('drafts'), { action: 'away', piece: piece(), who: who(), path: o.entry.path, base: o.entry.sha }); });
      }, Promise.resolve()).then(function () { dialog.close(); close(); }, function (e) {
        go.disabled = false; go.textContent = 'Finish'; go.classList.remove('castor-pending'); go.removeAttribute('aria-busy'); status.textContent = 'Not put away: ' + e.message;
      });
    }, 'versions-done');
    foot.appendChild(go); dialog.appendChild(foot);
    var putBack = liftWashes();
    dialog.addEventListener('close', function () { putBack(); dialog.remove(); });
    screen.appendChild(dialog); dialog.showModal();
  }

  Castor.drafts = Castor.versions = {
    mount: function () {
      if (P.mounted || (Castor.role && Castor.role.reviewer)) return;
      P.mounted = true;
      Castor.panels.register('drafts', { title: 'Versions', ready: true, mount: function (el) { P.body = el; render(); refresh(); } });
      Castor.bus.on('piece:open', function () { P.chosen = null; if (V) close(); else refresh(); });
      Castor.bus.on('who:set', refresh);
      Castor.bus.on('live:reload', function () { if (V) reloaded(); else refresh(); });
      global.addEventListener('resize', function () { if (V && screen && screen.getAttribute('data-mode') !== mode()) paint(); });
      setTimeout(refresh, 0);
    },
    refresh: refresh, compare: compare, count: function () { return P.entries.length; },
    _state: function () { return { panel: P, compare: V }; }
  };
})(window);
