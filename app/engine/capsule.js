/* Layout-owned writing chrome. Existing controls keep their state and actions. */
(function (global) {
  'use strict';
  var doc = global.document;
  if (!doc) return;
  var Castor = global.Castor = global.Castor || {};
  var menu, arranging = false, peek = null, commentControl;
  function bar() { return doc.getElementById('topbar'); }
  function words() { return doc.querySelector('.nav.topwords'); }
  function phone() { var app = doc.getElementById('app'); return !!(app && app.dataset.mode === 'phone'); }
  function move(node, target) { if (node && target && node.parentNode !== target) target.appendChild(node); }
  function commentPeek(value) {
    peek = value;
    if (menu) paintCommentPeek();
    return commentControl;
  }
  function paintCommentPeek() {
    var control = commentControl;
    if (!control) return;
    var app = doc.getElementById('app'), save = doc.getElementById('writing-save-slot');
    var writing = app.dataset.keyboard === 'up' && save && save.parentNode;
    var compact = peek && writing && phone();
    var target = peek && writing ? save.parentNode : words();
    move(control, target);
    var next = peek && writing ? save : phone() ? menu.word : target.querySelector('[data-panel="changes"]') || menu.word;
    if (next && control.nextSibling !== next) target.insertBefore(control, next);
    // The phone chip yields history's pinned space to the formatting strip.
    if (writing) ['undo', 'redo'].forEach(function (id) {
      var button = doc.querySelector('.command-island[data-arrangement="writing"] [data-command="' + id + '"]');
      var history = compact ? doc.querySelector('.command-island[data-arrangement="writing"] .command-island-row') : save.parentNode;
      if (button && button.parentNode !== history) {
        if (compact) history.appendChild(button);
        else history.insertBefore(button, peek ? control : save);
      }
    });
    var preview = control.querySelector('.comment-preview');
    if (!peek) {
      control.removeAttribute('data-comment-peek');
      if (preview) { preview.remove(); preview = null; }
      var width = control.getBoundingClientRect().width;
      if (width) control.style.setProperty('--comment-slot-width', width + 'px');
    }
    if (peek) {
      if (!preview) {
        preview = doc.createElement('span'); preview.className = 'comment-preview';
        var author = doc.createElement('span'); author.className = 'comment-preview-author'; preview.appendChild(author);
        var text = doc.createElement('span'); text.className = 'comment-preview-text'; preview.appendChild(text);
        var more = doc.createElement('span'); more.className = 'comment-preview-more'; preview.appendChild(more);
        control.appendChild(preview);
      }
      var label = peek.author.trim().split(/\s+/)[0], count = peek.ids.length > 1 ? '+' + (peek.ids.length - 1) : '';
      if (preview.firstChild.textContent !== label) preview.firstChild.textContent = label;
      if (preview.children[1].textContent !== peek.words) preview.children[1].textContent = peek.words;
      if (preview.lastChild.textContent !== count) preview.lastChild.textContent = count;
      control.setAttribute('data-comment-peek', '');
      var additional = peek.ids.length - 1;
      var accessibleWords = additional ? peek.words.replace(/[.!?]+$/, '') + ', and ' + additional + ' more thread' + (additional === 1 ? '' : 's') : peek.words;
      control.setAttribute('aria-label', 'Comment by ' + peek.author + ': ' + accessibleWords + (/[.!?]$/.test(accessibleWords) ? ' ' : '. ') + 'Open thread');
    } else {
      control.removeAttribute('data-comment-peek'); control.removeAttribute('aria-label');
      if (preview) preview.remove();
    }
  }
  function labelWords() {
    Array.prototype.forEach.call(doc.querySelectorAll('.topwords .word, #more-sheet .word, .descant-share'), function (w) {
      if (!w.querySelector(':scope > .word-label')) {
        for (var n = w.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 && n.nodeValue.trim()) {
            var label = doc.createElement('span'); label.className = 'word-label'; label.textContent = n.nodeValue.trim();
            w.replaceChild(label, n); break;
          }
        }
      }
      if (!w.querySelector(':scope > .chrome-icon') && !w.classList.contains('capsule-publish')) {
        var icon = doc.createElement('span'); icon.className = 'chrome-icon'; icon.setAttribute('aria-hidden', 'true');
        w.insertBefore(icon, w.firstChild);
      }
    });
  }
  function writer() {
    var app = doc.getElementById('app');
    return !!(app && app.hasAttribute('data-preset') && !(Castor.role && Castor.role.reviewer) && Castor.publishState && Castor.publishState.open);
  }
  function publishButton() {
    var button = doc.querySelector('.capsule-publish');
    if (!button) {
      button = doc.createElement('button'); button.type = 'button'; button.className = 'word capsule-publish';
      var label = doc.createElement('span'); label.className = 'word-label'; label.textContent = 'Publish'; button.appendChild(label);
      button.addEventListener('click', function () { if (Castor.publishState) Castor.publishState.open(); });
    }
    button.hidden = !writer(); return button;
  }
  function updateCounts() {
    var b = bar();
    if (!b) return;
    var counts = {
      comments: Castor.comments && Castor.comments.list ? Castor.comments.list().filter(function (t) { return !t.done; }).length : 0,
      changes: Castor.changes && Castor.changes.current ? Castor.changes.current().unread : 0
    };
    if (Castor.versions) counts.drafts = Castor.versions.count();
    Object.keys(counts).forEach(function (id) {
      var w = b.querySelector('[data-panel="' + id + '"]') || doc.querySelector('#app [data-panel="' + id + '"]');
      if (!w) return;
      var count = w.querySelector('.count');
      if (!count) { count = doc.createElement('span'); count.className = 'count'; w.appendChild(count); }
      var value = String(counts[id] || 0); if (count.textContent !== value) count.textContent = value;
      // Open versions show Versions in every preset, so a rewrite beside the article is never missed.
      if (id === 'drafts') { if (counts[id]) w.setAttribute('data-open', ''); else w.removeAttribute('data-open'); }
    });
  }
  function proxy(sheet, id, label, source, action, icon) {
    var button = doc.getElementById(id);
    if (button) return button;
    button = doc.createElement('button'); button.type = 'button'; button.className = 'word menu-tool'; button.id = id;
    button.dataset.icon = icon || id;
    var text = doc.createElement('span'); text.className = 'word-label'; text.textContent = label; button.appendChild(text);
    button.addEventListener('click', function () { var target = source && doc.querySelector(source); if (target) target.click(); else if (action) action(); });
    sheet.appendChild(button); return button;
  }
  function layoutMenu(value) {
    menu = value;
    var b = bar(), nav = words(), foot = doc.getElementById('footline'), meta = foot && foot.querySelector('.foot-meta');
    if (!b || !nav || !foot || !meta) return;
    foot.classList.add('dock-bar');
    if (!foot._chromePointer) { foot._chromePointer = true; foot.addEventListener('pointerdown', function (event) { event.stopPropagation(); }); }
    var small = phone(), sheet = menu.sheet;
    move(nav, small ? b : foot); move(menu.word, nav); move(sheet, b);
    var menuLabel = menu.word.querySelector('.more-label');
    if (menuLabel && menuLabel.textContent !== (small ? 'Menu' : 'More')) menuLabel.textContent = small ? 'Menu' : 'More';
    menu.word.setAttribute('aria-label', small ? 'Menu' : 'More');
    sheet.setAttribute('aria-label', small ? 'Menu' : 'More');
    ['outline', 'comments', 'changes', 'files', 'drafts', 'workspace', 'links', 'for-you'].forEach(function (id) {
      var button = id === 'comments' && commentControl || doc.querySelector('.topwords [data-panel="' + id + '"], #more-sheet [data-panel="' + id + '"]');
      if (id === 'comments' && button) {
        commentControl = button;
        if (!button._peekClick) {
          button._peekClick = true;
          button.addEventListener('mousedown', function (event) { if (peek) event.preventDefault(); });
          button.addEventListener('click', function (event) { if (peek) { event.preventDefault(); event.stopImmediatePropagation(); peek.open(); } }, true);
        }
      }
      if (id !== 'comments') move(button, id === 'comments' || !small && ['outline', 'changes', 'drafts'].indexOf(id) >= 0 ? nav : sheet);
      if (button && Castor.panels) {
        if (Castor.panels.isReady) button.hidden = !Castor.panels.isReady(id);
        if (Castor.panels.isOpen) button.setAttribute('aria-pressed', String(Castor.panels.isOpen(id)));
      }
    });
    var section = doc.getElementById('menu-publish');
    if (!section) {
      section = doc.createElement('section'); section.id = 'menu-publish'; section.setAttribute('aria-label', 'Publish');
      var heading = doc.createElement('h2'); heading.textContent = 'Publish'; section.appendChild(heading);
      sheet.insertBefore(section, sheet.firstChild);
    }
    var pub = publishButton(), live = doc.querySelector('.descant-live-marker');
    move(live, small ? section : meta); move(pub, small ? section : meta);
    var shortcuts = doc.getElementById('castor-shortcuts'); move(shortcuts, sheet);
    if (shortcuts) shortcuts.dataset.icon = 'shortcuts';
    proxy(sheet, 'menu-search', 'Search', '.find-lens', null, 'search');
    proxy(sheet, 'menu-theme', 'Theme', '#theme-switch', null, 'theme');
    proxy(sheet, 'menu-settings', 'Settings', '#castor-settings-gear', null, 'settings');
    proxy(sheet, 'menu-share', 'Share', '.descant-share', null, 'share');
    var articles = doc.getElementById('menu-articles');
    if (!articles) { articles = doc.createElement('section'); articles.id = 'menu-articles'; articles.setAttribute('aria-label', 'Open articles'); sheet.appendChild(articles); }
    var tabs = Array.prototype.slice.call(doc.querySelectorAll('#castor-tabs .castor-tab'));
    var stamp = tabs.map(function (tab) { return tab.textContent + ':' + tab.getAttribute('aria-selected'); }).join('|');
    if (articles._stamp !== stamp) {
      articles._stamp = stamp; articles.textContent = '';
      var title = doc.createElement('h2'); title.textContent = 'Open articles'; articles.appendChild(title);
      tabs.forEach(function (tab, i) {
        var button = proxy(articles, 'menu-article-' + i, tab.textContent.trim(), null, function () { tab.click(); }, 'article');
        button.setAttribute('aria-current', tab.getAttribute('aria-selected') === 'true' ? 'page' : 'false');
      });
    }
    move(doc.querySelector('.foot-by'), sheet);
    var save = doc.getElementById('phone-save-slot');
    if (!save) { save = doc.createElement('span'); save.id = 'phone-save-slot'; b.insertBefore(save, nav.parentNode === b ? nav : b.querySelector('.bar-tools')); }
    var strip = doc.getElementById('castor-tabs');
    if (strip && strip.parentNode !== b) b.insertBefore(strip, b.querySelector('.brand').nextSibling);
    var share = doc.querySelector('.descant-share'), tools = b.querySelector('.bar-tools');
    if (share && tools && share.parentNode !== tools) tools.insertBefore(share, tools.firstChild);
    if (Castor.touchLayout) Castor.touchLayout.placeSave();
    labelWords(); updateCounts(); paintCommentPeek();
  }
  function openPublishFromLive(event) {
    var live = event.target.closest && event.target.closest('.descant-live-marker');
    if (!live || !Castor.publishState || !Castor.publishState.open) return;
    // The marker's older target listener can stop other target listeners.
    // Capture from its ancestor so the dock's promised action wins first.
    event.preventDefault(); event.stopImmediatePropagation();
    Castor.publishState.open();
    if (menu) {
      menu.sheet.hidden = true;
      menu.word.setAttribute('aria-expanded', 'false'); menu.word.setAttribute('aria-pressed', 'false');
    }
  }
  function measureMargins() {
    var app = doc.getElementById('app'), col = doc.querySelector('#page .page-column');
    if (!app || !col) return;
    var width = col.getBoundingClientRect().width;
    var free = Math.floor(((global.innerWidth || 0) - width) / 2 - 24);
    if (app._marginFree !== free) { app._marginFree = free; app.style.setProperty('--margin-free', free + 'px'); }
  }
  function arrange() {
    if (arranging) return;
    arranging = true;
    try { if (menu) layoutMenu(menu); measureMargins(); } finally { arranging = false; }
  }
  function start() {
    var app = doc.getElementById('app'); if (!app || !bar()) return;
    arrange();
    app.addEventListener('click', openPublishFromLive, true);
    var observer = new global.MutationObserver(arrange);
    observer.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-mode', 'data-keyboard', 'data-preset'] });
    if (Castor.bus && Castor.bus.on) ['comments:pending', 'comments:saved', 'comments:unsaved', 'piece:opened', 'live:reload', 'save:state'].forEach(function (name) { Castor.bus.on(name, arrange); });
    if (Castor.panels && Castor.panels.onLayout) Castor.panels.onLayout(arrange);
    global.addEventListener('resize', arrange, { passive: true });
    if (global.ResizeObserver) { var col = doc.querySelector('#page .page-column'); if (col) new global.ResizeObserver(measureMargins).observe(col); }
  }
  Castor.capsule = { arrange: arrange, layoutMenu: layoutMenu, commentPeek: commentPeek };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : this);
