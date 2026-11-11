/* Castor engine · island.js
 *
 * The command island. A world's --island token decides whether it is phone-only
 * (the default), always present, or off. It owns no document state and writes no
 * Markdown DOM itself: every edit is committed through Castor.editor's public
 * getCaret/getBlocks/replaceBlock/restoreCaret API, so undo and rendering stay
 * with the editor. The island never enters localStorage.
 */
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;
  var toolbarChoice = new URLSearchParams((global.location && global.location.search) || '').get('toolbar');
  // The order the writer reaches for them, the first five in view on a phone before the row scrolls.
  var COMMANDS = [
    { id: 'heading', label: 'Paragraph', title: 'Heading level' },
    { id: 'bold', label: 'Bold', title: 'Bold' },
    { id: 'italic', label: 'Italic', title: 'Italic' },
    { id: 'link', label: 'Link', title: 'Link' },
    { id: 'bullet', label: 'Bullet', title: 'Bullet list' },
    { id: 'checkbox', label: 'Box', title: 'Checkbox' },
    { id: 'highlight', label: 'Highlight', title: 'Highlight' },
    { id: 'footnote', label: 'Footnote', title: 'Add footnote' },
    { id: 'outdent', label: 'Outdent', title: 'Outdent' },
    { id: 'indent', label: 'Indent', title: 'Indent' }
  ];

  if (toolbarChoice === 'symbols') COMMANDS.splice(7, 0,
    { id: 'quote', label: 'Quote', title: 'Quote' });
  if (toolbarChoice !== 'words' && toolbarChoice !== 'symbols') {
    COMMANDS = COMMANDS.filter(function (def) { return def.id !== 'checkbox'; });
  }

  function commandSymbol(id) {
    if (id === 'heading') return 'P';
    if (id === 'bold') return '<b>B</b>';
    if (id === 'italic') return '<i>I</i>';
    if (id === 'highlight') return '<u>H</u>';
    if (id === 'footnote') return 'x<sup>1</sup>';
    var paths = {
      bullet: '<circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h11M9 12h11M9 18h11"/>',
      checkbox: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m7 12 3 3 7-7"/>',
      outdent: '<path d="M3 5h18M11 10h10M11 14h10M3 19h18M7 9l-3 3 3 3M4 12h4"/>',
      indent: '<path d="M3 5h18M11 10h10M11 14h10M3 19h18M4 9l3 3-3 3M3 12h4"/>',
      undo: '<path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/>',
      redo: '<path d="m15 5 5 5-5 5M20 10h-10a6 6 0 0 0 0 12"/>',
      'hide-keyboard': '<rect x="3" y="3" width="18" height="11" rx="2"/><path d="M6 7h1m3 0h1m3 0h1m3 0h0M7 11h10m-9 7 4 3 4-3"/>',
      'show-keyboard': '<rect x="3" y="3" width="18" height="11" rx="2"/><path d="M6 7h1m3 0h1m3 0h1m3 0h0M7 11h10m-9 10 4-3 4 3"/>',
      quote: '<path d="M4 6h6v7H4V6m6 7c0 4-2 5-4 5M14 6h6v7h-6V6m6 7c0 4-2 5-4 5"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths[id] + '</svg>';
  }

  var S = {
    mounted: false, ctx: null, frame: null, app: null, article: null, root: null,
    row: null, heading: null, focused: false, dismissed: false,
    actions: null, desktopActions: null, keyboardCaret: null,
    keyboardOverride: null, viewportHigh: 0, viewportWidth: 0, viewportOrientation: null,
    resizeObserver: null, headingBlockId: null,
    touchEnabled: true, tuck: null, touch: null, saveWatched: null
  };
  var touchMedia = global.matchMedia && global.matchMedia('(any-pointer: coarse)');
  function touchScreen() {
    return !!((touchMedia && touchMedia.matches) || (global.navigator && global.navigator.maxTouchPoints > 0));
  }

  function editor() { return Castor.editor; }
  function mode() {
    if (S.app && S.app.dataset.mode) return S.app.dataset.mode;
    return S.app && S.app.clientWidth < 700 ? 'phone' : 'desktop';
  }
  function policy() {
    var value = '';
    try {
      var style = Castor.frameReads ? Castor.frameReads.style(DOC.documentElement) : global.getComputedStyle(DOC.documentElement);
      value = style.getPropertyValue('--island').trim().toLowerCase();
    }
    catch (e) { value = ''; }
    return value === 'always' || value === 'off' || value === 'phone' ? value : 'phone';
  }
  function allowed() {
    var value = policy();
    if (touchScreen()) return value !== 'off' && S.touchEnabled;
    return value !== 'off' && (value === 'always' || mode() === 'phone');
  }
  function focusActive() {
    return !!(S.app && S.app.getAttribute('data-focus') === 'on');
  }
  function editFocused() {
    var e = editor();
    return !!(e && e.isFocused && e.isFocused() && DOC.activeElement &&
      DOC.activeElement.classList && DOC.activeElement.classList.contains('cw-edit'));
  }
  function viewport() { return global.visualViewport || null; }
  function updateViewportBaseline() {
    var vv = viewport(), scale = vv && vv.scale || 1;
    var width = vv && vv.width ? vv.width * scale : global.innerWidth || S.app && S.app.clientWidth || 0;
    // WebKit keeps the layout viewport full-height while its visual viewport
    // shrinks for the keyboard, including when rotating with editing focused.
    // Pair layout dimensions: orientation events can precede layout resize.
    var layoutHeight = Math.abs(width - global.innerWidth) < 1 ? global.innerHeight || 0 : 0;
    var height = Math.max(layoutHeight, vv ? vv.height * scale : global.innerHeight || 0);
    var orientation = global.screen && global.screen.orientation;
    var direction = orientation ? String(orientation.angle == null ? orientation.type : orientation.angle)
      : global.orientation == null ? '' : String(global.orientation);
    // Keyboard resize retains the layout width. Rotation and Split View start
    // a new full-layout baseline, even with the native keyboard still open.
    if (S.viewportOrientation !== direction ||
        Math.abs(width - S.viewportWidth) > Math.max(24, S.viewportWidth * .05)) {
      S.viewportWidth = width;
      S.viewportOrientation = direction;
      S.viewportHigh = height;
    } else S.viewportHigh = Math.max(S.viewportHigh, height);
  }

  function keyboardUp() {
    if (S.keyboardOverride != null) return !!S.keyboardOverride;
    if (!editFocused()) return false;
    var vv = viewport();
    if (!vv) return true;
    var high = S.viewportHigh || vv.height;
    // Panning changes offsetTop, not keyboard size; zoom changes CSS pixels.
    // A focused host can keep focus after Android's keyboard is dismissed.
    return high - vv.height * (vv.scale || 1) > Math.max(96, high * .14);
  }

  function createButton(def, symbols) {
    var b = DOC.createElement('button');
    b.type = 'button';
    b.className = 'command-island-word';
    b.dataset.command = def.id;
    if (symbols) b.innerHTML = commandSymbol(def.id);
    else b.textContent = def.label;
    b.setAttribute('title', def.title);
    b.setAttribute('aria-label', def.title);
    b.addEventListener('pointerdown', function (event) { event.preventDefault(); });
    b.addEventListener('click', function () { run(def.id); });
    return b;
  }

  function ensure() {
    if (S.root || !DOC || !allowed()) return S.root;
    var root = DOC.createElement('aside');
    root.className = 'command-island';
    root.setAttribute('aria-label', 'Writing commands');
    root.dataset.open = '0';
    var writing = !!(Castor.capsule && touchScreen());
    var split = !writing && toolbarChoice === 'split';
    var symbols = split || toolbarChoice === 'symbols' || (toolbarChoice !== 'words' && touchScreen());
    if (symbols) root.dataset.toolbar = 'symbols';
    root.dataset.arrangement = writing ? 'writing' : split ? 'split' : 'combined';

    var clip = DOC.createElement('div');
    clip.className = 'command-island-clip';
    var row = DOC.createElement('div');
    row.className = 'command-island-row';
    row.setAttribute('role', 'toolbar');
    COMMANDS.forEach(function (def) {
      var button = createButton(def, symbols);
      row.appendChild(button);
      if (def.id === 'heading') S.heading = button;
    });
    clip.appendChild(row);

    var close = DOC.createElement('button');
    close.type = 'button';
    close.className = 'command-island-close';
    close.textContent = 'Close';
    close.setAttribute('aria-label', 'Dismiss writing commands');
    close.addEventListener('pointerdown', function (event) { event.preventDefault(); });
    close.addEventListener('click', function () { S.dismissed = true; refresh(); });

    if (!split) root.appendChild(clip);
    var actions = DOC.createElement('div');
    actions.className = 'command-island-actions' + (split ? ' command-island-history' : '');
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', split ? 'Editing history' : 'Editing history and keyboard');
    var actionButtons = [];
    [
      { id: 'undo', label: 'Undo', title: 'Undo' },
      { id: 'redo', label: 'Redo', title: 'Redo' },
      { id: 'hide-keyboard', label: 'Hide keyboard', title: 'Hide keyboard' }
    ].forEach(function (def) {
      if ((split || writing) && def.id === 'hide-keyboard') return;
      var button = createButton(def, symbols);
      actions.appendChild(button); actionButtons.push(button);
    });
    if (writing) {
      while (actions.firstChild) row.appendChild(actions.firstChild);
      var saveSlot = DOC.createElement('span'); saveSlot.id = 'writing-save-slot';
      actions.appendChild(saveSlot);
      var done = createButton({ id: 'done', label: 'Done', title: 'Done' }, false);
      actions.appendChild(done); actionButtons.push(done);
    }
    root.appendChild(actions);
    if (split) {
      root.appendChild(clip);
      var keyboard = DOC.createElement('div');
      keyboard.className = 'command-island-actions command-island-keyboard';
      keyboard.setAttribute('role', 'group');
      keyboard.setAttribute('aria-label', 'Keyboard');
      var hide = createButton({ id: 'hide-keyboard', label: 'Hide keyboard', title: 'Hide keyboard' }, symbols);
      keyboard.appendChild(hide); actionButtons.push(hide);
      root.appendChild(keyboard);
    }
    root.appendChild(close);
    root.dataset.docked = touchScreen() ? '1' : '0';
    if (touchScreen() && S.app) S.app.insertBefore(root, DOC.getElementById('footline'));
    else (S.frame || DOC.body).appendChild(root);
    S.root = root;
    if (writing && S.app) ensureTuck();
    S.row = row;
    S.actions = actionButtons;
    refreshHeading(true);
    refreshControls();
    return root;
  }

  function ensureDesktopHistory() {
    if (S.desktopActions || !DOC || Castor.capsule) return;
    var line = DOC.getElementById('footline');
    var footer = line && line.querySelector('.foot-meta');
    if (!footer) return;
    var group = DOC.createElement('span');
    group.className = 'desktop-history';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Editing history');
    S.desktopActions = ['undo', 'redo'].map(function (id) {
      var button = createButton({ id: id, label: id === 'undo' ? 'Undo' : 'Redo', title: id === 'undo' ? 'Undo' : 'Redo' }, true);
      group.appendChild(button);
      return button;
    });
    footer.insertBefore(group, footer.firstChild);
  }

  // Phone, keyboard up: the writing bar floats above the keyboard. A finger scroll
  // tucks it into one round button that keeps the save mark; a press on that
  // button, a tap in the text or typing brings the whole bar back at once.
  function floating() {
    return !!(S.root && S.root.dataset.arrangement === 'writing' && mode() === 'phone');
  }
  function tucked() { return !!(S.app && S.app.dataset.barTucked != null); }
  function tuck(on) {
    on = !!on && floating() && S.root.dataset.open === '1';
    if (!S.app || tucked() === on) return;
    if (on) S.app.dataset.barTucked = ''; else delete S.app.dataset.barTucked;
    if (S.root) S.root.inert = on;
    if (S.tuck) S.tuck.inert = !on;
  }
  function ensureTuck() {
    if (S.tuck) return;
    var button = DOC.createElement('button');
    button.type = 'button';
    button.className = 'command-island-tuck';
    button.inert = true;
    // The caret stays in the text: no focus moves, and iOS gets no mouse events to blur on.
    button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
    button.addEventListener('touchend', function (event) { event.preventDefault(); tuck(false); });
    button.addEventListener('click', function () { tuck(false); });
    S.app.appendChild(button);
    S.tuck = button;
    paintTuck();
  }
  function paintTuck() {
    if (!S.tuck) return;
    var save = DOC.getElementById('castor-save');
    var icon = save && save.querySelector('.save-signal');
    if (save && save !== S.saveWatched && global.MutationObserver) {
      S.saveWatched = save;
      new global.MutationObserver(paintTuck).observe(save, { attributes: true, attributeFilter: ['data-signal', 'aria-label'] });
    }
    var signal = save && save.getAttribute('data-signal') || 'saving';
    if (S.tuck.getAttribute('data-signal') !== signal) S.tuck.setAttribute('data-signal', signal);
    var label = (save && save.getAttribute('aria-label') || 'Save state').replace(/[.\s]*$/, '') + '. Show the writing tools';
    if (S.tuck.getAttribute('aria-label') !== label) S.tuck.setAttribute('aria-label', label);
    if (S.tuck._mark !== signal && icon) { S.tuck._mark = signal; S.tuck.innerHTML = icon.outerHTML; }
  }
  function inPage(event) {
    return !!(event.target && event.target.closest && event.target.closest('#page .page-scroll'));
  }
  function onTouchStart(event) {
    S.touch = floating() && inPage(event) && event.touches.length === 1 ? { y: event.touches[0].clientY, moved: false } : null;
  }
  function onTouchMove(event) {
    if (!S.touch || S.touch.moved || !event.touches.length) return;
    if (Math.abs(event.touches[0].clientY - S.touch.y) > 10) { S.touch.moved = true; tuck(true); }
  }
  function onTouchEnd() {
    if (S.touch && !S.touch.moved) tuck(false);
    S.touch = null;
  }

  function remove() {
    tuck(false);
    if (S.root) S.root.remove();
    if (S.tuck) S.tuck.remove();
    S.tuck = null;
    S.root = null; S.row = null; S.heading = null; S.headingBlockId = null; S.actions = null;
    if (S.app) S.app.dataset.touchFormat = '0';
  }

  function place() {
    if (!S.root || !S.app) return;
    if (Castor.capsule && touchScreen()) {
      var open = S.root.dataset.open === '1', floats = open && floating();
      // The top writing row bounds the caret zone from above; the phone's floating bar
      // bounds it from below (its resting top, whether or not it is tucked).
      var bottom = open && !floats ? S.root.getBoundingClientRect().bottom : 0;
      var top = floats ? S.app.getBoundingClientRect().top + S.root.offsetTop : 0;
      [['--writing-row-bottom', bottom], ['--writing-bar-top', top]].forEach(function (pair) {
        var value = Math.round(pair[1] * 100) / 100 + 'px';
        if (S.app.style.getPropertyValue(pair[0]) !== value) S.app.style.setProperty(pair[0], value);
      });
    }
  }

  function currentBlock(saved) {
    var e = editor();
    if (!e || !saved || !e.getBlocks) return null;
    var blocks = e.getBlocks();
    for (var i = 0; i < blocks.length; i++) if (blocks[i].id === saved.blockId) return blocks[i];
    return null;
  }

  function headingLabel() {
    var e = editor(), id = e && e.focusedBlockId && e.focusedBlockId();
    var block = currentBlock(id ? { blockId: id } : e && e.getCaret && e.getCaret());
    if (!block || !/^h[1-6]$/.test(block.type)) return 'Paragraph';
    return block.type.toUpperCase();
  }

  function lineRange(source, at) {
    var start = source.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
    var end = source.indexOf('\n', at);
    return { start: start, end: end < 0 ? source.length : end };
  }

  function commit(block, saved, source, start, end) {
    var e = editor();
    if (!e || !e.replaceBlock || !e.restoreCaret || source === block.source) return false;
    if (!e.replaceBlock(block.id, source)) return false;
    e.restoreCaret({ blockId: block.id, start: start, end: end == null ? start : end }, 'snap');
    refreshHeading('typed');
    global.requestAnimationFrame(place);
    return true;
  }

  function wrapInline(block, saved, marker, empty) {
    var a = saved.start, b = saved.end, source = block.source;
    if (b > a) {
      return commit(block, saved, source.slice(0, a) + marker + source.slice(a, b) + marker + source.slice(b),
        a + marker.length, b + marker.length);
    }
    var pair = empty || marker + marker;
    return commit(block, saved, source.slice(0, a) + pair + source.slice(a), a + marker.length);
  }

  function listCommand(block, saved, kind) {
    var source = block.source, lr = lineRange(source, saved.start), line = source.slice(lr.start, lr.end);
    var indent = (/^\s*/.exec(line) || [''])[0];
    var rest = line.slice(indent.length).replace(/^(?:[-*+] |\d+[.)] )(?:\[[ xX]\] )?/, '');
    var marker = kind === 'checkbox' ? '- [ ] ' : '- ';
    var nextLine = indent + marker + rest;
    var delta = nextLine.length - line.length;
    return commit(block, saved, source.slice(0, lr.start) + nextLine + source.slice(lr.end),
      Math.max(lr.start + indent.length + marker.length, saved.start + delta),
      Math.max(lr.start + indent.length + marker.length, saved.end + delta));
  }

  function run(id) {
    var e = editor();
    if (!e) return false;
    if (id === 'undo' || id === 'redo') {
      var history = e.historyState && e.historyState();
      if (!history || !history[id] || typeof e[id] !== 'function') return false;
      e[id](); refreshControls(); return true;
    }
    if (id === 'done') {
      var active = DOC.activeElement;
      if (e.hideKeyboard) e.hideKeyboard();
      else if (active && active.blur) active.blur();
      refresh(); return true;
    }
    if (id === 'hide-keyboard') {
      var savedKeyboard = keyboardCaret();
      if (!savedKeyboard) return false;
      S.keyboardCaret = savedKeyboard;
      var toggled;
      if (keyboardUp()) toggled = e.hideKeyboard && e.hideKeyboard();
      // Keep focus inside the trusted click. Deferring this to a timer or a
      // frame prevents iOS from reopening the software keyboard.
      else toggled = e.restoreCaret && e.restoreCaret(savedKeyboard, 'snap');
      refresh(); return !!toggled;
    }
    if (e.can && !e.can(id)) return false;
    if (e && typeof e.command === 'function') {
      var result = e.command(id);
      refreshHeading('typed');   // the level may have changed under the caret; repaints only if it did
      return result;
    }
    var saved = e && e.getCaret && e.getCaret();
    var block = currentBlock(saved);
    if (!e || !saved || !block) return false;

    var source = block.source, lr, take, prefix, next, delta;
    if (id === 'heading') {
      take = /^#{1,6}\s+/.exec(source);
      var clean = take ? source.slice(take[0].length) : source;
      var levels = { p: 1, h1: 2, h2: 3, h3: 4, h4: 5, h5: 6, h6: 0 };
      var level = levels[block.type] == null ? 1 : levels[block.type];
      prefix = level ? new Array(level + 1).join('#') + ' ' : '';
      delta = prefix.length - (take ? take[0].length : 0);
      return commit(block, saved, prefix + clean, Math.max(prefix.length, saved.start + delta),
        Math.max(prefix.length, saved.end + delta));
    }
    if (id === 'bold') return wrapInline(block, saved, '**');
    if (id === 'italic') return wrapInline(block, saved, '*');
    if (id === 'highlight') return wrapInline(block, saved, '==');
    if (id === 'link') {
      if (saved.end > saved.start) {
        return commit(block, saved,
          source.slice(0, saved.start) + '[[' + source.slice(saved.start, saved.end) + ']]' + source.slice(saved.end),
          saved.start + 2, saved.end + 2);
      }
      return commit(block, saved, source.slice(0, saved.start) + '[[]]' + source.slice(saved.start), saved.start + 2);
    }
    if (id === 'bullet' || id === 'checkbox') return listCommand(block, saved, id);
    if (id === 'indent') {
      lr = lineRange(source, saved.start);
      return commit(block, saved, source.slice(0, lr.start) + '    ' + source.slice(lr.start), saved.start + 4, saved.end + 4);
    }
    if (id === 'outdent') {
      lr = lineRange(source, saved.start);
      take = /^ {1,4}/.exec(source.slice(lr.start));
      if (!take) return false;
      next = source.slice(0, lr.start) + source.slice(lr.start + take[0].length);
      return commit(block, saved, next, Math.max(lr.start, saved.start - take[0].length),
        Math.max(lr.start, saved.end - take[0].length));
    }
    return false;
  }

  function refreshHeading(force) {
    if (!S.heading) return;
    var e = editor(), id = e && e.focusedBlockId && e.focusedBlockId();
    if (!force && id === S.headingBlockId) return;
    S.headingBlockId = id;
    var label = headingLabel();
    // Typing re-asks on every keystroke; the button changes only when the level does.
    if (force !== true && label === S.headingLabel) return;
    S.headingLabel = label;
    if (S.root.dataset.toolbar === 'symbols') {
      if (/^H[1-6]$/.test(label)) S.heading.innerHTML = 'H<sub>' + label.slice(1) + '</sub>';
      else S.heading.textContent = 'P';
    } else S.heading.textContent = label;
    S.heading.setAttribute('title', 'Heading level, currently ' + label);
    S.heading.setAttribute('aria-label', 'Heading level, currently ' + label);
  }

  function keyboardCaret() {
    var e = editor(), saved = e && e.getCaret && e.getCaret();
    if (saved && currentBlock(saved)) return saved;
    return e && S.keyboardCaret && currentBlock(S.keyboardCaret) ? S.keyboardCaret : null;
  }

  function publishKeyboard() {
    if (!S.app) return;
    var state = keyboardUp() ? 'up' : 'down';
    if (S.app.dataset.keyboard === state) return;
    S.app.dataset.keyboard = state;
    if (state === 'down') tuck(false);
    var bus = S.ctx && S.ctx.bus || Castor.bus;
    if (bus && bus.emit) bus.emit('keyboard:change', { up: state === 'up' });
  }

  /* The row as data, for a renderer other than this page (the app's keyboard bar): every
     command button in the order the page draws it, with its words, its markup, whether it can
     be pressed and, for the heading button, the level in force. null while there is no row.
     A tap from elsewhere goes through run(id), as a tap here does. */
  var GROUP = { undo: 'history', redo: 'history', 'hide-keyboard': 'keyboard', done: 'done' };
  function describe() {
    if (!S.root) return null;
    var items = [];
    (function walk(node) {
      Array.prototype.forEach.call(node.children || [], function (child) {
        var id = child.dataset && child.dataset.command;
        if (!id) { walk(child); return; }
        var level = id === 'heading' ? headingLabel() : null;
        items.push({ id: id, group: GROUP[id] || 'format', label: child.getAttribute('aria-label') || '',
          text: child.textContent || '', html: child.innerHTML || '', enabled: !child.disabled,
          active: level === null ? null : level === 'Paragraph' ? 'p' : level.toLowerCase() });
      });
    })(S.root);
    return { arrangement: S.root.dataset.arrangement, open: S.root.dataset.open === '1', items: items };
  }

  /* Who hears a changed description. Nothing is described while nobody listens. */
  var listeners = [], described = null;
  function onChange(fn) {
    listeners.push(fn);
    described = JSON.stringify(describe());
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }
  function announce() {
    if (!listeners.length) return;
    var d = describe(), json = JSON.stringify(d);
    if (json === described) return;
    described = json;
    listeners.slice().forEach(function (fn) {
      try { fn(d); } catch (err) { console.error('[castor] island listener', err); }
    });
  }

  // The bar is refreshed on every key: a control's state is written only when it changes.
  function setAttr(el, name, value) { if (!el.getAttribute || el.getAttribute(name) !== value) el.setAttribute(name, value); }
  function setDisabled(button, off) {
    if (button.disabled !== off) button.disabled = off;
    setAttr(button, 'aria-disabled', off ? 'true' : 'false');
  }
  function refreshControls() {
    var e = editor();
    if (!S.actions && !S.desktopActions) { announce(); return; }
    var state = e && e.historyState ? e.historyState() : {};
    var saved = keyboardCaret();
    if (editFocused() && saved) S.keyboardCaret = saved;
    (S.actions || []).concat(S.desktopActions || []).forEach(function (button) {
      var id = button.dataset.command;
      setDisabled(button, id === 'done' ? false : id === 'hide-keyboard' ? !saved : !state[id]);
      if (id === 'hide-keyboard') {
        var up = keyboardUp(), label = up ? 'Hide keyboard' : 'Show keyboard';
        setAttr(button, 'title', label);
        setAttr(button, 'aria-label', label);
        var face = (S.root.dataset.toolbar === 'symbols' ? 'symbols:' : 'words:') + label;
        if (button.castorFace !== face) {
          if (S.root.dataset.toolbar === 'symbols') button.innerHTML = commandSymbol(up ? 'hide-keyboard' : 'show-keyboard');
          else button.textContent = label;
          button.castorFace = face;
        }
      }
    });
    if (S.row) Array.prototype.forEach.call(S.row.children, function (button) {
      var id = button.dataset.command;
      setDisabled(button, id === 'undo' || id === 'redo' ? !state[id] : !e || !!(e.can && !e.can(id)));
    });
    announce();
  }

  function refresh() {
    if (!S.mounted) return;
    ensureDesktopHistory();
    S.focused = editFocused();
    updateViewportBaseline();
    publishKeyboard();
    if (!allowed()) { remove(); refreshControls(); return; }
    var docked = touchScreen();
    if (S.root && S.root.dataset.docked !== (docked ? '1' : '0')) remove();
    if (S.root && Castor.capsule && docked && S.root.dataset.arrangement !== 'writing') remove();
    ensure();
    if (S.app && S.app.dataset.touchFormat !== (docked ? '1' : '0')) S.app.dataset.touchFormat = docked ? '1' : '0';
    var value = policy();
    var layout = mode() === 'phone' ? 'phone' : 'computer';
    if (S.root.dataset.layout !== layout) S.root.dataset.layout = layout;
    // The phone's floating bar is for the article: another field (a comment or search,
    // an editor field too) has the keyboard to itself. The bar's own buttons and a passing
    // BODY focus between two blocks are not another field.
    var active = DOC.activeElement;
    var elsewhere = mode() === 'phone' && !!active && !(active.closest && active.closest('#page')) &&
      !!(active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''));
    // While it steps aside, its round mark still shows a save problem (the top row is away too).
    if (S.app && mode() === 'phone' && (S.app.dataset.barAside != null) !== elsewhere) { if (elsewhere) S.app.dataset.barAside = ''; else delete S.app.dataset.barAside; }
    var show = Castor.capsule && docked ? keyboardUp() && !elsewhere : docked || (!S.dismissed && !focusActive() &&
      (value === 'always' || (S.focused && keyboardUp())));
    if (S.root.dataset.open !== (show ? '1' : '0')) S.root.dataset.open = show ? '1' : '0';
    setAttr(S.root, 'aria-hidden', show ? 'false' : 'true');
    if (!show || !floating()) tuck(false);
    paintTuck();
    refreshHeading();
    refreshControls();
    if (Castor.touchLayout) Castor.touchLayout.placeSave();
    if (show || Castor.capsule && docked) global.requestAnimationFrame(place);
  }

  function onFocusIn(event) {
    if (event.target && event.target.classList && event.target.classList.contains('cw-edit')) {
      S.dismissed = false; refresh();
    }
  }
  function onFocusOut() {
    global.setTimeout(function () {
      if (!editFocused()) { S.dismissed = false; refresh(); }
    }, 0);
  }
  function onViewport() { refresh(); }

  function mount(ctx) {
    if (!DOC) return api;
    S.ctx = ctx || {};
    S.frame = S.ctx.frame || DOC.getElementById('frame') || DOC.body;
    S.app = S.ctx.app || DOC.getElementById('app');
    S.article = S.ctx.article || S.ctx.pageEl || DOC.getElementById('page-article');
    var vv = viewport();
    updateViewportBaseline();
    if (!S.mounted) {
      DOC.addEventListener('focusin', onFocusIn, true);
      DOC.addEventListener('focusout', onFocusOut, true);
      DOC.addEventListener('selectionchange', function () { refreshHeading(false); refreshControls(); });
      DOC.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      DOC.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
      DOC.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
      ['beforeinput', 'input'].forEach(function (type) {
        DOC.addEventListener(type, function (event) {
          if (event.target && event.target.closest && event.target.closest('.cw-edit')) tuck(false);
        }, true);
      });
      global.addEventListener('resize', refresh);
      global.addEventListener('orientationchange', refresh);
      if (global.screen && global.screen.orientation && global.screen.orientation.addEventListener) {
        global.screen.orientation.addEventListener('change', refresh);
      }
      if (touchMedia) {
        if (touchMedia.addEventListener) touchMedia.addEventListener('change', refresh);
        else if (touchMedia.addListener) touchMedia.addListener(refresh);
      }
      if (vv) { vv.addEventListener('resize', onViewport); vv.addEventListener('scroll', onViewport); }
      if (global.ResizeObserver && S.app) {
        S.resizeObserver = new ResizeObserver(refresh);
        S.resizeObserver.observe(S.app);
      }
      if (Castor.panels && Castor.panels.onLayout) Castor.panels.onLayout(refresh);
      var bus = S.ctx.bus || Castor.bus;
      if (bus && bus.on) bus.on('size', refresh);
      if (bus && bus.on) {
        bus.on('doc:change', function () { refreshHeading('typed'); refreshControls(); });
        bus.on('editor:history', refreshControls);
        bus.on('piece:open', function () { S.keyboardCaret = null; S.headingBlockId = null; refreshHeading(true); refreshControls(); });
      }
      S.mounted = true;
    }
    refresh();
    return api;
  }

  var api = {
    mount: mount,
    run: run,
    refresh: refresh,
    describe: describe,
    onChange: onChange,
    setTouchEnabled: function (on) { S.touchEnabled = !!on; refresh(); },
    hide: function () { S.dismissed = true; refresh(); },
    tuck: function (on) { tuck(on); return tucked(); },
    state: function () { return { mounted: S.mounted, present: !!S.root, open: !!(S.root && S.root.dataset.open === '1'), mode: mode(), policy: policy() }; },
    _setKeyboardForTest: function (on) { S.keyboardOverride = on == null ? null : !!on; refresh(); }
  };

  Castor.island = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
