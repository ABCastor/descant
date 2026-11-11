/* Settings on the phone: one full-height sheet, grouped the way the device's own
   settings are. Every group is on one scroll, every setting is one line with its
   value, and a choice of several opens its own page inside the sheet, with a way
   back. Laptop and iPad keep the tabbed card; the controls are the same elements,
   so a choice made in either shape is the same choice. */
(function (global) {
  'use strict';
  var doc = global.document;
  if (!doc) return;
  var Castor = global.Castor = global.Castor || {};
  var panel, sub = null, fromMenu = false, wired = false, pushTimer = 0;
  // A choice the sheet shows as one line, and the select or picker that holds it.
  var CHOICES = [
    { id: 'theme', label: 'Theme', section: 'settings-page', first: true },
    { id: 'set-size', label: 'Text size' },
    { id: 'set-width', label: 'Text width' },
    { id: 'set-language', label: 'Language of this article' },
    { id: 'set-preset', label: 'Tools in More' }
  ];

  function phone() { var app = doc.getElementById('app'); return !!(app && app.dataset.mode === 'phone'); }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function chevron() {
    var s = el('span', 'set-chevron'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return s;
  }
  function open() { return !!(panel && panel.matches && panel.matches(':popover-open')); }
  function tabs() { return Array.prototype.slice.call(panel.querySelectorAll('[role="tab"]')); }

  /* --- one line per choice ------------------------------------------------- */
  function options(choice) {
    if (choice.id === 'theme') return Castor.prefs && Castor.prefs.themes ? Castor.prefs.themes : [];
    var select = doc.getElementById(choice.id);
    return select ? Array.prototype.map.call(select.options, function (o) { return { value: o.value, label: o.textContent }; }) : [];
  }
  function current(choice) {
    if (choice.id === 'theme') return Castor.prefs && Castor.prefs.theme ? Castor.prefs.theme() : 'system';
    var select = doc.getElementById(choice.id); return select ? select.value : '';
  }
  function choose(choice, value) {
    if (choice.id === 'theme') { if (Castor.prefs && Castor.prefs.setTheme) Castor.prefs.setTheme(value); return; }
    var select = doc.getElementById(choice.id);
    if (!select || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new global.Event('change', { bubbles: true }));
  }
  function home(choice) {
    if (choice.id === 'theme') return null;
    var select = doc.getElementById(choice.id);
    return select && select.closest ? select.closest('.set-row') : null;
  }
  function navRow(id, label, onOpen) {
    var row = el('button', 'set-row set-nav'); row.type = 'button'; row.id = 'set-nav-' + id;
    row.appendChild(el('span', 'set-lbl', label));
    row.appendChild(el('span', 'set-value'));
    row.appendChild(chevron());
    row.addEventListener('click', onOpen);
    return row;
  }
  function buildChoices() {
    CHOICES.forEach(function (choice) {
      if (doc.getElementById('set-nav-' + choice.id)) return;
      var original = home(choice), section = original ? original.parentNode : doc.getElementById(choice.section);
      if (!section) return;
      var row = navRow(choice.id, choice.label, function () { openChoice(choice, row); });
      if (original) {
        original.classList.add('set-has-nav'); section.insertBefore(row, original);
        if (original.classList.contains('set-wide-only')) row.classList.add('set-wide-only');
      }
      else section.insertBefore(row, choice.first ? section.firstChild : null);
      choice.row = row;
    });
    var font = doc.querySelector('#set-reading-font .cw-reading-picker');
    if (font && !font._sheet) {
      font._sheet = true;
      font.querySelector('summary').addEventListener('click', function (event) {
        if (!panel.hasAttribute('data-sheet')) return;
        event.preventDefault(); openFont(font);
      });
    }
  }
  function paintChoices() {
    CHOICES.forEach(function (choice) {
      var row = choice.row; if (!row) return;
      var value = current(choice), found = options(choice).filter(function (o) { return o.value === value; })[0];
      row.querySelector('.set-value').textContent = found ? found.label : '';
      // A row its home hides (the language of an article without one) hides with it.
      var original = home(choice);
      row.hidden = !!(original && original.hidden);
    });
    var offline = doc.getElementById('set-nav-offline');
    if (offline) {
      var receipt = Castor.offline && Castor.offline.receipt && Castor.offline.receipt();
      offline.querySelector('.set-value').textContent = receipt ? 'Ready' : 'Not set up';
    }
  }

  /* --- a page inside the sheet ---------------------------------------------- */
  function openSub(title, fill, done, opener) {
    closeSub(true);
    var page = el('div', 'settings-sub'); page.setAttribute('role', 'group'); page.setAttribute('aria-label', title);
    var head = el('div', 'settings-sub-head');
    var back = el('button', 'settings-sub-back'); back.type = 'button';
    back.appendChild(chevron()); back.appendChild(el('span', '', 'Settings'));
    back.setAttribute('aria-label', 'Back to Settings');
    back.addEventListener('click', function () { closeSub(); });
    head.appendChild(back); head.appendChild(el('h3', 'settings-sub-title', title));
    var body = el('div', 'settings-sub-body');
    page.appendChild(head); page.appendChild(body);
    fill(body);
    // Where Settings was scrolled, for the way back.
    var home = panel.scrollTop;
    panel.scrollTop = 0; panel.setAttribute('data-sub', '');
    panel.appendChild(page);
    sub = { page: page, done: done, opener: opener, home: home };
    // Laid out first, then moved in, so the page slides rather than appears.
    void page.offsetWidth;
    page.setAttribute('data-open', '');
    back.focus({ preventScroll: true });
  }
  function closeSub(now) {
    if (!sub) return;
    var gone = sub; sub = null;
    panel.removeAttribute('data-sub');
    panel.scrollTop = gone.home || 0;
    if (gone.done) gone.done();
    gone.page.removeAttribute('data-open');
    var remove = function () { if (gone.page.parentNode) gone.page.parentNode.removeChild(gone.page); };
    if (now || global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) remove();
    else { gone.page.addEventListener('transitionend', remove, { once: true }); global.setTimeout(remove, 400); }
    paintChoices();
    if (!now && gone.opener && gone.opener.focus) gone.opener.focus({ preventScroll: true });
  }
  function optionList(items, selected, pick) {
    var list = el('div', 'set-options'); list.setAttribute('role', 'radiogroup');
    items.forEach(function (item) {
      var b = el('button', 'set-option'); b.type = 'button'; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(item.value === selected));
      b.appendChild(el('span', 'set-lbl', item.label));
      var tick = el('span', 'set-tick'); tick.setAttribute('aria-hidden', 'true');
      tick.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.appendChild(tick);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(list.children, function (other) { other.setAttribute('aria-checked', String(other === b)); });
        pick(item.value);
        // The tick moves, then the page goes back: one tap per choice.
        global.setTimeout(function () { if (sub && sub.page.contains(b)) closeSub(); }, 180);
      });
      list.appendChild(b);
    });
    return list;
  }
  function openChoice(choice, row) {
    openSub(choice.label, function (body) {
      body.appendChild(optionList(options(choice), current(choice), function (value) { choose(choice, value); }));
    }, null, row);
  }
  function openFont(details) {
    var list = details.querySelector('.cw-reading-options');
    if (!list) return;
    openSub('Reading font', function (body) {
      body.appendChild(list);
      list.addEventListener('click', fontPicked);
    }, function () { list.removeEventListener('click', fontPicked); details.appendChild(list); }, details.querySelector('summary'));
  }
  function fontPicked(event) {
    var hit = event.target.closest && event.target.closest('button');
    // Only the page this font was chosen on goes back; another opened meanwhile stays.
    var mine = sub;
    if (hit && !hit.disabled) global.setTimeout(function () { if (sub && sub === mine) closeSub(); }, 180);
  }
  function openOffline(row) {
    var area = doc.getElementById('descant-offline'), section = doc.getElementById('settings-offline');
    if (!area || !section) return;
    openSub('Offline and recovery', function (body) { body.appendChild(area); },
      function () { section.appendChild(area); }, row);
  }

  /* --- the sheet's shape ------------------------------------------------------ */
  function arrange() {
    if (!panel) return;
    var sheet = phone();
    if (sheet !== panel.hasAttribute('data-sheet')) {
      if (sheet) panel.setAttribute('data-sheet', ''); else panel.removeAttribute('data-sheet');
      if (!sheet) closeSub(true);
    }
    buildChoices();
    tabs().forEach(function (tab) {
      var section = doc.getElementById(tab.getAttribute('aria-controls'));
      if (!section) return;
      // The group's name sits above its card, as the tab's name does on the laptop.
      var title = panel.querySelector('.settings-group[data-for="' + section.id + '"]');
      if (!title) { title = el('h3', 'settings-group', tab.textContent.trim()); title.setAttribute('data-for', section.id); title.setAttribute('aria-hidden', 'true'); }
      if (title.nextSibling !== section) section.parentNode.insertBefore(title, section);
      if (sheet) {
        section.hidden = tab.hidden;
        section.setAttribute('role', 'group'); section.setAttribute('aria-label', tab.textContent.trim());
        section.removeAttribute('tabindex');
      } else {
        section.hidden = tab.getAttribute('aria-selected') !== 'true';
        section.setAttribute('role', 'tabpanel'); section.removeAttribute('aria-label');
        section.setAttribute('tabindex', '0');
      }
      title.hidden = section.hidden;
    });
    var offline = doc.getElementById('settings-offline');
    if (offline && doc.getElementById('descant-offline') && !doc.getElementById('set-nav-offline')) {
      var row = navRow('offline', 'Offline and recovery', function () { openOffline(row); });
      offline.insertBefore(row, offline.firstChild);
    }
    paintChoices();
    var back = doc.getElementById('settings-back');
    if (back) back.hidden = !(sheet && fromMenu);
  }

  // The Menu held under a push lets go when the push ends, or at once if Settings closes first.
  function endPush() {
    if (pushTimer) global.clearTimeout(pushTimer);
    pushTimer = 0;
    var menu = doc.getElementById('more-sheet');
    if (menu) menu.removeAttribute('data-under-push');
  }
  function wire() {
    panel = doc.getElementById('castor-settings');
    if (!panel || wired) return;
    wired = true;
    var done = doc.getElementById('settings-done'), back = doc.getElementById('settings-back');
    if (done) done.addEventListener('click', function () { if (panel.hidePopover) panel.hidePopover(); });
    if (back) back.addEventListener('click', function () {
      if (panel.hidePopover) panel.hidePopover();
      // After this tap has finished, or the Menu's own outside-tap rule would close it again.
      endPush();
      global.setTimeout(function () { var menu = doc.getElementById('more-word'); if (menu) menu.click(); }, 0);
    });
    // Settings chosen from the phone's Menu is a page pushed from it, with the way back.
    doc.addEventListener('click', function (event) {
      var hit = event.target.closest && event.target.closest('#menu-settings');
      if (!hit) return;
      fromMenu = true;
      // Marked before the sheet opens, so its first frame is already off to the right.
      if (phone()) panel.setAttribute('data-pushed', '');
      // The Menu stays painted under the page being pushed over it, then goes.
      var menu = doc.getElementById('more-sheet');
      if (menu && phone()) {
        endPush();
        menu.setAttribute('data-under-push', '');
        pushTimer = global.setTimeout(endPush, 340);
      }
    }, true);
    panel.addEventListener('toggle', function (event) {
      if (event.newState === 'open') {
        if (fromMenu && phone()) panel.setAttribute('data-pushed', ''); else panel.removeAttribute('data-pushed');
        arrange();
        if (phone()) panel.scrollTop = 0;
      } else { closeSub(true); fromMenu = false; endPush(); panel.removeAttribute('data-pushed'); }
    });
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sub) { event.preventDefault(); event.stopPropagation(); closeSub(); }
    }, true);
    var app = doc.getElementById('app');
    if (app && global.MutationObserver) new global.MutationObserver(function () { arrange(); }).observe(app, { attributes: true, attributeFilter: ['data-mode'] });
    arrange();
  }

  Castor.settingsSheet = { arrange: arrange, open: open, closeSub: closeSub };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', wire); else wire();
})(typeof window !== 'undefined' ? window : this);
