(function (global) {
  'use strict';

  var DOC = global.document;
  var lit = null;                  // the block element this file lit
  var washNode = null;             // our node inside the engine's wash layer
  var extra = [];                  // one more node per wrapped line
  var restingOn = null;            // block id the light rests on
  var raf = 0, timer = 0;

  function C() { return global.Castor; }
  function ready() {
    var c = C();
    return !!(c && c.editor && typeof c.editor.getBlocks === 'function' && c.editor.getBlocks().length);
  }
  function blockEl(id) { return DOC.querySelector('#page-article .cw-block[data-block-id="' + id + '"]'); }

  /* The first sentence of the PIECE: the first paragraph that is prose. A title
     is not a sentence, and a writer note is not the piece. */
  function firstSentence() {
    var blocks = C().editor.getBlocks();
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.type !== 'p') continue;
      var source = String(b.source || '').trim();
      if (!source || source.indexOf('%%') === 0) continue;
      if (/^\[?[A-Z]{2,}[^:\n]{0,40}:/.test(source)) continue;        // [NAME: ...]
      if (!/[a-z]{2,}\s+[a-z]{2,}/i.test(source)) continue;
      var el = blockEl(b.id);
      if (!el || el.querySelector('.cw-writer-only')) continue;
      return b.id;
    }
    return null;
  }

  function firstSentenceRange(el) {
    var walker = DOC.createTreeWalker(el, global.NodeFilter.SHOW_TEXT, null);
    var nodes = [], text = '', node;
    while ((node = walker.nextNode())) { nodes.push({ node: node, at: text.length }); text += node.nodeValue; }
    if (!text.trim()) return null;
    var start = 0;
    while (start < text.length && /\s/.test(text.charAt(start))) start++;
    var end = text.length, m = /[.!?](\s|$)/.exec(text.slice(start));
    if (m) end = start + m.index + 1;
    function point(at) {
      for (var i = nodes.length - 1; i >= 0; i--) {
        if (at >= nodes[i].at) return { node: nodes[i].node, off: Math.min(at - nodes[i].at, nodes[i].node.nodeValue.length) };
      }
      return { node: nodes[0].node, off: 0 };
    }
    var a = point(start), b = point(end), range = DOC.createRange();
    try { range.setStart(a.node, a.off); range.setEnd(b.node, b.off); } catch (e) { return null; }
    return range;
  }

  /* One rectangle per line, merged, exactly as the engine merges the caret's. */
  function lineRects(range) {
    var raw = Array.prototype.slice.call(range.getClientRects()), out = [];
    raw.forEach(function (r) {
      if (r.width < 0.5 || r.height < 0.5) return;
      var hit = null;
      out.forEach(function (o) { if (Math.abs(o.top - r.top) < r.height * .6) hit = o; });
      if (!hit) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      else {
        hit.left = Math.min(hit.left, r.left); hit.right = Math.max(hit.right, r.right);
        hit.top = Math.min(hit.top, r.top); hit.bottom = Math.max(hit.bottom, r.bottom);
      }
    });
    return out;
  }

  function washLayer() {
    var layer = DOC.querySelector('.cw-wash-layer');       // the engine's own layer
    if (!layer) return null;
    if (!washNode || washNode.parentNode !== layer) {
      washNode = DOC.createElement('i');
      washNode.className = 'cw-focus-wash';
      washNode.setAttribute('data-resting', '1');
      layer.appendChild(washNode);
    }
    return layer;
  }

  function washColour() {
    var page = DOC.getElementById('page-article');
    if (!page) return '';
    var style = global.getComputedStyle(page);
    if (style.getPropertyValue('--focus-sentence').trim() === 'off') return '';
    var v = style.getPropertyValue('--focus-wash').trim();
    return (!v || v === 'none' || v === 'transparent') ? '' : v;
  }

  /* The resting light is a token (`--focus-rest` in theme.css), not a fact about
     this file. Turn it off and the page returns to its genuinely-unlit state,
     which is the state the engine's own invariant is about — "nothing recedes
     until something is lit" cannot be observed in a world that is never unlit,
     and a check that cannot construct a state is not measuring it. Reading the
     token per paint also means a world can turn the light off at any moment
     rather than at load. */
  function restingOn_() {
    var page = DOC.getElementById('page-article');
    if (!page) return false;
    return global.getComputedStyle(page).getPropertyValue('--focus-rest').trim() === 'on';
  }

  function clear() {
    if (lit) { lit.classList.remove('cw-lit'); lit = null; }
    hideBands();
    restingOn = null;
  }
  function hideBands() {
    if (washNode) washNode.hidden = true;
    extra.forEach(function (n) { n.hidden = true; });
  }

  /* The engine's light wins whenever there is a caret. */
  function engineHasIt() {
    var c = C();
    return !!(c.editor.isFocused && c.editor.isFocused());
  }

  /* One node per line of the sentence, all of them ours, all of them the
     engine's own .cw-focus-wash inside the engine's own layer. */
  function bands(rects, lh, colour) {
    var layer = washNode.parentNode;
    while (extra.length < rects.length - 1) {
      var n = DOC.createElement('i');
      n.className = 'cw-focus-wash';
      n.setAttribute('data-resting', '1');
      layer.appendChild(n);
      extra.push(n);
    }
    var all = [washNode].concat(extra);
    all.forEach(function (node, i) {
      var r = rects[i];
      if (!r) { node.hidden = true; return; }
      var mid = (r.top + r.bottom) / 2;
      node.style.background = colour;
      node.style.transform = 'translate3d(' + r.left + 'px,' + (mid - lh / 2) + 'px,0) scale(' + (r.right - r.left) + ',' + lh + ')';
      node.hidden = false;
    });
  }

  function paint() {
    raf = 0;
    if (!ready()) return;
    if (!restingOn_()) { clear(); return; }
    if (engineHasIt()) {
      var caret = C().editor.getCaret && C().editor.getCaret();
      if (caret) restingOn = caret.blockId;                 // where to come back to
      if (lit) { lit.classList.remove('cw-lit'); lit = null; }
      hideBands();
      return;
    }
    var id = (restingOn && blockEl(restingOn)) ? restingOn : firstSentence();
    var el = id && blockEl(id);
    if (!el) { clear(); return; }
    var colour = washColour();
    var range = colour ? firstSentenceRange(el) : null, rects = range ? lineRects(range) : [];
    var lh = rects.length ? parseFloat(global.getComputedStyle(el).lineHeight) || (rects[0].bottom - rects[0].top) : 0;
    restingOn = id;
    if (lit && lit !== el) lit.classList.remove('cw-lit');
    el.classList.add('cw-lit');
    lit = el;
    var layer = colour ? washLayer() : null;
    if (!layer) { hideBands(); return; }
    if (!rects.length) { hideBands(); return; }
    /* The band is the LINE box, centred on the words, which is the shape the
       engine gives the caret's own shade: a band shorter than the caret standing
       in it reads as a bug. A sentence that wraps takes one band per line. */
    bands(rects, lh, colour);
  }

  function schedule() {
    if (raf) return;
    raf = global.requestAnimationFrame(paint);
  }
  function later(ms) {
    if (timer) global.clearTimeout(timer);
    timer = global.setTimeout(function () { timer = 0; schedule(); }, ms == null ? 90 : ms);
  }

  DOC.addEventListener('selectionchange', function () { later(); });
  DOC.addEventListener('focusout', function () { later(140); }, true);
  DOC.addEventListener('pointerup', function () { later(140); }, true);
  global.addEventListener('resize', schedule);

  function watch() {
    var page = DOC.getElementById('page-article');
    if (page && global.ResizeObserver) new global.ResizeObserver(function () { later(60); }).observe(page);
    if (DOC.fonts && DOC.fonts.ready && DOC.fonts.ready.then) DOC.fonts.ready.then(function () { later(60); });
  }

  var tries = 0;
  (function arm() {
    if (ready()) {
      schedule();
      watch();
      var sc = DOC.querySelector('.page-scroll');
      if (sc) sc.addEventListener('scroll', schedule, { passive: true });
      if (C().bus && C().bus.on) {
        C().bus.on('doc:change', schedule);
        C().bus.on('writing:mode', schedule);
        C().bus.on('size', function () { later(240); });
        C().bus.on('panel:open', function () { later(240); });
        C().bus.on('panel:close', function () { later(240); });
      }
      return;
    }
    if (tries++ > 60) return;
    global.setTimeout(arm, 100);
  })();

  global.Castor = global.Castor || {};
  global.Castor.typewell = {
    paint: paint,
    firstSentence: firstSentence,
    resting: function () { return restingOn; },
    wash: function () { return washNode && !washNode.hidden ? washNode : null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
