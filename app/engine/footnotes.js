/* ============================================================================
   Castor engine — footnotes.js
   Footnotes twice, which is the whole point of the feature (plan v3, guide 07).

   1. IN THE MARGIN, beside the paragraph that refers to them, when the page is
      wide enough to have a gutter. This is the reading position: the eye does
      not leave the line.
   2. AT THE FOOT, always, in the order they were written, each with a `↩︎` back
      link to the first place it was referred to. This is the printing position,
      and it is what survives being exported, printed, or read on a phone.

   Narrow pages have no gutter, so the margin copy is not drawn at all (a CSS
   container query hides it) and the superscript becomes a toggle: tapping it
   reveals an editor under its own paragraph. Read-only pages toggle the copy.

   Anchors stay separate from placement so panels.js can stack every margin
   family together after fonts, content, or the available width changes.
   ========================================================================== */

(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;

  var S = { page: null, raf: 0, positionRaf: 0, mounted: false, signature: null, refs: [], pairs: [], editing: null, returning: false, observer: null };

  function currentDoc() {
    return (Castor.editor && Castor.editor.getDoc && Castor.editor.getDoc()) ||
      (Castor.app && Castor.app.doc);
  }

  function footnoteSignature(doc) {
    if (!doc) return null;
    var refs = [];
    (doc.blocks || []).forEach(function (block) {
      var hits = String(block.source || '').match(/\[\^[^\]\n]+\]/g);
      if (hits) refs.push([block.id, hits]);
    });
    return JSON.stringify([refs, doc.footnotes || {}, doc.footnoteOrder || []]);
  }

  function refsChanged() {
    if (!S.page) return false;
    var refs = S.page.querySelectorAll('.footnote-ref a[data-footnote]');
    if (refs.length !== S.refs.length) return true;
    for (var i = 0; i < refs.length; i++) if (refs[i] !== S.refs[i]) return true;
    return false;
  }

  function on(name, fn) {
    if (Castor.bus && Castor.bus.on) Castor.bus.on(name, fn);
    else DOC.addEventListener(name, fn);
  }

  /* The element handed over is not always the one holding the blocks: editor.js
     builds its own column of wrappers inside it, later. Resolve it fresh. */
  function column() {
    if (!S.page) return null;
    var first = S.page.querySelector('[data-block-id]');
    return (first && first.parentElement) || S.page.querySelector('.page-column') || S.page;
  }

  function blockOf(node) {
    var col = column();
    var el = node;
    while (el && el.parentElement && el.parentElement !== col) el = el.parentElement;
    return el && el.parentElement === col ? el : null;
  }

  function clear() {
    if (!S.page) return;
    var old = S.page.querySelectorAll('[data-castor-fn]');
    for (var i = 0; i < old.length; i++) if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
  }

  /* The note's text: md.js hands it over already rendered, keyed by the footnote
     key. Falling back to the definition element's own markup keeps this working
     over any renderer that produced the page. */
  function noteHtml(key, defs) {
    var doc = currentDoc();
    if (doc && doc.footnotes && doc.footnotes[key] != null) return doc.footnotes[key];
    var d = defs[key];
    if (!d) return null;
    var clone = d.cloneNode(true);
    var sup = clone.querySelector('sup');
    if (sup && sup.parentNode) sup.parentNode.removeChild(sup);
    var back = clone.querySelector('.footnote-back');
    if (back && back.parentNode) back.parentNode.removeChild(back);
    return clone.innerHTML;
  }

  /* What the reader sees beside the paragraph is the NUMBER, the same one the
     superscript and the note at the foot carry; `key` stays internal. md.js is
     the one that counts, so read its answer rather than counting again here. */
  function numberOf(key, defs) {
    var d = defs && defs[key];
    var sup = d && d.querySelector('sup');
    if (sup && sup.textContent.trim()) return sup.textContent.trim();
    var doc = Castor.app && Castor.app.doc;
    if (doc && doc.footnoteNumbers && doc.footnoteNumbers[key] != null) return String(doc.footnoteNumbers[key]);
    return key;
  }

  /* The foot list reads in the order the reader met the notes, not the order the
     author happened to type the definitions in: a numbered list that runs
     1 · 2 · 5 · 3 · 4 looks broken however right each number is. md.js hands over
     `footnoteOrder` for exactly this. Only the RENDERED elements move — `blocks`
     and `source` keep the author's order, and the editor looks its blocks up by
     id, so nothing about the file changes. Refused unless the definitions are a
     contiguous run: reordering across a paragraph would move the paragraph. */
  function orderFoot(col, defs) {
    var doc = Castor.app && Castor.app.doc;
    var order = doc && doc.footnoteOrder;
    if (!col || !order || order.length < 2) return;
    var byKey = {}, wanted = [], i;
    for (i = 0; i < order.length; i++) {
      var d = defs[order[i]], b = d && blockOf(d);
      if (b && b.parentElement === col && !byKey[order[i]]) { byKey[order[i]] = b; wanted.push(b); }
    }
    if (wanted.length < 2) return;
    var here = wanted.slice().sort(function (a, b2) {
      return (a.compareDocumentPosition(b2) & 4) ? -1 : 1;
    });
    var run = here[0], seen = 0;
    while (run && seen < here.length) {                 // contiguous?
      if (here.indexOf(run) < 0) return;
      seen++;
      run = run.nextElementSibling;
    }
    var after = here[here.length - 1].nextSibling;
    for (i = 0; i < wanted.length; i++) col.insertBefore(wanted[i], after);
  }

  /* A note's number and body, in the margin or under its paragraph. */
  function noteShell(kind, key, html, label) {
    var n = DOC.createElement('aside');
    n.className = 'footnote-' + kind;
    n.setAttribute('data-castor-fn', kind);
    n.setAttribute('data-key', key);
    var num = DOC.createElement('span');
    num.className = 'footnote-margin-key';
    num.textContent = label == null ? key : label;
    n.appendChild(num);
    var body = DOC.createElement('span');
    body.className = 'footnote-margin-body';
    body.innerHTML = html;
    n.appendChild(body);
    return n;
  }

  function marginNote(key, html, label) {
    var n = noteShell('margin', key, html, label);
    n.tabIndex = 0;
    n.setAttribute('aria-label', 'Footnote ' + label + ', editable');
    n.addEventListener('click', function (ev) {
      if (ev.target.closest('a[href]') || S.editing && S.editing.note === n) return;
      var pair = S.pairs.find(function (p) { return p.note === n; });
      if (pair) openReference(pair.ref, pair.block, key);
    });
    n.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || ev.target !== n) return;
      ev.preventDefault(); ev.stopPropagation();
      var pair = S.pairs.find(function (p) { return p.note === n; });
      if (pair) openReference(pair.ref, pair.block, key);
    });
    return n;
  }

  function definitionBody(key) {
    var doc = currentDoc();
    var block = doc && doc.blocks.find(function (b) {
      return b.type === 'footnote-def' && b.meta && b.meta.footnoteKey === key;
    });
    return block ? block.meta.body : null;
  }

  function finishEditing(returnFocus) {
    var edit = S.editing;
    if (!edit) return;
    S.editing = null;
    edit.note.classList.remove('is-editing');
    if (edit.note.classList.contains('footnote-inline')) edit.note.remove();
    else edit.body.innerHTML = (currentDoc().footnotes || {})[edit.key] || '';
    if (refsChanged()) schedule(); else schedulePosition();
    if (returnFocus && edit.caret) Castor.editor.restoreCaret(edit.caret, 'navigate');
  }

  function startEditing(note, key, label, caret) {
    if (!Castor.editor || !Castor.editor.updateFootnote ||
        Castor.editor.isReadOnly && Castor.editor.isReadOnly() || global.getComputedStyle(note).display === 'none') return;
    var value = definitionBody(key);
    if (value == null) return;
    finishEditing(false);
    if (Castor.editor.blur) Castor.editor.blur();
    var body = note.querySelector('.footnote-margin-body');
    body.textContent = '';
    var measure = DOC.createElement('span');
    measure.className = 'footnote-margin-measure';
    measure.setAttribute('aria-hidden', 'true');
    measure.textContent = value + '\n';
    // A side note is written with the article's editor. It grows with its text,
    // keeps its own undo, and the article ignores its keys, so it needs neither a
    // measuring copy nor stopped events.
    var editorField = Castor.editorField && typeof global.HTMLElement === 'function' && DOC.createElement('div') instanceof global.HTMLElement;
    var field = editorField
      ? Castor.editorField({ name: 'note', className: 'footnote-margin-edit', label: 'Footnote ' + label + ', editable', value: value })
      : DOC.createElement('textarea');
    if (!editorField) {
      field.className = 'footnote-margin-edit';
      field.rows = 1;
      field.value = value;
      field.setAttribute('aria-label', 'Footnote ' + label + ', editable');
      body.appendChild(measure);
    }
    body.appendChild(field);
    note.classList.add('is-editing');
    S.editing = { note: note, key: key, body: body, field: field, caret: caret };
    // Native textarea undo owns note typing; the body editor must not consume it.
    if (!editorField) ['keydown', 'beforeinput', 'input', 'paste', 'compositionstart', 'compositionend'].forEach(function (name) {
      field.addEventListener(name, function (ev) { ev.stopPropagation(); });
    });
    field.addEventListener('keydown', function (ev) {
      if (!ev.isComposing && (ev.key === 'Escape' || ev.key === 'Enter' && !ev.shiftKey)) { ev.preventDefault(); finishEditing(true); }
    });
    field.addEventListener('input', function () {
      measure.textContent = field.value + '\n';
      Castor.editor.updateFootnote(key, field.value);
      schedulePosition();
    });
    field.addEventListener('blur', function () { finishEditing(false); });
    field.focus();
    if (note.scrollIntoView) note.scrollIntoView({ block: 'nearest' });
    schedulePosition();
  }

  function inlineNote(key, html, label) { return noteShell('inline', key, html, label); }

  /* Every definition at the foot gets one back link to the first reference. The
     arrow is the brief's, and it is the one control in the engine that is a glyph
     rather than a word: a word here would be longer than the note. */
  function addBackLink(def, key, refId, label) {
    if (!def || def.querySelector('.footnote-back')) return;
    var a = DOC.createElement('a');
    a.className = 'footnote-back';
    a.setAttribute('data-castor-fn', 'back');
    a.href = '#' + refId;
    a.textContent = '↩︎';
    a.setAttribute('aria-label', 'Back to where note ' + (label == null ? key : label) + ' is referred to');
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      var ref = DOC.getElementById(refId);
      if (!ref) return;
      if (ref.scrollIntoView) ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
      ref.classList.remove('flash');
      void ref.offsetWidth;
      ref.classList.add('flash');
    });
    def.appendChild(DOC.createTextNode(' '));
    def.appendChild(a);
  }

  function inlineFor(block, key) {
    var next = block.nextElementSibling;
    while (next && next.hasAttribute('data-castor-fn')) {
      if (next.classList.contains('footnote-inline') && next.getAttribute('data-key') === key) return next;
      next = next.nextElementSibling;
    }
    return null;
  }

  function toggleInline(block, key, html, label) {
    var existing = inlineFor(block, key);
    if (existing) {
      existing.parentNode.removeChild(existing);
      return;
    }
    var n = inlineNote(key, html, label);
    if (block.parentNode) block.parentNode.insertBefore(n, block.nextSibling);
  }

  function openReference(ref, block, key) {
    var sourceBlock = (currentDoc().blocks || []).find(function (b) { return b.id === block.getAttribute('data-block-id'); });
    if (!sourceBlock) return;
    var same = block.querySelectorAll('.footnote-ref a[data-footnote], .cw-fnref[data-footnote]'), occurrence = 0;
    for (var i = 0; i < same.length && same[i] !== ref; i++) if (same[i].getAttribute('data-footnote') === key) occurrence++;
    // The source renderer already skips escaped text and code. Its offsets
    // distinguish real calls from marker-shaped prose without a second parser.
    var rendered = DOC.createElement('span');
    rendered.innerHTML = Castor.editor._internals.renderInline(sourceBlock.source).html;
    var markers = rendered.querySelectorAll('.cw-fnref[data-footnote]');
    for (i = 0; i < markers.length; i++) {
      if (markers[i].getAttribute('data-footnote') === key && occurrence-- === 0) {
        open(key, sourceBlock.id, Number(markers[i].getAttribute('data-source-end')));
        return;
      }
    }
  }

  function open(key, blockId, offset) {
    if (S.editing && S.editing.key === key && S.editing.caret.blockId === blockId && S.editing.caret.start === offset) { S.editing.field.focus(); return; }
    finishEditing(false);
    if (Castor.editor && Castor.editor.blur) Castor.editor.blur();
    if (footnoteSignature(currentDoc()) !== S.signature || refsChanged()) layout();
    var pair = S.pairs.find(function (p) { return p.key === key && p.block.getAttribute('data-block-id') === blockId; });
    if (!pair) return;
    var label = numberOf(key), note = pair.note;
    if (global.getComputedStyle(note).display === 'none') {
      note = inlineFor(pair.block, key);
      if (!note) {
        note = inlineNote(key, noteHtml(key, {}) || '', label);
        pair.block.parentNode.insertBefore(note, pair.block.nextSibling);
      }
    }
    startEditing(note, key, label, { blockId: blockId, start: offset, end: offset });
  }

  // Capture the return tap before the body editor moves the caret to the tap.
  // Touchend and its synthetic click belong to that same gesture.
  function onArticleReturn(ev) {
    var block = ev.target.closest && ev.target.closest('.cw-block');
    if (!block || ev.target.closest('a[href], .cw-fnref')) return;
    if (!S.editing && !S.returning) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (S.editing) finishEditing(true);
    S.returning = ev.type !== 'click';
  }

  function layout() {
    S.raf = 0;
    if (!S.page) return;
    if (Castor.bonds) Castor.bonds.clear('footnote:');
    S.editing = null;
    if (S.observer) S.observer.disconnect();
    clear();
    var col = column();
    if (!col) return;

    var defs = {}, list = col.querySelectorAll('.footnote-definition[id]'), i;
    for (i = 0; i < list.length; i++) {
      var id = list[i].id.replace(/^fn-/, '');
      defs[id] = list[i];
    }

    orderFoot(col, defs);

    var refs = col.querySelectorAll('.footnote-ref a[data-footnote]');
    S.refs = Array.prototype.slice.call(refs);
    var firstRef = {}, pending = [];
    for (i = 0; i < refs.length; i++) {
      var a = refs[i];
      var key = a.getAttribute('data-footnote');
      var block = blockOf(a);
      if (!block) continue;
      if (!firstRef[key]) {
        firstRef[key] = 'fnref-' + key;
        a.id = firstRef[key];
      }
      var html = noteHtml(key, defs);
      if (html == null) continue;                 // a ref with no definition: md.js marks it
      var label = numberOf(key, defs);
      bindRef(a, block, key, html, label);
      if (block.querySelector && block.classList.contains('footnote-definition')) continue;
      pending.push({ block: block, ref: a, key: key, note: marginNote(key, html, label) });
    }

    for (var k in firstRef) if (defs[k]) addBackLink(defs[k], k, firstRef[k], numberOf(k, defs));

    // Measure every block first, then insert: inserting changes the next measurement.
    var colTop = col.getBoundingClientRect ? col.getBoundingClientRect().top : 0;
    pending.forEach(function (p) { p.top = p.block.getBoundingClientRect().top - colTop; });
    pending.forEach(function (p) {
      p.note.dataset.marginAnchor = p.block.getAttribute('data-block-id');
      p.note.dataset.marginAt = String(Math.round(p.top));
      p.note.style.setProperty('--at', Math.round(p.top) + 'px');
      if (p.block.parentNode) p.block.parentNode.insertBefore(p.note, p.block.nextSibling);
      else col.appendChild(p.note);
    });
    S.pairs = pending;
    if (S.observer) {
      S.observer.observe(S.page);
      if (S.page.parentElement) S.observer.observe(S.page.parentElement);
    }
    S.signature = footnoteSignature(currentDoc());
    // New notes can share an anchor. Stack them before their first paint;
    // later resize/font updates still coalesce through the regular queue.
    if (Castor.panels && Castor.panels.routeMargins) Castor.panels.routeMargins(true);
    if (Castor.bonds) {
      pending.forEach(function (p, index) {
        Castor.bonds.register('footnote:' + p.key + ':' + index, {
          kind: 'footnote-to-line', from: p.ref, to: p.note
        });
      });
      Castor.bonds.layout();
    }
  }

  /* Writers open the same editor through every reference. Readers retain the
     blog's margin flash or under-paragraph toggle. */
  function bindRef(a, block, key, html, label) {
    if (a.dataset.fnBound) return;
    a.dataset.fnBound = '1';
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (Castor.editor && !(Castor.editor.isReadOnly && Castor.editor.isReadOnly())) {
        openReference(a, block, key);
        return;
      }
      var margin = block.parentNode &&
        block.parentNode.querySelector('.footnote-margin[data-key="' + key + '"]');
      var shown = margin && global.getComputedStyle(margin).display !== 'none';
      if (shown) {
        margin.classList.remove('flash');
        void margin.offsetWidth;
        margin.classList.add('flash');
        return;
      }
      var current = noteHtml(key, {});
      toggleInline(block, key, current == null ? html : current, label);
    });
  }

  function schedule() {
    if (S.raf) return;
    // A piece-open idle callback can arrive after doc:change already rebuilt
    // these same refs. Check at execution, before removing live margin notes.
    var refresh = function () {
      S.raf = 0;
      if (footnoteSignature(currentDoc()) !== S.signature || refsChanged()) layout();
      else schedulePosition();
    };
    S.raf = global.requestAnimationFrame
      ? global.requestAnimationFrame(refresh)
      : global.setTimeout(refresh, 16);
  }

  function reposition() {
    S.positionRaf = 0;
    if (!S.page || S.raf || !S.pairs.length) return;
    if (S.editing && global.getComputedStyle(S.editing.note).display === 'none') finishEditing(false);
    if (Castor.panels && Castor.panels.routeMargins) Castor.panels.routeMargins();
  }

  function schedulePosition() {
    if (S.raf || S.positionRaf || !S.pairs.length) return;
    S.positionRaf = global.requestAnimationFrame
      ? global.requestAnimationFrame(reposition)
      : global.setTimeout(reposition, 16);
  }

  function onDocChange(payload) {
    var signature = footnoteSignature(payload && payload.doc || currentDoc());
    if (S.editing && refsChanged()) finishEditing(false);
    if (S.editing) {
      var doc = currentDoc();
      S.pairs.forEach(function (p) {
        if (p.note !== S.editing.note && signature !== S.signature) p.note.querySelector('.footnote-margin-body').innerHTML = doc.footnotes[p.key] || '';
      });
      S.signature = signature;
      schedulePosition();
    } else if (signature !== S.signature || refsChanged()) schedule();
    else schedulePosition();
  }

  function mount(ctx) {
    ctx = ctx || {};
    S.page = ctx.page || DOC.getElementById('page') || DOC.body;
    if (!S.mounted) {
      S.mounted = true;
      if (global.ResizeObserver) S.observer = new global.ResizeObserver(schedulePosition);
      if (DOC.fonts) {
        DOC.fonts.ready.then(schedulePosition);
        DOC.fonts.addEventListener('loadingdone', schedulePosition);
      }
      if (S.page.addEventListener) S.page.addEventListener('load', schedulePosition, true);
      ['pointerdown', 'mousedown', 'touchend', 'click'].forEach(function (name) {
        if (S.page.addEventListener) S.page.addEventListener(name, onArticleReturn, true);
      });
      if (S.page.addEventListener) S.page.addEventListener('click', function (ev) {
        var ref = ev.target.closest && ev.target.closest('.cw-fnref[data-footnote]');
        if (!ref) return;
        ev.preventDefault(); ev.stopImmediatePropagation();
        var block = ref.closest('[data-block-id]');
        if (block) openReference(ref, block, ref.getAttribute('data-footnote'));
      }, true);
      on('doc:change', onDocChange);
      on('piece:open', function () {
        if (global.requestIdleCallback) global.requestIdleCallback(schedule, { timeout: 200 });
        else global.setTimeout(schedule, 32);
      });
      on('layout', schedulePosition);
      on('size', schedulePosition);
      on('theme', schedulePosition);
      global.addEventListener('resize', schedulePosition);
    }
    schedule();
    return api;
  }

  var api = { mount: mount, layout: layout, open: open, _state: S };
  Castor.footnotes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
