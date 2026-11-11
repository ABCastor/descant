(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});

  // ---------------------------------------------------------------------------
  // 1 · The faces. `probe` is the family we ask the browser about; `note` is the
  //     honest sentence shown in the list when a face may not be present.
  // ---------------------------------------------------------------------------

  var FACES = [
    { id: 'source-serif-4', label: 'Source Serif 4', kind: 'serif', probe: 'Source Serif 4',
      stack: "'Source Serif 4', Georgia, 'Times New Roman', serif", note: 'the Castor reading face' },
    { id: 'commissioner', label: 'Commissioner', kind: 'sans', probe: 'Commissioner',
      stack: "Commissioner, system-ui, -apple-system, sans-serif", note: 'the Castor interface face' },
    { id: 'martian-mono', label: 'Martian Mono', kind: 'mono', probe: 'Martian Mono',
      stack: "'Martian Mono', ui-monospace, SFMono-Regular, Menlo, monospace", note: 'the Castor measuring face' },
    { id: 'eb-garamond', label: 'EB Garamond', kind: 'serif', probe: 'EB Garamond',
      stack: "'EB Garamond', Garamond, 'Times New Roman', serif" },
    { id: 'literata', label: 'Literata', kind: 'serif', probe: 'Literata',
      stack: "Literata, Word, Georgia, 'Times New Roman', serif", aliases: ['Word'] },
    { id: 'libre-caslon', label: 'Libre Caslon', kind: 'serif', probe: 'Libre Caslon Text',
      stack: "'Libre Caslon Text', 'Libre Caslon Display', Georgia, serif" },
    { id: 'new-york', label: 'New York', kind: 'serif', probe: 'New York',
      stack: "'New York', ui-serif, Georgia, serif", note: 'device font' },
    { id: 'iowan', label: 'Iowan Old Style', kind: 'serif', probe: 'Iowan Old Style',
      stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif", note: 'when installed on this device' },
    { id: 'hanken', label: 'Hanken Grotesk', kind: 'sans', probe: 'Hanken Grotesk',
      stack: "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif" },
    { id: 'libre-franklin', label: 'Libre Franklin', kind: 'sans', probe: 'Libre Franklin',
      stack: "'Libre Franklin', 'Helvetica Neue', Arial, sans-serif" },
    { id: 'jost', label: 'Jost', kind: 'sans', probe: 'Jost',
      stack: "Jost, Futura, 'Avenir Next', sans-serif" },
    { id: 'futura', label: 'Futura', kind: 'sans', probe: 'Futura',
      stack: "Futura, Jost, 'Avenir Next', sans-serif",
      note: 'device font' },
    { id: 'neue-haas', label: 'Neue Haas Grotesk', kind: 'sans', probe: 'Neue Haas Grotesk Text Pro',
      stack: "'Neue Haas Grotesk Text Pro', 'Neue Haas Grotesk', 'Helvetica Neue', Helvetica, sans-serif",
      aliases: ['Neue Haas Grotesk'], note: 'device font' },
    { id: 'sf', label: 'San Francisco', kind: 'sans', probe: '-apple-system',
      stack: "-apple-system, system-ui, 'Helvetica Neue', sans-serif", note: 'the system face' }
  ];

  // The founder's reading list takes precedence over generic design exclusions.
  FACES.push({ id: 'ibm-plex', label: 'IBM Plex Sans', kind: 'sans', probe: 'IBM Plex Sans',
    stack: "'IBM Plex Sans', Arial, sans-serif" });
  var READING_ORDER = ['eb-garamond', 'literata', 'libre-caslon', 'new-york', 'ibm-plex',
    'hanken', 'libre-franklin', 'jost', 'futura', 'neue-haas', 'sf'];
  FACES.sort(function (a, b) {
    function index(f) { var i = READING_ORDER.indexOf(f.id); return i < 0 ? READING_ORDER.length : i; }
    return index(a) - index(b);
  });

  var RETIRED_FACES = [
    { id: 'inter', label: 'Inter', reason: 'One maintainer, 21 months without a commit, and present in nearly every AI company stylesheet.' },
    { id: 'space-grotesk', label: 'Space Grotesk', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'instrument-serif', label: 'Instrument Serif', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'fraunces', label: 'Fraunces', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'bricolage-grotesque', label: 'Bricolage Grotesque', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'sora', label: 'Sora', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'young-serif', label: 'Young Serif', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'bodoni', label: 'Bodoni', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' },
    { id: 'syne', label: 'Syne', reason: 'Ruled out by the 1,590-page interface scan as machine-checkable slop.' }
  ];

  var SIZES = [
    { id: 'xs', label: 'Smaller', value: '16px' },
    { id: 's', label: 'Small', value: '17px' },
    { id: 'm', label: 'Default', value: '18.5px' },
    { id: 'l', label: 'Large', value: '20px' },
    { id: 'xl', label: 'Larger', value: '22px' }
  ];

  // Six restrained ramps, H1 strongest. Each carries a dark-paper twin: a ramp
  // built for white paper disappears on a dark one, and a colour choice that
  // only works in one theme is not a colour choice. A world overrides the whole
  // set through Castor.app.data.headingPresets or window.CASTOR_HEADING_PRESETS;
  // a world preset without `dark` simply uses its one ramp in both.
  var DEFAULT_PRESETS = [
    { id: 'ink', label: 'Ink', colors: ['#1a1a1c', '#34343c', '#4c4c56', '#63636e'],
      dark: ['#f0ede7', '#d3cfc7', '#b3aea5', '#948f86'] },
    { id: 'slate', label: 'Slate', colors: ['#26333f', '#33475a', '#446079', '#587a96'],
      dark: ['#cfe0ef', '#a9c4db', '#87a8c4', '#6b8dab'] },
    { id: 'rust', label: 'Rust', colors: ['#6b2f1f', '#8a4326', '#a55c34', '#bd7b4f'],
      dark: ['#f0b491', '#dd9a76', '#c68260', '#ad6c4d'] },
    { id: 'moss', label: 'Moss', colors: ['#2b4030', '#3b5942', '#4e7355', '#669070'],
      dark: ['#bcd9c2', '#9dbfa5', '#82a58a', '#6a8b72'] },
    { id: 'plum', label: 'Plum', colors: ['#3d2540', '#563457', '#6f4671', '#8b5d8c'],
      dark: ['#e0c2e2', '#c4a2c7', '#a886ac', '#8e6d92'] },
    { id: 'sea', label: 'Sea', colors: ['#12414a', '#1b5b66', '#277884', '#3a95a2'],
      dark: ['#a8dbe4', '#87c1cc', '#69a6b2', '#528c98'] }
  ];

  // Which paper are we on: an explicit data-theme wins, otherwise the device.
  function isDark() {
    if (typeof document === 'undefined') return false;
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function presets() {
    var d = (Castor.app && Castor.app.data && Castor.app.data.headingPresets) || global.CASTOR_HEADING_PRESETS;
    return (d && d.length) ? d : DEFAULT_PRESETS;
  }
  function faceById(id) { for (var i = 0; i < FACES.length; i++) if (FACES[i].id === id) return FACES[i]; return null; }
  function sizeById(id) { for (var i = 0; i < SIZES.length; i++) if (SIZES[i].id === id) return SIZES[i]; return SIZES[2]; }
  function presetById(id) { var p = presets(); for (var i = 0; i < p.length; i++) if (p[i].id === id) return p[i]; return p[0]; }

  // ---------------------------------------------------------------------------
  // 2 · Availability. FontFaceSet.check returns true for nonexistent families,
  //     too. Compare actual glyph widths against several generic fallbacks.
  //     Ask again after webfonts load; Literata ships locally under `Word`.
  // ---------------------------------------------------------------------------

  var availability = {};
  function checkAll() {
    if (typeof document === 'undefined') return;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext && canvas.getContext('2d');
    FACES.forEach(function (f) {
      if (f.id === 'sf') {
        availability[f.id] = /Mac|iPhone|iPad|iPod/.test((global.navigator &&
          (global.navigator.platform || global.navigator.userAgent)) || '');
        return;
      }
      availability[f.id] = !!ctx && [f.probe].concat(f.aliases || []).some(function (family) {
        return ['monospace', 'serif', 'sans-serif'].some(function (fallback) {
          ctx.font = '32px ' + fallback;
          var base = ctx.measureText('mmmmWWWWiiii0123456789').width;
          ctx.font = '32px "' + family + '", ' + fallback;
          return ctx.measureText('mmmmWWWWiiii0123456789').width !== base;
        });
      });
    });
  }
  function statusOf(f) {
    var known = availability[f.id];
    if (known !== true) return 'Not on this device';
    return f.note || '';
  }


  var VAR = {
    reading: '--font-reading',
    interface: '--font-ui',
    heading: '--font-heading',
    size: '--reading-size'
  };
  var HVARS = ['--level-1', '--level-2', '--level-3', '--level-4', '--level-5', '--level-6'];

  function blank() {
    return { reading: null, interface: null, heading: null, size: null, preset: null, custom: null, marks: null };
  }

  var chosen = blank();
  var previous = null;
  function remember() { previous = JSON.parse(JSON.stringify(chosen)); }
  var world = null;        // {reading, interface, heading, size, colors[]} from the cascade
  var worldMarks = null;   // the shell's own data-heading-marks, restored on reset

  function worldName() {
    return (Castor.app && Castor.app.world) || global.CASTOR_WORLD ||
      (typeof document !== 'undefined' && document.documentElement.getAttribute('data-world')) || 'dev';
  }
  function storeKey() { return 'castor.' + worldName() + '.type'; }

  // Read the world's own tokens BEFORE anything of ours is written.
  function readWorld() {
    if (typeof document === 'undefined' || !global.getComputedStyle) {
      return { reading: '', interface: '', heading: '', size: '', colors: ['', '', '', ''] };
    }
    var cs = global.getComputedStyle(document.documentElement);
    function g(n) { return (cs.getPropertyValue(n) || '').trim(); }
    return {
      reading: g(VAR.reading), interface: g(VAR.interface), heading: g(VAR.heading),
      size: g(VAR.size),
      colors: HVARS.map(g)
    };
  }

  function load() {
    var got = blank();
    try {
      var raw = global.localStorage && global.localStorage.getItem(storeKey());
      if (raw) {
        var stored = JSON.parse(raw);
        for (var k in got) if (stored[k] != null) got[k] = stored[k];
      }
    } catch (e) { /* a locked or private store is not an error worth showing */ }
    return got;
  }

  function save() {
    try {
      var out = {}, any = false;
      for (var k in chosen) if (chosen[k] != null) { out[k] = chosen[k]; any = true; }
      if (any) global.localStorage.setItem(storeKey(), JSON.stringify(out));
      else global.localStorage.removeItem(storeKey());
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // 4 · Apply: write an override, or clear one
  // ---------------------------------------------------------------------------

  function setOrClear(style, name, value) {
    if (value == null || value === '') style.removeProperty(name);
    else style.setProperty(name, value);
  }

  // The colours the writer picked, or null when the world's still stand.
  function chosenColors() {
    if (chosen.custom) return [chosen.custom.h1, chosen.custom.h2, chosen.custom.h3, chosen.custom.h4];
    if (!chosen.preset) return null;
    var p = presetById(chosen.preset);
    return (isDark() && p.dark && p.dark.length) ? p.dark : p.colors;
  }
  // What is actually on the page right now, for the swatches and the labels.
  function effectiveColors() {
    var c = chosenColors();
    if (c) return c;
    var w = (world && world.colors) || [];
    if (w.some(function (v) { return !!v; })) return w;
    return DEFAULT_PRESETS[0][isDark() ? 'dark' : 'colors'];
  }

  function apply() {
    if (typeof document === 'undefined') return;
    var root = document.documentElement, s = root.style;

    ['reading', 'interface', 'heading'].forEach(function (slot) {
      var f = chosen[slot] && faceById(chosen[slot]);
      setOrClear(s, VAR[slot], f ? f.stack : null);
    });
    setOrClear(s, VAR.size, chosen.size ? sizeById(chosen.size).value : null);

    var c = chosenColors();
    HVARS.forEach(function (name, i) { setOrClear(s, name, c ? (c[i] || c[c.length - 1]) : null); });

    if (chosen.marks) root.setAttribute('data-heading-marks', chosen.marks);
    else if (worldMarks != null) root.setAttribute('data-heading-marks', worldMarks);
    else root.removeAttribute('data-heading-marks');

    refreshReadingPicker();
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('type:change', get());
  }

  function set(slot, value) {
    if (!(slot in chosen)) return false;
    var next = (value === '' || value == null) ? null : value;
    if (chosen[slot] === next && !(slot === 'preset' && chosen.custom)) return true;
    remember();
    chosen[slot] = next;   // '' means back to the world's
    if (slot === 'preset') chosen.custom = null;
    save(); apply(); refreshPanel();
    return true;
  }
  function setCustom(level, hex) {
    remember();
    var c = effectiveColors();
    chosen.custom = chosen.custom || { h1: toHex(c[0]), h2: toHex(c[1]), h3: toHex(c[2]), h4: toHex(c[3]) };
    chosen.custom['h' + level] = hex;
    save(); apply(); refreshPanel();
  }

  function reset() {
    remember();
    chosen = blank();
    if (typeof document !== 'undefined') {
      var s = document.documentElement.style;
      ['reading', 'interface', 'heading', 'size'].forEach(function (k) { s.removeProperty(VAR[k]); });
      HVARS.forEach(function (n) { s.removeProperty(n); });
    }
    save(); apply(); refreshPanel();
  }

  function restorePrevious() {
    if (!previous) return false;
    chosen = previous;
    previous = null;
    save(); apply(); refreshPanel();
    return true;
  }

  // The first family in a stack, unquoted, so a world's token can be shown as a
  // name and matched against the faces we know.
  function firstFamily(stack) {
    var first = String(stack || '').split(',')[0].trim();
    return first.replace(/^['"]|['"]$/g, '');
  }
  function matchFace(stack) {
    var fam = firstFamily(stack).toLowerCase();
    if (!fam) return null;
    for (var i = 0; i < FACES.length; i++) {
      if (firstFamily(FACES[i].stack).toLowerCase() === fam) return FACES[i];
      if (FACES[i].probe.toLowerCase() === fam) return FACES[i];
      if ((FACES[i].aliases || []).some(function (alias) { return alias.toLowerCase() === fam; })) return FACES[i];
    }
    return null;
  }
  function toHex(v) {
    var s = String(v || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s;
    if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    var m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
    if (m) return '#' + [1, 2, 3].map(function (i) { return ('0' + (+m[i]).toString(16)).slice(-2); }).join('');
    return DEFAULT_PRESETS[0].colors[0];
  }

  // Effective values (what the reader sees) plus `chosen` (what the writer set).
  function get() {
    var f = {};
    ['reading', 'interface', 'heading'].forEach(function (slot) {
      var hit = chosen[slot] || (matchFace(world && world[slot]) || {}).id || null;
      f[slot] = hit || ("world: " + (firstFamily(world && world[slot]) || 'unset'));
    });
    var sizeVal = chosen.size ? sizeById(chosen.size).value : ((world && world.size) || '');
    return {
      reading: f.reading, interface: f.interface, heading: f.heading,
      size: chosen.size || 'world', sizeValue: sizeVal,
      preset: chosen.preset || 'world', colors: effectiveColors(),
      custom: chosen.custom,
      marks: chosen.marks || worldMarks || 'outline',
      chosen: {
        reading: chosen.reading, interface: chosen.interface, heading: chosen.heading,
        size: chosen.size, preset: chosen.preset, custom: chosen.custom, marks: chosen.marks
      },
      world: world
    };
  }

  // ---------------------------------------------------------------------------
  // 5 · The panel body (panels.js renders it if it offers a register hook)
  // ---------------------------------------------------------------------------

  var panelEl = null;
  var readingPicker = null;

  function refreshReadingPicker() {
    if (!readingPicker) return;
    var current = chosen.reading, face = faceById(current) || matchFace(world && world.reading);
    readingPicker.value.textContent = face ? face.label : 'Default reading font';
    readingPicker.value.style.fontFamily = face ? face.stack : '';
    readingPicker.options.forEach(function (entry) {
      var f = entry.face, selected = entry.id === (current || '');
      entry.button.setAttribute('aria-checked', selected ? 'true' : 'false');
      entry.button.disabled = !!f && availability[f.id] !== true && !selected;
      entry.name.textContent = (selected ? '✓ ' : '') + (f ? f.label : 'Default reading font');
      entry.note.textContent = f ? statusOf(f) : '';
    });
  }

  function mountReadingPicker(host) {
    if (!host) return;
    host.textContent = '';
    var details = document.createElement('details'); details.className = 'cw-reading-picker';
    // One row: what it is and the font in use, in that font. The list opens below it.
    var summary = document.createElement('summary'), label = document.createElement('span'), value = document.createElement('span');
    label.className = 'set-lbl'; label.textContent = 'Reading font'; value.className = 'set-value';
    summary.appendChild(label); summary.appendChild(value); details.appendChild(summary);
    var list = document.createElement('div'); list.className = 'cw-reading-options';
    list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', 'Reading font');
    readingPicker = { summary: summary, value: value, options: [] };
    [null].concat(FACES).forEach(function (face) {
      var button = document.createElement('button'); button.type = 'button';
      var id = face ? face.id : '';
      button.setAttribute('role', 'radio'); button.setAttribute('data-font', id);
      if (face) button.style.fontFamily = face.stack;
      var name = document.createElement('span'), note = document.createElement('small');
      button.appendChild(name); button.appendChild(note);
      button.addEventListener('click', function () { set('reading', id); });
      readingPicker.options.push({ id: id, face: face, button: button, name: name, note: note });
      list.appendChild(button);
    });
    list.addEventListener('keydown', function (e) {
      if (!/^(ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) return;
      var buttons = readingPicker.options.map(function (o) { return o.button; }).filter(function (b) { return !b.disabled; });
      var at = buttons.indexOf(document.activeElement), delta = /Down|Right/.test(e.key) ? 1 : -1;
      at = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + delta + buttons.length) % buttons.length;
      e.preventDefault(); buttons[at].focus(); buttons[at].click();
    });
    details.appendChild(list); host.appendChild(details);
    refreshReadingPicker();
  }

  function worldLabelFor(slot) {
    if (slot === 'size') return 'Default' + ((world && world.size) ? ' (' + world.size + ')' : '');
    var m = matchFace(world && world[slot]);
    var name = m ? m.label : firstFamily(world && world[slot]);
    return 'Default' + (name ? ' (' + name + ')' : '');
  }

  function faceItems(slot) {
    var out = [{ id: '', label: worldLabelFor(slot), detail: chosen[slot] ? '' : 'in use' }];
    FACES.forEach(function (f) {
      out.push({ id: f.id, label: f.label, detail: chosen[slot] === f.id ? ('in use · ' + statusOf(f)).replace(/ · $/, '') : statusOf(f) });
    });
    return out;
  }

  function retiredDrawer() {
    var details = document.createElement('details');
    details.className = 'cw-type-retired';
    var summary = document.createElement('summary');
    summary.textContent = 'Previously ruled out';
    details.appendChild(summary);
    RETIRED_FACES.forEach(function (face) {
      var item = document.createElement('div');
      item.className = 'cw-type-retired-item';
      var name = document.createElement('strong');
      name.textContent = face.label;
      var reason = document.createElement('span');
      reason.textContent = face.reason;
      item.appendChild(name);
      item.appendChild(reason);
      details.appendChild(item);
    });
    return details;
  }

  function row(label) {
    var r = document.createElement('div');
    r.className = 'cw-type-row';
    var t = document.createElement('div');
    t.className = 'cw-type-label';
    t.textContent = label;
    r.appendChild(t);
    return r;
  }

  function selectFor(slot, options, valueOf, labelOf, detailOf, worldLabel) {
    var sel = document.createElement('select');
    sel.className = 'cw-type-select';
    sel.setAttribute('aria-label', slot);
    var first = document.createElement('option');
    first.value = '';
    first.textContent = worldLabel;
    if (chosen[slot] == null) first.selected = true;
    sel.appendChild(first);
    options.forEach(function (o) {
      var op = document.createElement('option');
      op.value = valueOf(o);
      op.textContent = labelOf(o) + (detailOf && detailOf(o) ? '  (' + detailOf(o) + ')' : '');
      if (chosen[slot] === valueOf(o)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', function () { set(slot, sel.value); });
    return sel;
  }

  function panelBody() {
    var box = document.createElement('div');
    box.className = 'cw-type-panel';

    [['reading', 'Reading face'], ['interface', 'Interface face'], ['heading', 'Heading face']].forEach(function (s) {
      var r = row(s[1]);
      r.appendChild(selectFor(s[0], FACES, function (f) { return f.id; }, function (f) { return f.label; },
        statusOf, worldLabelFor(s[0])));
      box.appendChild(r);
    });
    box.appendChild(retiredDrawer());

    var sz = row('Reading size');
    sz.appendChild(selectFor('size', SIZES, function (o) { return o.id; }, function (o) { return o.label; },
      function (o) { return o.value; }, worldLabelFor('size')));
    box.appendChild(sz);

    var pr = row('Heading colours');
    pr.appendChild(selectFor('preset', presets(), function (o) { return o.id; }, function (o) { return o.label; },
      null, 'Default'));
    box.appendChild(pr);

    var sw = document.createElement('div');
    sw.className = 'cw-type-swatches';
    effectiveColors().forEach(function (hex, i) {
      var wrap = document.createElement('label');
      wrap.className = 'cw-type-swatch';
      var input = document.createElement('input');
      input.type = 'color';
      input.value = toHex(hex);
      input.setAttribute('aria-label', 'Heading ' + (i + 1) + ' colour');
      input.addEventListener('input', function () { setCustom(i + 1, input.value); });
      var cap = document.createElement('span');
      cap.textContent = 'H' + (i + 1);
      wrap.appendChild(input); wrap.appendChild(cap);
      sw.appendChild(wrap);
    });
    box.appendChild(sw);

    var mk = row('Colour headings');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cw-type-toggle';
    btn.textContent = (get().marks === 'page') ? 'outline and page' : 'outline only';
    btn.addEventListener('click', function () { set('marks', get().marks === 'page' ? 'outline' : 'page'); });
    mk.appendChild(btn);
    box.appendChild(mk);

    var back = row('');
    var undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'cw-type-toggle';
    undo.textContent = 'Previous type choice';
    undo.disabled = !previous;
    undo.addEventListener('click', restorePrevious);
    back.appendChild(undo);
    var reb = document.createElement('button');
    reb.type = 'button';
    reb.className = 'cw-type-toggle';
    reb.textContent = 'Reset all type';
    reb.addEventListener('click', reset);
    back.appendChild(reb);
    box.appendChild(back);

    panelEl = box;
    return box;
  }

  function refreshPanel() {
    if (!panelEl || !panelEl.parentNode) return;
    // panelBody() reassigns panelEl, so hold the old node BEFORE building the
    // new one or replaceChild is handed the same node twice.
    var old = panelEl, parent = panelEl.parentNode;
    var fresh = panelBody();
    parent.replaceChild(fresh, old);
    panelEl = fresh;
  }

  function injectBase() {
    if (typeof document === 'undefined' || document.getElementById('castor-fonts-base')) return;
    var s = document.createElement('style');
    s.id = 'castor-fonts-base';
    s.textContent = [
      '.cw-reading-picker summary{cursor:pointer;padding:8px 4px;min-height:44px;box-sizing:border-box}',
      '.cw-reading-options{max-height:240px;overflow:auto;border-block:1px solid var(--rule)}',
      '.cw-reading-options button{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'width:100%;min-height:44px;border:0;border-radius:0;background:transparent;color:var(--ink);padding:8px 4px;text-align:left;font-size:16px;cursor:pointer}',
      '.cw-reading-options button:hover:not(:disabled){background:var(--pane-hot)}',
      '.cw-reading-options button:focus-visible{outline:2px solid var(--ink);outline-offset:-2px}',
      '.cw-reading-options small{font:400 12px/1.4 var(--font-ui,system-ui);color:var(--ink-2);max-width:48%}',
      '.cw-reading-options button:disabled{cursor:default}',
      '.cw-type-panel{display:flex;flex-direction:column;gap:10px;padding:12px;',
      'font:400 13px/1.4 var(--font-ui,system-ui,sans-serif)}',
      '.cw-type-row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}',
      '.cw-type-label{opacity:.7;flex:none;white-space:nowrap}',
      '.cw-type-row>.cw-type-select{flex:0 1 auto;min-width:0;max-width:none;text-overflow:ellipsis}',
      '.cw-type-select,.cw-type-toggle{font:inherit;max-width:60%;padding:3px 6px;',
      'border:1px solid var(--rule,rgba(0,0,0,.18));border-radius:6px;background:transparent;color:inherit}',
      '.cw-type-toggle{cursor:pointer}',
      '.cw-type-retired{border-top:1px solid var(--rule,rgba(0,0,0,.18));padding-top:8px}',
      '.cw-type-retired summary{cursor:pointer;color:var(--ink-2,rgba(0,0,0,.7))}',
      '.cw-type-retired-item{display:grid;grid-template-columns:minmax(7rem,.42fr) 1fr;gap:8px;',
      'padding:6px 0;border-top:1px solid var(--rule,rgba(0,0,0,.12));font-size:11.5px;line-height:1.4}',
      '.cw-type-retired-item:first-of-type{margin-top:7px}',
      '.cw-type-retired-item strong{font-weight:600;color:var(--ink,#23231f)}',
      '.cw-type-retired-item span{color:var(--ink-2,rgba(0,0,0,.7))}',
      '.cw-type-swatches{display:flex;flex-wrap:wrap;gap:8px}',  // touch-sized swatches wrap in a narrow panel
      '.cw-type-swatch{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;opacity:.75}',
      '.cw-type-swatch input{width:34px;height:22px;padding:0;border:1px solid var(--rule,rgba(0,0,0,.18));',
      'border-radius:4px;background:transparent}',
      '#app[data-mode="phone"] .cw-type-panel :is(select,button,input,summary){min-height:44px;box-sizing:border-box}',
      '#app[data-mode="phone"] .cw-type-swatch input{width:44px}',
      '#app[data-mode="phone"] .cw-type-retired summary{display:flex;align-items:center}',
      '@media(any-pointer:coarse){.cw-type-panel :is(select,button,input,summary){min-height:44px;box-sizing:border-box}',
      '.cw-type-swatch input{width:44px}.cw-type-retired summary{display:flex;align-items:center}}'
    ].join('');
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }

  // ---------------------------------------------------------------------------
  // 6 · Palette entries (the Type section)
  // ---------------------------------------------------------------------------

  function registerCommands() {
    var C = Castor.commands;
    if (!C || !C.register) return;

    [['reading', 'Reading face'], ['interface', 'Interface face'], ['heading', 'Heading face']].forEach(function (s) {
      C.register({
        id: 'type.' + s[0], title: 'Type: ' + s[1].toLowerCase(), section: 'Type',
        run: function () {
          C.openList({
            title: s[1], items: faceItems(s[0]),
            onPick: function (i) { set(s[0], i.id); }
          });
        }
      });
    });

    C.register({
      id: 'type.size', title: 'Type: reading size', section: 'Type',
      run: function () {
        var items = [{ id: '', label: worldLabelFor('size') }];
        SIZES.forEach(function (o) { items.push({ id: o.id, label: o.label, detail: o.value }); });
        C.openList({ title: 'Reading size', items: items, onPick: function (i) { set('size', i.id); } });
      }
    });

    C.register({
      id: 'type.colours', title: 'Type: heading colours', section: 'Type',
      run: function () {
        var items = [{ id: '', label: 'Default' }];
        presets().forEach(function (p) { items.push({ id: p.id, label: p.label, detail: p.colors.join(' ') }); });
        C.openList({ title: 'Heading colours', items: items, onPick: function (i) { set('preset', i.id); } });
      }
    });

    C.register({
      id: 'type.marks', title: 'Colour headings: outline only or outline and page', section: 'Type',
      run: function () { set('marks', get().marks === 'page' ? 'outline' : 'page'); }
    });

    C.register({
      id: 'type.reset', title: 'Type: back to the default', section: 'Type',
      run: reset
    });
  }

  // ---------------------------------------------------------------------------
  // 7 · Public API
  // ---------------------------------------------------------------------------

  var mounted = false;
  var fonts = {
    mount: function () {
      injectBase();
      // read the world BEFORE loading any choice, and before apply() can write
      worldMarks = (typeof document !== 'undefined')
        ? document.documentElement.getAttribute('data-heading-marks') : null;
      world = readWorld();
      chosen = load();
      checkAll();
      apply();
      if (!mounted) {
        registerCommands();
        if (Castor.panels && Castor.panels.register) {
          // panels.js's contract: {title, mount(bodyEl)}. It hands us the body
          // element and expects us to fill it.
          Castor.panels.register('type', {
            title: 'Type',
            mount: function (body) { body.appendChild(panelBody()); }
          });
          if (Castor.commands && Castor.commands.register) {
            Castor.commands.register({
              id: 'panel.type', title: 'Type panel', hint: 'open or close', section: 'Panels',
              when: function () { return !!(Castor.panels && Castor.panels.toggle); },
              run: function () { Castor.panels.toggle('type'); }
            });
          }
        }
        if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
          document.fonts.ready.then(function () { checkAll(); refreshPanel(); refreshReadingPicker(); });
          if (document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', function () {
            checkAll(); refreshPanel(); refreshReadingPicker();
          });
        }
        // a chosen ramp follows the paper, so re-apply when the paper changes
        if (global.matchMedia) {
          var mq = global.matchMedia('(prefers-color-scheme: dark)');
          if (mq.addEventListener) mq.addEventListener('change', apply);
          else if (mq.addListener) mq.addListener(apply);
        }
        if (typeof MutationObserver !== 'undefined') {
          new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        }
        mounted = true;
      }
      return fonts;
    },
    faces: function () {
      return FACES.map(function (f) {
        return { id: f.id, label: f.label, kind: f.kind, stack: f.stack, note: statusOf(f), available: availability[f.id] === true };
      });
    },
    retired: function () { return RETIRED_FACES.map(function (f) { return { id: f.id, label: f.label, reason: f.reason }; }); },
    sizes: function () { return SIZES.slice(); },
    presets: presets,
    get: get,
    set: set,
    setCustom: setCustom,
    apply: apply,
    reset: reset,
    restorePrevious: restorePrevious,
    panelBody: panelBody,
    mountReadingPicker: mountReadingPicker,
    worldDefaults: function () { return world; },
    statusOf: function (id) { var f = faceById(id); return f ? statusOf(f) : ''; }
  };

  Castor.fonts = fonts;
  if (typeof module !== 'undefined' && module.exports) module.exports = fonts;
})(typeof window !== 'undefined' ? window : globalThis);
