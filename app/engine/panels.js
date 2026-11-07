/* ============================================================================
   Castor engine — panels.js
   The docks: both sides, drag to reorder or move across, resize, separators,
   the article adapts, focus mode, the phone bottom sheet, persistence.

   Structure is CSS (engine.css); this file only changes state and writes two
   numbers during a drag. Three notes for whoever reads it next:

   - Width animates through a registered custom property, not through JS. open()
     sets a data attribute, CSS moves --dock-l-w / --dock-r-w, and the grid
     column carries the page with it. That is what "the article adapts" means:
     the page element IS the remaining column, and .page-column centres its
     measure inside whatever is left. No JS ever measures the page.
   - The one place JS does touch layout is a pointer drag: the dock's inner edge
     and the separator between two stacked panels. Both write a CSS variable and
     stop.
   - Mode (desktop / tablet / phone) is read from the app's OWN width with a
     ResizeObserver, never from the window, because the size switch renders the
     real viewport / 834 / 390 frame and a media query would lie.
   ========================================================================== */

(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});

  /* `beside` has no word in the top bar: it is opened by following a link or a
     file, never by asking for it. It is in the list so that it persists, gets a
     title, and can be closed like anything else. */
  var IDS = ['files', 'outline', 'comments', 'changes', 'drafts', 'workspace', 'links', 'live', 'beside'];
  var TITLES = {
    files: 'Files', outline: 'Outline', comments: 'Comments', changes: 'Changes',
    drafts: 'Versions', workspace: 'Workspace', links: 'Links', live: 'Live', beside: 'Beside'
  };
  var LEFT_BY_NATURE = { files: true, outline: true };
  function defaultSide(id) { return LEFT_BY_NATURE[id] ? 'left' : 'right'; }
  /* The side open() uses: where it already is if it is open (nothing jumps under
     the reader), then the writer's own placement, then what the caller asked for
     (every caller asks for the rule's own side), then the rule. */
  function pickSide(id, asked, openOn, placedOn) {
    return openOn || placedOn || asked || defaultSide(id);
  }
  /* Words the shells carry for panels that are not built. A word with nothing
     behind it promises something the app cannot do, so these stay out of the top
     bar, the palette and the stored desk until their module registers with
     ready:true. The code paths stay; a finished module appears by saying so. */
  var UNTIL_READY = { drafts: true, live: true, 'for-you': true, links: true };
  /* Panels this reader may never use (reviewer mode, app.js). Withheld is
     stronger than not-ready: no module can make one ready, and a desk stored in
     this browser cannot reopen one. */
  var withheld = {};
  var MIN_DOCK = 220;
  var MIN_PANEL_PX = 64;
  var DUR = 220;

  var els = { app: null, left: null, right: null, page: null, topbar: null };
  var reg = {};                       // id -> {title, mount, mounted, el, body}
  var layoutCbs = [];
  var mounted = false;
  var focusExit = null;
  var scrollTimers = new WeakMap(), scrollMotionWired = false;
  var marginRouting = false;
  var surface = {
    active: false, deck: null, secondary: null, body: null, divider: null,
    ratio: 0.58, collapsed: null, dragging: null
  };

  /* One semantic connector registry for the whole app. The layer exists in
     every world; only a world declaring --bonds:on paints registrations. */
  var bond = { layer: null, defs: null, group: null, items: {}, timer: null };

  var state = {
    world: 'dev',
    order: { left: [], right: [] },   // every id ever placed, in dock order
    open: {},                         // id -> true
    collapsed: {},                    // id -> header only, independent of open/closed
    share: {},                        // id -> flex-grow weight
    size: { left: 320, right: 340 },
    placed: {},                       // id -> side the writer put it on by hand
    focus: false,
    summoned: null,                   // focus mode: the one panel called back
    mode: 'desktop',
    activeSide: 'left',               // tablet: the dock currently shown
    recentPanel: null                 // phone projection, without closing the remembered desk
  };

  /* --- small helpers ------------------------------------------------------ */

  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  /* Native overlay scrollbars reveal themselves while a region is moving, then
     return to rest 800ms after its last scroll. One capture listener covers the
     page, docks, panels, canvas and any future scroller without module wiring. */
  function wireScrollMotion() {
    if (scrollMotionWired || typeof document === 'undefined') return;
    scrollMotionWired = true;
    document.addEventListener('scroll', function (e) {
      var target = e.target === document ? document.scrollingElement : e.target;
      if (!target || !target.classList) return;
      target.classList.add('is-scrolling');
      var old = scrollTimers.get(target); if (old) global.clearTimeout(old);
      scrollTimers.set(target, global.setTimeout(function () {
        target.classList.remove('is-scrolling'); scrollTimers.delete(target);
      }, 800));
      scheduleBonds();
    }, true);
  }

  function title(id) {
    return (reg[id] && reg[id].title) || TITLES[id] || (id.charAt(0).toUpperCase() + id.slice(1));
  }

  function isOpen(id) { return !!state.open[id]; }
  function isReady(id) { return !withheld[id] && (!UNTIL_READY[id] || !!(reg[id] && reg[id].ready)); }

  /* Every word for a panel that is not ready is hidden, wherever the phone bar
     has moved it (the More sheet lives inside the top bar too). */
  function applyReadiness() {
    var bar = els.topbar || (typeof document !== 'undefined' && document.getElementById('topbar'));
    if (!bar) return;
    var words = bar.querySelectorAll('[data-panel]');
    for (var i = 0; i < words.length; i++) {
      var ok = isReady(words[i].dataset.panel);
      if (words[i].hidden === ok) words[i].hidden = !ok;
    }
  }

  function openIds(side) {
    return state.order[side].filter(function (id) {
      return isOpen(id) && !(surface.active && id === 'workspace');
    });
  }

  /* What the dock actually shows. Focus mode keeps the arrangement untouched
     and shows nothing but the one panel you summon, so leaving focus gives you
     back exactly the desk you had. */
  function visibleIds(side) {
    if (state.focus) {
      return (state.summoned && sideOf(state.summoned) === side && isOpen(state.summoned))
        ? [state.summoned] : [];
    }
    var ids = openIds(side);
    return state.mode === 'phone' ? ids.filter(function (id) { return id === state.recentPanel; }) : ids;
  }

  function sideOf(id) {
    return state.order.left.indexOf(id) >= 0 ? 'left'
      : state.order.right.indexOf(id) >= 0 ? 'right' : null;
  }

  function storeKey() { return 'castor.' + state.world + '.panels'; }

  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({
        order: state.order,
        placed: state.placed,
        open: Object.keys(state.open),
        collapsed: Object.keys(state.collapsed),
        share: state.share,
        size: state.size,
        activeSide: state.activeSide,
        surface: surface.active ? { ratio: surface.ratio, collapsed: surface.collapsed } : null
      }));
    } catch (e) { /* private mode, a full disk: the app still works */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(storeKey()); } catch (e) { return; }
    if (!raw) return;
    try {
      var v = JSON.parse(raw);
      if (v.order && v.order.left && v.order.right) {
        state.order.left = v.order.left.filter(known);
        state.order.right = v.order.right.filter(known);
      }
      if (Array.isArray(v.open)) {
        v.open.filter(known).forEach(function (id) { if (!UNTIL_READY[id] && !withheld[id]) state.open[id] = true; });
      }
      if (v.placed && typeof v.placed === 'object') {
        Object.keys(v.placed).filter(known).forEach(function (id) {
          if (v.placed[id] === 'left' || v.placed[id] === 'right') state.placed[id] = v.placed[id];
        });
      }
      if (Array.isArray(v.collapsed)) v.collapsed.filter(known).forEach(function (id) { state.collapsed[id] = true; });
      if (v.share) state.share = v.share;
      if (v.size) {
        ['left', 'right'].forEach(function (side) {
          var size = Number(v.size[side]);
          if (isFinite(size) && size > 0) state.size[side] = Math.max(MIN_DOCK, size);
        });
      }
      if (v.activeSide === 'left' || v.activeSide === 'right') state.activeSide = v.activeSide;
      if (v.surface) {
        if (isFinite(v.surface.ratio)) surface.ratio = Math.max(0.28, Math.min(0.76, Number(v.surface.ratio)));
        if (v.surface.collapsed === 'primary' || v.surface.collapsed === 'secondary') {
          surface.collapsed = v.surface.collapsed;
        }
      }
    } catch (e) { /* a corrupt arrangement is not worth a broken app */ }
  }

  function known(id) { return IDS.indexOf(id) >= 0 || !!reg[id]; }

  function clampDock(px) {
    if (els.app && els.app.clientWidth > 0 && els.app.clientWidth < 700) return Math.max(MIN_DOCK, px);
    var max = els.app ? Math.floor(els.app.clientWidth * 0.4) : 640;
    return Math.max(MIN_DOCK, Math.min(px, Math.max(MIN_DOCK, max)));
  }

  function featureToken(name) {
    if (!global.getComputedStyle || !document.documentElement) return '';
    var style = Castor.frameReads ? Castor.frameReads.style(document.documentElement) : global.getComputedStyle(document.documentElement);
    return style.getPropertyValue(name).trim();
  }

  /* --- the optional sibling surface ------------------------------------ */

  function surfaceButton(word, side) {
    var b = el('button', 'surface-word', word);
    b.type = 'button'; b.dataset.surface = side;
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      setSurfaceCollapsed(surface.collapsed === side ? null : side);
    });
    return b;
  }

  function applySurface() {
    if (!surface.active || !surface.deck) return;
    surface.deck.style.setProperty('--surface-primary', Math.round(surface.ratio * 10000) / 100 + 'fr');
    surface.deck.style.setProperty('--surface-secondary', Math.round((1 - surface.ratio) * 10000) / 100 + 'fr');
    if (surface.collapsed) surface.deck.dataset.collapsed = surface.collapsed;
    else delete surface.deck.dataset.collapsed;
    var pageWord = surface.divider && surface.divider.querySelector('[data-surface="primary"]');
    var canvasWord = surface.divider && surface.divider.querySelector('[data-surface="secondary"]');
    if (pageWord) pageWord.textContent = surface.collapsed === 'primary' ? 'Show page' : 'Hide page';
    if (canvasWord) canvasWord.textContent = surface.collapsed === 'secondary' ? 'Show canvas' : 'Hide canvas';
  }

  function setSurfaceCollapsed(which, persist) {
    if (!surface.active) return;
    surface.collapsed = which === 'primary' || which === 'secondary' ? which : null;
    if (surface.collapsed === 'secondary') delete state.open.workspace;
    else state.open.workspace = true;
    applySurface();
    if (persist !== false) save();
    emit();
  }

  function mountSurfaceWorkspace() {
    if (!surface.active || !surface.body) return;
    var r = reg.workspace;
    if (!r || r.mounted || typeof r.mount !== 'function') return;
    r.body = surface.body;
    surface.body.textContent = '';
    delete surface.body.dataset.empty;
    ensureBody('workspace');
  }

  function onSurfacePointerDown(e) {
    if (e.button !== 0 || e.target.closest('.surface-word')) return;
    var r = surface.deck.getBoundingClientRect();
    surface.dragging = { left: r.left, width: r.width, pid: e.pointerId };
    surface.divider.dataset.dragging = '1';
    surface.divider.setPointerCapture(e.pointerId);
    els.app.dataset.resizing = '1';
    global.addEventListener('pointermove', onSurfacePointerMove);
    global.addEventListener('pointerup', onSurfacePointerUp, { once: true });
    e.preventDefault();
  }

  function onSurfacePointerMove(e) {
    if (!surface.dragging) return;
    surface.ratio = Math.max(0.28, Math.min(0.76,
      (e.clientX - surface.dragging.left) / Math.max(1, surface.dragging.width)));
    surface.collapsed = null;
    state.open.workspace = true;
    applySurface();
    layoutBonds();
  }

  function onSurfacePointerUp() {
    global.removeEventListener('pointermove', onSurfacePointerMove);
    if (!surface.dragging) return;
    surface.dragging = null;
    if (surface.divider) delete surface.divider.dataset.dragging;
    if (els.app) delete els.app.dataset.resizing;
    save(); emit();
  }

  function onSurfaceKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    surface.collapsed = null;
    state.open.workspace = true;
    surface.ratio = Math.max(0.28, Math.min(0.76,
      surface.ratio + (e.key === 'ArrowRight' ? 0.025 : -0.025)));
    applySurface(); save(); emit(); e.preventDefault();
  }

  function setupSurface() {
    var raw = featureToken('--surface-split');
    if (!raw || raw === 'off') return;
    var ratio = parseFloat(raw);
    if (isFinite(ratio)) surface.ratio = ratio > 1 ? ratio / 100 : ratio;
    surface.ratio = Math.max(0.28, Math.min(0.76, surface.ratio));
    surface.active = true;
    els.app.dataset.surfaceSplit = 'on';

    var deck = el('div', 'surface-deck');
    deck.setAttribute('data-surface-deck', '1');
    var divider = el('div', 'surface-divider');
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', 'Resize the page and canvas');
    var actions = el('div', 'surface-divider-actions');
    actions.appendChild(surfaceButton('Hide page', 'primary'));
    actions.appendChild(surfaceButton('Hide canvas', 'secondary'));
    divider.appendChild(actions);
    var secondary = el('section', 'surface-secondary');
    secondary.id = 'surface-secondary';
    secondary.setAttribute('aria-label', 'Workspace canvas');
    var body = el('div', 'surface-workspace');
    body.id = 'surface-workspace';
    secondary.appendChild(body);

    els.app.insertBefore(deck, els.page);
    deck.appendChild(els.page);
    deck.appendChild(divider);
    deck.appendChild(secondary);
    surface.deck = deck; surface.secondary = secondary; surface.body = body; surface.divider = divider;
    divider.addEventListener('pointerdown', onSurfacePointerDown);
    divider.addEventListener('keydown', onSurfaceKey);
    if (surface.collapsed !== 'secondary') state.open.workspace = true;
    applySurface();
    mountSurfaceWorkspace();
  }

  /* --- the optional semantic connector layer ---------------------------- */

  function svg(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

  function setupBondLayer() {
    if (bond.layer || !els.app) return;
    var layer = svg('svg');
    layer.setAttribute('class', 'castor-bond-layer');
    layer.setAttribute('aria-hidden', 'true');
    var defs = svg('defs'), group = svg('g');
    layer.appendChild(defs); layer.appendChild(group); els.app.appendChild(layer);
    bond.layer = layer; bond.defs = defs; bond.group = group;
  }

  function endpoint(value) {
    var out = typeof value === 'function' ? value() : value;
    if (typeof out === 'string') out = document.querySelector(out);
    return out && out.nodeType === 1 ? out : null;
  }

  function edgePoint(a, b) {
    var acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    var bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
    var dx = bcx - acx, dy = bcy - acy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx >= 0 ? a.right : a.left, y: acy };
    }
    return { x: acx, y: dy >= 0 ? a.bottom : a.top };
  }

  function roleColour(role) {
    return role === 'human' ? 'var(--mortal)' : role === 'agent' ? 'var(--immortal)' : null;
  }

  function crossesRoles(item) {
    return (item.fromRole === 'human' && item.toRole === 'agent') ||
      (item.fromRole === 'agent' && item.toRole === 'human');
  }

  function layoutBonds() {
    if (!bond.layer) return;
    bond.defs.textContent = ''; bond.group.textContent = '';
    if (featureToken('--bonds') !== 'on') return;
    var base = els.app.getBoundingClientRect();
    if (!base.width || !base.height) return;
    bond.layer.setAttribute('viewBox', '0 0 ' + Math.round(base.width) + ' ' + Math.round(base.height));
    Object.keys(bond.items).forEach(function (id, index) {
      var item = bond.items[id], from = endpoint(item.from), to = endpoint(item.to);
      if (!from || !to) return;
      var fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect();
      if (!fr.width || !fr.height || !tr.width || !tr.height) return;
      var a = edgePoint(fr, tr), b = edgePoint(tr, fr);
      a.x -= base.left; a.y -= base.top; b.x -= base.left; b.y -= base.top;
      var path = svg('path');
      path.setAttribute('class', 'castor-bond');
      path.setAttribute('data-bond-id', id);
      path.setAttribute('data-bond-kind', item.kind || 'relation');
      path.setAttribute('d', 'M' + Math.round(a.x * 10) / 10 + ' ' + Math.round(a.y * 10) / 10 +
        ' L' + Math.round(b.x * 10) / 10 + ' ' + Math.round(b.y * 10) / 10);
      if (crossesRoles(item)) {
        var gid = 'castor-bond-gradient-' + index;
        var grad = svg('linearGradient');
        grad.id = gid; grad.setAttribute('gradientUnits', 'userSpaceOnUse');
        grad.setAttribute('x1', a.x); grad.setAttribute('y1', a.y);
        grad.setAttribute('x2', b.x); grad.setAttribute('y2', b.y);
        var s1 = svg('stop'), s2 = svg('stop');
        s1.setAttribute('offset', '0'); s2.setAttribute('offset', '1');
        s1.style.stopColor = roleColour(item.fromRole); s2.style.stopColor = roleColour(item.toRole);
        grad.appendChild(s1); grad.appendChild(s2); bond.defs.appendChild(grad);
        path.style.stroke = 'url(#' + gid + ')';
        path.setAttribute('data-bond-gradient', item.fromRole + '-to-' + item.toRole);
      }
      bond.group.appendChild(path);
    });
  }

  function scheduleBonds() {
    if (bond.timer) return;
    bond.timer = global.setTimeout(function () { bond.timer = null; layoutBonds(); }, 0);
  }

  /* Margin modules know where their own anchor is, but only the engine can see
     footnotes, comments, and change notes together. Stack the three families in
     one lane after each module has stamped its unmodified anchor position. */
  var marginRaf = 0, marginObserver = null, marginObserved = new Set();
  function routeMargins(immediate) {
    if (!els.page) return;
    if (immediate === true) {
      if (marginRaf) global.cancelAnimationFrame(marginRaf);
      placeMargins();
      return;
    }
    if (marginRaf) return;
    marginRaf = global.requestAnimationFrame(placeMargins);
  }

  function placeMargins() {
    marginRaf = 0;
    if (!els.page) return;
    var nodes = Array.prototype.slice.call(els.page.querySelectorAll(
      '.footnote-margin[data-margin-at], .gutter-note[data-margin-at], ' +
      '.castor-thread-slot[data-margin-route="comment"][data-margin-at]'));
    var anchors = {}, parents = new Map();
    if (nodes.some(function (node) { return node.dataset.marginAnchor; })) {
      Array.prototype.forEach.call(els.page.querySelectorAll('[data-block-id]'), function (block) {
        anchors[block.getAttribute('data-block-id')] = block.getBoundingClientRect().top;
      });
    }
    if (!marginObserver && global.ResizeObserver) marginObserver = new global.ResizeObserver(routeMargins);
    if (marginObserver) {
      var next = new Set(nodes.concat([els.page]));
      marginObserved.forEach(function (node) { if (!next.has(node)) marginObserver.unobserve(node); });
      next.forEach(function (node) { if (!marginObserved.has(node)) marginObserver.observe(node); });
      marginObserved = next;
    }
    var measured = nodes.map(function (node) {
      var style = Castor.frameReads ? Castor.frameReads.style(node) : global.getComputedStyle(node);
      var parent = node.offsetParent || node.parentElement;
      if (parent && !parents.has(parent)) parents.set(parent, parent.getBoundingClientRect().top + (parent.clientTop || 0));
      var base = parent ? parents.get(parent) : 0;
      var top = anchors[node.dataset.marginAnchor];
      if (top == null) top = (Number(node.dataset.marginAt) || 0) + base;
      return { node: node, top: top, base: base,
        absolute: style.position === 'absolute' && style.display !== 'none', height: node.getBoundingClientRect().height };
    }).sort(function (a, b) {
      return a.top - b.top;
    });
    var floor = -1e9;
    measured.forEach(function (item) {
      var wanted = item.absolute ? Math.max(item.top, floor) : item.top;
      var top = Math.ceil(wanted - item.base);
      item.node.style.setProperty('--at', top + 'px');
      if (item.node.style.top) item.node.style.top = top + 'px';
      if (item.absolute) floor = top + item.base + item.height + 12;
    });
    scheduleBonds();
  }

  var bondsApi = {
    register: function (id, spec) {
      if (!id || !spec) return bondsApi;
      bond.items[id] = spec; scheduleBonds(); return bondsApi;
    },
    unregister: function (id) { delete bond.items[id]; scheduleBonds(); return bondsApi; },
    clear: function (prefix) {
      Object.keys(bond.items).forEach(function (id) {
        if (!prefix || id.indexOf(prefix) === 0) delete bond.items[id];
      });
      scheduleBonds(); return bondsApi;
    },
    layout: layoutBonds,
    layer: function () { return bond.layer; },
    list: function () { return Object.keys(bond.items); }
  };
  Castor.bonds = bondsApi;

  /* --- the panel element -------------------------------------------------- */

  function grip() {
    /* a drag handle drawn in one stroke: two rules, no glyph, no emoji */
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '12'); svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 12 12'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M2 4.5h8M2 7.5h8"/>';
    return svg;
  }

  function panelEl(id) {
    if (reg[id] && reg[id].el) return reg[id].el;
    var sec = el('section', 'panel');
    sec.dataset.panelId = id;

    var head = el('header', 'panel-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'group');
    head.setAttribute('aria-label', title(id) + ' panel. Alt with the arrow keys moves it.');
    var g = el('span', 'panel-grip'); g.appendChild(grip()); g.setAttribute('aria-hidden', 'true');
    var h = el('h2', 'panel-title', title(id));
    var close = el('button', 'word panel-close', 'Close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close ' + title(id));
    close.addEventListener('click', function (e) { e.stopPropagation(); api.close(id); });
    var fold = el('button', 'word panel-collapse', 'Collapse');
    fold.type = 'button';
    fold.setAttribute('aria-controls', 'panel-body-' + id);
    // Leave native button activation intact, but do not let Space reach the
    // editor's document-level "type anywhere" handler.
    fold.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
    });
    fold.addEventListener('click', function (e) {
      e.stopPropagation();
      api.collapse(id, !state.collapsed[id]);
    });
    head.appendChild(g); head.appendChild(h); head.appendChild(fold); head.appendChild(close);

    var body = el('div', 'panel-body');
    body.id = 'panel-body-' + id;

    sec.appendChild(head); sec.appendChild(body);
    head.addEventListener('pointerdown', onHeadPointerDown);
    head.addEventListener('keydown', onHeadKey);

    reg[id] = reg[id] || { title: TITLES[id], mount: null, mounted: false };
    reg[id].el = sec; reg[id].body = body; reg[id].head = head; reg[id].fold = fold;
    return sec;
  }

  function ensureBody(id) {
    var r = reg[id];
    if (!r || !r.body || r.mounted) return;
    if (typeof r.mount === 'function') {
      r.mounted = true;
      try {
        r.mount(r.body);
      } catch (e) {
        r.body.dataset.empty = '1';
        r.body.textContent = title(id) + ' failed to start: ' + (e && e.message ? e.message : e);
      }
    } else {
      /* nothing registered yet: say so plainly, and stay replaceable */
      r.body.dataset.empty = '1';
      r.body.textContent = title(id) + ' is not built yet';
    }
  }

  /* --- rendering ---------------------------------------------------------- */

  function scaffold(dockEl) {
    if (dockEl.querySelector('.dock-clip')) return;
    var clip = el('div', 'dock-clip');
    var inner = el('div', 'dock-inner');
    var grab = el('div', 'sheet-grabber');
    grab.setAttribute('aria-hidden', 'true');
    grab.addEventListener('pointerdown', onSheetPointerDown);
    inner.appendChild(grab);
    clip.appendChild(inner);
    var rez = el('div', 'dock-resizer');
    rez.setAttribute('role', 'separator');
    rez.setAttribute('aria-orientation', 'vertical');
    rez.tabIndex = 0;
    rez.addEventListener('pointerdown', onResizePointerDown);
    rez.addEventListener('keydown', onResizeKey);
    dockEl.appendChild(clip);
    dockEl.appendChild(rez);
  }

  function renderSide(side) {
    var dock = els[side];
    if (!dock) return;
    var inner = dock.querySelector('.dock-inner');
    var grab = inner.querySelector('.sheet-grabber');
    var ids = visibleIds(side);
    /* Collapse exists to share a column between stacked panels. A panel alone in
       its column always shows its body and offers no Collapse. */
    var stacked = ids.length > 1;
    if (!stacked) ids.forEach(function (id) { delete state.collapsed[id]; });

    var wanted = grab ? [grab] : [];
    var separators = Array.prototype.slice.call(inner.querySelectorAll('.panel-sep'));
    var expanded = ids.filter(function (id) { return !state.collapsed[id]; });
    var total = expanded.reduce(function (sum, id) { return sum + (Number(state.share[id]) > 0 ? Number(state.share[id]) : 1); }, 0);
    var previous = null, sepIndex = 0;
    ids.forEach(function (id, i) {
      var collapsed = !!state.collapsed[id];
      if (!collapsed && previous) {
        var sep = separators[sepIndex++] || separator(side, i);
        sep.dataset.side = side; sep.dataset.index = String(i); sep.dataset.before = previous;
        wanted.push(sep);
      }
      var p = panelEl(id), weight = Number(state.share[id]) > 0 ? Number(state.share[id]) : 1;
      // Flex weights below one leave free space unused. Normalize the visible
      // expanded panels, preserving the writer's saved ratios underneath.
      p.style.setProperty('--share', String(collapsed ? 0 : weight / total * expanded.length));
      p.dataset.collapsed = collapsed ? '1' : '0';
      reg[id].body.hidden = collapsed;
      reg[id].fold.textContent = collapsed ? 'Expand' : 'Collapse';
      reg[id].fold.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      reg[id].fold.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + title(id));
      reg[id].fold.hidden = !stacked;
      wanted.push(p);
      ensureBody(id);
      if (!collapsed) previous = id;
    });
    /* Leave surviving panels attached. Rebuilding their fragment on a resize
       blurs a focused control even though its panel stays on the same side. */
    Array.prototype.slice.call(inner.children).forEach(function (node) {
      if (wanted.indexOf(node) < 0) inner.removeChild(node);
    });
    wanted.forEach(function (node, index) {
      if (inner.children[index] !== node) inner.insertBefore(node, inner.children[index] || null);
    });

    dock.dataset.collapsedOnly = ids.length && !expanded.length ? '1' : '0';
    dock.dataset.open = ids.length && shows(side) ? '1' : '0';
    dock.setAttribute('aria-hidden', ids.length && shows(side) ? 'false' : 'true');
  }

  /* On iPad only one dock is shown at a time; the other keeps its panels and
     collapses to its words in the top bar. */
  function shows(side) {
    if (state.mode === 'tablet' || state.mode === 'phone') return state.activeSide === side;
    return true;
  }

  function separator(side, index) {
    var s = el('div', 'panel-sep');
    s.dataset.side = side;
    s.dataset.index = String(index);
    s.setAttribute('role', 'separator');
    s.setAttribute('aria-orientation', 'horizontal');
    s.tabIndex = 0;
    s.addEventListener('pointerdown', onSepPointerDown);
    s.addEventListener('keydown', onSepKey);
    return s;
  }

  function apply() {
    if (!els.app) return;
    els.app.dataset.leftOpen = (visibleIds('left').length && shows('left')) ? '1' : '0';
    els.app.dataset.rightOpen = (visibleIds('right').length && shows('right')) ? '1' : '0';
    els.app.dataset.focus = state.focus ? 'on' : 'off';
    if (focusExit) focusExit.hidden = !state.focus;
    /* in focus mode a panel you summon comes back on its own, one at a time,
       while the top bar and the agent line stay away */
    els.app.dataset.summoned = (state.focus && state.summoned) ? '1' : '0';
    els.app.style.setProperty('--dock-l-size', clampDock(state.size.left) + 'px');
    els.app.style.setProperty('--dock-r-size', clampDock(state.size.right) + 'px');
    applySurface();
  }

  var emitTimer = null;
  var CORNER_W = 88, CORNER_H = 64;
  function watchCorner() {
    if (watchCorner.on) return;
    watchCorner.on = true;
    focusExit = el('button', 'word focus-exit', 'Exit Zen');
    focusExit.type = 'button';
    focusExit.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    focusExit.addEventListener('click', function () { api.focus(false); });
    els.app.appendChild(focusExit);
    document.addEventListener('pointermove', function (e) {
      if (!state.focus || e.pointerType === 'touch') return;
      if (e.clientX <= CORNER_W && e.clientY <= CORNER_H) api.focus(false);
    }, { passive: true });
  }

  function sync(persist) {
    normaliseSide();
    renderSide('left');
    renderSide('right');
    apply();
    if (persist !== false) save();
    emit();
    /* the dock is still travelling: tell the modules again when it lands, so
       comments.js can put its cards level with the passages */
    clearTimeout(emitTimer);
    emitTimer = setTimeout(emit, DUR + 30);
  }

  function info() {
    return {
      mode: state.mode,
      focus: state.focus,
      summoned: state.summoned,
      activeSide: state.activeSide,
      left: { ids: openIds('left'), shown: shows('left'), size: state.size.left, visible: shows('left') ? visibleIds('left') : [] },
      right: { ids: openIds('right'), shown: shows('right'), size: state.size.right, visible: shows('right') ? visibleIds('right') : [] },
      open: Object.keys(state.open),
      surface: surface.active ? {
        active: true, ratio: surface.ratio, collapsed: surface.collapsed,
        workspace: surface.secondary
      } : { active: false }
    };
  }

  function emit() {
    var i = info();
    layoutCbs.forEach(function (cb) { try { cb(i); } catch (e) { console.error(e); } });
    if (Castor.bus && Castor.bus.emit) Castor.bus.emit('layout', i);
    layoutBonds();
  }

  /* --- dragging a panel head ---------------------------------------------- */

  var drag = null;

  function onHeadPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;
    if (state.mode === 'phone') return;              // the sheet swipes instead
    var sec = e.currentTarget.closest('.panel');
    drag = {
      id: sec.dataset.panelId, sec: sec, x0: e.clientX, y0: e.clientY,
      live: false, ghost: null, ind: null, target: null, pid: e.pointerId
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onHeadPointerMove);
    window.addEventListener('pointerup', onHeadPointerUp, { once: true });
  }

  function onHeadPointerMove(e) {
    if (!drag) return;
    if (!drag.live) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 5) return;
      drag.live = true;
      drag.sec.dataset.dragging = '1';
      drag.ghost = el('div', 'panel-ghost', title(drag.id));
      document.body.appendChild(drag.ghost);
      drag.ind = el('div', 'drop-indicator');
    }
    drag.ghost.style.left = (e.clientX + 12) + 'px';
    drag.ghost.style.top = (e.clientY - 10) + 'px';
    var t = dropTarget(e.clientX, e.clientY);
    drag.target = t;
    showIndicator(t);
  }

  function onHeadPointerUp() {
    window.removeEventListener('pointermove', onHeadPointerMove);
    if (!drag) return;
    var d = drag; drag = null;
    if (d.ghost) d.ghost.remove();
    if (d.ind) d.ind.remove();
    delete d.sec.dataset.dragging;
    els.left.removeAttribute('data-drop-target');
    els.right.removeAttribute('data-drop-target');
    if (!d.live || !d.target) return;
    move(d.id, d.target.side, d.target.index);
  }

  function dropTarget(x, y) {
    var appR = els.app.getBoundingClientRect();
    var lR = els.left.getBoundingClientRect();
    var rR = els.right.getBoundingClientRect();
    var side;
    if (lR.width > 4 && x >= lR.left && x <= lR.right) side = 'left';
    else if (rR.width > 4 && x >= rR.left && x <= rR.right) side = 'right';
    else side = (x < appR.left + appR.width / 2) ? 'left' : 'right';   // page edge opens that dock

    var ids = visibleIds(side).filter(function (id) { return id !== (drag && drag.id); });
    var index = ids.length;
    for (var i = 0; i < ids.length; i++) {
      var r = reg[ids[i]].el.getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    return { side: side, index: index };
  }

  function showIndicator(t) {
    els.left.removeAttribute('data-drop-target');
    els.right.removeAttribute('data-drop-target');
    els[t.side].dataset.dropTarget = '1';
    var inner = els[t.side].querySelector('.dock-inner');
    var ids = visibleIds(t.side).filter(function (id) { return id !== drag.id; });
    var before = ids[t.index] ? reg[ids[t.index]].el : null;
    if (before) inner.insertBefore(drag.ind, before);
    else inner.appendChild(drag.ind);
  }

  function move(id, side, index) {
    var from = sideOf(id);
    if (from) state.order[from].splice(state.order[from].indexOf(id), 1);
    var ids = openIds(side);
    var at = ids[index] ? state.order[side].indexOf(ids[index]) : state.order[side].length;
    state.order[side].splice(at < 0 ? state.order[side].length : at, 0, id);
    state.placed[id] = side;          // a hand-made placement: it outranks the rule
    state.open[id] = true;
    state.activeSide = side;
    state.recentPanel = id;
    sync();
  }

  function onHeadKey(e) {
    if (!e.altKey) return;
    var id = e.currentTarget.closest('.panel').dataset.panelId;
    var side = sideOf(id);
    var ids = openIds(side);
    var i = ids.indexOf(id);
    /* the index is read against the list WITHOUT this panel, so one step down
       is i + 1, not i + 2 */
    if (e.key === 'ArrowUp' && i > 0) { move(id, side, i - 1); }
    else if (e.key === 'ArrowDown' && i < ids.length - 1) { move(id, side, i + 1); }
    else if (e.key === 'ArrowLeft' && side === 'right') { move(id, 'left', openIds('left').length); }
    else if (e.key === 'ArrowRight' && side === 'left') { move(id, 'right', openIds('right').length); }
    else return;
    e.preventDefault();
    var head = reg[id].head;
    if (head) head.focus();
  }

  /* --- resizing the dock's inner edge ------------------------------------- */

  var rez = null;

  function onResizePointerDown(e) {
    if (e.button !== 0) return;
    var dock = e.currentTarget.closest('.dock');
    var side = dock === els.left ? 'left' : 'right';
    rez = { side: side, pid: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.dragging = '1';
    els.app.dataset.resizing = '1';     // kill the width transition while dragging
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeUp, { once: true });
    e.preventDefault();
  }

  function onResizeMove(e) {
    if (!rez) return;
    var r = els[rez.side].getBoundingClientRect();
    var px = rez.side === 'left' ? (e.clientX - r.left) : (r.right - e.clientX);
    state.size[rez.side] = clampDock(Math.round(px));
    apply();
  }

  function onResizeUp() {
    window.removeEventListener('pointermove', onResizeMove);
    if (!rez) return;
    var d = els[rez.side].querySelector('.dock-resizer');
    if (d) delete d.dataset.dragging;
    rez = null;
    els.app.removeAttribute('data-resizing');
    save();
    emit();
  }

  function onResizeKey(e) {
    var side = e.currentTarget.closest('.dock') === els.left ? 'left' : 'right';
    var step = e.shiftKey ? 40 : 12;
    if (e.key === 'ArrowLeft') state.size[side] = clampDock(state.size[side] + (side === 'right' ? step : -step));
    else if (e.key === 'ArrowRight') state.size[side] = clampDock(state.size[side] + (side === 'right' ? -step : step));
    else return;
    e.preventDefault();
    apply(); save(); emit();
  }

  /* --- the separator between two stacked panels --------------------------- */

  var sep = null;

  function onSepPointerDown(e) {
    if (e.button !== 0) return;
    var side = e.currentTarget.dataset.side;
    var idx = parseInt(e.currentTarget.dataset.index, 10);
    var ids = visibleIds(side);
    var a = e.currentTarget.dataset.before || ids[idx - 1], b = ids[idx];
    if (!a || !b) return;
    var ar = reg[a].el.getBoundingClientRect();
    var br = reg[b].el.getBoundingClientRect();
    sep = {
      a: a, b: b, side: side, y0: e.clientY, ah: ar.height, bh: br.height,
      weight: (state.share[a] || 1) + (state.share[b] || 1), node: e.currentTarget
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.dragging = '1';
    window.addEventListener('pointermove', onSepMove);
    window.addEventListener('pointerup', onSepUp, { once: true });
    e.preventDefault();
  }

  function onSepMove(e) {
    if (!sep) return;
    var total = sep.ah + sep.bh;
    var dy = e.clientY - sep.y0;
    var ah = Math.max(MIN_PANEL_PX, Math.min(total - MIN_PANEL_PX, sep.ah + dy));
    var bh = total - ah;
    state.share[sep.a] = sep.weight * (ah / total);
    state.share[sep.b] = sep.weight * (bh / total);
    renderSide(sep.side);
  }

  function onSepUp() {
    window.removeEventListener('pointermove', onSepMove);
    if (!sep) return;
    delete sep.node.dataset.dragging;
    sep = null;
    save(); emit();
  }

  function onSepKey(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    var side = e.currentTarget.dataset.side;
    var idx = parseInt(e.currentTarget.dataset.index, 10);
    var ids = visibleIds(side);
    var a = e.currentTarget.dataset.before || ids[idx - 1], b = ids[idx];
    if (!a || !b) return;
    var d = e.key === 'ArrowUp' ? -0.1 : 0.1;
    state.share[a] = Math.max(0.2, (state.share[a] || 1) + d);
    state.share[b] = Math.max(0.2, (state.share[b] || 1) - d);
    renderSide(side);
    e.preventDefault();
    save();
  }

  /* --- the phone bottom sheet --------------------------------------------- */

  var swipe = null;

  function onSheetPointerDown(e) {
    if (state.mode !== 'phone') return;
    var dock = e.currentTarget.closest('.dock');
    swipe = { dock: dock, y0: e.clientY, dy: 0, t0: Date.now() };
    dock.dataset.swiping = '1';
    e.currentTarget.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onSheetMove);
    window.addEventListener('pointerup', onSheetUp, { once: true });
    e.preventDefault();
  }

  function onSheetMove(e) {
    if (!swipe) return;
    swipe.dy = Math.max(0, e.clientY - swipe.y0);
    swipe.dock.style.setProperty('--sheet-y', swipe.dy + 'px');
  }

  function onSheetUp() {
    window.removeEventListener('pointermove', onSheetMove);
    if (!swipe) return;
    var fast = swipe.dy / Math.max(1, Date.now() - swipe.t0) > 0.5;
    delete swipe.dock.dataset.swiping;
    swipe.dock.style.removeProperty('--sheet-y');
    var shut = swipe.dy > 60 || fast;
    var dock = swipe.dock;
    swipe = null;
    if (shut) {
      var side = dock === els.left ? 'left' : 'right';
      openIds(side).forEach(function (id) { delete state.open[id]; });
      sync();
    }
  }

  /* --- mode ---------------------------------------------------------------- */

  function normaliseSide() {
    if (state.mode === 'desktop') return;
    if (!openIds(state.activeSide).length) {
      state.activeSide = openIds('left').length ? 'left' : 'right';
    }
    if (state.mode === 'phone' && (!isOpen(state.recentPanel) || sideOf(state.recentPanel) !== state.activeSide)) {
      var ids = openIds(state.activeSide);
      state.recentPanel = ids[ids.length - 1] || null;
    }
  }

  function setMode(w) {
    var m = w <= 700 ? 'phone' : w < 1100 ? 'tablet' : 'desktop';
    if (m === state.mode) { apply(); emit(); return; }
    state.mode = m;
    els.app.dataset.mode = m;
    if (m === 'phone') {
      /* Show one panel while retaining the desktop arrangement for return. */
      if (isOpen(state.recentPanel)) state.activeSide = sideOf(state.recentPanel) || state.activeSide;
    }
    normaliseSide();
    sync(false);
  }

  function onPanelFocus(e) {
    var panel = e.target && e.target.closest && e.target.closest('.panel');
    var id = panel && panel.dataset.panelId;
    if (!id || !isOpen(id)) return;
    var side = sideOf(id);
    if (!side || state.activeSide === side && state.recentPanel === id) return;
    state.activeSide = side; state.recentPanel = id;
    if (state.mode !== 'desktop') sync(false);
    save();
  }

  /* --- keys ---------------------------------------------------------------- */

  function onKey(e) {
    if (e.defaultPrevented) return;
    if (e.isComposing || (e.getModifierState && e.getModifierState('AltGraph'))) return;
    if ((e.metaKey || e.ctrlKey) && e.key === '.') {
      e.preventDefault();
      api.focus(!state.focus);
      return;
    }
    /* Esc closes the topmost thing. This listener is on window, i.e. the last
       stop in the bubble, so a palette or a menu that handled Esc has already
       called preventDefault and we keep our hands off. */
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (state.focus) {
        /* the summoned panel first, focus itself second */
        if (state.summoned) { state.summoned = null; sync(false); }
        else api.focus(false);
        e.preventDefault();
        return;
      }
      var open = Object.keys(state.open);
      if (open.length) { api.close(open[open.length - 1]); e.preventDefault(); }
    }
  }

  /* --- API ----------------------------------------------------------------- */

  var api = {
    ids: IDS,

    mount: function (opts) {
      opts = opts || {};
      wireScrollMotion();
      els.app = opts.app || document.getElementById('app');
      els.left = opts.left || document.getElementById('dock-left');
      els.right = opts.right || document.getElementById('dock-right');
      els.page = opts.page || document.getElementById('page');
      els.topbar = opts.topbar || document.getElementById('topbar');
      state.world = opts.world || 'dev';
      if (!els.app || !els.left || !els.right) {
        console.warn('Castor.panels: no #app / #dock-left / #dock-right to mount into');
        return api;
      }
      scaffold(els.left);
      scaffold(els.right);
      load();
      applyReadiness();
      marginRouting = featureToken('--margin-routing') === 'on';
      if (marginRouting) els.app.dataset.marginRouting = 'on';
      setupSurface();
      setupBondLayer();
      mounted = true;

      var w = els.app.clientWidth || 1280;
      state.mode = w <= 700 ? 'phone' : w < 1100 ? 'tablet' : 'desktop';
      els.app.dataset.mode = state.mode;
      normaliseSide();

      if (global.ResizeObserver) {
        new ResizeObserver(function (entries) {
          setMode(entries[0].contentRect.width);
        }).observe(els.app);
      } else {
        window.addEventListener('resize', function () { setMode(els.app.clientWidth); });
      }
      window.addEventListener('keydown', onKey);
      document.addEventListener('focusin', onPanelFocus);
      sync(false);
      return api;
    },

    /* Called by every other module before its panel can show anything real. */
    register: function (id, def) {
      def = def || {};
      reg[id] = reg[id] || {};
      if (def.title) reg[id].title = def.title;
      if (def.ready === true) reg[id].ready = true;
      if (typeof def.mount === 'function') {
        reg[id].mount = def.mount;
        reg[id].placeholder = false;
        reg[id].mounted = false;
      }
      if (reg[id].el) {
        var t = reg[id].el.querySelector('.panel-title');
        if (t) t.textContent = title(id);
      }
      if (reg[id].body && isOpen(id)) {
        reg[id].body.textContent = '';
        delete reg[id].body.dataset.empty;
        ensureBody(id);
      }
      if (id === 'workspace' && surface.active) mountSurfaceWorkspace();
      applyReadiness();
      return api;
    },

    open: function (id, side) {
      if (!mounted) return api;
      if (surface.active && id === 'workspace') {
        state.open.workspace = true;
        surface.collapsed = null;
        mountSurfaceWorkspace();
        applySurface(); save(); emit();
        return api;
      }
      if (!isReady(id)) return api;
      var chosen = pickSide(id, side, isOpen(id) ? sideOf(id) : null, state.placed[id]);
      if (state.mode === 'phone') {           // one panel at a time
        Object.keys(state.open).forEach(function (k) { if (k !== id) delete state.open[k]; });
      }
      if (state.focus) state.summoned = id;   // one summoned thing at a time
      if (sideOf(id) !== chosen) {
        var from = sideOf(id);
        if (from) state.order[from].splice(state.order[from].indexOf(id), 1);
        state.order[chosen].push(id);
      }
      state.open[id] = true;
      if (state.share[id] == null) state.share[id] = 1;
      state.activeSide = chosen; state.recentPanel = id;
      sync();
      return api;
    },

    close: function (id) {
      if (surface.active && id === 'workspace') {
        if (!state.open.workspace && surface.collapsed === 'secondary') return api;
        delete state.open.workspace;
        surface.collapsed = 'secondary';
        applySurface(); save(); emit();
        return api;
      }
      if (!state.open[id]) return api;
      delete state.open[id];
      if (state.summoned === id) state.summoned = null;
      sync();
      return api;
    },

    toggle: function (id, side) {
      if (surface.active && id === 'workspace') {
        return (state.open.workspace && surface.collapsed !== 'secondary') ? api.close(id) : api.open(id);
      }
      /* In focus mode a word summons its panel rather than closing a panel you
         cannot see; the second press sends it away again. */
      if (state.focus) {
        if (state.summoned === id) { state.summoned = null; sync(); return api; }
        return api.open(id, side);
      }
      /* On iPad and phone, a panel that is open but collapsed on the other side
         should come forward rather than close. */
      if (isOpen(id) && state.mode !== 'desktop' && (sideOf(id) !== state.activeSide || state.mode === 'phone' && state.recentPanel !== id)) {
        state.activeSide = sideOf(id);
        state.recentPanel = id;
        sync();
        return api;
      }
      return isOpen(id) ? api.close(id) : api.open(id, side);
    },

    isOpen: function (id) { return isOpen(id); },

    collapse: function (id, on) {
      if (!known(id)) return;
      if (on) state.collapsed[id] = true;
      else delete state.collapsed[id];
      sync();
    },
    isCollapsed: function (id) { return !!state.collapsed[id]; },

    /* Take these panels away for good on this page: their words hide, open()
       and the palette refuse them, and any that are open close. Called before
       mount by app.js for a reviewer; safe after it too. */
    withhold: function (ids) {
      var changed = false;
      (ids || []).forEach(function (id) {
        id = String(id);
        withheld[id] = true;
        if (state.open[id]) { delete state.open[id]; changed = true; }
        if (state.summoned === id) state.summoned = null;
      });
      if (mounted && changed) sync();
      applyReadiness();
      return api;
    },
    isWithheld: function (id) { return !!withheld[id]; },

    /* false for a panel whose word stays hidden until its module is ready */
    isReady: function (id) { return isReady(id); },

    /* the side rule, readable from outside (the tests; the walkthrough) */
    defaultSide: defaultSide,
    pickSide: pickSide,

    focus: function (on) {
      state.focus = on === undefined ? !state.focus : !!on;
      state.summoned = null;      /* the page alone; the desk is remembered */
      if (state.focus) watchCorner();
      sync(false);
      return api;
    },

    isFocus: function () { return state.focus; },



    onLayout: function (cb) {
      if (typeof cb === 'function') { layoutCbs.push(cb); cb(info()); }
      return api;
    },

    state: info,

    routeMargins: routeMargins,

    surface: function () {
      return surface.active ? {
        active: true, ratio: surface.ratio, collapsed: surface.collapsed,
        deck: surface.deck, workspace: surface.secondary,
        show: function (which) { setSurfaceCollapsed(which === 'page' ? 'secondary' : which === 'canvas' ? 'primary' : null); },
        collapse: setSurfaceCollapsed
      } : { active: false };
    },

    /* the body element of a panel, for a module that mounts late */
    bodyOf: function (id) { return reg[id] && reg[id].body; },

    title: title
  };

  Castor.panels = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
