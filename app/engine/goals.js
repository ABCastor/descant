/* A writing goal on the piece, kept quietly.

   The goal lives in the article's front matter, in the four keys the Ulysses import already
   writes: `goal` (the count), `goal-type` (at-least, about, at-most or daily), `goal-unit` (words or
   characters) and `goal-due` (an optional YYYY-MM-DD). One article, one goal: article.md is the
   one file both writers share, and a version beside it is never what the count measures.
   Setting or removing it goes through the editor's front matter edit, so it saves, undoes and
   recovers like any other edit.

   The bar shows a small ring beside the word count; tapping the count opens a small sheet to
   set, change or remove it, with the words written today. Nothing here ever blocks writing,
   saving or publishing: a goal only shows. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {});

  var KIND_WORDS = { 'at-least': 'At least', about: 'About', 'at-most': 'At most', daily: 'A day' };
  var KINDS = Object.keys(KIND_WORDS);
  var UNITS = ['words', 'characters'];
  var UNIT_WORDS = { words: ['word', 'words'], characters: ['character', 'characters'], sentences: ['sentence', 'sentences'],
    paragraphs: ['paragraph', 'paragraphs'], pages: ['page', 'pages'], 'reading-time': ['minute of reading', 'minutes of reading'] };
  var ABOUT = 0.1;              // "about" is there within a tenth either side
  var MOST = 10000000;
  var GOAL_ROW = /^goal(?:-type|-unit|-due)?[ \t]*:/;

  function realDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var d = new Date(value + 'T12:00:00Z');
    return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }
  function text(value) { return value == null ? '' : String(value).trim(); }

  /* The goal the front matter holds, or null. A kind or unit Descant does not count
     (such as pages) is read as it is, with supported: false. */
  function read(frontmatter) {
    var fm = frontmatter || {}, raw = fm.goal;
    var count = typeof raw === 'number' ? raw : /^\d+$/.test(text(raw)) ? Number(text(raw)) : NaN;
    if (!(count >= 1 && count <= MOST && Math.floor(count) === count)) return null;
    var kind = text(fm['goal-type']) || 'at-least', unit = text(fm['goal-unit']) || 'words', due = text(fm['goal-due']);
    return { count: count, kind: kind, unit: unit, due: realDate(due) ? due : '', supported: KINDS.indexOf(kind) >= 0 && UNITS.indexOf(unit) >= 0 };
  }

  /* The article with this goal in its header (null removes it). Only the goal rows change:
     the body bytes, the other rows, their order and the line endings stay. */
  function withGoal(source, goal) {
    var all = String(source);
    var header = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(all);
    if (!header) throw Error('This article needs front matter before it can carry a goal.');
    var lines = [];
    if (goal) {
      if (!(goal.count >= 1 && goal.count <= MOST && Math.floor(goal.count) === goal.count)) throw Error('A goal is a whole number from 1 to 10,000,000.');
      if (KINDS.indexOf(goal.kind) < 0) throw Error('Choose a kind of goal.');
      if (UNITS.indexOf(goal.unit) < 0) throw Error('A goal counts words or characters.');
      if (goal.due && !realDate(goal.due)) throw Error('A deadline is a date.');
      lines = ['goal: ' + goal.count, 'goal-type: ' + goal.kind, 'goal-unit: ' + goal.unit];
      if (goal.due) lines.push('goal-due: ' + goal.due);
    }
    var newline = header[1].indexOf('\r') >= 0 ? '\r\n' : '\n';
    var rows = header[2].split(newline), kept = [], at = -1;
    rows.forEach(function (row) {
      if (GOAL_ROW.test(row)) { if (at < 0) at = kept.length; } else kept.push(row);
    });
    if (at < 0) at = kept.length;
    var next = kept.slice(0, at).concat(lines, kept.slice(at));
    return header[1] + next.join(newline) + header[3] + all.slice(header[0].length);
  }

  /* The words a reader counts: no front matter, no writer's notes, no link targets, no marks. */
  function readerText(markdown, footnotes) {
    var text = String(markdown || '')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      .replace(/%%[\s\S]*?%%/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, function (m, target, label) { return label || target; });
    // Words: a footnote's mark is no word, and its definition reads as words. Characters keep the
    // definition a footnote, so the parser reads its text, and drop only the mark in the text.
    return footnotes ? text.replace(/\[\^[^\]]+\](?!:)/g, '') : text.replace(/\[\^[^\]]+\]:?/g, ' ');
  }
  function words(markdown) {
    var found = readerText(markdown).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return found ? found.length : 0;
  }
  /* Characters as a reader sees them, spaces included: each block's text with any run of
     white space read as one space; a paragraph break counts nothing. */
  function characters(markdown) {
    var body = readerText(markdown, true), parse = C.md && C.md.parse, parts;
    if (parse) {
      parts = parse(body).blocks.filter(function (b) { return b.type !== 'frontmatter' && b.type !== 'reference-def'; })
        .map(function (b) { return b.text || ''; });
    } else parts = body.replace(/[*_~=`#>]+/g, '').split(/\n\s*\n/);
    return parts.reduce(function (n, part) { return n + Array.from(part.replace(/\s+/g, ' ').trim()).length; }, 0);
  }
  function measure(markdown, unit) { return unit === 'characters' ? characters(markdown) : words(markdown); }

  /* Where a count stands against its goal: the ring's fraction, and short, reached, under
     (an "at most" still within it) or over, with what is left or over. */
  function progress(goal, n) {
    if (!goal || n == null || KINDS.indexOf(goal.kind) < 0 || UNITS.indexOf(goal.unit) < 0) return null;
    var c = goal.count, f = Math.max(0, Math.min(1, n / c));
    if (goal.kind === 'at-most') return n > c ? { fraction: 1, state: 'over', left: 0, over: n - c } : { fraction: f, state: 'under', left: c - n, over: 0 };
    if (goal.kind === 'about') {
      var band = c * ABOUT;
      if (n > c + band) return { fraction: 1, state: 'over', left: 0, over: n - c };
      if (n >= c - band) return { fraction: 1, state: 'reached', left: 0, over: 0 };
      return { fraction: f, state: 'short', left: c - n, over: 0 };
    }
    return n >= c ? { fraction: 1, state: 'reached', left: 0, over: 0 } : { fraction: f, state: 'short', left: c - n, over: 0 };
  }
  function figure(n) { return Number(n).toLocaleString('en'); }
  function unitWord(unit, n) { var w = UNIT_WORDS[unit] || [unit, unit]; return n === 1 ? w[0] : w[1]; }
  function describe(goal) {
    if (!goal) return '';
    var amount = figure(goal.count) + ' ' + unitWord(goal.unit, goal.count);
    if (goal.kind === 'daily') return amount + ' a day';
    return (KIND_WORDS[goal.kind] || goal.kind) + ' ' + amount;
  }
  function note(goal, n) {
    var p = progress(goal, n);
    if (!p) return '';
    if (p.state === 'over') return figure(p.over) + ' ' + unitWord(goal.unit, p.over) + ' over';
    if (p.state === 'reached') return 'Reached';
    if (p.state === 'under') return p.left ? figure(p.left) + ' left' : 'At the limit';
    return figure(p.left) + ' to go';
  }

  /* Today's words: the count now, less the count at the last save before this device's
     midnight, read from the article's history on the server (every save is a commit there,
     from any device). The start of the day is kept on this device, so a reload, or a page
     with no server, counts from the same start; the next day asks again. */
  function midnight(ms, next) { var d = new Date(ms); d.setHours(next ? 24 : 0, 0, 0, 0); return d.getTime(); }
  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function createDay(options) {
    var fetcher = options.fetch, storage = options.storage, now = options.now || Date.now, api = options.api;
    var starts = new Map(), loading = new Map();
    function key(path) { return 'castor.goalDay.' + path; }
    function start(path) {
      var at = midnight(now()), v = starts.get(path);
      if (v && v.before === at) return v;
      try {
        v = storage && JSON.parse(storage.getItem(key(path)) || 'null');
        if (v && (v.before == null ? v.day === dayOf(at) : v.before === at) && Number.isFinite(v.words) && Number.isFinite(v.characters)) return v;
      } catch (e) { /* storage may be blocked */ }
      return null;
    }
    function delta(path, total, unit) {
      var s = path && start(path);
      return s ? total - (unit === 'characters' ? s.characters : s.words) : null;
    }
    function today(path, markdown, unit) { return delta(path, measure(markdown, unit), unit); }
    function load(path) {
      if (!path) return Promise.resolve(null);
      var known = start(path);
      if (known) return Promise.resolve(known);
      var at = midnight(now()), request = path + ':' + at;
      if (loading.has(request)) return loading.get(request);
      var wait = Promise.resolve()
        .then(function () { return fetcher(api('piece/day?path=' + encodeURIComponent(path) + '&before=' + at)); })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (body) {
          if (!body || typeof body.markdown !== 'string' || at !== midnight(now())) return null;
          var v = { day: dayOf(at), before: at, words: words(body.markdown), characters: characters(body.markdown), commit: body.commit || null };
          starts.set(path, v);
          try { if (storage) storage.setItem(key(path), JSON.stringify(v)); } catch (e) { /* counted for this page only */ }
          return v;
        })
        .catch(function () { return null; })
        .finally(function () { loading.delete(request); });
      loading.set(request, wait);
      return wait;
    }
    return { today: today, delta: delta, load: load, start: start };
  }

  var api = { read: read, withGoal: withGoal, words: words, characters: characters, measure: measure,
    progress: progress, describe: describe, note: note, createDay: createDay };
  C.goals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  /* ---- the page ------------------------------------------------------------------ */

  var D = global.document;
  if (!D || !D.createElement) return;
  var SVG = 'http://www.w3.org/2000/svg';
  var ui = { ctx: null, bound: false, count: null, panel: null, day: null, dayWatch: null, dayTimer: 0, askedInside: 0, pointerAt: 0 };

  function isWriter(id) { return !!(C.people && C.people.isWriter(id)); }
  function founder() {
    var role = C.role || {};
    if (role.role === 'reviewer' || role.reviewer === true) return false;
    var people = C.who && C.who.session ? C.who.session() : [];
    if (people.length) return people.some(function (p) { return isWriter(p.id); });
    return isWriter(role.who || '') || role.confirmed === true || role.role === 'founder';
  }
  function source() { return C.editor && C.editor.getSource ? C.editor.getSource() : (C.app && C.app.source) || ''; }
  function articlePath() {
    var p = C.pieces && C.pieces.current ? C.pieces.current() : '';
    return /^articles\/[^/]+\/article\.md$/.test(p || '') ? p : '';
  }
  // Only the header is parsed for the goal: the count pauses never parse the whole essay for it.
  function goalOf(src) {
    var head = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(src || '');
    return head && C.md && C.md.parse ? read(C.md.parse(head[0]).frontmatter) : null;
  }
  function day() {
    if (!ui.day) {
      var storage = null;
      try { storage = global.localStorage; } catch (e) { storage = null; }
      ui.day = createDay({ fetch: function (url) { return global.fetch(url, { credentials: 'same-origin', cache: 'no-store' }); }, storage: storage,
        api: function (route) { return C.endpoints.api(route); } });
    }
    return ui.day;
  }

  function snapshot(src, path) {
    var goal = path ? goalOf(src) : null, unit = goal && goal.supported ? goal.unit : 'words';
    var total = measure(src, unit), daily = !!(goal && goal.supported && goal.kind === 'daily');
    return { goal: goal, unit: unit, total: total, daily: daily, n: daily ? day().delta(path, total, unit) : total };
  }
  function todayText(n) { return n == null ? '—' : (n < 0 ? '−' : '') + figure(Math.abs(n)); }
  function todaySuffix(n) { return '· ' + todayText(n) + ' today'; }
  function uncounted(path) {
    var w = ui.dayWatch;
    if (!path) return 'Not for this file';
    return w && w.path === path && w.at === midnight(Date.now()) && !w.pending ? 'Today’s count is unavailable' : 'Counting…';
  }

  // Only a visible goal sheet or an active daily goal needs history. A writing pause can
  // repaint many times without re-asking; midnight, reopening the sheet and reconnect can retry.
  function watchDay(path, retry) {
    var w = ui.dayWatch;
    if (!path) {
      global.clearTimeout(ui.dayTimer); ui.dayTimer = 0; ui.dayWatch = null;
      return;
    }
    var now = Date.now(), at = midnight(now);
    var same = w && w.path === path && w.at === at;
    if (!same || retry) {
      global.clearTimeout(ui.dayTimer);
      ui.dayTimer = global.setTimeout(function () { paintNow(true); }, midnight(now, true) - now);
    }
    if (!same) w = ui.dayWatch = { path: path, at: at, pending: false };
    if (day().start(path) || w.pending || (same && !retry)) return;
    w.pending = true;
    day().load(path).then(function () {
      if (ui.dayWatch !== w) return;
      w.pending = false;
      paintNow();
    });
  }

  /* The mark: a hairline ring and, inside it, the count so far as a pie from twelve o'clock (a
     pie reads as progress, never as the save state's turning arc). Reached, the pie is whole and
     a tick is drawn into it. Colour never says anything here: ink only. */
  function mark(size) {
    var holder = D.createElement('span'); holder.className = 'goal-mark'; holder.setAttribute('aria-hidden', 'true');
    var svg = D.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', size); svg.setAttribute('height', size);
    var track = D.createElementNS(SVG, 'circle'), arc = D.createElementNS(SVG, 'circle'), tick = D.createElementNS(SVG, 'path');
    track.setAttribute('class', 'goal-track'); track.setAttribute('cx', '8'); track.setAttribute('cy', '8'); track.setAttribute('r', '7');
    // A circle of radius 2.5 stroked 5 wide paints the disc of radius 5; its dash is the pie.
    arc.setAttribute('class', 'goal-arc'); arc.setAttribute('cx', '8'); arc.setAttribute('cy', '8'); arc.setAttribute('r', '2.5');
    arc.setAttribute('pathLength', '100'); arc.setAttribute('stroke-dasharray', '100'); arc.setAttribute('stroke-dashoffset', '100');
    arc.setAttribute('transform', 'rotate(-90 8 8)');
    tick.setAttribute('class', 'goal-tick'); tick.setAttribute('d', 'M5.7 8.15l1.55 1.55 3.05-3.2');
    svg.appendChild(track); svg.appendChild(arc); svg.appendChild(tick); holder.appendChild(svg);
    return holder;
  }
  function setMark(holder, goal, n) {
    var p = progress(goal, n), state = !goal ? 'none' : p ? p.state : goal.supported ? 'pending' : 'kept';
    if (holder.getAttribute('data-state') !== state) holder.setAttribute('data-state', state);
    var arc = holder.querySelector('.goal-arc'), offset = String(Math.round((1 - (p ? p.fraction : 0)) * 1000) / 10);
    if (arc && arc.getAttribute('stroke-dashoffset') !== offset) arc.setAttribute('stroke-dashoffset', offset);
  }
  function setText(node, value) { if (node && node.textContent !== value) node.textContent = value; }

  /* The bar's count: the ring, then "1,240 words", then for a count over its limit a quiet
     "· 40 over". Called by the bar when the writing pauses. */
  function paintCount(el, src, retry) {
    if (!el) return;
    ui.count = el;
    // Only a writer, and only on an article (not a version beside it), has a goal to see and set.
    var path = founder() ? articlePath() : '', view = snapshot(src, path);
    var goal = view.goal, unit = view.unit, n = view.n;
    watchDay(view.daily || isOpen() ? path : '', retry);
    var ring = el.querySelector && el.querySelector(':scope > .goal-mark'), label = el.querySelector && el.querySelector(':scope > .foot-count-label');
    var over = el.querySelector && el.querySelector(':scope > .goal-over');
    if (!label) {
      el.textContent = '';
      ring = mark(14); label = D.createElement('span'); label.className = 'foot-count-label';
      over = D.createElement('span'); over.className = 'goal-over';
      el.appendChild(ring); el.appendChild(label); el.appendChild(over);
    }
    setMark(ring, goal, n);
    var articleTotal = figure(view.total) + ' ' + unitWord(unit, view.total);
    setText(label, articleTotal);
    var p = progress(goal, n);
    setText(over, view.daily ? todaySuffix(n) : p && p.state === 'over' ? '· ' + figure(p.over) + ' over' : '');
    if (path) {
      if (!el._goalBound) {
        el._goalBound = true;
        el.addEventListener('click', function () { open(); });
        el.addEventListener('keydown', function (e) {
          if (el.getAttribute('role') === 'button' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
        });
      }
      if (el.getAttribute('role') !== 'button') { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); }
      bindPanel(el);
      var spoken = articleTotal + '. ' + goalLabel(view, path);
      if (el.getAttribute('aria-label') !== spoken) el.setAttribute('aria-label', spoken);
    } else if (el.getAttribute('role') === 'button') {
      el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-label');
    }
    if (isOpen()) paintSheet(view, path);
  }
  function goalLabel(view, path) {
    var goal = view.goal;
    if (!goal) return 'Set a goal';
    if (!goal.supported) return 'Goal kept from the import. Goal';
    var status = view.daily ? (view.n == null ? uncounted(path) : todayText(view.n) + ' today, ' + note(goal, view.n).toLowerCase())
      : note(goal, view.n).toLowerCase();
    return describe(goal) + ', ' + status + '. Goal';
  }
  function paintNow(retry) {
    paintCount(D.getElementById('castor-words'), source(), retry === true);
    paintMenuRow();
  }

  /* The phone has no bar: its Menu carries the count as a row, the ring as its icon. */
  function paintMenuRow(row) {
    row = row || D.getElementById('menu-goal');
    if (!row) return;
    var path = founder() ? articlePath() : '', view = snapshot(source(), path);
    var goal = view.goal, unit = view.unit, n = view.n;
    var ring = row.querySelector(':scope > .goal-mark');
    if (!ring) { ring = mark(18); ring.classList.add('goal-mark-row'); row.insertBefore(ring, row.firstChild); }
    setMark(ring, goal, n);
    setText(row.querySelector('.word-label'), unit === 'characters' ? 'Characters' : 'Words');
    var value = row.querySelector('.menu-value');
    if (!value) { value = D.createElement('span'); value.className = 'menu-value'; row.appendChild(value); }
    setText(value, view.daily ? figure(view.total) + ' ' + todaySuffix(n) : goal && goal.supported ? figure(n) + ' of ' + figure(goal.count) : figure(view.total));
    if (view.daily) row.setAttribute('aria-label', figure(view.total) + ' ' + unitWord(unit, view.total) + '. ' + goalLabel(view, path));
    else row.removeAttribute('aria-label');
    row.hidden = !path;
  }

  /* ---- the sheet ---------------------------------------------------------------- */

  function el(tag, cls, words) { var n = D.createElement(tag); if (cls) n.className = cls; if (words != null) n.textContent = words; return n; }
  function segment(name, label, options) {
    var set = el('fieldset', 'goal-seg'); set.appendChild(el('legend', 'goal-legend', label));
    options.forEach(function (o) {
      var item = el('label', 'goal-seg-option'), input = el('input');
      input.type = 'radio'; input.name = name; input.value = o[0];
      item.appendChild(input); item.appendChild(el('span', '', o[1])); set.appendChild(item);
    });
    return set;
  }
  function chosen(form, name) { var hit = form.querySelector('input[name="' + name + '"]:checked'); return hit ? hit.value : ''; }
  function choose(form, name, value) {
    Array.prototype.forEach.call(form.querySelectorAll('input[name="' + name + '"]'), function (r) { r.checked = r.value === value; });
  }
  function isOpen() { try { return !!(ui.panel && ui.panel.matches(':popover-open')); } catch (e) { return false; } }
  function build() {
    if (ui.panel) return ui.panel;
    var panel = el('div', 'castor-goal'); panel.id = 'castor-goal';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', 'castor-goal-title');
    panel.setAttribute('popover', 'auto');
    var head = el('div', 'goal-head'), title = el('h2', 'goal-title', 'Goal'); title.id = 'castor-goal-title';
    var done = el('button', 'goal-done', 'Done'); done.type = 'button';
    done.addEventListener('click', function () { close(); });
    head.appendChild(title); head.appendChild(done); panel.appendChild(head);

    var summary = el('div', 'goal-summary'); summary.appendChild(mark(28));
    var figures = el('div', 'goal-figures');
    figures.appendChild(el('p', 'goal-figure')); figures.appendChild(el('p', 'goal-line'));
    summary.appendChild(figures); panel.appendChild(summary);

    var today = el('div', 'goal-today');
    today.appendChild(el('span', 'goal-today-label', 'Today'));
    today.appendChild(el('span', 'goal-today-count'));
    panel.appendChild(today);
    panel.appendChild(el('p', 'goal-today-note', 'From the last save before midnight, on any device.'));

    var form = el('form', 'goal-form'); form.noValidate = true;
    form.appendChild(segment('goal-kind', 'Kind', KINDS.map(function (kind) { return [kind, KIND_WORDS[kind]]; })));
    var amount = el('div', 'goal-amount'), countLabel = el('label', 'goal-field goal-count'), number = el('input');
    number.type = 'number'; number.name = 'goal-count'; number.min = '1'; number.max = String(MOST); number.step = '1';
    number.inputMode = 'numeric'; number.placeholder = '2000'; number.setAttribute('aria-label', 'Count');
    countLabel.appendChild(number); amount.appendChild(countLabel);
    amount.appendChild(segment('goal-unit', 'Unit', [['words', 'Words'], ['characters', 'Characters']]));
    form.appendChild(amount);
    var dueLabel = el('label', 'goal-field goal-due'), due = el('input'), date = el('span', 'goal-date');
    due.type = 'date'; due.name = 'goal-due';
    // An empty date field would show today's date as if it were set: it says so in words instead.
    date.appendChild(due); date.appendChild(el('span', 'goal-date-empty', 'Add a date'));
    dueLabel.appendChild(el('span', 'goal-field-label', 'Due')); dueLabel.appendChild(date);
    var clear = el('button', 'goal-due-clear', 'No date'); clear.type = 'button';
    clear.addEventListener('click', function () { due.value = ''; sync(); });
    dueLabel.appendChild(clear);
    form.appendChild(dueLabel);
    var actions = el('div', 'goal-actions');
    var set = el('button', 'goal-set', 'Set goal'); set.type = 'submit';
    var remove = el('button', 'goal-remove', 'Remove goal'); remove.type = 'button';
    remove.addEventListener('click', function () { apply(null); });
    actions.appendChild(set); actions.appendChild(remove); form.appendChild(actions);
    form.appendChild(el('p', 'goal-error')).setAttribute('role', 'status');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = Number(number.value);
      apply({ count: n, kind: chosen(form, 'goal-kind'), unit: chosen(form, 'goal-unit'), due: due.value || '' });
    });
    function sync() {
      var n = Number(number.value), ok = n >= 1 && n <= MOST && Math.floor(n) === n;
      set.disabled = !ok;
      clear.hidden = !due.value;
      if (due.value) date.removeAttribute('data-empty'); else date.setAttribute('data-empty', '');
      setText(form.querySelector('.goal-error'), '');
    }
    form.addEventListener('input', sync); form.addEventListener('change', sync);
    // The sheet's keys stay in the sheet: none reaches the article's editor.
    ['keydown', 'beforeinput', 'paste', 'input'].forEach(function (type) {
      panel.addEventListener(type, function (e) { if (type !== 'keydown' || e.key !== 'Escape') e.stopPropagation(); });
    });
    panel.appendChild(form);
    panel._sync = sync;
    (ui.ctx && ui.ctx.app || D.getElementById('app') || D.body).appendChild(panel);
    ui.panel = panel;
    wireLeaving(panel);
    if (ui.count) bindPanel(ui.count);
    return panel;
  }
  function bindPanel(opener) {
    if (!ui.panel || ui.panel._bound || !C.popovers) return;
    ui.panel._bound = true;
    C.popovers.bind(opener, ui.panel, fillForm);
  }
  function fillForm() {
    var panel = ui.panel, form = panel.querySelector('.goal-form'), goal = goalOf(source());
    var g = goal && goal.supported ? goal : null;
    choose(form, 'goal-kind', g ? g.kind : 'at-least');
    choose(form, 'goal-unit', g ? g.unit : 'words');
    form.querySelector('input[name="goal-count"]').value = g ? String(g.count) : '';
    form.querySelector('input[name="goal-due"]').value = goal ? goal.due : '';
    form.querySelector('.goal-set').textContent = goal ? 'Change goal' : 'Set goal';
    form.querySelector('.goal-remove').hidden = !goal;
    panel._sync();
    var path = articlePath(), view = snapshot(source(), path);
    // The beforetoggle hook fills the sheet before :popover-open matches.
    watchDay(path, true);
    paintSheet(view, path);
  }
  function paintSheet(view, path) {
    var panel = ui.panel, goal = view.goal, unit = view.unit, n = view.n;
    setMark(panel.querySelector('.goal-summary .goal-mark'), goal, n);
    var figureText = view.daily && n == null ? describe(goal)
      : goal && goal.supported ? todayText(n) + ' of ' + figure(goal.count) + ' ' + unitWord(unit, goal.count) + (view.daily ? ' today' : '')
      : figure(view.total) + ' ' + unitWord(unit, view.total);
    setText(panel.querySelector('.goal-figure'), figureText);
    var line = !goal ? 'No goal yet.'
      : !goal.supported ? 'From the import: ' + describe(goal) + '. Descant counts words and characters.'
      : (n == null ? uncounted(path) : note(goal, n)) + dueWords(goal.due);
    setText(panel.querySelector('.goal-line'), line);
    panel.querySelector('.goal-today').hidden = view.daily;
    if (!view.daily) {
      var today = day().delta(path, view.total, unit);
      setText(panel.querySelector('.goal-today-count'), today == null ? uncounted(path)
        : (today > 0 ? '+' : '') + todayText(today) + ' ' + unitWord(unit, Math.abs(today)));
    }
  }
  function dueWords(due) {
    if (!due) return '';
    var d = new Date(due + 'T12:00:00'), now = new Date(); now.setHours(12, 0, 0, 0);
    var days = Math.round((d - now) / 864e5), when = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return ' · ' + (days > 1 ? 'due ' + when : days === 1 ? 'due tomorrow' : days === 0 ? 'due today' : 'was due ' + when);
  }
  function apply(goal) {
    var panel = ui.panel, error = panel.querySelector('.goal-error');
    if (!C.editor || !C.editor.updateFrontmatter) return;
    try {
      var done = C.editor.updateFrontmatter(function (src) { return withGoal(src, goal); }, 'goal');
      if (done === false) { setText(error, 'This article cannot be changed here.'); return; }
    } catch (e) { setText(error, e.message); return; }
    paintNow();
    close();
  }

  /* Arriving is CSS (motion.css). Leaving takes the kit's 120 ms exit before the popover hides:
     Done animates the sheet itself; Escape and a tap outside close it natively (WebKit cannot
     animate a hidden popover), so a still copy of it takes the same exit where it stood. */
  function leaveFrames(phone) {
    return C.motion && C.motion.reduced() ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: phone ? '0 -8px' : '0 8px' }];
  }
  function phone() { var app = D.getElementById('app'); return !!(app && app.dataset.mode === 'phone'); }
  function animateOut(node, then) {
    if (!node.animate) { then(); return; }
    var calm = C.motion && C.motion.reduced();
    var motion = node.animate(leaveFrames(phone()), { duration: C.motion ? C.motion.ms(calm ? 'fade' : 'out') : 120, easing: calm ? 'ease-out' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    motion.onfinish = function () { then(); motion.cancel(); };
  }
  function close() {
    var panel = ui.panel;
    if (!panel || !isOpen() || panel._leaving) return;
    panel._leaving = true;
    animateOut(panel, function () { panel._leaving = false; try { panel.hidePopover(); } catch (e) { /* already closed */ } });
  }
  function wireLeaving(panel) {
    ['pointerdown', 'keydown'].forEach(function (name) {
      global.addEventListener(name, function (event) {
        if (name === 'keydown' && event.key === 'Escape') ui.askedInside = 0;
        else if (event.target && panel.contains(event.target)) ui.askedInside = Date.now();
      }, true);
    });
    // Closed by a finger or a mouse, the count it returns to takes no focus ring; from the keys it does.
    panel.addEventListener('toggle', function (event) {
      if (event.newState !== 'closed') return;
      paintNow();
      if (!ui.pointerAt || Date.now() - ui.pointerAt > 1500) return;
      global.setTimeout(function () { if (ui.count && D.activeElement === ui.count) ui.count.blur(); }, 0);
    });
    global.addEventListener('pointerdown', function () { ui.pointerAt = Date.now(); }, true);
    global.addEventListener('keydown', function () { ui.pointerAt = 0; }, true);
    panel.addEventListener('beforetoggle', function (event) {
      if (event.newState !== 'closed' || panel._leaving || Date.now() - ui.askedInside < 1000) return;
      try {
        var at = panel.getBoundingClientRect();
        if (!at.width || !at.height) return;
        var copy = panel.cloneNode(true);
        ['position:fixed', 'display:block', 'left:' + at.left + 'px', 'top:' + at.top + 'px', 'right:auto', 'bottom:auto', 'width:' + at.width + 'px',
          'height:' + at.height + 'px', 'margin:0', 'inset:auto', 'translate:none', 'transition:none', 'animation:none', 'z-index:2147483000', 'pointer-events:none']
          .forEach(function (pair) { var k = pair.indexOf(':'); copy.style.setProperty(pair.slice(0, k), pair.slice(k + 1)); });
        copy.removeAttribute('id'); copy.removeAttribute('popover'); copy.setAttribute('aria-hidden', 'true'); copy.inert = true;
        Array.prototype.forEach.call(copy.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
        panel.parentNode.insertBefore(copy, panel.nextSibling);
        animateOut(copy, function () { if (copy.parentNode) copy.parentNode.removeChild(copy); });
      } catch (e) { /* it still closes; only its leaving is not drawn */ }
    });
  }
  function open() {
    if (!founder() || !articlePath()) return;
    var panel = build();
    if (isOpen()) return;
    try { panel.showPopover(); } catch (e) { /* not in the document yet */ }
  }

  function mount(context) {
    ui.ctx = context;
    if (!ui.bound && context && context.bus) {
      ui.bound = true;
      context.bus.on('who:set', paintNow);
      context.bus.on('piece:opened', paintNow);
      var resume = function () { if (!D.hidden) paintNow(true); };
      global.addEventListener('online', resume);
      global.addEventListener('focus', resume);
      D.addEventListener('visibilitychange', resume);
      // The phone's Menu is painted as it opens, never on each pause: the chrome's own layout
      // runs on every change inside it.
      D.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('#more-word')) paintNow(true);
      }, true);
    }
    paintMenuRow();
  }

  api.mount = mount; api.paintCount = paintCount; api.paintMenuRow = paintMenuRow; api.open = open; api.close = close;
})(typeof window !== 'undefined' ? window : globalThis);
