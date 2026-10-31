/* K1-A Capsule: the few things capsule.css cannot do alone (design/DESIGN.md).
   - The open articles join the top row: the strip app.js builds after #topbar is
     moved inside it, after the name, whenever app.js makes it again.
   - Share goes first among the tools; each panel word's label gets its own box,
     so the stylesheet can centre the word on its capitals.
   - The capsule gets its two hairlines and, for a writer, the Publish button.
   - Typing quiets the capsule; the pointer or a pause brings it back.
   Nothing here owns state: the words, the strip and the panels stay with their
   modules, which still find them where they always were. */
(function (global) {
  'use strict';
  var doc = global.document;
  if (!doc) return;
  var Castor = global.Castor = global.Castor || {};
  var QUIET_MS = 1200;

  function bar() { return doc.getElementById('topbar'); }
  function words() { var b = bar(); return b && b.querySelector('.nav.topwords'); }

  function placeStrip() {
    var b = bar(), strip = doc.getElementById('castor-tabs');
    if (!b || !strip || strip.parentNode === b) return;
    var brand = b.querySelector('.brand');
    b.insertBefore(strip, brand ? brand.nextSibling : b.firstChild);
  }

  function placeShare() {
    var b = bar(), share = b && b.querySelector('.descant-share'), tools = b && b.querySelector('.bar-tools');
    if (share && tools && share.parentNode !== tools) tools.insertBefore(share, tools.firstChild);
  }

  function labelWords() {
    var nav = words(), b = bar();
    if (!nav) return;
    var list = Array.prototype.slice.call(nav.querySelectorAll('.word'));
    var share = b && b.querySelector('.descant-share');
    if (share) list.push(share);
    list.forEach(function (w) {
      if (w.querySelector(':scope > .word-label')) return;
      for (var n = w.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 && n.nodeValue.trim()) {
          var span = doc.createElement('span');
          span.className = 'word-label';
          span.textContent = n.nodeValue.trim();
          w.replaceChild(span, n);
          if (!w.title) w.title = span.textContent;
          return;
        }
      }
    });
  }

  function writer() {
    var app = doc.getElementById('app');
    // Readers never get a preset; the role check holds even if one did.
    return !!(app && app.hasAttribute('data-preset') && !(Castor.role && Castor.role.reviewer) && Castor.publishState && Castor.publishState.open);
  }

  function dressCapsule() {
    var nav = words();
    if (!nav) return;
    if (!nav.querySelector('.capsule-rule')) {
      var rule = doc.createElement('span'); rule.className = 'capsule-rule'; rule.setAttribute('aria-hidden', 'true');
      var end = doc.createElement('span'); end.className = 'capsule-rule end'; end.setAttribute('aria-hidden', 'true');
      nav.appendChild(rule); nav.appendChild(end);
    }
    var publish = nav.querySelector('.capsule-publish');
    if (!publish) {
      publish = doc.createElement('button');
      publish.type = 'button';
      publish.className = 'word capsule-publish';
      publish.textContent = 'Publish';
      publish.addEventListener('click', function () { if (Castor.publishState && Castor.publishState.open) Castor.publishState.open(); });
      nav.appendChild(publish);
    }
    publish.hidden = !writer();
    var end2 = nav.querySelector('.capsule-rule.end');
    if (end2) end2.hidden = publish.hidden;
    nav.setAttribute('role', 'toolbar');
    nav.setAttribute('aria-label', 'Panels');
  }

  /* Typing quiets the capsule. Any pointer movement, or a pause, brings it back. */
  var quietTimer = 0;
  function quiet(on) {
    var app = doc.getElementById('app');
    if (!app) return;
    if (on) app.setAttribute('data-capsule', 'quiet'); else app.removeAttribute('data-capsule');
  }
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (!t || !t.closest || !t.closest('.page-column')) return;
    quiet(true);
    clearTimeout(quietTimer);
    quietTimer = setTimeout(function () { quiet(false); }, QUIET_MS);
  }
  function onPointer() { if (quietTimer) { clearTimeout(quietTimer); quietTimer = 0; quiet(false); } }

  /* A margin card takes the free margin beside the page column, never more than
     its own size and never less than 240 px (capsule.css). The column never moves. */
  function measureMargins() {
    var app = doc.getElementById('app'), col = doc.querySelector('#page .page-column');
    if (!app || !col) return;
    var w = col.getBoundingClientRect().width, room = global.innerWidth || 0;
    if (!w || !room) return;
    var free = Math.floor((room - w) / 2 - 16 - 8);
    if (app._marginFree !== free) { app._marginFree = free; app.style.setProperty('--margin-free', free + 'px'); }
    liftCapsule();
  }

  /* On a touch device the formatting bar sits at the foot of the window; the
     capsule floats above it instead of on it. */
  function liftCapsule() {
    var app = doc.getElementById('app'), island = doc.querySelector('#app > .command-island');
    if (!app) return;
    var lift = 0;
    if (island && island.offsetParent !== null) {
      var r = island.getBoundingClientRect();
      if (r.height && r.bottom >= (global.innerHeight || 0) - 2) lift = Math.round(r.height);
    }
    if (app._capsuleLift !== lift) { app._capsuleLift = lift; app.style.setProperty('--capsule-lift', lift + 'px'); }
  }

  function arrange() { placeStrip(); placeShare(); labelWords(); dressCapsule(); measureMargins(); }

  function start() {
    var app = doc.getElementById('app');
    if (!app || !bar()) return;
    arrange();
    var mo = new global.MutationObserver(function () { arrange(); });
    mo.observe(app, { childList: true, attributes: true, attributeFilter: ['data-touch-format', 'data-keyboard', 'data-mode'] });
    mo.observe(bar(), { childList: true, subtree: true });
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('pointermove', onPointer, { passive: true });
    global.addEventListener('resize', measureMargins, { passive: true });
    if (global.ResizeObserver) { var col = doc.querySelector('#page .page-column'); if (col) new global.ResizeObserver(measureMargins).observe(col); }
  }

  Castor.capsule = { arrange: arrange, quiet: quiet, QUIET_MS: QUIET_MS };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : this);
