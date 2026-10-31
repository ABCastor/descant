/* The standfirst is metadata, outside every editable body block. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {}), D = global.document;
  // Only the metadata line changes. Body bytes, blank lines and key order survive.
  function withField(source, key, value, words) {
    const text = String(source), field = String(value).trim(), lead = new RegExp('^' + key + ':');
    if (/[\r\n\u0000-\u001f\u007f]/.test(field)) throw Error('A ' + words + ' is one line of plain text.');
    const header = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
    if (!header) throw Error('This article needs front matter before adding a ' + words + '.');
    const newline = header[1].includes('\r') ? '\r\n' : '\n';
    const rows = header[2].split(newline), hits = rows.filter(line => lead.test(line));
    if (hits.length > 1) throw Error('Keep one ' + words + ' in the front matter.');
    const line = key + ': ' + JSON.stringify(field);
    const next = rows.flatMap(row => lead.test(row) ? (field ? [line] : []) : [row]);
    if (!hits.length && field) next.push(line);
    return header[1] + next.join(newline) + header[3] + text.slice(header[0].length);
  }
  function withSource(source, value) { return withField(source, 'subtitle', value, 'subtitle'); }
  // A title stays unquoted, as authors write it, only when the parser reads the
  // plain form back as exactly the same string (not a number, true or null).
  function withTitle(source, value) {
    const title = String(value).trim(), quoted = withField(source, 'title', title, 'title');
    if (!/^[^\s"'#&*!|>%@`{}\[\],?:-][^:#]*$/.test(title)) return quoted;
    const plain = quoted.replace(/^title: ".*"$/m, function () { return 'title: ' + title; });
    const parse = C.md && C.md.parse;
    return parse && parse(plain).frontmatter.title === title ? plain : quoted;
  }

  var ctx, node, input, bound = false, heading = null, titleAtFocus = null;
  function isWriter(id) { return !!(C.people && C.people.isWriter(id)); }
  function founder() {
    var role = C.role || {};
    if (role.role === 'reviewer' || role.reviewer === true) return false;
    var people = C.who && C.who.session ? C.who.session() : [];
    if (people.length) return people.some(function (p) { return isWriter(p.id); });
    return isWriter(role.who || '') || role.confirmed === true || role.role === 'founder';
  }
  function editable() { return founder() && C.editor && C.editor.canEditSubtitle(); }
  function value() {
    var doc = C.md.parse(C.editor.getSource());
    return typeof doc.frontmatter.subtitle === 'string' ? doc.frontmatter.subtitle : '';
  }
  function fit() {
    if (!input || !input.style) return;
    input.style.height = 'auto';
    if (input.scrollHeight) input.style.height = input.scrollHeight + 'px';
  }
  function close() { input = null; if (node) node.remove(); node = null; sync(); }
  function edit() {
    if (input || !editable()) return;
    var old = value(), finished = false;
    // A one-row text area set exactly like the subtitle, so editing keeps its
    // look: same type, same wrapping, no box. Enter finishes; it never adds a line.
    input = D.createElement('textarea'); input.rows = 1; input.value = old;
    input.setAttribute('aria-label', 'Subtitle'); input.setAttribute('autocomplete', 'off'); input.setAttribute('spellcheck', 'true');
    node.classList.add('cw-subtitle-editing');
    node.replaceChildren(input); fit();
    input.addEventListener('input', fit);
    function finish(cancel) {
      if (finished) return; finished = true;
      if (!cancel && editable()) {
        try { C.editor.updateSubtitle(String(input.value).replace(/[\r\n]+/g, ' ')); }
        catch (error) { input.setCustomValidity(error.message); input.reportValidity(); finished = false; return; }
      }
      close();
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(false); });
    ['input', 'beforeinput', 'paste', 'copy', 'compositionstart', 'compositionend', 'dragstart'].forEach(function (type) {
      input.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    input.addEventListener('dragover', function (e) {
      e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    input.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      var text = e.dataTransfer && e.dataTransfer.getData('text/plain');
      if (!text) return;
      var start = input.selectionStart == null ? input.value.length : input.selectionStart;
      var end = input.selectionEnd == null ? start : input.selectionEnd;
      input.value = input.value.slice(0, start) + text.replace(/[\r\n]+/g, ' ') + input.value.slice(end);
    });
    input.focus();
  }
  function sync() {
    if (!ctx || !C.editor || input) return;
    var title = ctx.article.querySelector('.cw-block[data-type="h1"]');
    var text = value(), canEdit = editable();
    if (!title || (!text && !canEdit)) { if (node) node.remove(); node = null; return; }
    if (!node || node.parentNode !== title.parentNode) {
      if (node) node.remove();
      node = D.createElement('div'); node.className = 'cw-subtitle';
      node.setAttribute('contenteditable', 'false');
      node.addEventListener('click', edit);
      node.addEventListener('keydown', function (e) {
        if (!input && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); edit(); }
      });
    }
    title.classList.add('cw-title-area');
    watchTitle(title);
    title.parentNode.insertBefore(node, title.nextSibling);
    node.textContent = text || 'Add a subtitle';
    node.classList.toggle('cw-subtitle-empty', !text);
    node.setAttribute('tabindex', canEdit ? '0' : '-1');
    node.setAttribute('role', canEdit ? 'button' : 'note');
    node.setAttribute('aria-label', canEdit ? (text ? 'Edit subtitle' : 'Add a subtitle') : 'Subtitle');
  }
  /* The title is the article's first heading, edited in place like any block,
     but it keeps its resting look: the "# " marker hangs outside the column,
     invisible, and the caret never enters it. Leaving the title brings the
     front matter title along when the two matched before the edit. */
  function headingText(el) {
    var b = el && C.editor && C.editor.getBlocks ? C.editor.getBlocks().find(function (x) { return x.id === el.getAttribute('data-block-id'); }) : null;
    var m = b && /^(#{1,6})[ \t]+(.*)$/.exec(b.source);
    return m ? m[2].trim() : null;
  }
  function markerWidth(el) {
    var mark = el.querySelector && el.querySelector('.cw-mirror .cw-mk-block');
    var width = mark && mark.getBoundingClientRect ? mark.getBoundingClientRect().width : 0;
    if (el.style && el.style.setProperty) el.style.setProperty('--title-mark', width + 'px');
    return mark ? mark.textContent.length : 0;
  }
  function titleHost(el) {
    var host = el.querySelector && el.querySelector('.cw-edit');
    return host && host.firstChild && host.firstChild.nodeType === 3 ? host : null;
  }
  function keepCaretOutOfMarker() {
    var el = heading, sel = global.getSelection && global.getSelection();
    if (!el || !sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return;
    var host = titleHost(el), text = host && host.firstChild, lead = el.querySelector('.cw-mirror .cw-mk-block');
    var min = lead ? lead.textContent.length : 0;
    if (!text || !min || text.data.length < min) return;
    var r = sel.getRangeAt(0);
    if (r.startContainer !== text && r.endContainer !== text) return;
    var start = r.startContainer === text ? r.startOffset : min, end = r.endContainer === text ? r.endOffset : text.data.length;
    if (start >= min && end >= min) return;
    var range = D.createRange();
    range.setStart(text, Math.max(start, min)); range.setEnd(text, Math.max(end, min));
    sel.removeAllRanges(); sel.addRange(range);
  }
  function watchTitle(el) {
    heading = el;
    if (el._castorTitle) return;
    el._castorTitle = true;
    el.addEventListener('focusin', function () {
      var fm = C.md.parse(C.editor.getSource()).frontmatter || {};
      titleAtFocus = { heading: headingText(el), title: typeof fm.title === 'string' ? fm.title.trim() : null };
      if (global.requestAnimationFrame) global.requestAnimationFrame(function () { markerWidth(el); keepCaretOutOfMarker(); });
    });
    el.addEventListener('input', function () { markerWidth(el); });
    el.addEventListener('keydown', function (e) {
      var host = titleHost(el), sel = global.getSelection && global.getSelection(), lead = el.querySelector('.cw-mirror .cw-mk-block');
      if (!host || !sel || !sel.rangeCount || !lead) return;
      var min = lead.textContent.length, text = host.firstChild;
      // Typing goes after the marker even if the caret was just moved before it.
      keepCaretOutOfMarker();
      var r = sel.getRangeAt(0);
      var atStart = r.collapsed && r.startContainer === text && r.startOffset <= min;
      var home = e.key === 'Home' || (e.metaKey && e.key === 'ArrowLeft') || (e.key === 'ArrowUp' && !e.shiftKey && atStart);
      if (home && !e.shiftKey) {
        e.preventDefault();
        var range = D.createRange(); range.setStart(text, min); range.collapse(true);
        sel.removeAllRanges(); sel.addRange(range);
      } else if (atStart && (e.key === 'Backspace' || (e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey))) e.preventDefault();
    }, true);
    el.addEventListener('focusout', function () {
      var before = titleAtFocus; titleAtFocus = null;
      if (!before || !before.heading || before.title !== before.heading || !editable()) return;
      var now = headingText(el);
      if (!now || now === before.heading) return;
      try { C.editor.updateFrontmatter(function (source) { return withTitle(source, now); }, 'title'); }
      catch (error) { /* The heading keeps the new words; the tab title stays until the next edit. */ }
    });
  }
  function mount(context) {
    if (node) node.remove(); input = null; node = null; ctx = context;
    if (!bound) {
      bound = true;
      ctx.bus.on('doc:change', sync); ctx.bus.on('who:set', sync);
      if (D.addEventListener) D.addEventListener('selectionchange', keepCaretOutOfMarker);
    }
    sync();
  }
  C.subtitle = { mount: mount, withSource: withSource, withTitle: withTitle };
  if (typeof module !== 'undefined' && module.exports) module.exports = C.subtitle;
})(typeof window !== 'undefined' ? window : globalThis);
