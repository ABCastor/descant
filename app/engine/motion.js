/* Motion and touch, the script half of motion.css.

   - The press: iOS shows :active under a finger only when the page listens for
     touches, so one passive listener is enough for the first frame to show it.
   - Tokens: a glide that must be started from a script (FLIP) reads the same
     durations and curve as the stylesheet, and runs as a Web Animation on
     transform, never as a frame loop.
   - Haptics: three moments only (a comment posted, a sheet snapped shut by a
     swipe, an action refused). Inside the Descant app they go to the native
     shell, which plays them unless the system has haptics off; anywhere else
     they do nothing. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {};
  var DOC = global.document;
  var MOMENTS = { posted: 1, snap: 1, refused: 1 };

  if (DOC && DOC.addEventListener) DOC.addEventListener('touchstart', function () {}, { passive: true, capture: true });

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  // A token's length in ms: --motion-<name> from motion.css (fallback when it has not loaded).
  var FALLBACK = { menu: 280, bar: 290, 'sheet-in': 410, 'sheet-out': 120, panel: 500, out: 120, fade: 150 };
  function ms(name) {
    var root = DOC && DOC.documentElement, v = NaN;
    if (root && global.getComputedStyle) v = parseFloat(global.getComputedStyle(root).getPropertyValue('--motion-' + name));
    return isFinite(v) && v >= 0 ? v : (FALLBACK[name] || 0);
  }
  var ARRIVE = 'cubic-bezier(.32, .72, 0, 1)';

  // Show an element that just jumped by (dx, dy) gliding from where it was. Reduce Motion: it just is there.
  function glide(el, dx, dy, token) {
    if (!el || !el.animate || reduced() || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) return null;
    if (el._castorGlide) el._castorGlide.cancel();
    var motion = el.animate([{ translate: dx + 'px ' + dy + 'px' }, { translate: '0 0' }],
      { duration: ms(token || 'menu'), easing: ARRIVE });
    el._castorGlide = motion;
    return motion;
  }

  // Let a surface leave (a short fade and a small step aside), then run `then`, which hides it.
  // WebKit cannot animate a popover out after it is hidden, so the leaving comes first.
  function leave(el, then, token) {
    var finish = function () { if (then) then(); };
    if (!el || !el.animate) { finish(); return null; }
    if (el._castorLeaving) return el._castorLeaving;
    var calm = reduced();
    var motion = el.animate(calm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '24px 0' }],
      { duration: ms(calm ? 'fade' : (token || 'out')), easing: calm ? 'ease-out' : 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
    el._castorLeaving = motion;
    var done = function () { el._castorLeaving = null; finish(); motion.cancel(); };
    motion.onfinish = done;
    motion.oncancel = function () { if (el._castorLeaving === motion) { el._castorLeaving = null; finish(); } };
    return motion;
  }

  // The native shell's message handler exists only inside the app.
  function haptic(moment) {
    if (!MOMENTS[moment]) return false;
    var handler = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.descant;
    if (!handler || typeof handler.postMessage !== 'function') return false;
    try {
      var sent = handler.postMessage({ version: 1, kind: 'haptic', moment: moment });
      if (sent && typeof sent.catch === 'function') sent.catch(function () {});
    } catch (e) { return false; }
    return true;
  }

  Castor.motion = { ms: ms, reduced: reduced, glide: glide, leave: leave, haptic: haptic };
})(typeof window !== 'undefined' ? window : this);
