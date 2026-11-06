(function (global) {
  'use strict';

  var DOC = global.document;
  var lit = null;                  // the block element this file lit
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
    restingOn = null;
  }
  /* The engine's light wins whenever there is a caret. */
  function engineHasIt() {
    var c = C();
    return !!(c.editor.isFocused && c.editor.isFocused());
  }

  function paint() {
    raf = 0;
    if (!ready()) return;
    if (!restingOn_()) { clear(); return; }
    if (engineHasIt()) {
      var caret = C().editor.getCaret && C().editor.getCaret();
      if (caret) restingOn = caret.blockId;                 // where to come back to
      if (lit) { lit.classList.remove('cw-lit'); lit = null; }
        return;
    }
    var id = (restingOn && blockEl(restingOn)) ? restingOn : firstSentence();
    var el = id && blockEl(id);
    if (!el) { clear(); return; }
    restingOn = id;
    if (lit && lit !== el) lit.classList.remove('cw-lit');
    el.classList.add('cw-lit');
    lit = el;
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
    wash: function () { return null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
