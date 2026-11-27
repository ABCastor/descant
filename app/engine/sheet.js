/* The one sheet: how every pane comes and goes (the motion is motion.css's; this is its hand).

   On a phone and an iPad held upright every pane is a sheet that rises from the bottom edge the way
   Comments does (410 ms, the arrival curve). On a laptop and a wide iPad the cards and menus keep
   their place and rise a few pixels on the same curve. Wherever it stands, a pane closes by being
   pulled down:

   - the sheet follows the finger (or the mouse on its grab handle); pulled up it gives a little and
     resists (rubber band);
   - let go fast enough (decide(): 0.5 px/ms) or far enough (30 % of its height, at most 140 px) and
     it carries on down and closes; otherwise it springs back;
   - over a list scrolled down, the finger scrolls the list first; once the list is at its top the same
     finger pulls the sheet (the iOS sheet's rule);
   - a pane holding words typed and not yet sent springs back instead of closing (decide() 'keep'):
     the close button and Escape still close it.

   Leaving: the browser hides a popover or a dialog at once and WebKit cannot animate it after, so a
   still copy of it, where it stood, takes the leave (ghost()). Reduce Motion: every move is a 150 ms
   fade in place, and a pull still closes.

   Only translate and opacity move, on the compositor; nothing is measured while the finger moves. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {};
  var DOC = global.document;

  var SPEED = 0.5;        // px per ms: a flick this fast closes
  var FLICK_MIN = 12;     // ...once it has moved at least this far
  var BACK_SPEED = -0.15; // moving up this fast when let go: the writer changed their mind
  var FAR = 0.3, FAR_MAX = 140;
  var RUBBER = 0.55, RUBBER_MAX = 48;
  var SLOP = 6;           // px before a touch counts as a drag (or a scroll, or sideways)
  var ARRIVE = 'cubic-bezier(.32, .72, 0, 1)';
  var LEAVE = 'cubic-bezier(.4, 0, 1, 1)';
  var CARRY = 'cubic-bezier(.2, .6, .35, 1)'; // a released sheet keeps the finger's speed, then slows

  /* --- the rules, pure (tests read these) ------------------------------------------------------ */

  // What a let-go does: 'close', 'stay' (spring back) or 'keep' (would close, but holds typed words).
  function decide(offset, velocity, height, holding) {
    var close = velocity <= BACK_SPEED ? false
      : (velocity >= SPEED && offset >= FLICK_MIN) || offset >= Math.min(FAR_MAX, Math.max(0, height) * FAR);
    if (!close) return 'stay';
    return holding ? 'keep' : 'close';
  }
  // A pull past the resting place gives less and less: never more than RUBBER_MAX px.
  function rubber(dy) {
    if (dy >= 0) return dy;
    var x = -dy;
    return -RUBBER_MAX * (1 - 1 / (1 + x * RUBBER / RUBBER_MAX));
  }
  // The finger's speed at the end, from the last 100 ms of samples [[t, y], ...] (px per ms, down is +).
  function velocity(samples) {
    if (!samples || samples.length < 2) return 0;
    var last = samples[samples.length - 1], first = last, i;
    for (i = samples.length - 2; i >= 0; i--) { if (last[0] - samples[i][0] > 100) break; first = samples[i]; }
    var dt = last[0] - first[0];
    return dt > 0 ? (last[1] - first[1]) / dt : 0;
  }
  // How long a released sheet takes to go from where it is: about its own speed, never a jump or a crawl.
  function carryMs(remaining, speed) {
    var v = Math.max(speed || 0, 0.9);
    return Math.round(Math.min(300, Math.max(160, 1.4 * remaining / v)));
  }

  /* --- where things are ---------------------------------------------------------------------------- */

  function reduced() { return !!(Castor.motion && Castor.motion.reduced ? Castor.motion.reduced() : global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function ms(name, fallback) { return Castor.motion && Castor.motion.ms ? Castor.motion.ms(name) : fallback; }
  function appMode() { var app = DOC && DOC.getElementById('app'); return (app && app.dataset.mode) || 'desktop'; }
  // A sheet on a phone and an iPad held upright; a card on a laptop and a wide iPad.
  function shape() { var m = appMode(); return m === 'phone' || m === 'tablet' ? 'sheet' : 'card'; }

  // Words typed into a pane and not sent: a pull or a tap outside must not throw them away. A search
  // (a query is kept for next time anyway) and a field nobody can type in hold nothing.
  function holding(el) {
    if (!el || !el.querySelectorAll) return false;
    var fields = el.querySelectorAll('input, textarea');
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], type = (f.type || '').toLowerCase();
      if (/^(checkbox|radio|range|button|submit|reset|hidden|file|color|search)$/.test(type) || f.readOnly || f.disabled) continue;
      if (f.getAttribute && f.getAttribute('role') === 'combobox') continue;
      if (f.value !== f.defaultValue && f.value.trim() !== '') return true;
    }
    return false;
  }
  var NO_DRAG = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-sheet-drag], .cw-edit';
  // The nearest box between the touch and the sheet that scrolls up and down.
  function scrollerOf(target, el) {
    for (var n = target; n && n !== el.parentNode; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (n.scrollHeight > n.clientHeight + 1) {
        var oy = global.getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return n;
      }
      if (n === el) break;
    }
    return null;
  }

  /* --- moving the real element ------------------------------------------------------------------- */

  // Important, so the pane follows the finger under Reduce Motion too (its rules pin translate there):
  // a hand moving a sheet is not an animation.
  function place(el, offset, card) {
    el.style.setProperty('translate', '0 ' + offset.toFixed(1) + 'px', 'important');
    if (card) el.style.setProperty('opacity', String(Math.max(0.35, 1 - Math.max(0, offset) / 260)), 'important');
  }
  function unplace(el) { el.style.removeProperty('translate'); el.style.removeProperty('opacity'); }

  function springBack(el, offset, card) {
    unplace(el);
    delete el.dataset.sheetDragging;
    if (!el.animate || Math.abs(offset) < 0.5) return null;
    var from = { translate: '0 ' + offset + 'px' }, to = { translate: '0 0' };
    if (card) { from.opacity = String(Math.max(0.35, 1 - Math.max(0, offset) / 260)); to.opacity = '1'; }
    return el.animate([from, to], { duration: reduced() ? ms('fade', 150) : ms('sheet-in', 410), easing: ARRIVE });
  }

  // A sheet let go to close: it carries on down from where the finger left it, then is put away.
  function carryAway(el, offset, speed, card, then) {
    var h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
    var away = card ? offset + 24 : Math.max(offset + 24, h + 16);
    var calm = reduced();
    unplace(el);
    var from = { translate: '0 ' + offset + 'px', opacity: card ? String(Math.max(0.35, 1 - Math.max(0, offset) / 260)) : '1' };
    var to = calm ? { translate: '0 ' + offset + 'px', opacity: '0' } : { translate: '0 ' + away + 'px', opacity: card ? '0' : '1' };
    var motion = el.animate ? el.animate([from, to], {
      duration: calm ? ms('fade', 150) : carryMs(away - offset, speed), easing: calm ? 'ease-out' : CARRY, fill: 'forwards'
    }) : null;
    var finish = function () {
      // Put away while still drawn where the carry ended; nothing eases back on the way.
      el.dataset.sheetDragging = '1';
      try { then(); } finally {
        global.requestAnimationFrame(function () {
          global.requestAnimationFrame(function () { if (motion) motion.cancel(); delete el.dataset.sheetDragging; });
        });
      }
    };
    if (motion) motion.onfinish = finish; else finish();
    return motion;
  }

  /* --- the pull ---------------------------------------------------------------------------------- */

  // opts.close(): put the pane away now (it is already off screen). opts.enabled(pointerType): whether
  // a pull applies now (default: a sheet takes any pointer on its handle and any finger anywhere; a
  // card only a finger). opts.handle: what a mouse may pull (default the grab handle and [data-sheet-handle]).
  function bind(el, opts) {
    if (!el || el._castorSheet) return el && el._castorSheet;
    opts = opts || {};
    var g = null;
    function handleSel() { return (opts.handleOf && opts.handleOf()) || opts.handle || '.sheet-grabber, [data-sheet-handle]'; }
    function enabled(kind) {
      if (opts.enabled) return opts.enabled(kind);
      return shape() === 'sheet' || kind === 'touch';
    }
    function begin(x, y, target, kind) {
      if (!enabled(kind)) return null;
      if (target && target.closest && target.closest(NO_DRAG)) return null;
      // A mouse pulls by the handle (or a sheet's grab stroke, its top 28 px), never by a control on it
      // (a press there is a click).
      if (kind !== 'touch') {
        if (!target || !target.closest || target.closest('button, a[href], [role="button"], summary, label')) return null;
        var top = el.getBoundingClientRect().top;
        if (!target.closest(handleSel()) && !(shape() === 'sheet' && y - top >= 0 && y - top <= 28)) return null;
      }
      return { x0: x, y0: y, origin: y, lastY: y, kind: kind, state: kind === 'touch' ? 'pending' : 'drag',
        scroller: scrollerOf(target, el), offset: 0, samples: [[Date.now(), y]], card: shape() !== 'sheet' };
    }
    function startDrag(y) {
      g.state = 'drag'; g.origin = y; el.dataset.sheetDragging = '1';
      if (el.getAnimations) el.getAnimations().forEach(function (a) { if (!a.transitionProperty) a.cancel(); });
    }
    function move(x, y, cancelable, event) {
      if (!g) return;
      var dx = x - g.x0, dy = y - g.y0;
      if (g.state === 'pending') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dx) > Math.abs(dy)) { g.state = 'off'; return; }
        var top = !g.scroller || g.scroller.scrollTop <= 0;
        // From where the finger is less the slop, so the sheet starts at the finger with no jump.
        if (dy > 0 && top) startDrag(g.y0 + SLOP);
        else if (dy < 0 && !g.scroller) startDrag(g.y0 - SLOP);
        else g.state = 'scroll';
      }
      if (g.state === 'scroll') {
        // The list reached its top and the finger keeps coming down: from here it pulls the sheet.
        if (g.scroller && g.scroller.scrollTop <= 0 && y > g.lastY) startDrag(y);
        else { g.lastY = y; return; }
      }
      if (g.state !== 'drag') return;
      if (cancelable && event) event.preventDefault();
      g.lastY = y;
      g.offset = rubber(y - g.origin);
      g.samples.push([Date.now(), y]);
      if (g.samples.length > 12) g.samples.shift();
      place(el, g.offset, g.card);
    }
    function end(cancelled) {
      var done = g; g = null;
      if (!done || done.state !== 'drag') return;
      var v = cancelled ? 0 : velocity(done.samples);
      var h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
      var what = decide(done.offset, v, h, holding(el));
      if (what === 'close') {
        if (Castor.motion && Castor.motion.haptic) Castor.motion.haptic('snap');
        carryAway(el, done.offset, v, done.card, function () { (opts.close || function () {})({ pulled: true }); });
      } else springBack(el, done.offset, done.card);
    }
    // Fingers: touch events, so the page can still take over a finger the list was scrolling.
    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { if (g && g.state === 'drag') end(true); g = null; return; }
      var t = e.touches[0];
      g = begin(t.clientX, t.clientY, e.target, 'touch');
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (!g || e.touches.length !== 1) return;
      var t = e.touches[0];
      move(t.clientX, t.clientY, e.cancelable, e);
    }, { passive: false });
    el.addEventListener('touchend', function () { end(false); });
    el.addEventListener('touchcancel', function () { end(true); });
    // A mouse or a pen: on the grab handle only (elsewhere it selects and clicks).
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      g = begin(e.clientX, e.clientY, e.target, e.pointerType || 'mouse');
      if (!g) return;
      startDrag(e.clientY);
      var who = e.target;
      try { who.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      e.preventDefault();
      var onMove = function (m) { move(m.clientX, m.clientY, false, null); };
      var onUp = function (u) {
        who.removeEventListener('pointermove', onMove); who.removeEventListener('pointerup', onUp); who.removeEventListener('pointercancel', onUp);
        end(u.type === 'pointercancel');
      };
      who.addEventListener('pointermove', onMove); who.addEventListener('pointerup', onUp); who.addEventListener('pointercancel', onUp);
    });
    el._castorSheet = { el: el, opts: opts };
    return el._castorSheet;
  }

  /* --- leaving ------------------------------------------------------------------------------------- */

  // The real element leaves (down as a sheet, a short fall and fade as a card), then `then` hides it.
  function leave(el, then) {
    var finish = function () { if (then) then(); };
    if (!el || !el.animate) { finish(); return null; }
    if (el._castorLeaving) return el._castorLeaving;
    var calm = reduced(), sheet = el.getAttribute && el.getAttribute('data-sheet-shape') === 'sheet' || (!el.hasAttribute('data-sheet-shape') && shape() === 'sheet');
    var h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
    var frames = calm ? [{ opacity: 1 }, { opacity: 0 }]
      : sheet ? [{ translate: '0 0' }, { translate: '0 ' + Math.round(h + 16) + 'px' }]
        : [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 8px' }];
    var motion = el.animate(frames, { duration: calm ? ms('fade', 150) : sheet ? ms('sheet-out', 200) : ms('out', 120), easing: calm ? 'ease-out' : LEAVE, fill: 'forwards' });
    el._castorLeaving = motion;
    // Hidden while still marked as leaving, so a gate watching the close knows it is drawn already.
    motion.onfinish = function () { try { finish(); } finally { el._castorLeaving = null; motion.cancel(); } };
    motion.oncancel = function () { if (el._castorLeaving === motion) { el._castorLeaving = null; finish(); } };
    return motion;
  }

  // A still copy of el where it stands takes the leave; el itself can be hidden (or removed) at once.
  function ghost(el) {
    if (!el || !el.getBoundingClientRect || !global.getComputedStyle || !el.parentNode) return null;
    var at = el.getBoundingClientRect();
    if (!at.width || !at.height) return null;
    var style = global.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return null;
    var copy = el.cloneNode(true), i;
    // Same classes and attributes, so the page's rules draw it as they draw the pane; it differs only by
    // its place, held where the pane stood, over everything.
    ['position:fixed', 'display:' + style.display, 'opacity:' + style.opacity, 'left:' + at.left + 'px', 'top:' + at.top + 'px', 'right:auto', 'bottom:auto',
      'inset:' + at.top + 'px auto auto ' + at.left + 'px', 'width:' + at.width + 'px', 'height:' + at.height + 'px', 'max-height:none', 'max-width:none',
      'margin:0', 'box-sizing:border-box', 'translate:none', 'transform:none', 'animation:none', 'transition:none', 'z-index:2147483000', 'pointer-events:none']
      .forEach(function (pair) { var k = pair.indexOf(':'); copy.style.setProperty(pair.slice(0, k), pair.slice(k + 1)); });
    // It keeps its ids so the page's rules still draw it; it stands after the pane, so every lookup
    // by id still finds the real one first.
    copy.removeAttribute('open');
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('data-leaving-copy', '');
    copy.inert = true;
    // Seen as an open pane, so its open-state rules (surface, shadow) still draw it.
    copy.setAttribute('data-ghost-open', '');
    el.parentNode.insertBefore(copy, el.nextSibling);
    copy.scrollTop = el.scrollTop;
    var from = el.querySelectorAll('*'), to = copy.querySelectorAll('*');
    for (i = 0; i < from.length && i < to.length; i++) if (from[i].scrollTop) to[i].scrollTop = from[i].scrollTop;
    leave(copy, function () { if (copy.parentNode) copy.parentNode.removeChild(copy); });
    return copy;
  }

  /* --- the gates: a popover and a dialog become sheets -------------------------------------------------- */

  function setShape(el, fill) {
    if (typeof fill === 'function') fill = fill();
    el.setAttribute('data-castor-sheet', fill ? 'fill' : 'fit');
    el.setAttribute('data-sheet-shape', shape());
    if (appMode() === 'tablet') el.setAttribute('data-sheet-wide', ''); else el.removeAttribute('data-sheet-wide');
  }

  // A popover pane (Settings, Search, the goal, Save details...). opts.fill (or a function of now): a
  // full-height sheet under the top row (it has a field the keyboard must not cover); opts.ghost():
  // whether a close leaves a copy (default yes); opts.handle: what a mouse may pull; opts.pulled():
  // called once a pull has put it away. A second call
  // adds its options to the first (popovers.js gates every pane it binds; a pane's own module adds
  // what is particular to it).
  function popover(el, opts) {
    if (!el) return;
    var gate = el._castorSheetGate, k;
    if (gate) { for (k in opts || {}) gate[k] = opts[k]; setShape(el, gate.fill); return; }
    gate = el._castorSheetGate = {};
    for (k in opts || {}) gate[k] = opts[k];
    setShape(el, gate.fill);
    el.addEventListener('beforetoggle', function (e) {
      if (e.newState === 'open') { setShape(el, gate.fill); return; }
      if (el._castorLeaving || el._castorQuiet || (gate.ghost && !gate.ghost())) return;
      try { ghost(el); } catch (err) { /* it still closes; only its leaving is not drawn */ }
    });
    // Pulled shut: hidden quietly (it is already down), then the pane is told (opts.pulled), so it can
    // do what its own close does, such as give the writer's caret back.
    bind(el, { close: function () {
      el._castorQuiet = true; try { el.hidePopover(); } finally { el._castorQuiet = false; }
      if (gate.pulled) gate.pulled();
    }, handleOf: function () { return gate.handle; } });
  }

  // A modal dialog pane (Publish, Share, the publish state, Versions' finish...). Escape, a tap on the
  // backdrop, a pull and every close() from the code take the same leave.
  function dialog(d, opts) {
    if (!d || d._castorSheetGate) return d;
    opts = opts || {};
    d._castorSheetGate = true;
    setShape(d, opts.fill);
    var nativeClose = d.close;
    d.close = function () {
      if (d.open && !d._castorQuiet) { try { ghost(d); } catch (err) { /* closes anyway */ } }
      return nativeClose.apply(d, arguments);
    };
    d.addEventListener('cancel', function () { if (d.open) { try { ghost(d); } catch (err) { /* closes anyway */ } d._castorQuiet = true; global.setTimeout(function () { d._castorQuiet = false; }, 0); } });
    d.addEventListener('click', function (e) {
      if (e.target !== d || opts.backdrop === false) return;
      var r = d.getBoundingClientRect();
      var out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (!out) return;
      if (holding(d)) { nudge(d); return; }
      d.close();
    });
    bind(d, { close: function () { d._castorQuiet = true; try { d.close(); } finally { d._castorQuiet = false; } } });
    return d;
  }

  // A pane that keeps typed words answers a tap outside with a small shake of its edge, not a close.
  function nudge(el) {
    if (!el.animate || reduced()) return;
    el.animate([{ translate: '0 0' }, { translate: '0 6px' }, { translate: '0 0' }], { duration: ms('menu', 280), easing: ARRIVE });
  }

  /* --- the keyboard: a sheet with a field sits on it, not under it --------------------------------------- */

  function wireKeyboard() {
    var vv = global.visualViewport, root = DOC && DOC.documentElement;
    if (!vv || !root || !root.style) return;
    var raf = 0;
    function fit() {
      raf = 0;
      var covered = Math.max(0, Math.round(global.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty('--sheet-kb', (covered > 80 ? covered : 0) + 'px');
    }
    var schedule = function () { if (!raf) raf = global.requestAnimationFrame(fit); };
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    fit();
  }
  if (DOC && DOC.addEventListener) {
    if (DOC.readyState === 'loading') DOC.addEventListener('DOMContentLoaded', wireKeyboard); else wireKeyboard();
  }

  Castor.sheet = {
    decide: decide, rubber: rubber, velocity: velocity, carryMs: carryMs, holding: holding, shape: shape,
    bind: bind, leave: leave, ghost: ghost, popover: popover, dialog: dialog,
    rules: { speed: SPEED, flickMin: FLICK_MIN, backSpeed: BACK_SPEED, far: FAR, farMax: FAR_MAX, rubberMax: RUBBER_MAX, slop: SLOP }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.sheet;
})(typeof window !== 'undefined' ? window : globalThis);
