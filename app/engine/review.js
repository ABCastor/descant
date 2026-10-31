/* review.js — the optional, in-page review island: pins, images and a live design readout.
 * Injection rule: the island has no DOM unless ?review / #review is present,
 * localStorage['castor.review'] is set, or Command/Ctrl Shift R summons it.
 * It is meta tooling, never product chrome, and is deliberately identical in every world.
 *
 * API: Castor.review.install(ctx) · mount(ctx) · toggle(pinMode) · pins() · clear() · exportPins()
 */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {};
  var S = {
    world: 'dev', pins: [], on: false, open: false, section: '', mounted: false,
    layer: null, outline: null, island: null, panel: null, body: null, tab: null,
    box: null, boxPin: null, info: null, position: null, drag: null, uploads: {}
  };
  var TOKENS = ['--ground', '--paper', '--ink', '--ink-2', '--ink-3', '--accent', '--rule',
    '--pane', '--pane-solid', '--pane-hot', '--sel', '--highlight',
    '--h1-color', '--h2-color', '--h3-color', '--h4-color'];

  function app() { return Castor.app || {}; }
  function pinKey() { return 'castor.' + S.world + '.review'; }
  function getLS(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function setLS(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }
  function delLS(k) { try { global.localStorage.removeItem(k); } catch (e) {} }
  function urlFlag() {
    var q = global.location && global.location.search || '';
    var h = global.location && global.location.hash || '';
    return /(?:^|[?&])review(?:=|&|$)/i.test(q) || /(?:^#|[&#])review(?:=|&|$)/i.test(h);
  }
  function load() {
    try { S.pins = JSON.parse(getLS(pinKey()) || '[]') || []; } catch (e) { S.pins = []; }
    S.pins.forEach(function (p, i) { p.id = p.id || ('p' + (i + 1)); p.saved = true; });
    try { S.position = JSON.parse(getLS('castor.review.position') || 'null'); } catch (e2) { S.position = null; }
  }
  function save() {
    try { setLS(pinKey(), JSON.stringify(S.pins, function (k, v) { return k[0] === '_' ? undefined : v; })); }
    catch (e) { /* private mode or a full quota */ }
  }
  function ours(node) {
    for (var n = node; n && n !== document.body; n = n.parentNode) {
      if (n.id === 'review-toggle') return true;
      if (n.classList) for (var i = 0; i < n.classList.length; i++) if (/^castor-rv/.test(n.classList[i])) return true;
    }
    return false;
  }
  function cssPath(node) {
    var out = [];
    while (node && node.nodeType === 1 && node !== document.body && out.length < 12) {
      if (node.id) { out.unshift('#' + node.id); break; }
      var tag = node.tagName.toLowerCase(), i = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
      out.unshift(tag + ':nth-of-type(' + i + ')'); node = node.parentElement;
    }
    return out.join(' > ');
  }
  function words(node) { return (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60); }
  function resolve(pin) {
    var hit = null;
    try { hit = pin.path ? document.querySelector(pin.path) : null; } catch (e) {}
    if (hit && ours(hit)) hit = null;
    if (!pin.text) return hit;
    if (hit && words(hit).slice(0, 24) === pin.text.slice(0, 24)) return hit;
    var all = document.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,a,button,span,div,section,aside');
    for (var i = 0; i < all.length; i++) if (!ours(all[i]) && words(all[i]) === pin.text) return all[i];
    return hit && words(hit).slice(0, 10) === pin.text.slice(0, 10) ? hit : null;
  }
  function button(label, cls) {
    var b = document.createElement('button'); b.type = 'button';
    b.className = cls || 'castor-rv-word'; b.textContent = label; return b;
  }

  function ensureIsland() {
    if (S.island) return;
    load();
    S.layer = document.createElement('div'); S.layer.className = 'castor-rv-layer';
    S.outline = document.createElement('div'); S.outline.className = 'castor-rv-outline';
    S.island = document.createElement('aside'); S.island.className = 'castor-rv-island';
    S.island.setAttribute('aria-label', 'Review tools');
    S.tab = button('Review', 'castor-rv-tab'); S.tab.setAttribute('aria-expanded', 'false');
    S.panel = document.createElement('div'); S.panel.className = 'castor-rv-panel';
    var head = document.createElement('header'); head.className = 'castor-rv-head';
    var title = document.createElement('strong'); title.textContent = 'Review tools';
    var close = button('Close'); head.appendChild(title); head.appendChild(close);
    var nav = document.createElement('nav'); nav.className = 'castor-rv-nav'; nav.setAttribute('aria-label', 'Review tools');
    var review = button('Review'); review.dataset.reviewAction = 'pin';
    var sizes = document.createElement('span'); sizes.className = 'castor-rv-size'; sizes.setAttribute('aria-label', 'Review size');
    ['computer', 'ipad', 'phone'].forEach(function (id) {
      var b = button(id === 'ipad' ? 'iPad' : id[0].toUpperCase() + id.slice(1)); b.dataset.size = id;
      b.addEventListener('click', function () { if (app().setSize) app().setSize(id); }); sizes.appendChild(b);
    });
    var info = button('Type & colours'); info.dataset.reviewAction = 'info';
    var pins = button('Pins'); pins.dataset.reviewAction = 'pins';
    var exp = button('Export'); exp.dataset.reviewAction = 'export';
    nav.appendChild(review); nav.appendChild(sizes); nav.appendChild(info); nav.appendChild(pins); nav.appendChild(exp);
    S.body = document.createElement('div'); S.body.className = 'castor-rv-body'; S.body.hidden = true;
    S.panel.appendChild(head); S.panel.appendChild(nav); S.panel.appendChild(S.body);
    S.island.appendChild(S.tab); S.island.appendChild(S.panel);
    document.body.appendChild(S.layer); document.body.appendChild(S.outline); document.body.appendChild(S.island);
    S.tab.addEventListener('click', function () { setOpen(true); });
    close.addEventListener('click', function () { setOpen(false); });
    review.addEventListener('click', function () { setPinMode(!S.on); });
    info.addEventListener('click', function () { openSection('info'); });
    pins.addEventListener('click', function () { openSection('pins'); });
    exp.addEventListener('click', exportPins);
    head.addEventListener('pointerdown', startDrag);
    applyPosition(); render(); bindLive();
  }
  function removeIsland() {
    setPinMode(false); closeBox();
    [S.layer, S.outline, S.island].forEach(function (n) { if (n) n.remove(); });
    S.layer = S.outline = S.island = S.panel = S.body = S.tab = null;
    S.open = false; S.section = ''; S.info = null;
  }
  function applyPosition() {
    if (!S.island) return;
    var size = app().size || 'computer'; S.island.dataset.size = size;
    if (size !== 'computer' || global.innerWidth < 700) {
      var frame = document.getElementById('frame'); var fr = frame && frame.getBoundingClientRect();
      var ir = S.island.getBoundingClientRect(); var agent = document.getElementById('changes-notice');
      var ah = agent ? agent.getBoundingClientRect().height : 0;
      if (fr) {
        S.island.style.left = Math.max(7, fr.right - ir.width - 7) + 'px';
        S.island.style.top = Math.max(7, fr.bottom - ah - ir.height - 7) + 'px';
        S.island.style.right = 'auto'; S.island.style.bottom = 'auto';
      }
      return;
    }
    if (!S.position) {
      S.island.style.left = S.island.style.top = '';
      S.island.style.right = S.island.style.bottom = '';
      return;
    }
    S.island.style.left = S.position.left + 'px'; S.island.style.top = S.position.top + 'px';
    S.island.style.right = 'auto'; S.island.style.bottom = 'auto';
  }
  function startDrag(e) {
    if (app().size === 'phone' || global.innerWidth < 700 || e.target.closest('button')) return;
    var r = S.island.getBoundingClientRect(); S.drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    global.addEventListener('pointermove', moveDrag); global.addEventListener('pointerup', endDrag, { once: true });
  }
  function moveDrag(e) {
    if (!S.drag) return;
    var r = S.island.getBoundingClientRect();
    S.position = { left: Math.max(8, Math.min(e.clientX - S.drag.x, global.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(e.clientY - S.drag.y, global.innerHeight - r.height - 8)) };
    applyPosition();
  }
  function endDrag() {
    global.removeEventListener('pointermove', moveDrag); S.drag = null;
    if (S.position) setLS('castor.review.position', JSON.stringify(S.position));
  }
  function setOpen(on) {
    ensureIsland(); S.open = !!on; S.island.dataset.open = S.open ? '1' : '0';
    S.tab.setAttribute('aria-expanded', String(S.open)); if (!S.open) setPinMode(false);
    applyPosition();
  }
  function setPinMode(on) {
    S.on = !!on; document.documentElement.classList.toggle('castor-rv-on', S.on);
    if (S.outline) S.outline.style.display = 'none'; if (!S.on) closeBox(); renderIsland(); return S.on;
  }
  function openSection(name) {
    ensureIsland(); setOpen(true); S.section = S.section === name ? '' : name;
    S.body.hidden = !S.section; if (S.section === 'info') renderInfo(); else if (S.section === 'pins') renderPins();
    renderIsland();
  }
  function renderIsland() {
    if (!S.island) return;
    S.island.dataset.size = app().size || 'computer';
    var p = S.island.querySelector('[data-review-action="pin"]');
    if (p) p.setAttribute('aria-pressed', String(S.on));
    S.island.querySelectorAll('.castor-rv-size [data-size]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.size === (app().size || 'computer')));
    });
    S.island.querySelectorAll('[data-review-action="info"],[data-review-action="pins"]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.reviewAction === S.section));
    });
  }

  function closeBox() { if (S.box) S.box.remove(); S.box = S.boxPin = null; }
  function cancelBox() {
    var pin = S.boxPin; closeBox();
    if (pin && !pin.saved) S.pins = S.pins.filter(function (p) { return p !== pin; }); render();
  }
  function imageData(file) {
    return new Promise(function (done, fail) {
      var fr = new FileReader(); fr.onerror = fail; fr.onload = function () {
        var img = new Image(); img.onerror = fail; img.onload = function () {
          var scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
          var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          function encode() {
            var data = c.toDataURL(mime, mime === 'image/jpeg' ? .86 : undefined);
            if (data.length <= 3.5 * 1024 * 1024 || Math.max(c.width, c.height) <= 256) { done(data); return; }
            var smaller = document.createElement('canvas'); smaller.width = Math.max(1, Math.round(c.width * .8));
            smaller.height = Math.max(1, Math.round(c.height * .8)); smaller.getContext('2d').drawImage(c, 0, 0, smaller.width, smaller.height); c = smaller; encode();
          }
          encode();
        }; img.src = String(fr.result);
      }; fr.readAsDataURL(file);
    });
  }
  function storeAsset(pin, data) {
    if (!/^https?:$/.test(global.location.protocol)) return Promise.resolve(null);
    return global.fetch('/api/review/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world: S.world, pinId: pin.id, image: data }) })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (out) {
        if (out && out.path) { pin.image = out.path; pin._preview = out.path; save(); renderPins(); }
        return out;
      }).catch(function () { return null; });
  }
  function attach(pin, file, preview) {
    if (!file || !/^image\//.test(file.type || '')) return;
    var task = imageData(file).then(function (data) {
      pin.image = data; pin._preview = data; save();
      if (preview) { preview.src = data; preview.hidden = false; } renderPins();
      return storeAsset(pin, data);
    }).catch(function () { /* the note remains usable if an image cannot be decoded */ });
    S.uploads[pin.id] = task;
    task.then(function () { if (S.uploads[pin.id] === task) delete S.uploads[pin.id]; });
  }
  function openBox(pin, left, top) {
    closeBox(); var box = document.createElement('div'); box.className = 'castor-rv-box';
    box.style.left = Math.max(global.scrollX + 8, Math.min(left + 16, global.scrollX + global.innerWidth - 286)) + 'px';
    box.style.top = Math.max(global.scrollY + 8, top + 12) + 'px';
    var ta = document.createElement('textarea'); ta.placeholder = 'What is wrong, or what you would want'; ta.value = pin.note || '';
    var preview = document.createElement('img'); preview.className = 'castor-rv-preview'; preview.alt = 'Attached example';
    preview.src = pin._preview || pin.image || ''; preview.hidden = !preview.src;
    var row = document.createElement('div'); row.className = 'castor-rv-box-actions'; var add = button('Attach');
    var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.className = 'castor-rv-file'; input.hidden = true;
    var hint = document.createElement('span'); hint.textContent = 'Enter saves. Paste or drop an image.';
    add.addEventListener('click', function () { input.click(); }); input.addEventListener('change', function () { attach(pin, input.files[0], preview); });
    row.appendChild(add); row.appendChild(input); row.appendChild(hint); box.appendChild(ta); box.appendChild(preview); box.appendChild(row);
    function pasted(e) { var fs = e.clipboardData && e.clipboardData.files; if (fs && fs[0]) { e.preventDefault(); attach(pin, fs[0], preview); } }
    box.addEventListener('paste', pasted); box.addEventListener('dragover', function (e) { e.preventDefault(); box.dataset.dropping = '1'; });
    box.addEventListener('dragleave', function () { delete box.dataset.dropping; });
    box.addEventListener('drop', function (e) { e.preventDefault(); delete box.dataset.dropping; attach(pin, e.dataTransfer.files[0], preview); });
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); pin.note = ta.value.trim();
        if (!pin.note && !pin.image && !pin.saved && !S.uploads[pin.id]) S.pins = S.pins.filter(function (p) { return p !== pin; });
        else {
          pin.saved = true;
          if (S.uploads[pin.id]) S.uploads[pin.id].then(function () { postPin(pin); });
          else postPin(pin);
        }
        save(); closeBox(); render();
      } else if (e.key === 'Escape') { e.preventDefault(); cancelBox(); }
    });
    box.addEventListener('click', function (e) { e.stopPropagation(); }); S.layer.appendChild(box); S.box = box; S.boxPin = pin; ta.focus();
  }
  function postPin(pin) {
    if (!/^https?:$/.test(global.location.protocol)) return;
    try { global.fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world: S.world, id: pin.id, size: app().size || '', theme: app().theme || '',
        path: pin.path, text: pin.text, x: pin.x, y: pin.y, note: pin.note, image: pin.image || '', time: pin.time }) }).catch(function () {}); }
    catch (e) {}
  }
  function render() {
    if (!S.layer) return; S.layer.querySelectorAll('.castor-rv-pin').forEach(function (n) { n.remove(); });
    S.pins.forEach(function (pin, i) {
      var hit = resolve(pin), dot = document.createElement('button'); dot.type = 'button';
      dot.className = 'castor-rv-pin' + (hit ? '' : ' lost'); dot.textContent = String(i + 1);
      /* Hang the pin off the element's TOP-RIGHT corner, not on the click point: a disc on
         the click point sits over the first letters of the passage it is about. The stored
         x/y fractions are untouched — they are the record of where he clicked. */
      if (hit) { var r = hit.getBoundingClientRect();
        dot.style.left = Math.round(r.right + global.scrollX) + 'px';
        dot.style.top = Math.round(r.top + global.scrollY) + 'px'; }
      else { dot.style.left = '14px'; dot.style.top = Math.round(global.scrollY + 60 + i * 26) + 'px'; }
      dot.title = pin.note || 'Review pin'; dot.addEventListener('click', function (e) {
        e.stopPropagation(); openBox(pin, parseInt(dot.style.left, 10), parseInt(dot.style.top, 10));
      }); S.layer.appendChild(dot);
    });
    renderPins(); renderIsland();
  }
  function renderPins() {
    if (!S.body || S.section !== 'pins') return; S.body.textContent = '';
    var head = document.createElement('div'); head.className = 'castor-rv-list-head';
    head.textContent = S.pins.length ? S.pins.length + (S.pins.length === 1 ? ' pin' : ' pins') : 'No pins yet';
    if (S.pins.length) { var clearWord = button('Clear'); clearWord.addEventListener('click', function () {
      if (global.confirm('Remove every review pin on this page?')) clear(); }); head.appendChild(clearWord); }
    S.body.appendChild(head); var list = document.createElement('ol');
    S.pins.forEach(function (pin, i) {
      var li = document.createElement('li'); var n = document.createElement('strong'); n.textContent = String(i + 1) + '.'; li.appendChild(n);
      if (pin.image) { var img = document.createElement('img'); img.src = pin._preview || pin.image; img.alt = 'Attached example'; li.appendChild(img); }
      var t = document.createElement('span'); t.textContent = pin.note || '(image only)'; li.appendChild(t);
      if (!resolve(pin)) { var lost = document.createElement('small'); lost.textContent = 'lost its place'; li.appendChild(lost); }
      li.addEventListener('click', function () { var dot = S.layer.querySelectorAll('.castor-rv-pin')[i];
        if (dot) openBox(pin, parseInt(dot.style.left, 10), parseInt(dot.style.top, 10)); }); list.appendChild(li);
    }); S.body.appendChild(list);
  }

  function colourValue(root, name) {
    var v = root.getPropertyValue(name).trim();
    if (!v && /^--h[1-4]-color$/.test(name)) v = root.getPropertyValue('--level-' + name[3]).trim();
    return v;
  }
  function rgba(value) {
    var probe = document.createElement('span'); probe.style.color = value; document.body.appendChild(probe);
    var nums = (getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0]).map(Number); probe.remove();
    return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
  }
  function hex(value) {
    var c = rgba(value), h = c.slice(0, 3).map(function (n) { return ('0' + Math.round(n).toString(16)).slice(-2); }).join('');
    return '#' + h + (c[3] < 1 ? ('0' + Math.round(c[3] * 255).toString(16)).slice(-2) : '');
  }
  // Both sides must reach `lum` as exactly three channels: a fourth (alpha) has
  // no coefficient, and one undefined coefficient turns the whole ratio into NaN.
  function contrast(fg, bg) {
    var f = rgba(fg), b = rgba(bg).slice(0, 3), alpha = f[3];
    f = f.slice(0, 3).map(function (v, i) { return v * alpha + b[i] * (1 - alpha); });
    function lum(c) { return c.map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); })
      .reduce(function (s, v, i) { return s + v * [.2126, .7152, .0722][i]; }, 0); }
    var a = lum(f), z = lum(b); return Math.round(((Math.max(a, z) + .05) / (Math.min(a, z) + .05)) * 100) / 100;
  }
  function resolvedFamily(style) {
    var stack = style.fontFamily.split(',').map(function (x) { return x.trim().replace(/^['"]|['"]$/g, ''); });
    if (!document.fonts || !document.fonts.check) return stack[0];
    for (var i = 0; i < stack.length; i++) if (document.fonts.check(style.fontSize + ' "' + stack[i] + '"')) return stack[i];
    return stack[0];
  }
  function readInfo() {
    var root = getComputedStyle(document.documentElement);
    var samples = [document.querySelector('#page-article p') || document.querySelector('#page-article'),
      document.querySelector('#topbar'), document.querySelector('#page-article h2') || document.querySelector('#page-article h1')];
    var labels = ['Reading', 'Interface', 'Heading'];
    var faces = samples.map(function (node, i) { var cs = getComputedStyle(node || document.body);
      return { label: labels[i], family: resolvedFamily(cs), stack: cs.fontFamily, size: cs.fontSize, line: cs.lineHeight }; });
    var colours = TOKENS.map(function (name) { var value = colourValue(root, name); return { name: name, value: value, hex: hex(value || 'transparent') }; });
    var paper = colourValue(root, '--paper'); var ratios = ['--ink', '--ink-2', '--ink-3'].map(function (name) {
      return { name: name, ratio: contrast(colourValue(root, name), paper) }; });
    return { faces: faces, colours: colours, ratios: ratios };
  }
  function infoMarkdown(info) {
    var out = ['## Type and colours in use', '', '### Type'];
    info.faces.forEach(function (f) { out.push('- ' + f.label + ': ' + f.family + ', ' + f.size + ' / ' + f.line); });
    out.push('', '### Colours'); info.colours.forEach(function (c) { out.push('- `' + c.name + '`: `' + c.hex + '`'); });
    out.push('', '### Contrast on `--paper`'); info.ratios.forEach(function (r) { out.push('- `' + r.name + '`: ' + r.ratio + ':1'); }); return out.join('\n');
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    fallback();
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove();
    }
  }
  function renderInfo() {
    if (!S.body || S.section !== 'info') return; S.info = readInfo(); S.body.textContent = '';
    var copy = button('Copy'); copy.className += ' castor-rv-copy'; copy.addEventListener('click', function () {
      copyText(infoMarkdown(S.info));
      copy.textContent = 'Copied'; global.setTimeout(function () { copy.textContent = 'Copy'; }, 1000);
    }); S.body.appendChild(copy);
    S.info.faces.forEach(function (f) { var row = document.createElement('div'); row.className = 'castor-rv-face';
      row.innerHTML = '<strong>' + f.label + '</strong><span>' + f.family + '</span><small>' + f.size + ' / ' + f.line + '</small>'; S.body.appendChild(row); });
    var palette = document.createElement('div'); palette.className = 'castor-rv-swatches';
    S.info.colours.forEach(function (c) { var row = document.createElement('div'); row.className = 'castor-rv-swatch';
      var sw = document.createElement('i'); sw.style.background = c.value; var name = document.createElement('span'); name.textContent = c.name;
      var value = document.createElement('code'); value.textContent = c.hex; row.appendChild(sw); row.appendChild(name); row.appendChild(value); palette.appendChild(row); });
    S.body.appendChild(palette); var ratios = document.createElement('div'); ratios.className = 'castor-rv-ratios';
    ratios.textContent = S.info.ratios.map(function (r) { return r.name + ' ' + r.ratio + ':1'; }).join('  '); S.body.appendChild(ratios);
  }
  function bindLive() {
    if (Castor.bus && Castor.bus.on) {
      ['theme', 'type:change'].forEach(function (name) { Castor.bus.on(name, function () { if (S.section === 'info') renderInfo(); renderIsland(); }); });
      Castor.bus.on('size', function () { renderIsland(); applyPosition(); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S.section === 'info') renderInfo(); });
  }

  function onMove(e) {
    if (!S.on) return; var hit = document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || ours(hit)) { S.outline.style.display = 'none'; return; } var r = hit.getBoundingClientRect();
    S.outline.style.display = 'block'; S.outline.style.left = r.left + 'px'; S.outline.style.top = r.top + 'px';
    S.outline.style.width = Math.max(0, r.width - 4) + 'px'; S.outline.style.height = Math.max(0, r.height - 4) + 'px';
  }
  function onClick(e) {
    if (!S.on) return; var hit = e.target && e.target.nodeType === 1 ? e.target : document.elementFromPoint(e.clientX, e.clientY);
    if (!hit || ours(hit)) return; e.preventDefault(); e.stopPropagation(); var r = hit.getBoundingClientRect();
    function frac(v, n) { return n ? Math.round(Math.min(1, Math.max(0, v / n)) * 1000) / 1000 : 0; }
    var pin = { id: 'p' + Date.now().toString(36), path: cssPath(hit), text: words(hit), x: frac(e.clientX - r.left, r.width),
      y: frac(e.clientY - r.top, r.height), note: '', image: '', time: new Date().toISOString(), saved: false };
    S.pins.push(pin); render(); openBox(pin, e.clientX + global.scrollX, e.clientY + global.scrollY);
  }
  function hint() {
    if (getLS('castor.review.hinted')) return; setLS('castor.review.hinted', '1'); var h = document.createElement('div');
    h.className = 'castor-rv-hint'; h.textContent = 'Review tools are separate. Press Command Shift R to open them.'; document.body.appendChild(h);
    global.setTimeout(function () { h.remove(); }, 1000);
  }
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault(); var first = !S.island; var opening = first || !S.open;
      if (!opening && !urlFlag()) { delLS('castor.review'); removeIsland(); return; }
      if (opening && !urlFlag()) setLS('castor.review', '1'); ensureIsland(); setOpen(opening); if (opening) hint(); return;
    }
    if (e.key === 'Escape' && S.island) { if (S.box) cancelBox(); else if (S.on) setPinMode(false); else if (S.open) setOpen(false); }
  }
  function exportPins() {
    var text = JSON.stringify({ world: S.world, pins: S.pins }, null, 2);
    copyText(text);
    try { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'review-' + S.world + '.json'; a.click(); global.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); } catch (e) {}
    return text;
  }
  var raf = 0;
  function schedule() { if (!raf) raf = global.requestAnimationFrame(function () { raf = 0; render(); }); }
  function clear() { S.pins = []; save(); render(); }
  function toggle(on) { setLS('castor.review', '1'); ensureIsland(); setOpen(true); return setPinMode(on === undefined ? !S.on : on); }
  function registerCommand() {
    if (!Castor.commands || !Castor.commands.register) return;
    try { Castor.commands.register({ id: 'review.type-colours', title: 'Type and colours in use', section: 'Review',
      run: function () { setLS('castor.review', '1'); ensureIsland(); openSection('info'); } }); } catch (e) {}
  }
  function install(a, b) {
    var opts = a && a.nodeType === 1 ? (b || {}) : (a || {}); S.world = opts.world || app().world || S.world;
    // A drive or a test may redirect its pins to a throwaway world so the founder's review file never fills with residue.
    try { var w = global.localStorage && global.localStorage.getItem('castor.review.world'); if (w) S.world = w.replace(/[^a-z0-9-]/gi, '').slice(0, 40) || S.world; } catch (e) {}
    if (!S.mounted) {
      S.mounted = true; document.addEventListener('mousemove', onMove, true); document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true); global.addEventListener('resize', schedule); global.addEventListener('scroll', schedule, true);
      // Typing #review onto an already-open page is a same-document navigation:
      // nothing reloads, so the gate has to hear the hash itself or the founder's
      // own link rule ("end it in #review") is only true from a cold load.
      global.addEventListener('hashchange', function () {
        if (urlFlag()) { ensureIsland(); return; }
        if (!getLS('castor.review')) removeIsland();
      });
    }
    registerCommand(); if (urlFlag() || getLS('castor.review')) ensureIsland(); return Castor.review;
  }
  Castor.review = { install: install, mount: install, toggle: toggle, openInfo: function () { ensureIsland(); openSection('info'); },
    pins: function () { return S.pins.slice(); }, clear: clear, exportPins: exportPins, _state: S };
  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.review;
})(typeof window !== 'undefined' ? window : this);
