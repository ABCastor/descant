(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;
  var S = {
    mounted: false, ctx: null, world: 'dev', root: null, card: null, spot: null,
    title: null, copy: null, count: null, back: null, next: null, skip: null,
    index: 0, active: false, target: null, targetClass: null,
    step: null, reopen: null, expanded: false, formatting: false, focusBefore: false,
    raf: 0, observer: null, watched: null, pulled: 0,
    originalPath: null, opening: null, leaving: null, manual: null, drag: null, tryButton: null, short: false,
    done: false, mark: 0, revealed: null, covered: false
  };
  var PRACTICE = 'articles/98-skunk-and-beaver/article.md';
  // A second practice piece, so "open another article" works in a new account.
  var PRACTICE_TWO = 'articles/97-practice-sandbox-2/article.md';

  var PAD = 7;      // ring padding around the target box
  var GAP = 16;     // clear space between the ring and the card
  var EDGE = 14;    // smallest distance from the card to a viewport edge

  function hit(event, selector) {
    return !!(event && event.target && event.target.closest && event.target.closest(selector));
  }
  function opened(id) {
    return function () { return !!(Castor.panels && Castor.panels.isOpen(id)); };
  }
  function shown(selector) {
    return function () { return !!firstOnScreen(selector); };
  }
  function popover(id) {
    var el = DOC.getElementById(id);
    return !!(el && el.matches && el.matches(':popover-open'));
  }
  function pointing() {
    return paragraphTarget();
  }
  function practiceBlock(empty) {
    var blocks = Castor.editor && Castor.editor.getBlocks ? Castor.editor.getBlocks() : [];
    return blocks.find(function (b) { return b.type === 'p' && (empty ? !b.source.trim() :
      /first comment/.test(b.source)); }) || blocks.find(function (b) {
      return b.type === 'p' && (empty ? !b.source.trim() : b.source.trim() && !/^%%/.test(b.source));
    });
  }
  function paragraphTarget(empty) {
    var b = practiceBlock(empty);
    return b ? firstOnScreen('#page-article .cw-block[data-block-id="' + b.id + '"]') : null;
  }
  function prepareEmpty() {
    if (!Castor.pieces || Castor.pieces.current() !== PRACTICE || !Castor.editor) return;
    var b = practiceBlock(true), after = practiceBlock(false);
    var id = b && b.id;
    if (!id && after && Castor.editor.insertAt) id = Castor.editor.insertAt(after.id, '');
    if (id && Castor.editor.focusBlock) Castor.editor.focusBlock(id, 0);
  }
  function addFootnote() {
    var b = practiceBlock(false);
    if (!b || !Castor.editor || !Castor.pieces || Castor.pieces.current() !== PRACTICE) return;
    Castor.editor.focusBlock(b.id, b.source.length);
    Castor.editor.command('footnote');
    bump();
  }
  function openSettings(tab) {
    var settings = DOC.getElementById('castor-settings');
    if (settings && settings.showPopover && !popover('castor-settings')) settings.showPopover();
    var page = tab && DOC.getElementById('settings-tab-' + tab);
    if (page && page.click && page.getAttribute && page.getAttribute('aria-selected') !== 'true') page.click();
  }
  /* A quiet interface hides some top-bar words (Settings, Page, Interface).
     The step that needs one shows it for as long as the step is up. */
  function reveal(el) {
    if (!el || !el.classList) return el;
    if (S.revealed && S.revealed !== el) S.revealed.classList.remove('walkthrough-reveal');
    el.classList.add('walkthrough-reveal'); S.revealed = el;
    return el;
  }
  function unreveal() {
    if (S.revealed && S.revealed.classList) S.revealed.classList.remove('walkthrough-reveal');
    S.revealed = null;
  }
  /* The word that opens a panel until it is open; then the panel itself, at its
     real size, so the ring shows what just appeared. */
  function panelTarget(id) {
    return function () {
      var panel = Castor.panels && Castor.panels.isOpen && Castor.panels.isOpen(id) &&
        firstOnScreen('.panel[data-panel-id="' + id + '"]');
      if (panel) return panel;
      if (!phone()) reveal(DOC.querySelector('#topbar [data-panel="' + id + '"]'));
      return firstOnScreen('[data-panel="' + id + '"]', '#more-word');
    };
  }
  function sentence(step) {
    return phone() && step.phone ? step.phone : typeof step.sentence === 'function' ? step.sentence() : step.sentence;
  }
  function structureCount() {
    var blocks = Castor.editor && Castor.editor.getBlocks ? Castor.editor.getBlocks() : [];
    return blocks.filter(function (b) { return /^(h[2-6]|list|quote|callout|table)$/.test(b.type); }).length;
  }
  function commentCount() {
    return DOC.querySelectorAll ? DOC.querySelectorAll('#page-article mark.commented').length : 0;
  }
  function practiceTwoTab() {
    var tab = DOC.querySelector('#castor-tabs [data-path="' + PRACTICE_TWO + '"]');
    return tab && visible(tab) ? tab : firstOnScreen('#castor-tabs', '#castor-tabs-fold');
  }

  /* Each step names what to do, in words a first-time writer can follow; `done`
     recognises that the writer has done it. A step never moves on by itself:
     when it is done, Next becomes the obvious way forward. `keys` lists command
     ids (their shortcut comes from the keyboard map, in this computer's own
     spelling) or literal chords. */
  var STEPS = [
    { id: 'write', title: 'Write a sentence', target: pointing,
      sentence: 'Click this paragraph and type a sentence. This is a practice article: what you write here never touches your own articles.',
      phone: 'Tap this paragraph and type a sentence. This is a practice article: what you write here never touches your own articles.',
      done: function (e) { return e.type === 'input' && hit(e, '#page-article .cw-edit'); } },
    { id: 'format', title: 'Make a word bold', target: function () { return firstOnScreen('.command-island[data-open="1"]', '.cw-selection-rect', '.cw-caret:not([hidden])') || paragraphTarget(); },
      sentence: 'Select a word, then press the bold keys below. The next pair makes it italic. The last one undoes your last change.',
      phone: 'Hold a word to select it, then tap B in the toolbar above the keyboard. Swipe the toolbar for more choices.',
      keys: ['edit.bold', 'edit.italic', 'edit.undo'],
      done: function (e) { return e.type === 'doc:change' && S.formatting; } },
    { id: 'structure', title: 'Add a heading or a list', target: function () { return paragraphTarget(true); }, prepare: prepareEmpty,
      sentence: 'On this empty line, type / and choose Heading or List. Articles are plain Markdown, so you can also type ## for a heading or - for a list.',
      phone: 'On this empty line, type / and choose Heading or List. Articles are plain Markdown, so you can also type ## for a heading or - for a list.',
      done: function () { return structureCount() > S.mark; } },
    { id: 'footnote', title: 'Add a footnote', target: function () { return firstOnScreen('.footnote-margin-edit', '.footnote-ref a[data-footnote]', '.footnote-margin') || paragraphTarget(); },
      sentence: 'Press Add a footnote, then write the note. It sits beside its paragraph while you write and goes to the end of the article when it is published.',
      phone: 'Tap Add a footnote, then write the note under the paragraph. It goes to the end of the article when it is published.',
      action: addFootnote, actionLabel: 'Add a footnote',
      done: function (e) { return (e.type === 'input' && hit(e, '.footnote-margin-edit')) || (e.type === 'click' && hit(e, '.footnote-ref a[data-footnote], .footnote-margin')); } },
    { id: 'comment', title: 'Comment on a passage', target: function () { return firstOnScreen('.castor-composer', '.selection-menu', '.cw-selection-rect') || paragraphTarget(); },
      sentence: 'Select a few words and choose Comment. Write your note; type @ to ask a person or @agent. Enter saves it, and the comment stays tied to those words.',
      phone: 'Hold and drag to select a few words, then tap Comment. Write your note; type @ to ask a person or @agent. Return saves it.',
      keys: ['edit.comment'],
      done: function (e) { return e.type === 'comments:saved' || commentCount() > S.mark; } },
    { id: 'comments', title: 'Find every comment', target: panelTarget('comments'),
      sentence: 'Open Comments to see every conversation on this article. Choose one to jump to its words. Drag a panel by its title to move it to the other side, or onto another panel.',
      phone: 'Tap More, then Comments, to see every conversation on this article. Choose one to jump to its words.',
      keys: ['panel.comments'], done: opened('comments') },
    { id: 'outline', title: 'Jump to a section', target: function () { return firstOnScreen('.panel[data-panel-id="outline"] .castor-row') || panelTarget('outline')(); },
      sentence: 'Open Outline and choose a heading to jump there. The arrows beside a heading fold the sections under it.',
      phone: 'Tap More, then Outline, and choose a heading to jump there.',
      keys: ['panel.outline'], done: function (e) { return e.type === 'click' && hit(e, '[data-outline-id]'); } },
    { id: 'search', title: 'Search everything', target: function () { return firstOnScreen('#global-search-input', '.find-lens'); },
      sentence: 'Open the magnifying glass and type a word. You find articles, passages, comments and commands in one list.',
      keys: ['go.search'], done: function (e) { return e.type === 'input' && hit(e, '#global-search-input') && e.target.value.trim().length >= 2; } },
    { id: 'tabs', title: 'Open another article', target: practiceTwoTab,
      sentence: 'Each tab is an article. Choose Practice sandbox 2. The arrow at the end of the row hides or shows the tabs.',
      phone: 'Each tab is an article. Swipe the row and choose Practice sandbox 2.',
      done: function (e) { return e.type === 'piece:open'; } },
    { id: 'save', title: 'Check that it is saved', target: function () { return firstOnScreen('#castor-save-details', '#castor-save'); }, dismiss: 'castor-save-details',
      sentence: 'Your writing saves by itself when you pause. Click Saved at the bottom: the ticks show a copy on this device, in the article history and on the shared server.',
      phone: 'Your writing saves by itself when you pause. Tap Saved at the bottom: the ticks show a copy on this device, in the article history and on the shared server.',
      done: function () { return popover('castor-save-details'); } },
    { id: 'changes', title: 'Catch up on edits', target: function () { return firstOnScreen('.changes-paragraph', '.changes-pair'); },
      sentence: 'When someone edits an article you read, Changes shows what is different since your last visit. Here is an example: the added word is highlighted and the removed word is crossed out. Open in article takes you to the paragraph.',
      prepare: function () { if (Castor.changes && Castor.changes.demonstrate) Castor.changes.demonstrate(); },
      done: function (e) { return e.type === 'click' && hit(e, '.changes-paragraph button'); } },
    { id: 'history', title: 'Mark it as read', target: function () { return firstOnScreen('.changes-done', '.changes-compare'); },
      sentence: 'Done reading tells Descant you have caught up, so next time Changes starts from here. It does not publish or approve anything.',
      prepare: function () { if (Castor.changes && Castor.changes.demonstrate && !Castor.changes._state?.on) Castor.changes.demonstrate(); },
      done: function (e) { return e.type === 'click' && hit(e, '.changes-done'); } },
    { id: 'files', title: 'Read a note beside your writing', target: function () { return firstOnScreen('.panel[data-panel-id="files"] .files-tree') || panelTarget('files')(); },
      sentence: 'Open Files and choose a note to read it next to the article. The practice has a picture and a voice note too.',
      phone: 'Tap More, then Files, and choose a note to read it. The practice has a picture and a voice note too.',
      keys: ['panel.files'], done: function (e) { return e.type === 'beside:open'; } },
    { id: 'workspace', title: 'Keep things at hand', target: panelTarget('workspace'),
      sentence: 'Workspace is a desk next to the article. Open it, then drag the picture or the voice note from Files onto it, or a sentence from the page.',
      phone: 'Tap More, then Workspace. It is a desk for passages, pictures, links and notes you are using.',
      keys: ['panel.workspace'], done: function (e) { return e.type === 'canvas:changed' || (phone() && opened('workspace')()); } },
    { id: 'settings', title: 'Open Settings', target: '#castor-settings-gear',
      sentence: 'The gear opens Settings: text size and width, spelling, writing offline and this guide.',
      keys: ['view.settings'], done: function () { return popover('castor-settings'); } },
    { id: 'focus', title: 'Write in Zen', target: function () { return firstOnScreen('#settings-focus .set-row-explained', '#castor-settings-gear'); },
      prepare: function () { openSettings('focus'); }, dismiss: 'castor-settings',
      sentence: 'In Settings, Focus, turn on Zen. Only your words stay on the screen.',
      phone: 'In Settings, Focus, turn on Zen. Only your words stay on the screen. The next card has a Leave Zen button.',
      keys: ['view.focus'], done: function () { return !!(Castor.panels && Castor.panels.isFocus()); } },
    { id: 'unfocus', title: 'Leave Zen', target: null,
      sentence: 'Press Escape, or move the pointer to the top left corner, to bring everything back.',
      phone: 'Tap Leave Zen below to bring everything back.',
      keys: ['Escape'], done: function () { return !!S.mark && !!(Castor.panels && !Castor.panels.isFocus()); } },
    { id: 'writer', title: 'Who is writing', target: function () { return firstOnScreen('#castor-who', '#castor-session'); }, dismiss: 'castor-who',
      sentence: 'The initials at the bottom right show who is writing. Every save and comment carries that name. Click them to see who is ticked or to change it.',
      phone: 'The initials at the bottom right show who is writing. Every save and comment carries that name. Tap them to change it.',
      done: shown('#castor-who') },
    { id: 'type', title: 'Choose the fonts', target: function () { return firstOnScreen('.panel[data-panel-id="type"]', '#global-search-input', '.find-lens', '#more-word'); },
      sentence: 'Fonts and colours live in the Type panel. Open search, type Type and choose it. Previous type choice takes you back.',
      phone: 'Fonts and colours live in the Type panel. Tap More, then Type. Previous type choice takes you back.',
      keys: ['go.search'], done: opened('type') },
    { id: 'shortcuts', title: 'Use only the keyboard', target: '#castor-shortcuts', dismiss: 'castor-keys-reference',
      sentence: "Everything in Descant works from the keyboard. Hold the key below for a second to see each control's shortcut, or open Shortcuts for the full list.",
      phone: 'With a keyboard attached, everything works from the keyboard. Hold Command or Ctrl for a second to see the shortcuts; Shortcuts has the full list.',
      keys: ['MOD'] },
    { id: 'end', title: 'You are ready', target: null,
      sentence: 'Finish takes you back to your writing. To see this guide again, open Settings, then Help, then Repeat the walkthrough.' }
  ];

  /* ------------------------------------------------------------- persistence */

  function reviewing() { return !!(Castor.role && Castor.role.reviewer); }
  var READER_STEPS = [
    { id: 'reader-welcome', title: 'Read and leave a note', target: null,
      sentence: 'You can read the articles shared with you and discuss them with their writers. This short guide shows you how. Close skips it; Settings reopens it.' },
    { id: 'reader-select', title: 'Comment on a passage', target: pointing,
      sentence: 'Select a few words, then choose Comment. Type your note and press Enter. Escape closes an unfinished draft and keeps it on this device.' },
    { id: 'reader-replies', title: 'Keep the conversation together', target: panelTarget('comments'),
      sentence: 'Open Comments to find your threads. Reply continues a conversation. The writers receive your saved comments and can reply here; you see your own threads and their replies.',
      prepare: function () { if (Castor.panels && Castor.panels.open) Castor.panels.open('comments'); } },
    { id: 'reader-save', title: 'Check that your words arrived', target: '#castor-save',
      sentence: 'Saved means your comments reached the review service. Saving means they are being sent. Not saved means a draft or a failed send needs attention. Tap the status for details.' },
    { id: 'reader-colour', title: 'Choose your comment colour', target: '#set-reader-color-row',
      sentence: 'In Settings, open You and choose your comment colour. New comments use it; earlier comments keep their colour.',
      prepare: function () { openSettings(); var tab = DOC.getElementById('settings-tab-account'); if (tab && tab.click) tab.click(); } },
    { id: 'reader-theme', title: 'Make reading comfortable', target: '#theme-switch',
      sentence: "The theme control switches between light, dark and your device's setting. Settings also has text size and width. You can reopen this guide from Settings, Help, Repeat the walkthrough.",
      prepare: function () { var settings = DOC.getElementById('castor-settings'); if (settings && settings.hidePopover && popover('castor-settings')) settings.hidePopover(); } }
  ];

  var QUICK = ['write', 'structure', 'outline', 'save', 'changes', 'history', 'settings', 'focus', 'unfocus', 'end'];
  function activeSteps() { if (reviewing()) return READER_STEPS; return S.short ? STEPS.filter(function (s) { return QUICK.indexOf(s.id) >= 0; }) : STEPS; }
  function stepAt(i) { return activeSteps()[i]; }
  function key() { return 'castor.' + S.world + '.walkthrough' + (reviewing() ? '.reader.' + encodeURIComponent(Castor.role.id || 'unconfirmed') : ''); }
  function autoStartEnabled() {
    try { return new URLSearchParams(global.location.search).get('tour') !== 'off'; }
    catch (e) { return true; }
  }
  function read() {
    try { return JSON.parse(localStorage.getItem(key()) || '{}'); }
    catch (e) { return {}; }
  }
  function remember(completed) {
    try { localStorage.setItem(key(), JSON.stringify({ seen: true, step: stepAt(S.index).id, completed: !!completed, originalPath: S.originalPath })); }
    catch (e) { /* Storage may be disabled. */ }
  }

  /* ------------------------------------------------------------------- shell */

  function make(tag, cls, text) {
    var el = DOC.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function ensure() {
    if (S.root) return;
    var root = make('section', 'walkthrough');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    // Share the browser's top layer with Settings and save receipts.
    if (root.showPopover) {
      root.setAttribute('popover', 'manual');
      Object.assign(root.style, { margin: '0', padding: '0', border: '0', background: 'none', width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none' });
    }
    root.setAttribute('aria-label', 'App walkthrough');

    var spot = make('div', 'walkthrough-spotlight');
    spot.setAttribute('aria-hidden', 'true');
    var card = make('div', 'walkthrough-card');
    var meta = make('div', 'walkthrough-meta');
    var count = make('span', 'walkthrough-count');
    var skip = make('button', 'walkthrough-skip', 'Close'); skip.type = 'button';
    var move = make('button', 'walkthrough-move', 'Move guide'); move.type = 'button';
    move.setAttribute('aria-label', 'Move guide. Drag or use the arrow keys.');
    meta.appendChild(count); meta.appendChild(move); meta.appendChild(skip);
    var title = make('h2', 'walkthrough-title');
    var copy = make('p', 'walkthrough-copy');
    var keys = make('div', 'walkthrough-keys');
    var actions = make('div', 'walkthrough-actions');
    var back = make('button', 'walkthrough-back', 'Back'); back.type = 'button';
    var next = make('button', 'walkthrough-next', 'Next'); next.type = 'button';
    actions.appendChild(back); actions.appendChild(next);
    card.appendChild(meta); card.appendChild(title); card.appendChild(copy);
    var tryButton = make('button', 'walkthrough-try'); tryButton.type = 'button'; tryButton.hidden = true;
    tryButton.addEventListener('click', function () { if (S.active && !S.leaving && S.step.action) S.step.action(); });
    card.appendChild(tryButton); S.tryButton = tryButton;
    var status = make('p', 'walkthrough-status'); status.setAttribute('aria-live', 'polite');
    card.appendChild(keys); card.appendChild(status); card.appendChild(actions);
    var reopen = make('button', 'walkthrough-reopen', 'Show step');
    Object.assign(reopen.style, { position: 'fixed', right: '14px', top: '14px', pointerEvents: 'auto' });
    reopen.hidden = true;
    reopen.addEventListener('click', function () { S.expanded = true; place(); });
    root.appendChild(spot); root.appendChild(card); root.appendChild(reopen);
    S.reopen = reopen;
    DOC.body.appendChild(root);

    skip.addEventListener('click', skipTour);
    back.addEventListener('click', backStep);
    next.addEventListener('click', nextStep);
    S.root = root; S.spot = spot; S.card = card; S.title = title; S.copy = copy; S.keys = keys;
    S.count = count; S.skip = skip; S.back = back; S.next = next; S.status = status;
    move.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var box = S.card.getBoundingClientRect();
      S.drag = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
      S.root.dataset.dragging = '1';
      if (move.setPointerCapture) move.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    move.addEventListener('pointermove', function (e) {
      if (!S.drag) return;
      S.manual = { left: S.drag.left + e.clientX - S.drag.x, top: S.drag.top + e.clientY - S.drag.y };
      place();
    });
    var endDrag = function () { S.drag = null; delete S.root.dataset.dragging; place(); };
    move.addEventListener('pointerup', endDrag); move.addEventListener('pointercancel', endDrag);
    move.addEventListener('keydown', function (e) {
      var delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key];
      if (!delta) return;
      e.preventDefault(); e.stopPropagation();
      S.manual = { left: (parseFloat(S.card.style.left) || 0) + delta[0], top: (parseFloat(S.card.style.top) || 0) + delta[1] };
      place();
    });
  }

  function phone() {
    var app = (S.ctx && S.ctx.app) || DOC.getElementById('app');
    return !!(app && ((app.dataset && app.dataset.mode === 'phone') || app.clientWidth < 700));
  }

  function clearTarget() {
    if (S.targetClass) S.targetClass.classList.remove('walkthrough-target');
    if (S.observer && S.watched) {
      try { S.observer.unobserve(S.watched); } catch (e) { /* already gone */ }
    }
    S.watched = null;
    S.targetClass = null; S.target = null;
  }
  function watchTarget(el) {
    if (!S.observer || !el || el === S.watched) return;
    if (S.watched) { try { S.observer.unobserve(S.watched); } catch (e) { /* gone */ } }
    S.watched = el;
    try { S.observer.observe(el); } catch (e) { S.watched = null; }
  }
  function targetOf(step) {
    if (!step || step.target == null) return null;
    try { return typeof step.target === 'function' ? step.target() : DOC.querySelector(step.target); }
    catch (e) { return null; }
  }

  /* The first selector that is really on screen at this size. The saves rail is
     display:none under 700px and the selection menu does not come up from a
     synthetic selection there, so a step naming one selector pointed at nothing
     on a phone. Each step names its desktop control first and the phone's own
     stand-in after it. */
  function firstOnScreen() {
    for (var i = 0; i < arguments.length; i++) {
      var found = null;
      try { found = DOC.querySelector(arguments[i]); } catch (e) { found = null; }
      if (!found) continue;
      if (visible(found)) return found;
    }
    return null;
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (!(r.width || r.height)) return false;
    if (!(r.right > 0 && r.bottom > 0 && r.left < global.innerWidth && r.top < global.innerHeight)) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return onTop(el, r);
  }

  /* Three points rather than one, because a target can be partly covered and
     still worth ringing. The tour's own card is not a cover: it moves out of
     the way once the geometry settles, and treating it as one would make a step
     lose the target it is about to point at. */
  function onTop(el, r) {
    var pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 4, r.top + 4],
      [r.right - 4, r.bottom - 4]
    ];
    var sawOnlyOurs = true;
    for (var i = 0; i < pts.length; i++) {
      var x = Math.min(Math.max(pts[i][0], 1), global.innerWidth - 1);
      var y = Math.min(Math.max(pts[i][1], 1), global.innerHeight - 1);
      var hit = DOC.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit.closest && hit.closest('.walkthrough')) continue;
      sawOnlyOurs = false;
      if (el === hit || el.contains(hit)) return true;
    }
    return sawOnlyOurs;
  }

  /* ---------------------------------------------------------------- geometry */

  function boxOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }
  function grow(b, n) {
    return {
      left: b.left - n, top: b.top - n, right: b.right + n, bottom: b.bottom + n,
      width: b.width + n * 2, height: b.height + n * 2
    };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

  /* Card placement. Each candidate puts the card wholly on ONE side of the ring
     and only clamps the OTHER axis, so a candidate that fits cannot overlap the
     ring -- that is a property of the geometry, not something to hope for and
     test afterwards. Candidates that do not fit are dropped, never squeezed;
     the winner is the fitting side with the most room, which is also the side
     the eye goes to. Null means no side fits and the ring should not be drawn. */
  function sides(ring, cw, ch, vw, vh, gap) {
    return [
      { side: 'right', rank: 3, left: ring.right + gap, top: clamp(ring.top, EDGE, vh - EDGE - ch), room: vw - EDGE - (ring.right + gap) - cw },
      { side: 'left', rank: 2, left: ring.left - gap - cw, top: clamp(ring.top, EDGE, vh - EDGE - ch), room: (ring.left - gap - cw) - EDGE },
      { side: 'below', rank: 1, left: clamp(ring.left, EDGE, vw - EDGE - cw), top: ring.bottom + gap, room: vh - EDGE - (ring.bottom + gap) - ch },
      { side: 'above', rank: 0, left: clamp(ring.left, EDGE, vw - EDGE - cw), top: ring.top - gap - ch, room: (ring.top - gap - ch) - EDGE }
    ];
  }
  function overlaps(a, ring, cw, ch) {
    var w = Math.min(a.left + cw, ring.right) - Math.max(a.left, ring.left);
    var h = Math.min(a.top + ch, ring.bottom) - Math.max(a.top, ring.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function cardFor(ring, cw, ch, vw, vh, avoid) {
    if (!ring && avoid) ring = avoid;
    if (!ring) return { left: Math.round((vw - cw) / 2), top: Math.round((vh - ch) / 2), fits: true };

    /* First pass: a side that takes the full gap and needs no squeezing. Any
       candidate that survives is wholly on one side of the ring, so it cannot
       overlap -- that is geometry, not a hope to be tested afterwards. */
    var candidates = sides(ring, cw, ch, vw, vh, GAP);
    if (avoid) candidates = candidates.concat(sides(avoid, cw, ch, vw, vh, GAP));
    if (avoid) candidates.slice().forEach(function (c) {
      var vertical = c.side === 'right' || c.side === 'left';
      [vertical ? avoid.bottom + GAP : avoid.right + GAP,
        vertical ? avoid.top - GAP - ch : avoid.left - GAP - cw].forEach(function (edge) {
        candidates.push({ side: c.side, rank: c.rank, room: c.room,
          left: vertical ? c.left : edge, top: vertical ? edge : c.top });
      });
    });
    var strict = candidates.filter(function (c) {
      return c.room >= 0 && c.left >= EDGE - 0.5 && c.top >= EDGE - 0.5 &&
        c.left + cw <= vw - EDGE + 0.5 && c.top + ch <= vh - EDGE + 0.5 &&
        !overlaps(c, ring, cw, ch) &&
        (!avoid || !overlaps(c, avoid, cw, ch));
    });
    /* Beside before under. Sorting purely by free space put the card UNDER a
       wide paragraph and over the four lines after it, which reads as the tour
       covering the writing; the same ring had room beside it in the margin,
       where a tour's card belongs. Room decides only between equals. */
    strict.sort(function (a, b) { return (b.rank - a.rank) || (b.room - a.room); });
    if (strict.length) return { left: Math.round(strict[0].left), top: Math.round(strict[0].top), fits: true };

    var relaxed = sides(ring, cw, ch, vw, vh, 4).map(function (c) {
      return {
        side: c.side, rank: c.rank,
        left: clamp(c.left, EDGE, Math.max(EDGE, vw - EDGE - cw)),
        top: clamp(c.top, EDGE, Math.max(EDGE, vh - EDGE - ch))
      };
    });
    relaxed.forEach(function (c) { c.over = overlaps(c, ring, cw, ch) + (avoid ? overlaps(c, avoid, cw, ch) : 0); });
    relaxed.sort(function (a, b) { return (a.over - b.over) || (b.rank - a.rank); });
    var best = relaxed[0];
    if (best && best.over === 0) return { left: Math.round(best.left), top: Math.round(best.top), fits: true };

    return best
      ? { left: Math.round(best.left), top: Math.round(best.top), fits: false }
      : { left: Math.round((vw - cw) / 2), top: Math.round((vh - ch) / 2), fits: false };
  }

  /* The phone card is a sheet across the frame. Same rule: it takes the edge
     the ring is not on, and if the ring reaches both edges there is no honest
     place for it and it is not drawn. */
  function sheetFor(ring, frame, ch, vh, avoid) {
    var bottom = { top: Math.round(frame.bottom - ch) };
    var top = { top: Math.round(frame.top) };
    if ((!ring || ring.bottom <= bottom.top - GAP) && (!avoid || avoid.bottom <= bottom.top - GAP)) return bottom;
    if ((!ring || ring.top >= top.top + ch + GAP) && (!avoid || avoid.top >= top.top + ch + GAP)) return top;
    return null;
  }

  function place() {
    if (!S.active || !S.root) return;
    var step = S.step;
    var wantsTarget = !!(step && step.target != null);

    if (wantsTarget) {
      var settling = S.root.dataset.settling === '1';
      var r0 = S.target ? boxOf(S.target) : null;
      // A step's target can change while it is up (a word, then the panel it opened).
      if (settling || !r0 || !(r0.width || r0.height) || typeof step.target === 'function') {
        var again = targetOf(step);
        if (again && again !== S.target) {
          if (S.targetClass) S.targetClass.classList.remove('walkthrough-target');
          S.target = again; S.targetClass = again;
          again.classList.add('walkthrough-target');
          watchTarget(again);
        }
      }
    }
    if (!wantsTarget && S.target) clearTarget();

    var rect = S.target ? boxOf(S.target) : null;
    var live = !!(rect && (rect.width || rect.height));
    S.root.dataset.targetExists = wantsTarget ? (live ? '1' : '0') : '-';

    var vv = global.visualViewport;
    var vw = vv ? vv.width + vv.offsetLeft : global.innerWidth;
    var vh = vv ? vv.height + vv.offsetTop : global.innerHeight;
    S.card.style.maxHeight = Math.max(80, (vv ? vv.height : vh) - EDGE * 2) + 'px';
    S.card.style.overflowY = 'auto';
    var ring = live && !S.expanded ? grow(rect, PAD) : null;

    /* A target hanging off the edge of the window gets brought in once, so the
       ring is a ring and not three sides of one. Bounded: the tour must not
       chase a target that cannot be scrolled. */
    if (ring && S.pulled < 4 && (ring.top < EDGE || ring.bottom > vh - EDGE) && ring.height < vh - EDGE * 2) {
      S.pulled++;
      try { S.target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e) { /* no-op */ }
      rect = boxOf(S.target);
      ring = grow(rect, PAD);
    }

    /* A pane sits flush against the window, so its ring's 7px of padding falls
       off the edge and the writer sees three sides of a rectangle. Trim the
       ring to the window, never inside the target itself. */
    if (ring) {
      ring = {
        left: Math.max(0, Math.min(ring.left, rect.left)),
        top: Math.max(0, Math.min(ring.top, rect.top)),
        right: Math.min(vw, Math.max(ring.right, rect.right)),
        bottom: Math.min(vh, Math.max(ring.bottom, rect.bottom))
      };
      ring.width = ring.right - ring.left;
      ring.height = ring.bottom - ring.top;
    }

    var cw = S.card.offsetWidth || 330, ch = S.card.offsetHeight || 180;
    var writing = null;
    // While fonts are being tried the guide keeps off the writing; a phone's
    // sheet cannot, and only needs to keep off the word it points at.
    if (step && step.id === 'type' && !phone()) {
      var focused = Castor.editor && Castor.editor.focusedBlockId && Castor.editor.focusedBlockId();
      var block = focused && DOC.querySelector('#page-article .cw-block[data-block-id="' + focused + '"]');
      block = DOC.querySelector('#page-article') || block || paragraphTarget(false);
      writing = block ? boxOf(block) : null;
      if (writing && !(writing.width || writing.height)) writing = null;
    }
    var fits = true;

    if (phone()) {
      S.root.dataset.phone = '1';
      var frame = ((S.ctx && S.ctx.frame) || DOC.getElementById('frame') || DOC.documentElement).getBoundingClientRect();
      frame = { left: frame.left, width: frame.width, top: Math.max(frame.top, vv ? vv.offsetTop : 0), bottom: Math.min(frame.bottom, vh) };
      S.card.style.left = Math.round(frame.left) + 'px';
      S.card.style.bottom = '';
      S.card.style.width = Math.round(S.manual ? Math.min(330, frame.width - EDGE * 2) : frame.width) + 'px';
      cw = S.card.offsetWidth || cw;
      ch = S.card.offsetHeight || ch;
      var sheet = sheetFor(ring, frame, ch, vh, writing);
      if (!sheet) { fits = false; sheet = sheetFor(null, frame, ch, vh); }
      var maxTop = Math.max(0, vh - ch);
      var clamped = Math.round(Math.min(Math.max(sheet.top, 0), maxTop));
      if (clamped !== sheet.top && (ring || writing)) {
        var covered = (ring && !(clamped + ch <= ring.top || clamped >= ring.bottom)) ||
          (writing && !(clamped + ch <= writing.top || clamped >= writing.bottom));
        if (covered) fits = false;
      }
      S.card.style.top = clamped + 'px';
    } else {
      delete S.root.dataset.phone;
      S.card.style.bottom = '';
      S.card.style.width = '';
      var at = cardFor(ring, cw, ch, vw, vh, writing);
      fits = at.fits;
      S.card.style.left = at.left + 'px';
      S.card.style.top = at.top + 'px';
    }

    // Automatic placement avoids the writing. Once the writer moves the card,
    // their position wins, including over the target and across later steps.
    // Keep the spotlight independent, and only clamp the card to the viewport.
    if (S.manual) {
      var manual = { left: clamp(S.manual.left, vv ? vv.offsetLeft : 0, Math.max(vv ? vv.offsetLeft : 0, vw - cw)),
        top: clamp(S.manual.top, vv ? vv.offsetTop : 0, Math.max(vv ? vv.offsetTop : 0, vh - ch)) };
      S.card.style.left = manual.left + 'px'; S.card.style.top = manual.top + 'px';
      fits = true;
    }
    S.card.hidden = !fits;
    S.reopen.hidden = fits;
    if (!fits) ring = null;
    S.root.dataset.covered = ring && covering(ring) ? '1' : '0';
    if (ring) {
      S.root.dataset.ring = '1';
      S.spot.hidden = false;
      S.spot.style.left = Math.round(ring.left) + 'px';
      S.spot.style.top = Math.round(ring.top) + 'px';
      S.spot.style.width = Math.round(ring.width) + 'px';
      S.spot.style.height = Math.round(ring.height) + 'px';
    } else {
      S.root.dataset.ring = '0';
      S.spot.hidden = true;
    }
  }

  /* A menu or panel the writer opened on top of the ring (the / choices,
     Settings, a save receipt) hides the ring and its shade until it closes;
     the step's own target never counts as a cover. */
  var COVERS = '[popover], .cw-picker, .selection-menu, #more-sheet';
  function covering(ring) {
    if (!DOC.querySelectorAll) return false;
    var list = DOC.querySelectorAll(COVERS);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === S.root || (S.root.contains && S.root.contains(el))) continue;
      if (S.target && (el === S.target || (el.contains && el.contains(S.target)) || (S.target.contains && S.target.contains(el)))) continue;
      if (el.hasAttribute && el.hasAttribute('popover') ? !(el.matches && el.matches(':popover-open')) : el.hidden) continue;
      var r = el.getBoundingClientRect();
      if (!(r.width && r.height)) continue;
      if (r.left < ring.right && r.right > ring.left && r.top < ring.bottom && r.bottom > ring.top) return true;
    }
    return false;
  }

  /* Nothing is shown until the rectangle it is drawn from has stopped moving.
     A panel slide is ~220ms of transition that fires no resize and no scroll,
     which is exactly what the old single-frame measurement walked into. The
     loop stops as soon as the box repeats, and stops regardless after 1.8s so a
     world with a forever-running animation cannot hold it open. */
  function settle() {
    stopSettle();
    var last = '', same = 0, began = Date.now();
    function frame() {
      S.raf = 0;
      if (!S.active) return;
      place();
      var r = S.target ? boxOf(S.target) : null;
      var sig = r ? [r.left.toFixed(2), r.top.toFixed(2), r.width.toFixed(2), r.height.toFixed(2)].join() : 'none';
      if (sig === last) same++; else { same = 0; last = sig; }
      var age = Date.now() - began;
      var done = (same >= 3 && age > 320) || age > 1800;
      if (done) { S.root.removeAttribute('data-settling'); return; }
      S.raf = global.requestAnimationFrame(frame);
    }
    S.raf = global.requestAnimationFrame(frame);
  }
  function stopSettle() {
    if (S.raf) { global.cancelAnimationFrame(S.raf); S.raf = 0; }
  }
  function bump(event) {
    if (!S.active) return;
    if (event && event.target && event.target.closest && event.target.closest('.walkthrough')) return;
    settle();
  }

  /* ------------------------------------------------------------------ steps */

  function cleanup() {
    if (S.step && S.step.dismiss) {
      var el = DOC.getElementById(S.step.dismiss);
      if (el && el.matches && el.matches(':popover-open') && el.hidePopover) el.hidePopover();
    }
    clearTarget(); unreveal();
  }

  /* A command id reads its shortcut from the keyboard map, so the guide shows
     the chord that really works, in this computer's spelling (⌘⌥T on a Mac,
     Ctrl + Alt + T elsewhere). Anything else is a literal chord. */
  function chordOf(entry) {
    if (!/^[a-z]+\.[a-z.]+$/.test(entry)) return entry;
    var all = Castor.commands && Castor.commands.all ? Castor.commands.all() : [];
    var command = all.find ? all.find(function (c) { return c.id === entry; }) : null;
    return command && command.keys ? command.keys : '';
  }
  function capsOf(entry) {
    entry = chordOf(entry);
    if (Castor.keys && Castor.keys.format) return Castor.keys.format(entry);
    var mac = /Mac|iPhone|iPad/.test((global.navigator && global.navigator.platform) || '');
    return String(entry).replace(/MOD/g, mac ? '\u2318' : 'Ctrl').split(' ');
  }

  function renderKeys(keys) {
    if (!S.keys) return;
    S.keys.textContent = '';
    S.keys.hidden = !keys || !keys.length || !!(Castor.keys && !Castor.keys.shown());
    if (!keys) return;
    keys = keys.filter(function (entry) { return !!chordOf(entry); });
    if (!keys.length) { S.keys.hidden = true; return; }
    var words = !!(Castor.keys && Castor.keys.os && Castor.keys.os() !== 'mac');
    keys.forEach(function (entry, i) {
      var chord = make('span', 'walkthrough-chord');
      /* "or" rides with the chord after it, so a row that wraps (Ctrl + Shift + O
         is twice as wide as ⌘⇧O) never leaves an "or" hanging at a line's end. */
      if (i) chord.appendChild(make('span', 'walkthrough-keysep', 'or'));
      capsOf(entry).forEach(function (k, j) {
        if (j && words) chord.appendChild(make('span', 'walkthrough-plus', '+'));
        chord.appendChild(make('kbd', null, k));
      });
      S.keys.appendChild(chord);
    });
  }

  function raise() {
    if (!S.root.showPopover) return;
    if (S.root.matches(':popover-open')) S.root.hidePopover();
    S.root.showPopover();
  }
  function showStep() {
    cleanup(); stopSettle();
    var step = stepAt(S.index);
    if (step.id !== 'changes' && step.id !== 'history' && Castor.changes && Castor.changes.endDemo) Castor.changes.endDemo();
    S.step = step; S.expanded = false; S.formatting = false; S.pulled = 0; S.done = false;
    S.mark = step.id === 'structure' ? structureCount() : step.id === 'comment' ? commentCount() :
      step.id === 'unfocus' ? (Castor.panels && Castor.panels.isFocus && Castor.panels.isFocus() ? 1 : 0) : 0;
    S.title.textContent = step.title;
    S.copy.textContent = sentence(step);
    renderKeys(step.keys);
    S.count.textContent = 'Walkthrough · ' + (S.index + 1) + ' of ' + activeSteps().length;
    S.back.disabled = S.index === 0;
    paintNext();
    S.root.dataset.step = step.id;
    S.root.dataset.actionable = step.done || step.action ? '1' : '0';
    S.tryButton.hidden = !step.action; S.tryButton.textContent = step.actionLabel || '';
    if (step.prepare) step.prepare();
    S.root.dataset.ring = '0'; S.spot.hidden = true;
    S.card.hidden = false; S.reopen.hidden = true;
    remember(false); raise();
    global.requestAnimationFrame(function () {
      if (!S.active || S.step !== step) return;
      var el = targetOf(step);
      if (el) { S.target = el; S.targetClass = el; el.classList.add('walkthrough-target'); watchTarget(el); }
      settle();
    });
  }
  /* Next is always there. While a step waits for its action it reads Skip;
     once the writer has done it, the card says so and Next becomes the button
     to press. Nothing moves on by itself. */
  function paintNext() {
    var step = S.step, last = S.index === activeSteps().length - 1;
    // Leave Zen asks nothing of a writer who never turned Zen on.
    var waiting = !!step.done && !S.done && !(step.id === 'unfocus' && !S.mark);
    var label = last ? 'Finish' : step.id === 'unfocus' && phone() && Castor.panels && Castor.panels.isFocus() ? 'Leave Zen' : waiting ? 'Skip' : 'Next';
    S.next.textContent = label;
    S.next.setAttribute('data-primary', waiting ? '0' : '1');
    var chord = !phone() && Castor.keys && Castor.keys.shown && Castor.keys.shown() && label !== 'Leave Zen' ? chordOf('help.next') : '';
    if (chord) { var cap = make('kbd', 'walkthrough-next-key', capsOf('help.next').join('')); cap.setAttribute('aria-hidden', 'true'); S.next.appendChild(cap); }
    S.status.textContent = waiting ? (step.action ? 'Try it, or skip this step.' : 'Try it here, or skip this step.') : S.done ? 'Done.' : '';
    S.root.dataset.done = S.done ? '1' : '0';
  }
  function markDone() {
    if (S.done) return;
    S.done = true; paintNext(); bump();
  }
  /* Leaving the practice opens the article the writer started from. A refused
     or failed open is tried once more; if it still fails the guide closes
     anyway and the practice stays open, so nobody is trapped on the last card. */
  function returnTo(original) {
    if (!original || Castor.pieces.current() === original) return Promise.resolve(true);
    function attempt() { return Promise.resolve(Castor.pieces.open(original)).then(function (ok) { return !!ok && Castor.pieces.current() === original; }, function () { return false; }); }
    return attempt().then(function (ok) {
      if (ok) return true;
      return new Promise(function (resolve) { global.setTimeout(resolve, 600); }).then(attempt);
    });
  }
  function finish(completed) {
    if (S.leaving) return S.leaving;
    if (!S.active) { if (S.root) S.root.hidden = true; return Promise.resolve(true); }
    if (reviewing()) {
      remember(completed); cleanup(); stopSettle();
      S.active = false; S.root.hidden = true; S.manual = null;
      S.root.removeAttribute('data-settling');
      if (S.root.hidePopover && S.root.matches(':popover-open')) S.root.hidePopover();
      return Promise.resolve(true);
    }
    var original = S.originalPath;
    S.leaving = checkpoint().then(function (safe) {
      if (!safe) throw new Error('Your practice could not be kept yet. Pause typing and try Close again.');
      return returnTo(original);
    }).then(function (opened) {
      if (Castor.changes && Castor.changes.endDemo) Castor.changes.endDemo();
      cleanup(); stopSettle();
      S.active = false; S.originalPath = null; S.root.hidden = true; S.manual = null;
      remember(completed);
      S.root.removeAttribute('data-settling');
      if (S.root.hidePopover && S.root.matches(':popover-open')) S.root.hidePopover();
      if (phone() && !S.focusBefore && Castor.panels && Castor.panels.isFocus()) Castor.panels.focus(false);
      return true;
    }).catch(function (error) {
      S.title.textContent = 'Keep your place'; S.copy.textContent = error.message;
      return false;
    }).then(function (result) { S.leaving = null; return result; });
    return S.leaving;
  }
  function skipTour() { finish(false); }
  function nextStep() {
    if (!S.active || S.leaving || S.opening) return;
    if (S.step.id === 'unfocus' && phone() && Castor.panels && Castor.panels.isFocus()) {
      Castor.panels.focus(false); return;
    }
    if (S.index >= activeSteps().length - 1) return finish(true);
    S.index++; showStep();
  }
  function backStep() {
    if (!S.active || S.leaving || S.index <= 0) return;
    S.index--; showStep();
  }
  function check(event) {
    if (!S.active || S.leaving || hit(event, '.walkthrough')) return;
    var step = S.step;
    if (step.done && !S.done && step.done(event)) markDone();
    else if (step.id === 'unfocus') paintNext();
    if (event.type === 'click' || event.type === 'input' || event.type === 'keyup') { raise(); bump(); }
  }
  function onAction(event) {
    var step = S.step;
    if (!S.active || hit(event, '.walkthrough')) return;
    if (step.id === 'format' && ((event.type === 'click' && hit(event, '[data-command]')) ||
      (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && /^[bie]$/i.test(event.key)))) S.formatting = true;
    // Let the app finish the action before checking its result.
    global.setTimeout(function () { if (S.active && S.step === step) check(event); }, 0);
  }
  function onKey(event) {
    if (!S.active) return;
    if (hit(event, '.walkthrough') && event.key === 'Escape' && S.step.id !== 'unfocus') {
      event.preventDefault(); event.stopPropagation(); skipTour(); return;
    }
    onAction(event);
  }
  function start(mode) {
    if (S.opening) return S.opening;
    if (S.leaving) return S.leaving.then(start);
    if (S.active) return Promise.resolve(true);
    S.short = mode === 'quick';
    ensure();
    if (Castor.commands && Castor.commands.close) Castor.commands.close();
    cleanup();
    if (reviewing()) { begin(); return Promise.resolve(true); }
    if (!Castor.pieces || !Castor.pieces.open || !Castor.pieces.current || !Castor.pieces.current()) return Promise.resolve(false);
    var saved = read(), current = Castor.pieces.current();
    // Either practice piece can be open when an unfinished guide resumes; the
    // way back is still the article it started from.
    var practising = current === PRACTICE || current === PRACTICE_TWO;
    S.originalPath = practising && !saved.completed && typeof saved.originalPath === 'string' ? saved.originalPath : current;
    S.opening = checkpoint().then(function (safe) {
      if (!safe) throw new Error('Your article could not be kept yet. Pause typing and open the guide again.');
      return Castor.pieces.open(PRACTICE);
    }).then(function (opened) {
      if (!opened || Castor.pieces.current() !== PRACTICE) throw new Error('The practice article could not open. Your article is still available.');
      begin(); return true;
    }).catch(function (error) {
      S.originalPath = null; S.root.hidden = false; S.title.textContent = 'The guide could not start';
      S.copy.textContent = error.message; S.count.textContent = ''; S.tryButton.hidden = true;
      S.back.disabled = S.next.disabled = true; raise();
      return false;
    }).then(function (result) { S.opening = null; return result; });
    return S.opening;
  }

  function checkpoint(attempt) {
    var path = Castor.pieces.current();
    if (Castor.editor && Castor.editor.flush) Castor.editor.flush();
    var source = Castor.editor && Castor.editor.getSource ? Castor.editor.getSource() : null;
    var saving = Castor.saver && Castor.saver.flush ? Promise.resolve(Castor.saver.flush()).catch(function () {}) : Promise.resolve();
    var kept = Castor.keep && Castor.keep.now ? Promise.resolve(Castor.keep.now()) : Promise.resolve(false);
    return kept.then(function (safe) {
      if (safe) return true;
      return saving.then(function () {
        var state = Castor.saver && Castor.saver.snapshot ? Castor.saver.snapshot() : null;
        return !!(state && state.path === path && state.clean);
      });
    }).then(function (safe) {
      if (Castor.pieces.current() !== path) return false;
      if (source !== null && Castor.editor.getSource() !== source) return (attempt || 0) < 2 ? checkpoint((attempt || 0) + 1) : false;
      return safe;
    });
  }

  function begin() {
    var saved = read();
    S.focusBefore = !!(Castor.panels && Castor.panels.isFocus());
    S.index = saved.completed ? 0 : activeSteps().findIndex(function (s) { return s.id === saved.step; });
    if (S.index < 0) S.index = 0;
    S.active = true; S.root.hidden = false;
    S.next.disabled = false;
    showStep();
  }

  function registerCommand() {
    if (!Castor.commands || !Castor.commands.register) return;
    Castor.commands.register({
      id: 'help.walkthrough', title: 'Show me around', hint: 'resume the walkthrough', section: 'Help', run: start
    });
    Castor.commands.register({
      id: 'help.next', title: 'Next walkthrough step', section: 'Help', when: function () { return S.active; },
      listed: function () { return S.active; }, run: nextStep
    });
  }

  function mount(ctx) {
    if (!DOC || reviewing() && (!Castor.role.confirmed || !Castor.role.id)) return api;
    S.ctx = ctx || {};
    S.world = S.ctx.world || (Castor.app && Castor.app.world) || DOC.documentElement.dataset.world || 'dev';
    ensure(); registerCommand();
    if (!S.mounted) {
      global.addEventListener('keydown', onKey, true);
      global.addEventListener('resize', bump);
      if (global.visualViewport) {
        global.visualViewport.addEventListener('resize', bump);
        global.visualViewport.addEventListener('scroll', bump);
      }
      ['click', 'focusin', 'input', 'change', 'selectionchange', 'keyup'].forEach(function (name) { DOC.addEventListener(name, onAction, true); });
      DOC.addEventListener('toggle', function () { if (S.active) { place(); if (S.step && S.step.done && !S.done && S.step.done({ type: 'toggle' })) markDone(); } }, true);
      if (Castor.bus && Castor.bus.on) {
        ['layout', 'piece:open', 'beside:open', 'doc:change', 'comments:saved', 'canvas:changed'].forEach(function (name) {
          Castor.bus.on(name, function (data) { check({ type: name, detail: data }); });
        });
      }
      global.addEventListener('scroll', place, true);
      DOC.addEventListener('transitionend', bump, true);
      DOC.addEventListener('animationend', bump, true);
      if (global.ResizeObserver) {
        S.observer = new global.ResizeObserver(function () { if (S.active) place(); });
        try { S.observer.observe(DOC.body); } catch (e) { S.observer = null; }
      }
      /* A tablet's first real key press brings the key caps in (commands.js);
         the card grows by a row, so it is placed again. */
      if (Castor.bus && Castor.bus.on) Castor.bus.on('keys:shown', function () {
        if (S.active) { renderKeys(stepAt(S.index).keys); paintNext(); bump(); }
      });
      S.mounted = true;
    }
    if (autoStartEnabled() && !read().seen) {
      /* Never on top of the who-is-writing card: on a phone the two cover each other. */
      var go = function () { if (autoStartEnabled() && !read().seen && !S.active) start('quick'); };
      global.setTimeout(function () {
        var who = global.Castor && Castor.who;
        if (who && who.whenClosed) who.whenClosed(go); else go();
      }, 320);
    }
    return api;
  }

  var api = {
    mount: mount,
    start: start,
    stop: function () { return finish(false); },
    next: nextStep,
    back: backStep,
    keyCaps: capsOf,
    practice: [PRACTICE, PRACTICE_TWO],
    steps: function () {
      return (reviewing() ? READER_STEPS : STEPS).map(function (s) {
        return { id: s.id, title: s.title, sentence: sentence(s), ring: s.target != null };
      });
    },
    state: function () { return { active: S.active, index: S.index, step: stepAt(S.index) && stepAt(S.index).id, world: S.world, done: S.done }; }
  };

  Castor.walkthrough = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
