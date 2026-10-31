/*
 * canvas.js — the workspace: a free canvas beside the piece.
 *
 * A panel holding an infinite canvas beside the piece: excerpts dragged out of the
 * page, notes, images, links, groups, arrows between them, and pen strokes under
 * everything. The file it writes is JSON Canvas 1.0, an open format other tools read.
 *
 * Three things in here are subtle and are commented where they happen:
 *   1. canvas <-> screen coordinates (search "COORDINATES")
 *   2. how a pan is told apart from a pen stroke and from a card drag (search "ROUTING")
 *   3. the export mapping onto JSON Canvas (search "EXPORT MAPPING")
 *
 * No libraries. Pointer events only. Colours and faces come from CSS variables.
 */
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});

  var SVGNS = 'http://www.w3.org/2000/svg';
  var MIN_ZOOM = 0.25;
  var MAX_ZOOM = 3;
  var MIME_ANCHOR = 'application/x-castor-anchor';
  var MIME_CARD = 'application/x-castor-card';
  var MIME_MOVE_BLOCK = 'application/x-castor-move-block';
  var MIME_FILE = 'application/x-castor-file';
  var HALF = 50000;            // half-span of the two SVG layers, in canvas units
  var FIT_PAD = 64;            // breathing room left by fit(), in screen pixels
  var SAVE_DEBOUNCE = 8000;

  var INKS = [
    { id: 'ink', word: 'Ink', css: 'var(--ink, #22252a)' },
    { id: 'accent', word: 'Accent', css: 'var(--accent, #3b5bdb)' },
    { id: 'secondary', word: 'Quiet', css: 'var(--ink-2, #8a8f98)' }
  ];

  var SIZES = {
    excerpt: { width: 250, height: 156 },
    note: { width: 220, height: 132 },
    image: { width: 260, height: 190 },
    file: { width: 236, height: 82 },
    link: { width: 236, height: 64 },
    group: { width: 340, height: 260 }
  };

  var EMPTY_LINE = 'Drag anything here: a sentence, an image, a link. ' +
    'Draw with the pen. It stays with the piece.';

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function svgEl(tag, cls, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (cls) n.setAttribute('class', cls);
    if (parent) parent.appendChild(n);
    return n;
  }

  var seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + Date.now().toString(36).slice(-5) + seq.toString(36);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function r2(n) { return Math.round(n * 100) / 100; }

  // Bus with a plain-DOM fallback, so no builder has to care which one exists.
  function on(name, fn) {
    if (Castor.bus && Castor.bus.on) Castor.bus.on(name, fn);
    else if (typeof document !== 'undefined') document.addEventListener(name, fn);
  }

  function emit(name, detail) {
    try {
      if (Castor.bus && typeof Castor.bus.emit === 'function') { Castor.bus.emit(name, detail); return; }
    } catch (e) { /* a listener threw; not our problem */ }
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e2) { /* no DOM events either */ }
  }

  function isUrl(s) { return /^(https?:\/\/|mailto:)\S+$/i.test(String(s || '').trim()); }
  function wikiTarget(s) {
    var m = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(String(s || ''));
    return m ? m[1] : null;
  }

  function rectInside(inner, outer) {
    return inner.x >= outer.x && inner.y >= outer.y &&
           inner.x + inner.width <= outer.x + outer.width &&
           inner.y + inner.height <= outer.y + outer.height;
  }

  /* ------------------------------------------------------------------ *
   * Structural CSS. Injected as the FIRST child of <head> so engine.css
   * and a world's theme.css override it at equal specificity. Nothing in
   * here picks a colour or a face: every one is a token with a neutral
   * fallback, because engine.css does not know these class names.
   * ------------------------------------------------------------------ */

  var CSS = [
    '.cv-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:240px;',
    'font-family:var(--font-ui,system-ui,-apple-system,"Segoe UI",sans-serif);',
    'color:var(--ink,#22252a);background:var(--paper,#fbfaf8);overflow:hidden;outline:none}',

    '.cv-bar{flex:0 0 auto;display:flex;align-items:center;gap:1px;padding:6px 8px;position:relative;z-index:4;',
    'border-bottom:1px solid var(--rule,rgba(0,0,0,.12));background:var(--paper,#fbfaf8)}',
    '.cv-tool{appearance:none;-webkit-appearance:none;background:none;border:0;border-radius:5px;',
    'padding:4px 9px;font:inherit;font-size:12.5px;line-height:1.4;color:var(--ink,#22252a);',
    'opacity:.75;cursor:pointer;white-space:nowrap}',
    '.cv-tool:hover{opacity:1;background:var(--sel,rgba(0,0,0,.055))}',
    '.cv-tool:focus-visible{outline:2px solid var(--accent,#3b5bdb);outline-offset:1px}',
    '.cv-tool[aria-pressed="true"]{opacity:1;background:var(--accent,#3b5bdb);color:var(--paper,#fff)}',
    '.cv-gap{flex:1 1 auto}',
    '.cv-inks{display:none;align-items:center;gap:1px;margin-left:4px;padding-left:7px;',
    'border-left:1px solid var(--rule,rgba(0,0,0,.12))}',
    '.cv-root.cv-is-pen .cv-inks{display:flex}',
    '.cv-tool.cv-inkbtn{opacity:.75;font-size:12px;border-radius:3px 3px 0 0;padding-bottom:2px}',
    '.cv-tool.cv-inkbtn[aria-pressed="true"]{background:var(--sel,rgba(0,0,0,.075));opacity:1;color:inherit}',

    '.cv-view{position:relative;flex:1 1 auto;overflow:hidden;touch-action:none;',
    'cursor:grab;contain:paint}',
    '.cv-view.cv-grabbing{cursor:grabbing}',
    '.cv-root.cv-is-pen .cv-view{cursor:crosshair}',
    '.cv-root.cv-is-arrow .cv-view{cursor:default}',

    '.cv-scene{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}',
    '.cv-ink,.cv-edges{position:absolute;left:-' + HALF + 'px;top:-' + HALF + 'px;',
    'width:' + (HALF * 2) + 'px;height:' + (HALF * 2) + 'px;pointer-events:none;overflow:visible}',
    '.cv-cards{position:absolute;left:0;top:0;width:0;height:0}',

    '.cv-card{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;',
    'background:var(--pane-solid,var(--paper,#fff));border:1px solid var(--rule,rgba(0,0,0,.14));border-radius:6px;',
    'box-shadow:0 1px 2px rgba(0,0,0,.07),0 8px 20px -8px rgba(0,0,0,.16);',
    'font-size:13px;line-height:1.45;overflow:visible;touch-action:none}',
    '.cv-card.cv-sel{border-color:var(--accent,#3b5bdb);',
    'box-shadow:0 0 0 1px var(--accent,#3b5bdb),0 1px 2px rgba(0,0,0,.07),0 10px 24px -8px rgba(0,0,0,.2)}',
    '.cv-card.cv-dragging{opacity:.92}',

    '.cv-head{flex:0 0 auto;display:flex;align-items:center;padding:5px 7px 2px;user-select:none}',
    '.cv-grip{cursor:grab;padding:0 3px;margin-left:-3px;border-radius:3px;font-size:11px;opacity:0;',
    'transition:opacity 160ms ease-out,background-color 160ms ease-out}',
    '.cv-card:hover .cv-grip,.cv-card.cv-sel .cv-grip{opacity:.72}',
    '.cv-grip:hover{background:var(--sel,rgba(0,0,0,.06));opacity:1}',
    '.cv-link-here{appearance:none;border:0;background:none;color:var(--accent,#3b5bdb);font:inherit;font-size:11px;',
    'padding:0 2px;margin-left:auto;opacity:0;cursor:pointer;transition:opacity 160ms ease-out}',
    '.cv-card:hover .cv-link-here,.cv-card.cv-sel .cv-link-here,.cv-link-here:focus-visible{opacity:1}',
    '.cv-close{appearance:none;border:0;background:none;color:var(--ink,#22252a);font:inherit;font-size:16px;line-height:1;',
    'padding:0 3px;margin-left:3px;border-radius:3px;opacity:.62;cursor:pointer}',
    '.cv-close:hover{opacity:1;background:var(--sel,rgba(0,0,0,.06))}',
    '.cv-close:focus-visible{opacity:1;outline:2px solid var(--accent,#3b5bdb);outline-offset:1px}',
    '.cv-card.cv-group .cv-close{position:absolute;right:5px;top:4px}',

    '.cv-body{flex:1 1 auto;padding:2px 9px 9px;overflow:auto;outline:none;word-break:break-word}',
    '.cv-card.cv-excerpt .cv-body{font-family:var(--font-reading,Georgia,"Iowan Old Style",serif);font-size:12.5px}',
    '.cv-card.cv-note .cv-body{font-size:13px}',
    '.cv-body[contenteditable="true"]{cursor:text;background:var(--sel,rgba(0,0,0,.03))}',

    '.cv-foot{flex:0 0 auto;padding:0 9px 7px;font-size:11px}',
    '.cv-back{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:11px;',
    'color:var(--accent,#3b5bdb);cursor:pointer}',
    '.cv-back:hover{text-decoration:underline}',

    '.cv-card.cv-image{padding:0}',
    '.cv-card.cv-image .cv-body{padding:0;display:flex;align-items:center;justify-content:center;overflow:hidden}',
    '.cv-card.cv-image img{max-width:100%;max-height:100%;display:block}',
    '.cv-wbadge{position:absolute;right:5px;bottom:5px;padding:1px 5px;border-radius:3px;',
    'font-size:10.5px;background:var(--sel,rgba(0,0,0,.06));opacity:.75;pointer-events:none}',

    '.cv-card.cv-link{border-radius:16px}',
    '.cv-card.cv-link .cv-body{display:flex;align-items:center;padding:0 12px}',
    '.cv-chip{color:var(--accent,#3b5bdb);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cv-chip:hover{text-decoration:underline}',
    '.cv-card.cv-file .cv-body{display:flex;flex-direction:column;justify-content:center;padding:2px 12px 12px}',
    '.cv-fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cv-fkind{font-size:10.5px;opacity:.62;text-transform:uppercase;letter-spacing:.04em}',

    '.cv-card.cv-group{background:none;border:1px solid var(--rule,rgba(0,0,0,.2));border-radius:8px;',
    'box-shadow:none}',
    '.cv-card.cv-group .cv-body{flex:1 1 auto;pointer-events:none}',
    '.cv-card.cv-group .cv-glabel{flex:0 0 auto;padding:5px 9px;font-size:11.5px;letter-spacing:.02em;',
    'opacity:.7;outline:none}',

    '.cv-h{position:absolute;width:9px;height:9px;border-radius:50%;background:var(--pane-solid,var(--paper,#fff));',
    'border:1px solid var(--accent,#3b5bdb);opacity:0;transition:opacity .12s ease-out;touch-action:none;cursor:crosshair}',
    '.cv-card:hover .cv-h,.cv-card.cv-sel .cv-h,.cv-root.cv-is-arrow .cv-h{opacity:1}',
    '.cv-h-top{left:50%;top:-5px;margin-left:-5px}.cv-h-bottom{left:50%;bottom:-5px;margin-left:-5px}',
    '.cv-h-left{top:50%;left:-5px;margin-top:-5px}.cv-h-right{top:50%;right:-5px;margin-top:-5px}',

    '.cv-resize{position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;',
    'touch-action:none;opacity:0;transition:opacity .12s ease-out}',
    '.cv-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;',
    'border-right:1.5px solid var(--ink,#22252a);border-bottom:1.5px solid var(--ink,#22252a);opacity:.4}',
    '.cv-card:hover .cv-resize,.cv-card.cv-sel .cv-resize{opacity:1}',

    '.cv-edge{fill:none;stroke:var(--ink,#22252a);stroke-width:1.4;stroke-opacity:.7}',
    '.cv-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}',
    '.cv-edge-head{fill:var(--ink,#22252a);fill-opacity:.7}',
    '.cv-edge.cv-live{stroke:var(--accent,#3b5bdb);stroke-dasharray:4 3}',
    '.cv-elabel{position:absolute;transform:translate(-50%,-50%);padding:1px 6px;border-radius:4px;',
    'background:var(--pane-solid,var(--paper,#fff));border:1px solid var(--rule,rgba(0,0,0,.14));font-size:11px;',
    'pointer-events:auto;cursor:text;outline:none;white-space:nowrap;max-width:200px;overflow:hidden}',
    '.cv-elabel.cv-empty-label{opacity:0}',
    '.cv-elabel.cv-empty-label:hover{opacity:.5}',

    '.cv-empty{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'max-width:34ch;text-align:center;font-size:13px;line-height:1.6;opacity:.65;',
    'pointer-events:none;padding:0 16px}',

    '.cv-marquee{position:absolute;border:1px dashed var(--accent,#3b5bdb);',
    'background:var(--accent,#3b5bdb);background:rgba(59,91,219,.07);pointer-events:none;display:none}',
    '.cv-view.cv-dropping::after{content:"";position:absolute;inset:4px;border-radius:6px;',
    'border:1.5px dashed var(--accent,#3b5bdb);pointer-events:none}',
    '.cv-zoom{position:absolute;right:8px;bottom:6px;font-size:11px;opacity:.65;pointer-events:none}',
    '.cv-page-drop-line{position:fixed;z-index:80;height:2px;background:var(--accent,#3b5bdb);',
    'box-shadow:0 0 0 1px var(--paper,#fff);pointer-events:none;display:none}',
    '.cv-menu{position:fixed;z-index:100;min-width:178px;padding:4px;background:var(--pane-solid,var(--paper,#fff));',
    'border:1px solid var(--rule,rgba(0,0,0,.16));border-radius:6px;box-shadow:0 10px 28px -10px rgba(0,0,0,.28)}',
    '.cv-menu[hidden]{display:none}',
    '.cv-menu-item{display:block;width:100%;appearance:none;border:0;border-radius:3px;background:none;color:var(--ink,#22252a);',
    'padding:6px 8px;text-align:left;font:inherit;font-size:12.5px;cursor:pointer}',
    '.cv-menu-item:hover,.cv-menu-item:focus{outline:none;background:var(--sel,rgba(0,0,0,.065))}',
    '.cv-menu-sep{height:1px;margin:4px 2px;background:var(--rule,rgba(0,0,0,.12))}'
  ].join('');

  function injectCss() {
    if (document.querySelector('style[data-castor="canvas"]')) return;
    var s = document.createElement('style');
    s.setAttribute('data-castor', 'canvas');
    s.textContent = CSS;
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }

  /* ------------------------------------------------------------------ *
   * Pen geometry: a stroke is a filled outline, not a constant-width line,
   * so pressure is visible. Each point is offset perpendicular to the local
   * direction by half its own width; the two sides are smoothed with
   * quadratic midpoint curves and closed into one path.
   * ------------------------------------------------------------------ */

  function sideTail(pts) {
    var d = '';
    for (var i = 1; i < pts.length - 1; i++) {
      var mx = (pts[i][0] + pts[i + 1][0]) / 2;
      var my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ' Q' + r2(pts[i][0]) + ' ' + r2(pts[i][1]) + ' ' + r2(mx) + ' ' + r2(my);
    }
    var last = pts[pts.length - 1];
    d += ' L' + r2(last[0]) + ' ' + r2(last[1]);
    return d;
  }

  function strokeOutline(points, baseWidth) {
    var n = points.length;
    if (!n) return '';
    if (n === 1) {
      var p0 = points[0];
      var r = Math.max(0.5, baseWidth * (p0[2] || 0.5)) / 2;
      return 'M' + r2(p0[0] - r) + ' ' + r2(p0[1]) +
        'a' + r2(r) + ' ' + r2(r) + ' 0 1 0 ' + r2(r * 2) + ' 0' +
        'a' + r2(r) + ' ' + r2(r) + ' 0 1 0 ' + r2(-r * 2) + ' 0Z';
    }
    var left = [], right = [];
    for (var i = 0; i < n; i++) {
      var prev = points[Math.max(0, i - 1)];
      var next = points[Math.min(n - 1, i + 1)];
      var dx = next[0] - prev[0], dy = next[1] - prev[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= len; dy /= len;
      var w = Math.max(0.4, baseWidth * (points[i][2] || 0.5)) / 2;
      left.push([points[i][0] - dy * w, points[i][1] + dx * w]);
      right.push([points[i][0] + dy * w, points[i][1] - dx * w]);
    }
    right.reverse();
    return 'M' + r2(left[0][0]) + ' ' + r2(left[0][1]) + sideTail(left) +
      ' L' + r2(right[0][0]) + ' ' + r2(right[0][1]) + sideTail(right) + 'Z';
  }

  function pointToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var wx = px - ax, wy = py - ay;
    var l2 = vx * vx + vy * vy;
    var t = l2 ? clamp((wx * vx + wy * vy) / l2, 0, 1) : 0;
    var dx = px - (ax + t * vx), dy = py - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function strokeHit(stroke, x, y, tolerance) {
    var pts = stroke.points, tol = tolerance + (stroke.width || 2) / 2;
    if (pts.length === 1) {
      return pointToSegment(x, y, pts[0][0], pts[0][1], pts[0][0], pts[0][1]) <= tol;
    }
    for (var i = 0; i < pts.length - 1; i++) {
      if (pointToSegment(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= tol) return true;
    }
    return false;
  }

  function strokeBounds(stroke) {
    var b = null;
    stroke.points.forEach(function (p) {
      if (!b) b = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
      else {
        b.minX = Math.min(b.minX, p[0]); b.minY = Math.min(b.minY, p[1]);
        b.maxX = Math.max(b.maxX, p[0]); b.maxY = Math.max(b.maxY, p[1]);
      }
    });
    return b;
  }

  /* ------------------------------------------------------------------ *
   * The workspace
   * ------------------------------------------------------------------ */

  /* --- public canvas journals ------------------------------------------- */
  var publicCanvasPageId = global.crypto && typeof global.crypto.randomUUID === 'function' ? global.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var publicCanvasWorkspaceSequence = 0;
  function pendingAccount(account) {
    var role = Castor.role;
    return role && role.confirmed && role.publicWriter && !!(Castor.people && Castor.people.isWriter(role.who)) && role.id === 'founder:' + role.who && role.id === account ? account : '';
  }
  function ownedPending(record, account) {
    return record && record.schema === 1 && record.account === account && record.pending === true &&
      /^[a-z0-9-]+$/.test(record.world || '') && /^articles\/[^/]+$/.test(record.piece || '') && record.piece.split('/').indexOf('..') < 0 &&
      Array.isArray(record.who) && record.who.length > 0 && record.who.length <= 8 && record.who[0] === account.slice('founder:'.length) &&
      typeof record.base === 'string' && record.canvas && Array.isArray(record.canvas.nodes) && Array.isArray(record.canvas.edges);
  }
  function pendingKey(record, account) { return 'castor.' + record.world + '.canvas.account.' + encodeURIComponent(account) + '.' + record.piece; }
  function pendingForAccount(account) {
    if (!pendingAccount(account)) return [];
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!/^castor\.[a-z0-9-]+\.canvas\.account\./.test(key || '')) continue;
      var record;
      try { record = JSON.parse(localStorage.getItem(key) || 'null'); } catch (error) { continue; }
      if (ownedPending(record, account) && (key === pendingKey(record, account) || key.indexOf(pendingKey(record, account) + '.recovery.') === 0)) out.push(Object.assign({}, record, { key: key }));
    }
    return out;
  }
  var recoverySequence = 0;
  function validatePendingForAccount(account, records) {
    return !!pendingAccount(account) && Array.isArray(records) && records.every(function (record) { return !!ownedPending(record, account); });
  }
  function recoveryKey(original) {
    var key;
    do { key = original + '.recovery.' + publicCanvasPageId + '-' + (++recoverySequence); } while (localStorage.getItem(key) !== null);
    return key;
  }
  function restorePendingForAccount(account, records, importId) {
    if (!validatePendingForAccount(account, records)) throw new Error('The original workspace writer could not be confirmed. Nothing was imported.');
    var known = pendingForAccount(account), restored = 0, existing = 0, conflicts = 0;
    // Content identity survives export/re-import and interrupted import retries,
    // including callers that supply the same portable-pack importId.
    function same(a, b) { return JSON.stringify([a.world, a.piece, a.account, a.who, a.base, a.canvas]) === JSON.stringify([b.world, b.piece, b.account, b.who, b.base, b.canvas]); }
    records.forEach(function (record) {
      if (known.some(function (held) { return same(held, record); })) { existing++; return; }
      var copy = { schema: 1, world: record.world, piece: record.piece, account: account, who: record.who, canvas: record.canvas, base: record.base, pending: true };
      var primary = pendingKey(copy, account);
      if (known.some(function (held) { return held.world === copy.world && held.piece === copy.piece; }) || localStorage.getItem(primary) !== null) conflicts++;
      // The former primary slot is read-only. Even two imports into empty
      // storage must allocate independently before either write completes.
      var key = recoveryKey(primary);
      localStorage.setItem(key, JSON.stringify(copy));
      known.push(Object.assign({}, copy, { key: key })); restored++;
    });
    if (restored) emit('canvas:recoveries', { account: account });
    return { restored: restored, existing: existing, conflicts: conflicts };
  }
  /* --- workspace -------------------------------------------------------- */
  function createWorkspace(host, opts) {
    opts = opts || {};
    injectCss();

    var world = opts.world || (Castor.app && Castor.app.world) || 'sample';
    var pieceFolder = String(opts.piece || (Castor.app && Castor.app.data &&
      Castor.app.data.piece && Castor.app.data.piece.folder) || '').replace(/^\/+|\/+$/g, '');

    var S = {
      cards: [],          // {id,type,x,y,width,height,text,url,path,fileType,kind,anchor,label,resized}
      edges: [],          // {id,fromNode,fromSide,toNode,toSide,label}
      strokes: [],        // {points:[[x,y,p]], ink, width}
      images: {},         // cardId -> data URL (JSON Canvas has no room for it)
      pan: { x: 0, y: 0 },
      zoom: 1,
      tool: 'select',     // 'select' | 'pen' | 'arrow'
      ink: 'ink',
      erasing: false,
      selection: [],      // card ids
      undo: null          // one step: {cards, edges, strokes}
    };

    /* --- DOM ------------------------------------------------------- */

    host.classList.add('cv-host');
    var root = el('div', 'cv-root', host);
    root.tabIndex = 0;

    var bar = el('div', 'cv-bar', root);
    var view = el('div', 'cv-view', root);
    var scene = el('div', 'cv-scene', view);
    var inkLayer = svgEl('svg', 'cv-ink', scene);
    inkLayer.setAttribute('viewBox', -HALF + ' ' + -HALF + ' ' + (HALF * 2) + ' ' + (HALF * 2));
    var edgeLayer = svgEl('svg', 'cv-edges', scene);
    edgeLayer.setAttribute('viewBox', -HALF + ' ' + -HALF + ' ' + (HALF * 2) + ' ' + (HALF * 2));
    var cardLayer = el('div', 'cv-cards', scene);
    var empty = el('div', 'cv-empty', view);
    empty.textContent = EMPTY_LINE;
    var marquee = el('div', 'cv-marquee', view);
    var zoomLabel = el('div', 'cv-zoom', view);
    var dropLine = el('div', 'cv-page-drop-line', document.body);
    var menu = el('div', 'cv-menu', document.body);
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    var menuState = null;
    var pageEl = document.getElementById('page');
    var articleEl = document.getElementById('page-article');
    var currentTextBlock = null;

    // The toolbar is words. Pen and Arrow are modes; Note and Fit act once.
    var buttons = {};
    function toolButton(id, word, parent) {
      var b = el('button', 'cv-tool', parent || bar);
      b.type = 'button';
      b.textContent = word;
      b.dataset.tool = id;
      buttons[id] = b;
      return b;
    }
    toolButton('note', 'Note');
    toolButton('pen', 'Pen').setAttribute('aria-pressed', 'false');
    var inks = el('span', 'cv-inks', bar);
    INKS.forEach(function (k) {
      var b = toolButton('ink:' + k.id, k.word, inks);
      b.classList.add('cv-inkbtn');
      b.style.borderBottom = '2px solid ' + k.css;
      b.setAttribute('aria-pressed', String(k.id === S.ink));
    });
    var eraseBtn = toolButton('erase', 'Erase', inks);
    eraseBtn.classList.add('cv-inkbtn');
    eraseBtn.style.borderBottom = '2px solid transparent';
    eraseBtn.setAttribute('aria-pressed', 'false');
    toolButton('arrow', 'Arrow').setAttribute('aria-pressed', 'false');
    toolButton('fit', 'Fit');
    el('span', 'cv-gap', bar);
    toolButton('export', 'Export');
    var saveStatus = el('span', 'cv-save-status', bar);
    saveStatus.setAttribute('role', 'status');

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.cv-tool');
      if (!b) return;
      onTool(b.dataset.tool);
    });

    function onTool(id) {
      if (id === 'note') {
        var c = centreOfView();
        var card = addCard({ type: 'note', text: '', x: c.x - SIZES.note.width / 2, y: c.y - SIZES.note.height / 2 });
        select([card.id]);
        editCard(card.id);
      } else if (id === 'pen') {
        setTool(S.tool === 'pen' ? 'select' : 'pen');
      } else if (id === 'arrow') {
        setTool(S.tool === 'arrow' ? 'select' : 'arrow');
      } else if (id === 'fit') {
        fit();
      } else if (id === 'export') {
        exportCanvas();
      } else if (id === 'erase') {
        S.erasing = !S.erasing;
        if (S.erasing && S.tool !== 'pen') setTool('pen');
        syncTools();
      } else if (id.indexOf('ink:') === 0) {
        S.ink = id.slice(4);
        S.erasing = false;
        if (S.tool !== 'pen') setTool('pen');
        syncTools();
      }
    }

    function setTool(t) {
      S.tool = t;
      if (t !== 'pen') S.erasing = false;
      syncTools();
    }

    function syncTools() {
      root.classList.toggle('cv-is-pen', S.tool === 'pen');
      root.classList.toggle('cv-is-arrow', S.tool === 'arrow');
      buttons.pen.setAttribute('aria-pressed', String(S.tool === 'pen'));
      buttons.arrow.setAttribute('aria-pressed', String(S.tool === 'arrow'));
      buttons.erase.setAttribute('aria-pressed', String(S.erasing));
      INKS.forEach(function (k) {
        buttons['ink:' + k.id].setAttribute('aria-pressed', String(!S.erasing && S.ink === k.id));
      });
    }

    /* --- COORDINATES ------------------------------------------------ *
     * CSS zoom scales the scene's layout, while transform carries translation
     * only. Chrome and WebKit rasterise text and images at the zoomed layout
     * scale, instead of enlarging a scale-1 composited bitmap, so edges stay
     * crisp in Chromium, Safari and the WebKit used on iPad/iPhone. Every card,
     * stroke point and edge endpoint remains stored in canvas units.
     *   screen -> canvas : (s - pan) / zoom
     *   canvas -> screen : c * zoom + pan
     * Screen here means "relative to the viewport box", so a client point
     * has the viewport's rect subtracted first.
     * ----------------------------------------------------------------- */

    function toCanvas(clientX, clientY) {
      var r = view.getBoundingClientRect();
      return {
        x: (clientX - r.left - S.pan.x) / S.zoom,
        y: (clientY - r.top - S.pan.y) / S.zoom
      };
    }

    function centreOfView() {
      var r = view.getBoundingClientRect();
      return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
    }

    function applyTransform() {
      /* `zoom` also scales transform distances, so divide pan by zoom. The
         resulting screen equation remains c * zoom + pan. */
      scene.style.zoom = String(S.zoom);
      scene.style.transform = 'translate(' + (S.pan.x / S.zoom) + 'px,' + (S.pan.y / S.zoom) + 'px)';
      zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
    }

    function zoomAt(clientX, clientY, nextZoom) {
      nextZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === S.zoom) return;
      var r = view.getBoundingClientRect();
      var sx = clientX - r.left, sy = clientY - r.top;
      // Keep the canvas point under the pointer pinned: pan' = s - c * zoom'
      var cx = (sx - S.pan.x) / S.zoom;
      var cy = (sy - S.pan.y) / S.zoom;
      S.zoom = nextZoom;
      S.pan.x = sx - cx * S.zoom;
      S.pan.y = sy - cy * S.zoom;
      applyTransform();
    }

    /* --- cards ------------------------------------------------------- */

    var nodeEls = {};   // cardId -> element

    function findCard(id) {
      for (var i = 0; i < S.cards.length; i++) if (S.cards[i].id === id) return S.cards[i];
      return null;
    }

    function addCard(spec) {
      spec = spec || {};
      var type = spec.type || 'note';
      var size = SIZES[type] || SIZES.note;
      var card = {
        id: spec.id || uid('n'),
        type: type,
        x: Math.round(spec.x == null ? centreOfView().x - size.width / 2 : spec.x),
        y: Math.round(spec.y == null ? centreOfView().y - size.height / 2 : spec.y),
        width: Math.round(spec.width || size.width),
        height: Math.round(spec.height || size.height),
        text: spec.text || '',
        url: spec.url || '',
        path: spec.path || '',
        fileType: spec.fileType || '',
        kind: spec.kind || '',
        group: spec.group || '',
        target: spec.target || '',
        label: spec.label || '',
        anchor: spec.anchor || null,
        resized: !!spec.resized
      };
      if (type === 'image' && spec.src && !card.path) S.images[card.id] = spec.src;
      // Groups go first in the array so they paint under everything else.
      if (type === 'group') S.cards.unshift(card); else S.cards.push(card);
      render();
      changed();
      return card;
    }

    function removeCards(ids) {
      if (!ids.length) return;
      S.undo = snapshot();
      ids.forEach(function (id) { delete S.images[id]; });
      S.cards = S.cards.filter(function (c) { return ids.indexOf(c.id) < 0; });
      S.edges = S.edges.filter(function (e) {
        return ids.indexOf(e.fromNode) < 0 && ids.indexOf(e.toNode) < 0;
      });
      S.selection = [];
      render();
      changed();
    }

    function snapshot() {
      return {
        cards: JSON.parse(JSON.stringify(S.cards)),
        edges: JSON.parse(JSON.stringify(S.edges)),
        strokes: JSON.parse(JSON.stringify(S.strokes)),
        images: Object.assign({}, S.images)
      };
    }

    function undo() {
      if (!S.undo) return false;
      S.cards = S.undo.cards;
      S.edges = S.undo.edges;
      S.strokes = S.undo.strokes;
      S.images = S.undo.images;
      S.undo = null;
      render();
      changed();
      return true;
    }

    function select(ids, additive) {
      S.selection = additive ? S.selection.concat(ids.filter(function (i) {
        return S.selection.indexOf(i) < 0;
      })) : ids.slice();
      S.cards.forEach(function (c) {
        var n = nodeEls[c.id];
        if (n) n.classList.toggle('cv-sel', S.selection.indexOf(c.id) >= 0);
      });
    }

    function placeCard(card) {
      var n = nodeEls[card.id];
      if (!n) return;
      n.style.left = card.x + 'px';
      n.style.top = card.y + 'px';
      n.style.width = card.width + 'px';
      n.style.height = card.height + 'px';
    }

    function buildCard(card) {
      var n = el('div', 'cv-card cv-' + card.type);
      n.dataset.id = card.id;

      if (card.type === 'group') {
        var lab = el('div', 'cv-glabel', n);
        lab.textContent = card.label || 'Group';
        lab.contentEditable = 'false';
        lab.addEventListener('dblclick', function (e) {
          e.stopPropagation();
          lab.contentEditable = 'true';
          lab.focus();
          document.execCommand && document.execCommand('selectAll', false, null);
        });
        lab.addEventListener('input', function () { card.label = lab.textContent; changed(); });
        lab.addEventListener('blur', function () {
          lab.contentEditable = 'false';
          card.label = lab.textContent.trim();
          changed();
        });
        el('div', 'cv-body', n);
        addCloseControl(n, card);
      } else {
        var head = el('div', 'cv-head', n);
        // The grip is the drag-OUT handle: a native HTML5 drag, because that is
        // the only way to hand text to the editor with the right MIME types.
        var grip = el('span', 'cv-grip', head);
        grip.textContent = 'To the text';
        grip.draggable = true;
        grip.title = 'Drag onto the page to insert this text';
        var linkHere = el('button', 'cv-link-here', head);
        linkHere.type = 'button'; linkHere.textContent = 'Link here';
        linkHere.title = 'Create a card that returns to the current paragraph';
        linkHere.addEventListener('click', function (e) { e.stopPropagation(); linkToCurrentParagraph(card); });
        addCloseControl(head, card);
        var body = el('div', 'cv-body', n);
        if (card.type === 'image') {
          var img = el('img', null, body);
          img.src = S.images[card.id] || card.url || '';
          img.alt = card.text || 'dropped image';
          img.draggable = false;
          if (card.resized) {
            var badge = el('div', 'cv-wbadge', n);
            badge.textContent = '|' + card.width;
          }
        } else if (card.type === 'link') {
          var chip = el('span', 'cv-chip', body);
          chip.textContent = card.anchor ? '[[' + String(card.anchor.quote || 'paragraph').slice(0, 36) + ']]'
            : (card.target ? '[[' + card.target + ']]' : (card.text || card.url));
          chip.addEventListener('click', function (e) {
            e.stopPropagation();
            openLink(card);
          });
        } else if (card.type === 'file') {
          var fileName = el('span', 'cv-fname', body);
          fileName.textContent = card.text || card.path || 'File';
          var fileKind = el('span', 'cv-fkind', body);
          fileKind.textContent = card.kind || card.fileType || 'file';
        } else {
          body.textContent = card.text;
          body.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            editCard(card.id);
          });
          body.addEventListener('input', function () {
            card.text = body.textContent;
            changed();
          });
          body.addEventListener('blur', function () {
            if (body.getAttribute('contenteditable') !== 'true') return;
            body.setAttribute('contenteditable', 'false');
            card.text = body.textContent;
            changed();
          });
        }

        if (card.type === 'excerpt') {
          var foot = el('div', 'cv-foot', n);
          var back = el('button', 'cv-back', foot);
          back.type = 'button';
          back.textContent = '↩ in text';
          back.addEventListener('click', function (e) {
            e.stopPropagation();
            backlink(card);
          });
        }

        if (card.type === 'excerpt' && card.anchor && card.anchor.blockId) {
          grip.textContent = 'Move paragraph';
          grip.title = 'Drag onto the page to move this paragraph there';
        }
        grip.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        grip.addEventListener('dragstart', function (e) { onCardDragStart(e, card); });
        grip.addEventListener('dragend', function (e) { onCardDragEnd(e, card); });
      }

      ['top', 'right', 'bottom', 'left'].forEach(function (side) {
        var h = el('div', 'cv-h cv-h-' + side, n);
        h.dataset.side = side;
      });
      el('div', 'cv-resize', n);
      return n;
    }

    function addCloseControl(parent, card) {
      var close = el('button', 'cv-close', parent);
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Delete card');
      close.title = 'Delete card';
      close.addEventListener('click', function (e) {
        e.stopPropagation();
        removeCards([card.id]);
        root.focus({ preventScroll: true });
      });
    }

    function editCard(id) {
      var n = nodeEls[id];
      if (!n) return;
      var body = n.querySelector('.cv-body');
      if (!body) return;
      body.setAttribute('contenteditable', 'true');
      body.focus();
      var r = document.createRange();
      r.selectNodeContents(body);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      sel.collapseToEnd();
    }

    function openLink(card) {
      if (card.anchor) { backlink(card); return; }
      if (card.target) {
        // An inward link: the shell decides where a piece opens.
        emit('open:beside', { target: card.target });
        return;
      }
      if (card.url) window.open(card.url, '_blank', 'noopener');
    }

    function backlink(card) {
      if (!card.anchor) return;
      emit('canvas:backlink', card.anchor);
      var ed = Castor.editor;
      if (!ed) return;
      try {
        if (card._movedBlock && card.anchor.blockId && typeof ed.scrollToBlock === 'function') {
          ed.scrollToBlock(card.anchor.blockId);
          var movedEl = articleEl && articleEl.querySelector('.cw-block[data-block-id="' + card.anchor.blockId + '"]');
          if (movedEl) {
            movedEl.classList.add('flash', 'cw-flash-block');
            setTimeout(function () { movedEl.classList.remove('flash', 'cw-flash-block'); }, 1600);
          }
          return;
        }
        if (typeof ed.flashAnchor === 'function') ed.flashAnchor(card.anchor);
        else if (typeof ed.scrollToBlock === 'function' && card.anchor.blockId) ed.scrollToBlock(card.anchor.blockId);
      } catch (e) { /* the editor is another builder's; never let it break the canvas */ }
    }

    function rememberCurrentBlock() {
      var sel = global.getSelection && global.getSelection();
      var node = sel && sel.anchorNode; if (node && node.nodeType === 3) node = node.parentNode;
      var block = node && node.closest ? node.closest('.cw-block[data-block-id]') : null;
      if (block && articleEl && articleEl.contains(block)) currentTextBlock = block;
    }

    function paragraphAnchor() {
      rememberCurrentBlock();
      var block = currentTextBlock;
      if (!block && articleEl) {
        var candidates = Array.prototype.slice.call(articleEl.querySelectorAll('.cw-block[data-block-id]'));
        var middle = pageEl ? pageEl.getBoundingClientRect().top + pageEl.clientHeight / 2 : global.innerHeight / 2;
        candidates.sort(function (a, b) {
          return Math.abs(a.getBoundingClientRect().top - middle) - Math.abs(b.getBoundingClientRect().top - middle);
        });
        block = candidates[0] || null;
      }
      if (!block || !Castor.md || !Castor.md.makeAnchor || !appDoc()) return null;
      var id = block.getAttribute('data-block-id');
      var item = (appDoc().blocks || []).filter(function (b) { return b.id === id; })[0];
      if (!item) return null;
      var sourceText = item.text || item.source || '';
      var anchor = Castor.md.makeAnchor(appDoc(), id, 0, Math.min(sourceText.length, 80));
      if (anchor) anchor.blockId = id;
      return anchor;
    }

    function appDoc() { return Castor.app && Castor.app.doc; }

    function linkToCurrentParagraph(card) {
      var anchor = paragraphAnchor(); if (!anchor) return;
      var linked = addCard({ type: 'link', anchor: anchor, text: '[[' + anchor.quote.slice(0, 36) + ']]',
        x: card.x + card.width + 28, y: card.y + 8 });
      S.edges.push({ id: uid('e'), fromNode: card.id, fromSide: 'right', toNode: linked.id, toSide: 'left', label: '' });
      select([linked.id]); renderEdges(); changed();
    }

    /* --- rendering ---------------------------------------------------- */

    var edgeEls = {};

    function render() {
      // Full rebuild on structural change. Cards are few; drags update styles
      // directly and never come through here.
      cardLayer.textContent = '';
      nodeEls = {};
      S.cards.forEach(function (c) {
        var n = buildCard(c);
        nodeEls[c.id] = n;
        cardLayer.appendChild(n);
        placeCard(c);
        if (S.selection.indexOf(c.id) >= 0) n.classList.add('cv-sel');
      });
      renderStrokes();
      renderEdges();
      empty.style.display = (S.cards.length || S.strokes.length) ? 'none' : '';
      applyTransform();
      syncBonds();
    }

    function syncBonds() {
      if (!Castor.bonds) return;
      Castor.bonds.clear('workspace:');
      S.cards.filter(function (card) { return !!card.anchor; }).forEach(function (card) {
        Castor.bonds.register('workspace:' + card.id, {
          kind: 'workspace-card-to-sentence',
          from: function () { return nodeEls[card.id] || null; },
          to: function () {
            return articleEl && articleEl.querySelector('mark.in-workspace[data-thread="canvas:' + card.id + '"]');
          }
        });
      });
      Castor.bonds.layout();
    }

    function renderStrokes() {
      inkLayer.textContent = '';
      S.strokes.forEach(function (st) {
        var p = svgEl('path', 'cv-stroke', inkLayer);
        p.setAttribute('d', strokeOutline(st.points, st.width));
        p.setAttribute('fill', inkColour(st.ink));
        st.el = p;
      });
    }

    function inkColour(id) {
      var found = null;
      INKS.forEach(function (k) { if (k.id === id) found = k; });
      return (found || INKS[0]).css;
    }

    // Where an edge meets a card: the named side, or the side facing the other card.
    function sidePoint(card, side, other) {
      var cx = card.x + card.width / 2, cy = card.y + card.height / 2;
      if (!side || side === 'auto') {
        var ox = other ? other.x + other.width / 2 : cx;
        var oy = other ? other.y + other.height / 2 : cy;
        var dx = ox - cx, dy = oy - cy;
        if (Math.abs(dx) * card.height > Math.abs(dy) * card.width) side = dx > 0 ? 'right' : 'left';
        else side = dy > 0 ? 'bottom' : 'top';
      }
      if (side === 'top') return { x: cx, y: card.y, side: side };
      if (side === 'bottom') return { x: cx, y: card.y + card.height, side: side };
      if (side === 'left') return { x: card.x, y: cy, side: side };
      return { x: card.x + card.width, y: cy, side: side };
    }

    function edgePath(a, b) {
      // A gentle S: the control points push out of the side the line leaves by.
      var out = Math.min(90, Math.max(30, Math.abs(a.x - b.x) / 2 + Math.abs(a.y - b.y) / 4));
      var c1 = { x: a.x, y: a.y }, c2 = { x: b.x, y: b.y };
      if (a.side === 'left') c1.x -= out; else if (a.side === 'right') c1.x += out;
      else if (a.side === 'top') c1.y -= out; else c1.y += out;
      if (b.side === 'left') c2.x -= out; else if (b.side === 'right') c2.x += out;
      else if (b.side === 'top') c2.y -= out; else c2.y += out;
      return { d: 'M' + r2(a.x) + ' ' + r2(a.y) + 'C' + r2(c1.x) + ' ' + r2(c1.y) + ' ' +
        r2(c2.x) + ' ' + r2(c2.y) + ' ' + r2(b.x) + ' ' + r2(b.y), c2: c2 };
    }

    function arrowHead(tip, from) {
      var dx = tip.x - from.x, dy = tip.y - from.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= len; dy /= len;
      var s = 7;
      var bx = tip.x - dx * s, by = tip.y - dy * s;
      return [r2(tip.x) + ',' + r2(tip.y),
        r2(bx - dy * s * 0.42) + ',' + r2(by + dx * s * 0.42),
        r2(bx + dy * s * 0.42) + ',' + r2(by - dx * s * 0.42)].join(' ');
    }

    function renderEdges() {
      edgeLayer.textContent = '';
      edgeEls = {};
      var labels = [];
      S.edges.forEach(function (e) {
        var from = findCard(e.fromNode), to = findCard(e.toNode);
        if (!from || !to) return;
        var a = sidePoint(from, e.fromSide, to);
        var b = sidePoint(to, e.toSide, from);
        var geom = edgePath(a, b);
        var hit = svgEl('path', 'cv-edge-hit', edgeLayer);
        hit.setAttribute('d', geom.d);
        var line = svgEl('path', 'cv-edge', edgeLayer);
        line.setAttribute('d', geom.d);
        var head = svgEl('polygon', 'cv-edge-head', edgeLayer);
        head.setAttribute('points', arrowHead(b, geom.c2));
        edgeEls[e.id] = { line: line, head: head, hit: hit };
        labels.push({ edge: e, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        hit.addEventListener('dblclick', function (ev) {
          ev.stopPropagation();
          var lab = cardLayer.querySelector('.cv-elabel[data-edge="' + e.id + '"]');
          if (lab) { lab.classList.remove('cv-empty-label'); lab.focus(); }
        });
      });
      // Labels are HTML, in the cards layer, so editing one is an ordinary
      // contenteditable rather than a foreignObject.
      Array.prototype.slice.call(cardLayer.querySelectorAll('.cv-elabel')).forEach(function (n) { n.remove(); });
      labels.forEach(function (L) {
        var lab = el('div', 'cv-elabel', cardLayer);
        lab.dataset.edge = L.edge.id;
        lab.textContent = L.edge.label || 'label';
        if (!L.edge.label) lab.classList.add('cv-empty-label');
        lab.style.left = L.x + 'px';
        lab.style.top = L.y + 'px';
        lab.contentEditable = 'true';
        lab.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        lab.addEventListener('dblclick', function (e) { e.stopPropagation(); });
        lab.addEventListener('input', function () { L.edge.label = lab.textContent; changed(); });
        lab.addEventListener('blur', function () {
          L.edge.label = lab.textContent.trim();
          if (!L.edge.label) { lab.textContent = 'label'; lab.classList.add('cv-empty-label'); }
          changed();
        });
      });
    }

    function refreshEdgeGeometry() {
      // Called during a card drag: no rebuild, just new path data.
      S.edges.forEach(function (e) {
        var g = edgeEls[e.id];
        if (!g) return;
        var from = findCard(e.fromNode), to = findCard(e.toNode);
        if (!from || !to) return;
        var a = sidePoint(from, e.fromSide, to);
        var b = sidePoint(to, e.toSide, from);
        var geom = edgePath(a, b);
        g.line.setAttribute('d', geom.d);
        g.hit.setAttribute('d', geom.d);
        g.head.setAttribute('points', arrowHead(b, geom.c2));
        var lab = cardLayer.querySelector('.cv-elabel[data-edge="' + e.id + '"]');
        if (lab) { lab.style.left = ((a.x + b.x) / 2) + 'px'; lab.style.top = ((a.y + b.y) / 2) + 'px'; }
      });
    }

    /* --- ROUTING ------------------------------------------------------ *
     * One pointer path for mouse, touch and pen. The viewport records every
     * pointerdown in the CAPTURE phase, so it knows how many fingers are
     * down before anything else runs. A card, an edge handle or the resize
     * corner then claims the gesture in the BUBBLE phase. The viewport's own
     * bubble handler runs last, and only then decides between pen, marquee
     * and pan. A second live pointer cancels whatever is running and becomes
     * a pinch, which is why two-finger pan works in every mode.
     * ------------------------------------------------------------------ */

    var pointers = new Map();   // pointerId -> {clientX, clientY}
    var G = null;               // the live gesture, or null

    view.addEventListener('pointerdown', function (e) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        cancelGesture();
        var pts = Array.from(pointers.values());
        var vr = view.getBoundingClientRect();
        G = {
          kind: 'pinch',
          startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          startZoom: S.zoom,
          // viewport-relative, the same frame pan lives in
          startMid: { x: (pts[0].x + pts[1].x) / 2 - vr.left, y: (pts[0].y + pts[1].y) / 2 - vr.top },
          startPan: { x: S.pan.x, y: S.pan.y }
        };
      }
    }, true);

    view.addEventListener('pointerdown', function (e) {
      if (G || pointers.size > 1) return;             // a card claimed it, or two fingers
      if (e.button !== undefined && e.button > 0) return;
      root.focus({ preventScroll: true });
      var pt = toCanvas(e.clientX, e.clientY);

      if (S.tool === 'pen') {
        G = S.erasing ? { kind: 'erase' } : startStroke(pt, e);
        if (S.erasing) { S.undo = snapshot(); eraseAt(pt); }
      } else if (e.shiftKey && S.tool !== 'arrow') {
        G = { kind: 'marquee', from: pt, client: { x: e.clientX, y: e.clientY } };
        marquee.style.display = 'block';
      } else {
        select([]);
        G = { kind: 'pan', startPan: { x: S.pan.x, y: S.pan.y }, client: { x: e.clientX, y: e.clientY } };
        view.classList.add('cv-grabbing');
      }
      view.setPointerCapture(e.pointerId);
    });

    view.addEventListener('pointermove', function (e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!G) return;

      if (G.kind === 'pinch') {
        var pts = Array.from(pointers.values());
        if (pts.length < 2) return;
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        var z = clamp(G.startZoom * (dist / G.startDist), MIN_ZOOM, MAX_ZOOM);
        var cx = (G.startMid.x - G.startPan.x) / G.startZoom;
        var cy = (G.startMid.y - G.startPan.y) / G.startZoom;
        var r = view.getBoundingClientRect();
        S.zoom = z;
        S.pan.x = (mid.x - r.left) - cx * z;
        S.pan.y = (mid.y - r.top) - cy * z;
        applyTransform();
        return;
      }

      if (G.kind === 'pan') {
        S.pan.x = G.startPan.x + (e.clientX - G.client.x);
        S.pan.y = G.startPan.y + (e.clientY - G.client.y);
        applyTransform();
        return;
      }

      if (G.kind === 'stroke') {
        // Coalesced events give an Apple Pencil its real sample rate for free.
        var evs = (typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents()) || [e];
        for (var i = 0; i < evs.length; i++) addStrokePoint(evs[i]);
        return;
      }

      if (G.kind === 'erase') { eraseAt(toCanvas(e.clientX, e.clientY)); return; }

      if (G.kind === 'marquee') {
        var r = view.getBoundingClientRect();
        var x0 = Math.min(G.client.x, e.clientX) - r.left, x1 = Math.max(G.client.x, e.clientX) - r.left;
        var y0 = Math.min(G.client.y, e.clientY) - r.top, y1 = Math.max(G.client.y, e.clientY) - r.top;
        marquee.style.left = x0 + 'px'; marquee.style.top = y0 + 'px';
        marquee.style.width = (x1 - x0) + 'px'; marquee.style.height = (y1 - y0) + 'px';
        G.to = toCanvas(e.clientX, e.clientY);
        return;
      }

      if (G.kind === 'card') {
        var dx = (e.clientX - G.client.x) / S.zoom;
        var dy = (e.clientY - G.client.y) / S.zoom;
        G.moving.forEach(function (m) {
          m.card.x = Math.round(m.x0 + dx);
          m.card.y = Math.round(m.y0 + dy);
          placeCard(m.card);
        });
        refreshEdgeGeometry();
        return;
      }

      if (G.kind === 'resize') {
        var c = G.card;
        c.width = Math.max(80, Math.round(G.w0 + (e.clientX - G.client.x) / S.zoom));
        c.height = Math.max(48, Math.round(G.h0 + (e.clientY - G.client.y) / S.zoom));
        c.resized = true;
        placeCard(c);
        var badge = nodeEls[c.id] && nodeEls[c.id].querySelector('.cv-wbadge');
        if (c.type === 'image') {
          if (!badge) { badge = el('div', 'cv-wbadge', nodeEls[c.id]); }
          badge.textContent = '|' + c.width;
        }
        refreshEdgeGeometry();
        return;
      }

      if (G.kind === 'edge') {
        var p = toCanvas(e.clientX, e.clientY);
        var geom = edgePath(G.from, { x: p.x, y: p.y, side: 'left' });
        G.line.setAttribute('d', geom.d);
        return;
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (!G) return;
      var g = G;
      if (g.kind === 'pinch' && pointers.size > 0) return;   // wait for the second finger
      G = null;
      view.classList.remove('cv-grabbing');

      if (g.kind === 'stroke') { finishStroke(g); }
      else if (g.kind === 'erase') { changed(); }
      else if (g.kind === 'marquee') {
        marquee.style.display = 'none';
        makeGroup(g.from, g.to);
      } else if (g.kind === 'card') {
        if (!g.moved) {
          select([g.card.id], g.additive);
        } else changed();
      } else if (g.kind === 'resize') { changed(); }
      else if (g.kind === 'edge') {
        g.line.remove();
        var target = document.elementFromPoint(e.clientX, e.clientY);
        var host2 = target && target.closest ? target.closest('.cv-card') : null;
        if (host2 && host2.dataset.id !== g.cardId) {
          S.edges.push({
            id: uid('e'),
            fromNode: g.cardId, fromSide: g.side,
            toNode: host2.dataset.id, toSide: null,
            label: ''
          });
          renderEdges();
          changed();
        }
      }
    }

    view.addEventListener('pointerup', endPointer);
    view.addEventListener('pointercancel', endPointer);

    function cancelGesture() {
      if (!G) return;
      if (G.kind === 'stroke' && G.path) G.path.remove();
      if (G.kind === 'edge' && G.line) G.line.remove();
      if (G.kind === 'marquee') marquee.style.display = 'none';
      G = null;
      view.classList.remove('cv-grabbing');
    }

    /* --- pen ---------------------------------------------------------- */

    function pressureOf(e) {
      if (e.pointerType === 'mouse') return 0.55;
      return e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    }

    function startStroke(pt, e) {
      var st = {
        points: [[r2(pt.x), r2(pt.y), r2(pressureOf(e))]],
        ink: S.ink,
        width: 3.2
      };
      var path = svgEl('path', 'cv-stroke', inkLayer);
      path.setAttribute('fill', inkColour(st.ink));
      path.setAttribute('d', strokeOutline(st.points, st.width));
      empty.style.display = 'none';
      return { kind: 'stroke', stroke: st, path: path };
    }

    function addStrokePoint(e) {
      if (!G || G.kind !== 'stroke') return;
      var p = toCanvas(e.clientX, e.clientY);
      var pts = G.stroke.points;
      var last = pts[pts.length - 1];
      // Thin the samples in canvas units so a zoomed-out stroke is not a blob.
      if (Math.hypot(p.x - last[0], p.y - last[1]) < 1.1 / S.zoom) return;
      pts.push([r2(p.x), r2(p.y), r2(pressureOf(e))]);
      G.path.setAttribute('d', strokeOutline(pts, G.stroke.width));   // one write per move
    }

    function finishStroke(g) {
      var st = g && g.stroke;
      if (!st) return;
      if (!st.points.length) { if (g.path) g.path.remove(); return; }
      S.strokes.push(st);
      changed();
    }

    function eraseAt(pt) {
      var tol = 5 / S.zoom;
      var keep = [], hitAny = false;
      S.strokes.forEach(function (st) {
        if (!hitAny && strokeHit(st, pt.x, pt.y, tol)) { hitAny = true; return; }
        keep.push(st);
      });
      if (!hitAny) return;
      S.strokes = keep;
      renderStrokes();
    }

    function makeGroup(a, b) {
      if (!a || !b) return;
      var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      var w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
      if (w < 48 || h < 48) return;
      addCard({ type: 'group', x: x, y: y, width: w, height: h, label: 'Group' });
    }

    /* --- gestures that start on a card --------------------------------- */

    cardLayer.addEventListener('pointerdown', function (e) {
      var handle = e.target.closest ? e.target.closest('.cv-h') : null;
      var resizer = e.target.closest ? e.target.closest('.cv-resize') : null;
      var node = e.target.closest ? e.target.closest('.cv-card') : null;
      if (!node) return;
      if (e.button !== undefined && e.button > 0) return;
      if (pointers.size > 1) return;                       // the pinch owns it
      // A control inside a card, or text being edited: no gesture at all. The
      // event must still stop here, or the viewport would start a pan behind it
      // and its pointer capture would swallow the click.
      if (e.target.getAttribute && e.target.getAttribute('contenteditable') === 'true') { e.stopPropagation(); return; }
      if (e.target.closest('button, .cv-chip, .cv-elabel')) { e.stopPropagation(); return; }
      if (S.tool === 'pen' && !handle && !resizer) return; // the pen draws over cards

      var card = findCard(node.dataset.id);
      if (!card) return;
      root.focus({ preventScroll: true });

      if (handle) {
        var from = sidePoint(card, handle.dataset.side, null);
        var line = svgEl('path', 'cv-edge cv-live', edgeLayer);
        G = { kind: 'edge', cardId: card.id, side: handle.dataset.side, from: from, line: line };
        view.setPointerCapture(e.pointerId);
      } else if (resizer) {
        G = { kind: 'resize', card: card, w0: card.width, h0: card.height,
              client: { x: e.clientX, y: e.clientY } };
        view.setPointerCapture(e.pointerId);
      } else {
        if (S.selection.indexOf(card.id) < 0) select([card.id], e.shiftKey);
        // Everything selected moves; a group takes the cards fully inside it.
        var ids = S.selection.slice();
        S.cards.forEach(function (c) {
          if (c.type === 'group' && ids.indexOf(c.id) >= 0) {
            S.cards.forEach(function (o) {
              if (o !== c && ids.indexOf(o.id) < 0 && rectInside(o, c)) ids.push(o.id);
            });
          }
        });
        G = {
          kind: 'card', card: card, additive: e.shiftKey, moved: false,
          client: { x: e.clientX, y: e.clientY },
          moving: ids.map(function (id) {
            var c = findCard(id);
            return c ? { card: c, x0: c.x, y0: c.y } : null;
          }).filter(Boolean)
        };
        // NB: no setPointerCapture here. Capturing retargets the compatibility
        // mouse events too, which would swallow a click on a button inside the
        // card. The capture is taken on the first real movement instead.
      }
      e.stopPropagation();
    });

    view.addEventListener('pointermove', function (e) {
      if (G && G.kind === 'card' && !G.moved &&
          (Math.abs(e.clientX - G.client.x) > 2 || Math.abs(e.clientY - G.client.y) > 2)) {
        G.moved = true;
        try { view.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      }
    }, true);

    // Double-clicking empty canvas is the second way to make a note, and the
    // fast one: the card lands where you looked and is already taking text.
    view.addEventListener('dblclick', function (e) {
      if (S.tool !== 'select') return;
      var t = e.target;
      var onEmpty = t === view || t === scene || t === cardLayer ||
        (t.classList && (t.classList.contains('cv-ink') || t.classList.contains('cv-edges') ||
                         t.classList.contains('cv-empty')));
      if (!onEmpty) return;
      var pt = toCanvas(e.clientX, e.clientY);
      var card = addCard({ type: 'note', text: '',
                           x: pt.x - SIZES.note.width / 2, y: pt.y - 18 });
      select([card.id]);
      editCard(card.id);
    });

    /* --- wheel and keys ------------------------------------------------ */

    view.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // ctrl+wheel is what a trackpad pinch sends; zoom about the pointer.
        zoomAt(e.clientX, e.clientY, S.zoom * Math.exp(-e.deltaY / 180));
      } else {
        S.pan.x -= e.deltaX;
        S.pan.y -= e.deltaY;
        applyTransform();
      }
    }, { passive: false });

    root.addEventListener('keydown', function (e) {
      var ae = document.activeElement;
      var typing = ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
      if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !typing) {
        e.preventDefault();
        var cardEl = e.target && e.target.closest ? e.target.closest('.cv-card') : null;
        var selected = cardEl ? findCard(cardEl.dataset.id) :
          (S.selection.length ? findCard(S.selection[S.selection.length - 1]) : null);
        if (selected) select([selected.id]);
        var r = selected && nodeEls[selected.id] && nodeEls[selected.id].getBoundingClientRect();
        if (r) showMenu({ card: selected }, r.left + r.width / 2, r.top + r.height / 2);
        else {
          var vr = view.getBoundingClientRect();
          showMenu({ point: centreOfView() }, vr.left + vr.width / 2, vr.top + vr.height / 2);
        }
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && !typing && S.selection.length) {
        e.preventDefault();
        removeCards(S.selection.slice());
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        if (undo()) e.preventDefault();
      } else if (e.key === 'Escape') {
        if (typing) { ae.blur(); return; }
        cancelGesture();
        if (S.tool !== 'select') setTool('select');
        else select([]);
      }
    });

    /* --- context menu --------------------------------------------------- *
     * This is ours, rather than the browser's generic menu, because the canvas
     * needs actions which make sense for cards. The menu uses real buttons so
     * arrows, Home/End, Enter/Space and Escape work without a mouse.
     * --------------------------------------------------------------------- */

    function hideMenu(returnFocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      menu.textContent = '';
      menuState = null;
      if (returnFocus) root.focus({ preventScroll: true });
    }

    function menuButton(label, run, separator, returnFocus, shortcut) {
      if (separator) el('div', 'cv-menu-sep', menu);
      var b = el('button', 'cv-menu-item', menu);
      b.type = 'button';
      b.textContent = label;
      if (shortcut) {
        var hint = el('kbd', 'cv-menu-key', b);
        hint.textContent = shortcut;
        hint.style.cssText = 'float:right;margin-left:1rem;font:inherit;color:var(--ink-2)';
        b.setAttribute('aria-keyshortcuts', 'Backspace Delete');
      }
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function () { hideMenu(returnFocus); run(); });
      return b;
    }

    function moveCardInStack(card, front) {
      if (!card) return;
      S.undo = snapshot();
      S.cards = S.cards.filter(function (c) { return c.id !== card.id; });
      if (front) S.cards.push(card); else S.cards.unshift(card);
      render();
      changed();
    }

    function addNoteAt(point) {
      var card = addCard({ type: 'note', text: '',
        x: point.x - SIZES.note.width / 2, y: point.y - SIZES.note.height / 2 });
      select([card.id]);
      editCard(card.id);
    }

    function showMenu(state, clientX, clientY) {
      hideMenu();
      menuState = state;
      var card = state.card;
      if (card) {
        menuButton('Delete', function () { removeCards([card.id]); }, false, true, 'Backspace / Delete');
        menuButton('Bring to front', function () { moveCardInStack(card, true); }, false, true);
        menuButton('Send to back', function () { moveCardInStack(card, false); }, false, true);
        menuButton('Copy text', function () { copyText(cardPlainText(card)); }, true);
        if (card.type === 'note' || card.type === 'excerpt') {
          menuButton('Edit text', function () { editCard(card.id); });
        }
        if (card.type !== 'link') {
          menuButton('Link to paragraph', function () { linkToCurrentParagraph(card); });
        }
      } else {
        menuButton('New note', function () { addNoteAt(state.point || centreOfView()); });
        menuButton('Pen', function () { setTool('pen'); });
        menuButton('Arrow', function () { setTool('arrow'); });
        menuButton('Fit canvas', fit, true);
        menuButton('Export workspace', exportCanvas);
      }
      var items = menu.querySelectorAll('.cv-menu-item');
      if (!items.length) { hideMenu(); return; }
      Array.prototype.forEach.call(items, function (item, i) { item.tabIndex = i ? -1 : 0; });
      menu.hidden = false;
      var left = clamp(clientX, 8, Math.max(8, global.innerWidth - menu.offsetWidth - 8));
      var top = clamp(clientY, 8, Math.max(8, global.innerHeight - menu.offsetHeight - 8));
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
      items[0].focus({ preventScroll: true });
    }

    function onMenuKey(e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('.cv-menu-item'));
      var at = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); hideMenu(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        if (!items.length) return;
        if (e.key === 'Home') at = 0;
        else if (e.key === 'End') at = items.length - 1;
        else at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[at].focus();
      }
    }

    function onMenuPointerDown(e) {
      if (!menu.hidden && !menu.contains(e.target)) hideMenu();
    }

    menu.addEventListener('keydown', onMenuKey);
    document.addEventListener('pointerdown', onMenuPointerDown, true);
    view.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var node = e.target.closest ? e.target.closest('.cv-card') : null;
      var card = node && findCard(node.dataset.id);
      if (card) select([card.id]);
      showMenu(card ? { card: card } : { point: toCanvas(e.clientX, e.clientY) }, e.clientX, e.clientY);
    });

    /* --- drop IN -------------------------------------------------------- *
     * A page selection arrives as text/plain plus application/x-castor-anchor.
     * A Files row arrives as application/x-castor-file; an operating-system file
     * arrives in dataTransfer.files. URLs and [[piece]] arrive as text. Everything
     * else becomes a note, which is the point: the canvas takes whatever you give it.
     * -------------------------------------------------------------------- */

    view.addEventListener('dragover', function (e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (t && Array.prototype.indexOf.call(t, MIME_CARD) >= 0) {
        // one of our own cards: not a target, so dragend reads dropEffect 'none'
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      view.classList.add('cv-dropping');
    });
    view.addEventListener('dragleave', function (e) {
      if (e.target === view) view.classList.remove('cv-dropping');
    });

    view.addEventListener('drop', function (e) {
      e.preventDefault();
      view.classList.remove('cv-dropping');
      var dt = e.dataTransfer;
      if (!dt) return;
      var pt = toCanvas(e.clientX, e.clientY);

      if (dt.types && Array.prototype.indexOf.call(dt.types, MIME_CARD) >= 0) return; // our own card

      var fileRaw = '';
      try { fileRaw = dt.getData(MIME_FILE) || ''; } catch (fileErr) { fileRaw = ''; }
      if (fileRaw) {
        var filePayload = null;
        try { filePayload = JSON.parse(fileRaw); } catch (fileJsonErr) { filePayload = null; }
        if (filePayload) { fileCardFromPayload(filePayload, pt); return; }
      }

      var anchorRaw = '';
      try { anchorRaw = dt.getData(MIME_ANCHOR); } catch (err) { anchorRaw = ''; }
      var text = '';
      try { text = dt.getData('text/plain') || ''; } catch (err2) { text = ''; }

      if (anchorRaw) {
        var anchor = null;
        try { anchor = JSON.parse(anchorRaw); } catch (err3) { anchor = null; }
        var quoted = text || (anchor && anchor.quote) || '';
        var card = addCard({ type: 'excerpt', text: quoted, anchor: anchor,
                             x: pt.x - SIZES.excerpt.width / 2, y: pt.y - 24 });
        select([card.id]);
        return;
      }

      var files = dt.files && dt.files.length ? Array.prototype.slice.call(dt.files) : [];
      if (files.length) {
        files.forEach(function (f, i) { fileCardFromFile(f, pt.x + i * 24, pt.y + i * 24); });
        return;
      }

      var uri = '';
      try { uri = dt.getData('text/uri-list') || ''; } catch (err4) { uri = ''; }
      dropText(uri.split('\n')[0] || text, pt);
    });

    function dropText(text, pt) {
      text = String(text || '').trim();
      if (!text) return;
      var wiki = wikiTarget(text);
      if (wiki) {
        addCard({ type: 'link', target: wiki, text: text, x: pt.x - SIZES.link.width / 2, y: pt.y - 20 });
      } else if (isUrl(text)) {
        addCard({ type: 'link', url: text, text: text, x: pt.x - SIZES.link.width / 2, y: pt.y - 20 });
      } else {
        addCard({ type: 'note', text: text, x: pt.x - SIZES.note.width / 2, y: pt.y - 24 });
      }
    }

    function fileKind(name, mime) {
      var match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
      if (match) return match[1].toUpperCase();
      var tail = String(mime || '').split('/').pop();
      return tail && tail !== 'octet-stream' ? tail.toUpperCase() : 'FILE';
    }

    function fileGroup(name, mime) {
      if (/^image\//.test(mime || '')) return 'images';
      if (/\.(md|txt|pdf|canvas)$/i.test(name || '') || /^(text\/|application\/pdf|application\/json)/.test(mime || '')) return 'documents';
      return 'other';
    }

    function fileCardFromPayload(payload, pt) {
      if (!payload || payload.type === 'folder') return null;
      var name = payload.name || String(payload.path || '').split('/').pop() || 'File';
      var mime = payload.type || 'application/octet-stream';
      var common = {
        text: name, path: payload.path || '', fileType: mime,
        kind: fileKind(name, mime), group: payload.group || fileGroup(name, mime),
        x: pt.x - SIZES.file.width / 2, y: pt.y - 24
      };
      var card;
      if (/^image\//.test(mime)) {
        common.type = 'image'; common.url = payload.dataUrl || payload.url || '';
        common.width = SIZES.image.width; common.height = SIZES.image.height;
        card = addCard(common);
      } else if (/\.md$/i.test(name) || mime === 'text/markdown') {
        common.type = 'link'; common.target = payload.path || name;
        common.width = SIZES.link.width; common.height = SIZES.link.height;
        card = addCard(common);
      } else {
        common.type = 'file';
        card = addCard(common);
      }
      select([card.id]);
      return card;
    }

    function readFile(file, done) {
      var reader = new FileReader();
      reader.onload = function () {
        done(String(reader.result || ''));
      };
      reader.onerror = function () { emit('files:error', { error: 'The dropped file could not be read.' }); };
      reader.readAsDataURL(file);
    }

    function fileCardFromFile(file, x, y) {
      var mime = file.type || 'application/octet-stream';
      var image = /^image\//.test(mime);
      var card = null;
      if (!image) {
        card = fileCardFromPayload({ name: file.name, type: mime, group: fileGroup(file.name, mime) }, { x: x, y: y });
      }
      readFile(file, function (dataUrl) {
        if (image) {
          card = addCard({ type: 'image', src: dataUrl, text: file.name || 'pasted-image',
            fileType: mime, kind: fileKind(file.name, mime), group: 'images',
            x: x - SIZES.image.width / 2, y: y - 24 });
          select([card.id]);
        }
        uploadFile(card, file.name || 'pasted-image', dataUrl, mime);
      });
      return card;
    }

    function uploadFile(card, name, dataUrl, declaredType) {
      if (!card || !/^https?:$/.test(location.protocol) || !pieceFolder) return Promise.resolve(null);
      var flight = fetch('/api/files/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ piece: pieceFolder, name: name, type: declaredType, data: dataUrl,
          who: Castor.who && (Castor.who.session ? Castor.who.session().map(function (person) { return person.id || { name: person.name, email: person.email }; }) : Castor.who.get()) })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) throw new Error(payload.error || ('The server returned ' + response.status));
          return payload.entry || payload;
        });
      }).then(function (entry) {
        card.path = entry.path || card.path;
        card.text = entry.name || String(entry.path || '').split('/').pop() || card.text;
        card.fileType = entry.type || card.fileType;
        card.kind = fileKind(card.text, card.fileType);
        card.group = entry.group || fileGroup(card.text, card.fileType);
        if (card.type === 'link') card.target = card.path || card.target;
        if (card.type === 'image') {
          delete S.images[card.id];
          card.url = entry.url || dataUrl;
        }
        render(); changed();
        emit('files:stored', entry);
        return entry;
      }).catch(function (error) {
        emit('files:error', { error: error.message, name: name });
        return null;
      });
      return Castor.saveStatus ? Castor.saveStatus.track(flight) : flight;
    }

    root.addEventListener('paste', function (e) {
      var ae = document.activeElement;
      if (ae && ae.isContentEditable) return;         // pasting into a card's text
      var cd = e.clipboardData;
      if (!cd) return;
      var pt = centreOfView();
      var items = cd.items ? Array.prototype.slice.call(cd.items) : [];
      var img = items.filter(function (i) { return /^image\//.test(i.type); })[0];
      if (img && img.getAsFile) { e.preventDefault(); fileCardFromFile(img.getAsFile(), pt.x, pt.y); return; }
      var text = cd.getData && cd.getData('text/plain');
      if (text) { e.preventDefault(); dropText(text, pt); }
    });

    /* --- drag OUT -------------------------------------------------------- *
     * A plain card always copies into the page. An anchored excerpt is different:
     * its explicit "Move paragraph" grip carries the source block's id, and our
     * capture listener below reorders that block before editor.js sees its generic
     * text/plain drop. A selection dropped FROM the page remains MIME_ANCHOR only,
     * therefore remains a reference rather than silently cutting the prose.
     * --------------------------------------------------------------------- */

    function cardPlainText(card) {
      if (card.type === 'link') {
        if (card.anchor) return '[[#' + String(card.anchor.quote || 'paragraph').slice(0, 48) + ']]';
        return card.target ? '[[' + card.target + ']]' : card.url;
      }
      if (card.type === 'image') {
        var name = card.path || (card.text && /\.[a-z0-9]{2,5}$/i.test(card.text) ? card.text : (card.id + '.png'));
        return '![[' + name + (card.resized ? '|' + card.width : '') + ']]';
      }
      if (card.type === 'file') return '[[' + (card.path || card.text || 'file') + ']]';
      return card.text || '';
    }

    function onCardDragStart(e, card) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var sourceBlock = null;
      if (card.type === 'excerpt' && card.anchor && card.anchor.blockId && Castor.editor &&
          typeof Castor.editor.getBlocks === 'function') {
        sourceBlock = Castor.editor.getBlocks().filter(function (b) { return b.id === card.anchor.blockId; })[0] || null;
      }
      card._movesBlock = !!sourceBlock;
      dt.effectAllowed = card._movesBlock ? 'move' : 'copyMove';
      dt.setData('text/plain', cardPlainText(card));
      dt.setData(MIME_CARD, JSON.stringify({
        id: card.id, type: card.type, text: card.text, url: card.url,
        target: card.target, anchor: card.anchor, width: card.width,
        path: card.path, name: card.text, fileType: card.fileType,
        kind: card.kind, group: card.group, dataUrl: card.path ? '' : (S.images[card.id] || '')
      }));
      if (sourceBlock) dt.setData(MIME_MOVE_BLOCK, JSON.stringify({
        cardId: card.id, blockId: sourceBlock.id
      }));
      card._altDrag = !!e.altKey;
      S.draggingOut = true;
    }

    function onCardDragEnd(e, card) {
      if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none' && card._altDrag) {
        removeCards([card.id]);      // Alt held: the card moves out instead of copying
      }
      card._altDrag = false; card._movesBlock = false; S.draggingOut = false; hidePageDropLine();
    }

    /* The editor owns the actual text insertion. This overlay only makes its
       existing drop position visible between page blocks, so it cannot create a
       second insertion path or disagree with the editor's source model. */
    function showPageDropLine(e) {
      if (!S.draggingOut || !pageEl || !articleEl || !pageEl.contains(e.target)) return;
      var blocks = Array.prototype.slice.call(articleEl.querySelectorAll(':scope > .cw-block'));
      if (!blocks.length) return;
      var at = blocks[blocks.length - 1].getBoundingClientRect().bottom;
      for (var i = 0; i < blocks.length; i++) {
        var r = blocks[i].getBoundingClientRect();
        if (e.clientY < Math.floor(r.top + r.height / 2)) { at = r.top; break; }
      }
      var ar = articleEl.getBoundingClientRect();
      dropLine.style.left = Math.round(ar.left) + 'px'; dropLine.style.top = Math.round(at - 1) + 'px';
      dropLine.style.width = Math.round(ar.width) + 'px'; dropLine.style.display = 'block';
    }
    function hidePageDropLine() { dropLine.style.display = 'none'; }
    function pageDragLeave(e) { if (!pageEl.contains(e.relatedTarget)) hidePageDropLine(); }

    function movePayload(dt) {
      var raw = '';
      try { raw = dt && dt.getData(MIME_MOVE_BLOCK); } catch (e) { raw = ''; }
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e2) { return null; }
    }

    function hasMoveMime(dt) {
      var types = dt && dt.types;
      return !!(types && Array.prototype.indexOf.call(types, MIME_MOVE_BLOCK) >= 0);
    }

    function modelInsertionAt(clientY) {
      var ed = Castor.editor;
      if (!ed || typeof ed.getBlocks !== 'function' || !articleEl) return null;
      var blocks = ed.getBlocks();
      var visible = Array.prototype.slice.call(articleEl.querySelectorAll(':scope > .cw-block'));
      if (!visible.length) return null;
      function modelIndex(id) {
        for (var j = 0; j < blocks.length; j++) if (blocks[j].id === id) return j;
        return -1;
      }
      for (var i = 0; i < visible.length; i++) {
        var rect = visible[i].getBoundingClientRect();
        if (clientY < Math.floor(rect.top + rect.height / 2)) {
          var beforeId = visible[i].getAttribute('data-block-id');
          var beforeAt = modelIndex(beforeId);
          return beforeAt < 0 ? null : beforeAt;
        }
      }
      var lastId = visible[visible.length - 1].getAttribute('data-block-id');
      var lastAt = modelIndex(lastId);
      return lastAt < 0 ? null : lastAt + 1;
    }

    function reorderParagraph(blockId, insertionIndex, cardId) {
      var ed = Castor.editor;
      if (!ed || typeof ed.getBlocks !== 'function' || typeof ed.replaceBlock !== 'function') return false;
      var blocks = ed.getBlocks();
      var from = -1;
      blocks.forEach(function (block, i) {
        if (block.id === blockId) from = i;
      });
      insertionIndex = clamp(Number(insertionIndex), 0, blocks.length);
      // Dropping directly before or after the source has no visible move, but it
      // is still consumed so editor.js cannot turn a no-op into a duplicate.
      if (from < 0 || insertionIndex === from || insertionIndex === from + 1) return false;

      var ordered = blocks.slice();
      var moved = ordered.splice(from, 1)[0];
      var at = insertionIndex;
      if (from < at) at -= 1;
      ordered.splice(at, 0, moved);
      if (ordered.every(function (block, i) { return block.source === blocks[i].source; })) return false;

      /* editor.js intentionally keeps stable positional ids, while anchors resolve
         by text. Replacing the changed source span is therefore a true block move:
         the old paragraph's source leaves its old position, rather than being
         copied beside it or replaced by an empty placeholder. */
      blocks.forEach(function (block, i) {
        if (block.source !== ordered[i].source) ed.replaceBlock(block.id, ordered[i].source);
      });
      var card = cardId && findCard(cardId);
      if (card && card.anchor) {
        card.anchor.blockId = blocks[at].id;
        card._movedBlock = true;
        changed();
      }
      emit('editor:move', { blockId: blockId, insertionIndex: insertionIndex });
      return true;
    }

    function onMoveParagraphDragOver(e) {
      if (!hasMoveMime(e.dataTransfer)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'move';
    }

    function onMoveParagraphDrop(e) {
      if (!hasMoveMime(e.dataTransfer)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hidePageDropLine();
      var payload = movePayload(e.dataTransfer);
      if (!payload) return;
      var insertionIndex = modelInsertionAt(e.clientY);
      if (insertionIndex != null) reorderParagraph(payload.blockId, insertionIndex, payload.cardId);
    }

    if (pageEl) {
      pageEl.addEventListener('dragover', showPageDropLine, true);
      pageEl.addEventListener('dragleave', pageDragLeave, true);
      pageEl.addEventListener('drop', hidePageDropLine, true);
      pageEl.addEventListener('pointerup', rememberCurrentBlock, true);
      // Capture at the page boundary, not only a block: real inter-paragraph
      // space is a valid move landing and must never reach editor.js as a copy.
      pageEl.addEventListener('dragover', onMoveParagraphDragOver, true);
      pageEl.addEventListener('drop', onMoveParagraphDrop, true);
    }
    document.addEventListener('selectionchange', rememberCurrentBlock);


    function cardToNode(c) {
      var n = { id: c.id, type: 'text', x: Math.round(c.x), y: Math.round(c.y),
                width: Math.round(c.width), height: Math.round(c.height) };
      if (c.type === 'group') { n.type = 'group'; if (c.label) n.label = c.label; return n; }
      if (c.type === 'link') {
        if (c.target) {
          n.type = 'file';
          n.file = c.path || (/\.md$/i.test(c.target) ? c.target : c.target + '.md');
        }
        else { n.type = 'link'; n.url = c.url || c.text || ''; }
        return n;
      }
      if (c.type === 'image') {
        n.type = 'file';
        n.file = c.path || (c.text && /\.[a-z0-9]{2,5}$/i.test(c.text) ? c.text : (c.id + '.png'));
        return n;
      }
      if (c.type === 'file') {
        n.type = 'file';
        n.file = c.path || c.text || (c.id + '.bin');
        return n;
      }
      n.text = c.text || '';
      return n;
    }

    function nodeToCard(n, extra) {
      var base = { id: n.id, x: n.x || 0, y: n.y || 0,
                   width: n.width || 200, height: n.height || 120 };
      var anchor = extra.anchors && extra.anchors[n.id];
      var held = extra.files && extra.files[n.id];
      if (n.type === 'group') { base.type = 'group'; base.label = n.label || 'Group'; return base; }
      if (n.type === 'link') { base.type = 'link'; base.url = n.url || ''; base.text = n.url || ''; return base; }
      if (n.type === 'file') {
        var img = extra.images && extra.images[n.id];
        if (held) {
          base.type = held.cardType || 'file';
          base.path = held.path || n.file || '';
          base.text = held.name || String(base.path).split('/').pop() || n.file || '';
          base.fileType = held.type || '';
          base.kind = held.kind || fileKind(base.text, base.fileType);
          base.group = held.group || fileGroup(base.text, base.fileType);
          base.url = held.url || (pieceFolder && base.path
            ? '/api/files/content?piece=' + encodeURIComponent(pieceFolder) + '&path=' + encodeURIComponent(base.path) : '');
          if (base.type === 'link') base.target = base.path || String(n.file || '').replace(/\.md$/i, '');
          if (base.type === 'image') { if (img) base.src = img; base.resized = true; }
          return base;
        }
        if (img) { base.type = 'image'; base.src = img; base.text = n.file || ''; base.resized = true; return base; }
        base.type = 'link';
        base.target = String(n.file || '').replace(/\.md$/i, '');
        base.text = '[[' + base.target + ']]';
        return base;
      }
      base.type = anchor ? 'excerpt' : 'note';
      base.text = n.text || '';
      base.anchor = anchor || null;
      return base;
    }

    function toJSON() {
      var anchors = {}, files = {};
      S.cards.forEach(function (c) { if (c.anchor) anchors[c.id] = c.anchor; });
      S.cards.forEach(function (c) {
        if (['image', 'file'].indexOf(c.type) < 0 && !(c.type === 'link' && c.path)) return;
        files[c.id] = {
          cardType: c.type, path: c.path || '', name: c.text || '', type: c.fileType || '',
          kind: c.kind || '', group: c.group || fileGroup(c.text, c.fileType),
          url: c.path ? '' : (c.url || '')
        };
      });
      return {
        nodes: S.cards.map(cardToNode),
        edges: S.edges.map(function (e) {
          var o = { id: e.id, fromNode: e.fromNode, toNode: e.toNode };
          if (e.fromSide) o.fromSide = e.fromSide;
          if (e.toSide) o.toSide = e.toSide;
          if (e.label) o.label = e.label;
          return o;
        }),
        'x-castor': {
          version: 1,
          strokes: S.strokes.map(function (s) {
            return { points: s.points, ink: s.ink, width: s.width };
          }),
          anchors: anchors,
          images: S.images,
          files: files
        }
      };
    }

    function load(json) {
      if (!json) return;
      if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) { return; } }
      var extra = json['x-castor'] || {};
      S.images = Object.assign({}, extra.images || {});
      S.cards = (json.nodes || []).map(function (n) { return nodeToCard(n, extra); })
        .map(function (c) {
          if (c.type === 'image' && c.src) { S.images[c.id] = c.src; delete c.src; }
          c.text = c.text || ''; c.url = c.url || ''; c.target = c.target || '';
          c.path = c.path || ''; c.fileType = c.fileType || ''; c.kind = c.kind || ''; c.group = c.group || '';
          c.label = c.label || ''; c.anchor = c.anchor || null;
          return c;
        });
      // Groups paint under everything else.
      S.cards.sort(function (a, b) { return (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1); });
      S.edges = (json.edges || []).map(function (e) {
        return { id: e.id || uid('e'), fromNode: e.fromNode, fromSide: e.fromSide || null,
                 toNode: e.toNode, toSide: e.toSide || null, label: e.label || '' };
      });
      S.strokes = (extra.strokes || []).map(function (s) {
        return { points: s.points || [], ink: s.ink || 'ink', width: s.width || 3.2 };
      });
      S.selection = [];
      S.undo = null;
      render();
      publishAnchors();
      refit();                 // the cards exist now; frame them if nothing has yet
    }

    /* --- persistence ------------------------------------------------------ */

    var legacyStoreKey = 'castor.' + world + '.canvas';
    var publicWorkspace = !!(Castor.role && Castor.role.publicWriter) || !!(Castor.app && Castor.app.data && Castor.app.data.publicWriter) || /^\/write(?:\/|$)/.test(location.pathname || '');
    var account = publicWorkspace ? confirmedAccount() : '';
    var primaryStoreKey = account ? legacyStoreKey + '.account.' + encodeURIComponent(account) + '.' + pieceFolder : null;
    var pageId = publicWorkspace ? publicCanvasPageId + '-' + (++publicCanvasWorkspaceSequence) : '';
    // Each instance owns its first journal key before any storage reads. A
    // remount in the same document cannot share the retired instance's slot.
    var storeKey = publicWorkspace ? (primaryStoreKey ? primaryStoreKey + '.recovery.page.' + pageId : null) : legacyStoreKey + '.' + pieceFolder;
    var originalWho = null;
    var generation = 0, retired = false;
    var saveTimer = null, saveQueue = Promise.resolve(), version = '', dirty = false, loaded = false;
    var serverReady = Promise.resolve(), blockedJournal = false, previewCopy = null, previewBefore = null, keepMineButton = null, recoveryGroup = null;

    function confirmedAccount() {
      var role = Castor.role;
      return role && role.confirmed && role.publicWriter && !!(Castor.people && Castor.people.isWriter(role.who)) && role.id === 'founder:' + role.who ? role.id : '';
    }
    function currentWho() {
      var who = Castor.who && (Castor.who.session ? Castor.who.session().map(function (person) { return person.id || { name: person.name, email: person.email }; }) : Castor.who.get && Castor.who.get());
      return who;
    }
    function capturedWho(who) { return typeof who === 'string' ? [who] : who; }
    function firstWriter(who) { return typeof who === 'string' ? who : Array.isArray(who) && typeof who[0] === 'string' ? who[0] : ''; }
    function sameAccount() { return !retired && (!publicWorkspace || !!account && confirmedAccount() === account && firstWriter(currentWho()) === account.slice('founder:'.length)); }
    function mayReplay() { return sameAccount(); }
    function accountError() {
      emit('files:error', { error: blockedJournal ? 'An older workspace recovery has no matching writer and was preserved. Export this workspace to keep your new work.' : 'This workspace stays with its original writer. Sign in as that writer before saving it to Git.', name: 'workspace.canvas' });
    }
    function rememberWho() {
      if (!publicWorkspace || originalWho) return;
      var selected = capturedWho(currentWho());
      originalWho = firstWriter(selected) === account.slice('founder:'.length) ? selected : [account.slice('founder:'.length)];
    }
    function lineage() { return { key: storeKey, session: JSON.stringify(originalWho), version: version, generation: generation, loaded: loaded }; }
    function currentLineage(attempt, compareVersion) {
      return !retired && (!publicWorkspace || sameAccount() && !blockedJournal && !previewCopy && loaded === attempt.loaded &&
        storeKey === attempt.key && JSON.stringify(originalWho) === attempt.session && generation === attempt.generation && (!compareVersion || version === attempt.version));
    }

    function journal(json) {
      if (retired) return;
      if (!storeKey || blockedJournal) { accountError(); return; }
      var record = { canvas: json, base: version, pending: true };
      if (publicWorkspace) { rememberWho(); record.schema = 1; record.world = world; record.piece = pieceFolder; record.account = account; record.who = originalWho; record.pageId = pageId; }
      try { localStorage.setItem(storeKey, JSON.stringify(record)); }
      catch (error) { emit('files:error', { error: 'The browser cannot keep this unsaved workspace.', name: 'workspace.canvas' }); }
    }

    function changed() {
      if (retired) return;
      if (previewCopy) { load(previewCopy.canvas); emit('files:error', { error: 'Return to your workspace or restore this copy before editing it.', name: 'workspace.canvas' }); return; }
      dirty = true;
      saveStatus.textContent = 'Unsaved workspace';
      empty.style.display = (S.cards.length || S.strokes.length) ? 'none' : '';
      publishAnchors();
      var json = toJSON();
      journal(json);
      emit('canvas:changed', json);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DEBOUNCE);
    }

    function save() {
      if (retired) return Promise.resolve(null);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (previewCopy) return Promise.resolve(null);
      if (blockedJournal) { accountError(); return Promise.resolve(null); }
      if (!loaded) {
        var waiting = lineage();
        return serverReady.then(function () { return loaded && (!publicWorkspace || storeKey === waiting.key && generation === waiting.generation && !previewCopy && !blockedJournal && sameAccount()) ? save() : null; });
      }
      var json = toJSON(), stamp = JSON.stringify(json);
      journal(json);
      var attempt = lineage();
      // Serialize bursts so a slow earlier request cannot overwrite a later one.
      saveQueue = saveQueue.then(function () { return serverReady; }).then(function () {
        if (!currentLineage(attempt, false)) return null;
        // Earlier queued saves may have advanced this record's base. Capture the
        // exact owned bytes at dispatch, never another page's replacement.
        var journalBytes = null;
        try {
          var bytes = localStorage.getItem(storeKey), held = JSON.parse(bytes || 'null');
          if (!publicWorkspace || held && held.pageId === pageId && held.account === account && JSON.stringify(held.canvas) === stamp) journalBytes = bytes;
        } catch (error) { /* no matching kept copy */ }
        return pushToServer(json).then(function (payload) {
          if (payload && payload.saved) {
            if (!currentLineage(attempt, false)) return null;
            if (!mayReplay()) { accountError(); return null; }
            version = payload.version || version;
            if (JSON.stringify(toJSON()) === stamp) {
              dirty = false;
              saveStatus.textContent = '';
              try {
                if (!publicWorkspace || journalBytes !== null && localStorage.getItem(storeKey) === journalBytes) localStorage.removeItem(storeKey);
                if (!publicWorkspace) localStorage.removeItem(legacyStoreKey);
              } catch (error) { /* blocked */ }
            } else journal(toJSON());
          }
          return payload;
        });
      });
      if (Castor.saveStatus) saveQueue = Castor.saveStatus.track(saveQueue);
      return saveQueue;
    }

    function pushToServer(json) {
      if (retired) return Promise.resolve(null);
      if (!loaded || !/^https?:$/.test(location.protocol) || !pieceFolder) return Promise.resolve(null);
      if (previewCopy) return Promise.resolve(null);
      if (blockedJournal || !mayReplay()) { accountError(); return Promise.resolve(null); }
      rememberWho();
      var who = publicWorkspace ? originalWho : currentWho();
      var attempt = lineage();
      if (!who || (Array.isArray(who) && !who.length)) {
        emit('files:error', { error: 'Choose who is writing to save this workspace.', name: 'workspace.canvas' });
        return Promise.resolve(null);
      }
      try {
        return freshWriter().then(function (allowed) {
          if (!currentLineage(attempt, true)) return null;
          if (!allowed || !mayReplay()) { accountError(); return null; }
          return fetch('/api/canvas?piece=' + encodeURIComponent(pieceFolder) +
          '&who=' + encodeURIComponent(JSON.stringify(who)) + '&base=' + encodeURIComponent(attempt.version), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json)
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (payload) {
            if (!currentLineage(attempt, true)) return null;
            if (!mayReplay()) throw new Error('The signed-in writer changed. The original workspace recovery is kept.');
            if (!response.ok) throw new Error(payload.error || ('The server returned ' + response.status));
            if (payload.entry) emit('files:stored', payload.entry);
            return payload;
          });
          });
        }).catch(function (error) { if (currentLineage(attempt, true)) emit('files:error', { error: error.message, name: 'workspace.canvas' }); return null; });
      } catch (error) { return Promise.resolve(null); }
    }

    function freshWriter() {
      if (!publicWorkspace) return Promise.resolve(true);
      return new Promise(function (resolve) {
        var finished = false;
        var abort = typeof global.AbortController === 'function' ? new global.AbortController() : null;
        var timer = setTimeout(function () { if (abort) abort.abort(); finish(false); }, 5000);
        function finish(value) { if (finished) return; finished = true; clearTimeout(timer); resolve(value); }
        try {
          fetch('/api/whoami', Object.assign({ cache: 'no-store' }, abort ? { signal: abort.signal } : {})).then(function (response) {
            return response.ok ? response.json() : null;
          }).then(function (identity) {
            finish(!!identity && identity.role === 'founder' && identity.publicWriter === true && identity.id === account && identity.who === account.slice('founder:'.length) && identity.offline !== true && mayReplay());
          }, function () { finish(false); });
        } catch (error) { finish(false); }
      });
    }

    // While an anchored card exists its passage keeps a faint mark in the page.
    // Whoever draws it (editor, comments) listens; nobody listening is fine.
    function publishAnchors() {
      var anchors = S.cards.filter(function (c) { return c.anchor; })
        .map(function (c) {
          var a = Object.assign({}, c.anchor);
          a._canvasCardId = c.id;
          return a;
        });
      emit('canvas:anchors', anchors);
    }

    function restore(data) {
      if (retired) return;
      if (publicWorkspace && !account) { accountError(); return; }
      var pending = null, legacy = null;
      try { pending = JSON.parse(localStorage.getItem(storeKey) || 'null');
        // Preserve the former account-wide journal as a migration copy. All new
        // writes and acknowledgments belong to this page's independent key.
        if (publicWorkspace && !pending) pending = JSON.parse(localStorage.getItem(primaryStoreKey) || 'null');
        if (!publicWorkspace) legacy = JSON.parse(localStorage.getItem(legacyStoreKey) || 'null'); } catch (error) { /* invalid cache */ }
      if (publicWorkspace && pending) {
        if (pending.account !== account || !Array.isArray(pending.who) || firstWriter(pending.who) !== account.slice('founder:'.length)) { pending = null; blockedJournal = true; accountError(); }
        else originalWho = pending.who;
      }
      if (!/^https?:$/.test(location.protocol) || !pieceFolder) {
        loaded = true;
        load((pending && pending.canvas) || legacy || data || { nodes: [], edges: [] });
        return;
      }
      // Git is loaded first. A pending journal is replayed only over its own base.
      serverReady = fetch('/api/canvas?state=1&piece=' + encodeURIComponent(pieceFolder)).then(function (response) {
        if (!response.ok) throw new Error('The workspace could not be loaded from Git.');
        return response.json();
      }).then(function (state) {
        if (retired) return;
        if (!sameAccount()) { accountError(); return; }
        version = state.version || '';
        loaded = true;
        var held = pending && pending.pending ? pending.canvas : legacy;
        if (!dirty) load(state.canvas);
        if (held && !dirty) {
          if ((pending && pending.base !== version) || (!pending && legacy && version)) {
            emit('files:error', { error: 'Unsaved workspace differs from Git. Your kept copy is shown. Export it or choose Keep mine.', name: 'workspace.canvas' });
            // Keep the pending copy visible and cached, but refuse to overwrite the newer Git version.
            load(held); version = pending ? pending.base : ''; loaded = false;
            offerKeepMine();
          } else { load(held); dirty = true; journal(held); saveTimer = setTimeout(save, SAVE_DEBOUNCE); }
        } else if (dirty) saveTimer = setTimeout(save, SAVE_DEBOUNCE);
        showRecoveredCopies();
      }).catch(function (error) {
        if (retired) return;
        if (!sameAccount()) { accountError(); return; }
        if (!dirty) load((pending && pending.canvas) || legacy || { nodes: [], edges: [] });
        emit('files:error', { error: error.message, name: 'workspace.canvas' });
        showRecoveredCopies();
      });
    }
    function offerKeepMine() {
      if (keepMineButton) return;
      var keepMine = keepMineButton = el('button', 'cv-tool', bar);
      keepMine.type = 'button'; keepMine.textContent = 'Keep mine';
      keepMine.addEventListener('click', function () {
        if (retired) return;
        if (!mayReplay() || previewCopy) { accountError(); return; }
        var attempt = lineage(), accepted = null;
        keepMine.disabled = true;
        fetch('/api/canvas?state=1&piece=' + encodeURIComponent(pieceFolder)).then(function (response) {
          if (!response.ok) throw new Error('The Git workspace cannot be read yet.');
          return response.json();
        }).then(function (current) {
          if (!currentLineage(attempt, true)) return null;
          if (!mayReplay()) throw new Error('The signed-in writer changed. The original workspace recovery is kept.');
          version = current.version || ''; loaded = true; dirty = true; generation++;
          accepted = lineage();
          return save();
        }).then(function (payload) {
          if (payload && payload.saved && currentLineage(accepted, false)) { keepMine.remove(); keepMineButton = null; }
          else keepMine.disabled = false;
        }).catch(function (error) { keepMine.disabled = false; if (currentLineage(accepted || attempt, false)) saveStatus.textContent = error.message; });
      });
    }
    function endPreview() {
      if (retired || !previewCopy) return;
      generation++;
      load(previewBefore.canvas); version = previewBefore.version; loaded = previewBefore.loaded; dirty = previewBefore.dirty;
      view.style.pointerEvents = ''; previewCopy = null; previewBefore = null;
    }
    function showRecoveredCopies() {
      if (retired) return;
      if (recoveryGroup) { recoveryGroup.remove(); recoveryGroup = null; }
      if (!publicWorkspace || !sameAccount()) return;
      var copies = pendingForAccount(account).filter(function (record) { return record.world === world && record.piece === pieceFolder && record.key !== storeKey; });
      if (!copies.length) return;
      var group = recoveryGroup = el('details', 'cv-tool', bar), title = el('summary', null, group);
      title.textContent = 'Recovered workspace copies (' + copies.length + ')';
      copies.forEach(function (record, index) {
        var row = el('div', null, group), compare = el('button', 'cv-tool', row), restoreCopy = el('button', 'cv-tool', row);
        compare.type = restoreCopy.type = 'button'; compare.textContent = 'View copy ' + (index + 1); restoreCopy.textContent = 'Restore copy ' + (index + 1);
        compare.addEventListener('click', function () {
          if (!sameAccount()) { accountError(); return; }
          endPreview(); if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
          generation++;
          previewBefore = { canvas: toJSON(), version: version, loaded: loaded, dirty: dirty };
          previewCopy = record; load(record.canvas); view.style.pointerEvents = 'none';
        });
        restoreCopy.addEventListener('click', function () {
          if (!sameAccount()) { accountError(); return; }
          endPreview();
          if (dirty) journal(toJSON());
          generation++;
          // Use a fresh independent key. Neither the previous workspace journal
          // nor the imported recovery is replaced by this explicit choice.
          storeKey = recoveryKey(pendingKey(record, account)); blockedJournal = false;
          originalWho = record.who; version = record.base; loaded = false; dirty = true;
          load(record.canvas); journal(record.canvas); saveStatus.textContent = 'Recovered workspace. Export it or choose Keep mine to save it to Git.';
          offerKeepMine();
        });
      });
      var back = el('button', 'cv-tool', group); back.type = 'button'; back.textContent = 'Return to workspace';
      back.addEventListener('click', endPreview);
    }
    function whoChanged() {
      if (retired) return;
      if (publicWorkspace && !mayReplay()) { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; if (dirty) journal(toJSON()); accountError(); return; }
      if (dirty) save();
    }
    function pageHidden() { if (!retired && dirty) journal(previewBefore ? previewBefore.canvas : toJSON()); }
    function retireWorkspace() {
      if (retired) return;
      if (publicWorkspace) {
        if (dirty && !blockedJournal && account) journal(previewBefore ? previewBefore.canvas : toJSON());
        retired = true; generation++;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
      } else if (saveTimer) { clearTimeout(saveTimer); save(); }
    }
    function workspaceError(detail) {
      var error = detail && detail.detail !== undefined ? detail.detail : detail;
      if (error) saveStatus.textContent = error.error;
    }
    on('files:error', workspaceError);
    on('canvas:recoveries', showRecoveredCopies);
    on('who:set', whoChanged);
    global.addEventListener('pagehide', pageHidden);

    /* --- fit and export ---------------------------------------------------- */

    function contentBounds() {
      var b = null;
      function grow(x, y, w, h) {
        if (!b) b = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        else {
          b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y);
          b.maxX = Math.max(b.maxX, x + w); b.maxY = Math.max(b.maxY, y + h);
        }
      }
      S.cards.forEach(function (c) { grow(c.x, c.y, c.width, c.height); });
      S.strokes.forEach(function (s) {
        var sb = strokeBounds(s);
        if (sb) grow(sb.minX, sb.minY, sb.maxX - sb.minX, sb.maxY - sb.minY);
      });
      return b;
    }

    function fit() {
      var b = contentBounds();
      var r = view.getBoundingClientRect();
      if (!b || !r.width || !r.height) { S.zoom = 1; S.pan.x = 0; S.pan.y = 0; applyTransform(); return; }
      var w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
      var z = clamp(Math.min((r.width - FIT_PAD) / w, (r.height - FIT_PAD) / h), MIN_ZOOM, MAX_ZOOM);
      S.zoom = z;
      S.pan.x = (r.width - w * z) / 2 - b.minX * z;
      S.pan.y = (r.height - h * z) / 2 - b.minY * z;
      applyTransform();
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(fallbackCopy);
        return;
      }
      fallbackCopy();
      function fallbackCopy() {
        var ta = el('textarea', null, root);
        ta.value = text;
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
        ta.remove();
      }
    }

    function exportCanvas() {
      var json = toJSON();
      var text = JSON.stringify(json, null, 2);
      copyText(text);
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var a = el('a', null, root);
        a.href = URL.createObjectURL(blob);
        a.download = 'workspace.canvas';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { /* download blocked; the clipboard copy still happened */ }
      pushToServer(json);
      emit('canvas:export', json);
      return json;
    }

    /* --- boot -------------------------------------------------------------- */

    syncTools();
    restore(opts.data);
    if (S.cards.length || S.strokes.length) fit();
    applyTransform();

    /* The panel is a sliding pane: at mount the view has no width yet, and every
       dock resize changes it again. A canvas that keeps its old transform through
       that shows a blank desk with the card off to one side, which is what the
       finish review saw. Refit whenever the view's own size changes and there is
       something to fit; an empty canvas keeps its empty line instead. */
    var fitRaf = 0, lastW = 0, lastH = 0, everFitted = false;
    function refit() {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(function () {
        fitRaf = 0;
        var r = view.getBoundingClientRect();
        if (!r.width || !r.height) return;
        var sameSize = Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1;
        if (sameSize && everFitted) return;
        lastW = r.width; lastH = r.height;
        if (S.cards.length || S.strokes.length) { fit(); everFitted = true; }
      });
    }
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(refit);
      ro.observe(view);
      S.resizeObserver = ro;
    }
    refit();

    var api = {
      el: root,
      world: world,
      addCard: addCard,
      removeCards: removeCards,
      toJSON: toJSON,
      load: load,
      fit: fit,
      undo: undo,
      save: save,
      exportCanvas: exportCanvas,
      setTool: setTool,
      getTool: function () { return S.tool; },
      state: S,
      destroy: function () {
        retireWorkspace();
        if (Castor.bus && Castor.bus.off) {
          Castor.bus.off('who:set', whoChanged);
          Castor.bus.off('files:error', workspaceError);
          Castor.bus.off('canvas:recoveries', showRecoveredCopies);
        }
        global.removeEventListener('pagehide', pageHidden);
        if (Castor.bonds) Castor.bonds.clear('workspace:');
        if (S.resizeObserver) { S.resizeObserver.disconnect(); S.resizeObserver = null; }
        if (pageEl) {
          pageEl.removeEventListener('dragover', showPageDropLine, true);
          pageEl.removeEventListener('dragleave', pageDragLeave, true);
          pageEl.removeEventListener('drop', hidePageDropLine, true);
          pageEl.removeEventListener('pointerup', rememberCurrentBlock, true);
          pageEl.removeEventListener('dragover', onMoveParagraphDragOver, true);
          pageEl.removeEventListener('drop', onMoveParagraphDrop, true);
        }
        document.removeEventListener('selectionchange', rememberCurrentBlock);
        document.removeEventListener('pointerdown', onMenuPointerDown, true);
        menu.removeEventListener('keydown', onMenuKey);
        menu.remove();
        dropLine.remove();
        root.remove();
      }
    };
    return api;
  }

  /* ------------------------------------------------------------------ *
   * Module surface
   * ------------------------------------------------------------------ */

  var active = null;

  function mount(bodyEl, opts) {
    if (!bodyEl) return null;
    if (active) active.destroy();
    active = createWorkspace(bodyEl, opts || {});
    return active;
  }

  on('piece:open', function () {
    if (!active || !active.el.parentNode) return;
    var host = active.el.parentNode;
    mount(host, { world: Castor.app && Castor.app.world });
  });

  function delegate(name) {
    return function () {
      if (!active) return null;
      return active[name].apply(active, arguments);
    };
  }

  var COMMANDS = [
    { id: 'workspace.open', title: 'Open workspace', run: function () { openPanel(); } },
    { id: 'workspace.export', title: 'Export canvas', run: function () { if (active) active.exportCanvas(); } },
    { id: 'workspace.pen', title: 'Pen', run: function () { if (active) active.setTool(active.getTool() === 'pen' ? 'select' : 'pen'); } },
    { id: 'workspace.arrow', title: 'Arrow', run: function () { if (active) active.setTool(active.getTool() === 'arrow' ? 'select' : 'arrow'); } },
    { id: 'workspace.fit', title: 'Fit', run: function () { if (active) active.fit(); } }
  ];

  function openPanel() {
    var p = Castor.panels;
    if (p && typeof p.open === 'function') { try { p.open('workspace', 'right'); return; } catch (e) { /* fall through */ } }
    if (p && typeof p.toggle === 'function') { try { p.toggle('workspace'); } catch (e2) { /* nothing to open */ } }
  }

  Castor.canvas = {
    mount: mount,
    pendingForAccount: pendingForAccount,
    validatePendingForAccount: validatePendingForAccount,
    restorePendingForAccount: restorePendingForAccount,
    addCard: delegate('addCard'),
    toJSON: delegate('toJSON'),
    load: delegate('load'),
    fit: delegate('fit'),
    undo: delegate('undo'),
    exportCanvas: delegate('exportCanvas'),
    setTool: delegate('setTool'),
    get instance() { return active; },
    commands: COMMANDS
  };

  /* Panel registration. panels.js may load before or after this file, so try
     now and again once the document is ready; commands.js gets the same
     treatment, and if its API is a shape we do not know, COMMANDS is still
     hanging on Castor.canvas for it to read. */
  var registered = false;
  function registerPanel() {
    if (registered) return;
    var p = Castor.panels;
    if (!p || typeof p.register !== 'function') return;
    try {
      p.register('workspace', {
        title: 'Workspace',
        mount: function (bodyEl) { return mount(bodyEl, { world: Castor.app && Castor.app.world }); }
      });
      registered = true;
    } catch (e) { /* a different panels API; app.js can call Castor.canvas.mount */ }
  }

  var commandsRegistered = false;
  function registerCommands() {
    if (commandsRegistered) return;
    var c = Castor.commands;
    if (!c) return;
    var fn = c.register || c.add || c.addCommand;
    if (typeof fn !== 'function') return;
    try {
      COMMANDS.forEach(function (cmd) {
        fn.call(c, { id: cmd.id, title: cmd.title, name: cmd.title, section: 'Workspace', run: cmd.run });
      });
      commandsRegistered = true;
    } catch (e) { /* commands.js will read Castor.canvas.commands instead */ }
  }

  function wire() { registerPanel(); registerCommands(); }
  wire();
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else setTimeout(wire, 0);
    document.addEventListener('castor:ready', wire);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.canvas;

})(typeof window !== 'undefined' ? window : globalThis);
