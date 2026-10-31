/* The product's own signature: its name, the window title, and the app install.
 *
 * The header and the footer line are not built here. build.py fills every shell's
 * two placeholders from engine/topbar.html and engine/footline.html, writing the
 * product's name into the header, and signature.css carries their rules. This file
 * does only what needs a script:
 *
 *   1. PRODUCT_NAME, the one place the product's name is written. build.py reads it
 *      from here for the header, the manifest and the static <title>; this file
 *      uses it for the window title. Change it here and rebuild.
 *   2. The window title: "<Name>* · <article title>", kept true when the engine
 *      sets its own title and when an article tab is switched.
 *   3. On a phone, a tap on the name plays the quarter turn its asterisk makes
 *      under a pointer (signature.css; nothing moves under reduced motion).
 *   4. The service worker registration, which is what lets Chrome install the app.
 *
 * Rules it follows: castor-identity docs/SIGNATURE.md, "The product header" and
 * "Each product's own identity" (the name, then the typed Castor asterisk in
 * --human). */
(function () {
  'use strict';

  var PRODUCT_NAME = "Descant";

  var SEP = ' · ';
  var MARKED = PRODUCT_NAME + '*';

  /* ---- the window title ------------------------------------------------------ */

  var lastSet = null;

  function bare(title) {
    var t = String(title || '').trim();
    if (t.indexOf(MARKED + SEP) === 0) return t.slice((MARKED + SEP).length);
    if (t === MARKED) return '';
    return t;
  }

  function setTitle(articleTitle) {
    var want = articleTitle ? MARKED + SEP + articleTitle : MARKED;
    if (document.title !== want) {
      lastSet = want;
      document.title = want;
    }
  }

  function selectedTab() {
    var n = document.querySelector('#castor-tabs .castor-tab[aria-selected="true"] .castor-tab-name');
    return n ? n.textContent.trim() : '';
  }

  function watchTitle() {
    var el = document.querySelector('head > title');
    if (!el) {
      el = document.createElement('title');
      document.head.appendChild(el);
    }
    /* Whoever sets a title (the engine does, with the article's own) is naming the
       article; the product's name goes in front of it. */
    new MutationObserver(function () {
      if (document.title === lastSet) return;
      setTitle(bare(document.title));
    }).observe(el, { childList: true, characterData: true, subtree: true });
    setTitle(selectedTab() || bare(document.title));

    /* Switching an article tab changes which piece is open without the engine
       setting a title, so the selected tab is the article's name then. */
    var app = document.getElementById('app');
    if (!app) return;
    var strip = null;
    var onTabs = new MutationObserver(function () {
      var name = selectedTab();
      if (name) setTitle(name);
    });
    function follow() {
      var now = document.getElementById('castor-tabs');
      if (now === strip) return;
      onTabs.disconnect();
      strip = now;
      if (strip) {
        onTabs.observe(strip, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected'] });
        var name = selectedTab();
        if (name) setTitle(name);
      }
    }
    new MutationObserver(follow).observe(app, { childList: true });
    follow();
  }

  /* ---- the name's tap -------------------------------------------------------- */

  function tapName() {
    var name = document.querySelector('#topbar .brand-name');
    if (!name) return;
    var brand = name.closest('.brand');
    if (brand) brand.addEventListener('click', function () {
      var Castor = window.Castor || {};
      if (Castor.role && Castor.role.reviewer) return;
      if (Castor.panels && Castor.panels.open) Castor.panels.open('files', 'left');
    });
    name.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      name.classList.add('brand-play');
      setTimeout(function () { name.classList.remove('brand-play'); }, 900);
    });
  }

  /* ---- the install ----------------------------------------------------------- */

  function applyIdentity() {
    var root = document.documentElement;
    var tag = document.getElementById && document.getElementById('castor-data'), publicData;
    try { publicData = tag && JSON.parse(tag.textContent); } catch (e) { publicData = null; }
    var publicWriter = publicData && publicData.publicWriter === true;
    var logo = root.getAttribute('data-logo');
    if (publicWriter) { logo = '2'; root.setAttribute('data-logo', logo); }
    if (!/^(?:[1-6]|none)$/.test(logo || '')) return;
    var base = '/logos/' + logo + '/';
    var name = document.querySelector('#topbar .brand-name');
    if (name && logo !== 'none') {
      var mark = document.createElement('img');
      mark.className = 'descant-mark';
      mark.alt = '';
      mark.setAttribute('aria-hidden', 'true');
      mark.width = 36; mark.height = 30;
      function paint() {
        var theme = root.getAttribute('data-resolved') === 'dark' ? 'dark' : 'light';
        mark.src = publicWriter ? publicData.identityMarks[theme] : base + 'mark-' + theme + '.svg';
      }
      paint();
      name.prepend(mark);
      new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-resolved'] });
    }
    if (publicWriter) return;
    document.querySelectorAll('link[rel="icon"]').forEach(function (link) {
      link.href = base + (link.sizes && String(link.sizes) ? 'favicon.ico' : 'favicon.svg');
    });
    var touch = document.querySelector('link[rel="apple-touch-icon"]');
    if (touch) touch.href = base + 'icon-180.png';
    var manifest = document.querySelector('link[rel="manifest"]');
    if (manifest) manifest.href = base + 'manifest-' + (root.getAttribute('data-signature') === 'full' ? 'full' : 'small') + '.webmanifest';
  }

  function wireLogoChoices() {
    document.querySelectorAll('[data-logo-choice]').forEach(function (link) {
      var choice = link.getAttribute('data-logo-choice');
      var url = new URL(location.href);
      if (choice) url.searchParams.set('logo', choice);
      else url.searchParams.delete('logo');
      link.href = url.href;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    });
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
      console.warn('[castor] the app could not register its worker, so it cannot be installed here', err);
    });
  }

  function wirePreviewChoices() {
    document.querySelectorAll('[data-preview-param]').forEach(function (link) {
      var param = link.getAttribute('data-preview-param');
      var value = link.getAttribute('data-preview-value');
      var url = new URL(location.href);
      if (value) url.searchParams.set(param, value);
      else url.searchParams.delete(param);
      link.href = url.href;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    });
  }

  function start() {
    var disclosure = new URL(location.href).searchParams.get('disclosure');
    document.documentElement.setAttribute('data-disclosure', disclosure === 'plus' ? 'plus' : 'chevron');
    applyIdentity();
    wireLogoChoices();
    wirePreviewChoices();
    watchTitle();
    tapName();
    if (document.readyState === 'complete') registerWorker();
    else window.addEventListener('load', registerWorker);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
