/* Native popovers share one state indicator and return focus on Escape. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {});
  var opened = [];
  function returnFocus(opener, onlyHidden) {
    if (!opener) return false;
    var sheet = opener.closest && opener.closest('#more-sheet');
    var doc = opener.ownerDocument || global.document;
    var target = sheet && sheet.hidden && doc && doc.getElementById('more-word');
    if (!target && onlyHidden) return false;
    (target || opener).focus();
    return true;
  }
  function bind(opener, panel, onOpen) {
    if (!opener || !panel) return;
    opener.setAttribute('popovertarget', panel.id);
    opener.setAttribute('aria-controls', panel.id);
    opener.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-haspopup', 'dialog');
    panel.setAttribute('popover', 'auto');
    if (panel.getAttribute && /^(alertdialog|dialog)$/.test(panel.getAttribute('role') || '')) {
      panel.setAttribute('tabindex', '-1');
      panel.setAttribute('aria-modal', 'true');
    }
    panel.addEventListener('beforetoggle', function (e) {
      opened = opened.filter(function (p) { return p !== panel; });
      if (e.newState === 'open') opened.push(panel);
      opener.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState === 'open' && onOpen) onOpen();
    });
    panel.addEventListener('toggle', function (e) {
      var open = e.newState === 'open';
      opener.setAttribute('aria-expanded', String(open));
      if (open && panel.getAttribute && panel.getAttribute('role') === 'dialog') panel.focus();
      if (!open) returnFocus(opener, true);
    });
    var doc = opener.ownerDocument || global.document;
    if (doc) doc.addEventListener('keydown', function (e) {
      if (!panel.matches || !panel.matches(':popover-open')) return;
      var top = opened.filter(function (p) { return p.matches && p.matches(':popover-open'); }).pop();
      if (top && top !== panel) return;
      if (e.key === 'Tab' && panel.getAttribute && panel.getAttribute('aria-modal') === 'true') {
        containTab(e, panel, doc); return;
      }
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (panel.hidePopover) panel.hidePopover();
      opener.setAttribute('aria-expanded', 'false');
      returnFocus(opener);
    }, true);
  }
  function containTab(e, panel, doc) {
    var candidates = panel.querySelectorAll ? panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]') : [];
    var items = Array.prototype.filter.call(candidates, function (n) {
      return !n.disabled && n.tabIndex >= 0 && n.getClientRects().length;
    });
    var at = items.indexOf(doc.activeElement);
    e.preventDefault(); e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (!items.length) { panel.focus(); return; }
    var next = at < 0 ? (e.shiftKey ? items.length - 1 : 0)
      : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }
  C.popovers = { bind: bind, containTab: containTab, returnFocus: returnFocus };
  if (typeof module !== 'undefined' && module.exports) module.exports = C.popovers;
})(typeof window !== 'undefined' ? window : globalThis);
