/* Castor engine · commands.js — the palette, the pickers, the keyboard map.
 *
 * Three jobs:
 *   1. The inline pickers the editor calls: `/` block commands, `@` people and
 *      files, `[[` pieces, files and headings, `[^` the next footnote number.
 *   2. The command palette on ⌘K. The palette is a REGISTRY, not a list: every
 *      module registers what it owns through Castor.commands.register(), so the
 *      palette knows about a panel or a type choice without knowing the module.
 *   3. The global keyboard map from the engine contract, Ctrl on non-Mac.
 *
 * Every action reaches for Castor.panels / Castor.app / Castor.editor only if
 * they are there; nothing here breaks a page that mounted a subset.
 */
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var IS_MAC = typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  var THEME_KEY = 'Y'; // Ctrl+Alt+T opens a terminal on common Linux desktops.
  // Physical keys shared by the registry, global dispatcher and hover labels.
  var APP_KEYS = {
    'panel.files': 'KeyS', 'panel.outline': 'KeyO', 'panel.comments': 'KeyT',
    'panel.changes': 'KeyG', 'panel.workspace': 'KeyA', 'panel.live': 'KeyV',
    'panel.drafts': 'KeyX', 'panel.links': 'KeyK', 'panel.beside': 'BracketRight',
    'view.focus': 'KeyZ', 'view.settings': 'Comma', 'view.theme.cycle': 'KeyY',
    'view.review': 'BracketLeft', 'view.lastpanel': 'Backslash', 'edit.comment': 'Quote',
    'help.next': 'KeyN', 'tabs.new': 'KeyP'
  };
  function appKeyLabel(code) {
    return '⌘⌥' + ({ Comma: ',', Backslash: '\\', BracketRight: ']', BracketLeft: '[', Quote: "'" }[code] || code.slice(3));
  }

  var keys = (function () {
    var nav = global.navigator || {};
    var loc = global.location || {};

    function readEnv(search) {
      var out = {};
      var m = /[?&]env=([^&#]*)/.exec(search || '');
      if (!m) return out;
      decodeURIComponent(m[1]).split(',').forEach(function (w) {
        w = w.trim().toLowerCase();
        if (w === 'mac' || w === 'win' || w === 'linux') out.os = w;
        else if (w === 'phone' || w === 'tablet' || w === 'desktop') out.device = w;
        else if (w === 'standalone') out.standalone = true;
        else if (w === 'browser') out.standalone = false;
      });
      return out;
    }
    var ENV = readEnv(loc.search);

    function media(q) {
      try { return !!(global.matchMedia && global.matchMedia(q).matches); } catch (e) { return false; }
    }

    /* userAgentData first (it says "macOS" plainly), then the old platform string,
       then the user agent. An iPad asking for the desktop site reports Macintosh,
       which is right here: its keyboard prints ⌘. */
    function osFrom(platform, ua) {
      var p = String(platform || '') + ' ' + String(ua || '');
      if (/mac|iphone|ipad|ipod/i.test(p)) return 'mac';
      if (/win/i.test(p)) return 'win';
      return 'linux';
    }
    function detectOs() {
      if (ENV.os) return ENV.os;
      var uad = nav.userAgentData && nav.userAgentData.platform;
      return osFrom(uad || nav.platform, nav.userAgent);
    }

    /* A phone, a tablet or a computer, from what the device IS rather than how
       wide the window happens to be: a narrow Chrome window on a Mac still has a
       keyboard under it. */
    function deviceFrom(o) {
      var ua = o.ua || '';
      if (/iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua))) return 'phone';
      if (/iPad/.test(ua) || /Android/.test(ua)) return 'tablet';
      if (/Macintosh/.test(ua) && (o.touchPoints || 0) > 1) return 'tablet';   // iPadOS as a "Mac"
      if (o.coarse && !o.hover) return (o.shortSide || 0) < 600 ? 'phone' : 'tablet';
      return 'desktop';
    }
    function detectDevice() {
      if (ENV.device) return ENV.device;
      var scr = global.screen || {};
      return deviceFrom({
        ua: nav.userAgent || '', touchPoints: nav.maxTouchPoints || 0,
        coarse: media('(pointer: coarse)'), hover: media('(hover: hover)'),
        shortSide: Math.min(scr.width || 0, scr.height || 0)
      });
    }

    /* An installed app window has no browser tabs, so the browser's own tab keys
       are free there. Fullscreen is NOT counted: a fullscreen browser tab still
       keeps them. */
    function standalone() {
      if (typeof ENV.standalone === 'boolean') return ENV.standalone;
      return media('(display-mode: standalone)') || media('(display-mode: window-controls-overlay)') ||
        nav.standalone === true;
    }

    var MAC_GLYPH = { MOD: '⌘', '⌘': '⌘', '⇧': '⇧', '⌥': '⌥', '⌃': '⌃' };
    var WORD = { MOD: 'Ctrl', '⌘': 'Ctrl', '⇧': 'Shift', '⌥': 'Alt', '⌃': 'Ctrl' };

    /* 'MOD ⇧ O' -> ['⌘','⇧','O'] on a Mac, ['Ctrl','Shift','O'] elsewhere. A
       glued string like '⌘⇧F' (the palette's own spelling) is split first. */
    function format(entry, os) {
      os = os || detectOs();
      var s = String(entry || '').replace(/MOD/g, ' MOD ').replace(/([⌘⇧⌥⌃])/g, ' $1 ');
      return s.split(/\s+/).filter(Boolean).map(function (t) {
        var table = os === 'mac' ? MAC_GLYPH : WORD;
        return Object.prototype.hasOwnProperty.call(table, t) ? table[t] : t;
      });
    }
    function text(entry, os) {
      os = os || detectOs();
      return format(entry, os).join(os === 'mac' ? '' : '+');
    }

    function hint(control, entry, aria) {
      if (!control) return;
      var cap = global.document.createElement('kbd');
      cap.className = 'shortcut-hint';
      cap.textContent = text(entry);
      cap.setAttribute('aria-hidden', 'true');
      control.appendChild(cap);
      control.setAttribute('aria-keyshortcuts', aria.replace(/MOD/g, detectOs() === 'mac' ? 'Meta' : 'Control'));
    }

    function chordFor(os, isStandalone) {
      var mac = os === 'mac';
      var primary = isStandalone
        ? (mac ? { meta: true } : { ctrl: true })
        : (mac ? { ctrl: true } : { alt: true, shift: true });
      var also = isStandalone ? [mac ? { ctrl: true } : { alt: true, shift: true }] : [];
      var badge = isStandalone
        ? (mac ? '⌘' : '')
        : (mac ? '⌃' : '');
      var words = isStandalone
        ? (mac ? '⌘ + number' : 'Ctrl + number')
        : (mac ? '⌃ Control + number' : 'Alt + Shift + number');
      var aria = isStandalone
        ? (mac ? 'Meta+' : 'Control+')
        : (mac ? 'Control+' : 'Alt+Shift+');
      /* The keys whose hold shows the numbers: the chord's own, and on a Mac the
         ⌘ reflex too, because the hint has to be there when the reflex fires and
         what it then shows is the chord that works, spelled out in words. */
      var hold = mac ? ['Meta', 'Control'] : (isStandalone ? ['Control', 'Alt'] : ['Alt', 'Control']);
      return { os: os, standalone: !!isStandalone, primary: primary, chords: [primary].concat(also),
        badge: badge, words: words, aria: aria, hold: hold };
    }
    function same(e, m) {
      return !!e.metaKey === !!m.meta && !!e.ctrlKey === !!m.ctrl &&
        !!e.altKey === !!m.alt && !!e.shiftKey === !!m.shift;
    }
    /* The digit a key event asks for under this chord, or 0. Read from e.code,
       because with Shift held e.key is "!" and with Alt on a Mac it is "¡". */
    function digitOf(chord, e) {
      if (!e) return 0;
      var hit = chord.chords.some(function (m) { return same(e, m); });
      if (!hit) return 0;
      var m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      if (m) return Number(m[1]);
      return /^[1-9]$/.test(e.key || '') ? Number(e.key) : 0;
    }
    function tabChord() { return chordFor(detectOs(), standalone()); }

    /* --- whether key caps belong on this screen ----------------------------- */

    var seenKeyboard = false;
    function frameSize() {
      var f = global.document && global.document.getElementById('frame');
      return (f && f.dataset && f.dataset.size) || 'computer';
    }
    function form() {
      var d = detectDevice();
      var s = frameSize();
      if (d === 'phone' || s === 'phone') return 'phone';
      if (d === 'tablet' || s === 'ipad') return 'tablet';
      return 'desktop';
    }
    function visibleFor(f, seen) { return f === 'desktop' || (f === 'tablet' && !!seen); }

    /* A key from a real keyboard, not the on-screen one. A modifier cannot come
       from a touch keyboard; a printable key can, so it only counts while no
       on-screen keyboard is taking the bottom of the screen. Composition and the
       "Unidentified"/229 events Android sends for its own keyboard never count. */
    function composing(e) { return !!(e && (e.isComposing || e.keyCode === 229)); }
    function physical(e, touchKeyboardUp) {
      if (!e || composing(e)) return false;
      var k = e.key || '';
      if (k === 'Unidentified' || k === 'Process' || k === 'Dead') return false;
      if (k === 'Meta' || k === 'Control' || k === 'Alt' || e.metaKey || e.ctrlKey || e.altKey) return true;
      if (k === 'Shift' || k.length === 1 || /^(Arrow|Escape$|F\d)/.test(k)) return !touchKeyboardUp;
      return false;
    }
    function touchKeyboardUp() {
      var vv = global.visualViewport;
      if (!vv || !global.innerHeight) return false;
      return global.innerHeight - vv.height * (vv.scale || 1) > 120;
    }

    function apply() {
      var root = global.document && global.document.documentElement;
      if (!root) return;
      var on = visibleFor(form(), seenKeyboard);
      root.setAttribute('data-keys', on ? 'on' : 'off');
      root.setAttribute('data-os', detectOs());
    }
    var wired = false;
    function wire() {
      if (wired || !global.document) return;
      wired = true;
      apply();
      /* On the window, in the capture phase, and registered before the tour's
         own listener, so a key the tour consumes still counts. */
      global.addEventListener('keydown', function (e) {
        if (seenKeyboard || !physical(e, touchKeyboardUp())) return;
        seenKeyboard = true;
        apply();
        if (Castor.bus && Castor.bus.emit) Castor.bus.emit('keys:shown', true);
      }, true);
      /* The size switch re-frames the app as an iPad or a phone. */
      var f = global.document.getElementById('frame');
      if (f && global.MutationObserver) {
        new global.MutationObserver(apply).observe(f, { attributes: true, attributeFilter: ['data-size'] });
      }
    }

    return {
      os: detectOs, device: detectDevice, standalone: standalone, form: form,
      format: format, text: text, hint: hint, composing: composing,
      chordFor: chordFor, tabChord: tabChord, digitOf: digitOf,
      shown: function () { return visibleFor(form(), seenKeyboard); },
      wire: wire, apply: apply,
      // pure pieces, for the tests
      _osFrom: osFrom, _deviceFrom: deviceFrom, _visibleFor: visibleFor, _physical: physical,
      _readEnv: readEnv
    };
  })();
  Castor.keys = keys;

  var registry = [];
  var byId = {};

  // ---------------------------------------------------------------------------
  // 1 · Registry
  // ---------------------------------------------------------------------------

  function register(cmd) {
    if (!cmd || !cmd.id || typeof cmd.run !== 'function') return null;
    if (byId[cmd.id]) {                        // re-registering replaces
      registry = registry.filter(function (c) { return c.id !== cmd.id; });
    }
    var c = {
      id: cmd.id,
      title: cmd.title || cmd.id,
      keys: APP_KEYS[cmd.id] ? appKeyLabel(APP_KEYS[cmd.id]) : (cmd.keys || ''),
      section: cmd.section || 'Actions',
      hint: cmd.hint || '',
      when: cmd.when || null,
      listed: cmd.listed || null,
      run: cmd.run
    };
    registry.push(c); byId[c.id] = c;
    return c;
  }
  function unregister(id) { registry = registry.filter(function (c) { return c.id !== id; }); delete byId[id]; }
  function all() { return registry.slice(); }
  /* One page-wide limit on what the palette offers at all (reviewer mode,
     app.js): a command outside it is neither listed nor run, by the palette, the
     keyboard map or a chord. Null means no limit, which is every founder's page. */
  var limiter = null;
  function allowed(c) { try { return !limiter || !!limiter(c); } catch (e) { return false; } }
  function available(c) {
    if (!allowed(c)) return false;
    try { return c.when ? !!c.when() : true; } catch (e) { return false; }
  }
  /* Unavailable commands are still listed, greyed, so the palette teaches what the
     app can do. A command for something that does not exist yet is different: a
     greyed "Live panel" is a word with nothing behind it, so `listed` keeps it
     out of the palette, the search and the keyboard map altogether. */
  function listed(c) {
    if (!allowed(c)) return false;
    try { return c.listed ? !!c.listed() : true; } catch (e) { return true; }
  }

  // ---------------------------------------------------------------------------
  // 2 · Fuzzy match
  // ---------------------------------------------------------------------------

  function score(q, text) {
    if (!q) return 1;
    var s = text.toLowerCase(), n = q.toLowerCase(), at = 0, total = 0;
    for (var i = 0; i < n.length; i++) {
      var c = n.charAt(i);
      if (c === ' ') continue;
      var hit = s.indexOf(c, at);
      if (hit < 0) return 0;
      total += (hit === at ? 3 : 1);                             // consecutive run
      if (hit === 0 || /[\s·:(/-]/.test(s.charAt(hit - 1))) total += 2; // word start
      at = hit + 1;
    }
    return total + Math.max(0, 24 - s.length) / 12;
  }

  function rank(q, list, textOf) {
    return list
      .map(function (x) { return { x: x, s: score(q, textOf(x)) }; })
      .filter(function (r) { return r.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .map(function (r) { return r.x; });
  }

  function contextMatch(text, query) {
    var lines = String(text || '').split('\n').map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var q = String(query || '').trim().toLowerCase();
    var clean = lines.filter(function (line) { return q && line.toLowerCase().indexOf(q) >= 0; })[0];
    if (!clean) clean = (q ? rank(q, lines, function (line) { return line; })[0] : lines[0]) || '';
    if (!clean) return null;
    var lower = clean.toLowerCase();
    var at = q ? lower.indexOf(q) : 0;
    if (q && at < 0 && !score(q, clean)) return null;
    if (at < 0) at = 0;
    var from = Math.max(0, at - 42), to = Math.min(clean.length, at + Math.max(q.length, 1) + 58);
    var label = (from ? '…' : '') + clean.slice(from, to) + (to < clean.length ? '…' : '');
    var match = q && lower.indexOf(q) >= 0 ? clean.slice(lower.indexOf(q), lower.indexOf(q) + q.length) : '';
    return { label: label, match: match };
  }

  // Quick search is local and synchronous: headings, then passages, then the
  // command registry. At article scale this is cheaper than one layout read.
  function searchItems(query) {
    var q = String(query || '').trim();
    var doc = Castor.editor && Castor.editor.getDoc ? (Castor.editor.getDoc() || {}) : {};
    var headings = rank(q, (doc.headings || []).slice(), function (h) { return h.text || ''; }).slice(0, 10).map(function (h) {
      var hit = contextMatch(h.text, q) || { label: h.text, match: '' };
      return { id: 'search-h:' + h.blockId, group: 'Headings', label: hit.label, match: hit.match, detail: 'H' + h.level,
        run: function () { goToMatch(h.blockId, hit.match || h.text, h.text); } };
    });
    var headingIds = {}; (doc.headings || []).forEach(function (h) { headingIds[h.blockId] = 1; });
    var passages = [];
    (doc.blocks || []).forEach(function (b) {
      if (headingIds[b.id] || b.type === 'frontmatter' || b.type === 'footnote-def') return;
      var hit = contextMatch(b.source || b.text, q);
      if (!hit || (q && !hit.match && !score(q, b.text || b.source))) return;
      passages.push({ id: 'search-p:' + b.id, group: 'Passages', label: hit.label, match: hit.match, detail: 'passage',
        run: function () { goToMatch(b.id, hit.match || (b.text || '').slice(0, 40), b.text || ''); } });
    });
    passages = rank(q, passages, function (p) { return p.label; }).slice(0, 12);
    var commands = rank(q, registry.filter(function (c) { return available(c) && listed(c); }), function (c) { return c.title + ' ' + c.section + ' ' + c.id; }).slice(0, 12).map(function (c) {
      var hit = contextMatch(c.title, q) || { label: c.title, match: '' };
      return { id: 'search-c:' + c.id, group: 'Commands', label: hit.label, match: hit.match,
        detail: c.hint || keyLabel(c.keys), run: function () { run(c.id); } };
    });
    return headings.concat(passages, commands);
  }

  function goToMatch(blockId, quote, blockText) {
    if (!Castor.editor) return;
    Castor.editor.scrollToBlock(blockId);
    if (quote && Castor.editor.flashAnchor) Castor.editor.flashAnchor({ quote: quote, blockText: blockText || '', blockId: blockId });
  }

  function searchRows(q) {
    var out = [], group = null;
    searchItems(q).forEach(function (item) {
      if (item.group !== group) { group = item.group; out.push({ kind: 'section', title: group }); }
      out.push({ kind: 'search', item: item });
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3 · Key labels
  // ---------------------------------------------------------------------------

  /* ⌘⇧F on a Mac, Ctrl+Shift+F elsewhere: the platform's own spelling (section 0). */
  function keyLabel(k) {
    if (!k) return '';
    return keys.text(k);
  }

  // ---------------------------------------------------------------------------
  // 4 · Base styles (functional only; inserted first in <head> so a world wins)
  // ---------------------------------------------------------------------------

  function injectBase() {
    if (typeof document === 'undefined' || document.getElementById('castor-commands-base')) return;
    var s = document.createElement('style');
    s.id = 'castor-commands-base';
    s.textContent = [
      '.cw-palette{position:fixed;inset:0;z-index:90;display:flex;justify-content:center;',
      'align-items:flex-start;padding-top:12vh;background:rgba(12,12,14,.28)}',
      '.cw-palette[hidden]{display:none!important}',
      '.cw-palette-box{width:min(560px,92vw);max-height:70vh;display:flex;flex-direction:column;overflow:hidden;',
      'background:var(--pane-solid,#fff);color:var(--ink,#111);border:1px solid var(--rule,rgba(0,0,0,.14));',
      'border-radius:12px;box-shadow:0 24px 60px -18px rgba(0,0,0,.45);',
      'font:400 14px/1.4 var(--font-ui,system-ui,sans-serif)}',
      '.cw-palette-input{all:unset;padding:14px 16px;font-size:15px;',
      'border-bottom:1px solid var(--rule,rgba(0,0,0,.1))}',
      '.cw-palette-list,.cw-picker-list{overflow-y:auto;padding:6px}',
      '.cw-sect{padding:8px 10px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.5}',
      '.cw-row{display:flex;align-items:baseline;gap:10px;padding:7px 10px;border-radius:7px;cursor:pointer}',
      '.cw-row[aria-selected="true"]{background:var(--pane-hot,rgba(0,0,0,.07))}',
      '.cw-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cw-row-hint{font-size:12px;opacity:.55}',
      '.shortcut-section{font:600 14px/1.4 var(--font-ui,system-ui);margin:1.4rem 0 .6rem}',
      '.shortcuts-reference{max-width:calc(100vw - 24px)}',
      '.shortcut-row{align-items:baseline}.shortcut-row>span{min-width:0}',
      '.shortcuts-reference .shortcut-row kbd{white-space:normal;text-align:right;min-width:5rem}',
      'html[data-keys="off"] .castor-settings #set-shortcuts{display:flex}',
      'html[data-keys="off"] #castor-keys-reference .shortcut-row kbd{display:block}',
      'html[data-keys="off"] .cw-palette[data-keyboard-map="true"] .cw-row-keys{display:block!important}',
      '.cw-row-keys{font-size:12px;opacity:.6;font-variant-numeric:tabular-nums}',
      '.cw-row.cw-off{opacity:.42}',
      '.cw-empty{padding:12px 10px;opacity:.55}',
      '.cw-picker{position:fixed;z-index:80;width:min(300px,80vw);max-height:44vh;overflow:hidden;',
      'background:var(--pane-solid,#fff);color:var(--ink,#111);border:1px solid var(--rule,rgba(0,0,0,.14));',
      'border-radius:10px;box-shadow:0 14px 34px -12px rgba(0,0,0,.4);',
      'font:400 13.5px/1.4 var(--font-ui,system-ui,sans-serif)}',
      '.cw-picker[hidden]{display:none}'
    ].join('');
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }

  // ---------------------------------------------------------------------------
  // 5 · The palette
  // ---------------------------------------------------------------------------

  var paletteEl = null, paletteBox = null, inputEl = null, listEl = null;
  var isOpen = false, rows = [], selIndex = 0, listMode = null;
  var paletteCaret = null, searchOnly = false;

  function buildPalette() {
    if (paletteEl) return;
    injectBase();
    paletteEl = document.createElement('div');
    paletteEl.className = 'palette-scrim cw-palette';
    paletteEl.setAttribute('data-open', '0');
    paletteEl.hidden = true;
    var box = document.createElement('div');
    box.className = 'palette cw-palette-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Commands');
    box.setAttribute('data-open', '0');
    paletteBox = box;
    inputEl = document.createElement('input');
    inputEl.className = 'palette-input cw-palette-input';
    inputEl.type = 'text';
    inputEl.setAttribute('aria-label', 'Command');
    inputEl.placeholder = 'What do you want to do';
    listEl = document.createElement('div');
    listEl.className = 'palette-list cw-palette-list';
    listEl.setAttribute('role', 'listbox');
    box.appendChild(inputEl); box.appendChild(listEl);
    paletteEl.appendChild(box);
    document.body.appendChild(paletteEl);

    paletteEl.addEventListener('mousedown', function (e) { if (e.target === paletteEl) close(); });
    inputEl.addEventListener('input', function () { refresh(inputEl.value); });
    inputEl.addEventListener('keydown', onPaletteKey);
    paletteEl.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && Castor.popovers) Castor.popovers.containTab(e, paletteBox, document);
    });
  }

  function open(prefill) {
    buildPalette();
    paletteCaret = Castor.editor && Castor.editor.getCaret ? Castor.editor.getCaret() : null;
    listMode = null;
    searchOnly = false;
    isOpen = true;
    setOpen(true);
    inputEl.value = prefill || '';
    inputEl.placeholder = 'What do you want to do';
    refresh(inputEl.value);
    inputEl.focus();
  }

  // A drill-down list inside the palette (the Type faces, the headings, the
  // "since" choices). Same chrome, so it never feels like a second widget.
  function openList(spec) {
    buildPalette();
    paletteCaret = Castor.editor && Castor.editor.getCaret ? Castor.editor.getCaret() : null;
    listMode = spec;
    searchOnly = false;
    isOpen = true;
    setOpen(true);
    inputEl.value = '';
    inputEl.placeholder = spec.title || 'Choose';
    refresh('');
    inputEl.focus();
  }

  function close() {
    if (!paletteEl) return;
    isOpen = false; listMode = null; searchOnly = false;
    setOpen(false);
    if (paletteCaret && Castor.editor && Castor.editor.restoreCaret) Castor.editor.restoreCaret(paletteCaret, 'navigate');
    paletteCaret = null;
  }

  function openSearch() {
    open('');
    searchOnly = true;
    inputEl.placeholder = 'Search this piece';
    refresh('');
  }

  function setOpen(on) {
    paletteEl.hidden = !on;
    paletteEl.setAttribute('data-open', on ? '1' : '0');
    paletteEl.setAttribute('data-keyboard-map', listMode && listMode.keyboardMap ? 'true' : 'false');
    paletteBox.setAttribute('data-open', on ? '1' : '0');
  }

  function refresh(q) {
    selIndex = 0;
    if (listMode) {
      var matches = rank(q, listMode.items, function (i) { return (i.label || '') + ' ' + (i.detail || '') + ' ' + (i.section || ''); });
      rows = [];
      var listSection = null;
      matches.forEach(function (i) {
        if (i.section && i.section !== listSection) { listSection = i.section; rows.push({ kind: 'section', title: i.section }); }
        rows.push({ kind: 'item', item: i });
      });
      selIndex = rows.findIndex(function (r) { return r.kind !== 'section'; });
      if (selIndex < 0) selIndex = 0;
    } else if (searchOnly || String(q || '').trim()) {
      rows = searchRows(q);
      selIndex = rows.findIndex(function (r) { return r.kind !== 'section'; });
      if (selIndex < 0) selIndex = 0;
    } else {
      var cmds = rank(q, registry.filter(listed), function (c) { return c.title + ' ' + c.section + ' ' + c.id; });
      cmds.sort(function (a, b) { return (available(a) ? 0 : 1) - (available(b) ? 0 : 1); });
      rows = [];
      var section = null;
      cmds.forEach(function (c) {
        if (c.section !== section) { section = c.section; rows.push({ kind: 'section', title: section }); }
        rows.push({ kind: 'cmd', cmd: c });
      });
      // keep the first selectable row selected
      selIndex = rows.findIndex(function (r) { return r.kind !== 'section'; });
      if (selIndex < 0) selIndex = 0;
    }
    drawList(listEl, rows, selIndex, function (r, i) { selIndex = i; runRow(r); });
  }

  function drawList(host, list, sel, onActivate) {
    host.innerHTML = '';
    if (!list.length || list.every(function (r) { return r.kind === 'section'; })) {
      var none = document.createElement('div');
      none.className = 'cw-empty';
      none.textContent = 'Nothing matches that';
      host.appendChild(none);
      return;
    }
    list.forEach(function (r, i) {
      if (r.kind === 'section') {
        var h = document.createElement('div');
        h.className = 'cw-sect'; h.textContent = r.title;
        host.appendChild(h);
        return;
      }
      var row = document.createElement('div');
      row.className = 'palette-item cw-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      var title = document.createElement('span');
      title.className = 'cw-row-title';
      var hint = document.createElement('span');
      hint.className = 'palette-hint cw-row-hint';
      var keys = document.createElement('span');
      keys.className = 'palette-hint cw-row-keys';
      if (r.kind === 'cmd') {
        title.textContent = r.cmd.title;
        hint.textContent = available(r.cmd) ? r.cmd.hint : 'not in this page';
        keys.textContent = keyLabel(r.cmd.keys);
        if (!available(r.cmd)) row.classList.add('cw-off');
      } else {
        title.textContent = r.item.label;
        hint.textContent = r.item.detail || '';
        keys.textContent = keyLabel(r.item.keys);
        if (r.item.match) paintMatch(title, r.item.label, r.item.match);
      }
      row.appendChild(title); row.appendChild(hint); row.appendChild(keys);
      row.addEventListener('mousedown', function (e) { e.preventDefault(); });
      row.addEventListener('click', function () { if (onActivate) onActivate(r, i); });
      host.appendChild(row);
    });
  }

  function paintMatch(host, label, match) {
    var at = String(label).toLowerCase().indexOf(String(match).toLowerCase());
    if (at < 0) return;
    host.textContent = '';
    host.appendChild(document.createTextNode(label.slice(0, at)));
    var strong = document.createElement('strong'); strong.textContent = label.slice(at, at + match.length); host.appendChild(strong);
    host.appendChild(document.createTextNode(label.slice(at + match.length)));
  }

  function moveSel(host, list, dir) {
    var i = selIndex;
    do {
      i += dir;
      if (i < 0) i = list.length - 1;
      if (i >= list.length) i = 0;
    } while (list[i] && list[i].kind === 'section');
    selIndex = i;
    drawList(host, list, selIndex, function (r, k) { selIndex = k; runRow(r); });
    var node = host.querySelectorAll('.cw-row')[countRowsBefore(list, i)];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }
  function countRowsBefore(list, i) {
    var n = 0;
    for (var k = 0; k < i; k++) if (list[k].kind !== 'section') n++;
    return n;
  }

  function runRow(r) {
    if (!r) return;
    if (r.kind === 'cmd') {
      if (!available(r.cmd)) return;
      close();
      try { r.cmd.run(); } catch (e) { console.error(e); }
    } else if (r.kind === 'item') {
      var pick = listMode && listMode.onPick;
      var item = r.item;
      close();
      if (pick) { try { pick(item); } catch (e) { console.error(e); } }
    } else if (r.kind === 'search') {
      var found = r.item;
      close();
      if (found && found.run) { try { found.run(); } catch (e) { console.error(e); } }
    }
  }

  function onPaletteKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(listEl, rows, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(listEl, rows, -1); return; }
    if (e.key === 'Enter') { e.preventDefault(); runRow(rows[selIndex]); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  }

  // ---------------------------------------------------------------------------
  // 6 · The inline pickers
  // ---------------------------------------------------------------------------

  var pickerEl = null, picked = null;

  function data() { return (Castor.app && Castor.app.data) || global.CASTOR_DATA || {}; }

  var BLOCK_ITEMS = [
    { id: 'h1', label: 'Heading 1', insert: '# ' },
    { id: 'h2', label: 'Heading 2', insert: '## ' },
    { id: 'h3', label: 'Heading 3', insert: '### ' },
    { id: 'list', label: 'List', insert: '- ' },
    { id: 'numbered', label: 'Numbered', insert: '1. ' },
    { id: 'quote', label: 'Quote', insert: '> ' },
    { id: 'callout', label: 'Callout', insert: '> [!note] ' },
    { id: 'image', label: 'Image', insert: '![[]]', caretBack: 2, detail: 'embed a file' },
    { id: 'table', label: 'Table', insert: '| Column | Column |\n| --- | --- |\n|  |  |', caretBack: 6 },
    { id: 'line', label: 'Line', insert: '---' },
    { id: 'code', label: 'Code', insert: '```\n\n```', caretBack: 4 },
    { id: 'card', label: 'Workspace card', insert: '> [!example] Workspace card\n> ', detail: 'goes to the canvas' }
  ];

  function nextFootnote(doc) {
    return Castor.editor && Castor.editor.nextFootnote ? Castor.editor.nextFootnote() : '1';
  }

  function defaultItems(kind, o) {
    var d = data(), doc = o && o.doc, out = [];
    if (kind === 'search') return searchItems(o && o.query || '');
    if (kind === 'block') {
      return BLOCK_ITEMS.concat(registry.filter(function (c) { return c.id !== 'edit.undo' && c.id !== 'edit.redo' && available(c) && listed(c); }).map(function (c) {
        return { id: 'command:' + c.id, label: c.title, detail: c.hint || c.section, keys: c.keys,
          run: function () { run(c.id); } };
      }));
    }
    if (kind === 'mention') {
      var people = (d.people && d.people.length) ? d.people.map(function (p) { return typeof p === 'string' ? p : p.name; }).filter(Boolean) : ['agent'];
      if (people.indexOf('agent') < 0) people.unshift('agent');
      people.forEach(function (p) {
        out.push({ id: 'p:' + p, label: p, detail: p === 'agent' ? 'your agent' : 'in the room', insert: '@' + p });
      });
      ((d.piece && d.piece.files) || []).forEach(function (f) {
        out.push({ id: 'f:' + f, label: f, detail: 'file', insert: '[[' + f + ']]' });
      });
      return out;
    }
    if (kind === 'wiki') {
      (d.pieces || []).forEach(function (p) {
        out.push({ id: 'w:' + p, label: p, detail: 'piece', insert: '[[' + p + ']]' });
      });
      ((d.piece && d.piece.files) || []).forEach(function (f) {
        out.push({ id: 'wf:' + f, label: f, detail: 'file', insert: '[[' + f + ']]' });
      });
      ((doc && doc.headings) || []).forEach(function (h) {
        out.push({ id: 'h:' + h.id, label: h.text, detail: 'heading in this piece', insert: '[[#' + h.text + ']]' });
      });
      return out;
    }
    if (kind === 'footnote') {
      var next = nextFootnote(doc);
      out.push({ id: 'fn:' + next, label: '[^' + next + ']', detail: 'the next footnote', insert: '[^' + next + ']' });
      return out;
    }
    return out;
  }

  function picker(kind, o) {
    o = o || {};
    closePicker();
    injectBase();
    var items = o.items || defaultItems(kind, o);
    if (!items.length) return null;

    pickerEl = document.createElement('div');
    pickerEl.className = 'cw-picker';
    var list = document.createElement('div');
    list.className = 'cw-picker-list';
    list.setAttribute('role', 'listbox');
    pickerEl.appendChild(list);
    document.body.appendChild(pickerEl);

    var state = { kind: kind, all: items, rows: [], sel: 0, query: null, onPick: o.onPick, onCancel: o.onCancel };
    picked = state;
    var placeRaf = 0, pendingRect = o.anchorRect;

    function draw() {
      state.rows = state.shown.map(function (i) { return { kind: 'item', item: i }; });
      if (state.sel >= state.rows.length) state.sel = Math.max(0, state.rows.length - 1);
      drawList(list, state.rows, state.sel, function (r, i) { state.sel = i; commit(); });
      var selected = list.children[state.sel];
      if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest' });
    }
    function filter(q) {
      q = q || '';
      if (q === state.query) return;
      state.query = q;
      state.shown = kind === 'search' ? searchItems(q || '')
        : rank(q || '', state.all, function (i) { return (i.label || '') + ' ' + (i.detail || ''); });
      if (!state.shown.length) state.shown = [];
      draw();
    }
    function place(rect) {
      pendingRect = rect || pendingRect;
      if (!pendingRect || placeRaf) return;
      placeRaf = requestAnimationFrame(function () {
        placeRaf = 0;
        if (!pickerEl) return;
        var box = pickerEl.getBoundingClientRect();
        var vw = global.innerWidth || 1024, vh = global.innerHeight || 768;
        var left = Math.min(Math.max(8, pendingRect.left), vw - box.width - 8);
        var top = pendingRect.bottom + 6;
        if (top + box.height > vh - 8) top = Math.max(8, pendingRect.top - box.height - 6);
        pickerEl.style.left = Math.round(left) + 'px';
        pickerEl.style.top = Math.round(top) + 'px';
      });
    }
    function commit() {
      var row = state.rows[state.sel];
      var fn = state.onPick;
      if (!row) { cancel(); return; }
      destroy();
      if (fn) { try { fn(row.item); } catch (e) { console.error(e); } }
    }
    function cancel() {
      var fn = state.onCancel;
      destroy();
      if (fn) { try { fn(); } catch (e) { console.error(e); } }
    }
    function destroy() {
      document.removeEventListener('keydown', onKey, true);
      if (placeRaf) cancelAnimationFrame(placeRaf);
      if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
      pickerEl = null; picked = null;
    }
    // Capture phase, so arrows and Enter belong to the picker while it is open
    // and every other keystroke still reaches the editor and keeps typing.
    function onKey(e) {
      if (picked !== state) return;
      // An empty result list leaves editing and navigation with the editor.
      if (!state.rows.length && e.key !== 'Escape') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); state.sel = (state.sel + 1) % Math.max(1, state.rows.length); draw(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); state.sel = (state.sel - 1 + state.rows.length) % Math.max(1, state.rows.length); draw(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    }

    filter(o.query || '');
    place(o.anchorRect);
    document.addEventListener('keydown', onKey, true);

    return {
      el: pickerEl,
      update: function (q, rect) { if (picked !== state) return; filter(q); place(rect || o.anchorRect); },
      close: function () { if (picked === state) destroy(); }
    };
  }

  function closePicker() {
    if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
    pickerEl = null; picked = null;
  }

  // ---------------------------------------------------------------------------
  // 7 · The global commands this module can execute itself
  // ---------------------------------------------------------------------------

  var PANELS = [
    { id: 'files', title: 'Files' },
    { id: 'outline', title: 'Outline' },
    { id: 'comments', title: 'Comments' },
    { id: 'changes', title: 'Changes' },
    { id: 'drafts', title: 'Drafts' },
    { id: 'workspace', title: 'Workspace' },
    { id: 'links', title: 'Links' },
    { id: 'live', title: 'Live' },
    { id: 'beside', title: 'Beside' }
  ];

  function hasPanels() { return !!(Castor.panels && Castor.panels.toggle); }
  /* Live and Drafts are words with nothing behind them until their module says
     it is ready (panels.js, UNTIL_READY); the palette keeps the same silence. */
  function panelReady(id) { return !(Castor.panels && Castor.panels.isReady) || Castor.panels.isReady(id); }
  function hasEditor() { return !!(Castor.editor && Castor.editor.getSource); }
  function hasSearchBox() { return !!(Castor.search && Castor.search.open && Castor.search.available()); }

  function togglePanel(id) {
    if (hasPanels()) Castor.panels.toggle(id);
  }

  function setTheme(mode) {
    if (Castor.app && Castor.app.setTheme) { Castor.app.setTheme(mode); return; }
    var root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }
  function setSize(size) {
    if (Castor.app && Castor.app.setSize) { Castor.app.setSize(size); return; }
    document.documentElement.setAttribute('data-size', size);
  }

  function registerGlobals() {
    register({ id: 'writing.check', title: 'Check paragraph', hint: 'local findings and optional revision questions', section: 'Writing',
      when: function () { return !!(Castor.checking && Castor.editor && (!Castor.pieces || Castor.pieces.current()) && !(Castor.editor.isReadOnly && Castor.editor.isReadOnly())); },
      run: function () { return Castor.checking.start(); } });
    [false, true].forEach(function (notes) {
      register({ id: notes ? 'article.copy.notes' : 'article.copy',
        title: notes ? 'Copy article with notes' : 'Copy article',
        hint: notes ? 'plain text, notes once at the end' : 'plain text for reading or listening', section: 'Article',
        when: function () { return hasEditor() && !!Castor.export && !(Castor.pieces && Castor.pieces.current && !Castor.pieces.current()); },
        run: function () { return Castor.export.copyArticle({ includeNotes: notes }); }
      });
    });
    /* The bar's lens (search.js) searches every article, its comments and these
       commands; without it, this piece's headings and passages. */
    register({
      id: 'go.search', title: 'Search everything', hint: 'articles, comments, commands', keys: '⌘K', section: 'Go to',
      when: function () { return hasSearchBox() || hasEditor(); },
      run: function () { if (hasSearchBox()) Castor.search.open(); else openSearch(); }
    });
    [['view.settings', 'Settings', 'castor-settings-gear', '⌘⌥,'],
      ['view.theme.cycle', 'Switch theme', 'theme-switch', '⌘⌥' + THEME_KEY]].forEach(function (item) {
      register({
        id: item[0], title: item[1], keys: item[3], section: 'View',
        when: function () { return !!document.getElementById(item[2]); },
        run: function () { document.getElementById(item[2]).click(); }
      });
    });
    PANELS.forEach(function (p) {
      register({
        id: 'panel.' + p.id,
        title: p.title + ' panel',
        hint: 'open or close',
        keys: p.keys,
        section: 'Panels',
        when: function () { return hasPanels() && panelReady(p.id); },
        listed: function () { return panelReady(p.id); },
        run: function () { togglePanel(p.id); }
      });
    });

    register({
      id: 'view.focus', title: 'Zen', hint: 'the page alone', section: 'View',
      when: function () { return !!(Castor.panels && Castor.panels.focus); },
      run: function () {
        var on = !Castor.panels.isFocus();
        document.documentElement.setAttribute('data-focus', on ? 'on' : 'off');
        if (Castor.panels && Castor.panels.focus) Castor.panels.focus(on);
      }
    });
    register({
      id: 'view.lastpanel', title: 'Last panel', hint: 'show or hide it again', section: 'View',
      when: hasPanels,
      run: function () {
        if (Castor.panels.toggleLast) Castor.panels.toggleLast();
        else togglePanel(lastPanelId || 'outline');
      }
    });
    ['light', 'dark', 'system'].forEach(function (mode) {
      register({
        id: 'view.theme.' + mode, title: 'Theme ' + mode, section: 'View',
        run: function () { setTheme(mode); }
      });
    });
    [['computer', 'Computer'], ['ipad', 'iPad'], ['phone', 'Phone']].forEach(function (s) {
      register({
        id: 'view.size.' + s[0], title: 'Size ' + s[1], hint: 'frame the app', section: 'View',
        run: function () { setSize(s[0]); }
      });
    });
    register({
      id: 'view.writernotes', title: 'Writer notes', hint: 'show or hide the %% notes', section: 'View',
      when: function () { return !!(Castor.app && Castor.app.setWriterNotes); },
      run: function () { Castor.app.setWriterNotes(); }
    });
    register({
      id: 'view.review', title: 'Review mode', hint: 'pin a note on anything', section: 'View',
      when: function () { return !!(Castor.review && Castor.review.toggle); },
      run: function () { Castor.review.toggle(); }
    });
    // Two ways to write, both off unless a world asks for them. The token IS
    // the switch, so a theme turns either on with one line and no script; the
    // palette entry sets the same token on the page and so wins over the theme.
    register({
      id: 'view.focusparagraph', title: 'Dim other paragraphs', hint: 'independent of Zen; in Settings, Focus', section: 'View',
      when: hasEditor,
      run: function () {
        if (Castor.app && Castor.app.setDim) Castor.app.setDim();
        else Castor.editor.setWritingMode('--focus-paragraph');
      }
    });
    register({
      id: 'view.typewriter', title: 'Typewriter line', hint: 'hold the line you write on still', section: 'View',
      when: hasEditor, run: function () { Castor.editor.setWritingMode('--typewriter'); }
    });
    register({
      id: 'view.trail', title: 'Fade what I have written', hint: 'the words behind the caret recede', section: 'View',
      when: hasEditor, run: function () { Castor.editor.setWritingMode('--trail'); }
    });

    [
      { id: 'bold', title: 'Bold', hint: '**like this**', keys: '⌘B' },
      { id: 'italic', title: 'Italic', hint: '*like this*', keys: '⌘I' },
      { id: 'highlight', title: 'Highlight', hint: '==like this==', keys: '⌘⇧M' },
      { id: 'code', title: 'Code', hint: '`like this`', keys: '⌘E' },
      { id: 'strike', title: 'Strikethrough', hint: '~~like this~~', keys: '⌘⇧X' }
    ].forEach(function (m) {
      register({
        id: 'edit.' + m.id, title: m.title, hint: m.hint, keys: m.keys, section: 'Writing',
        // `when` is hasEditor, never editor.can(): while the palette is open the
        // selection lives in ITS input, so can() reads no caret and every one of
        // these would be filtered out of the list that is meant to offer them.
        // close() restores the writer's caret before run() fires.
        when: hasEditor,
        run: function () { Castor.editor.command(m.id); }
      });
    });
    register({
      id: 'edit.undo', title: 'Undo', keys: '⌘Z', section: 'Writing',
      when: hasEditor, run: function () { Castor.editor.undo(); }
    });
    register({
      id: 'edit.redo', title: 'Redo', keys: '⌘⇧Z', section: 'Writing',
      when: hasEditor, run: function () { Castor.editor.redo(); }
    });
    register({
      id: 'edit.comment', title: 'Comment on selection', section: 'Writing',
      when: function () { return hasEditor() && !(Castor.comments && Castor.comments.available && !Castor.comments.available()); },
      run: function () {
        var a = Castor.editor.getSelectionAnchor && Castor.editor.getSelectionAnchor();
        if (!a) return;
        if (Castor.editor.hideSelectionMenu) Castor.editor.hideSelectionMenu();
        if (Castor.comments && Castor.comments.compose) Castor.comments.compose(a);
        else if (Castor.bus) Castor.bus.emit('comment:new', a);
      }
    });
    ['footnote', 'link'].forEach(function (id) {
      register({ id: 'edit.' + id, title: id === 'link' ? 'Link' : 'Footnote', section: 'Writing',
        when: function () { return hasEditor() && !!Castor.editor.command && !(Castor.editor.isReadOnly && Castor.editor.isReadOnly()); },
        run: function () { Castor.editor.command(id); } });
    });
    register({ id: 'edit.date', title: 'Insert date', section: 'Writing',
      when: function () { return hasEditor() && !!Castor.editor.insertMarkdown && !(Castor.editor.isReadOnly && Castor.editor.isReadOnly()); },
      run: function () {
        var d = new Date();
        Castor.editor.insertMarkdown(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
      } });
    register({ id: 'edit.comment.paragraph', title: 'Comment on this paragraph', section: 'Writing',
      when: function () { return hasEditor() && !!Castor.editor.focusedBlockId && !!Castor.editor.getBlocks &&
        !!(Castor.comments && Castor.comments.compose) && !(Castor.comments.available && !Castor.comments.available()); },
      run: function () {
        var id = Castor.editor.focusedBlockId();
        var blocks = Castor.editor.getBlocks(), at = blocks.map(function (b) { return b.id; }).indexOf(id);
        var b = blocks[at];
        // A slash occupies an empty line: after removing it, comment on the preceding paragraph.
        while (b && (!b.source.trim() || b.type === 'frontmatter')) b = blocks[--at];
        if (!b) return;
        Castor.comments.compose({ blockId: b.id, quote: b.source, blockText: b.source });
      } });
    register({ id: 'go.article', title: 'Open another article', section: 'Go to',
      when: function () { return !!(Castor.pieces && Castor.pieces.list && Castor.pieces.open); },
      run: function () {
        openList({ title: 'Open another article', items: Castor.pieces.list().map(function (p) { return { id: p.path, label: p.title }; }),
          onPick: function (p) { Castor.pieces.open(p.id); } });
      } });
    register({ id: 'article.publish-state', title: 'Publish state', hint: 'read the published version status', section: 'Article',
      when: function () { return !!document.querySelector('.descant-live-marker'); },
      run: function () { document.querySelector('.descant-live-marker').click(); } });
    register({
      id: 'go.heading', title: 'Go to heading', hint: 'anywhere in the piece', section: 'Go to',
      when: function () { return !!(Castor.editor && Castor.editor.getDoc); },
      run: function () {
        var doc = Castor.editor.getDoc() || {};
        var items = (doc.headings || []).map(function (h) {
          return { id: h.id, label: h.text, detail: 'H' + h.level, blockId: h.blockId };
        });
        if (!items.length) return;
        openList({
          title: 'Go to heading', items: items,
          onPick: function (i) { Castor.editor.scrollToBlock(i.blockId); }
        });
      }
    });
    register({
      id: 'changes.since', title: 'Show changes since', hint: 'pick a moment', section: 'Writing',
      when: function () { return !!(Castor.changes && Castor.changes.since); },
      run: function () {
        var items = [
          { id: 'read', label: 'since you last read' },
          { id: 'yesterday', label: 'since yesterday' },
          { id: 'first', label: 'since the first draft' }
        ];
        ((data().versions) || []).forEach(function (v) {
          items.push({ id: v.id, label: 'since ' + (v.label || v.id), detail: v.when || '' });
        });
        openList({ title: 'Show changes since', items: items, onPick: function (i) { Castor.changes.since(i.id); } });
      }
    });
    register({
      id: 'canvas.export', title: 'Export the workspace', hint: 'JSON Canvas', section: 'Writing',
      when: function () { return !!(Castor.canvas && Castor.canvas.exportJson); },
      run: function () { Castor.canvas.exportJson(); }
    });
    register({id:'share.article', title:'Share this article', hint:'comment link and who has access', section:'Sharing',
      when:function () { return !!document.querySelector('.descant-share'); },
      run:function () { if (Castor.share) Castor.share.open(); }
    });
    register({
      id: 'share.people', title: 'People and sharing', hint: 'who outside can read what', section: 'Sharing',
      when: function () {
        var p = (global.location && global.location.protocol) || '';
        var install = Castor.app && Castor.app.data && Castor.app.data.install;
        if (install && install.kind === 'personal') return false;
        return !!global.fetch && (p === 'http:' || p === 'https:');
      },
      run: openSharing
    });
    register({
      id: 'help.keys', title: 'Keyboard map', hint: 'every shortcut', section: 'Help',
      run: function () {
        openList({
          title: 'Keyboard map', keyboardMap: true,
          items: keyboardMap(),
          onPick: function () {} // A reference: Enter must never run a destructive shortcut.
        });
      }
    });
  }

  /* People and sharing: Descant's dashboard, where a founder shares an article with someone
     outside by name. The server asks Descant for a one-time link (POST /api/share/admin-link,
     the founders' listener only) and the page opens it. The tab is opened first, inside the
     keypress or click, because a browser blocks a window opened after a network wait; it is
     cut off from this page before it is sent anywhere. A reader's palette never lists this
     (app.js limits it to reading commands). */
  function openSharing() {
    var who = (Castor.who && Castor.who.get) ? Castor.who.get() : '';
    if (!who) {
      if (Castor.who && Castor.who.ask) Castor.who.ask();
      tellSharing('Say who you are first, then choose People and sharing again.');
      return;
    }
    var tab = null;
    try { tab = global.open('', '_blank'); } catch (e) { tab = null; }
    if (tab) { try { tab.opener = null; } catch (e) { /* already cut off */ } }
    global.fetch('/api/share/admin-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: who })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok || !body || typeof body.url !== 'string') {
          throw new Error((body && body.error) || 'The server could not make the link.');
        }
        return body.url;
      });
    }).then(function (url) {
      if (tab) tab.location.replace(url);
      else global.open(url, '_blank', 'noopener');
    }).catch(function (err) {
      if (tab) { try { tab.close(); } catch (e) { /* the browser closed it */ } }
      tellSharing(String((err && err.message) || err));
    });
  }
  function tellSharing(text) {
    openList({ title: 'People and sharing', items: [{ id: 'share.note', label: text }], onPick: function () {} });
  }

  // ---------------------------------------------------------------------------
  // 8 · The keyboard map
  // ---------------------------------------------------------------------------

  var lastPanelId = null;
  if (Castor.bus && Castor.bus.on) {
    Castor.bus.on('panel:open', function (p) { lastPanelId = (p && p.id) || p; });
  }

  // Aliases still accepted by the dispatcher. Keep their labels in the same
  // table as their dispatch, so help cannot silently forget legacy chords.
  var LEGACY_PANELS = { c: 'comments', o: 'outline', h: 'changes', w: 'workspace', l: 'live', f: 'files' };
  var LEGACY_KEYS = { 'view.focus': ['⌘.'], 'view.lastpanel': ['⌘\\', '⌘⇧\\'], 'view.review': ['⌘⇧R'] };

  function keyboardMap() {
    var out = [];
    function add(section, label, chord, command) {
      out.push({ id: 'key:' + out.length, section: section, label: label,
        keys: keyLabel(chord), command: command || null });
    }
    registry.forEach(function (c) {
      if (!allowed(c) || (!listed(c) && c.id !== 'help.next')) return;
      if (c.keys) add(c.section, c.title, c.keys, c.id);
      (LEGACY_KEYS[c.id] || []).forEach(function (chord) { add(c.section, c.title + ' (also)', chord, c.id); });
      Object.keys(LEGACY_PANELS).forEach(function (k) {
        if (c.id === 'panel.' + LEGACY_PANELS[k]) add(c.section, c.title + ' (also)', '⌘⇧' + k.toUpperCase(), c.id);
      });
    });
    var chord = keys.tabChord();
    chord.chords.forEach(function (m) {
      add('Article tabs', 'Open article or numbered panel 1-9',
        (m.meta ? '⌘' : '') + (m.ctrl ? '⌃' : '') + (m.alt ? '⌥' : '') + (m.shift ? '⇧' : '') + '1-9');
    });
    [
      ['Article tabs', 'Close the focused article tab', 'Backspace / Delete'],
      ['Writing', 'Save now', '⌘S'],
      ['Writing', 'New paragraph / line break', 'Enter / ⇧Enter'],
      ['Writing', 'Indent / outdent a list item', 'Tab / ⇧Tab'],
      ['Writing', 'Move or extend the selection', '← ↑ → ↓ / ⇧← ⇧↑ ⇧→ ⇧↓'],
      ['Writing', 'Start or end of line (Mac)', '⌘← / ⌘→'],
      ['Writing', 'Leave the paragraph', 'Escape'],
      ['Slash menu', 'Open block commands at paragraph start', '/'],
      ['Writing pickers', 'People, articles, footnotes', '@ / [[ / [^'],
      ['Menus and search', 'Previous / next item', '↑ / ↓'],
      ['Menus and search', 'Choose item / close', 'Enter / Escape'],
      ['Writing pickers', 'Choose item', 'Enter / Tab'],
      ['Settings tabs', 'Previous / next tab', '← / →'],
      ['Settings tabs', 'First / last tab', 'Home / End'],
      ['Reading font', 'Choose previous / next font', '← ↑ / → ↓'],
      ['Reading font', 'First / last font', 'Home / End'],
      ['Panel headings', 'Move panel up / down / left / right', '⌥↑ / ⌥↓ / ⌥← / ⌥→'],
      ['Panel width', 'Resize at the panel edge; Shift for larger steps', '← / → / ⇧← / ⇧→'],
      ['Panel height', 'Resize between panels', '↑ / ↓'],
      ['Split view divider', 'Resize the two pages', '← / →'],
      ['Files and outline', 'Previous / next / first / last row', '↑ / ↓ / Home / End'],
      ['Files and outline', 'Expand / collapse / open', '→ / ← / Enter / Space'],
      ['Workspace cards', 'Open context menu', '⇧F10 / ContextMenu'],
      ['Workspace cards', 'Remove selected cards', 'Backspace / Delete'],
      ['Workspace cards', 'Undo last canvas action', '⌘Z / ⌘⇧Z'],
      ['Workspace cards', 'Cancel, leave editing or clear selection', 'Escape'],
      ['Context menus', 'First / last item', 'Home / End'],
      ['Comment composer', 'Send / insert a line break', 'Enter / ⇧Enter'],
      ['Comment composer', 'Close composer or mention list', 'Escape'],
      ['Comment mentions', 'Choose person / accept', '↑ / ↓ / Enter / Tab'],
      ['Publish tags', 'Choose suggestion', '↑ / ↓'],
      ['Publish tags', 'Add tag', 'Enter / Tab / ,'],
      ['Publish tags', 'Remove last tag when the field is empty', 'Backspace'],
      ['Publish tags', 'Close suggestions', 'Escape'],
      ['Title and subtitle', 'Finish editing / cancel subtitle edit', 'Enter / Escape'],
      ['Footnotes', 'Finish editing / insert a line break', 'Enter / Escape / ⇧Enter'],
      ['Walkthrough', 'Close the walkthrough', 'Escape'],
      ['Dialogs and menus', 'Next / previous control', 'Tab / ⇧Tab'],
      ['Dialogs and menus', 'Close the topmost menu, sheet or Zen', 'Escape']
    ].forEach(function (r) {
      if (r[1].indexOf('(Mac)') >= 0 && keys.os() !== 'mac') return;
      if (limiter && /^(Writing|Slash|Workspace|Publish|Comment composer|Title|Footnotes|Walkthrough)/.test(r[0])) return;
      add(r[0], r[1], r[2]);
    });
    return out.sort(function (a, b) { return a.section.localeCompare(b.section); });
  }

  function codeOf(e) {
    if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
    return '';
  }

  function onGlobalKey(e) {
    if (e.defaultPrevented) return;
    if (keys.composing(e) || (e.getModifierState && e.getModifierState('AltGraph'))) return;
    var mod = IS_MAC ? e.metaKey : e.ctrlKey;

    if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (isOpen) { close(); e.preventDefault(); return; }
      if (picked) { closePicker(); e.preventDefault(); return; }
      if (Castor.editor && Castor.editor.hideSelectionMenu) Castor.editor.hideSelectionMenu();
      if (document.documentElement.getAttribute('data-focus') === 'on') {
        document.documentElement.setAttribute('data-focus', 'off');
        if (Castor.panels && Castor.panels.focus) Castor.panels.focus(false);
        e.preventDefault();
      }
      return;
    }
    if (!mod) return;
    if (isOpen) return;                       // the palette owns its own keys

    var k = codeOf(e);

    if (e.altKey) {
      if (e.shiftKey || e.repeat || (IS_MAC ? e.ctrlKey : e.metaKey)) return;
      var action = Object.keys(APP_KEYS).filter(function (id) { return APP_KEYS[id] === e.code; })[0];
      if (action && run(action)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }

    if (k === 'k' && !e.shiftKey) {
      e.preventDefault();
      if (hasSearchBox()) Castor.search.open(); else open();
      return;
    }
    if (e.code === 'Period' && !e.shiftKey) { e.preventDefault(); run('view.focus'); return; }
    if (e.code === 'Backslash') { e.preventDefault(); run('view.lastpanel'); return; }

    if (k === 'z') { e.preventDefault(); run(e.shiftKey ? 'edit.redo' : 'edit.undo'); return; }

    if (e.shiftKey) {
      var map = LEGACY_PANELS;
      if (map[k]) { e.preventDefault(); run('panel.' + map[k]); return; }
      /* Command Shift R belongs to review.js alone: it is the only handler that
         can DISMISS the island and clear the persistent flag. Binding it here too
         re-opened the island in the same keystroke, so the founder could summon
         the review tools and never put them away. The palette entry stays. */
    }
  }

  function run(id) {
    var c = byId[id];
    if (!c) return false;
    if (!available(c)) return false;
    try { c.run(); } catch (e) { console.error(e); }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 9 · Public API
  // ---------------------------------------------------------------------------

  /* Resolve at hover time, so re-registering a command updates every control. */
  function controlTooltip(control) {
    var ids = { 'castor-settings-gear': 'view.settings', 'theme-switch': 'view.theme.cycle',
      'set-focus': 'view.focus', 'set-dim': 'view.focusparagraph' };
    var data = control.dataset || {};
    var id = ids[control.id] || (data.panel ? 'panel.' + data.panel : data.command ? 'edit.' + data.command : '');
    if (control.matches('.find-lens')) id = 'go.search';
    if (control.matches('.focus-exit')) id = 'view.focus';
    if (control.matches('.castor-tab-close')) id = 'tabs.close';
    if (control.matches('.castor-tab')) {
      var index = Array.prototype.indexOf.call(document.querySelectorAll('#castor-tabs .castor-tab'), control);
      if (index < 0 || index > 8) return '';
      var chord = keys.tabChord().aria.replace(/Meta\+/g, '⌘').replace(/Control\+/g, '⌃').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
      var name = control.querySelector('.castor-tab-name');
      return (name ? name.textContent : 'Article') + ' (' + keyLabel(chord + (index + 1)) + ')';
    }
    var command = byId[id];
    if (!command) return '';
    return command.title + (command.keys ? ' (' + keyLabel(command.keys) + ')' : '');
  }

  function wireControlTooltips() {
    var tip, active, oldTitle, oldDescription, timer;
    function hide() {
      clearTimeout(timer);
      if (active) {
        if (oldTitle !== null) active.setAttribute('title', oldTitle);
        if (oldDescription) active.setAttribute('aria-describedby', oldDescription);
        else active.removeAttribute('aria-describedby');
      }
      active = null;
      if (!tip) return;
      if (tip.hidePopover) tip.hidePopover();
      tip.hidden = true;
    }
    function show(e) {
      var control = e.target.closest && e.target.closest('button,input,[data-command]');
      if (!control || control === active) return;
      hide();
      var text = controlTooltip(control);
      if (!text) return;
      if (!tip) {
        tip = document.createElement('div'); tip.id = 'castor-control-tip'; tip.className = 'control-tip';
        tip.setAttribute('role', 'tooltip'); tip.setAttribute('popover', 'manual'); document.body.appendChild(tip);
      }
      active = control; oldTitle = control.getAttribute('title'); oldDescription = control.getAttribute('aria-describedby');
      control.removeAttribute('title');
      control.setAttribute('aria-describedby', (oldDescription ? oldDescription + ' ' : '') + tip.id);
      tip.textContent = text;
      timer = setTimeout(function () {
        if (active !== control) return;
        tip.hidden = false;
        if (tip.showPopover) tip.showPopover();
        var box = control.getBoundingClientRect(), bounds = tip.getBoundingClientRect();
        tip.style.left = Math.max(8, Math.min(global.innerWidth - bounds.width - 8, box.left + box.width / 2 - bounds.width / 2)) + 'px';
        tip.style.top = (box.bottom + bounds.height + 12 > global.innerHeight ? Math.max(8, box.top - bounds.height - 6) : box.bottom + 6) + 'px';
      }, e.type === 'focusin' ? 0 : 400);
    }
    document.addEventListener('pointerover', show);
    document.addEventListener('focusin', show);
    ['pointerout', 'focusout'].forEach(function (name) {
      document.addEventListener(name, function (e) { if (active && !active.contains(e.relatedTarget)) hide(); });
    });
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', hide);
    document.addEventListener('scroll', hide, true);
  }

  /* The commands the search box lists for a query: ranked as the palette ranks
     them, only those this page offers, each with whether it can run now. */
  function matching(q, limit) {
    var found = rank(String(q || '').trim(), registry.filter(listed), function (c) {
      return c.title + ' ' + c.section + ' ' + c.id;
    });
    return found.slice(0, limit || 12).map(function (c) {
      return { id: c.id, title: c.title, section: c.section, hint: c.hint, keys: keyLabel(c.keys), available: available(c) };
    });
  }

  function hintCommand(control, id) {
    var command = byId[id];
    if (!command || !command.keys) return;
    var aria = keys.format(command.keys, 'mac').map(function (key) {
      return { '⌘': 'MOD', '⇧': 'Shift', '⌥': 'Alt', '⌃': 'Control' }[key] || key;
    }).join('+');
    keys.hint(control, command.keys, aria);
  }

  var mounted = false;
  var commands = {
    mount: function () {
      if (Castor.share && Castor.share.mount) Castor.share.mount();
      injectBase();
      keys.wire();
      if (!mounted) {
        registerGlobals();
        wireControlTooltips();
        [['castor-settings-gear', '⌘⌥,', 'MOD+Alt+,'],
          ['theme-switch', '⌘⌥' + THEME_KEY, 'MOD+Alt+' + THEME_KEY]].forEach(function (item) {
          var control = document.getElementById(item[0]);
          keys.hint(control, item[1], item[2]);
          if (control) control.setAttribute('title', (item[0] === 'theme-switch' ? 'Switch theme' : 'Settings') + ' (' + keys.text(item[1]) + ')');
        });
        keys.hint(document.querySelector('.find-lens'), '⌘K', 'MOD+K');
        PANELS.forEach(function (panel) {
          hintCommand(document.querySelector('#topbar [data-panel="' + panel.id + '"]'), 'panel.' + panel.id);
        });
        document.addEventListener('keydown', function (e) { if (e.altKey) onGlobalKey(e); }, true);
        document.addEventListener('keydown', onGlobalKey);
        mounted = true;
      }
      return commands;
    },
    register: register,
    unregister: unregister,
    all: all,
    run: run,
    matching: matching,
    limit: function (fn) { limiter = typeof fn === 'function' ? fn : null; return commands; },
    open: open,
    openList: openList,
    close: close,
    isOpen: function () { return isOpen; },
    picker: picker,
    closePicker: closePicker,
    keyLabel: keyLabel,
    hint: hintCommand,
    keys: keys,
    keyboardMap: keyboardMap,
    isMac: IS_MAC
  };

  Castor.commands = commands;
  if (typeof module !== 'undefined' && module.exports) module.exports = commands;
})(typeof window !== 'undefined' ? window : globalThis);
