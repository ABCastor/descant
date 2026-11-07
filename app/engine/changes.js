(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {}, D = global.document;
  var S = { world: 'dev', on: false, root: null, view: null, request: 0, mounted: false, menu: null, full: false, historyEntry: false, historyWait: null, historyDone: null, inert: [] };
  function app() { return Castor.app || {}; }
  function data() { return app().data || {}; }
  function versions() { return data().versions || []; }
  function articleKey() { return data().path || (data().piece || {}).folder || ''; }
  function articlePath() {
    var current = Castor.pieces && Castor.pieces.current && Castor.pieces.current();
    return current || data().path || ((data().piece || {}).folder ? data().piece.folder + '/article.md' : '');
  }
  function currentId() { return data().current || (versions().length ? versions()[versions().length - 1].id : null); }
  function versionById(id) { return versions().find(function (v) { return v.id === id; }); }
  function key() { return 'castor.' + S.world + '.' + (articleKey() ? articleKey() + '.' : '') + 'lastRead'; }
  function readId() { try { return global.localStorage.getItem(key()); } catch (e) { return null; } }
  function checkpoint() { return versionById(readId()); }
  function element(tag, cls, text) {
    var n = D.createElement(tag); if (cls) n.className = cls;
    if (text != null) n.textContent = text; return n;
  }
  function button(text, fn, cls) {
    var n = element('button', cls || 'word', text); n.type = 'button'; n.addEventListener('click', fn); return n;
  }
  function parseMd(source) {
    if (Castor.md && Castor.md.parse) return Castor.md.parse(source || '');
    return { blocks: String(source || '').replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/).filter(Boolean).map(function (s, i) {
      var h = /^(#{1,6})\s+(.*)$/.exec(s);
      return { id: 'b' + i, type: h ? 'h' + h[1].length : 'p', text: h ? h[2] : s };
    }) };
  }
  function readingBlocks(source) {
    return parseMd(source).blocks.filter(function (b) { return b.type !== 'frontmatter' && b.type !== 'reference-def' && b.html !== ''; });
  }
  function authorName(v) { return v.who || v.author || 'Unknown contributor'; }
  function saveTime(v) {
    var d = new Date(v && v.when);
    return isFinite(d.getTime()) ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'date unavailable';
  }
  function liveKey(live) { return live ? [live.commit, live.article_sha256, live.published_at].join('|') : ''; }
  function websiteReason(live) {
    if (!live) return 'Not published yet';
    if (!live.commit || !live.article_sha256) return 'Published text is unavailable: no saved publication reference';
    return '';
  }
  function websiteStatus() {
    if (Castor.publishState && Castor.publishState.statusWords) return Castor.publishState.statusWords();
    var p = data().piece || {}, live = p.live;
    if (!live) return 'Not published';
    if (!live.article_sha256) return 'Website version unknown';
    return p.article_sha256_now === live.article_sha256 ? 'Matches website' : 'Unpublished changes';
  }
  function snapshot() {
    var v = versionById(currentId());
    return { path: articlePath(), id: v && v.id, markdown: v && v.markdown,
      versions: versions().map(function (v) { return Object.assign({}, v); }),
      live: (data().piece || {}).live ? Object.assign({}, data().piece.live) : null,
      status: websiteStatus(), title: (data().piece || {}).title || parseMd(v && v.markdown).frontmatter?.title || 'Article',
      personal: checkpoint() ? Object.assign({}, checkpoint()) : null,
      first: !checkpoint(), mode: 'personal', base: null, loading: false, error: '', unavailable: '', preview: null, all: false };
  }
  function ensureRoot() {
    if (S.root) return;
    S.root = element('section', 'changes-screen'); S.root.hidden = true;
    S.root.setAttribute('aria-label', 'Changes'); S.root.setAttribute('tabindex', '-1');
    (S.host || D.getElementById('app') || D.body).appendChild(S.root);
    S.root.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  }
  function placeRoot() {
    var host = S.full ? S.host || D.getElementById('app') || D.body : S.panelBody;
    if (host && S.root.parentNode !== host) host.appendChild(S.root);
    S.root.setAttribute('data-full', S.full ? '1' : '0');
  }
  function fullView() {
    if (!S.on || S.full) return;
    if (Castor.panels && Castor.panels.isFocus && Castor.panels.isFocus()) Castor.panels.focus(false);
    S.full = true; placeRoot(); render();
    S.inert = Array.from(S.root.parentNode.children).filter(function (n) { return n !== S.root && n.id !== 'topbar' && n.id !== 'castor-tabs' && !n.inert; });
    S.inert.forEach(function (n) { n.inert = true; });
    if (global.history && global.history.pushState) {
      global.history.pushState(Object.assign({}, global.history.state, { descantChanges: true }), ''); S.historyEntry = true;
    }
    var back = S.root.querySelector && S.root.querySelector('.changes-back'); if (back) back.focus();
  }
  function hideMenu() { if (S.menu) { var menu = S.menu; S.menu = null; menu.close(); menu.remove(); } }
  function close() {
    hideMenu(); var back = S.historyEntry; S.historyEntry = false; S.request++; S.on = false; S.demo = false; S.full = false;
    if (S.root) { S.root.hidden = true; placeRoot(); }
    S.inert.forEach(function (n) { n.inert = false; }); S.inert = [];
    if (Castor.panels && Castor.panels.close) Castor.panels.close('changes');
    if (back && global.history) {
      S.historyWait = new Promise(function (resolve) { S.historyDone = resolve; });
      global.history.back();
    }
    if (S.returnFocus && S.returnFocus.isConnected !== false && S.returnFocus.focus) S.returnFocus.focus();
  }
  // History traversal is asynchronous. A new destination must wait until the
  // full-view entry is consumed before it replaces the article URL.
  function leaveFullView() {
    if (S.full) close();
    return S.historyWait || Promise.resolve();
  }
  function handoffHeader(e) {
    if (!S.full) return;
    var target = e.target.closest && e.target.closest('button');
    // More only reveals the same header words; Changes keeps its own exit.
    if (!target || target.id === 'more-word' || target.getAttribute('data-panel') === 'changes') return;
    e.preventDefault(); e.stopImmediatePropagation();
    leaveFullView().then(function () { if (target.isConnected !== false) target.click(); });
  }
  function open(mode, base) {
    if (Castor.role && (Castor.role.reviewer || Castor.role.role === 'reviewer')) return;
    ensureRoot();
    if (!S.on) S.returnFocus = D.activeElement;
    S.on = true; S.demo = false; S.root.hidden = false;
    if (Castor.panels && Castor.panels.open && !S.panelOpen) Castor.panels.open('changes');
    placeRoot();
    S.view = snapshot(); S.view.mode = mode || 'personal';
    if (base) S.view.base = Object.assign({}, base);
    selectMode(S.view.mode);
    var back = S.root.querySelector && S.root.querySelector('button'); if (back) back.focus();
  }
  function show(on) { if (on) { if (!S.on) open('personal'); } else close(); return S.on; }
  function selectMode(mode) {
    hideMenu(); var v = S.view; if (!v) return;
    v.cmp = null;
    S.request++; v.mode = mode; v.preview = null; v.error = ''; v.loading = false;
    if (mode === 'personal') {
      v.base = v.personal;
      if (!v.base && !v.unavailable && !websiteReason(v.live)) { v.mode = 'website'; loadWebsite(); return; }
    } else if (mode === 'website') { loadWebsite(); return; }
    render();
  }
  function loadWebsite() {
    var v = S.view, reason = v.unavailable || websiteReason(v.live);
    if (reason) { v.base = null; v.unavailable = reason; render(); return Promise.resolve(); }
    v.base = null; v.loading = true; render();
    var ticket = ++S.request, signature = liveKey(v.live);
    var get = Castor.publishState && Castor.publishState.comparison;
    var request = get ? get(v.path, v.live) : global.fetch('/api/piece/live?path=' + encodeURIComponent(v.path), { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (payload) { if (!r.ok) { var e = Error(payload.error || 'Published text is unavailable'); e.unavailable = [404, 409, 422].indexOf(r.status) >= 0; throw e; } return payload; });
    });
    return request.then(function (payload) {
      if (ticket !== S.request || S.view !== v || !S.on || v.path !== articlePath()) return;
      if (payload.commit !== v.live.commit || typeof payload.markdown !== 'string') throw Error('The website changed while loading. Try again.');
      v.base = { id: payload.commit, sha: payload.commit, markdown: payload.markdown, when: v.live.published_at };
      v.loading = false; v.websiteLoaded = signature; render();
    }).catch(function (error) {
      if (ticket !== S.request || S.view !== v || !S.on || v.path !== articlePath()) return;
      v.loading = false;
      if (error.unavailable) { v.unavailable = 'Published text is unavailable: ' + error.message; if (v.first) v.mode = 'personal'; }
      else v.error = error.message;
      render();
    });
  }
  function comparisonMenu() {
    var v = S.view; if (!v) return;
    hideMenu(); var menu = S.menu = element('dialog', 'changes-menu');
    menu.setAttribute('aria-label', 'Compare current writing with');
    menu.appendChild(element('h2', null, 'Compare current writing with'));
    function choice(label, help, mode, reason) {
      var b = button(label, function () { selectMode(mode); }, 'changes-choice');
      b.appendChild(element('small', null, reason || help)); b.disabled = !!reason; menu.appendChild(b);
    }
    choice('My last check here', 'Where you finished reading in this browser.', 'personal', v.personal || S.demo ? '' : 'No earlier check here');
    choice('Website version', 'The exact published text' + (v.live ? ', published on ' + saveTime({ when: v.live.published_at }) : '') + '.', 'website', v.unavailable || websiteReason(v.live));
    // Keep the action label alone so assistive technology and touch users can find it directly.
    menu.appendChild(button('Earlier versions…', function () { selectMode('history'); }, 'changes-choice'));
    menu.appendChild(element('p', 'changes-help', 'Browse saved writing, then choose a version to compare.'));
    menu.appendChild(button('Cancel', hideMenu));
    menu.addEventListener('close', function () { if (S.menu === menu) { S.menu = null; menu.remove(); } });
    // A native dialog enters the browser's top layer. Position it against the
    // app's frame so the built-in Phone size also gets a phone-width sheet.
    if (S.root.getBoundingClientRect) {
      var rect = S.root.getBoundingClientRect(), desktop = rect.width >= 900;
      var width = desktop ? Math.min(512, rect.width) : rect.width;
      Object.assign(menu.style, { margin: '0', right: 'auto', width: width + 'px',
        left: (rect.left + (rect.width - width) / 2) + 'px',
        top: desktop ? (rect.top + rect.height * .15) + 'px' : 'auto',
        bottom: desktop ? 'auto' : Math.max(0, global.innerHeight - rect.bottom) + 'px',
        maxHeight: (rect.height * .85) + 'px' });
    }
    S.root.parentNode.appendChild(menu); menu.showModal();
  }
  function unchanged(root, block) {
    var p = element('div', 'changes-current-text');
    if (typeof block.html === 'string') p.innerHTML = block.html; else p.textContent = block.text;
    root.appendChild(p);
  }
  function headingAt(blocks, index) {
    for (var i = Math.min(index, blocks.length - 1); i >= 0; i--) if (/^h[1-6]$/.test(blocks[i].type)) return { text: blocks[i].text, id: blocks[i].id };
    return { text: 'Opening', id: blocks[0] && blocks[0].id };
  }
  function comparison(v) {
    var before = readingBlocks(v.base.markdown), after = readingBlocks(v.markdown), used = {};
    if (!Castor.diff || !Castor.diff.blocks) throw Error('Comparison is unavailable.');
    var changes = Castor.diff.blocks(before, after).map(function (ch) {
      var oldText = ch.ops.filter(function (op) { return op.op !== 'ins'; }).map(function (op) { return op.text; }).join('');
      var oldIndex = ch.kind === 'added' ? -1 : ch.movedFrom;
      if (oldIndex == null || !before[oldIndex] || used[oldIndex] || before[oldIndex].text !== oldText)
        oldIndex = ch.kind === 'added' ? -1 : before.findIndex(function (b, i) { return !used[i] && b.text === oldText; });
      if (oldIndex >= 0) used[oldIndex] = true;
      return { change: ch, oldIndex: oldIndex, newIndex: ch.kind === 'removed' ? -1 : after.findIndex(function (b) { return b.id === ch.blockId; }) };
    });
    var ordered = changes.filter(function (item) { return item.change.kind !== 'removed'; });
    changes.filter(function (item) { return item.change.kind === 'removed'; }).forEach(function (item) {
      // Place a removal just before the next surviving old paragraph. Absolute old
      // indices drift when paragraphs above it are added or removed.
      var following = changes.filter(function (c) { return c.newIndex >= 0 && c.oldIndex > item.oldIndex; }).sort(function (a,b) { return a.oldIndex - b.oldIndex; })[0];
      var at = following ? ordered.indexOf(following) : ordered.length; ordered.splice(at, 0, item);
    });
    return { before: before, after: after, all: ordered, items: ordered.filter(function (item) { return item.change.kind !== 'same'; }) };
  }
  function openInArticle(index, shownBlocks) {
    if (S.full) close();
    var blocks = Castor.editor && Castor.editor.getBlocks ? Castor.editor.getBlocks() : parseMd(versionById(currentId())?.markdown).blocks;
    var target = shownBlocks[index], match = target && blocks.filter(function (b) { return b.text === target.text || b.source === target.source; });
    var b = match && match.length === 1 ? match[0] : blocks[Math.min(Math.max(0, index), blocks.length - 1)];
    if (!b) return;
    if (Castor.editor && Castor.editor.focusBlock) Castor.editor.focusBlock(b.id, 0);
    var nodes = D.querySelectorAll ? D.querySelectorAll('#page-article [data-block-id]') : [];
    Array.from(nodes).some(function (n) { if (n.getAttribute('data-block-id') !== b.id) return false; Array.from(nodes).forEach(function (node) { node.removeAttribute('data-change-target'); }); n.setAttribute('data-change-target', '1'); n.scrollIntoView({ block: 'center' }); return true; });
  }
  function renderPair(root, item, cmp) {
    var ch = item.change, group = element('section', 'changes-paragraph');
    var index = item.newIndex;
    if (index < 0) {
      var survivors = cmp.all.filter(function (i) { return i.newIndex >= 0 && i.oldIndex >= 0; });
      var next = survivors.filter(function (i) { return i.oldIndex > item.oldIndex; }).sort(function (a,b) { return a.oldIndex - b.oldIndex; })[0];
      var previous = survivors.filter(function (i) { return i.oldIndex < item.oldIndex; }).sort(function (a,b) { return b.oldIndex - a.oldIndex; })[0];
      index = next ? next.newIndex : previous ? previous.newIndex : 0;
    }
    var heading = ch.kind === 'removed' ? headingAt(cmp.before, item.oldIndex) : headingAt(cmp.after, index);
    if (cmp.heading !== heading.text) group.appendChild(element('h3', 'changes-section-heading', heading.text));
    cmp.heading = heading.text;
    if (ch.kind === 'removed' || ch.kind === 'added') group.appendChild(element('p', 'changes-help', ch.kind === 'removed' ? 'Paragraph removed' : 'New paragraph'));
    if (ch.kind === 'moved' && item.oldIndex >= 0) {
      var old = cmp.before[item.oldIndex];
      var unique = cmp.after[item.newIndex].text === old.text && cmp.before.filter(function (b) { return b.text === old.text; }).length === 1 && cmp.after.filter(function (b) { return b.text === old.text; }).length === 1;
      if (unique) {
        var origin = headingAt(cmp.before, item.oldIndex), originAt = cmp.after.findIndex(function (b) { return /^h/.test(b.type) && b.text === origin.text; });
        group.appendChild(button('Moved from ' + origin.text, function () { openInArticle(originAt < 0 ? index : originAt, cmp.after); }, 'word changes-move'));
      }
    }
    var pair = element('div', 'changes-pair');
    ['Before', 'Now'].forEach(function (label) {
      var side = element('div', 'changes-side'); side.appendChild(element('h4', null, label));
      var prose = element('p', 'changes-words'), omitted = label === 'Before' ? 'ins' : 'del';
      ch.ops.forEach(function (op) {
        if (op.op === omitted) return;
        prose.appendChild(element(label === 'Before' && op.op === 'del' ? 'del' : label === 'Now' && op.op === 'ins' ? 'mark' : 'span', null, op.text));
      });
      if (!prose.textContent) prose.textContent = label === 'Before' ? 'No earlier paragraph' : 'Paragraph removed';
      side.appendChild(prose); pair.appendChild(side);
    });
    group.appendChild(pair);
    if (!(S.view && S.view.synthetic)) group.appendChild(button('Open in article', function () { openInArticle(index, cmp.after); }));
    root.appendChild(group);
  }
  function renderHistory(root, v) {
    root.appendChild(element('h2', null, 'Earlier versions'));
    root.appendChild(button('Back to changes', function () { v.preview = null; selectMode(v.personal ? 'personal' : 'website'); }));
    if (v.preview) {
      root.appendChild(element('h3', null, 'Saved on ' + saveTime(v.preview)));
      root.appendChild(element('p', 'changes-help', 'Saved by ' + authorName(v.preview)));
      root.appendChild(button('Compare with current writing', function () { var base = v.preview; v.preview = null; v.base = base; v.cmp = null; v.mode = 'earlier'; render(); }));
      root.appendChild(button('Back to earlier versions', function () { v.preview = null; render(); }));
      readingBlocks(v.preview.markdown).forEach(function (b) { unchanged(root, b); }); return;
    }
    root.appendChild(element('p', 'changes-help', 'Available saved writing, newest first. Show all saves reveals individual saves within each day.'));
    root.appendChild(button(v.all ? 'Hide individual saves' : 'Show all saves', function () { v.all = !v.all; render(); }));
    var days = {};
    v.versions.slice().reverse().forEach(function (save) {
      var date = new Date(save.when), day = isFinite(date.getTime()) ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
      (days[day] || (days[day] = [])).push(save);
    });
    Object.keys(days).forEach(function (day) {
      root.appendChild(element('h3', null, day)); var saves = days[day];
      var names = Array.from(new Set(saves.map(authorName))); root.appendChild(element('p', 'changes-help', names.join(', ')));
      saves.filter(function (save, i) { return v.all || i === 0 || v.live && save.sha === v.live.commit; }).forEach(function (save) {
        var published = v.live && (save.sha === v.live.commit || save.id === v.live.commit);
        var row = button(saveTime(save) + ' · ' + authorName(save) + (published ? ' · Published' : ''), function () { v.preview = save; render(); }, 'word changes-save');
        row.setAttribute('data-version', save.id); root.appendChild(row);
      });
      if (!v.all && saves.length > 1) root.appendChild(element('p', 'changes-help', saves.length + ' saves on this day'));
    });
    if (!v.versions.length) root.appendChild(element('p', null, 'No earlier versions are available.'));
    if (v.live && !v.versions.some(function (save) { return save.sha === v.live.commit; })) root.appendChild(element('p', 'changes-help', 'Published on ' + saveTime({when: v.live.published_at}) + '. This publication is outside the available saved history.'));
  }
  function render() {
    if (!S.root || !S.view) return;
    var v = S.view; S.root.textContent = '';
    var header = element('header', 'changes-header');
    if (S.full) {
      var back = button('Back to article', close, 'changes-back');
      var arrow = element('span', 'changes-back-arrow'); arrow.setAttribute('aria-hidden', 'true'); back.appendChild(arrow); header.appendChild(back);
    } else header.appendChild(button('Open full view', fullView, 'word changes-expand'));
    if (S.full) header.appendChild(element('h1', null, v.title + ' · Changes')); S.root.appendChild(header);
    var main = element('div', 'changes-content'); S.root.appendChild(main);
    var status = element('p', 'changes-website-status', v.status);
    status.setAttribute('role', 'status'); main.appendChild(status);
    if (S.full && v.mode === 'personal' && v.base) main.appendChild(element('p', 'changes-help', 'Your last check here compared with the current saved writing.'));
    if (!S.demo && (v.status === 'Unpublished changes' || v.status === 'Not published')) {
      main.className += ' changes-has-publish';
      var publisher = Castor.publishState;
      var blocked = publisher && publisher.reason ? publisher.reason() : 'Publishing is not available in this view.';
      var publish = button('Publish', function () { if (publisher && publisher.open) publisher.open(); }, 'changes-publish');
      publish.disabled = !!blocked; main.appendChild(publish);
      main.appendChild(element('p', 'changes-help', blocked || 'Review the website comparison, then publish this saved version.'));
    }
    if (S.demo) main.appendChild(element('p', 'changes-help', S.view && !S.view.synthetic
      ? 'Example: one paragraph of this article, shown as if a word had been added and another taken out. Your article and your reading place stay as they are.'
      : 'Example: a word added and another taken out. Your article and your reading place stay as they are.'));
    if (v.mode === 'history') { renderHistory(main, v); return; }
    var control = element('div', 'changes-control'); control.appendChild(element('span', null, 'Compare current writing with'));
    var choose = button(v.mode === 'website' ? 'Website version' : v.mode === 'earlier' ? 'Earlier version' : 'My last check here', comparisonMenu, 'word changes-compare');
    choose.setAttribute('aria-label', 'Compare current writing with ' + choose.textContent); choose.setAttribute('aria-haspopup', 'dialog'); control.appendChild(choose);
    // The wording leads; comparison controls are secondary to the change count.
    main.appendChild(control);
    if (v.live && v.mode === 'website') main.appendChild(element('p', 'changes-help', 'Published on ' + saveTime({when:v.live.published_at})));
    if (!S.demo && currentId() !== v.id) {
      main.appendChild(element('p', 'changes-help', 'New edits are available'));
      main.appendChild(button('Load new edits', function () { var mode = v.mode, base = v.base; open(mode, base); }));
    }
    if (!S.demo && liveKey((data().piece || {}).live) !== liveKey(v.live)) {
      main.appendChild(element('p', 'changes-help', 'The website was updated'));
      main.appendChild(button('Reload comparison', function () { open(v.mode, v.base); }));
    }
    if (v.loading) { var loading = element('p', null, 'Finding changes…'); loading.setAttribute('role', 'status'); main.appendChild(loading); completion(main, v, true); return; }
    if (v.error) {
      var error = element('p', null, 'Couldn’t load changes'); error.setAttribute('role', 'alert'); main.appendChild(error);
      main.appendChild(element('p', 'changes-help', v.error)); main.appendChild(button('Try again', function () { v.error = ''; selectMode(v.mode); })); return;
    }
    if (v.unavailable) main.appendChild(element('p', 'changes-help', v.unavailable));
    if (typeof v.markdown !== 'string' || !v.id) { main.appendChild(element('p', null, 'Couldn’t load changes')); main.appendChild(button('Try again', function () { open(v.mode); })); return; }
    if (!v.base) {
      if (!v.first && v.mode === 'website') return;
      main.appendChild(element('h2', null, 'First reading'));
      main.appendChild(element('p', null, 'There is no earlier reading to compare. Read the article, then choose Done reading to set your starting point.'));
      readingBlocks(v.markdown).forEach(function (b) { unchanged(main, b); });
    } else {
      if (v.first && v.mode === 'website') main.appendChild(element('p', 'changes-help', 'No earlier check is recorded in this browser. Showing differences from the website.'));
      try {
        var cmp = v.cmp || (v.cmp = comparison(v)), count = cmp.items.length, noun = count === 1 ? ' paragraph' : ' paragraphs';
        var sentence = v.mode === 'website' ? count + noun + (count === 1 ? ' differs' : ' differ') + ' from the website version published on ' + saveTime(v.base)
          : v.mode === 'earlier' ? count + noun + (count === 1 ? ' differs' : ' differ') + ' from the version saved on ' + saveTime(v.base)
          : count + noun + ' changed since your last check here on ' + saveTime(v.base);
        var summary = element('p', 'changes-summary', sentence);
        main.insertBefore(summary, control);
        // Plain notes under the list, no disclosure triangle.
        var about = element('div', 'changes-about');
        about.appendChild(element('p', 'changes-help', 'Body text only. Formatting, link addresses and publication fields are not compared.'));

        if (!count) main.appendChild(element('p', null, v.mode === 'website' ? 'The saved text matches the website' : v.mode === 'personal' ? 'No text changes since your last check here' : 'No text changes in this comparison'));
        else {
          var baseAt = v.versions.findIndex(function (save) { return save.id === v.base.id || save.sha === v.base.sha; });
          var saves = baseAt >= 0 ? v.versions.slice(baseAt + 1) : [];
          var names = Array.from(new Set(saves.map(authorName)));
          if (names.length) about.appendChild(element('p', 'changes-help', 'Saves in this comparison by ' + names.join(', ') + '. Latest displayed save: ' + saveTime(v.versions[v.versions.length - 1]) + '.'));
          main.appendChild(element('p', 'changes-legend', 'Crossed out: removed. Highlighted: added.'));
          cmp.heading = null;
          cmp.items.forEach(function (item) { renderPair(main, item, cmp); });
        }
      } catch (e) { v.error = e.message; render(); return; }
    }
    if (about) main.appendChild(about);
    completion(main, v, false);
    if (!S.full) main.appendChild(button('Back to article', close, 'word changes-panel-back'));
  }
  function completion(root, v, disabled) {
    if (!(v.mode === 'personal' || v.first && v.mode === 'website')) return;
    var done = button('Done reading', markRead, 'word changes-done'); done.disabled = disabled || !v.id; root.appendChild(done);
    root.appendChild(element('p', 'changes-help', 'Remembers your place in this browser and returns to the article. It does not approve edits or publish anything.'));
    if (v.first) root.appendChild(element('p', 'changes-help', 'Next time, Changes will show edits after this saved article.'));
  }
  function markRead() {
    var v = S.view;
    if (!S.on || !v || v.loading || v.error || !v.id || v.mode !== 'personal' && !(v.first && v.mode === 'website')) return;
    if (!S.demo && v.path === articlePath()) { try { global.localStorage.setItem(key(), v.id); } catch (e) { v.error = 'Your browser could not remember your place. Allow browser storage, then try again.'; render(); return; } }
    close(); paintNotice();
  }
  function renderRail() {
    var rail = D.getElementById('saves-rail'); if (!rail) return;
    rail.textContent = ''; rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Saved versions');
    versions().slice().reverse().forEach(function (v) {
      var tick = button('', function () { setBase(v.id); }, 'tick');
      tick.setAttribute('data-version', v.id);
      if (v.id === currentId()) tick.setAttribute('data-current', '1');
      tick.setAttribute('data-by', (v.authorRole || v.by) === 'agent' || v.author === 'the agent' ? 'agent' : 'human');
      tick.title = authorName(v) + ' · ' + saveTime(v);
      tick.setAttribute('aria-label', 'Compare current writing with the version saved on ' + saveTime(v) + ' by ' + authorName(v));
      rail.appendChild(tick);
    });
  }
  function refresh() {
    paintNotice(); renderRail();
    if (S.on) { if (!S.demo && S.view.path !== articlePath()) open('personal'); else render(); }
    return current();
  }
  function setBase(id) { var base = versionById(id); if (base) open('earlier', base); }
  function setSince(k, id) { if (k === 'lastRead' || k === 'read') open('personal'); else if (k === 'website') open('website'); else setBase(id || k); }
  function since(k) {
    if (k === 'first') return setBase(versions()[0] && versions()[0].id);
    if (k === 'yesterday') { var today = new Date(); today.setHours(0,0,0,0); var earlier = versions().filter(function (v) { return new Date(v.when) < today; }); return setBase(earlier.length && earlier[earlier.length - 1].id); }
    setSince(k, k);
  }
  function missed() {
    var base = checkpoint(), vs = versions(), from = base ? vs.indexOf(base) : -1, end = vs.findIndex(function (v) { return v.id === currentId(); });
    if (from < 0 || end <= from) return null;
    var saves = vs.slice(from + 1, end + 1), names = Array.from(new Set(saves.map(authorName)));
    return { count: saves.length, people: names, line: names.join(' and ') + ' saved changes', baseId: base.id };
  }
  function paintNotice() {
    if (!S.noticeEl) return; var away = missed(), frame = D.getElementById('app');
    S.noticeEl.hidden = !away; if (frame) frame.setAttribute('data-changes-notice', away ? '1' : '0');
    S.noticeText.textContent = away ? away.line : '';
  }
  function mountNotice(root) {
    if (!root) return; S.noticeEl = root; root.textContent = '';
    S.noticeText = element('span', 'changes-notice-text'); root.appendChild(S.noticeText);
    root.appendChild(button('Read changes', function () { open('personal'); })); paintNotice();
  }
  function current() {
    return { on: S.on, unread: missed()?.count || 0, base: S.view?.base?.id || null, since: S.view?.mode || null, changes: S.view?.cmp && !S.view.error ? S.view.cmp.items.map(function (i) { return i.change; }) : [] };
  }
  function renderPanel(body) {
    S.panelBody = body; ensureRoot(); placeRoot();
  }
  function demonstrate() {
    ensureRoot(); if (!S.on) S.returnFocus = D.activeElement;
    S.on = true; S.demo = true; S.root.hidden = false; S.request++;
    if (Castor.panels && Castor.panels.open && !S.panelOpen) Castor.panels.open('changes'); placeRoot();
    var example = exampleEdit(Castor.editor && Castor.editor.getSource ? Castor.editor.getSource() : ((versionById(currentId()) || {}).markdown || ''));
    var old = { id: 'example-before', when: '2026-10-13T16:20:00+02:00', markdown: example.before, who: 'Example writer' };
    var now = { id: 'example-now', when: '2026-10-14T17:00:00+02:00', markdown: example.now, who: 'Example writer' };
    S.view = { path: articlePath(), id: now.id, markdown: now.markdown, title: 'Example', status: 'Not published', mode: 'personal', base: old, personal: old, first: false, live: null, versions: [old,now], synthetic: example.synthetic }; render();
  }
  /* The example is a real paragraph of the open article, shown as if one word
     had been added and one taken out, so Open in article lands on it. An
     article with no plain paragraph gets a made-up one and no Open button. */
  function exampleEdit(source) {
    var target = readingBlocks(source).filter(function (b) {
      var text = String(b.source || '');
      return b.type === 'p' && text.split(/\s+/).length >= 6 && !/[\[\]*_`<>%|\\]/.test(text) && source.split(text).length === 2;
    })[0];
    if (!target) return { synthetic: true, before: '# A small example\n\nWe do not prune the garden.', now: '# A small example\n\nWe do prune the garden carefully.' };
    var words = target.source.split(' '), earlier = words.slice();
    earlier.splice(2, 1); earlier.splice(1, 0, 'quietly');
    return { synthetic: false, now: source, before: source.replace(target.source, earlier.join(' ')) };
  }
  function mount(ctx) {
    ctx = ctx || {}; S.host = ctx.app || D.getElementById('app'); S.world = ctx.world || app().world || 'dev';
    mountNotice(D.getElementById('changes-notice')); renderRail();
    if (!S.mounted) {
      S.mounted = true;
      var topbar = D.getElementById('topbar');
      if (topbar) topbar.addEventListener('click', handoffHeader, true);
      if (global.addEventListener) global.addEventListener('popstate', function () {
        var done = S.historyDone; S.historyDone = null; S.historyWait = null;
        if (done) done();
        if (S.on && S.historyEntry) { S.historyEntry = false; close(); }
      });
      if (Castor.panels && Castor.panels.register) Castor.panels.register('changes', { title: 'Changes', ready: true, mount: renderPanel });
      if (Castor.panels && Castor.panels.onLayout) Castor.panels.onLayout(function (info) {
        var on = !!(info && info.open && info.open.indexOf('changes') >= 0);
        var wasOpen = S.panelOpen; S.panelOpen = on;
        if (on && !S.on) show(true); else if (wasOpen && !on && S.on) close();
      });
      if (Castor.bus && Castor.bus.on) ['doc:change', 'live:reload', 'save:state'].forEach(function (name) { Castor.bus.on(name, refresh); });
      if (Castor.commands && Castor.commands.register) Castor.commands.register({ id: 'changes.read', title: 'Done reading', section: 'Writing', run: markRead });
    }
    if (S.on) refresh();
    else if (Castor.panels && Castor.panels.isOpen && Castor.panels.isOpen('changes')) show(true);
    return Castor.changes;
  }
  Castor.changes = {
    mount: mount, show: show, open: open, setBase: setBase, since: since, setSince: setSince,
    leaveFullView: leaveFullView, refresh: refresh, current: current, markRead: markRead, missed: missed, mountNotice: mountNotice,
    demonstrate: demonstrate, endDemo: function () { if (S.demo) close(); }, _state: S
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.changes;
})(typeof window !== 'undefined' ? window : this);
