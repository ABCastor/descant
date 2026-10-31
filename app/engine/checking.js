/* Descant paragraph observations, opened deliberately. No model or network calls. */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {}), DOC = global.document;
  var S = { review: null, view: 'all', active: 0, preview: null, message: '', root: null, mounted: false, undo: null, applying: false };
  var VIEW_KEY = 'descant.checking.view.v1';
  function el(tag, cls, text) { var n = DOC.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function button(parent, label, fn, disabled) { var n = el('button', null, label); n.setAttribute('type', 'button'); n.disabled = !!disabled; n.addEventListener('click', fn); parent.appendChild(n); return n; }
  function actionButton(parent, label, fn, mutation) { var n = button(parent, label, fn, !valid() || mutation && editor().isReadOnly && editor().isReadOnly()); S.actionButtons.push({ node: n, mutation: mutation }); return n; }
  function path() {
    var current = Castor.pieces && Castor.pieces.current ? Castor.pieces.current() :
      (typeof Castor.piecePath === 'function' ? Castor.piecePath() : Castor.piecePath);
    return typeof current === 'string' && current ? current : null;
  }
  function version() { return Castor.app && Castor.app.data && Castor.app.data.current || null; }
  function shown() { return !Castor.panels.isOpen || Castor.panels.isOpen('checking'); }
  function editor() { return Castor.editor; }
  function readBlocks() {
    var ed = editor(), blocks = ed.getBlocks(), native = ed.getCurrentSource(), model = ed.getSource();
    if (native !== model) {
      var focus = ed.focusedBlockId(), offset = 0;
      blocks.forEach(function (b, i) {
        var gap = typeof b.sep === 'string' ? b.sep : (i ? '\n\n' : ''); offset += gap.length;
        if (b.id === focus) {
          var suffix = model.slice(offset + b.source.length);
          if (native.slice(0, offset) !== model.slice(0, offset) || native.slice(native.length - suffix.length) !== suffix) throw Error('Native paragraph unavailable');
          b.source = native.slice(offset, native.length - suffix.length);
        } else offset += b.source.length;
      });
    }
    return blocks;
  }
  /* An open decision is marked [FOUNDERS: ...], [WRITERS: ...] or with a listed writer's key
     or first name in capitals, as in [ADA: ...]. */
  function markerWords() {
    var words = ['FOUNDERS', 'WRITERS'], P = Castor.people;
    if (P) P.ids().forEach(function (id) { words.push(id.toUpperCase(), P.name(id).toUpperCase()); });
    return words.filter(Boolean).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
  }
  function analyse(source) {
    var parsed = Castor.md.parse(source);
    if (parsed.blocks.length !== 1 || parsed.blocks[0].type !== 'p') return [];
    var findings = [], masked = source;
    function blank(re) { masked = masked.replace(re, function (text) { return ' '.repeat(text.length); }); }
    // Mask only literal/non-prose spans; positions remain UTF-16 source offsets.
    blank(/(`+)[\s\S]*?\1/g); blank(/%%[\s\S]*?%%/g); blank(/\]\([^\n)]*\)/g);
    blank(/https?:\/\/[^\s]+/gi); blank(/<[^>]*>/g); blank(/\\./g);
    var decision = new RegExp('^\\[(?:' + markerWords().join('|') + '):');
    var unfinished = new RegExp('\\{TODO\\b[^}]*\\}|\\bTODO\\b|\\[(?:citation needed|source needed)\\]|\\[(?:' + markerWords().join('|') + '):[^\\]]*\\]', 'g');
    Array.from(masked.matchAll(unfinished)).forEach(function (m) {
      findings.push({ kind: 'unfinished', start: m.index, end: m.index + m[0].length,
        label: decision.test(m[0]) ? 'Writer decision still open' : 'Unfinished reference',
        question: 'What still needs to be supplied here?' });
    });
    blank(unfinished);
    var words = Array.from(masked.matchAll(/\p{L}[\p{L}\p{M}\p{N}'’]*/gu));
    for (var i = 1; i < words.length; i++) {
      var a = words[i - 1], b = words[i], gap = source.slice(a.index + a[0].length, b.index);
      if (a[0].toLowerCase() === b[0].toLowerCase() && /^[ \t]+$/.test(gap)) findings.push({ kind: 'repeat', start: a.index, end: b.index + b[0].length,
        label: 'Repeated word', question: 'Was this repetition intentional?', cut: { start: a.index + a[0].length, end: b.index + b[0].length } });
    }
    var scopes = {};
    Array.from(masked.matchAll(/\b(?:always|proves)\b/gi)).forEach(function (m) {
      var start = m.index, end = m.index + m[0].length;
      while (start > 0 && !/[.!?\n]/.test(masked.charAt(start - 1))) start--;
      while (end < masked.length && !/[.!?\n]/.test(masked.charAt(end))) end++;
      if (end < masked.length) end++;
      if (!scopes[start]) scopes[start] = { kind: 'scope', start: start, end: end, expressions: [], label: 'Scope question', question: 'What supports that scope?' };
      scopes[start].expressions.push(m[0]);
    });
    Object.keys(scopes).forEach(function (key) { findings.push(scopes[key]); });
    return findings.sort(function (a, b) { return a.start - b.start; }).map(function (f, index) {
      return Object.assign(f, { id: 'finding-' + index, excerpt: source.slice(f.start, f.end), disposition: 'open', origin: 'Local rule' });
    });
  }
  function capture() {
    if (!path()) throw Error('Open an article before checking a paragraph');
    var ed = editor(), caret = ed && ed.getCaret && ed.getCaret(), range = ed && ed.getSourceRange && ed.getSourceRange();
    if (!caret || !range || range.unsupported) throw Error('Select text within one paragraph');
    var blocks = readBlocks(), index = blocks.findIndex(function (b) { return b.id === caret.blockId; }), b = blocks[index];
    var parsed = b && Castor.md.parse(b.source);
    if (!b || b.type !== 'p' || parsed.blocks.length !== 1 || parsed.blocks[0].type !== 'p') throw Error('Put the caret in one prose paragraph');
    var offset = 0;
    for (var i = 0; i <= index; i++) { offset += typeof blocks[i].sep === 'string' ? blocks[i].sep.length : (i ? 2 : 0); if (i < index) offset += blocks[i].source.length; }
    if (range.start !== offset + caret.start || range.end !== offset + caret.end || caret.start < 0 || caret.end > b.source.length) throw Error('Select text within one paragraph');
    return { path: path(), version: version(), blockId: b.id, index: index, before: index ? blocks[index - 1].id : null,
      after: blocks[index + 1] ? blocks[index + 1].id : null, source: b.source, selection: { start: caret.start, end: caret.end }, coordinates: 'UTF-16 source code units' };
  }
  function matches(snapshot, expected) {
    if (!snapshot || !path() || path() !== snapshot.path || version() !== snapshot.version) return false;
    try {
      var blocks = readBlocks(), b = blocks[snapshot.index];
      return !!b && b.id === snapshot.blockId && b.source === expected &&
        (snapshot.index ? blocks[snapshot.index - 1].id : null) === snapshot.before &&
        (blocks[snapshot.index + 1] ? blocks[snapshot.index + 1].id : null) === snapshot.after;
    } catch (e) { return false; }
  }
  function refuse(message) { S.message = message || 'Paragraph changed. Check again.'; render(); return { ok: false, reason: S.message }; }
  function finding(id) { return S.review && S.review.findings.find(function (f) { return f.id === id; }); }
  function valid() { return S.review && !S.review.invalidated && matches(S.review.snapshot, S.review.snapshot.source); }
  function captureRequest() {
    if (S.requestField && S.requestOwner) S.requestOwner.request = S.requestField.value;
    if (S.questions) S.questionsOpen = S.questions.open;
    if (S.agent) S.agentOpen = S.agent.open;
  }
  function start() {
    if (!S.mounted) mount();
    captureRequest();
    try {
      var snapshot = capture();
      S.review = { snapshot: snapshot, findings: analyse(snapshot.source), request: 'Check the quoted passage against the listed sources. Return specific discrepancies or useful questions, source locations and the limits of what you checked. Do not edit the article or supply replacement wording. No substantive finding is acceptable.' };
      var selected = S.review.findings.findIndex(function (f) { return f.end > snapshot.selection.start && f.start < snapshot.selection.end; });
      S.active = selected < 0 ? 0 : selected; S.preview = null; S.message = '';
    }
    catch (e) { if (S.review) S.review.invalidated = true; S.message = e.message; Castor.panels.open('checking', 'right'); render(); return { ok: false, reason: S.message }; }
    Castor.panels.open('checking', 'right'); render(); return { ok: true, review: S.review };
  }
  function setView(view) { S.view = view === 'one' ? 'one' : 'all'; try { global.localStorage.setItem(VIEW_KEY, S.view); } catch (e) {} render(); }
  function choose(id, disposition) { var f = finding(id); if (!f || ['dismissed', 'later', 'open'].indexOf(disposition) < 0) return false; f.disposition = disposition; render(); return true; }
  function previewCut(id) { var f = finding(id); if (!f || !f.cut) return refuse('This question does not propose a cut.'); S.preview = id; S.active = S.review.findings.indexOf(f); render(); return { ok: true }; }
  function applyCut(id) {
    var f = finding(id), ed = editor();
    if (!f || !f.cut || !valid()) return refuse();
    if (S.preview !== id) return refuse('Preview this exact cut before applying.');
    if (ed.isReadOnly && ed.isReadOnly()) return refuse('This article is read only.');
    if (ed.getCurrentSource() !== ed.getSource()) return refuse('Finish typing before applying a cut. Your current words are unchanged.');
    var snapshot = S.review.snapshot, source = snapshot.source, next = source.slice(0, f.cut.start) + source.slice(f.cut.end), previous = f.disposition;
    S.applying = true; var applied;
    try { applied = ed.replaceBlock(snapshot.blockId, next); } finally { S.applying = false; }
    if (!applied) return refuse();
    f.disposition = 'edited'; S.preview = null; S.message = 'Edited. Facts, argument and meaning have not been checked.';
    S.undo = { snapshot: snapshot, after: next, fullSource: ed.getCurrentSource(), finding: f, previous: previous, active: true };
    render(); return { ok: true };
  }
  function undo() {
    var op = S.undo, ed = editor();
    if (ed && ed.isReadOnly && ed.isReadOnly()) return refuse('This article is read only.');
    if (!op || !op.active || !matches(op.snapshot, op.after) || ed.getCurrentSource() !== op.fullSource) return refuse('Later writing prevents this Undo. Use the editor history.');
    op.active = false; S.applying = true;
    try { ed.undo(); } finally { S.applying = false; }
    if (op.finding.disposition === 'edited') op.finding.disposition = op.previous;
    S.message = 'Cut undone.'; render(); return { ok: true };
  }
  function rewrite(id) {
    if (!valid()) return refuse();
    var ed = editor(); if (ed.isReadOnly && ed.isReadOnly()) return refuse('This article is read only.');
    var snapshot = S.review.snapshot, f = finding(id);
    ed.restoreCaret({ blockId: snapshot.blockId, start: f ? f.start : snapshot.selection.start, end: f ? f.end : snapshot.selection.end }, 'navigate');
    return { ok: true };
  }
  function askAgent() {
    captureRequest();
    if (!valid()) return refuse();
    if (!Castor.comments || !Castor.comments.compose || !S.review.snapshot.source.trim()) return refuse('The comment composer is unavailable.');
    if (S.review.request.length > 1200) return refuse('The request exceeds 1200 characters. Shorten it deliberately; your exact draft is retained.');
    if (/@agent\b/i.test(S.review.request)) return refuse('Add @agent in the comment composer only when ready to request a response. Your exact draft is retained.');
    var source = S.review.snapshot.source, anchor = { quote: source, blockText: source, blockId: S.review.snapshot.blockId };
    var slot = Castor.comments.compose(anchor), field = slot && slot.querySelector('textarea');
    if (!field) return refuse('The comment composer is unavailable.');
    field.value = S.review.request;
    field.dispatchEvent(new global.Event('input', { bubbles: true })); field.focus();
    S.message = 'Comment draft opened. Add @agent and save only when you choose to request a response.'; render(); return { ok: true };
  }
  function questions(root, source) {
    var details = el('details', 'checking-questions'), opening = source.slice(0, 60), ending = source.slice(-70);
    details.open = !!S.questionsOpen; S.questions = details;
    details.appendChild(el('summary', null, 'Questions for this paragraph'));
    details.appendChild(el('p', 'checking-origin', 'Williams & Bizup, Style: Lessons in Clarity and Grace. Author questions, not local findings.'));
    [["Who acts in “" + opening + "”, and where is the action verb?", 'Actions; Characters'],
      ['What does the reader already know, and how does this opening connect with it?', 'Cohesion and Coherence'],
      ['Does the ending “' + ending + '” put the intended idea under emphasis?', 'Emphasis'],
      ['What can you cut without losing uncertainty or a causal connection?', 'Concision'],
      ['What is this paragraph for, and does the order serve that purpose?', 'Cohesion and Coherence'],
      ['Read this paragraph aloud. Where does the rhythm help or hinder what the reader needs?', 'Elegance']]
      .forEach(function (item) { details.appendChild(el('p', null, item[0] + ' (' + item[1] + ')')); });
    root.appendChild(details);
  }
  function renderFinding(root, f, expanded) {
    var row = el('section', 'checking-finding'); row.setAttribute('data-finding-id', f.id);
    button(row, f.label, function () { S.active = S.review.findings.indexOf(f); render(); if (valid()) editor().scrollToBlock(S.review.snapshot.blockId); });
    if (f.disposition !== 'open') row.appendChild(el('span', 'checking-disposition', f.disposition));
    if (expanded) {
      row.appendChild(el('blockquote', 'checking-excerpt', f.excerpt)); row.appendChild(el('p', null, f.question)); row.appendChild(el('p', 'checking-origin', f.origin));
      actionButton(row, 'Rewrite', function () { rewrite(f.id); }, true);
      if (f.cut) actionButton(row, 'Cut…', function () { previewCut(f.id); }, true);
      button(row, 'Dismiss', function () { choose(f.id, 'dismissed'); }); button(row, 'Later', function () { choose(f.id, 'later'); });
      if (S.preview === f.id) {
        var source = S.review.snapshot.source;
        row.appendChild(el('p', null, 'Cut only “' + source.slice(f.cut.start, f.cut.end) + '”.'));
        row.appendChild(el('pre', 'checking-cut-preview', source.slice(0, f.cut.start) + source.slice(f.cut.end)));
        actionButton(row, 'Apply cut', function () { applyCut(f.id); }, true);
        button(row, 'Cancel cut', function () { S.preview = null; render(); });
      }
    }
    root.appendChild(row);
  }
  function render(force) {
    var root = S.root; if (!root) return; captureRequest();
    if (!force && S.requestField && DOC.activeElement === S.requestField && S.requestOwner === S.review) {
      S.deferredRender = true;
      S.status.textContent = !valid() ? 'Earlier version. Paragraph changed. Check again before editing.' : S.message;
      S.actionButtons.forEach(function (item) { item.node.disabled = !valid() || item.mutation && editor().isReadOnly && editor().isReadOnly(); });
      return;
    }
    root.textContent = ''; S.actionButtons = []; S.deferredRender = false;
    root.appendChild(el('p', 'checking-scope', 'Local checks · facts not checked'));
    var views = el('div', 'checking-views'); ['all', 'one'].forEach(function (view) { var b = button(views, view === 'all' ? 'All findings' : 'One at a time', function () { setView(view); }); b.setAttribute('aria-pressed', String(S.view === view)); }); root.appendChild(views);
    S.status = el('p', 'checking-status', S.message); S.status.setAttribute('role', 'status'); root.appendChild(S.status);
    if (!S.review) { root.appendChild(el('p', null, 'Put the caret in one paragraph, then choose Check paragraph.')); return; }
    var review = S.review;
    if (!valid()) root.appendChild(el('p', 'checking-stale', 'Earlier version. Paragraph changed. Check again before editing.'));
    if (!review.findings.length) root.appendChild(el('p', null, 'No local findings. Facts, argument and meaning have not been checked.'));
    else if (S.view === 'all') review.findings.forEach(function (f, i) { renderFinding(root, f, i === S.active); });
    else {
      root.appendChild(el('p', null, (S.active + 1) + ' of ' + review.findings.length)); renderFinding(root, review.findings[S.active], true);
      var navigation = el('div', 'checking-actions');
      button(navigation, 'Previous', function () { S.active--; render(); }, S.active === 0);
      button(navigation, 'Next', function () { S.active++; render(); }, S.active === review.findings.length - 1);
      root.appendChild(navigation);
      if (S.active === review.findings.length - 1) root.appendChild(el('p', null, 'End of this review. Facts, argument and meaning have not been checked.'));
    }
    if (S.undo && S.undo.active) button(root, 'Undo', undo, !!(editor().isReadOnly && editor().isReadOnly()));
    questions(root, review.snapshot.source);
    var agent = el('details', 'checking-agent'); agent.open = !!S.agentOpen; S.agent = agent; agent.appendChild(el('summary', null, 'Optional agent request'));
    agent.appendChild(el('p', null, 'The watcher reads the article, bounded article materials, the thread, shared profile and article 2. A comment draft does not start checking. Add @agent and save only when ready. A nonempty comment also saves when you click outside it.'));
    var request = el('textarea'); request.value = review.request; request.maxLength = 1200; request.setAttribute('aria-label', 'Editable request for an agent');
    S.requestField = request; S.requestOwner = review;
    request.addEventListener('blur', function () { if (S.deferredRender) render(true); });
    request.addEventListener('input', function () { review.request = request.value; }); agent.appendChild(request);
    actionButton(agent, 'Ask agent', function () { review.request = request.value; askAgent(); }, false); root.appendChild(agent);
    button(root, 'Comments', function () { Castor.panels.open('comments', 'right'); });
    button(root, 'Close', function () { Castor.panels.close('checking'); });
  }
  function mount() {
    if (S.mounted) return api; S.mounted = true;
    try { S.view = global.localStorage.getItem(VIEW_KEY) === 'one' ? 'one' : 'all'; } catch (e) {}
    Castor.panels.register('checking', { title: 'Paragraph check', ready: true, mount: function (root) { S.root = root; root.className = 'checking-panel'; render(); } });
    if (Castor.bus && Castor.bus.on) {
      Castor.bus.on('doc:change', function () { if (S.applying) return; if (S.undo && editor().getCurrentSource() !== S.undo.fullSource) S.undo.active = false; if (S.review) { if (!valid()) S.review.invalidated = true; if (shown()) render(); } });
      Castor.bus.on('piece:open', function () { if (S.undo) S.undo.active = false; if (S.review) { S.review.invalidated = true; S.message = 'Earlier version. Check the current paragraph again.'; if (shown()) render(); } });
      Castor.bus.on('layout', function () { var open = shown(); if (open && !S.shown) render(); S.shown = open; });
    }
    return api;
  }
  var api = { mount: mount, start: start, analyse: analyse, setView: setView, choose: choose, previewCut: previewCut,
    applyCut: applyCut, undo: undo, rewrite: rewrite, askAgent: askAgent, state: function () { return S; } };
  Castor.checking = api;
})(window);
