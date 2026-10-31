/* ============================================================================
   Castor engine: search.js
   Search everything: the lens in the bar (engine/topbar.html), the logbook's.

   The flap under the lens is a native popover, so a click outside it or Escape
   closes it with no script. This adds the results and the keys: Cmd-K opens it
   when nothing is being typed, Cmd-K or Ctrl-K opens it from anywhere
   (commands.js routes the chord here), Escape closes it and gives the focus
   back. One list, grouped by kind: the articles whose title matches, the lines
   of their text, their review comments (all from GET /api/search, every listed
   article), and the app's own commands (commands.js). Enter or a click on an
   article's hit opens that article and selects the words found; on a comment
   it opens Comments at the passage the thread is about; on a command it runs it.

   Where the server cannot search (a page opened from disk, a reviewer's page,
   no network) the text hits come from the open article alone, so the box still
   finds what is on the page.
   ========================================================================== */

(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;

  var GROUPS = [['title', 'Articles'], ['text', 'Text'], ['comment', 'Comments'], ['command', 'Commands']];
  var SHOWN = { title: 10, text: 12, comment: 8, command: 8 };
  var WAIT = 180;                        // ms of quiet before a query goes to the server

  var panel = null, input = null, results = null, lens = null, empty = null;
  var timer = 0, request = null, generation = 0;
  var rows = [], active = -1, query = '';
  var returnTo = null;                   // the writer's caret, when the keys opened the box from the text

  function wired() { return !!(panel && input && results && panel.showPopover); }
  function isOpen() { try { return !!panel && panel.matches(':popover-open'); } catch (e) { return false; } }

  /* Every way in (the lens, "/", Cmd-K) comes here, inside the event that asked,
     so the field has the focus before the next key arrives: nothing waits for the
     popover's own toggle event, and a key typed while the flap is still unfolding
     lands in the field. A query kept from last time is selected, so the first key
     replaces it. */
  function open() {
    if (!wired()) return false;
    var wasOpen = isOpen();
    if (!wasOpen) {
      returnTo = (Castor.editor && Castor.editor.getCaret) ? Castor.editor.getCaret() : null;
      try { panel.showPopover(); } catch (e) { return false; }
    }
    input.focus();
    input.select();
    var q = clean(input.value);
    if (!wasOpen && q) run(q);
    return true;
  }

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

  function close(giveBack) {
    if (wired() && isOpen()) { try { panel.hidePopover(); } catch (e) { /* already closed */ } }
    if (giveBack && !(Castor.popovers && Castor.popovers.returnFocus(lens, true))) {
      if (returnTo && Castor.editor && Castor.editor.restoreCaret) Castor.editor.restoreCaret(returnTo, 'navigate');
      else if (lens) lens.focus();
    }
    returnTo = null;
  }

  function stop() {
    clearTimeout(timer);
    if (request) { try { request.abort(); } catch (e) { /* gone */ } }
    request = null;
    generation += 1;
  }

  function clear() {
    stop();
    rows = [];
    active = -1;
    results.textContent = '';
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  /* ---- what is searched ------------------------------------------------------ */

  function currentPath() { return (Castor.pieces && Castor.pieces.current) ? Castor.pieces.current() : null; }
  function currentTitle() {
    var d = Castor.app && Castor.app.data;
    return (d && d.piece && d.piece.title) || 'This article';
  }

  function lowerIndex(text, needle, from) { return String(text).toLowerCase().indexOf(needle, from || 0); }

  function lineCount(text) {
    var n = 0, s = String(text || '');
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
    return n;
  }

  /* The editor's blocks with the line each starts on in the file, as the editor
     writes the file back (editor.js getSource). */
  function blockLines() {
    var ed = Castor.editor;
    if (!ed || !ed.getBlocks) return [];
    var blocks = ed.getBlocks(), out = [], nl = 0;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var gap = (typeof b.sep === 'string' && b.type === b.sepType) ? b.sep : (i === 0 ? '' : '\n\n');
      nl += lineCount(gap);
      out.push({ id: b.id, type: b.type, source: String(b.source || ''), line: nl + 1 });
      nl += lineCount(b.source);
    }
    return out;
  }

  /* The words around a match in a block's rendered text (no Markdown), and where the
     match sits in them: the same shape the server gives. */
  function snippet(text, at, length) {
    var start = Math.max(0, at - 40), end = Math.min(text.length, at + length + 80);
    if (start > 0 && text.charAt(start) === ' ') start += 1;
    var lead = start > 0 ? '…' : '';
    var from = lead.length + at - start;
    return { snippet: lead + text.slice(start, end) + (end < text.length ? '…' : ''), match: [from, from + length] };
  }

  /* The open article's own lines, for when the server cannot answer. */
  function localHits(q) {
    var needle = q.toLowerCase(), path = currentPath(), title = currentTitle(), out = [];
    var at = title.toLowerCase().indexOf(needle);
    if (at >= 0) out.push({ path: path, title: title, kind: 'title', snippet: title, match: [at, at + needle.length], line: 1 });
    var lines = {};
    blockLines().forEach(function (b) { lines[b.id] = b.line; });
    var doc = (Castor.editor && Castor.editor.getDoc && Castor.editor.getDoc()) || {};
    (doc.blocks || []).forEach(function (b) {
      if (b.type === 'frontmatter' || out.length >= 50) return;
      var text = String(b.text || '').replace(/\s+/g, ' ').trim();
      var found = lowerIndex(text, needle);
      if (found < 0) return;
      var cut = snippet(text, found, needle.length);
      out.push({ path: path, title: title, kind: 'text', snippet: cut.snippet, match: cut.match, line: lines[b.id] || 1 });
    });
    return { hits: out, more: false };
  }

  function commandRows(q) {
    if (!Castor.commands || !Castor.commands.matching) return [];
    return Castor.commands.matching(q, SHOWN.command + 1)
      .filter(function (c) { return c.id !== 'go.search'; })
      .map(function (c) { return { kind: 'command', cmd: c }; });
  }

  function serverHits(q) {
    var proto = (global.location && global.location.protocol) || '';
    if ((proto !== 'http:' && proto !== 'https:') || !global.fetch) return Promise.resolve(localHits(q));
    var ctl = global.AbortController ? new global.AbortController() : null;
    request = ctl;
    return global.fetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('search answered ' + r.status);
        return r.json();
      })
      .then(function (body) {
        if (!body || !Array.isArray(body.hits)) throw new Error('search answered no hits');
        return { hits: body.hits, more: !!body.more };
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        return localHits(q);
      });
  }

  function run(q) {
    stop();
    query = q;
    var mine = generation;
    var commands = commandRows(q);
    if (q.length < 2) { render(q, [], false, commands); return; }
    timer = setTimeout(function () {
      serverHits(q).then(function (found) {
        if (mine === generation) render(q, found.hits, found.more, commands);
      }, function () { /* a newer query replaced this one */ });
    }, WAIT);
  }

  /* ---- the list ---------------------------------------------------------------- */

  function el(tag, cls, text) {
    var n = DOC.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function marked(host, text, q, match) {
    var at = -1, to = -1;
    if (match && match.length === 2 && match[0] >= 0 && match[1] > match[0] && match[1] <= text.length) {
      at = match[0]; to = match[1];
    } else if (q) {
      at = lowerIndex(text, q.toLowerCase());
      to = at + q.length;
    }
    if (at < 0) { host.textContent = text; return host; }
    host.appendChild(DOC.createTextNode(text.slice(0, at)));
    host.appendChild(el('b', '', text.slice(at, to)));
    host.appendChild(DOC.createTextNode(text.slice(to)));
    return host;
  }

  function describe(row, q) {
    var here = row.hit && row.hit.path === currentPath();
    if (row.kind === 'command') {
      var c = row.cmd;
      return { title: c.title, detail: c.available ? [c.hint, c.keys].filter(Boolean).join(' · ') : 'not in this page' };
    }
    var h = row.hit;
    if (row.kind === 'title') return { title: h.title, detail: here ? 'The article you are in' : 'Open the article', mark: true };
    if (row.kind === 'comment') {
      return { title: h.snippet, mark: true,
        detail: (h.author ? h.author + ', on ' : 'On ') + (here ? 'this article' : h.title) };
    }
    return { title: h.snippet, mark: true, detail: here ? 'This article' : h.title };
  }

  function render(q, hits, more, commands) {
    results.textContent = '';
    rows = [];
    active = -1;
    var byKind = { title: [], text: [], comment: [], command: commands.slice(0, SHOWN.command) };
    var capped = more || commands.length > SHOWN.command;
    hits.forEach(function (h) {
      var list = byKind[h.kind];
      if (!list) return;
      if (list.length >= SHOWN[h.kind]) { capped = true; return; }
      list.push({ kind: h.kind, hit: h });
    });
    GROUPS.forEach(function (g) {
      var list = byKind[g[0]];
      if (!list.length) return;
      var section = el('section', 'search-group');
      section.setAttribute('role', 'group');
      var head = el('h2', '', g[1]);
      head.id = 'find-group-' + g[0];
      section.setAttribute('aria-labelledby', head.id);
      section.appendChild(head);
      var ul = el('ul', 'search-results');
      ul.setAttribute('role', 'presentation');
      list.forEach(function (row) {
        var index = rows.length;
        var said = describe(row, q);
        var li = el('li');
        li.setAttribute('role', 'presentation');
        var b = el('button', 'search-result');
        b.type = 'button';
        b.id = 'find-opt-' + index;
        b.tabIndex = -1;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', 'false');
        if (row.kind === 'command' && !row.cmd.available) b.setAttribute('aria-disabled', 'true');
        var title = el('strong', 'search-result-title');
        if (said.mark) marked(title, said.title, q, row.hit && row.hit.match); else title.textContent = said.title;
        b.appendChild(title);
        if (said.detail) b.appendChild(el('small', 'search-result-detail', said.detail));
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // the field keeps the focus
        b.addEventListener('mousemove', function () { if (active !== index) select(index); });
        b.addEventListener('click', function () { choose(index); });
        li.appendChild(b);
        ul.appendChild(li);
        rows.push({ kind: row.kind, hit: row.hit, cmd: row.cmd, el: b });
      });
      section.appendChild(ul);
      results.appendChild(section);
    });
    if (!rows.length) {
      var none = el('p', 'search-empty');
      none.appendChild(el('b', '', 'No results'));
      none.appendChild(DOC.createTextNode(q.length < 2 ? 'Type one more letter to search the articles.' : 'Try another word or a shorter search.'));
      results.appendChild(none);
    } else if (capped) {
      results.appendChild(el('p', 'search-more', 'More matches than these: a longer search narrows them.'));
    }
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (rows.length) select(0);
  }

  function select(index) {
    if (!rows.length) return;
    if (index < 0) index = rows.length - 1;
    if (index >= rows.length) index = 0;
    if (active >= 0 && rows[active]) rows[active].el.setAttribute('aria-selected', 'false');
    active = index;
    var row = rows[active];
    row.el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.el.id);
    if (row.el.scrollIntoView) row.el.scrollIntoView({ block: 'nearest' });
  }

  /* ---- landing where the hit is ------------------------------------------------ */

  /* Selects the words found in the open article: in the block holding the line the
     hit is on, or failing that the first block that holds them. */
  function selectWords(line, q) {
    var ed = Castor.editor;
    if (!ed || !ed.restoreCaret) return false;
    var needle = q.toLowerCase(), first = null, pick = null;
    var blocks = blockLines();
    for (var i = 0; i < blocks.length && !pick; i++) {
      var b = blocks[i];
      if (b.type === 'frontmatter') continue;
      var at = lowerIndex(b.source, needle);
      if (at < 0) continue;
      var span = { blockId: b.id, start: at, end: at + needle.length };
      if (!first) first = span;
      var last = b.line + lineCount(b.source);
      if (line >= b.line && line <= last) {
        var lines = b.source.split('\n'), from = 0;
        for (var k = 0; k < line - b.line; k++) from += lines[k].length + 1;
        var on = lowerIndex(b.source, needle, from);
        if (on >= 0) span = { blockId: b.id, start: on, end: on + needle.length };
        pick = span;
      }
    }
    pick = pick || first;
    if (!pick) return false;
    if (ed.scrollToBlock) ed.scrollToBlock(pick.blockId);
    return !!ed.restoreCaret(pick, 'navigate');
  }

  function land(row, q) {
    var hit = row.hit;
    if (row.kind === 'title') {
      var scroller = DOC.querySelector('#page .page-scroll');
      if (scroller && scroller.scrollTo) scroller.scrollTo({ top: 0 });
      return;
    }
    if (row.kind === 'comment') {
      if (Castor.panels && Castor.panels.open && !(Castor.panels.isOpen && Castor.panels.isOpen('comments'))) {
        try { Castor.panels.open('comments'); } catch (e) { /* no comments panel on this page */ }
      }
      if (hit.quote && Castor.editor && Castor.editor.flashAnchor) Castor.editor.flashAnchor({ quote: hit.quote, blockText: '' });
      return;
    }
    if (!selectWords(hit.line, q) && Castor.editor && Castor.editor.flashAnchor) {
      Castor.editor.flashAnchor({ quote: q, blockText: '' });
    }
  }

  function choose(index) {
    var row = rows[index];
    if (!row) return;
    if (row.kind === 'command') {
      if (!row.cmd.available) return;
      close(false);
      if (Castor.commands && Castor.commands.run) Castor.commands.run(row.cmd.id);
      return;
    }
    var q = query;
    close(false);
    var path = row.hit.path;
    var there = !path || path === currentPath() || !(Castor.pieces && Castor.pieces.open)
      ? Promise.resolve(true) : Promise.resolve(Castor.pieces.open(path));
    there.then(function (ok) { if (ok !== false) land(row, q); });
  }

  /* ---- the keys ------------------------------------------------------------------ */

  function onFieldKey(e) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault();
      select(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      clear();
      close(true);
    }
  }

  function wire() {
    panel = DOC.getElementById('find');
    input = DOC.getElementById('global-search-input');
    results = DOC.getElementById('global-search-results');
    lens = DOC.querySelector('.find-lens');
    if (!wired()) return;

    /* The field names the chord this keyboard has: ⌘K on a Mac, iPhone or iPad. */
    var hint = panel.querySelector('.search-key');
    var mac = Castor.keys && Castor.keys.os ? Castor.keys.os() === 'mac'
      : /mac|iphone|ipad/i.test((global.navigator && (global.navigator.platform || '')) || '');
    if (hint && hint.dataset && hint.dataset.mac && mac) hint.textContent = hint.dataset.mac;

    /* The toggle event arrives a task after the flap opened, when keys may already
       be in the field: it never selects them. It gives the field the focus only if
       the flap opened some other way and nothing in it has the focus yet. */
    if (lens) lens.setAttribute('aria-expanded', String(isOpen()));
    panel.addEventListener('toggle', function (e) {
      if (lens) lens.setAttribute('aria-expanded', String(e.newState === 'open'));
      if (e.newState === 'open') {
        if (!panel.contains(DOC.activeElement)) input.focus();
      } else if (!isOpen()) {
        clear();
        if (Castor.popovers) Castor.popovers.returnFocus(lens, true);
      }
    });
    /* The lens opens the flap through the same door as the keys. */
    if (lens) {
      lens.addEventListener('click', function (e) {
        e.preventDefault();
        if (isOpen()) close(false); else open();
      });
    }
    input.addEventListener('input', function () {
      var q = clean(input.value);
      if (!q) { clear(); return; }
      run(q);
    });
    input.addEventListener('keydown', onFieldKey);
    var form = panel.querySelector('form');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });
    /* Focus moving on past the flap closes it, as a click there would. Not the
       lens: its own click toggles the flap. */
    panel.addEventListener('focusout', function (e) {
      var next = e.relatedTarget;
      if (next && next !== lens && !panel.contains(next) && isOpen()) close(false);
    });
  }

  Castor.search = {
    open: open,
    close: function () { close(false); },
    isOpen: isOpen,
    available: wired
  };

  if (DOC && DOC.readyState === 'loading') DOC.addEventListener('DOMContentLoaded', wire);
  else if (DOC) wire();
})(typeof window !== 'undefined' ? window : globalThis);
