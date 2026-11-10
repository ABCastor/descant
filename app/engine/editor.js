/* Castor engine · editor.js — Markdown without seeing it.
 *
 * Focused and reading blocks use the same renderer and glyph metrics. Source
 * markers remain in hidden runs. Native input owns the formatted subtree until
 * its structure changes; composition is never rebuilt while it is active.
 *
 * No libraries. Vanilla ES2020. One global: Castor.
 */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {});
  // Overlay, outline, island, and margin painters share native reads in a frame.
  var frameReads = Castor.frameReads || (Castor.frameReads = (function () {
    var selection = null, styles = new Map(), queued = false;
    function clear() { selection = null; styles.clear(); queued = false; }
    function expire() {
      if (queued) return;
      queued = true;
      (global.requestAnimationFrame || function (fn) { return global.setTimeout(fn, 16); })(function () {
        global.setTimeout(clear, 0);
      });
    }
    return {
      selection: function () {
        if (!selection) {
          var sel = global.getSelection && global.getSelection();
          selection = { sel: sel, range: sel && sel.rangeCount ? sel.getRangeAt(0) : null };
        }
        expire();
        return selection;
      },
      invalidateSelection: function () { selection = null; },
      invalidateStyles: function () { styles.clear(); },
      style: function (node) {
        if (!styles.has(node)) styles.set(node, global.getComputedStyle(node));
        expire();
        return styles.get(node);
      }
    };
  })());
  // A bus is app.js's to own; create one only if nothing has yet, so that a
  // module mounted before app.js still has somewhere to emit.
  if (!Castor.bus) {
    Castor.bus = (function () {
      var m = {};
      return {
        on: function (k, fn) { (m[k] || (m[k] = [])).push(fn); return function () { Castor.bus.off(k, fn); }; },
        off: function (k, fn) { m[k] = (m[k] || []).filter(function (f) { return f !== fn; }); },
        emit: function (k, payload) { (m[k] || []).slice().forEach(function (f) { try { f(payload); } catch (e) { console.error(e); } }); }
      };
    })();
  }
  /* One editor, mounted as often as it is needed: the article,
     and every comment, reply and side note, so they all write the same way. Each
     call below has its own blocks, history, caret and overlays. Only the article
     ('article') talks on Castor.bus, so a comment being typed never reads as the
     article changing; any other instance has a bus of its own (editor.on) and
     block ids prefixed with its name. The body is not re-indented, so the lines
     the tests hook (where Castor.editor is set, and repaint) keep their exact text. */
  function privateBus() {
    var m = {};
    return {
      on: function (k, fn) { (m[k] || (m[k] = [])).push(fn); return function () { (m[k] = (m[k] || []).filter(function (f) { return f !== fn; })); }; },
      off: function (k, fn) { m[k] = (m[k] || []).filter(function (f) { return f !== fn; }); },
      emit: function (k, payload) { (m[k] || []).slice().forEach(function (f) { try { f(payload); } catch (e) { console.error(e); } }); }
    };
  }
  var instanceCount = 0;
  function createEditor(role) {
  var isArticle = role === 'article';
  var bus = isArticle ? Castor.bus : privateBus();
  // An editor mounted inside this one (a comment composer or a side note on the
  // article page) owns its own events: this one ignores them.
  function foreign(node) {
    for (var n = node && node.nodeType === 1 ? node : node && node.parentNode; n && n !== page; n = n.parentNode)
      if (n.classList && n.classList.contains('cw-editor-page')) return true;
    return false;
  }
  function own(fn) { return function (e) { if (foreign(e && e.target)) return; return fn.apply(this, arguments); }; }
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ESCAPES[c]; }); }
  function isAlnum(c) { return !!c && /[A-Za-z0-9]/.test(c); }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }
  var idSeq = 0;
  function mintId() { return (isArticle ? 'e' : role + '-e') + (++idSeq); }

  var MULTILINE = { list: 1, code: 1, table: 1, quote: 1, callout: 1, 'footnote-def': 1, frontmatter: 1 };

  // A bare hash run is an empty heading while writing. `#aphorism` is a tag,
  // and a `#` anywhere but offset 0 is never a heading marker.
  function classify(src) {
    var lines = src.split('\n'), first = lines[0] || '';
    var m = /^(#{1,6})(?:[ \t]|$)/.exec(first);
    if (m) return 'h' + m[1].length;
    if (/^---\s*$/.test(first) && lines.length > 2 && /^---\s*$/.test(lines[lines.length - 1])) return 'frontmatter';
    if (/^\s*(```|~~~)/.test(first)) return 'code';
    if (/^\s*>\s*\[!/.test(first)) return 'callout';
    if (/^\s*>/.test(first)) return 'quote';
    if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return 'list';
    if (/^(?: {4}| {0,3}\t)/.test(first)) return 'code';
    if (lines.length > 1 && /^ {0,3}[|: \t-]+$/.test(lines[1]) && MD().parse(src).blocks[0]?.type === 'table') return 'table';
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(src.trim())) return 'hr';
    if (/^\[\^[^\]]+\]:/.test(first)) return 'footnote-def';
    if (/^!\[\[[^\]]+\]\]\s*$/.test(src.trim())) return 'embed';
    if (/\n {0,3}=+[ \t]*$/.test(src)) return 'h1';
    if (/\n {0,3}-+[ \t]*$/.test(src)) return 'h2';
    return 'p';
  }

  // Length of the markdown marker at the head of a source line (heading hashes,
  // list bullet, quote arrows, task box). Rendered dim, kept in the source.
  function markerLen(line) {
    var m = /^(#{1,6})(?:[ \t]|$)/.exec(line);
    if (m) return m[0].length;
    m = /^(\s*)((?:>\s?)+)(\[![a-z]+\]\s*)?/i.exec(line);
    if (m && m[2]) return m[0].length;
    m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(line);
    if (m) return m[0].length;
    m = /^(\[\^[^\]]+\]:\s*)/.exec(line);
    if (m) return m[0].length;
    return 0;
  }

  function headingLevel(type) { return /^h[1-6]$/.test(type) ? +type.slice(1) : 0; }

  function renderInline(source) { return { html: MD().renderInline(source, { editSource: true }) }; }
  // Resolve from the current source, including edits made before the delayed
  // reparse. Focus and serialization must share the same reference authority.
  var referenceContextSource = null, referenceContext = {};
  function currentReferences() {
    var source = getSource();
    if (source !== referenceContextSource) {
      referenceContext = source.indexOf(']:') < 0 ? {} : MD().parse(source).references || {};
      referenceContextSource = source;
    }
    doc.references = referenceContext;
    return referenceContext;
  }
  function liveHtml(block) {
    var parsed = MD().parse(block.source, { editSource: true, showWriterNotes: opts.showWriterNotes !== false,
      footnoteNumbers: doc && doc.footnoteNumbers, footnotes: doc && doc.footnotes, references: currentReferences() });
    // A reference definition is all Markdown, so it would be all hidden marks: the
    // writer edits its plain source, dimmed by its block (definitionSource below).
    if (definitionsOnly(parsed)) return standsAsDefinition(block) ? WRITER_LINE + esc(block.source) + '</p>' : strandedHtml(block, true);
    return (parsed.blocks.map(function (b) { return b.html; }).join('') || '<p><br></p>').replace(/ data-block-id="[^"]*"/g, '');
  }
  // Only link reference definitions (`[r]: /url`): lines that draw nothing in the article.
  var WRITER_LINE = '<p class="cw-writer-line">';
  function definitionsOnly(parsed) {
    return !!(parsed && parsed.blocks.length) && parsed.blocks.every(function (b) { return b.type === 'reference-def'; });
  }
  /* A block of reference definitions is shown to the writer as its source, dimmed like
     a writer note, whether or not the caret is in it. The block carries the dimming, so
     the painted text and the editable text have one size and one face. */
  function markWriterSource(wrap, on, unused) {
    var list = wrap && wrap.classList, change = list && list[on ? 'add' : 'remove'];
    if (change) change.call(list, 'cw-writer-source');
    if (list && list.add && list.remove) list[on && unused ? 'add' : 'remove']('cw-unused');
  }
  /* A definition no link of the page uses: readers never see the line, perhaps by
     accident ("[Update]: later" reads as one). The page says so at the line's end. */
  function unusedDefinition(b) {
    var used = doc && doc.usedReferences;
    if (!used || !definitionSource(b.source)) return false;
    try { return MD().parse(b.source).blocks.every(function (x) { return !used.has(x.meta.referenceKey); }); } catch (e) { return false; }
  }
  function definitionSource(source) {
    source = String(source || '');
    if (source.indexOf(']:') < 0) return false;
    try { return definitionsOnly(MD().parse(source)); } catch (e) { return false; }
  }
  /* A block of definitions stands as one only if it still is once the lines joined to
     it from above by single line breaks are read with it: a definition cannot
     interrupt a paragraph, a table or a footnote, which then print it on the site. */
  function standsAsDefinition(b, text) {
    if (!b) return false;
    text = text == null ? b.source : text;
    if (!definitionSource(text)) return false;
    var at = idx(b.id), above = '';
    for (var i = at; i > 0; i--) {
      var gap = typeof blocks[i].sep === 'string' ? blocks[i].sep : '\n\n';
      if (!gap || /\n[ \t]*\n/.test(gap)) break;
      above = blocks[i - 1].source + gap + above;
    }
    if (!above) return true;
    try {
      var all = MD().parse(above + text).blocks, own = MD().parse(text).blocks.length;
      return all.length >= own && all.slice(-own).every(function (x) { return x.type === 'reference-def'; });
    } catch (e) { return false; }
  }
  // The paragraph text the site prints for such a stranded line.
  function strandedHtml(b, editing) {
    return '<p>' + MD().renderInline(b.source, { editSource: !!editing, references: doc && doc.references }) + '</p>';
  }
  /* Such a block is written as source, like a code fence: what the writer types is
     what is saved, with no escape, no white-space span and no auto-closed pair. Only
     while the result is still a definition: the moment an edit would leave prose,
     that edit goes through the paragraph path and is escaped like any paragraph. */
  function editedAsSource(b, after) {
    return typeof standsAsDefinition === 'function' && standsAsDefinition(b, after);
  }

  function editingHtml(html, source) {
    // Rendering is never a source transformation. Check the actual DOM projection
    // before installing it, including unknown block types and generated labels.
    var probe = document.createElement('div'); probe.innerHTML = html;
    if (source != null && probe.textContent !== source) return esc(source);
    // The reader decorates definitions by id. Its return links belong to the
    // mirror, never to the editable source projection.
    html = html.replace(/(<aside\b[^>]*class="footnote-definition"[^>]*?) id="fn-[^"]*"/g, '$1');
    // A plain paragraph needs no formatting nodes. Keep its native text node
    // across keystrokes; the mirror still owns the reader's paragraph box.
    if (html === '<p><br></p>') return '';
    var plain = /^<p(?: class="cw-writer-line")?>([^<]*)<\/p>$/.exec(html);
    return plain ? plain[1] : html;
  }

  function MD() {
    if (!Castor.md || !Castor.md.parse) throw new Error('Castor editor requires md.js before mount');
    return Castor.md;
  }

  // Plain hosts use one text node; formatted hosts retain source runs and map
  // native text and element-boundary positions to Markdown offsets.
  function editOf(id) {
    var el = elOf(id);
    return el && el.querySelector('.cw-edit');
  }
  function textOf(host) {
    return host && host.childNodes.length === 1 && host.childNodes[0].nodeType === 3 ? host.childNodes[0] : null;
  }
  function sourceNodes(host) {
    if (!host) return [];
    var single = textOf(host);
    if (single) return [{ node: single, at: 0, len: single.data.length }];
    if (host.nodeType === 3) return [{ node: host, at: 0, len: host.data.length }];
    var all = [];
    (function visit(n) { Array.prototype.forEach.call(n.childNodes || [], function (child) { if (child.nodeType === 3) all.push(child); else visit(child); }); })(host);
    var node, out = [], at = 0;
    for (var j = 0; j < all.length; j++) {
      node = all[j];
      var ui = node.parentElement && node.parentElement.closest('[data-castor-ui]');
      if (ui && host.contains(ui)) continue;
      out.push({ node: node, at: at, len: node.nodeValue.length }); at += node.nodeValue.length;
    }
    return out;
  }
  function hiddenSource(node) {
    return !!(node && node.parentElement && node.parentElement.closest('.cw-mk,.cw-atom'));
  }
  function interactionRuns(host) {
    return sourceNodes(host).filter(function (n) {
      var atom = n.node.parentElement && n.node.parentElement.closest('.cw-atom');
      if (atom) { n.atomic = true; return true; }
      return !hiddenSource(n.node);
    });
  }
  function sourcePoint(host, offset, forward) {
    var nodes = sourceNodes(host), candidate = null, boundary = null;
    (function visit(parent, at) {
      Array.prototype.forEach.call(parent.childNodes || [], function (child, index) {
        var length = child.nodeType === 3 ? child.nodeValue.length : child.textContent == null ? sourceNodes(child).reduce(function (sum, n) { return sum + n.len; }, 0) : child.textContent.length;
        var end = at + length;
        if (child.nodeType === 1 && !hiddenSource(child) &&
            (/^(STRONG|EM|MARK|DEL|CODE|A|SUP|SUB|SPAN)$/.test(child.tagName) || /(?:^| )cw-atom(?: |$)/.test(child.className))) {
          if (offset === at || offset === end) {
            if (!boundary) boundary = { node: parent, offset: index + (offset === end ? 1 : 0) };
          }
        }
        if (child.nodeType === 1 && !boundary) visit(child, at);
        at = end;
      });
    })(host, 0);
    if (boundary) return boundary;
    if (offset === nodes.reduce(function (sum, n) { return sum + n.len; }, 0)) return { node: host, offset: host.childNodes.length };
    // A toolbar-created empty pair has no visible text node yet. Its interior
    // is the element boundary between the opening and closing hidden runs.
    for (var j = 0; j + 1 < nodes.length; j++) {
      var left = nodes[j], right = nodes[j + 1], parent = left.node.parentElement && left.node.parentElement.parentElement;
      if (left.at + left.len === offset && right.at === offset && hiddenSource(left.node) && hiddenSource(right.node) &&
          parent && parent === right.node.parentElement.parentElement && /^(STRONG|EM|MARK|DEL|CODE)$/.test(parent.tagName)) {
        return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, right.node.parentElement) };
      }
    }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (hiddenSource(n.node)) continue;
      if (offset >= n.at && offset <= n.at + n.len) {
        candidate = { node: n.node, offset: offset - n.at };
        return candidate;
      }
      if (n.at > offset) return forward || !candidate ? { node: n.node, offset: 0 } : candidate;
      candidate = { node: n.node, offset: n.len };
    }
    return candidate || { node: host, offset: 0 };
  }
  function domOffset(host, node, offset) {
    if (!host || node !== host && !host.contains(node)) return null;
    var nodes = sourceNodes(host), at = 0;
    if (node.nodeType === 3) {
      for (var i = 0; i < nodes.length; i++) if (nodes[i].node === node) return nodes[i].at + clamp(offset, 0, nodes[i].len);
      return null;
    }
    var children = node.childNodes || [];
    for (var k = 0; k < Math.min(offset, children.length); k++) at += children[k].textContent.length;
    if (node === host) return at;
    for (var n = node; n && n !== host; n = n.parentNode) {
      for (var prev = n.previousSibling; prev; prev = prev.previousSibling) at += prev.textContent.length;
    }
    return at;
  }



  var page = null;               // the page element
  var opts = {};
  var blocks = [];               // [{id, type, source}] — the editing model
  var tail = '';                 // whatever followed the last block in the file, put back on save
  var rendered = {};             // id -> the block's rendered HTML (from md.js)
  var doc = { blocks: [], headings: [], footnotes: {}, frontmatter: null };
  var headingCache = {};
  var headingContextSource = null, headingReferences = {}, headingReferenceKey = '';
  var focusId = null;
  var undoStack = [], redoStack = [];
  var lastUndoAt = 0, lastUndoKind = '', lastUndoBlock = null;
  var lastUndoCaret = null;
  var lastNativeCaret = null;
  var keyboardCaret = null;
  var literalRun = null;         // escapes generated by the current literal edit run
  var pending = [];              // auto-inserted closers awaiting a step-over
  var typingStyles = null;       // collapsed command intent, anchored to its next caret
  var selMenu = null, selAnchor = null;
  var activePicker = null;       // {kind, start, len, handle}
  var reparseTimer = null, composing = false, compositionId = null, compositionState = null, mounted = false;
  var caretEl = null, caretLayer = null, selectionLayer = null, overlayRaf = 0;
  var handles = null, draggingHandle = null, lastCaret = null;
  var CARET_TYPE_MS = 90, CARET_JUMP_MS = 140, CARET_GLIDE_CAP_MS = 160;
  var caretRaf = 0, caretMotion = null, caretVisual = null;
  var caretReducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
  var suppressClickUntil = 0;
  var touchInput = false, touchMoved = false, touchStart = null, touchSelection = null, touchCount = 0, everFocused = false;
  var lastEnter = null;
  var typewriterRaf = 0, typewriterOwnUntil = 0, typewriterLast = null, lastFocusPara = null;
  var pickerRaf = 0;
  var overlayMode = 'snap', pointerSelecting = false, pointerStartedInPage = false, nativeIntent = null, handledBackspace = false;
  var pointerAnchor = null, pointerCrossed = false;
  var metrics = { inputs: 0, lastInputMs: 0, maxInputMs: 0, mirrors: 0, lastMirrorMs: 0, maxMirrorMs: 0, trails: 0, lastTrailMs: 0, maxTrailMs: 0 };
  var version = null;

  function world() {
    return (Castor.app && Castor.app.world) ||
      (global.CASTOR_WORLD) ||
      (typeof document !== 'undefined' && document.documentElement.getAttribute('data-world')) || 'dev';
  }

  // Functional fallbacks load first so engine.css and the world win ties.
  function injectBase() {
    if (typeof document === 'undefined' || document.getElementById('castor-editor-base')) return;
    var s = document.createElement('style');
    s.id = 'castor-editor-base';
    s.textContent = [
      '.cw-block{position:relative}',
      '.cw-editor-page ::selection{background:transparent}',
      '.cw-editor-page[data-own-selection] .cw-block{-webkit-user-select:none;user-select:none}',
      '.cw-block>*{margin:0}',
      '.cw-editor-stack{display:grid;position:relative}',
      '.cw-editor-stack>.cw-edit,.cw-editor-stack>.cw-mirror{grid-area:1/1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.cw-edit{position:relative;z-index:2;outline:none;color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent}',
      '.cw-edit::selection{background:transparent;color:transparent;-webkit-text-fill-color:transparent}',
      '.cw-mirror{position:relative;z-index:1;pointer-events:none;user-select:none}',
      '.cw-mirror .cw-live{margin:0}',
      '.cw-mk{display:none}.cw-atom[data-label]::after{content:attr(data-label)}',
      // A source that ends in a newline gets NO line box from `pre-wrap`: the
      // soft break the writer just made is invisible and its caret has no rect.
      // A zero-width pseudo-element after both layers gives that last line its
      // box without adding a child node, so `textOf(host)` still sees exactly
      // one browser-owned text node.
      '.cw-edit::after,.cw-mirror .cw-live:not(.cw-lines)::after{content:"\\200B"}',
      '.cw-writer-only,.cw-writer-source{opacity:.45;font-style:italic}',
      '.cw-line{min-height:1em}',
      '.cw-lines{white-space:pre-wrap}',
      '.cw-t-table,.cw-t-code{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',
      // The overlays' GEOMETRY, not their look: writing.css owns the colour, the
      // width and the motion, and it wins these by loading later. Without this
      // floor the layers fall into the body's flow on a page that loads neither
      // stylesheet (the dev harness), and every rect is painted thousands of
      // pixels below its own text.
      '.cw-caret{position:fixed;left:0;top:0;z-index:79;width:3px;background:var(--caret-ink,var(--ink,#111));pointer-events:none;transform:translate3d(-9999px,-9999px,0)}',
      '.cw-caret-layer{position:fixed;inset:0;z-index:79;pointer-events:none}',
      '.cw-caret[hidden]{display:none}',
      '.cw-selection-layer{position:fixed;inset:0;z-index:78;pointer-events:none}',
      '.cw-selection-rect{position:absolute;left:0;top:0;transform-origin:0 0;background:var(--sel,rgba(80,120,200,.24))}',
      '.cw-sel-handle{position:fixed;left:0;top:0;z-index:79;pointer-events:auto;touch-action:none}',
      '.cw-sel-handle[hidden]{display:none}',
      '.cw-flash{background:var(--sel,rgba(255,214,102,.45));border-radius:2px}',
      '.cw-block.cw-drop-before{box-shadow:inset 0 2px 0 var(--accent,#3b6ea5)}',
      '.cw-block.cw-drop-after{box-shadow:inset 0 -2px 0 var(--accent,#3b6ea5)}',
      '.cw-selmenu{position:fixed;z-index:70;display:flex;gap:2px;padding:3px;border-radius:8px;',
      'background:var(--pane-solid,#fff);color:var(--ink,#111);border:1px solid var(--rule,rgba(0,0,0,.14));',
      'box-shadow:0 6px 20px -6px rgba(0,0,0,.32);font:500 13px/1 var(--font-ui,system-ui,sans-serif)}',
      '.cw-selmenu[hidden]{display:none}',
      '.cw-selmenu button{all:unset;position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:6px 10px;border-radius:5px;cursor:pointer}',
      '.cw-selmenu button:hover,.cw-selmenu button:focus-visible{background:var(--pane-hot,rgba(0,0,0,.07))}',
      '.cw-selmenu .shortcut-hint{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);margin:0;font-size:.625rem;line-height:1;white-space:nowrap;pointer-events:none;opacity:0;visibility:hidden}',
      '.cw-selmenu button:is(:hover,:focus-visible)>.shortcut-hint,html[data-keyhint="on"] .cw-selmenu .shortcut-hint{opacity:1;visibility:visible}'
    ].join('');
    var head = document.head || document.documentElement;
    head.insertBefore(s, head.firstChild);
  }

  function getSource(native) {
    var host = native && focusId && editOf(focusId);
    var out = '';
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var source = host && b.id === focusId ? host.textContent : b.source;
      if (b.empty && !source) continue;
      var gap = typeof b.sep === 'string' ? b.sep : (i === 0 ? '' : '\n\n');
      out += gap + source;
    }
    return out + tail;
  }

  // Visibility is decided from the render, so a new writer-note syntax cannot
  // create an unreachable empty block while images and rules remain visible.
  var DRAWS_WITHOUT_TEXT = /<(img|svg|hr|input|iframe|video|figure)\b/i;


  var MARKER_HTML_RE = /<span class="writer-note"[^>]*>[\s\S]*?<\/span><\/span>\s?/g;

  var rawHtml = {};

  function renderFor(b, md) {
    if (/^#{1,6}[ \t]*$/.test(b.source)) {
      b.type = classify(b.source);
      return '<' + b.type + '><br></' + b.type + '>';
    }
    /* The unstripped string is kept, so turning notes back ON restores the marker
       instead of leaving the stripped copy cached. And a block is never rendered a
       second time just to hide a slot: at least one block in a served piece has
       neither `html` nor parse data and throws in either renderer, which is a
       pre-existing hole this must not fall into. */
    var html = rawHtml[b.id];
    if (html == null) {
      try { html = b.html || md.blockToHtml(b); }
      catch (e) { html = String(b.html || rendered[b.id] || ''); }
      rawHtml[b.id] = html;
    }
    if (opts.showWriterNotes === false) return String(html).replace(MARKER_HTML_RE, '');
    return html;
  }

  function writerOnly(b) {
    if (!b || /^#{1,6}[ \t]*$/.test(b.source) || b.type === 'code' || b.type === 'frontmatter') return false;
    /* A block that renders nothing at all, such as a link's reference definition, is
       still in the file: the caret, a click and Backspace reach it, so the writer
       must see it. One not rendered yet is not one that renders nothing. */
    if (rendered[b.id] === '') return /[^\s]/.test(String(b.source || ''));
    var html = String(rendered[b.id] || '');
    if (!html || DRAWS_WITHOUT_TEXT.test(html)) return false;
    if (/[^\s]/.test(html.replace(/<[^>]*>/g, ''))) return false;
    return /[^\s]/.test(String(b.source || ''));
  }

  function visible(b) {
    if (!b) return false;
    if (b.type === 'frontmatter') return !!opts.showFrontmatter;
    if (opts.showWriterNotes === false && writerOnly(b)) return false;
    return true;
  }
  function firstVisibleBefore(i) { for (var k = i - 1; k >= 0; k--) if (visible(blocks[k])) return k; return -1; }
  function firstVisibleAfter(i) { for (var k = i + 1; k < blocks.length; k++) if (visible(blocks[k])) return k; return -1; }
  function idx(id) { for (var i = 0; i < blocks.length; i++) if (blocks[i].id === id) return i; return -1; }
  function blockOf(id) { var i = idx(id); return i < 0 ? null : blocks[i]; }
  function elOf(id) { return page ? page.querySelector('.cw-block[data-block-id="' + id + '"]') : null; }

  // Ids are stable per build (README). A re-parse renumbers, so re-attach our
  // own ids to the new blocks: exact source match first, then position.
  function reconcileIds(oldList, newList) {
    var used = {}, hits = {}, i, j;
    // Reserve every exact match before a new split block can take its neighbour's
    // ID by position. The render cache is keyed by that ID too.
    for (i = 0; i < newList.length; i++) {
      for (j = 0; j < oldList.length; j++) {
        if (used[j]) continue;
        if (oldList[j].source === newList[i].source) { hits[i] = j; used[j] = 1; break; }
      }
    }
    for (i = 0; i < newList.length; i++) {
      var hit = Object.prototype.hasOwnProperty.call(hits, i) ? hits[i] : -1;
      if (hit < 0 && oldList[i] && !used[i]) hit = i;
      if (hit >= 0) { used[hit] = 1; newList[i].id = oldList[hit].id; }
      else newList[i].id = mintId();
    }
    return newList;
  }

  function syncHeadings() {
    var md = MD(), next = {}, counts = Object.create(null), changed = false;
    var referenceHeading = blocks.some(function (b) { return headingLevel(b.type) && b.source.indexOf('[') >= 0; });
    if (referenceHeading) {
      var source = getSource();
      if (source !== headingContextSource) {
        // Every supported definition contains this boundary. Literal occurrences
        // still use the parser; its absence proves no definitions can resolve.
        headingReferences = source.indexOf(']:') >= 0 ? md.parse(source).references || {} : {};
        headingReferenceKey = JSON.stringify(headingReferences);
        headingContextSource = source;
      }
    } else {
      headingContextSource = null; headingReferences = {}; headingReferenceKey = '';
    }
    var headings = [];
    blocks.forEach(function (b) {
      var level = headingLevel(b.type);
      if (!level) return;
      var cached = headingCache[b.id];
      if (!cached || cached.source !== b.source || cached.references !== headingReferenceKey) {
        var parsed = md.parse(b.source, { references: headingReferences }).headings || [];
        cached = { source: b.source, references: headingReferenceKey, text: parsed[0] ? parsed[0].text : '' };
        changed = true;
      }
      next[b.id] = cached;
      var base = md.slug ? md.slug(cached.text) : b.id;
      var count = counts[base] = (counts[base] || 0) + 1;
      headings.push({ blockId: b.id, level: level, text: cached.text, id: count === 1 ? base : base + '-' + count });
    });
    if (Object.keys(headingCache).length !== headings.length) changed = true;
    headingCache = next;
    doc.headings = headings;
    return changed;
  }

  function parseAll() {
    var md = MD();
    var fresh = md.parse(getSource());
    reconcileIds(blocks, fresh.blocks);
    doc = fresh;
    fresh.blocks.forEach(function (b) { rawHtml[b.id] = null; rendered[b.id] = renderFor(b, md); });
    // A block of definitions an edit has left joined to prose is that prose's text on
    // the site. Until the next mount draws the boundaries again, it reads as text here.
    blocks.forEach(function (b) {
      if (stranded(b)) { rawHtml[b.id] = null; rendered[b.id] = strandedHtml(b, false); }
    });
    syncHeadings();
    return fresh;
  }

  // A definition an edit has left under prose is that prose's text on the site, and the
  // next opening reads the two as one block. Away from the caret, they are one block here too.
  function stranded(b) { return definitionSource(b.source) && !standsAsDefinition(b); }
  function joinStranded(keep, held) {
    for (var i = 1; i < blocks.length; i++) {
      var b = blocks[i], prev = blocks[i - 1], joined = prev.source + (typeof b.sep === 'string' ? b.sep : '\n\n') + b.source;
      if (b.id === keep || prev.id === keep || held[b.id] || held[prev.id] || !stranded(b) || MD().parse(joined).blocks.length !== 1) continue;
      prev.source = joined; prev.type = classify(joined);
      blocks.splice(i--, 1); removeBlockEl(b.id); delete rendered[b.id];
      refreshRendered(prev);
    }
  }

  function refreshRendered(b) {
    var md = MD();
    function keepHeadingIds(all) {
      syncHeadings();
      (doc.headings || []).forEach(function (heading) {
        if (!all && heading.blockId !== b.id) return;
        // Preserve the contextual render. A one-block parse cannot number its
        // heading for the whole page, so only the cached ID needs correction.
        function correct(html) { return html.replace(/ id="[^"]*"/, function () { return ' id="' + esc(heading.id) + '"'; }); }
        if (rendered[heading.blockId]) rendered[heading.blockId] = correct(rendered[heading.blockId]);
        if (rawHtml[heading.blockId]) rawHtml[heading.blockId] = correct(rawHtml[heading.blockId]);
      });
    }
    if (/^#{1,6}[ \t]*$/.test(b.source)) {
      b.type = classify(b.source);
      rawHtml[b.id] = rendered[b.id] = renderFor(b, md);
      return;
    }
    /* the page's footnote numbers travel with the re-parse, or a block that loses
       focus renumbers its own note to 1 */
    var sub = md.parse(b.source, { footnoteNumbers: doc && doc.footnoteNumbers, references: md.parse(getSource()).references });
    if (!sub.blocks.length) {
      // Enter can leave an empty head. It has no parsed HTML to replace the old cache.
      rawHtml[b.id] = rendered[b.id] = '';
    } else if (sub.blocks.length === 1) {
      b.type = sub.blocks[0].type || classify(b.source);
      rendered[b.id] = sub.blocks[0].html || md.blockToHtml(sub.blocks[0]);
      if (headingLevel(b.type)) keepHeadingIds(false);
    } else if (sub.blocks.length > 1) {
      // a paste turned one block into several: split the model
      var at = idx(b.id), extra = [];
      b.source = (sub.blocks[0].sep || '') + sub.blocks[0].source; b.type = sub.blocks[0].type;
      rendered[b.id] = sub.blocks[0].html || md.blockToHtml(sub.blocks[0]);
      for (var i = 1; i < sub.blocks.length; i++) {
        var nb = { id: mintId(), type: sub.blocks[i].type, source: sub.blocks[i].source,
          sep: sub.blocks[i].sep, sepType: sub.blocks[i].type };
        rendered[nb.id] = sub.blocks[i].html || md.blockToHtml(sub.blocks[i]);
        extra.push(nb);
      }
      // These gaps belonged inside the typed block, before its next neighbour.
      extra[extra.length - 1].source += sub.trailing || '';
      blocks.splice.apply(blocks, [at + 1, 0].concat(extra));
      keepHeadingIds(true);
      renderAll();
      scheduleReparse();
    }
  }

  function blockEl(b) {
    var wrap = document.createElement('div');
    wrap.className = 'cw-block';
    wrap.setAttribute('data-block-id', b.id);
    wrap.setAttribute('data-type', b.type);
    paint(wrap, b);
    return wrap;
  }

  function writerNoteHtml(b) {
    var md = MD(), out = '';
    try { out = md.blockToHtml(b, { showWriterNotes: true }) || ''; } catch (e) { out = ''; }
    if (out.replace(/<[^>]*>/g, '').trim()) return out;
    // An empty note (`%%%%`) shows its markers, so the writer sees what the caret reaches.
    return esc(String(b.source || '').replace(/%%/g, '').trim() || String(b.source || '').trim());
  }

  function focusedContents(wrap, b) {
    var stack = document.createElement('div');
    stack.className = 'cw-editor-stack';
    var mirror = document.createElement('div');
    mirror.className = 'cw-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    var edit = document.createElement('div');
    edit.className = 'cw-edit';
    edit.setAttribute('contenteditable', (opts && opts.readOnly) ? 'false' : 'true');
    edit.setAttribute('role', 'textbox');
    edit.setAttribute('aria-multiline', 'true');
    edit.setAttribute('aria-label', 'Writing block');
    // The visible text is the mirror; the host's own text is transparent, so a
    // spell underline would be drawn under characters nobody can see, and an
    // autocorrect would rewrite Markdown markers behind the writer's back.
    edit.setAttribute('autocorrect', 'off');
    edit.setAttribute('autocapitalize', 'off');
    edit.setAttribute('autocomplete', 'off');
    edit.setAttribute('data-enable-grammarly', 'false');
    edit.spellcheck = !!opts.spellcheck;
    // The host stays mounted. Its subtree is never rebuilt during composition.
    edit.innerHTML = editingHtml(liveHtml(b), b.source);
    edit.cwReferenceKey = JSON.stringify(doc.references || {});
    if (!edit.firstChild) edit.appendChild(document.createTextNode(''));
    stack.appendChild(mirror); stack.appendChild(edit); wrap.appendChild(stack);
    updateMirror(wrap, b);
  }

  function updateMirror(wrap, b) {
    var started = global.performance && performance.now ? performance.now() : Date.now();
    b.type = classify(b.source);
    wrap.setAttribute('data-type', b.type);
    var mirror = wrap.querySelector('.cw-mirror');
    if (mirror) {
      var html = liveHtml(b), host = wrap.querySelector('.cw-edit');
      // A reference definition's block is dimmed while it is written, too.
      var writerLine = /^<p class="cw-writer-line">/.test(html), marks = wrap.classList;
      if (marks && marks[writerLine ? 'add' : 'remove']) marks[writerLine ? 'add' : 'remove']('cw-writer-source');
      if (host && host.childNodes && !composing) {
        var next = document.createElement('div'); next.innerHTML = editingHtml(html, b.source);
        // A plain insertion only changes text. Keep WebKit's live nodes and IME
        // session; rebuild only after a formatting boundary changed.
        function structure(root) {
          return Array.prototype.map.call(root.childNodes, function shape(n) {
            return n.nodeType === 3 ? '#' : n.nodeName + ':' + (n.className || '') + ':' +
              (n.getAttribute('href') || '') + '[' + Array.prototype.map.call(n.childNodes, shape).join('') + ']';
          }).join('');
        }
        if (host.textContent !== b.source || structure(host) !== structure(next)) {
          var held = caretSource(); host.innerHTML = editingHtml(html, b.source);
          if (!host.firstChild) host.appendChild(document.createTextNode(''));
          if (held) setCaret(b.id, held.start, held.end, true);
        }
      }
      if (host) host.cwReferenceKey = JSON.stringify(doc.references || {});
      mirror.innerHTML = html;
      // Decorations belong to this paint, not the delayed document reparse.
      if (bus && bus.emit) bus.emit('editor:mirror', { blockId: b.id });
    }
    var took = (global.performance && performance.now ? performance.now() : Date.now()) - started;
    metrics.mirrors++;
    metrics.lastMirrorMs = took;
    metrics.maxMirrorMs = Math.max(metrics.maxMirrorMs, took);
  }

  function paint(wrap, b) {
    if (b.id === focusId) {
      wrap.innerHTML = '';
      wrap.classList.add('cw-focused');
      focusedContents(wrap, b);
    } else {
      wrap.classList.remove('cw-focused');
      var html = rendered[b.id] != null ? rendered[b.id] : MD().blockToHtml(b);
      var shown = writerOnly(b) && opts.showWriterNotes !== false && standsAsDefinition(b);
      markWriterSource(wrap, shown, shown && unusedDefinition(b));
      // Frontmatter and %%writer notes%% render as nothing for a reader. For a
      // WRITER they must still be visible and clickable, or a block exists in
      // the file that cannot be reached in the page. Show the source, dimmed.
      /* asked of what the block RENDERS, not of whether the string is empty: a
         `**[NAME: …]**` block renders `<strong></strong>`, which is a non-empty
         string and an empty paragraph on the page. */
      wrap.innerHTML = !writerOnly(b) ? html
        : (opts.showWriterNotes === false ? ''
          : shown ? '<p>' + esc(b.source) + '</p>'
          : '<div class="cw-writer-only">' + writerNoteHtml(b) + '</div>');
    }
    wrap.setAttribute('data-type', b.type);
    // A block painted afresh has lost every decoration others drew on it (comment
    // marks): say so, as the mirror does for the block being written.
    if (b.id !== focusId && wrap.isConnected && Castor.bus && Castor.bus.emit) Castor.bus.emit('editor:paint', { blockId: b.id });
  }

  function renderAll() {
    if (!page) return;
    var held = captureSelection();
    if (!focusId && !held) {
      // One HTML parse mounts every reading block; all blocks can accept typing immediately.
      page.innerHTML = blocks.filter(visible).map(function (b) {
        var html = rendered[b.id] != null ? rendered[b.id] : MD().blockToHtml(b);
        var shown = writerOnly(b) && opts.showWriterNotes !== false && standsAsDefinition(b);
        if (writerOnly(b)) html = opts.showWriterNotes === false ? ''
          : shown ? '<p>' + esc(b.source) + '</p>'
          : '<div class="cw-writer-only">' + writerNoteHtml(b) + '</div>';
        return '<div class="cw-block' + (shown ? ' cw-writer-source' + (unusedDefinition(b) ? ' cw-unused' : '') : '') + '" data-block-id="' + esc(b.id) + '" data-type="' + esc(b.type) + '">' + html + '</div>';
      }).join('');
      if (bus && bus.emit) bus.emit('editor:paint', {});
      return;
    }
    var frag = document.createDocumentFragment();
    blocks.forEach(function (b) { if (visible(b)) frag.appendChild(blockEl(b)); });
    page.innerHTML = '';
    page.appendChild(frag);
    if (held) applySelection(held);
    if (bus && bus.emit) bus.emit('editor:paint', {});
  }

  // The slot comes from the MODEL, so no caller can place an element where its
  // block is not.
  function insertBlockEl(b) {
    if (!page || !visible(b)) return;
    var el = blockEl(b), i = idx(b.id), ref = null;
    for (var k = i - 1; k >= 0; k--) { ref = elOf(blocks[k].id); if (ref) break; }
    if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref.nextSibling);
    else page.insertBefore(el, page.firstChild);
  }
  function removeBlockEl(id) {
    var el = elOf(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function repaint(id) {
    var b = blockOf(id);
    if (!b) return;
    if (!visible(b)) return;          // no element by design; nothing to repaint
    var el = elOf(id);
    if (!el) { renderAll(); return; } // the model gained a block: rebuild once
    paint(el, b);
  }

  /* The y of the visual line the caret is on, read from the live selection rather
     than from the painted caret, which may be mid-glide. */
  function liveCaretLineTop() {
    var sel = global.getSelection && global.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.height && !r.width && !r.top)) return null;
    return Math.round(r.top * 10) / 10;
  }

  function caretSource() {
    var r = frameReads.selection().range;
    if (!r || !focusId) return null;
    var el = editOf(focusId); if (!el) return null;
    var s = domOffset(el, r.startContainer, r.startOffset);
    var e = domOffset(el, r.endContainer, r.endOffset);
    if (s == null || e == null) { rememberNativeCaret(null); return null; }
    var c = { start: Math.min(s, e), end: Math.max(s, e) };
    rememberNativeCaret(c);
    return c;
  }
  function rememberNativeCaret(c) {
    var host = focusId && editOf(focusId), b = focusId && blockOf(focusId);
    // A late selectionchange after input describes the new DOM, not the old
    // range. Retain a pre-input range only while its exact source still agrees.
    if (!host || !b || host.textContent !== b.source) return;
    lastNativeCaret = c ? { blockId: focusId, source: b.source, start: c.start, end: c.end } : null;
  }

  function setCaret(id, start, end, keepTypingStyle) {
    var el = editOf(id); if (!el) return;
    if (!keepTypingStyle && typingStyles && (typingStyles.blockId !== id || typingStyles.at !== start || end != null && end !== start)) typingStyles = null;
    var b = blockOf(id); if (!b) return;
    start = clamp(start, 0, b.source.length);
    end = clamp(end == null ? start : end, 0, b.source.length);
    var sel = global.getSelection();
    var r = document.createRange();
    try {
      var single = textOf(el);
      var a = single ? { node: single, offset: start } : sourcePoint(el, start, true);
      var z = single ? { node: single, offset: end } : sourcePoint(el, end, start === end);
      r.setStart(a.node, a.offset);
      r.setEnd(z.node, z.offset);
    } catch (err) {
      r.selectNodeContents(el); r.collapse(false);
    }
    sel.removeAllRanges(); sel.addRange(r);
    frameReads.invalidateSelection();
    rememberNativeCaret({ start: Math.min(start, end), end: Math.max(start, end) });
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    requestOverlay(overlayMode);
  }

  function ensureOverlays() {
    if (!selectionLayer) {
      selectionLayer = document.createElement('div');
      selectionLayer.className = 'cw-selection-layer';
      selectionLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(selectionLayer);
    }
    if (!caretEl) {
      caretLayer = document.createElement('div');
      caretLayer.className = 'cw-caret-layer';
      caretLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(caretLayer);
      caretEl = document.createElement('div');
      caretEl.className = 'cw-caret';
      caretEl.setAttribute('aria-hidden', 'true');
      caretEl.hidden = true;
      caretLayer.appendChild(caretEl);
    }
    if (!handles) {
      handles = ['start', 'end'].map(function (which) {
        var h = document.createElement('div');
        h.className = 'cw-sel-handle';
        h.setAttribute('data-end', which);
        h.setAttribute('role', 'slider');
        h.setAttribute('aria-label', which === 'start' ? 'Selection start' : 'Selection end');
        h.hidden = true;
        h.addEventListener('pointerdown', function (e) { startHandleDrag(e, which); });
        caretLayer.appendChild(h);
        return h;
      });
    }
  }

  function clippedRect(rect, bounds) {
    var left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top);
    var right = Math.min(rect.right, bounds.right), bottom = Math.min(rect.bottom, bounds.bottom);
    return right > left && bottom > top ? { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top } : null;
  }
  // Article geometry includes text below the fold. Body-level overlays must
  // share its scrollport, including the area covered by a phone bottom sheet.
  function visibleOverlayBounds() {
    if (!page) return null;
    var scroll = page.closest('.page-scroll');
    var box = (scroll || page).getBoundingClientRect();
    var bounds = clippedRect(box, box);
    var vv = global.visualViewport;
    if (bounds && vv) bounds = clippedRect(bounds, {
      left: vv.offsetLeft, top: vv.offsetTop,
      right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height
    });
    if (bounds) {
      var exit = document.querySelector('.focus-exit:not([hidden])');
      var exitBox = exit && exit.getBoundingClientRect();
      if (exitBox && exitBox.height) bounds.top = Math.max(bounds.top, exitBox.bottom);
      document.querySelectorAll('#app[data-mode="phone"] .dock[data-open="1"]').forEach(function (dock) {
        bounds.bottom = Math.min(bounds.bottom, dock.getBoundingClientRect().top);
      });
      bounds.height = bounds.bottom - bounds.top;
    }
    return bounds && bounds.height > 0 ? bounds : null;
  }
  function clipOverlays(bounds) {
    var clip = bounds ? 'polygon(' + bounds.left + 'px ' + bounds.top + 'px,' +
      bounds.right + 'px ' + bounds.top + 'px,' + bounds.right + 'px ' + bounds.bottom + 'px,' +
      bounds.left + 'px ' + bounds.bottom + 'px)' : 'polygon(0px 0px,0px 0px,0px 0px)';
    [selectionLayer, caretLayer].forEach(function (layer) { layer.style.clipPath = clip; });
  }
  function mergeLineRects(rects) {
    var out = [];
    rects.sort(function (a, b) { return Math.abs(a.top - b.top) < 2 ? a.left - b.left : a.top - b.top; });
    rects.forEach(function (r) {
      var last = out[out.length - 1];
      if (last && Math.abs(last.top - r.top) < 2 && Math.abs(last.height - r.height) < 2 && r.left <= last.right + 2) {
        last.right = Math.max(last.right, r.right); last.width = last.right - last.left;
        last.bottom = Math.max(last.bottom, r.bottom); last.height = last.bottom - last.top;
      } else out.push(r);
    });
    return out;
  }
  function rectsBetween(host, a, b) {
    var nodes = sourceNodes(host), rects = [];
    nodes.forEach(function (n) {
      if (hiddenSource(n.node) || n.at >= b || n.at + n.len <= a) return;
      var r = document.createRange();
      try { r.setStart(n.node, Math.max(0, a - n.at)); r.setEnd(n.node, Math.min(n.len, b - n.at)); }
      catch (e) { return; }
      Array.prototype.forEach.call(r.getClientRects(), function (x) { if (x.height > 0 && x.width > 0) rects.push(x); });
    });
    return rects;
  }

  function caretGeometry(host, offset, forward) {
    if (!host) return null;
    var text = host;
    var style = frameReads.style(host);
    var lineHeight = parseFloat(style.lineHeight);
    if (!lineHeight) lineHeight = (parseFloat(style.fontSize) || 16) * 1.4;
    var data = host.textContent, len = data.length, rects, r;
    offset = clamp(offset, 0, len);
    var left = null, fontTop = null, fontHeight = null;

    if (forward && offset < len && data.charAt(offset) !== '\n') {
      rects = rectsBetween(text, offset, offset + 1);
      if (rects.length) { r = rects[0]; left = r.left; fontTop = r.top; fontHeight = r.height; }
    }
    if (left == null && offset > 0 && data.charAt(offset - 1) !== '\n') {
      rects = rectsBetween(text, offset - 1, offset);
      if (rects.length) { r = rects[rects.length - 1]; left = r.right; fontTop = r.top; fontHeight = r.height; }
    }
    if (left == null && offset < len && data.charAt(offset) !== '\n') {
      rects = rectsBetween(text, offset, offset + 1);
      if (rects.length) { r = rects[0]; left = r.left; fontTop = r.top; fontHeight = r.height; }
    }
    if (left == null && data.length && data.charAt(offset - 1) !== '\n') {
      for (var near = 1; near < data.length && left == null; near++) {
        var at = forward ? offset + near : offset - near;
        if (at < 0 || at >= data.length || data.charAt(at) === '\n') break;
        rects = rectsBetween(host, at, at + 1);
        if (rects.length) { r = rects[0]; left = forward ? r.left : r.right; fontTop = r.top; fontHeight = r.height; }
      }
    }
    if (left == null) {
      // an empty line: measure the last character that has a rect and step down
      // one line box for every newline crossed to reach the caret.
      var back = offset, crossed = 0;
      while (back > 0 && data.charAt(back - 1) === '\n') { back--; crossed++; }
      rects = back > 0 ? rectsBetween(text, back - 1, back) : [];
      var box = host.getBoundingClientRect();
      var padLeft = parseFloat(style.paddingLeft) || 0;
      var padTop = parseFloat(style.paddingTop) || 0;
      if (rects.length) {
        r = rects[rects.length - 1];
        fontHeight = r.height;
        fontTop = r.top + crossed * lineHeight;
      } else {
        fontHeight = parseFloat(style.fontSize) || lineHeight;
        fontTop = box.top + padTop + (lineHeight - fontHeight) / 2 + crossed * lineHeight;
      }
      left = box.left + padLeft;
    }
    var fill = parseFloat(style.getPropertyValue('--caret-fill'));
    if (!(fill > 0)) fill = 1;                       // the study: exactly 1lh
    return {
      left: left,
      lineTop: fontTop - (lineHeight - fontHeight) / 2,
      lineHeight: lineHeight,
      height: Math.min(lineHeight * fill, lineHeight),
      fontTop: fontTop,
      fontHeight: fontHeight
    };
  }

  function lineTopAt(host, off, forward) {
    var g = caretGeometry(host, off, forward);
    return g ? g.lineTop : null;
  }
  // The start is searched with the FORWARD reading: the first character of a
  // wrapped line sits at the offset that upstream still calls the end of the
  // line above, and taking the upstream answer left that character behind.
  function visualLineStart(host, off) {
    var here = lineTopAt(host, off, isForward(off)); if (here == null) return 0;
    var lo = 0, hi = off, mid, t;
    while (lo < hi) {
      mid = (lo + hi) >> 1;
      t = lineTopAt(host, mid, true);
      if (t != null && t >= here - 1) hi = mid; else lo = mid + 1;
    }
    return lo;
  }
  function visualLineEnd(host, off) {
    if (!host) return off;
    var len = host.textContent.length;
    var here = lineTopAt(host, off, isForward(off)); if (here == null) return len;
    var lo = off, hi = len, mid, t;
    while (lo < hi) {
      mid = (lo + hi + 1) >> 1;
      t = lineTopAt(host, mid);
      if (t != null && t <= here + 1) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  // The one caret position that must be painted at the START of its visual
  // line. Bound to the offset, so any other caret movement drops it with no
  // listener to forget and nothing to go stale.
  var forwardAt = null;
  function isForward(off) {
    return !!(forwardAt && forwardAt.blockId === focusId && forwardAt.offset === off);
  }
  // Which end of the selection the keyboard is moving. setCaret only knows
  // start and end, so a shifted line jump needs the live anchor to hold still.
  function selectionEnds(host) {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var a = domOffset(host, sel.anchorNode, sel.anchorOffset);
    var f = domOffset(host, sel.focusNode, sel.focusOffset);
    if (a == null || f == null) return null;
    return { anchor: a, focus: f };
  }

  // Geometry is read as one batch and only then painted. The overlays use
  // viewport coordinates because Range rects do; they never participate in the
  // page's layout and every selection rect is clipped back to the page.
  function selectedTextRects(range, bounds) {
    var root = range.commonAncestorContainer;
    if (!page.contains(root)) root = page;
    var walker = root.nodeType === 3 ? null : document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node = walker ? walker.nextNode() : root, rects = [];
    while (node) {
      var parent = node.parentElement;
      // A backwards drag crosses the display mirror preceding the native host.
      // Its element box and duplicate text are not part of the selected source.
      if (!(parent && parent.closest('.cw-mirror')) && node.data.length && range.intersectsNode(node)) {
        var start = range.startContainer === node ? range.startOffset : 0;
        var end = range.endContainer === node ? range.endOffset : node.data.length;
        if (end > start) {
          var textRange = document.createRange();
          textRange.setStart(node, start); textRange.setEnd(node, end);
          Array.prototype.forEach.call(textRange.getClientRects(), function (r) {
            var clipped = clippedRect(r, bounds); if (clipped) rects.push(clipped);
          });
        }
      }
      node = walker && walker.nextNode();
    }
    return rects;
  }

  function readOverlay() {
    var bounds = visibleOverlayBounds();
    var empty = { caret: null, selection: [], bounds: bounds };
    if (!bounds) return empty;
    var snapshot = frameReads.selection(), sel = snapshot.sel, range = snapshot.range;
    if (!range) return empty;
    try { if (!range.intersectsNode || !range.intersectsNode(page)) return empty; }
    catch (e) { return empty; }
    if (!sel.isCollapsed) {
      var rects = selectedTextRects(range, bounds);
      return { caret: null, selection: mergeLineRects(rects), bounds: bounds };
    }
    var host = focusId && editOf(focusId);
    if (!host || document.activeElement !== host || !host.contains(range.startContainer)) return empty;
    var off = domOffset(host, range.startContainer, range.startOffset);
    var g = off == null ? null : caretGeometry(host, off, isForward(off));
    if (!g) return empty;
    var caret = {
      left: g.left,
      top: g.lineTop + (g.lineHeight - g.height) / 2,
      height: g.height,
      lineTop: g.lineTop,
      lineHeight: g.lineHeight,
      host: host
    };
    return { caret: caret, selection: [], bounds: bounds };
  }

  function paintOverlay(state, mode) {
    ensureOverlays();
    clipOverlays(state.bounds);
    var selection = state.selection || [];
    while (selectionLayer.children.length < selection.length) {
      var node = document.createElement('i'); node.className = 'cw-selection-rect'; selectionLayer.appendChild(node);
    }
    Array.prototype.forEach.call(selectionLayer.children, function (node, i) {
      var r = selection[i];
      node.hidden = !r;
      if (node._castorMotion) { node._castorMotion.cancel(); node._castorMotion = null; }
      if (!r) { node._castorRect = null; return; }
      var old = node._castorRect;
      node.style.transform = 'translate3d(' + r.left + 'px,' + r.top + 'px,0)';
      node.style.width = r.width + 'px'; node.style.height = r.height + 'px';
      node.style.borderRadius = selection.length === 1 ? '4px'
        : (i === 0 ? '4px 4px 0 0' : (i === selection.length - 1 ? '0 0 4px 4px' : '0'));
      if (old && !pointerSelecting && mode === 'navigate' && node.animate && !(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        node._castorMotion = node.animate([
          { transform: 'translate3d(' + old.left + 'px,' + old.top + 'px,0) scale(' + old.width / r.width + ',' + old.height / r.height + ')' },
          { transform: node.style.transform + ' scale(1,1)' }
        ], { duration: 90, easing: 'cubic-bezier(.1,.8,.2,1)' });
      }
      node._castorRect = r;
    });
    paintHandles(selection);
    markFocusParagraph();
    paintTrail(state.caret);
    if (mode !== 'layout') typewriterLine(state.caret);
    caretEl.hidden = !state.caret || pointerSelecting || selection.length > 0;
    if (caretEl.hidden) {
      stopCaretGlide();
      caretVisual = lastCaret = null;
      return;
    }
    var c = state.caret;
    var docLeft = c.left + (global.scrollX || 0), docTop = c.top + (global.scrollY || 0);
    var moved = !lastCaret || Math.abs(docLeft - lastCaret.left) > .01 || Math.abs(docTop - lastCaret.top) > .01;
    var jump = !!lastCaret && (mode === 'navigate' || Math.abs(docTop - lastCaret.top) > 1 ||
      Math.abs(docLeft - lastCaret.left) > c.lineHeight * 4);
    caretEl.style.height = c.height + 'px';
    glideCaret(c, mode !== 'layout' && moved ? (jump ? CARET_JUMP_MS : CARET_TYPE_MS) : 0);
    lastCaret = { left: docLeft, top: docTop };
  }

  function stopCaretGlide() {
    if (caretRaf) cancelAnimationFrame(caretRaf);
    caretRaf = 0;
    caretMotion = null;
    caretEl.removeAttribute('data-moving');
  }
  function paintCaretPosition(left, top) {
    caretVisual = { left: left, top: top };
    caretEl.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';
  }
  function reducedCaretMotion() {
    return caretReducedMotion && caretReducedMotion.matches;
  }
  function glideCaret(c, duration) {
    if (!caretVisual || reducedCaretMotion()) {
      stopCaretGlide();
      paintCaretPosition(c.left, c.top);
      return;
    }
    // Overlay refreshes must not restart an in-flight trip to the same point.
    if (caretMotion && caretMotion.left === c.left && caretMotion.top === c.top) return;
    var now = global.performance.now();
    // Retarget from the last painted point, retaining the first trip's deadline.
    var deadline = caretMotion ? caretMotion.deadline : now + CARET_GLIDE_CAP_MS;
    duration = Math.min(duration, deadline - now);
    stopCaretGlide();
    if (duration <= 0 || (caretVisual.left === c.left && caretVisual.top === c.top)) {
      paintCaretPosition(c.left, c.top);
      return;
    }
    caretMotion = { fromLeft: caretVisual.left, fromTop: caretVisual.top,
      left: c.left, top: c.top, start: now, duration: duration, deadline: deadline };
    caretEl.setAttribute('data-moving', '1');
    caretRaf = requestAnimationFrame(animateCaret);
  }
  // Only the transform changes here. Geometry belongs to readOverlay, not this loop.
  function animateCaret(now) {
    caretRaf = 0;
    var m = caretMotion;
    if (!m) return;
    var t = reducedCaretMotion() ? 1 : Math.max(0, Math.min(1, (now - m.start) / m.duration));
    var ease = 1 - Math.pow(1 - t, 3);
    paintCaretPosition(m.fromLeft + (m.left - m.fromLeft) * ease, m.fromTop + (m.top - m.fromTop) * ease);
    if (t === 1) stopCaretGlide();
    else caretRaf = requestAnimationFrame(animateCaret);
  }

  // --- touch: real drag handles at both ends of a selection --------------------
  function coarsePointer() {
    return touchInput || !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  }
  var handleEdges = null;
  function paintHandles(selection) {
    if (!handles) return;
    var on = selection.length > 0 && coarsePointer();
    var first = selection[0], last = selection[selection.length - 1];
    handleEdges = on ? { start: { x: first.left, y: first.top + first.height / 2 }, end: { x: last.right, y: last.top + last.height / 2 } } : null;
    handles.forEach(function (h, i) {
      h.hidden = !on;
      if (!on) { h.style.pointerEvents = ''; return; }
      var r = i === 0 ? first : last;
      var x = i === 0 ? r.left : r.right;
      h.style.transform = 'translate3d(' + x + 'px,' + r.bottom + 'px,0)';
      h.style.setProperty('--handle-line', r.height + 'px');
    });
  }
  // iOS moves the selection itself once a finger is down on an end (the page then gets no moves)
  // and puts that end wherever the page's hit test under the finger lands: on a knob, that is outside
  // the article, so the range jumped to the article's end, or the whole paragraph while typing. Held,
  // the knobs leave hit testing; the moves of a drag run here still reach the captured knob.
  function holdHandles(on) {
    if (handles) handles.forEach(function (h) { h.style.pointerEvents = on ? 'none' : ''; });
  }
  function startHandleDrag(e, which) {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    holdHandles(true);
    var range = sel.getRangeAt(0).cloneRange();
    draggingHandle = { which: which, range: range };
    var node = e.currentTarget;
    // The knob hangs below the end it marks and sits under the finger. Read the text where
    // that end is, at the distance the finger grabbed it from, never under the knob itself:
    // a point on the knob is outside the article and would select to its end for a frame.
    var edge = handleEdges && handleEdges[which];
    var grab = edge ? { x: e.clientX - edge.x, y: e.clientY - edge.y } : { x: 0, y: 0 };
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    function move(ev) {
      var p = pointToPosition(ev.clientX - grab.x, ev.clientY - grab.y);
      if (!p || !page || !page.contains(p.node)) return;
      var holder = p.node.nodeType === 3 ? p.node.parentNode : p.node;
      if (holder && holder.closest && holder.closest('.cw-mirror')) return;
      var next = draggingHandle.range.cloneRange();
      try {
        if (which === 'start') next.setStart(p.node, p.offset);
        else next.setEnd(p.node, p.offset);
      } catch (err) { return; }
      if (next.collapsed) return;
      draggingHandle.range = next;
      sel.removeAllRanges(); sel.addRange(next);
      requestOverlay('navigate');
    }
    function up() {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      holdHandles(false);
      draggingHandle = null;
      onSelectionChange();
    }
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  var WORD_CHAR = /[\p{L}\p{N}_'’-]/u;
  function wordEdge(data, off, backwards) {
    var i = off;
    if (backwards) { while (i > 0 && WORD_CHAR.test(data.charAt(i - 1))) i--; }
    else { while (i < data.length && WORD_CHAR.test(data.charAt(i))) i++; }
    return i;
  }
  function offsetFromPoint(host, x, y) {
    if (!host) return null;
    var text = host, data = host.textContent, len = data.length;
    var approx = null, r = pointToCaret(x, y);
    if (r && host.contains(r.startContainer)) approx = domOffset(host, r.startContainer, r.startOffset);
    if (approx == null) approx = 0;
    var lo = Math.max(0, approx - 60), hi = Math.min(len, approx + 60);
    var cands = [], bestDy = Infinity, i, rects, rc;
    for (i = lo; i < hi; i++) {
      if (data.charAt(i) === '\n') continue;
      rects = rectsBetween(text, i, i + 1);
      if (!rects.length) continue;
      rc = rects[0];
      var dy = y < rc.top ? rc.top - y : (y > rc.bottom ? y - rc.bottom : 0);
      if (dy < bestDy) bestDy = dy;
      cands.push({ i: i, rect: rc, dy: dy });
    }
    var line = cands.filter(function (c) { return c.dy <= bestDy + .5; });
    if (!line.length) return approx;
    var bounds = line.map(function (c) { return { off: c.i, x: c.rect.left, w: c.rect.width }; });
    var tail = line[line.length - 1];
    bounds.push({ off: tail.i + 1, x: tail.rect.right, w: tail.rect.width });
    var pick = bounds[0], dx = Math.abs(x - bounds[0].x), d;
    for (i = 1; i < bounds.length; i++) {
      d = Math.abs(x - bounds[i].x);
      if (d < dx) { dx = d; pick = bounds[i]; }
    }
    return pick.off;
  }
  function pointToPosition(x, y) {
    var r = pointToCaret(x, y);
    if (!r) return null;
    var host = r.startContainer;
    if (host.nodeType === 3) host = host.parentNode;
    var edit = host && host.closest ? host.closest('.cw-edit') : null;
    if (edit) {
      var off = offsetFromPoint(edit, x, y);
      if (off != null) return sourcePoint(edit, off, true);
    }
    return { node: r.startContainer, offset: r.startOffset };
  }
  function placePreciseCaret(id, x, y) {
    var host = editOf(id);
    if (!host) return false;
    var off = offsetFromPoint(host, x, y);
    if (off == null) return false;
    setCaret(id, off);
    return true;
  }

  function blockTextOffset(el, node, offset) {
    var r = document.createRange();
    try { r.selectNodeContents(el); r.setEnd(node, offset); return r.toString().length; }
    catch (e) { return null; }
  }
  function positionAt(el, count) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), node, seen = 0;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (seen + len >= count) return { node: node, offset: count - seen };
      seen += len;
    }
    return { node: el, offset: el.childNodes.length };
  }
  function captureSelection() {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !page) return null;
    var r = sel.getRangeAt(0);
    var a = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
    var b = r.endContainer.nodeType === 3 ? r.endContainer.parentNode : r.endContainer;
    var ea = a && a.closest ? a.closest('.cw-block') : null;
    var eb = b && b.closest ? b.closest('.cw-block') : null;
    if (!ea || !eb || !page.contains(ea) || !page.contains(eb)) return null;
    var sa = blockTextOffset(ea, r.startContainer, r.startOffset);
    var sb = blockTextOffset(eb, r.endContainer, r.endOffset);
    if (sa == null || sb == null) return null;
    return { startId: ea.getAttribute('data-block-id'), start: sa, endId: eb.getAttribute('data-block-id'), end: sb };
  }
  function applySelection(saved) {
    if (!saved) return false;
    var ea = elOf(saved.startId), eb = elOf(saved.endId);
    if (!ea || !eb) return false;
    var pa = positionAt(ea, saved.start), pb = positionAt(eb, saved.end);
    var r = document.createRange();
    try { r.setStart(pa.node, pa.offset); r.setEnd(pb.node, pb.offset); }
    catch (e) { return false; }
    var sel = global.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    frameReads.invalidateSelection();
    return true;
  }

  // --- the paragraph focus shade and the typewriter line ----------------------
  function tokenOn(name) {
    if (!page) return false;
    var v = frameReads.style(page).getPropertyValue(name).trim().toLowerCase();
    return v === 'on' || v === '1' || v === 'true';
  }
  // Marked on the BLOCK, not repainted, so the dim transition is a CSS one that
  // never re-triggers while a writer types inside the same paragraph.
  function markFocusParagraph() {
    if (!page || !isArticle) return;
    var on = tokenOn('--focus-paragraph');
    var el = on && focusId ? elOf(focusId) : null;
    if (el !== lastFocusPara) {
      if (lastFocusPara) lastFocusPara.classList.remove('cw-lit');
      if (el) el.classList.add('cw-lit');
      lastFocusPara = el;
    }
    page.classList.toggle('cw-focus-paragraph', on);
  }
  var revealTimer = 0, revealPending = false, revealNotBefore = 0, focusScroll = null, tapCaretRaf = 0;
  function cancelCaretReveal() {
    if (tapCaretRaf) global.cancelAnimationFrame(tapCaretRaf);
    tapCaretRaf = 0;
    if (revealTimer) global.clearTimeout(revealTimer);
    revealTimer = 0; revealPending = false; revealNotBefore = 0; focusScroll = null;
  }
  function holdFocusScroll() {
    var scroll = page && page.closest && page.closest('.page-scroll');
    if (!scroll) return;
    focusScroll = { host: scroll, top: scroll.scrollTop, left: scroll.scrollLeft };
  }
  function undoFocusScroll() {
    var held = focusScroll;
    if (!held || held.host.scrollTop === held.top && held.host.scrollLeft === held.left) return;
    held.host.scrollTo({ top: held.top, left: held.left, behavior: 'instant' });
  }
  function revealCaret() {
    if (!page || !focusId) return;
    var host = editOf(focusId), c = caretSource();
    if (!host || !c) return;
    var scroll = page.closest && page.closest('.page-scroll');
    if (!scroll || !scroll.scrollBy) return;
    var g = caretGeometry(host, c.start, true);
    if (!g) return;
    var vv = global.visualViewport, box = scroll.getBoundingClientRect();
    var app = document.getElementById('app');
    var row = app && parseFloat(frameReads.style(app).getPropertyValue('--writing-row-bottom'));
    if (!row) {
      var topbar = document.querySelector('.topbar');
      row = topbar ? topbar.getBoundingClientRect().bottom : box.top;
    }
    var touch = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
    var keyboard = touch && vv && vv.height < global.innerHeight - 120;
    var top = Math.max(box.top, row) + (touch ? 16 : 0);
    var bottom = Math.min(box.bottom, vv ? vv.height + vv.offsetTop : global.innerHeight) - (keyboard ? 72 : touch ? 16 : 0);
    var delta = g.lineTop < top ? g.lineTop - top : g.lineTop + g.lineHeight > bottom ? g.lineTop + g.lineHeight - bottom : 0;
    if (Math.abs(delta) > 0.5) scroll.scrollBy({ top: delta, behavior: 'smooth' });
  }
  function requestCaretReveal(tap) {
    revealPending = true;
    if (tap && coarsePointer()) revealNotBefore = Date.now() + 460;
    if (revealTimer) global.clearTimeout(revealTimer);
    var vv = global.visualViewport;
    var opening = tap && coarsePointer() && vv && vv.height >= global.innerHeight - 120;
    // Keyboard geometry settles before the ONE visibility scroll. Resize events
    // renew this debounce only for the writer's outstanding tap/input intent.
    revealTimer = global.setTimeout(function () { revealTimer = 0; revealPending = false; undoFocusScroll(); focusScroll = null; revealCaret(); }, Math.max(80, revealNotBefore - Date.now()));
  }

  function scroller() {
    var el = page && page.parentNode;
    while (el && el !== document.body) {
      var style = frameReads.style(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentNode;
    }
    return global;
  }
  function typewriterLine(caret) {
    if (!isArticle || !caret || !tokenOn('--typewriter')) return;
    var host = scroller();
    var scrolled = host === global ? (global.scrollY || 0) : host.scrollTop;
    var mark = Math.round(caret.lineTop + scrolled) + ':' + Math.round(caret.left);
    if (mark === typewriterLast) return;
    typewriterLast = mark;
    if (Date.now() < typewriterOwnUntil) return;      // a scroll of ours is in flight
    var box = host === global
      ? { top: 0, height: global.innerHeight || document.documentElement.clientHeight }
      : (function () { var r = host.getBoundingClientRect(); return { top: r.top, height: r.height }; })();
    var hold = parseFloat(frameReads.style(page).getPropertyValue('--typewriter-hold')) || .4;
    var want = box.top + box.height * hold;
    var delta = caret.lineTop - want;
    if (Math.abs(delta) < 2) return;
    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var opts = { top: delta, left: 0, behavior: reduced ? 'auto' : 'smooth' };
    if (typewriterRaf) cancelAnimationFrame(typewriterRaf);
    typewriterRaf = requestAnimationFrame(function () {
      typewriterRaf = 0;
      typewriterOwnUntil = Date.now() + (reduced ? 60 : 700);
      if (host === global) global.scrollBy(opts); else host.scrollBy(opts);
    });
  }

  var trailSteps = 0, trailStyle = null, trailKeys = [];
  function trailAvailable() { return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function'; }
  function buildTrail() {
    if (!isArticle || !trailAvailable() || !page) return 0;
    var style = frameReads.style(page);
    var steps = Math.max(2, Math.min(120, parseInt(style.getPropertyValue('--trail-steps'), 10) || 40));
    var floor = parseFloat(style.getPropertyValue('--trail-floor'));
    if (!(floor >= 0 && floor <= 1)) floor = .55;
    if (steps === trailSteps && trailStyle) return steps;
    clearTrail();
    trailSteps = steps;
    trailKeys = [];
    var css = '';
    for (var i = 0; i < steps; i++) {
      // i = 0 is the furthest back and the faintest
      var strength = Math.max(floor, (i + 1) / steps);
      var key = 'castor-trail-' + i;
      trailKeys.push(key);
      css += '::highlight(' + key + '){color:color-mix(in srgb,var(--trail-ink,' +
        (style.getPropertyValue('--ink').trim() || 'currentColor') + ') ' + (strength * 100).toFixed(2) +
        '%,var(--trail-ground,' + (style.getPropertyValue('--paper').trim() || 'transparent') + '))}';
    }
    if (!trailStyle) {
      trailStyle = document.createElement('style');
      trailStyle.id = 'castor-trail';
      (document.head || document.documentElement).appendChild(trailStyle);
    }
    trailStyle.textContent = css;
    return steps;
  }
  function clearTrail() {
    if (!trailAvailable()) return;
    trailKeys.forEach(function (key) { CSS.highlights.delete(key); });
  }
  // The mirror is what a reader sees; the raw host's text is transparent. For a
  // multi-line block the mirror drops the newlines into element boundaries, so
  // the source offset is shifted by the newlines before it.
  function mirrorNodes(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), node, out = [], at = 0;
    while ((node = walker.nextNode())) { out.push({ node: node, at: at, len: node.nodeValue.length }); at += node.nodeValue.length; }
    return { nodes: out, length: at };
  }
  function rangeFor(list, from, to) {
    var r = document.createRange(), s = null, e = null;
    list.forEach(function (n) {
      if (s === null && from >= n.at && from <= n.at + n.len) s = { node: n.node, off: from - n.at };
      if (e === null && to >= n.at && to <= n.at + n.len && to > from) e = { node: n.node, off: to - n.at };
    });
    if (!s || !e) return null;
    try { r.setStart(s.node, s.off); r.setEnd(e.node, e.off); } catch (err) { return null; }
    return r;
  }
  function paintTrail(caret) {
    if (!trailAvailable()) return;
    var started = global.performance && performance.now ? performance.now() : Date.now();
    if (!caret || !tokenOn('--trail') || !focusId) { clearTrail(); return; }
    var wrap = elOf(focusId), b = blockOf(focusId);
    var mirror = wrap && wrap.querySelector('.cw-mirror');
    if (!mirror || !b) { clearTrail(); return; }
    var style = frameReads.style(page);
    var length = Math.max(4, parseInt(style.getPropertyValue('--trail-length'), 10) || 60);
    var quiet = Math.max(0, parseInt(style.getPropertyValue('--trail-quiet'), 10) || 20);
    var steps = buildTrail();
    var range = frameReads.selection().range;
    var host = editOf(focusId);
    var off = range ? domOffset(host, range.startContainer, range.startOffset) : null;
    if (off == null) { clearTrail(); return; }
    var before = b.source.slice(0, off), newlines = MULTILINE[b.type] ? (before.match(/\n/g) || []).length : 0;
    var end = Math.max(0, off - newlines - quiet);
    var start = Math.max(0, end - length + quiet);
    var list = mirrorNodes(mirror);
    end = Math.min(end, list.length);
    if (end - start < steps) start = Math.max(0, end - steps);
    var span = end - start;
    trailKeys.forEach(function (key, i) {
      var from = start + Math.floor(span * i / steps);
      var to = start + Math.floor(span * (i + 1) / steps);
      var r = span > 0 ? rangeFor(list.nodes, from, to) : null;
      if (r) CSS.highlights.set(key, new Highlight(r)); else CSS.highlights.delete(key);
    });
    var took = (global.performance && performance.now ? performance.now() : Date.now()) - started;
    metrics.trails++;
    metrics.lastTrailMs = took;
    metrics.maxTrailMs = Math.max(metrics.maxTrailMs, took);
  }

  var followRaf = 0, followUntil = 0, followDeadline = 0, followRect = null;
  function followLayout() {
    if (!page) return;
    var now = Date.now();
    followUntil = now + 400;               // the slide is 220ms; a webfont can land later
    followDeadline = now + 2000;           // and a world that animates forever never owns this loop
    if (followRaf) return;
    (function step() {
      followRaf = requestAnimationFrame(function () {
        followRaf = 0;
        if (!page) return;
        // The probe is a BLOCK, not the page: a dock that changes the page's
        // padding rather than its box moves every word without moving the
        // page's own rect by a pixel, and the loop would have watched the one
        // rectangle that did not move.
        var probe = page.querySelector('.cw-block') || page;
        var r = probe.getBoundingClientRect();
        var moved = !followRect || Math.abs(r.left - followRect.left) > .01 ||
          Math.abs(r.top - followRect.top) > .01 || Math.abs(r.width - followRect.width) > .01;
        followRect = { left: r.left, top: r.top, width: r.width };
        if (moved) {
          repositionSelMenu();             // the two words travel with their passage
          requestOverlay('layout');        // The text moved, so follow it without a glide.
        }
        if (Date.now() < Math.min(followUntil, followDeadline)) step();
      });
    })();
  }

  function requestOverlay(mode) {
    if (mode) overlayMode = mode;
    if (overlayRaf) return;
    overlayRaf = requestAnimationFrame(function () {
      overlayRaf = 0;
      var state = readOverlay();
      paintOverlay(state, overlayMode);
    });
  }
  function focusBlock(id, caretOffset) {
    var b = blockOf(id); if (!b || !visible(b)) return;
    if (focusId === id && editOf(id)) {
      overlayMode = 'navigate';
      var resume = caretOffset == null && keyboardCaret && keyboardCaret.blockId === id ? keyboardCaret : null;
      keyboardCaret = null;
      setCaret(id, resume ? resume.start : caretOffset == null ? b.source.length : caretOffset, resume ? resume.end : undefined);
      return;
    }
    if (focusId && focusId !== id) blurCurrent();
    focusId = id;
    everFocused = true;
    repaint(id);
    overlayMode = 'navigate';
    setCaret(id, caretOffset == null ? b.source.length : caretOffset);
    closePicker();
  }

  function blurCurrent() {
    if (!focusId) return;
    lastUndoKind = '';
    finishComposition();
    lastNativeCaret = null;
    nativeIntent = null;
    var b = blockOf(focusId);
    var was = focusId;
    focusId = null;
    if (b) {
      if (!b.source.trim() && blocks.length > 1 && b.type === 'p') {
        // an empty paragraph left behind by a split disappears on blur
        var i = idx(b.id);
        blocks.splice(i, 1);
        removeBlockEl(b.id);
        delete rendered[b.id];
        scheduleReparse();
        pending = []; literalRun = null;
        requestOverlay('snap');
        return;
      }
      refreshRendered(b);
      if (blocks.some(stranded)) scheduleReparse();
    }
    repaint(was);
    pending = []; literalRun = null;
    requestOverlay('snap');
  }

  function snapshot() {
    var c = caretSource();
    return {
      blocks: blocks.map(function (b) { return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.sepType, empty: b.empty }; }),
      focusId: focusId,
      caret: c ? c.start : null,
      selectionEnd: c ? c.end : null,
      literalRun: typeof literalRun !== 'undefined' && literalRun ? JSON.parse(JSON.stringify(literalRun)) : null,
      pending: typeof pending !== 'undefined' ? JSON.parse(JSON.stringify(pending)) : [],
      typingStyles: typeof typingStyles !== 'undefined' && typingStyles ? JSON.parse(JSON.stringify(typingStyles)) : null
    };
  }

  function historyState() {
    return { undo: !opts.readOnly && !composing && undoStack.length > 0, redo: !opts.readOnly && !composing && redoStack.length > 0 };
  }
  function emitHistory() {
    if (bus && bus.emit) bus.emit('editor:history', historyState());
  }

  // `kind` lets consecutive plain typing collapse into one undo step; anything
  // else (a split, a paste, a picker insertion) always starts a new one.
  function pushUndo(kind, beforeCaret) {
    var now = Date.now(), c = beforeCaret || caretSource();
    if (/^(type|delete|replace)$/.test(kind || '') && kind === lastUndoKind && focusId === lastUndoBlock && (now - lastUndoAt) < 700 && undoStack.length &&
        c && lastUndoCaret && c.start === lastUndoCaret.start && c.end === lastUndoCaret.end) {
      lastUndoAt = now; lastUndoCaret = null; return;
    }
    var saved = snapshot();
    if (beforeCaret) { saved.caret = beforeCaret.start; saved.selectionEnd = beforeCaret.end; }
    undoStack.push(saved);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastUndoAt = now; lastUndoKind = kind || ''; lastUndoBlock = focusId; lastUndoCaret = null;
    emitHistory();
  }

  function restore(s) {
    // Emptying the article can clamp its scrollport to zero before the rebuilt
    // content arrives. Keep the writer's current viewport as well as the caret.
    var scroll = page && page.closest && page.closest('.page-scroll') || scroller(), left = scroll === global ? global.scrollX || 0 : scroll.scrollLeft;
    var top = scroll === global ? global.scrollY || 0 : scroll.scrollTop;
    blocks = s.blocks.map(function (b) { return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.sepType, empty: b.empty }; });
    focusId = null;
    blocks.forEach(function (b) { refreshRendered(b); });
    focusId = s.focusId && idx(s.focusId) >= 0 ? s.focusId : null;
    keyboardCaret = null;
    if (typeof literalRun !== 'undefined') literalRun = s.literalRun ? JSON.parse(JSON.stringify(s.literalRun)) : null;
    if (typeof pending !== 'undefined') pending = s.pending ? JSON.parse(JSON.stringify(s.pending)) : [];
    typingStyles = s.typingStyles ? JSON.parse(JSON.stringify(s.typingStyles)) : null;
    cancelCaretReveal();
    renderAll();
    if (focusId) setCaret(focusId, s.caret == null ? 0 : s.caret, s.selectionEnd == null ? undefined : s.selectionEnd);
    changed(true);
    if (scroll === global) { if (global.scrollTo) global.scrollTo({ left: left, top: top, behavior: 'instant' }); }
    else { scroll.scrollLeft = left; scroll.scrollTop = top; }
    if (scroll !== global) focusScroll = { host: scroll, top: top, left: left };
    requestCaretReveal(false);
    requestOverlay('layout');
  }

  function undo() {
    if (opts.readOnly || !undoStack.length || composing) return;
    if (nativeIntent) editor.flush();
    frameReads.invalidateSelection();
    var here = snapshot();
    var s = undoStack.pop();
    redoStack.push(here);
    lastUndoKind = '';
    restore(s);
    emitHistory();
  }
  function redo() {
    if (opts.readOnly || !redoStack.length || composing) return;
    if (nativeIntent) editor.flush();
    frameReads.invalidateSelection();
    var here = snapshot();
    var s = redoStack.pop();
    undoStack.push(here);
    lastUndoKind = '';
    restore(s);
    emitHistory();
  }

  // Which blocks currently hold a live selection. Repainting one of those would
  // silently destroy the reader's selection (and orphan the floating menu that
  // is pointing at it), so the re-parse leaves them alone until it collapses.
  function selectedBlockIds() {
    var snapshot = frameReads.selection(), sel = snapshot.sel;
    if (!snapshot.range || sel.isCollapsed || !page) return {};
    var r = snapshot.range, held = {};
    var els = page.querySelectorAll('.cw-block');
    for (var i = 0; i < els.length; i++) {
      if (r.intersectsNode ? r.intersectsNode(els[i]) : false) held[els[i].getAttribute('data-block-id')] = 1;
    }
    return held;
  }

  function scheduleReparse() {
    if (reparseTimer) clearTimeout(reparseTimer);
    reparseTimer = setTimeout(function () {
      reparseTimer = null;
      var keep = focusId, held = selectedBlockIds(), before = {};
      blocks.forEach(function (b) { before[b.id] = { source: b.source, type: b.type, html: rendered[b.id] }; });
      var referencesBefore = JSON.stringify(doc.references || {});
      parseAll();
      joinStranded(keep, held);
      if (keep && referencesBefore !== JSON.stringify(doc.references || {}) && !composing) updateMirror(elOf(keep), blockOf(keep));
      // The focused text node is never touched. A block under a reader selection
      // also keeps the DOM to which the native Range points.
      blocks.forEach(function (b) {
        var old = before[b.id];
        if (b.id !== keep && !held[b.id] &&
            (!old || old.source !== b.source || old.type !== b.type || old.html !== rendered[b.id] || hintChanged(b))) repaint(b.id);
      });
      repositionSelMenu();
      requestOverlay('snap');
      emit();
    }, 160);
  }

  function hintChanged(b) {
    var list = elOf(b.id) && elOf(b.id).classList;
    return !!(list && list.contains && list.contains('cw-writer-source') && list.contains('cw-unused') !== unusedDefinition(b));
  }

  function repositionSelMenu() {
    if (!selMenu || selMenu.hidden) return;
    var snapshot = frameReads.selection();
    if (!snapshot.range || snapshot.sel.isCollapsed) { hideSelMenu(); return; }
    if (isArticle) showSelMenu(snapshot.range.getBoundingClientRect());   // a comment or a note has no Comment, Link or Ask menu
  }

  function changed(skipReparse) {
    if (focusId === lastUndoBlock) lastUndoCaret = caretSource();
    emitHistory();
    var headingsChanged = syncHeadings();
    var src = getSource();
    if (opts.onChange) { try { opts.onChange(src); } catch (e) { console.error(e); } }
    if (skipReparse || headingsChanged) emit();
    if (!skipReparse) scheduleReparse();
  }

  function emit() {
    syncHeadings();
    if (bus && bus.emit) bus.emit('doc:change', { source: getSource(), doc: doc });
  }

  function finishInput(started) {
    var took = (global.performance && performance.now ? performance.now() : Date.now()) - started;
    requestCaretReveal(false);
    metrics.inputs++;
    metrics.lastInputMs = took;
    metrics.maxInputMs = Math.max(metrics.maxInputMs, took);
  }

  function changedSpan(before, after, caret) {
    var start = 0;
    while (start < before.length && start < after.length && before.charAt(start) === after.charAt(start)) start++;
    var a = before.length, b = after.length;
    while (a > start && b > start && before.charAt(a - 1) === after.charAt(b - 1)) { a--; b--; }
    // With no native range, equal runs admit several identical splices. Keep
    // the smallest edit nearest the last observed caret, rather than its tail.
    if (caret != null) {
      var wanted = clamp(caret, 0, start);
      while (start > wanted && before.charAt(start - 1) === after.charAt(start - 1) &&
          before.charAt(a - 1) === after.charAt(b - 1)) { start--; a--; b--; }
    }
    return { start: start, end: a, insertedLength: b - start };
  }

  function syncNativeInput(intent, restoreOffset) {
    var host = focusId && editOf(focusId), b = focusId && blockOf(focusId);
    if (!host || !b) return;
    if (intent && intent.host && (intent.host !== host || intent.blockId !== b.id || intent.source !== b.source)) return;
    var raw = host.textContent.replace(/\r\n?/g, '\n');
    // contenteditable substitutes NBSP to paint a final/repeated ASCII space.
    // Reconcile only the browser's changed input, retaining authored NBSP.
    if (intent && intent.data && intent.data.includes(' ') && !intent.data.includes('\u00a0') && raw.includes('\u00a0')) {
      var nativeSpan = changedSpan(b.source, raw);
      var nativeEnd = nativeSpan.start + nativeSpan.insertedLength;
      var nativeText = raw.slice(nativeSpan.start, nativeEnd);
      if (nativeText.replace(/\u00a0/g, ' ') === intent.data) raw = raw.slice(0, nativeSpan.start) + intent.data + raw.slice(nativeEnd);
    }
    // A block shown as its source keeps its spaces: WebKit repaints the space beside a
    // deleted character as NBSP, which the writer never typed. That holds for the edit
    // that leaves a definition too, or retyping its colon would save the NBSP in its URL.
    if (raw.includes('\u00a0') && !(intent && (intent.data || intent.replacement || '').includes('\u00a0')) && typeof editedAsSource === 'function') {
      var paintedSpan = changedSpan(b.source, raw), paintedEnd = paintedSpan.start + paintedSpan.insertedLength;
      var spaced = raw.slice(0, paintedSpan.start) + raw.slice(paintedSpan.start, paintedEnd).replace(/\u00a0/g, ' ') + raw.slice(paintedEnd);
      if (spaced !== raw && (editedAsSource(b, spaced) || typeof standsAsDefinition === 'function' && standsAsDefinition(b))) raw = spaced;
    }
    var intendedEdit = intent && intent.selectionEdit;
    var intendedSource = intendedEdit && intent.data != null ? b.source.slice(0, intendedEdit.start) + intent.data + b.source.slice(intendedEdit.end) : null;
    if (raw === b.source && (intendedSource == null || intendedSource === b.source)) { if (restoreOffset != null) setCaret(b.id, restoreOffset); return; }
    var span;
    if (intent && intent.selectionEdit) {
      var edit = intent.selectionEdit;
      span = { start: edit.start, end: edit.end, insertedLength: raw.length - b.source.length + edit.end - edit.start };
    } else {
      var after = caretSource(), delta = raw.length - b.source.length;
      // input-only and direct native synchronization have no beforeinput. The
      // post-input Range identifies the end of the edit even in an equal run.
      var added = intent && intent.data != null ? intent.data.length : Math.max(0, delta);
      var at = after && after.start === after.end ? after.start - added : -1;
      var end = at + added - delta;
      if (at >= 0 && end >= at && end <= b.source.length &&
          raw === b.source.slice(0, at) + raw.slice(at, at + added) + b.source.slice(end)) {
        span = { start: at, end: end, insertedLength: added };
      } else span = changedSpan(b.source, raw, after ? Math.max(0, after.start - added) : typeof lastNativeCaret !== 'undefined' && lastNativeCaret && lastNativeCaret.start);
    }
    var inserted = raw.slice(span.start, span.start + span.insertedLength);
    var simpleSource = !/[\\`*_~=<>&[\]#|^%\r\n-]/.test(b.source + raw);
    var plain = (simpleSource && !/\s/.test(inserted) && !(intent && intent.pair && /[()[\]{}"]/.test(inserted)) || span.start === b.source.length && span.start === span.end && /[\p{L}\p{N}.,!?;:]$/u.test(b.source) && /^[\p{L}\p{N}]+$/u.test(inserted)) &&
      !(typeof literalRun !== 'undefined' && literalRun && literalRun.escapes.length) && !(typeof typingStyles !== 'undefined' && typingStyles);
    // Source synchronization callers have no InputEvent type. Native events,
    // including input-only mobile events, always opt into literal reconciliation.
    if (plain && (intendedSource == null || intendedSource === raw) || intent && intent.literal === false) {
      b.source = raw;
      adjustPending(b.id, span.start, span.end, span.insertedLength);
      b.type = classify(raw); updateMirror(elOf(b.id), b);
      if (restoreOffset != null) setCaret(b.id, restoreOffset);
      if (typeof literalRun !== 'undefined') literalRun = { blockId: b.id, source: raw, caret: span.start + inserted.length, escapes: [] };
      changed();
      if (intent && intent.data && intent.data.length === 1) afterInsert(b.id, intent.data);
      return;
    }
    if (intent && intent.selectionEdit) {
      var edit = intent.selectionEdit;
      var inserted = intent.data != null ? intent.data : span.insertedLength >= 0 ? raw.slice(edit.start, edit.start + span.insertedLength) : '';
      host.innerHTML = editingHtml(liveHtml(b), b.source);
      if (intent.pair) {
        setCaret(b.id, edit.start, edit.end);
        if (insertText(b.id, inserted, false)) return;
      }
      replaceVisible(b.id, edit.start, edit.end, inserted, false);
      return true;
    }
    // Native, replacement and IME mutations share the literal transaction.
    // Restore the pre-input source projection before reading its character model.
    host.innerHTML = editingHtml(liveHtml(b), b.source);
    replaceVisible(b.id, span.start, span.end, inserted, false);
    if (intent && intent.data && intent.data.length === 1) afterInsert(b.id, intent.data);
    else if (activePicker && activePicker.blockId === b.id) updatePicker();
  }

  function restoreSingleTextNode(host) {
    // Kept as the normalization boundary for input callers. Formatted source
    // runs belong to the renderer, and must never be flattened on each key.
    return null;
  }

  // Programmatic mutations (pairs, pickers, structural edits) splice the one
  // text node in place. Ordinary typing does not come through here: the browser
  // edits that node natively and onInput mirrors its resulting string.

  function applyEdit(id, start, end, text, caretAt) {
    if (opts && opts.readOnly) return;
    var b = blockOf(id); if (!b) return;
    start = clamp(start, 0, b.source.length);
    end = clamp(end, start, b.source.length);
    var nextSource = b.source.slice(0, start) + text + b.source.slice(end);
    // A visible transaction may serialize the entire block. Pending closers
    // belong to the actual changed span, not that serialization envelope.
    var mutation = start === 0 && end === b.source.length ? changedSpan(b.source, nextSource) : { start: start, end: end, insertedLength: text.length };
    // A shared escape prefix belongs to the changed character, not to an
    // unchanged pending closer whose backslash happens to match it.
    if (mutation.start > 0 && b.source.charAt(mutation.start - 1) === '\\') { mutation.start--; mutation.insertedLength++; }
    b.source = nextSource;
    adjustPending(id, mutation.start, mutation.end, mutation.insertedLength);
    b.type = classify(b.source);
    var host = editOf(id), node = textOf(host);
    if (node) node.data = b.source;
    var wrap = elOf(id);
    if (wrap && id === focusId) updateMirror(wrap, b);
    setCaret(id, caretAt == null ? start + text.length : caretAt);
    changed();
    if (activePicker && activePicker.blockId === id) updatePicker();
  }

  function adjustPending(id, start, end, insertedLength) {
    var delta = insertedLength - (end - start);
    pending = pending.filter(function (p) {
      if (p.blockId !== id) return true;
      if (p.index < start) return true;
      if (p.index < end) return false;
      p.index += delta;
      var b = blockOf(id);
      return !!b && (b.source.charAt(p.index) === p.ch || b.source.slice(p.index, p.index + 2) === '\\' + p.ch);
    });
  }

  function insertText(id, ch, history) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return false;
    // iPhone Smart Punctuation curls the quotes of a title typed in a definition, and the
    // site reads a title only between straight quotes: curled, the line would be prose.
    var straight = { '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'" }[ch];
    if (straight && typeof standsAsDefinition === 'function' && (standsAsDefinition(b) || standsAsDefinition(b, b.source.slice(0, c.start) + straight + b.source.slice(c.end)))) {
      replaceVisible(id, c.start, c.end, straight, history === false ? false : 'type'); return true;
    }

    // In a block written as source, every character is itself: no auto-close.
    if (typeof editedAsSource === 'function' && editedAsSource(b, b.source.slice(0, c.start) + ch + b.source.slice(c.end))) { replaceVisible(id, c.start, c.end, ch, history === false ? false : 'type'); return true; }
    // Style delimiters are literal writer input, never an implicit command.
    if (ch === '*' || ch === '_' || ch === '`') {
      replaceVisible(id, c.start, c.end, ch, history === false ? false : 'type'); return true;
    }

    var at = c.start, parts = interactionRuns(editOf(id));
    var visible = parts.filter(function (n) { return n.at + n.len > c.end; })[0];
    var next = visible && visible.atomic ? '\ufffc' : visible ? (visible.node.nodeValue == null ? visible.node.data || '' : visible.node.nodeValue).charAt(Math.max(0, c.end - visible.at)) : '';
    var hit = pending.find(function (p) { return p.blockId === id && p.index === at && p.ch === ch; });
    var decision = shouldAutoClose({ text: ch, next: next, pending: hit && hit.ch });
    if (c.start === c.end && decision.skip) {
      var closerSize = b.source.charAt(at) === '\\' ? 2 : 1;
      pending = pending.filter(function (p) { return p !== hit; });
      overlayMode = 'snap';
      if (typingStyles && typingStyles.blockId === id && typingStyles.at === at) { typingStyles.at = at + closerSize; typingStyles.run = null; }
      setCaret(id, at + closerSize);
      if (literalRun && literalRun.blockId === id && literalRun.source === b.source) literalRun.caret = at + closerSize;
      return true;
    }
    if (decision.insert.length > ch.length) {
      var closer = decision.insert.slice(-1), paired = replaceVisible(id, c.start, c.end, decision.insert, history === false ? false : 'pair');
      var closeAt = paired.caret - (b.source.slice(paired.caret - 2, paired.caret) === '\\' + closer ? 2 : 1);
      pending.push({ blockId: id, index: closeAt, ch: closer });
      setCaret(id, closeAt);
      if (literalRun && literalRun.blockId === id && literalRun.source === b.source) literalRun.caret = closeAt;
      return true;
    }
    if (c.end > c.start || typingStyles && typingStyles.blockId === id && typingStyles.at === at) {
      replaceVisible(id, c.start, c.end, ch, history === false ? false : 'type'); return true;
    }
    if (at === b.source.length && /\n$/.test(b.source)) {
      if (history !== false) pushUndo('type');
      applyEdit(id, at, at, ch, at + ch.length);
      afterInsert(id, ch);
      return true;
    }
    return false;
  }

  // Pure pairing specification, exported as Castor.editor.pairing. Input is
  // visible text, never Markdown source: text, next, pending (closer), previous
  // (opener), backspace. Output describes only the pair action; callers own
  // source offsets, pending lifetime, history and mutations. Apostrophes are
  // always literal. An opener pairs at block end, whitespace or closing
  // punctuation. A pending closer steps over; Backspace removes an empty
  // pending pair. All other input is literal, including pasted text.
  function shouldAutoClose(input) {
    var pairs = { '(': ')', '[': ']', '{': '}', '"': '"' };
    var ch = input.text || '';
    if (input.backspace) return { remove: !!input.pending && pairs[input.previous] === input.pending };
    if (input.pending === ch && input.next === ch) return { insert: '', skip: true };
    return { insert: ch + (pairs[ch] && (!input.next || /\s|[\p{Pe}\p{Pf}.,;:!?"']/u.test(input.next)) ? pairs[ch] : '') };
  }

  // Trigger detection runs after the character has landed in the source.
  function afterInsert(id, ch) {
    if (ch !== '/' && ch !== '@' && ch !== '^') return;
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    var at = c.start;
    if (ch === '/') {
      var lineStart = b.source.lastIndexOf('\n', at - 2) + 1;
      var lineEnd = b.source.indexOf('\n', at);
      if (at === lineStart + 1 && (lineEnd < 0 ? b.source.length : lineEnd) === at) openPicker('block', id, lineStart, 1);
      return;
    }
    if (ch === '@') { var pre = b.source.charAt(at - 2); if (!pre || /\s/.test(pre)) openPicker('mention', id, at - 1, 1); return; }
    if (ch === '^' && b.source.slice(at - 4, at) === '\\[\\^') { openPicker('footnote', id, at - 4, 4); return; }
    if (ch === '^' && b.source.charAt(at - 2) === '[') { openPicker('footnote', id, at - 2, 2); return; }
  }

  function splitBlock(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    pushUndo('split');
    var split = replaceVisible(id, c.start, c.end, { kind: 'split' }, 'project');
    if (b.type === 'code') { applyEdit(id, 0, b.source.length, split.source, split.caret); return; }
    var head = split.head, tail = split.tail;
    if (headingLevel(b.type) && c.start === c.end && (c.start === b.source.length || /^[ \t]+#+[ \t]*$/.test(b.source.slice(c.start)))) head = b.source;
    var i = idx(id);

    if (MULTILINE[b.type] && b.type !== 'table') {
      // inside a list or a quote, Enter continues the structure
      var lineStart = b.source.lastIndexOf('\n', Math.max(0, c.start - 1)) + 1;
      var line = b.source.slice(lineStart, c.start);
      var mlen = markerLen(line);
      var marker = line.slice(0, mlen);
      if (mlen && !line.slice(mlen).trim()) {
        // an empty item ends the structure and starts a paragraph after it
        b.source = b.source.slice(0, lineStart).replace(/\n$/, '');
        var fresh = { id: mintId(), type: 'p', source: tail.replace(/^\n/, '') };
        blocks.splice(i + 1, 0, fresh);
        var wasList = focusId;
        focusId = null;
        if (!b.source.trim()) { blocks.splice(idx(b.id), 1); removeBlockEl(b.id); delete rendered[b.id]; }
        else { refreshRendered(b); repaint(wasList); }
        insertBlockEl(fresh);
        focusBlock(fresh.id, 0); requestOverlay('snap'); changed();
        return;
      }
      var nextMarker = marker.replace(/(\d+)([.)])/, function (_, n, d) { return (+n + 1) + d; });
      applyEdit(id, 0, b.source.length, head + '\n' + nextMarker + tail, head.length + 1 + nextMarker.length);
      return;
    }

    b.source = head;
    b.type = classify(head);
    var nb = { id: mintId(), type: classify(tail), source: tail };
    if (split.lines) nb.sep = '\n';
    if (split.joint && split.joint.join('')) nb.joint = split.joint;
    blocks.splice(i + 1, 0, nb);
    refreshRendered(b);
    var wasSplit = focusId;
    focusId = null;
    repaint(wasSplit);
    insertBlockEl(nb);
    focusBlock(nb.id, 0);
    requestOverlay('snap');
    changed();
  }

  // Shift+Enter. A bare '\n' is Markdown's SOFT break: md.js renders it as a
  // space, so the break the writer just made disappears the moment the block
  // loses focus. Two trailing spaces are Markdown's line break and md.js gives
  // them a <br>, so what he sees is what the file keeps. A heading is one line
  // by definition, so there Shift+Enter is Enter.
  function softBreak(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    if (headingLevel(b.type)) { splitBlock(id); return; }
    pushUndo('break');
    var split = replaceVisible(id, c.start, c.end, { kind: 'split', soft: true }, 'project');
    applyEdit(id, 0, b.source.length, split.source, split.caret);
  }

  function mergeBack(id) {
    var i = idx(id); if (i <= 0) return false;
    var p = firstVisibleBefore(i); if (p < 0) return false;
    var b = blocks[i], prev = blocks[p];
    pushUndo('merge');
    var joint = b.joint || ['', ''], at = prev.source.length + joint[0].length;
    prev.source = prev.source + joint.join('') + b.source;
    prev.type = classify(prev.source);
    blocks.splice(i, 1);
    removeBlockEl(b.id);
    delete rendered[b.id];
    focusId = null;
    focusBlock(prev.id, at);
    requestOverlay('snap');
    changed();
    return true;
  }

  function pairedDelete(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c || c.end > c.start) return false;
    var auto = pending.find(function (p) { return p.blockId === id && p.index === c.start; });
    if (auto) {
      var closeSize = b.source.charAt(c.start) === '\\' ? 2 : 1;
      var previous = sourceNodes(editOf(id)).filter(function (n) { return !hiddenSource(n.node) && n.at < c.start; }).pop();
      var previousEnd = previous && Math.min(previous.at + previous.len, c.start);
      var opener = previous && previous.node.nodeValue.charAt(previousEnd - previous.at - 1);
      if (previous && previousEnd === c.start && shouldAutoClose({ backspace: true, previous: opener, pending: auto.ch }).remove) {
        var begin = c.start - 1;
        if (begin > 0 && b.source.charAt(begin - 1) === '\\') begin--;
        replaceVisible(id, begin, c.start + closeSize, ''); return true;
      }
    }
    for (var i = 0; i < PAIRED.length; i++) {
      var d = PAIRED[i];
      if (/^[([\{"']$/.test(d.open)) continue;
      if (emptyPairAt(b.source, c.start, d)) {
        pushUndo('delete');
        applyEdit(id, c.start - d.open.length, c.start + d.close.length, '', c.start - d.open.length);
        return true;
      }
    }
    return false;
  }

  function backspace(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    if (c.end > c.start) { pushUndo('delete'); applyEdit(id, c.start, c.end, ''); return; }
    if (c.start > 0) {
      pushUndo('delete');
      applyEdit(id, c.start - 1, c.start, '');
      return;
    }
    // at offset 0: first strip the block's own marker, only then merge
    var mlen = markerLen(b.source.split('\n')[0]);
    if (mlen) { pushUndo('unmark'); applyEdit(id, 0, mlen, '', 0); return; }
    mergeBack(id);
  }

  function forwardDelete(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    if (c.end > c.start) { pushUndo('delete'); applyEdit(id, c.start, c.end, ''); return; }
    if (c.start < b.source.length) { pushUndo('delete'); applyEdit(id, c.start, c.start + 1, ''); return; }
    var nx = firstVisibleAfter(idx(id));
    if (nx >= 0) { focusBlock(blocks[nx].id, 0); mergeBack(blocks[nx].id); }
  }

  function caretRect() {
    var range = frameReads.selection().range;
    if (!range) return null;
    var r = range.cloneRange();
    var rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height && !rect.top)) {
      var el = focusId && elOf(focusId);
      if (el) rect = el.getBoundingClientRect();
    }
    return rect;
  }
  function openPicker(kind, id, start, len, independent, end) {
    if (!Castor.commands || !Castor.commands.picker) return;
    if (!isArticle && kind !== 'mention') return;   // a field takes @names, not blocks, links or footnotes
    closePicker();
    var anchor = independent ? caretRect() : null;
    var handle = Castor.commands.picker(kind, {
      anchorRect: anchor,
      query: '',
      doc: doc,
      onPick: function (item) { applyPick(item); },
      onCancel: function () { closePicker(true); }
    });
    if (!handle) return;
    var label = independent && end > start ? interactionRuns(editOf(id)).map(function (n) {
      return n.node.nodeValue.slice(Math.max(0, start - n.at), Math.max(0, Math.min(n.len, end - n.at)));
    }).join('') : '';
    activePicker = { kind: kind, blockId: id, start: start, end: end == null ? start : end, label: label, source: blockOf(id).source, len: len, handle: handle, independent: !!independent };
    if (independent) {
      var input = document.createElement('input');
      input.className = 'cw-link-query';
      input.type = 'text';
      input.placeholder = 'Find a link';
      input.setAttribute('aria-label', 'Find a link');
      input.autocomplete = 'off';
      input.value = label;
      handle.el.insertBefore(input, handle.el.firstChild);
      input.addEventListener('input', function () { handle.update(input.value, anchor); });
      var dismiss = function (e) {
        if (!handle.el.contains(e.target)) {
          // A blank tap dismisses back into writing without losing the keyboard.
          // Explicit controls and a new writer position keep their own action.
          if (!e.target.closest || !e.target.closest('button,a,input,textarea,select,[contenteditable]')) e.preventDefault();
          closePicker(true);
        }
      };
      document.addEventListener('pointerdown', dismiss, true);
      activePicker.dismiss = dismiss;
      input.focus({ preventScroll: true });
      handle.update(label, anchor);
    } else updatePicker();
  }
  function updatePicker() {
    if (pickerRaf) return;
    pickerRaf = requestAnimationFrame(function () { pickerRaf = 0; updatePickerNow(); });
  }
  function updatePickerNow() {
    if (!activePicker || activePicker.independent) return;
    var b = blockOf(activePicker.blockId), c = caretSource();
    if (!b || !c || c.start < activePicker.start + activePicker.len) { closePicker(); return; }
    var q = b.source.slice(activePicker.start + activePicker.len, c.start);
    if (/\n/.test(q) || q.length > 80 || activePicker.kind === 'block' && q.charAt(0) === ' ') { closePicker(); return; }
    if (activePicker.kind === 'wiki') q = q.replace(/\]\]$/, '');
    activePicker.handle.update(q, caretRect());
  }
  function closePicker(restore) {
    var previous = activePicker;
    if (pickerRaf) { cancelAnimationFrame(pickerRaf); pickerRaf = 0; }
    if (activePicker && activePicker.dismiss) document.removeEventListener('pointerdown', activePicker.dismiss, true);
    if (activePicker && activePicker.handle) activePicker.handle.close();
    activePicker = null;
    if (restore && previous && previous.independent) {
      var block = blockOf(previous.blockId);
      if (block && block.source === previous.source) {
        focusBlock(previous.blockId, previous.start);
        setCaret(previous.blockId, previous.start, previous.end);
      }
    }
    requestOverlay('navigate');
  }
  function applyPick(item) {
    if (!activePicker || !item) { closePicker(); return; }
    var p = activePicker, b = blockOf(p.blockId), c = caretSource();
    if (p.dismiss) document.removeEventListener('pointerdown', p.dismiss, true);
    activePicker = null;
    if (!b || !c && !p.independent || p.independent && p.source != null && b.source !== p.source) {
      if (p.handle) p.handle.close();
      return;
    }
    var end = p.independent ? p.end : c.start;
    if ((p.kind === 'search' || p.kind === 'block') && typeof item.run === 'function') {
      pushUndo('search');
      applyEdit(p.blockId, p.start, end, '', p.start);
      if (p.handle) p.handle.close();
      try { item.run(); } catch (e) { console.error(e); }
      requestOverlay('navigate');
      return;
    }
    // the trigger's auto-close left brackets sitting after the caret; the chosen
    // insertion carries its own, so swallow them rather than doubling up.
    if (!p.independent && p.kind === 'wiki' && b.source.substr(end, 2) === ']]') end += 2;
    else if (p.kind === 'footnote' && p.len && b.source.charAt(end) === ']') end += 1;
    else if (p.kind === 'footnote' && p.len && b.source.substr(end, 2) === '\\]') end += 2;
    if (p.kind === 'footnote' || item.id === 'footnote') {
      if (p.handle) p.handle.close();
      insertFootnote(p.blockId, p.start, end);
      return;
    }
    var text = item.insert != null ? item.insert : (item.label || '');
    if (p.independent && p.label && /^\[\[[^]*\]\]$/.test(text)) {
      var target = text.slice(2, -2).split('|')[0];
      text = '[[' + target + (target === p.label ? '' : '|' + p.label) + ']]';
    }
    if (p.independent) {
      var wiki = /^\[\[([^]*?)\]\]$/.exec(item.insert || '');
      if (wiki) {
        replaceVisible(p.blockId, p.start, end, { kind: 'link', link: { wiki: true, target: wiki[1].split('|')[0] } }, 'pick');
        if (p.handle) p.handle.close();
        return;
      }
    }
    pushUndo('pick');
    var caretAt = p.start + text.length - (item.caretBack || 0);
    applyEdit(p.blockId, p.start, end, text, caretAt);
    if (p.handle) p.handle.close();
  }
  function ensureSelMenu() {
    if (!selMenu) {
      selMenu = document.createElement('div');
      document.body.appendChild(selMenu);
    }
    selMenu.textContent = '';
    // Two class names on purpose: `selection-menu` is engine.css's word for this
    // surface, `cw-selmenu` is ours and carries the functional fallback for a
    // page (like the dev harness) that never loads engine.css.
    selMenu.className = 'selection-menu cw-selmenu';
    selMenu.setAttribute('role', 'toolbar');
    selMenu.setAttribute('data-open', '0');
    selMenu.hidden = true;
    if (Castor.comments && Castor.comments.available && !Castor.comments.available()) {
      var hint = document.createElement('span');
      hint.textContent = 'Comments are available after moving this draft into the article.';
      selMenu.appendChild(hint);
      return selMenu;
    }
    ['Comment'].forEach(function (word) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = word;
      btn.setAttribute('data-command', 'comment');
      if (Castor.commands && Castor.commands.hint) Castor.commands.hint(btn, 'edit.comment');
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function () {
        var a = selAnchor;
        hideSelMenu();
        if (!a) return;
        if (word === 'Comment') {
          if (opts.onComment) opts.onComment(a);
          else if (Castor.comments && Castor.comments.add) Castor.comments.add(a, '');
          else if (bus && bus.emit) bus.emit('comment:new', a);
        } else {
          if (opts.onLink) opts.onLink(a);
          else linkSelection(a);
        }
      });
      selMenu.appendChild(btn);
    });
    return selMenu;
  }

  function linkSelection(a) {
    if (!a || !a.quote) return;
    var id = a.blockId, b = blockOf(id);
    if (!b) return;
    var at = -1;
    if (a.prefix) at = b.source.indexOf(a.prefix + a.quote);
    if (at >= 0) at += a.prefix.length; else at = b.source.indexOf(a.quote);
    if (at < 0) return;
    focusBlock(id, at);
    pushUndo('link');
    applyEdit(id, at, at + a.quote.length, '[[' + a.quote + ']]', at + 2 + a.quote.length);
    pending.push({ blockId: id, index: at + 2 + a.quote.length, ch: ']' });
    openPicker('wiki', id, at, 2);
    if (activePicker) activePicker.handle.update(a.quote, caretRect());
  }

  function showSelMenu(rect) {
    var m = ensureSelMenu();
    m.hidden = false;
    m.setAttribute('data-open', '1');
    var w = m.offsetWidth || 132, h = m.offsetHeight || 32;
    var left = clamp(rect.left + rect.width / 2 - w / 2, 8, (global.innerWidth || 1024) - w - 8);
    // above the selection by default; flipped below when it would clip the top
    var top = rect.top - h - 8;
    if (top < 24) top = rect.bottom + 8;
    m.style.left = Math.round(left) + 'px';
    m.style.top = Math.round(top) + 'px';
  }
  function hideSelMenu() { if (selMenu) { selMenu.hidden = true; selMenu.setAttribute('data-open', '0'); } }
  // A scroll or resize hides the menu where it stood; once the page is still it is back over the
  // words (N12): a long press iOS answers with a scroll still offers Comment.
  var menuReturn = 0;
  function menuAfterMove() {
    if (!menuReturn && (!selMenu || selMenu.hidden)) return;
    hideSelMenu();
    if (menuReturn) global.clearTimeout(menuReturn);
    menuReturn = global.setTimeout(function () {
      menuReturn = 0;
      var snapshot = frameReads.selection();
      if (isArticle && selAnchor && snapshot.range && !snapshot.sel.isCollapsed) showSelMenu(snapshot.range.getBoundingClientRect());
    }, 250);
  }


  // Build an anchor from the live selection. Offsets are located inside the
  // selected DOM layer using the native Range, preserving repeated occurrences
  // in both source-mode and rendered blocks.
  function anchorFromSelection(snapshot) {
    snapshot = snapshot || frameReads.selection();
    var sel = snapshot.sel, r = snapshot.range;
    if (!r || sel.isCollapsed) return null;
    var host = r.commonAncestorContainer;
    if (host.nodeType === 3) host = host.parentNode;
    var el = host && host.closest ? host.closest('.cw-block') : null;
    // A selection over paragraphs is one passage (S8); comments.js reads its parts.
    if (!el && isArticle && Castor.comments && Castor.comments.passageFromRange) return Castor.comments.passageFromRange(r, version);
    if (!el || !page.contains(el)) return null;
    var id = el.getAttribute('data-block-id');
    var b = (doc.blocks || []).filter(function (x) { return x.id === id; })[0] || blockOf(id);
    // While the words cannot be selected for a moment (ownSelection) the selection reads as none.
    var quote = sel.toString() || r.toString().trim();
    if (!quote.trim()) return null;
    var selectedHost = host.closest && host.closest('.cw-edit,.cw-mirror');
    var textNode = selectedHost && el.contains(selectedHost) ? selectedHost : el;
    if (!textNode.contains(r.startContainer) || !textNode.contains(r.endContainer)) return null;
    var text = textNode.textContent, at = blockTextOffset(textNode, r.startContainer, r.startOffset);
    // A long press on a line's first word, in its own element (a mark, bold, a link): WebKit starts
    // the range at the end of the line above, before the space the wrap hid; the words have none.
    var skip = at == null ? 0 : /^\s*/.exec(text.slice(at))[0].length;
    if (skip && text.slice(at, at + quote.length) !== quote && text.slice(at + skip, at + skip + quote.length) === quote) at += skip;
    if (at == null || text.slice(at, at + quote.length) !== quote) return null;
    var md = MD();
    if (b && text === b.text && md.makeAnchor) {
      try { return withBlock(md.makeAnchor(doc, id, at, at + quote.length, version), id); } catch (e) { /* fall through */ }
    }
    return withBlock({
      quote: quote,
      prefix: at >= 0 ? text.slice(Math.max(0, at - 32), at) : '',
      suffix: at >= 0 ? text.slice(at + quote.length, at + quote.length + 32) : '',
      blockText: text,
      version: version
    }, id);
  }
  function withBlock(a, id) { if (a && !a.blockId) a.blockId = id; return a; }

  var selectionChangeRaf = 0;
  function onSelectionChange() {
    if (!page) return;
    var nested = global.getSelection && global.getSelection();
    if (nested && nested.anchorNode && page.contains(nested.anchorNode) && foreign(nested.anchorNode)) {
      if (selAnchor) { selAnchor = null; if (opts.onSelect) opts.onSelect(null); }
      hideSelMenu(); requestOverlay();
      return;
    }
    frameReads.invalidateSelection();
    var sel = global.getSelection(), host = focusId && editOf(focusId);
    if (!composing && sel && sel.isCollapsed && host && host.contains(sel.anchorNode) && hiddenSource(sel.anchorNode)) {
      var off = domOffset(host, sel.anchorNode, sel.anchorOffset);
      var p = sourcePoint(host, off, true);
      if (p.node !== sel.anchorNode) setCaret(focusId, off);
    }
    var caret = caretSource();
    if (!composing && typeof typingStyles !== 'undefined' && typingStyles && host && sel && page.contains(sel.anchorNode) &&
        (!caret || caret.start !== caret.end || typingStyles.blockId !== focusId || typingStyles.at !== caret.start)) typingStyles = null;
    requestOverlay();
    if (selectionChangeRaf) return;
    selectionChangeRaf = requestAnimationFrame(function () { selectionChangeRaf = 0; syncSelectionChange(); });
  }
  function syncSelectionChange() {
    var snapshot = frameReads.selection(), sel = snapshot.sel;
    if (!snapshot.range || sel.isCollapsed) {
      if (selAnchor) { selAnchor = null; if (opts.onSelect) opts.onSelect(null); }
      hideSelMenu();
      return;
    }
    var a = anchorFromSelection(snapshot);
    if (!a) { hideSelMenu(); return; }
    selAnchor = a;
    if (isArticle) showSelMenu(snapshot.range.getBoundingClientRect());   // a comment or a note has no Comment, Link or Ask menu
    if (opts.onSelect) opts.onSelect(a);
    if (bus && bus.emit) bus.emit('select', a);
  }

  function pointToCaret(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      var r = document.createRange();
      r.setStart(p.offsetNode, p.offset); r.collapse(true);
      return r;
    }
    return null;
  }

  function onMouseDown(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    lastUndoKind = '';
    var el = e.target.closest ? e.target.closest('.cw-block') : null;
    pointerSelecting = false;
    pointerStartedInPage = !!el;
    pointerAnchor = null; pointerCrossed = false;
    overlayMode = 'navigate';
    if (!el) { if (focusId) blurCurrent(); return; }
    var id = el.getAttribute('data-block-id');
    if (id === focusId) return;               // native caret handling inside the raw host
    if (focusId) blurCurrent();               // so a drag can select across blocks
  }
  function tappedSourceOffset(el, x, y) {
    var r = pointToCaret(x, y);
    if (!r || !el.contains(r.startContainer)) return null;
    var edit = el.querySelector('.cw-edit');
    if (edit) return offsetFromPoint(edit, x, y);
    // Count reading characters at the finger BEFORE installing an edit surface.
    var reading = document.createRange();
    reading.selectNodeContents(el); reading.setEnd(r.startContainer, r.startOffset);
    var count = reading.toString().length;
    var b = blockOf(el.getAttribute('data-block-id')), temp = document.createElement('div');
    if (!b) return null;
    temp.innerHTML = liveHtml(b);
    var nodes = sourceNodes(temp), seen = 0;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], atom = n.node.parentElement && n.node.parentElement.closest('.cw-atom');
      if (atom) {
        var label = atom.getAttribute('data-label') || '';
        if (count <= seen + label.length) return n.at + (count > seen ? n.len : 0);
        seen += label.length; continue;
      }
      if (hiddenSource(n.node)) continue;
      if (seen + n.len >= count) return n.at + count - seen;
      seen += n.len;
    }
    return b.source.length;
  }
  function passageTap(e, touch) {
    if (e.target.closest && e.target.closest('.cw-subtitle,.footnote-ref,.cw-fnref')) return;
    if (opts && opts.readOnly) return;
    var el = e.target.closest ? e.target.closest('.cw-block') : null;
    if (!el) return;
    var ui = e.target.closest && e.target.closest('[data-castor-ui]');
    if (ui && el.contains(ui)) return;
    if (touch && !ui && Castor.comments && Castor.comments.tapPassage && Castor.comments.tapPassage(e)) return;
    var id = el.getAttribute('data-block-id');
    var off = tappedSourceOffset(el, e.clientX, e.clientY);
    // Empty padded cells have no reading character for the browser to hit.
    // Resolve their element boundary in the exact editable source projection.
    var cell = e.target.closest && e.target.closest('td,th'), paddedIndex = null;
    if (cell && el.contains(cell)) {
      var projection = el.querySelector('.cw-edit');
      if (!projection) {
        projection = document.createElement('div');
        projection.innerHTML = liveHtml(blockOf(id));
      }
      var cellIndex = Array.prototype.indexOf.call(el.querySelectorAll('td,th'), cell);
      var projectedCell = projection.querySelectorAll('td,th')[cellIndex];
      if (projectedCell && !projectedCell.childNodes.length) { off = domOffset(projection, projectedCell, 0); paddedIndex = cellIndex; }
    }
    if (off == null) return;
    if (e.preventDefault) e.preventDefault();
    holdFocusScroll();
    if (id !== focusId) focusBlock(id, off); else setCaret(id, off);
    if (paddedIndex != null) {
      var paddedCell = editOf(id).querySelectorAll('td,th')[paddedIndex];
      var paddedRange = document.createRange(), paddedSelection = global.getSelection();
      paddedRange.setStart(paddedCell, 0); paddedRange.setEnd(paddedCell, 0);
      paddedSelection.removeAllRanges(); paddedSelection.addRange(paddedRange);
      frameReads.invalidateSelection();
    }
    undoFocusScroll();
    requestOverlay('navigate');
    requestCaretReveal(true);
    // WebKit can replace the caret after touchend, including the first tap
    // before its keyboard opens. Leave an already correct native selection
    // alone: replacing it can interrupt iOS's keyboard-opening transaction.
    if (touch) {
      // Remember the browser's hit-test for this tap, not every later caret in
      // the block. A new selection is never evidence of native tap snapping.
      var host = editOf(id), native = pointToCaret(e.clientX, e.clientY);
      var snap = native && host && host.contains(native.startContainer) ? domOffset(host, native.startContainer, native.startOffset) : null;
      var token = { off: off, snap: snap, superseded: false };
      passageTap.selectionToken = token;
      if (!passageTap.watchSelection) {
        passageTap.watchSelection = function () {
          var pending = passageTap.selectionToken;
          if (!pending || !tapCaretRaf) return;
          var caret = caretSource();
          if (!caret || caret.start !== caret.end || caret.start !== pending.off && caret.start !== pending.snap) pending.superseded = true;
        };
        document.addEventListener('selectionchange', passageTap.watchSelection);
      }
      tapCaretRaf = global.requestAnimationFrame(function () {
        tapCaretRaf = 0;
        var caret = caretSource();
        if (passageTap.selectionToken !== token) return;
        passageTap.selectionToken = null;
        if (!token.superseded && focusId === id && snap != null && snap !== off && caret && caret.start === snap && caret.end === snap) setCaret(id, off);
      });
    }
  }
  function onClick(e) {
    if (touchInput && Date.now() < suppressClickUntil) return;
    var sel = global.getSelection();
    if (sel && !sel.isCollapsed) return;
    passageTap(e, touchInput);
  }
  function onTouchStart(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    cancelCaretReveal();
    lastUndoKind = '';
    touchInput = true;
    touchMoved = false;
    touchStart = e.touches && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    var sel = global.getSelection && global.getSelection();
    touchSelection = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
    touchCount++;
  }
  function onTouchMove(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!touchStart || !e.touches || !e.touches.length) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - touchStart.x) > 8 || Math.abs(t.clientY - touchStart.y) > 8) { touchMoved = true; cancelCaretReveal(); }
  }
  function onTouchEnd(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!page || !e.changedTouches || e.changedTouches.length !== 1) return;
    var sel = global.getSelection && global.getSelection();
    var selected = sel && sel.rangeCount && !sel.isCollapsed && sel.getRangeAt(0);
    // A long-press selection someone is about to comment on is never collapsed by its own touch.
    if (selected && page.contains(selected.startContainer) && page.contains(selected.endContainer)) {
      if (!sameRange(touchSelection, selected)) ownSelection(selected.cloneRange());   // this touch selected them
      return;
    }
    if (touchMoved) return;
    // Read only: a tap never opens a block for typing, the same rule as a click.
    if (opts && opts.readOnly) return;
    var t = e.changedTouches[0];
    suppressClickUntil = Date.now() + 700;
    passageTap({ target: e.target, clientX: t.clientX, clientY: t.clientY,
      preventDefault: function () {
        var vv = global.visualViewport;
        if (e.cancelable && (!vv || vv.height < global.innerHeight - 120)) e.preventDefault();
      } }, true);
  }

  // iOS draws its own handles and Copy menu over a selection it made, beside the page's own (N11),
  // and none over one the page set. In reading mode the page hands the same words back while they
  // cannot be selected for a moment; then they can be again, for the next long press. Typing keeps
  // iOS's: its handles edit the words. After the touch's own dispatch: made unselectable during it,
  // iOS ends its long press on words it can no longer select and drops them.
  function ownSelection(range) {
    var active = document.activeElement;
    if (ownSelection.busy || active && active.isContentEditable && active.contains(range.startContainer)) return;
    ownSelection.busy = true;
    var touch = touchCount;
    global.setTimeout(function () {
      var sel = global.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) { ownSelection.busy = false; return; }
      // WebKit can drop the words as they become unselectable, once or more: the page sets them again,
      // until the words can be selected again or a new touch begins.
      var hold = function () { if (touch === touchCount && (!sel.rangeCount || sel.isCollapsed)) { sel.removeAllRanges(); sel.addRange(range); } };
      page.setAttribute('data-own-selection', '');
      global.requestAnimationFrame(function () {
        sel.removeAllRanges(); sel.addRange(range);
        document.addEventListener('selectionchange', hold);
        global.setTimeout(function () {
          document.removeEventListener('selectionchange', hold);
          page.removeAttribute('data-own-selection'); ownSelection.busy = false;
          hold();
          // The menu and its anchor from the words as they now stand, selectable again.
          frameReads.invalidateSelection(); syncSelectionChange();
        }, 120);
      });
    }, 0);
  }
  function sameRange(a, b) {
    return !!a && !!b && a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer && a.endOffset === b.endOffset;
  }

  function onPointerMove(e) {
    if (e.buttons && page && (pointerStartedInPage || page.contains(e.target))) {
      pointerSelecting = true;
      var sel = global.getSelection && global.getSelection(), host = focusId && editOf(focusId);
      if (pointerStartedInPage && sel && host) {
        if (!pointerAnchor && host.contains(sel.anchorNode)) pointerAnchor = { node: sel.anchorNode, offset: sel.anchorOffset };
        var p = pointerAnchor && (pointerCrossed || !host.contains(e.target)) && pointToPosition(e.clientX, e.clientY);
        // Native mouse selection cannot leave a contenteditable host. Extend
        // the same Range ourselves; its raw Markdown anchor stays untouched.
        if (p && page.contains(p.node) && (pointerCrossed || !host.contains(p.node)) && (sel.setBaseAndExtent || sel.extend)) {
          if (e.preventDefault) e.preventDefault();
          if (sel.setBaseAndExtent) sel.setBaseAndExtent(pointerAnchor.node, pointerAnchor.offset, p.node, p.offset);
          else { sel.collapse(pointerAnchor.node, pointerAnchor.offset); sel.extend(p.node, p.offset); }
          pointerCrossed = true;
          frameReads.invalidateSelection();
        }
      }
      requestOverlay('navigate');
    }
  }
  function onPointerUp() {
    pointerSelecting = false;
    pointerStartedInPage = false;
    pointerAnchor = null; pointerCrossed = false;
    requestOverlay('navigate');
  }
  function onCopy(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!Castor.export || !Castor.export.selectionText || !e.clipboardData) return;
    if (e.target.closest && e.target.closest('input,textarea,select')) return;
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    if (!page.contains(range.startContainer) || !page.contains(range.endContainer)) return;
    var text = Castor.export.selectionText(range);
    e.preventDefault();
    try { e.clipboardData.setData('text/plain', text); }
    catch (err) { if (Castor.export.showFallback) Castor.export.showFallback(text); }
    if (Castor.export.selectionHtml) {
      try { e.clipboardData.setData('text/html', Castor.export.selectionHtml(range)); } catch (err) { /* Plain copy remains available. */ }
    }
  }
  function crossHostRange(host) {
    var r = frameReads.selection().range;
    return !!(r && page && page.contains(r.startContainer) && page.contains(r.endContainer) &&
      (!host.contains(r.startContainer) || !host.contains(r.endContainer)));
  }
  function retireNativeHost(host) {
    // End only the unsupported editing host. A preceding valid IME input may
    // be kept, but a later cross-host mutation must never reach finishComposition.
    finishComposition(true);
    if (host && host.blur) host.blur();
    blurCurrent();
  }
  function replaceVisible(id, start, end, inserted, history, surface, work) {
    // A writer note (%%...%%) is drawn as this span: its words are literal source.
    function writerNote(node) { return !!(node && /(?:^| )writer-note(?: |$)/.test(node.className || '')); }
    var host = surface || editOf(id), b = blockOf(id);
    if (!host || !b) return;
    if (!surface && typeof currentReferences === 'function') {
      var previousReferences = JSON.stringify(doc.references || {});
      currentReferences();
      if ((previousReferences !== JSON.stringify(doc.references || {}) || host.cwReferenceKey !== JSON.stringify(doc.references || {})) && !composing) updateMirror(elOf(id), b);
    }
    var source = b.source;
    // A terminal line break is trimmed by the block reader, so editingHtml
    // keeps that paragraph as raw source. Recover a lossless inline projection
    // before a multiline transaction captures its styles and break markers.
    if (b.type === 'p' && source.includes('\n') && host.textContent === source && !host.querySelector('.cw-mk')) {
      var multiline = document.createElement('div'), multilineContext = typeof doc !== 'undefined' && doc || {};
      multiline.innerHTML = MD().renderInline(source, { editSource: true, references: multilineContext.references, footnoteNumbers: new Map(Object.entries(multilineContext.footnoteNumbers || {})), footnotes: multilineContext.footnotes });
      if (multiline.textContent === source) host = multiline;
    }
    var nodes = sourceNodes(host);
    var action = inserted && typeof inserted === 'object' ? inserted : { kind: 'text', text: inserted || '' };
    // Markdown styling inside raw HTML is literal text on the published site.
    if (action.kind === 'style' && /^ {0,3}</.test(source) && MD().parse(source).blocks[0]?.meta.htmlBlock) return { source: source, caret: end, start: start, end: end };
    if (action.kind === 'style' && (b.type === 'quote' || b.type === 'callout')) {
      var styleBlocks = MD().parse(source).blocks.slice();
      while (styleBlocks.length) {
        var styleBlock = styleBlocks.pop();
        if (styleBlock.meta.htmlBlock) return { source: source, caret: end, start: start, end: end };
        if (styleBlock.meta.bodySource) styleBlocks = styleBlocks.concat(MD().parse(styleBlock.meta.bodySource).blocks);
      }
    }
    // Share deterministic search limits across projections. Count parser input,
    // not elapsed time: scheduling must never change the Markdown we save.
    work = work || { probes: 0, steps: 0, characters: 0,
      limit: Math.max(65536, 8 * (source.length + String(action.text || '').length + (host.cwSourcePrefix || '').length + (host.cwSourceSuffix || '').length)) };
    var continuing = typeof literalRun !== 'undefined' && literalRun && literalRun.blockId === id && literalRun.source === source && action.kind === 'text';
    var runEscapes = continuing ? literalRun.escapes.slice() : host.cwLiteralEscapes || [];
    continuing = continuing || !!host.cwLiteralContinuation;
    var runEscapeSet = new Set(runEscapes);
    var pendingBefore = typeof pending !== 'undefined' ? pending.filter(function (p) { return p.blockId === id; }).map(function (p) { return { blockId: p.blockId, index: p.index, ch: p.ch }; }) : [];
    var pendingFallback = null;
    if (pendingBefore.length && /^h[12]$/.test(b.type) && /\n {0,3}(?:=+|-+)[ \t]*$/.test(source)) {
      var pendingRuns = interactionRuns(host);
      function pendingPoint(at) { return pendingRuns.reduce(function (count, n) { return count + (n.atomic ? n.at + n.len <= at ? 1 : 0 : Math.max(0, Math.min(n.len, at - n.at))); }, 0); }
      pendingFallback = { from: pendingPoint(start), to: pendingPoint(end) };
      pendingBefore.forEach(function (p) { p.point = pendingPoint(p.index); });
    }
    function rememberLiteral(next, escapes) {
      if (history === 'project') return;
      // Serialization may move several escape prefixes at once. Pending pairs
      // follow their visible character, not the enclosing changed-source span.
      if (pendingBefore.length && (chars && typeof from === 'number' || pendingFallback) && typeof document !== 'undefined' && document.createElement) {
        var probe = document.createElement('div'), rawPoints = [];
        probe.innerHTML = MD().parse(next.source, { editSource: true }).blocks.map(function (b) { return b.html; }).join('');
        var escapeEnds = new Set(); sourceNodes(probe).forEach(function (n) { if (hiddenSource(n.node) && n.node.nodeValue === '\\') escapeEnds.add(n.at + n.len); });
        interactionRuns(probe).forEach(function (n) {
          if (n.atomic) rawPoints.push(n.at);
          else for (var i = 0; i < n.len; i++) {
            var at = n.at + i;
            if (!i && next.source.charAt(at - 1) === '\\' && escapeEnds.has(at)) at--;
            rawPoints.push(at);
          }
        });
        var restored = [];
        pendingBefore.forEach(function (p) {
          var point = chars ? characterOffset(p.index) : p.point;
          var editFrom = chars ? from : pendingFallback.from, editTo = chars ? to : pendingFallback.to;
          if (action.kind === 'text') {
            if (point >= editFrom && point < editTo) return;
            if (point >= editTo) point += String(action.text || '').length - (editTo - editFrom);
          }
          var at = rawPoints[point];
          if (at != null && (next.source.charAt(at) === p.ch || next.source.slice(at, at + 2) === '\\' + p.ch)) restored.push({ blockId: id, index: at, ch: p.ch });
        });
        pending = pending.filter(function (p) { return p.blockId !== id; }).concat(restored);
      }
      literalRun = action.kind === 'text' ? { blockId: id, source: next.source, caret: next.caret, escapes: (escapes || []).slice() } : null;
    }
    function rawHTML(value) {
      return value.match(/(?<!\\)(?:\\\\)*(?:<!--(?:>|->|[^]*?-->)|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<![A-Za-z][^>]*>|<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n][^<>]*?)?\/?>)/g) || [];
    }

    if (/^#{1,6}[ \t]+$/.test(source) && start === source.length && end === start && action.kind === 'text' && action.text && typeof document !== 'undefined' && document.createElement) {
      var blankProbe = document.createElement('div'), blankType = b.type, savedTyping = typeof typingStyles !== 'undefined' ? typingStyles : null, bodyEdit, bodyTyping;
      blankProbe.cwSourcePrefix = source; blankProbe.cwHeading = true;
      try {
        b.source = ''; b.type = 'inline';
        if (savedTyping && savedTyping.blockId === id && savedTyping.at === start) typingStyles = { blockId: id, at: 0, styles: savedTyping.styles.slice(), run: savedTyping.run };
        bodyEdit = replaceVisible(id, 0, 0, action, 'project', blankProbe, work); bodyTyping = typeof typingStyles !== 'undefined' && typingStyles;
      } finally { b.source = source; b.type = blankType; if (typeof typingStyles !== 'undefined') typingStyles = savedTyping; }
      if (bodyEdit) {
        bodyEdit.source = source + bodyEdit.source; bodyEdit.caret += source.length; bodyEdit.escapes = (bodyEdit.escapes || []).map(function (at) { return at + source.length; });
        if (bodyEdit.start != null) bodyEdit.start += source.length;
        if (bodyEdit.end != null) bodyEdit.end += source.length;
        if (history === 'project') return bodyEdit;
        if (history !== false) pushUndo(history || 'replace');
        if (savedTyping && bodyTyping && savedTyping.blockId === id && savedTyping.at === start) { savedTyping.at = bodyEdit.caret; savedTyping.run = bodyTyping.run; }
        applyEdit(id, 0, source.length, bodyEdit.source, bodyEdit.caret); rememberLiteral(bodyEdit, bodyEdit.escapes); return bodyEdit;
      }
    }
    // A setext underline is a heading's hidden closing marker. Edit its text
    // through the same inline transaction, retaining the authored underline.
    var setext = /^h[12]$/.test(b.type) && /\n {0,3}(?:=+|-+)[ \t]*$/.exec(source);
    if (setext && (action.kind === 'text' || action.kind === 'style') && typeof document !== 'undefined' && document.createElement) {
      var headingBody = source.slice(0, setext.index), headingProbe = document.createElement('div');
      headingProbe.innerHTML = MD().renderInline(headingBody, { editSource: true });
      headingProbe.cwSourceSuffix = setext[0]; headingProbe.cwLiteralEscapes = runEscapes; headingProbe.cwLiteralContinuation = continuing;
      var headingType = b.type, headingEdit;
      try {
        b.source = headingBody; b.type = 'p';
        headingEdit = replaceVisible(id, Math.min(start, headingBody.length), Math.min(end, headingBody.length), action, 'project', headingProbe, work);
      } finally { b.source = source; b.type = headingType; }
      if (headingEdit) {
        if (headingEdit.source) headingEdit.source += setext[0];
        if (history === 'project') return headingEdit;
        if (history !== false) pushUndo(history || 'replace');
        if (typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start) { typingStyles.at = headingEdit.caret; typingStyles.run = headingEdit.typingRun; }
        applyEdit(id, 0, source.length, headingEdit.source, headingEdit.caret); rememberLiteral(headingEdit, headingEdit.escapes);
        if (action.kind === 'style') setCaret(id, headingEdit.start, headingEdit.end);
        return headingEdit;
      }
    }
    // A fenced block has one body. Its fences and info string are structural,
    // never inline Markdown and never candidates for a paragraph split. A block
    // of reference definitions is written as source too (editedAsSource).
    var asSource = !surface && (action.kind === 'text' || action.kind === 'split') && typeof editedAsSource === 'function' &&
      (action.kind === 'text' ? editedAsSource(b, source.slice(0, start) + (action.text || '') + source.slice(end))
        : editedAsSource(b, source.slice(0, start)) && (!source.slice(end).trim() || definitionSource(source.slice(end))));
    // An edit that turns every definition of the block into prose removes their labels.
    // Escape the paragraph against the references the page will have, so `[r]` is not
    // escaped against the very definition this edit takes away.
    var after = action.kind === 'text' && source.slice(0, start) + (action.text || '') + source.slice(end);
    if (!asSource && !surface && after !== false && typeof standsAsDefinition === 'function' && standsAsDefinition(b) &&
        !MD().parse(after).blocks.some(function (x) { return x.type === 'reference-def'; })) {
      var leftBehind = '';
      for (var li = 0; li < blocks.length; li++) {
        var other = blocks[li], otherSource = other.id === b.id ? after : other.source;
        if (other.empty && !otherSource) continue;
        leftBehind += (typeof other.sep === 'string' ? other.sep : (li === 0 ? '' : '\n\n')) + otherSource;
      }
      try { doc.references = MD().parse(leftBehind + tail).references || {}; } catch (e) { /* keep the page's */ }
    }
    if (asSource || b.type === 'code' || b.type === 'frontmatter' || b.type === 'table' || /^ {0,3}</.test(source) && MD().parse(source).blocks[0]?.meta.htmlBlock) {
      if (action.kind !== 'text' && action.kind !== 'split') {
        if (b.type === 'table' && action.kind === 'style' && end > start) {
          // Project just one cell through the ordinary inline transaction.
          // Delimiters, clipped fields and cross-cell selections stay raw.
          var lineStart = source.lastIndexOf('\n', start - 1) + 1, lineEnd = source.indexOf('\n', start);
          if (lineEnd < 0) lineEnd = source.length;
          var edges = [lineStart - 1];
          for (var at = lineStart; at < lineEnd; at++) {
            if (source.charAt(at) === '\\') { at++; continue; }
            if (source.charAt(at) === '|') edges.push(at);
          }
          edges.push(lineEnd);
          for (var cell = 1; cell < edges.length; cell++) {
            var left = edges[cell - 1] + 1, right = edges[cell];
            while (left < right && /[ \t]/.test(source.charAt(left))) left++;
            while (right > left && /[ \t]/.test(source.charAt(right - 1))) right--;
            if (start < left || end > right) continue;
            var cellSource = source.slice(left, right), cellProbe = document.createElement('div'), tableType = b.type, cellEdit;
            // The site and app have different delimiter resolution for dense
            // authored runs and nested strike. Keep those cells unchanged
            // rather than turn literal delimiters into different visible text.
            if (/[*_~]/.test(cellSource) && !/^(\*\*|\*|__|_)[^*_~]+\1$/.test(cellSource)) break;
            cellProbe.innerHTML = MD().renderInline(cellSource, { editSource: true, tableCell: true, references: typeof doc !== 'undefined' && doc && doc.references });
            try {
              b.source = cellSource; b.type = 'inline';
              cellEdit = replaceVisible(id, start - left, end - left, action, 'project', cellProbe, work);
            } finally { b.source = source; b.type = tableType; }
            if (!cellEdit) break;
            // Inline serialization does not own GFM row delimiters. Escape any
            // newly literal pipe, retaining source selection positions as it grows.
            var tableCell = '', tableShift = [];
            for (var ci = 0; ci < cellEdit.source.length; ci++) {
              if (cellEdit.source.charAt(ci) === '|') {
                var slashes = 0;
                for (var si = ci - 1; si >= 0 && cellEdit.source.charAt(si) === '\\'; si--) slashes++;
                if (!(slashes % 2)) { tableCell += '\\'; tableShift.push(ci); }
              }
              tableCell += cellEdit.source.charAt(ci);
            }
            // Table escaping also applies inside code. Validate visible cell
            // text after that final spelling, rather than guessing from slash
            // parity; a style may safely refuse an unrepresentable projection.
            var beforeCell = document.createElement('div'), afterCell = document.createElement('div');
            beforeCell.innerHTML = MD().renderInline(cellSource, { tableCell: true, references: typeof doc !== 'undefined' && doc && doc.references });
            afterCell.innerHTML = MD().renderInline(tableCell, { tableCell: true, references: typeof doc !== 'undefined' && doc && doc.references });
            if (beforeCell.textContent !== afterCell.textContent) break;
            ['caret', 'start', 'end'].forEach(function (key) {
              cellEdit[key] += tableShift.filter(function (at) { return at < cellEdit[key]; }).length;
            });
            cellEdit.source = source.slice(0, left) + tableCell + source.slice(right);
            cellEdit.caret += left; cellEdit.start += left; cellEdit.end += left;
            if (history === 'project') return cellEdit;
            if (history !== false) pushUndo(history || 'replace');
            applyEdit(id, 0, source.length, cellEdit.source, cellEdit.caret);
            setCaret(id, cellEdit.start, cellEdit.end);
            return cellEdit;
          }
        }
        return { source: source, caret: end, start: start, end: end };
      }
      var rawText = action.kind === 'split' ? '\n' : action.text || '';
      if (b.type === 'code') {
        var firstBreak = source.indexOf('\n'), indentedCode = /^(?: {4}| {0,3}\t)/.test(source);
        var closing = !indentedCode && /\n[ \t]*(?:`{3,}|~{3,})[ \t]*$/.exec(source);
        var bodyStart = indentedCode ? (/^(?: {4}| {0,3}\t)/.exec(source) || [''])[0].length : firstBreak < 0 ? source.length : firstBreak + 1;
        var bodyEnd = closing ? closing.index : source.length;
        start = clamp(start, bodyStart, bodyEnd); end = clamp(end, start, bodyEnd);
        if (indentedCode) rawText = rawText.replace(/\n/g, '\n    ');
        else if (firstBreak < 0 && rawText) rawText = '\n' + rawText;
      }
      if (b.type === 'table') {
        // Padded cells share a byte boundary until the first edit. The native
        // cell carries the missing delimiters, materialized only by that edit.
        if (start === end && rawText) {
          var padRange = frameReads.selection().range, padNode = padRange && padRange.startContainer;
          var padCell = padNode && (padNode.nodeType === 1 ? padNode : padNode.parentElement);
          padCell = padCell && padCell.closest && padCell.closest('[data-cw-table-pad]');
          if (padCell && host.contains(padCell) && domOffset(host, padRange.startContainer, padRange.startOffset) === start) {
            var padCount = +padCell.getAttribute('data-cw-table-pad') || 0;
            source = source.slice(0, start) + '|'.repeat(padCount) + source.slice(start);
            start += padCount; end += padCount;
          }
        }
        rawText = rawText.replace(/[\\`*_\[\]()~<>#|=^%&]/g, '\\$&').replace(/\n/g, '<br>');
        if (/^[ \t]/.test(rawText) && /^[ \t]*$/.test(source.slice(source.lastIndexOf('|', start - 1) + 1, start))) {
          var cellSpaces = /^[ \t]+/.exec(rawText)[0];
          rawText = '<span style="white-space:pre">' + cellSpaces + '</span>' + rawText.slice(cellSpaces.length);
        }
        rawText = rawText.replace(/ +$/, function (spaces) { return '&#32;'.repeat(spaces.length); });
      }
      var raw = { source: source.slice(0, start) + rawText + source.slice(end), caret: start + rawText.length };
      if (b.type === 'code') {
        var fence = /^( {0,3})(`{3,}|~{3,})/.exec(source), body = raw.source.slice(bodyStart, bodyEnd + raw.source.length - source.length);
        if (fence && closing) {
          var size = fence[2].length;
          body.split('\n').forEach(function (line) { var run = new RegExp('^ {0,3}(' + fence[2][0] + '+)[ \t]*$').exec(line); if (run) size = Math.max(size, run[1].length + 1); });
          if (size > fence[2].length) {
            var delta = size - fence[2].length, marker = fence[2][0].repeat(size);
            raw.source = raw.source.replace(/^( {0,3})(`{3,}|~{3,})/, '$1' + marker).replace(/\n([ \t]*)(?:`{3,}|~{3,})[ \t]*$/, '\n$1' + marker);
            raw.caret += delta;
          }
        }
      }

      // Two definitions parted by Enter stay a group: one line break, as before Backspace joined them.
      if (action.kind === 'split' && !action.soft && b.type !== 'code') return { head: source.slice(0, start), tail: source.slice(end), prefix: '', lines: asSource && definitionSource(source.slice(end)) };
      if (history === 'project' || action.kind === 'split') return raw;
      if (history !== false) pushUndo(history || 'replace');
      applyEdit(id, 0, source.length, raw.source, raw.caret);
      return raw;
    }
    // Capture characters and semantic owners, not delimiters. Source offsets are
    // used only at this boundary; all editing below is on the visible sequence.
    var chars = [], membersByOwner = new Map(), ownersByNode = new Map(), escapedEnds = new Set();
    nodes.forEach(function (n) {
      if (hiddenSource(n.node) && n.node.nodeValue === '\\') escapedEnds.add(n.at + n.len);
      for (var parent = n.node.parentElement; parent && parent !== host; parent = parent.parentElement) {
        if (!membersByOwner.has(parent)) membersByOwner.set(parent, []);
        membersByOwner.get(parent).push(n);
      }
    });
    function ownedNodes(node) { return membersByOwner.get(node) || []; }
    nodes.forEach(function (n) {
      var parent = n.node.parentElement, atom = parent && parent.closest('.cw-atom');
      if (atom) {
        if (chars.some(function (c) { return c.atom === atom; })) return;
        var members = ownedNodes(atom);
        var first = members[0], last = members[members.length - 1];
        var atomLink = atom.parentElement && atom.parentElement.closest('a');
        chars.push({ text: source.slice(first.at, last.at + last.len), at: first.at, end: last.at + last.len, styles: [], atom: atom, link: atomLink, originalLink: atomLink });
        return;
      }
      if (hiddenSource(n.node)) return;
      var styles = [], link = null, ticks = null;
      for (var p = parent; p && p !== host; p = p.parentElement) {
        var key = { STRONG: 'bold', EM: 'italic', MARK: 'highlight', DEL: 'strike', CODE: 'code', SUP: 'sup', SUB: 'sub', SPAN: writerNote(p) ? 'note' : 'span' }[p.tagName];
        if (key && styles.indexOf(key) < 0) styles.push(key);
        if (key === 'code') { var members = ownedNodes(p); ticks = members.length && (/^`+/.exec(source.slice(members[0].at)) || ['`'])[0]; }
        if (p.tagName === 'A' && !(p.className && /(?:^| )tag(?: |$)/.test(p.className))) link = p;
      }
      for (var i = 0; i < n.len; i++) chars.push({ text: parent && parent.closest('.cw-code-newline') ? ' ' : (n.node.nodeValue == null ? n.node.data || '' : n.node.nodeValue).charAt(i), at: n.at + i, end: n.at + i + 1, styles: styles.slice(), originalStyles: styles.slice(), link: link, originalLink: link, ticks: ticks, parent: parent });
    });
    nodes.forEach(function (n) {
      if (hiddenSource(n.node) && /^(?:<br\s*\/?>)$/i.test(n.node.nodeValue)) chars.push({ text: '\n', at: n.at, end: n.at + n.len, styles: [], originalStyles: [], rawAt: n.at, breakSource: n.node.nodeValue });
    });
    chars.sort(function (a, b) { return a.at - b.at; });
    chars.forEach(function (c) {
      if (c.atom) {
        for (var p = c.atom.parentElement; p && p !== host; p = p.parentElement) {
          var key = { STRONG: 'bold', EM: 'italic', MARK: 'highlight', DEL: 'strike', SUP: 'sup', SUB: 'sub' }[p.tagName];
          if (key && !(key === 'sup' && /footnote-ref/.test(p.className || ''))) c.styles.push(key);
        }
        c.originalStyles = c.styles.slice(); c.parent = c.atom;
      }
      c.rawAt = c.at;
      // An escape belongs to its visible character, not to its predecessor.
      if (!c.atom && source.charAt(c.at - 1) === '\\' && escapedEnds.has(c.at)) c.rawAt--;
      c.owners = [];
      for (var p = c.parent; p && p !== host; p = p.parentElement) {
        if (!ownersByNode.has(p)) {
          var members = ownedNodes(p), owner = null;
          if (members.length) {
            var ownerAt = members[0].at, htmlOpen = new RegExp('<' + p.tagName.toLowerCase() + (p.tagName === 'SPAN' ? '(?: style="white-space:pre")?' : '') + '>\\s*$', 'i').exec(source.slice(0, ownerAt)); if (htmlOpen) ownerAt = htmlOpen.index;
            var ancestors = new Set(); for (var ancestor = p; ancestor && ancestor !== host; ancestor = ancestor.parentElement) ancestors.add(ancestor);
            owner = { node: p, at: ownerAt, end: members[members.length - 1].at + members[members.length - 1].len, ancestors: ancestors };
          }
          ownersByNode.set(p, owner);
        }
        if (ownersByNode.get(p)) c.owners.push(ownersByNode.get(p));
      }
    });
    var derivedAnchors = new Set(), followingAnchors = new Set(), addressLabels = new Map();
    chars.forEach(function (c) {
      if (c.link && c.link.getAttribute) addressLabels.set(c.link, (addressLabels.get(c.link) || '') + (c.atom ? ' ' : c.text));
    });
    var replacedLabel = chars.filter(function (c) { return c.at < end && c.end > start; });
    if (action.kind === 'text' && replacedLabel.length && replacedLabel[0].link && replacedLabel.every(function (c) { return c.link === replacedLabel[0].link && !c.atom; }) && action.text === replacedLabel.map(function (c) { return c.text; }).join('')) {
      if (history !== 'project') setCaret(id, end);
      return { source: source, caret: end };
    }
    if (action.kind !== 'link') addressLabels.forEach(function (label, anchor) {
      // Content is the reload rule: words that derive exactly their destination
      // follow edits. Authored links with other words retain their destination.
      var members = ownedNodes(anchor);
      if (attr(anchor, 'data-autolink') && members.length && source.charAt(members[0].at) !== '<') {
        followingAnchors.add(anchor);
        if (action.kind !== 'style') return;
      }
      var visible = chars.filter(function (c) { return c.link === anchor; });
      var angleEdge = members.length && (source.charAt(members[0].at - 1) === '<' && start <= members[0].at && end > members[0].at - 1 || source.charAt(members[members.length - 1].at + members[members.length - 1].len) === '>' && start <= members[members.length - 1].at + members[members.length - 1].len && end > members[members.length - 1].at + members[members.length - 1].len);
      if (!angleEdge && !visible.some(function (c) { return start === end ? c.at <= start && c.end >= start : c.at < end && c.end > start; })) return;
      if (!label || /\s/.test(label)) return;
      var probe = document.createElement('div');
      probe.innerHTML = MD().renderInline('<' + label + '>');
      var address = probe.querySelector('a');
      if (!address || address.textContent !== label || address.getAttribute('href') !== attr(anchor, 'href')) {
        probe.innerHTML = MD().renderInline(label, { literalAutolinkAt: 0 });
        address = probe.querySelector('a');
      }
      if ((!address || address.textContent !== label || address.getAttribute('href') !== attr(anchor, 'href')) && /^www\./i.test(label)) {
        probe.innerHTML = MD().renderInline('<http://' + label + '>'); address = probe.querySelector('a');
      }
      if (address && (address.textContent === label || /^www\./i.test(label) && address.textContent === 'http://' + label) && address.getAttribute('href') === attr(anchor, 'href')) {
        followingAnchors.add(anchor);
        // Plain bare autolinks already re-derive in the reader. Only formatting
        // or an explicit/angle link needs the full regeneration path.
        if (!attr(anchor, 'data-autolink') || members.length && source.charAt(members[0].at) === '<' || action.kind === 'style' && members.some(function (n) { return !hiddenSource(n.node) && n.at < end && n.at + n.len > start; })) derivedAnchors.add(anchor);
      }
    });
    chars.forEach(function (c) {
      var anchor = c.link;
      if (!followingAnchors.has(anchor)) return;
      var members = ownedNodes(anchor);
      c.explicitAddress = !attr(anchor, 'data-autolink') && members.length && source.charAt(members[0].at - 1) !== '<';
      c.addressOrigin = anchor; c.addressTitle = attr(anchor, 'title');
      c.automatic = true; c.link = c.originalLink = null;
      c.owners = c.owners.filter(function (o) { return o.node !== anchor; });
    });
    // Ask the same GFM scanner that paints the reader which source characters
    // belong to a bare autolink. Escapes inside those spans are URL characters.
    function automaticPositions(value) {
      var positions = [];
      if (!/https?:\/\/|www\.|@(?:[A-Za-z0-9._&-]|\\[._&-])/i.test(value) || typeof document === 'undefined' || !document.createElement) return positions;
      var probe = document.createElement('div');
      probe.innerHTML = MD().renderInline(value, { editSource: true });
      if (probe.textContent !== value) return positions;
      var parts = sourceNodes(probe);
      parts.forEach(function (n) {
        var anchor = n.node.parentElement && n.node.parentElement.closest('a');
        if (!anchor || !anchor.getAttribute('data-autolink') || hiddenSource(n.node)) return;
        var first = parts.find(function (part) { return anchor.contains(part.node); });
        if (!first || value.charAt(first.at) === '<') return;
        for (var i = n.at; i < n.at + n.len; i++) if (value.charAt(i) !== '<' && value.charAt(i) !== '`' && !(value.charAt(i) === '&' && /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/.test(value.slice(i)))) positions[i] = true;
        // GFM trims terminal delimiters until another URL character arrives.
        // Keep them in the same literal run, so typing the next character can
        // extend the destination instead of inheriting a permanent HTML break.
        for (var tail = n.at + n.len; tail < value.length && /[)_*\[\](]/.test(value[tail]); tail++) positions[tail] = true;
      });
      return positions;
    }
    function structuralPrefix(line) {
      if (b.type === 'inline' || b.type === 'p') return 0;
      if (b.type === 'footnote-def') return (/^(?:\[\^[^\]]+\]:[ \t]*|[ \t]+)/.exec(line) || [''])[0].length;
      var rest = line, size = 0, match;
      while ((match = /^(?: {0,3}>[ \t]?|[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)/.exec(rest))) {
        size += match[0].length; rest = rest.slice(match[0].length);
      }
      if (b.type === 'list' || /^(?:quote|callout)$/.test(b.type)) size += (/^[ \t]+/.exec(rest) || [''])[0].length;
      return size;
    }
    function opensBlock(value) {
      return /^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|param|script|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$))/i.test(value) || /^[ \t]+/.test(value) || /^ {0,3}(?:[-+*]|#{1,6}|>)[ \t]*$/.test(value) || /^ {0,3}(?:(?:-[ \t]*){3,}$|[-=]+[ \t]*$|(?:[-+*]|\d+[.)]|#{1,6}|>)[ \t]|`{3,}|~{3,})/.test(value);
    }
    // Native reconciliation can temporarily expose raw source instead of
    // hidden marker nodes. Structural prefixes still belong to the block.
    chars = chars.filter(function (c) {
      var lineAt = source.lastIndexOf('\n', c.at - 1) + 1, end = source.indexOf('\n', lineAt);
      return c.at >= lineAt + structuralPrefix(source.slice(lineAt, end < 0 ? source.length : end));
    });
    var charactersByOwner = new Map();
    chars.forEach(function (c) { (c.owners || []).forEach(function (o) {
      if (!charactersByOwner.has(o.node)) charactersByOwner.set(o.node, []);
      charactersByOwner.get(o.node).push(c);
    }); });
    function ownerCharacters(owner) { return charactersByOwner.get(owner.node) || []; }
    function charBefore(at) {
      var lo = 0, hi = chars.length;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (chars[mid].end <= at) lo = mid + 1; else hi = mid; }
      return chars[lo - 1];
    }
    function charAfter(at) {
      var lo = 0, hi = chars.length;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (chars[mid].at < at) lo = mid + 1; else hi = mid; }
      return chars[lo];
    }
    function characterOffset(at) { var lo = 0, hi = chars.length; while (lo < hi) { var mid = (lo + hi) >>> 1; if (chars[mid].end <= at) lo = mid + 1; else hi = mid; } return lo; }
    var from = characterOffset(start), to = characterOffset(end), active = chars[from];
    // At a hidden closing marker the caret is outside the style. At the end of
    // a visible run it still belongs to that run until the closing marker.
    if (from === to && (!active || active.at > start) && from && chars[from - 1].end === start) active = chars[from - 1];
    // Reconstruct the live typing run, including whitespace temporarily emitted
    // outside Markdown marks. These are edited characters, not raw source trees.
    var typing = typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start ? typingStyles : null;
    var typingRun = typing && action.kind === 'text' && !action.link ? { from: typing.run ? typing.run.from : from, styles: typing.run ? typing.run.styles.map(function (styles) { return styles.slice(); }) : [] } : null;
    if (typingRun) typingRun.styles.forEach(function (styles, index) {
      var c = chars[typingRun.from + index];
      if (c) {
        // Only whitespace may have moved outside its typing delimiters. A
        // retained run must never re-own untouched non-whitespace characters.
        if (/^\s$/.test(c.text)) c.styles = styles.slice();
        else typingRun.styles[index] = c.styles.slice();
        c.typed = true;
      }
    });
    function literal(text, owner) { return String(text).split('').map(function (ch) { return { text: ch, at: start, end: start, styles: typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start ? typingStyles.styles.slice() : owner ? owner.styles.slice() : [], link: owner && owner.link, ticks: owner && owner.ticks, owners: owner && owner.owners, automatic: owner && owner.automatic, explicitAddress: owner && owner.explicitAddress, addressOrigin: owner && owner.addressOrigin, addressTitle: owner && owner.addressTitle, typed: !!typingRun }; }); }
    function attr(el, name) { return el && el.getAttribute ? el.getAttribute(name) : null; }
    function linkInfo(el) {
      var members = ownedNodes(el);
      var raw = members.length ? source.slice(members[0].at, members[members.length - 1].at + members[members.length - 1].len) : '';
      if (/(?:^| )wikilink(?: |$)/.test(attr(el, 'class') || '') && raw.slice(0, 2) === '[[') return { wiki: true, target: raw.slice(2, -2).split('|')[0] };
      return { wiki: false, target: attr(el, 'href') || (raw.match(/\]\(([^]*)\)$/) || [,''])[1], title: attr(el, 'title') };
    }
    // The published reader leaves wiki syntax literal. A code span must not
    // begin in one wiki token and consume content outside that token.
    // Wiki scans keep escaped and ordinary characters disjoint so a malformed
    // closer cannot backtrack over every spelling of a backslash run.
    function crossesWikiCode(value) {
      if (value.indexOf('[[') < 0 || value.indexOf('`') < 0) return false;
      var spans = [], wiki = /(?<!\\)\[\[(?:\\.|[^\]\\\n])*\]\]/g, match;
      while ((match = wiki.exec(value))) spans.push({ start: match.index, end: match.index + match[0].length });
      function scope(at) { for (var n = 0; n < spans.length; n++) if (at >= spans[n].start && at < spans[n].end) return n + 1; return 0; }
      for (var at = 0; at < value.length;) {
        if (value[at] === '\\') { at += 2; continue; }
        if (value[at] !== '`') { at++; continue; }
        var size = 1; while (value[at + size] === '`') size++;
        var close = at + size;
        while (close < value.length) {
          if (value[close] !== '`') { close++; continue; }
          var run = 1; while (value[close + run] === '`') run++;
          if (run === size) break; close += run;
        }
        if (close >= value.length) { at += size; continue; }
        if (scope(at) !== scope(close) && (scope(at) || scope(close))) return true;
        at = close + size;
      }
      return false;
    }
    function crossesWikiStyles(value) {
      if (!/\[\[/.test(value) || !/[*_~]/.test(value)) return false;
      var spans = [], extra = 0;
      var plain = value.replace(/(?<!\\)\[\[(?:\\.|[^\]\\\n])*\]\]/g, function (token, at) {
        spans.push({ start: at + extra, end: at + extra + token.length + 1 }); extra++;
        return '\\' + token;
      });
      if (!spans.length) return false;
      var probe = document.createElement('div'); probe.innerHTML = MD().renderInline(plain, { editSource: true });
      var bounds = new Map();
      sourceNodes(probe).forEach(function (n) {
        for (var parent = n.node.parentElement; parent && parent !== probe; parent = parent.parentElement) {
          if (!/^(?:STRONG|EM|DEL|MARK)$/.test(parent.tagName)) continue;
          var range = bounds.get(parent);
          if (!range) bounds.set(parent, { start: n.at, end: n.at + n.len }); else range.end = n.at + n.len;
        }
      });
      var crossing = false;
      bounds.forEach(function (range) { spans.forEach(function (span) {
        if ((range.start > span.start && range.start < span.end) !== (range.end > span.start && range.end < span.end)) crossing = true;
      }); });
      return crossing;
    }
    var globalLiteralCounts = new Map();
    chars.forEach(function (c, i) { if (!c.atom && !(action.kind === 'text' && i >= from && i < to)) globalLiteralCounts.set(c.text, (globalLiteralCounts.get(c.text) || 0) + 1); });
    if (action.kind === 'text') String(action.text || '').split('').forEach(function (ch) { globalLiteralCounts.set(ch, (globalLiteralCounts.get(ch) || 0) + 1); });
    var emphasisMatches = new WeakMap();
    function matchesEmphasis(candidate, list) {
      var cache = emphasisMatches.get(list);
      if (!cache) { cache = new Map(); emphasisMatches.set(list, cache); }
      var cacheKey = (candidate.full ? 'block:' : 'inline:') + (candidate.breaks === false ? 'nobr:' : '') + candidate.source;
      if (!cache.has(cacheKey)) cache.set(cacheKey, computeEmphasis(candidate, list));
      return cache.get(cacheKey);
    }
    function computeEmphasis(candidate, list) {
          if (crossesWikiCode(candidate.source) || crossesWikiStyles(candidate.source)) return false;
          var probe = document.createElement('div'), actual = [];
          var context = { editSource: true, showWriterNotes: true, references: typeof doc !== 'undefined' && doc && doc.references };
          probe.innerHTML = candidate.full ? MD().parse(candidate.source, context).blocks.map(function (b) { return b.html; }).join('') : MD().renderInline(candidate.source, context);
          function walk(node, styles, link) {
            if (node.nodeType !== 3 && /(?:^| )cw-mk(?: |$)/.test(node.className || '')) return;
            if (node.nodeType !== 3 && /(?:^| )cw-code-newline(?: |$)/.test(node.className || '')) { actual.push({ text: ' ', styles: styles, link: link }); return; }
            if (node.nodeType === 3) {
              var text = node.nodeValue == null ? node.data || '' : node.nodeValue;
              for (var n = 0; n < text.length; n++) actual.push({ text: text.charAt(n), styles: styles, link: link });
              return;
            }
            var next = styles.slice(), key = { STRONG: 'bold', EM: 'italic', CODE: 'code', DEL: 'strike', MARK: 'highlight', SUP: 'sup', SUB: 'sub', SPAN: writerNote(node) ? 'note' : 'span' }[node.tagName];
            if (key && !(key === 'sup' && /(?:^| )footnote-ref(?: |$)/.test(node.className || '')) && !(key === 'span' && /(?:^| )cw-atom(?: |$)/.test(node.className || '')) && next.indexOf(key) < 0) next.push(key);
            var nextLink = node.tagName === 'A' ? { target: node.getAttribute('href') || node.getAttribute('data-target') || '', automatic: !!node.getAttribute('data-autolink') } : link;
            if (node.tagName === 'BR' && candidate.breaks === false) return;
            if (node.tagName === 'BR') { actual.push({ text: '\n', styles: next, link: nextLink }); return; }
            if (node.nodeType !== 3 && /(?:^| )cw-atom(?: |$)/.test(node.className || '')) { var wanted = list[actual.length], label = node.getAttribute('data-label'); if (wanted && wanted.atom || label == null || !/^&#(?:[xX][0-9a-fA-F]+|[0-9]+);$/.test(node.textContent)) actual.push({ text: node.textContent, styles: next, link: nextLink }); else for (var i = 0; i < label.length; i++) actual.push({ text: label.charAt(i), styles: next, link: nextLink }); return; }
            Array.prototype.forEach.call(node.childNodes || [], function (child) { walk(child, next, nextLink); });
          }
          walk(probe, []);
          return actual.length === list.length && actual.every(function (c, index) {
            var wanted = list[index];
            var target = wanted.link && (wanted.link.nodeType ? attr(wanted.link, 'href') || attr(wanted.link, 'data-target') || '' : wanted.link.target);
            if (!wanted.atom && (wanted.link ? !c.link || c.link.target !== target : c.link && !c.link.automatic)) return false;
            return c.text === wanted.text && ['bold', 'italic', 'code', 'strike', 'highlight', 'sup', 'sub', 'span'].every(function (key) { return key !== 'code' && /\s/.test(c.text) || (c.styles.indexOf(key) >= 0) === (wanted.styles.indexOf(key) >= 0); });
          });
        }
    // Reuse authored spelling outside the edit before accepting a whole-paragraph
    // serialization. Validate the stitched paragraph against the intended visible
    // model, so preserving source cannot introduce a new delimiter interaction.
    // Opaque constructs need this even when our inline model cannot describe the
    // site's HTML semantics: their original bytes remain the authority.
    function retainUntouched(next, wanted) {
      if (!next || next.source === source) return next;
      var pattern = /(?<!\\)<[!?A-Za-z/][^>\n]*>/g, token, spans = [];
      while ((token = pattern.exec(source))) {
        if (/^<\/?(?:span|strong|em|mark|del|sup|sub|br)(?:[ \t/>]|$)/i.test(token[0])) continue;
        // An angle autolink shown with its own angles (<<https://x>>) loses
        // that spelling when the edit removes one of the wrapping angles: the
        // edit owns it then. Any other untouched construct keeps its bytes.
        var tokenEnd = token.index + token[0].length;
        if (/^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>$/.test(token[0])
          && source.charAt(token.index - 1) === '<' && source.charAt(tokenEnd) === '>'
          && (token.index === end && start <= token.index - 1 || tokenEnd === start && end > tokenEnd)) continue;
        if (token.index + token[0].length <= start || token.index >= end) spans.push({ at: token.index, end: token.index + token[0].length, raw: token[0] });
      }
      if (!spans.length) return next;
      var context = { editSource: true, references: typeof doc !== 'undefined' && doc && doc.references };
      // Replace only the opaque owners, right to left. Reusing a whole raw
      // prefix would also freeze spelling generated by earlier keystrokes.
      spans.reverse().forEach(function (span) {
        var probe = document.createElement('div'), points = [], atomSeen = new Set();
        probe.innerHTML = b.type === 'inline' ? MD().renderInline(next.source, context) : MD().parse(next.source, context).blocks.map(function (b) { return b.html; }).join('');
        sourceNodes(probe).forEach(function (n) {
          var atom = n.node.parentElement && n.node.parentElement.closest('.cw-atom');
          if (atom) {
            if (!atomSeen.has(atom)) { atomSeen.add(atom); var ns = sourceNodes(atom); points.push({ at: n.at, end: n.at + ns.reduce(function (total, n) { return total + n.len; }, 0) }); }
          } else if (!hiddenSource(n.node)) for (var i = 0; i < n.len; i++) points.push({ at: n.at + i, end: n.at + i + 1 });
        });
        var first = chars.filter(function (c) { return c.end <= span.at; }).length;
        var last = chars.filter(function (c) { return c.at < span.end; }).length;
        if (action.kind === 'text' && span.at >= end) { var delta = String(action.text || '').length - (to - from); first += delta; last += delta; }
        var left = [first ? points[first - 1]?.end : structuralPrefix(next.source.split('\n')[0]), points[first]?.at ?? next.source.length];
        var right = [last < points.length ? points[last].at : next.source.length, last ? points[last - 1]?.end : 0];
        for (var a = 0; a < left.length; a++) for (var z = 0; z < right.length; z++) {
          var lo = left[a], hi = right[z];
          if (lo == null || hi == null || lo > hi) continue;
          var value = next.source.slice(0, lo) + span.raw + next.source.slice(hi);
          if (value === next.source) return;
          if (!matchesEmphasis({ source: value, full: b.type !== 'inline' }, wanted)) continue;
          var shift = span.raw.length - (hi - lo);
          function point(at) { return at == null ? at : at <= lo ? at : at >= hi ? at + shift : lo; }
          next = Object.assign({}, next, { source: value, caret: point(next.caret), start: point(next.start), end: point(next.end),
            escapes: (next.escapes || []).filter(function (at) { return at < lo || at >= hi; }).map(point) });
          return;
        }
      });
      return next;
    }
    // Remove only escapes introduced by this transaction. Compare complete
    // reader trees, including links, atoms, whitespace and block structure;
    // text equality alone would accept accidental formatting. Authored escapes
    // are retained; only this run's generated escapes can be revisited. Raw spelling wins whenever it is valid.
    function cleanSpelling(value, positions, caret, inline) {
      if (!positions.length || typeof document === 'undefined' || !document.createElement) return { source: value, caret: caret, escapes: positions.slice() };
      var exhausted = {}, meanings = new Map();
      function checkpoint() { if (++work.steps > 4096) throw exhausted; }
      function parseInput(text) {
        checkpoint();
        // Count actual parser input. Dense families make one bounded pass;
        // sparse inputs retain the exact search within the same work limits.
        var cost = text.length;
        if (work.characters + cost > work.limit) throw exhausted;
        work.characters += cost;
        return text;
      }
      function render(text) { return MD().renderInline(parseInput(text)); }
      function meaning(text) {
        checkpoint();
        if (meanings.has(text)) return meanings.get(text);
        if (++work.probes > 128) throw exhausted;
        var probe = document.createElement('div'), tokens = [];
        var context = typeof doc !== 'undefined' && doc || {};
        var wrapped = (host.cwSourcePrefix || '') + text + (host.cwSourceSuffix || '');
        parseInput(wrapped);
        probe.innerHTML = inline && !host.cwSourcePrefix && !host.cwSourceSuffix ? MD().renderInline(text, context) : MD().parse(wrapped, context).blocks.map(function (b) { return b.html; }).join('');
        // The app intentionally displays unsupported HTML literally; CommonMark
        // publishes it as HTML. Also retain empty block markers whose app
        // interpretation is more permissive while writing. Include those
        // source constructs in the comparison rather than accepting text alone.
        var withoutWiki = wrapped.replace(/(?<!\\)\[\[(?:\\.|[^\]\\\n])*\]\]/g, function (token) { return '\\[' + token.slice(1); });
        tokens.push(['site-html-openings', wrapped.match(/(?<!\\)(?:\\\\)*<(?:!(?!@)|\?)[^\n]*/g) || []]);
        tokens.push(['site-wiki-context', withoutWiki === wrapped ? '' : MD().parse(parseInput(withoutWiki), context).blocks.map(function (b) { return b.html; }).join('')]);
        // CommonMark can consume a wiki closer as a new inline-link label.
        // Literal parentheses after that token must retain their escape.
        tokens.push(['site-wiki-link-boundary', wrapped.match(/(?<!\\)(?:\\\\)*\[\[(?:\\.|[^\]\\\n])*\]\]\(/g) || []]);
        tokens.push(['CommonMark', (wrapped.match(/(?<!\\)<!(?:[A-Za-z][^>]*|--[^]*?--)>/g) || []), (wrapped.match(/\[\[(?:\\.|[^\]\\\n])*\]\]/g) || []).map(function (token) { return token.replace(/\\(.)/g, '$1'); }), (wrapped.match(/(?<!\\)(?:\\\\)*\\\n/g) || []), (wrapped.match(/^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|param|script|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$))/gim) || []), (wrapped.match(/(?<!\\)(?:\\\\)*<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n][^<>]*?)?\/?>/g) || []), inline && !host.cwSourceSuffix ? [] : wrapped.split('\n').map(function (line, index) { var rest = line.replace(/^\[\^[^\]]+\]:[ \t]*/, '').trimStart(), markers = [], match; while ((match = /^(?: {0,3}>[ \t]?|[ \t]*(?:[-+*]|\d+[.)])[ \t]+| {0,3}#{1,6}(?:[ \t]+|$))/.exec(rest))) { markers.push(match[0]); rest = rest.slice(match[0].length); } var body = rest.trim();
          var htmlBlock = /^(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|param|script|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$))/i.exec(rest);
          if (htmlBlock) markers.push(htmlBlock[0]); if (/^(?:[-=*+>]|#{1,6})$/.test(body) || index > 0 && /^[-=]+$/.test(body) || /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(body) || /^(?:`{3,}|~{3,})/.test(body)) markers.push(body); return markers.length ? [index, markers] : null; }).filter(Boolean)]);
        function visit(node) {
          if (node.nodeType === 3) {
            var text = node.nodeValue == null ? node.data || '' : node.nodeValue, last = tokens[tokens.length - 1];
            if (last && last[0] === 'text') last[1] += text; else tokens.push(['text', text]);
            return;
          }
          var tag = node.tagName, attributes = ['href', 'title', 'src', 'alt', 'class', 'style', 'data-target', 'data-footnote', 'data-note'].map(function (key) { return node.getAttribute && node.getAttribute(key); });
          if (node !== probe) tokens.push(['open', tag, attributes]);
          Array.prototype.forEach.call(node.childNodes || [], visit);
          if (node !== probe) tokens.push(['close', tag]);
        }
        visit(probe); var result = JSON.stringify(tokens); meanings.set(text, result); return result;
      }
      // The serializer already supplied an exact literal spelling. If optimization
      // expires, retain it in full, never an unvalidated search candidate.
      try {
        var expected = meaning(value);
        var eligiblePositions = new Set(positions);
        function spell(kept) { var retained = new Set(kept); return value.split('').filter(function (_, index) { return !eligiblePositions.has(index) || retained.has(index); }).join(''); }
        var kept = [], raw = spell(kept);
        if (meaning(raw) !== expected) {
          // Dense punctuation uses a canonical bounded pass. Try each character
          // family, then its individual positions in a fixed order. Sparse
          // inputs retain the exact minimum search below. The whole reader
          // meaning still validates every accepted removal.
          function isolatedMinimum() {
            if (host.cwSourcePrefix || host.cwSourceSuffix || !/^[A-Za-z0-9 *_]+$/.test(raw) || render(value) !== raw) return null;
            var eligible = new Set(positions), originalAt = [], domains = [], covered = new Set(), match;
            for (var at = 0; at < value.length; at++) if (!eligible.has(at)) originalAt.push(at);
            var pattern = /(^| )([*_]{1,3})([A-Za-z0-9](?:[A-Za-z0-9 ]*[A-Za-z0-9])?)\2(?= |$)/g;
            while ((match = pattern.exec(raw))) {
              var mark = match[2]; if (!/^\*+$|^_+$/.test(mark)) return null;
              var begin = match.index + match[1].length, close = begin + mark.length + match[3].length, points = [];
              for (var n = 0; n < mark.length; n++) points.push(originalAt[begin + n] - 1);
              for (var n = 0; n < mark.length; n++) points.push(originalAt[close + n] - 1);
              if (!points.every(function (at) { return eligible.has(at); })) return null;
              for (var n = begin; n < close + mark.length; n++) if (/[*_]/.test(raw[n])) covered.add(n);
              domains.push({ begin: begin, end: close + mark.length, mark: mark, body: match[3], points: points });
            }
            if (domains.length < 2 || raw.split('').some(function (ch, at) { return /[*_]/.test(ch) && !covered.has(at); })) return null;
            var probes = []; ['*', '_'].forEach(function (ch) { for (var n = 1; n <= 3; n++) { probes.push(' a' + ch.repeat(n) + ' '); probes.push(' !' + ch.repeat(n) + '!'); } });
            function state(text, shown) { var bits = 0; probes.forEach(function (probe, bit) { if (render(text + probe) !== shown + probe) bits |= 1 << bit; }); return bits; }
            var states = new Map([[0, { text: '', count: 0, points: [] }]]), previousEnd = 0;
            for (var d = 0; d < domains.length; d++) {
              var domain = domains[d], options = [], token = domain.mark + domain.body + domain.mark;
              for (var mask = 0; mask < Math.pow(2, domain.points.length); mask++) {
                checkpoint();
                var spelling = '', points = [];
                for (var n = 0; n < token.length; n++) { var bit = n < domain.mark.length ? n : n >= domain.mark.length + domain.body.length ? n - domain.body.length : -1; var escape = bit >= 0 && mask & (1 << bit); spelling += escape ? '\\' + token[n] : token[n]; if (escape) points.push(domain.points[bit]); }
                if (render(spelling) === token) options.push({ text: spelling, points: points });
              }
              var nextStates = new Map(), plain = raw.slice(previousEnd, domain.begin), shown = raw.slice(0, domain.end);
              states.forEach(function (prior) { options.forEach(function (option) {
                checkpoint();
                var count = prior.count + option.points.length; if (count > kept.length) return;
                var text = prior.text + plain + option.text; if (render(text) !== shown) return;
                var key = state(text, shown), best = nextStates.get(key);
                if (!best || count < best.count) nextStates.set(key, { text: text, count: count, points: prior.points.concat(option.points) });
              }); });
              states = nextStates; previousEnd = domain.end;
            }
            var best = null; states.forEach(function (candidate) { if ((!best || candidate.count < best.count) && meaning(spell(candidate.points)) === expected) best = candidate; });
            return best && best.points;
          }
          kept = positions.slice();
          var isolated = isolatedMinimum();
          if (isolated) kept = isolated;
          else {
            var candidates = positions.slice();
            if (positions.length > 8) {
              // Remove harmless families in bulk before refining a small
              // interacting remainder. Long delimiter families keep the same
              // deterministic work bound as the bulk pass.
              Array.from(new Set(positions.map(function (at) { return value[at + 1]; }))).sort().forEach(function (ch) {
                var candidate = kept.filter(function (at) { return value[at + 1] !== ch; });
                if (meaning(spell(candidate)) === expected) kept = candidate;
              });
              candidates = kept.slice();
            }
            if (candidates.length <= 8) {
              function prune(order) {
                var retained = candidates.slice(), changed = true;
                while (changed) {
                  changed = false;
                  order.forEach(function (position) {
                    if (retained.indexOf(position) < 0) return;
                    var candidate = retained.filter(function (p) { return p !== position; });
                    if (meaning(spell(candidate)) === expected) { retained = candidate; changed = true; }
                  });
                }
                return retained;
              }
              kept = prune(candidates.slice().reverse());
              var forward = prune(candidates);
              if (forward.length < kept.length) kept = forward;
              // Greedy removal alone can keep two early delimiters when escaping one
              // later delimiter suffices. Search smaller subsets before accepting the
              // bound above, in source order for deterministic ties. Ordinary typing
              // has one candidate; syntax-free paste takes the zero-escape fast path.
              function choose(start, count, selected) {
                checkpoint();
                if (!count) return meaning(spell(selected)) === expected ? selected : null;
                for (var index = start; index <= candidates.length - count; index++) {
                  var found = choose(index + 1, count - 1, selected.concat(candidates[index]));
                  if (found) return found;
                }
                return null;
              }
              // For plain isolated delimiter runs, no emphasis pair may close.
              // The state records which closing runs would match an outstanding
              // opener. Equal states have the same valid continuations; keep the
              // cheapest prefix. This avoids exponential subsets for ordinary pasted
              // Markdown while the general search below handles interacting syntax.
              for (var size = 1; !isolated && size < kept.length; size++) {
                var minimum = choose(0, size, []);
                if (minimum) { kept = minimum; break; }
              }
            }
          }
        }

        var keptSet = new Set(kept), removed = positions.filter(function (position) { return !keptSet.has(position); }).sort(function (a, b) { return a - b; });
        var spelling = spell(kept), mappedCaret = caret - removed.filter(function (position) { return position < caret; }).length, escapedAt = new Set(), mapped = new Set(), removedBefore = 0;
        // Both sequences are ordered. Map all generated prefixes in one merge,
        // rather than rescanning every removed prefix for each retained one.
        kept.slice().sort(function (a, b) { return a - b; }).forEach(function (at) {
          while (removedBefore < removed.length && removed[removedBefore] < at) removedBefore++;
          escapedAt.add(at - removedBefore);
        });
        // Removing one backslash can make its neighbour the escape prefix.
        // Follow actual prefix ownership within the resulting run, rather than
        // treating a generated prefix's new visible neighbour as authored.
        for (var at = 0; at < spelling.length;) {
          if (spelling[at] !== '\\') { at++; continue; }
          var begin = at;
          while (spelling[at] === '\\') { if (escapedAt.has(at)) mapped.add(begin + 2 * Math.floor((at - begin) / 2)); at++; }
          if (mappedCaret > begin && mappedCaret < at && (mappedCaret - begin) % 2) mappedCaret++;
        }
        return { source: spelling, caret: mappedCaret, removed: removed, escapes: Array.from(mapped).sort(function (a, b) { return a - b; }) };
      } catch (error) {
        if (error !== exhausted) throw error;
        return { source: value, caret: caret, escapes: positions.slice(), spellingFallback: true };
      }
    }
    // Inline serialization uses a fixed semantic nesting order. Whitespace is
    // moved outside delimiter edges, literals are escaped, and source carets are
    // obtained from the serializer's own boundary map.
    function serialize(list, caretIndex, variant) {
      // A literal delimiter on another visual line can pair with a style mark
      // emitted here. The entire edited surface determines shortcut safety.
      var styledDelimiters = rows && (rows.length > 1 || rows.some(function (row) { return row.chars.some(function (c) { return c.text === '\n'; }); })) && rows.some(function (row) { return row.chars.some(function (c) { return c.styles.indexOf('bold') >= 0 || c.styles.indexOf('italic') >= 0; }); });
      // A literal angle address keeps its visible brackets. Spell the address
      // with a derived autolink, never an authored destination, so label edits
      // and reloads always derive its target from the current address text.
      var angleText = list.map(function (c) { return c.atom ? ' ' : c.text; }).join(''), anglePattern = /<([^<>\s]+)>/g, angleMatch;
      while ((angleMatch = anglePattern.exec(angleText))) {
        var begin = angleMatch.index + 1, finish = begin + angleMatch[1].length;
        var members = list.slice(begin, finish);
        if (members.some(function (c) { return c.link; })) continue;
        var angleProbe = document.createElement('div'); angleProbe.innerHTML = MD().renderInline(angleMatch[0]);
        var angleLink = angleProbe.querySelector('a');
        if (!angleLink || !angleLink.getAttribute('data-autolink') || angleLink.textContent !== angleMatch[1]) continue;
        var derived = { target: angleLink.getAttribute('href'), angle: members.every(function (c) { return !c.atom && !c.styles.length; }) && (angleProbe.textContent === angleMatch[1] ? 'fenced' : 'bare') };
        members.forEach(function (c) { c.link = derived; });
      }
      // Removing a visible angle must not discard the remaining address's
      // derivation. Styled bare addresses use the same reader scanner and
      // content rule as styled angle addresses; other explicit links stay owned.
      if (derivedAnchors.size) {
        // An authored address can own punctuation that GFM trims from a bare
        // autolink. Regenerate the complete edited label as an explicit link.
        for (var addressAt = 0; addressAt < list.length;) {
          var addressStart = addressAt, origin = list[addressAt].addressOrigin;
          while (++addressAt < list.length && origin && list[addressAt].addressOrigin === origin) {}
          var addressMembers = list.slice(addressStart, addressAt);
          if (!origin || !addressMembers.every(function (c) { return c.explicitAddress && !c.link && !c.atom; })) continue;
          var addressText = addressMembers.map(function (c) { return c.text; }).join('');
          var fullProbe = document.createElement('div'); fullProbe.innerHTML = MD().renderInline('<' + (/^www\./i.test(addressText) ? 'http://' : '') + addressText + '>');
          var fullLink = fullProbe.querySelector('a');
          if (!fullLink || fullLink.textContent !== addressText && fullLink.textContent !== 'http://' + addressText) continue;
          var fullTarget = fullLink.getAttribute('href'), fullTitle = addressMembers[0].addressTitle;
          fullProbe.innerHTML = MD().renderInline(addressText, { literalAutolinkAt: 0 });
          var plainLink = fullProbe.querySelector('a');
          var fullDerived = { target: fullTarget, title: fullTitle, angle: fullTitle == null && plainLink && plainLink.textContent === addressText && plainLink.getAttribute('href') === fullTarget && addressMembers.every(function (c) { return !c.styles.length; }) && 'plain' };
          addressMembers.forEach(function (c) { c.link = fullDerived; });
        }
        var barePattern = /[A-Za-z][A-Za-z0-9+.-]{1,31}:|www\.|[A-Za-z0-9.+_-]+@/gi, bareMatch;
        while ((bareMatch = barePattern.exec(angleText))) {
          var bareProbe = document.createElement('div'); bareProbe.innerHTML = MD().renderInline(angleText, { literalAutolinkAt: bareMatch.index });
          var bareLink = bareProbe.querySelector('a'), barePlain = !!bareLink;
          if (!bareLink) {
            // Other URI schemes are native angle addresses, not bare GFM links.
            // Their explicit spelling still follows its visible address.
            var token = /^[^\s<>]+/.exec(angleText.slice(bareMatch.index));
            if (token) bareProbe.innerHTML = MD().renderInline('<' + token[0] + '>');
            bareLink = bareProbe.querySelector('a');
            if (!bareLink || !bareLink.getAttribute('data-autolink') || bareLink.textContent !== token[0]) continue;
          }
          var bareEnd = bareMatch.index + bareLink.textContent.length, bareMembers = list.slice(bareMatch.index, bareEnd);
          barePattern.lastIndex = bareEnd;
          if (bareMembers.some(function (c) { return c.link || c.atom; }) || !bareMembers.some(function (c) { return c.automatic; }) || !barePlain && !bareMembers.every(function (c) { return c.explicitAddress; })) continue;
          var bareTitle = bareMembers.find(function (c) { return c.addressTitle != null; });
          var bareDerived = { target: bareLink.getAttribute('href'), title: bareTitle && bareTitle.addressTitle, angle: !bareTitle && barePlain && bareMembers.every(function (c) { return !c.styles.length; }) && 'plain' };
          bareMembers.forEach(function (c) { c.link = bareDerived; });
        }
      }
      var out = '', caret = null, inLinkLabel = false, newEscapes = [], automaticFrom = 0, automaticCandidate = false, automaticWord = false, automaticProbeDirty = true, automaticCut = Infinity;
      var indexes = new Map(), literalCounts = new Map();
      list.forEach(function (c, index) { if (!indexes.has(c)) indexes.set(c, index); if (!c.atom) literalCounts.set(c.text, (literalCounts.get(c.text) || 0) + 1); });
      if (list.some(function (c) { return c.text === '\n' && !c.atom; })) {
        var segment = [], consumed = 0;
        function flush() {
          var local = caretIndex != null && caretIndex >= consumed && caretIndex <= consumed + segment.length ? caretIndex - consumed : null;
          var chunk = serialize(segment, local, variant);
          if (local != null) caret = out.length + chunk.caret;
          (chunk.escapes || []).forEach(function (at) { newEscapes.push(out.length + at); });
          out += chunk.source; consumed += segment.length + 1; segment = [];
        }
        list.forEach(function (c) { if (c.text === '\n' && !c.atom) { flush(); out += c.breakSource || '\n'; } else segment.push(c); });
        flush(); return { source: out, caret: caret == null ? out.length : caret, escapes: newEscapes };
      }
      function append(s, literal, character, rawAt) {
        // GFM consumes backslashes and emphasis marks at the end of a URL.
        // End that source run before emitting syntax for a separate character.
        if (!inLinkLabel && automaticCandidate && automaticWord && (/^\\/.test(s) && s.length > 1 || !literal && /^[*_`]/.test(s))) {
          // Only a link in the final non-space run can consume this syntax.
          // An emitted empty span is a permanent text-event boundary, so earlier
          // URLs never need another prefix render as the rest of the run grows.
          var tail = out.slice(automaticFrom);
          if (automaticProbeDirty && MD().renderInline(tail, { autolinkProbe: true })) {
            var spans = automaticPositions(tail), last = spans.lastIndexOf(true);
            if (last >= 0) last += automaticFrom;
            if (last >= 0 && (!literal || s !== '\\>' || /https?:\/\/|www\./i.test(tail)) && /^[?!.,:;*_~\]\)"']*$/.test(out.slice(last + 1))) { if (caret != null && caret >= out.length) caret += 13; out += '<span></span>'; automaticFrom = out.length; automaticCandidate = automaticWord = false; automaticCut = Math.min(automaticCut, character ? indexes.get(character) : 0); }
          } else if (automaticProbeDirty) automaticProbeDirty = false;
        }
        // Adjacent code spans must not merge their closing/opening tick runs.
        if (!literal && /`$/.test(out) && /^`/.test(s)) { if (caret != null && caret >= out.length) caret += 13; out += '<span></span>'; }
        if (rawAt != null) for (var at = rawAt; at < rawAt + s.length; at++) { if (runEscapeSet.has(at)) newEscapes.push(out.length + at - rawAt); }
        if (character && s === '\\' + character.text && (!character.originalStyles || character.typed || source.slice(character.rawAt, character.end) !== s || character.styles.join() !== character.originalStyles.join() || character.link !== character.originalLink || runEscapeSet.has(character.rawAt))) newEscapes.push(out.length);
        // Carry the final text-event boundary forward instead of rescanning
        // the growing prefix for whitespace at every escaped character.
        var space = Math.max(s.lastIndexOf(' '), s.lastIndexOf('\n'), s.lastIndexOf('\r'), s.lastIndexOf('\t'));
        if (space >= 0) { automaticFrom = out.length + space + 1; automaticCandidate = automaticWord = false; automaticProbeDirty = true; }
        var addedTail = s.slice(space + 1);
        // A failed conservative prefilter cannot become true until a protocol,
        // host, email or entity character arrives. Do not decode the growing
        // punctuation-only suffix again for every generated escape.
        if (/[A-Za-z0-9._+\-:\/@&;#\u0080-\uffff]/.test(addedTail)) automaticProbeDirty = true;
        if (/[A-Za-z0-9]/.test(addedTail)) automaticWord = true;
        if (/https?:\/\/|www\.|[A-Za-z0-9.+_;>\\-]@/i.test((space >= 0 ? '' : out.slice(Math.max(automaticFrom, out.length - 8))) + addedTail)) automaticCandidate = true;
        out += s;
      }
      var automatic = [];
      for (var lo = 0; lo < list.length;) {
        var hi = lo + 1;
        while (hi < list.length && list[hi].styles.join() === list[lo].styles.join() && list[hi].link === list[lo].link && !list[hi].atom) hi++;
        var segment = list.slice(lo, hi).map(function (c) { return c.text; }).join('');
        if (!list[lo].link && !list[lo].atom && list[lo].styles.indexOf('code') < 0 && /https?:\/\/|www\.|@/i.test(segment)) {
          automaticPositions(segment).forEach(function (value, at) { automatic[lo + at] = value; });
        }
        lo = hi;
      }
      var rawLiteral = list.map(function (c) { return c.text; }).join('');
      var rawAutomatic = (variant == null || variant < 6) && /https?:\/\/|www\./i.test(rawLiteral) && list.every(function (c) { return !c.atom && !c.link && !c.styles.length; }) && matchesEmphasis({ source: rawLiteral }, list);
      function escaped(s, character) {
        if (variant >= 7 && s === '`' && !character.originalStyles) return '&#96;';
        return s.replace(/[\\`*_\[\]()~#<>!|=^%&]/g, function (ch) {
          if ((variant == null || variant < 6) && !character.link && indexes.get(character) < automaticCut && (rawAutomatic && /[)_*\[\](]/.test(ch) || automaticCandidate && automaticWord && automatic[indexes.get(character)]) && character.styles.indexOf('code') < 0) return ch;
          var literalCount = literalCounts.get(ch) || 0;
          if (ch === '!' && !(list[indexes.get(character) + 1] && list[indexes.get(character) + 1].link)) return ch;
          var point = indexes.get(character), prev = list[point - 1], next = list[point + 1];
          var sameStyle = prev && next && character && prev.styles.join() === character.styles.join() && next.styles.join() === character.styles.join();
          if ((ch === '[' || !styledDelimiters) && literalCount === 1 && globalLiteralCounts.get(ch) === 1 &&
              // A projected inline span can still sit inside an outer link label.
              (ch === '[' && b.type !== 'inline' && !character.link && !list.some(function (c) { return c.atom; }) && !(prev && prev.link || next && next.link) && !globalLiteralCounts.get(']') ||
               ch === '_' && b.type !== 'inline' && prev && /[\p{L}\p{N}]/u.test(prev.text) && !character.link && !character.styles.length && !prev.styles.length && (!next || !next.styles.length) ||
               (ch === '*' || ch === '_') && b.type !== 'inline' && sameStyle && /[\p{L}\p{N}]/u.test(prev.text) && /[\p{L}\p{N}]/u.test(next.text) && character.styles.indexOf('italic') < 0)) return ch;
          return '\\' + ch;
        });
      }
      var order = ['link', variant >= 3 && variant < 6 ? 'italic' : 'bold', variant >= 3 && variant < 6 ? 'bold' : 'italic', 'highlight', 'strike', 'sup', 'sub', 'span', 'note', 'code'];
      function ownerKey(owner) { return { A: 'link', STRONG: 'bold', EM: 'italic', MARK: 'highlight', DEL: 'strike', SUP: 'sup', SUB: 'sub', SPAN: writerNote(owner.node) ? 'note' : 'span', CODE: 'code' }[owner.node.tagName]; }
      function rawFits(group, owner, level) {
        return group.every(function (c) {
          return (c.owners || []).every(function (o) {
            var key = ownerKey(o), index = order.indexOf(key);
            var wanted = key === 'link' ? c.link === o.node : c.styles.indexOf(key) >= 0;
            if (index < 0 || !wanted) return true;
            var inside = o.ancestors.has(owner.node);
            // Raw markup cannot omit an un-emitted ancestor or duplicate a
            // semantic wrapper that the enclosing serializer already emitted.
            return index < level ? !inside : inside;
          });
        });
      }
      function rawFlanks(group, owner) {
        var marker = source.charAt(owner.at);
        var automatic = owner.node.tagName === 'A' && attr(owner.node, 'data-autolink');
        if (marker !== '*' && marker !== '_' && !automatic) return true;
        var previous = list[indexes.get(group[0]) - 1], following = list[indexes.get(group[group.length - 1]) + 1];
        var before = charBefore(owner.at);
        var after = charAfter(owner.end);
        function text(c) { return c ? c.text : ''; }
        if (text(previous) === text(before) && text(following) === text(after)) return true;
        if (automatic) return false;
        // Markdown flanking sees source punctuation, including a nested code
        // fence, rather than the code span's visible first/last character.
        var size = owner.node.tagName === 'STRONG' ? 2 : 1;
        return markdownFlanks(source.slice(owner.at + size, owner.end - size), text(previous), text(following)) &&
          (marker !== '_' || !/[\p{L}\p{N}]/u.test(text(previous) + text(following)));
      }
      function emit(items, level, base, boundary) {
        if (level === order.length) {
          items.forEach(function (c, i) { if (base + i === caretIndex && caret == null) caret = out.length; append(c.atom ? c.text : c.originalStyles && !c.automatic && !(automatic[indexes.get(c)] && c.rawAt < c.at) && !((/[\\`*_]/.test(c.text) || action.kind !== 'split' && /[\[\]()~#<>!|=^%&]/.test(c.text)) && c.rawAt === c.at) && !(c.text === '!' && list[indexes.get(c) + 1] && list[indexes.get(c) + 1].link) ? source.slice(c.rawAt, c.end) : escaped(c.text, c), true, c); });
          if (base + items.length === caretIndex && caret == null) caret = out.length;
          return;
        }
        var key = order[level], i = 0;
        while (i < items.length) {
          var c = items[i], value = key === 'link' ? c.link : c.styles.indexOf(key) >= 0;
          var j = i + 1;
          while (j < items.length && (key === 'link' ? items[j].link : items[j].styles.indexOf(key) >= 0) === value) j++;
          if (!value) { emit(items.slice(i, j), level + 1, base + i, j === items.length ? boundary : ''); i = j; continue; }
          var lo = i, hi = j;
          var group = items.slice(i, j), ownerTag = { bold: 'STRONG', italic: 'EM', highlight: 'MARK', strike: 'DEL', link: 'A', code: 'CODE', sup: 'SUP', sub: 'SUB', span: 'SPAN', note: 'SPAN' }[key];
          var owner = group[0].owners && group[0].owners.find(function (o) { return o.node.tagName === ownerTag && writerNote(o.node) === (key === 'note'); });
          var unchanged = owner && group.every(function (x) { return !x.typed && x.originalStyles && x.styles.join() === x.originalStyles.join() && x.link === x.originalLink && x.owners.some(function (o) { return o.node === owner.node; }); });
          var whole = unchanged && ownerCharacters(owner).length === group.length;
          var previous = list[indexes.get(group[0]) - 1], following = list[indexes.get(group[group.length - 1]) + 1];
          // Existing underscore italics need new delimiters when an edit changes
          // their flanking word. Everything else in an untouched owner is raw.
          if (variant !== 8 && key !== 'note' && whole && rawFits(group, owner, level) && rawFlanks(group, owner)) {
            if (caretIndex >= base + i && caretIndex <= base + j) caret = out.length + (caretIndex === base + j ? group[group.length - 1].end : group[caretIndex - base - i].at) - owner.at;
            append(source.slice(owner.at, owner.end), false, null, owner.at); i = j; continue;
          }

          if (key !== 'code' && key !== 'note' && !(key === 'span' && owner && /^<span style="white-space:pre">/i.test(source.slice(owner.at, owner.end)))) {
            while (lo < hi && /\s/.test(items[lo].text)) { if (previous && (key === 'link' ? previous.link === value : previous.styles.indexOf(key) >= 0)) break; lo++; }
            while (hi > lo && /\s/.test(items[hi - 1].text)) { if (following && (key === 'link' ? following.link === value : following.styles.indexOf(key) >= 0)) break; hi--; }
          }
          emit(items.slice(i, lo), level + 1, base + i);
          if (hi > lo) {
            var open, close, info;
            if (key === 'link') {
              info = value.nodeType ? linkInfo(value) : value;
              var label = items.slice(lo, hi).map(function (x) { return x.text; }).join('');
              // Code and atom labels use the inline renderer inside the link.
              var styled = items.slice(lo, hi).some(function (x) { return x.styles.length > 0 || x.atom; });
              open = info.angle ? info.angle === 'fenced' ? '<' : '' : info.wiki ? '[[' + info.target + (label === info.target && !styled ? '' : '|') : '[';
              close = info.angle ? info.angle === 'fenced' ? '>' : info.angle === 'plain' ? '' : '<span></span>' : info.wiki ? ']]' : '](' + info.target.replace(/[\\()&<>]/g, '\\$&') + (info.title == null ? '' : ' \"' + info.title.replace(/[\\\"&<>]/g, '\\$&') + '\"') + ')';
              var edgeSpace = info.wiki && /^\s|\s$/.test(label);
              if (edgeSpace) { open += '<span>'; close = '</span>' + close; }
              append(open);
              if (info.angle) {
                items.slice(lo, hi).forEach(function (x, n) { if (base + lo + n === caretIndex && caret == null) caret = out.length; append(x.text, true, x); });
                if (base + hi === caretIndex && caret == null) caret = out.length;
              } else if (info.wiki && !styled) {
                items.slice(lo, hi).forEach(function (x, n) { if (base + lo + n === caretIndex && caret == null) caret = out.length; if (label !== info.target) append(x.atom ? x.text : escaped(x.text, x), true, x); });
                if (label === info.target && caretIndex >= base + lo && caretIndex <= base + hi) caret = out.length - info.target.length + caretIndex - base - lo;
                if (base + hi === caretIndex && caret == null) caret = out.length;
              } else { inLinkLabel = true; emit(items.slice(lo, hi), level + 1, base + lo, close.charAt(0)); inLinkLabel = false; }
              append(close);
              if ((action.kind === 'link' || action.link) && base + hi === caretIndex) caret = out.length;
            } else if (key === 'note') {
              append('%%');
              items.slice(lo, hi).forEach(function (x, n) { if (base + lo + n === caretIndex && caret == null) caret = out.length; out += x.text; });
              if (base + hi === caretIndex && caret == null) caret = out.length;
              out += '%%';
            } else if (key === 'code') {
              var body = items.slice(lo, hi).map(function (x) { return x.text; }).join(''), ticks = items[lo].ticks || '`';
              while (body.indexOf(ticks) >= 0) ticks += '`';
              var originalCode = items[lo].owners && items[lo].owners.find(function (o) { return o.node.tagName === 'CODE'; });
              var originalMembers = originalCode && ownerCharacters(originalCode);
              var originalTicks = originalCode && (/^`+/.exec(source.slice(originalCode.at)) || [''])[0];
              var originalPad = originalMembers && originalMembers.length ? source.slice(originalCode.at + originalTicks.length, originalMembers[0].at) : '';
              var pad = /\S/.test(body) && (originalPad || /^`|`$|^ .* $/.test(body)) ? ' ' : '';
              append(ticks + pad);
              // Tick characters inside code are literal, not adjacent spans.
              items.slice(lo, hi).forEach(function (x, n) { if (base + lo + n === caretIndex && caret == null) caret = out.length; out += x.text; });
              if (base + hi === caretIndex && caret == null) caret = out.length;
              out += pad + ticks;
            } else {
              open = { bold: variant % 3 === 1 ? '__' : '**', italic: variant % 3 === 2 ? '_' : '*', highlight: '==', strike: '~~' }[key];
              var at = indexes.get(items[lo]), stop = indexes.get(items[hi - 1]) + 1;
              var prev = out.slice(-1), next = hi === items.length && boundary ? boundary : list[stop] ? list[stop].text : '';
              var first = items[lo].text, last = items[hi - 1].text;
              var punct = function (c) { return !!c && /[\p{P}\p{S}]/u.test(c); };
              var canOpen = !/\s/.test(first) && (!punct(first) || !prev || /\s/.test(prev) || punct(prev));
              var canClose = !/\s/.test(last) && (!punct(last) || !next || /\s/.test(next) || punct(next));
              // CommonMark cannot delimit every punctuation/letter boundary.
              // Its safe inline HTML spelling preserves that exact style range.
              var tag = { bold: 'strong', italic: 'em', highlight: 'mark', strike: 'del', sup: 'sup', sub: 'sub', span: 'span' }[key];
              if (open && open.charAt(0) === '_') {
                var left = !!prev && !/\s/.test(prev) && (!punct(prev) || !first || /\s/.test(first) || punct(first));
                var right = !!next && !/\s/.test(next) && (!punct(next) || !last || /\s/.test(last) || punct(last));
                canOpen = canOpen && (!left || punct(prev)); canClose = canClose && (!right || punct(next));
              }
              if (!open || variant >= 6 && (key === 'bold' || key === 'italic' || key === 'highlight' || key === 'strike')) canOpen = false;
              var original = items[lo].owners && items[lo].owners.find(function (o) { return o.node.tagName === tag.toUpperCase(); });
              var generated = original && ownerCharacters(original).every(function (c) { return c.typed; });
              var raw = original && !generated && source.slice(original.at, original.end);
              var oldOpen = raw && new RegExp('^<' + tag + (tag === 'span' ? '(?: style="white-space:pre")?' : '') + '>', 'i').exec(raw), oldClose = raw && new RegExp('</' + tag + '>$', 'i').exec(raw);
              close = oldOpen && oldClose ? oldClose[0] : canOpen && canClose ? open : '</' + tag + '>';
              append(oldOpen && oldClose ? oldOpen[0] : canOpen && canClose ? open : '<' + tag + '>');
              emit(items.slice(lo, hi), level + 1, base + lo, close.charAt(0));
              append(close);
            }
          }
          emit(items.slice(hi, j), level + 1, base + hi, j === items.length ? boundary : '');
          i = j;
        }
      }
      // Preserve complete, unchanged original trees before choosing any
      // canonical nesting order. Their historical nesting is part of the source.
      var cursor = 0, point = 0;
      while (point < list.length) {
        var character = list[point], retained = null, members = null;
        if (variant !== 8 && !character.typed && character.originalStyles && character.owners) {
          character.owners.slice().reverse().some(function (owner) {
            var key = ownerKey(owner);
            if (!key || key === 'note') return false;
            var original = ownerCharacters(owner);
            // A raw owner can begin only at its first original character.
            // Reject every interior position before slicing or scanning its characters.
            if (!original.length || original[0] !== character) return false;
            var group = list.slice(point, point + original.length);
            if (!rawFlanks(group, owner)) return false;
            function belongs(c) { return c && c.owners && c.owners.some(function (o) { return o.node === owner.node; }) && (key === 'link' ? c.link === owner.node : c.styles.indexOf(key) >= 0); }
            if (belongs(list[point - 1]) || belongs(list[point + original.length])) return false;
            if (group.length !== original.length || !group.every(function (c, i) { return c === original[i] && !c.typed && c.originalStyles && c.styles.join() === c.originalStyles.join() && c.link === c.originalLink; }) || !rawFits(group, owner, 0)) return false;
            retained = owner; members = group; return true;
          });
        }
        if (!retained) { point++; continue; }
        if (point > cursor) emit(list.slice(cursor, point), 0, cursor);
        if (caret == null && caretIndex >= point && caretIndex <= point + members.length) caret = out.length + (caretIndex === point + members.length ? members[members.length - 1].end : members[caretIndex - point].at) - retained.at;
        append(source.slice(retained.at, retained.end), false, null, retained.at);
        point += members.length; cursor = point;
      }
      if (cursor < list.length || !list.length) emit(list.slice(cursor), 0, cursor);
      // Adjacent star runs can pair differently under CommonMark's rule of
      // three. Check the emitted span against the edited character model, then
      // try the other Markdown delimiter/nesting choices before resorting to
      // HTML. Existing raw owners are retained by each candidate above.
      if (variant == null && typeof document !== 'undefined' && document.createElement) {

        var candidate = { source: out, caret: caret == null ? out.length : caret, escapes: newEscapes };
        var best = matchesEmphasis(candidate, list) ? candidate : null;
        function fallbackCount(value) { return (value.source.match(/<(?:strong|em)>/gi) || []).length; }
        if (!best || fallbackCount(best)) {
          var firstChoice = list.some(function (c) { return c.styles.length || c.link || c.atom; }) ? 1 : 6;
          for (var choice = firstChoice; choice <= 8; choice++) {
            if (choice === 6 && best) break;
            candidate = serialize(list, caretIndex, choice);
            if (matchesEmphasis(candidate, list) && (!best || fallbackCount(candidate) < fallbackCount(best))) best = candidate;
            if (best && !fallbackCount(best)) break;
          }
        }
        if (best) { out = best.source; caret = best.caret; newEscapes = best.escapes || []; }
      }
      // Keep literal indentation visible under normal reader whitespace too,
      // without converting ASCII input to entities or nonbreaking spaces.
      var literalIndent = false;
      if (b.type !== 'inline' && /^[ \t]/.test(out)) for (var edge = 0; edge < list.length && /^[ \t]+$/.test(list[edge].text); edge++) {
        if (!list[edge].originalStyles) { literalIndent = true; break; }
      }
      if (literalIndent) {
        var spaces = /^[ \t]+/.exec(out)[0], open = '<span style="white-space:pre">';
        newEscapes = newEscapes.map(function (at) { return at + open.length + (at >= spaces.length ? 7 : 0); });
        out = open + spaces + '</span>' + out.slice(spaces.length);
        if (caret != null) caret += open.length + (caret > spaces.length ? 7 : 0);
        // The generated HTML boundary can change GFM's URL/image tokenization.
        // Validate the completed spelling, including that boundary, before use.
        if (variant == null && !matchesEmphasis({ source: out }, list)) {
          for (var spelling = 6; spelling <= 8; spelling++) {
            var protectedIndent = serialize(list, caretIndex, spelling);
            if (matchesEmphasis(protectedIndent, list)) return protectedIndent;
          }
        }
      }
      // A literal block opener must not turn a paragraph into another kind.
      if (b.type !== 'inline' && /^ {0,3}(?:(?:-[ \t]*){3,}|-+|=+)[ \t]*$/.test(out)) { var escapeAt = out.search(/[-=]/); newEscapes = newEscapes.map(function (at) { return at + (at >= escapeAt ? 1 : 0); }); newEscapes.push(escapeAt); out = out.replace(/[-=]/, '\\$&'); if (caret != null) caret++; }
      else if (b.type !== 'inline' && /^\d+[.)] /.test(out)) { var escapeAt = /^\d+/.exec(out)[0].length; newEscapes = newEscapes.map(function (at) { return at + (at >= escapeAt ? 1 : 0); }); newEscapes.push(escapeAt); out = out.replace(/^(\d+)([.)])/, function (_, n, marker) { return n + '\\' + marker; }); if (caret != null) caret++; }
      else if (b.type !== 'inline' && /^(?:> |[-+*] )/.test(out)) { newEscapes = newEscapes.map(function (at) { return at + 1; }); newEscapes.unshift(0); out = '\\' + out; if (caret != null) caret++; }
      return { source: out, caret: caret == null ? out.length : caret, escapes: newEscapes };
    }
    function markdownFlanks(body, previous, following) {
      var punct = function (c) { return !!c && /[\p{P}\p{S}]/u.test(c); };
      return body && !/\s/.test(body.charAt(0)) && !/\s/.test(body.slice(-1)) &&
        (!punct(body.charAt(0)) || !previous || /\s/.test(previous) || punct(previous)) &&
        (!punct(body.slice(-1)) || !following || /\s/.test(following) || punct(following));
    }
    // Plain labels already are valid Markdown. Wrapping their existing source
    // needs neither canonical serialization nor repeated endpoint projections.
    if (action.kind === 'link' && action.link && to > from && chars.slice(from, to).every(function (c) { return !c.atom && !c.link && !c.styles.length; })) {
      var lo = chars[from].rawAt, hi = chars[to - 1].end, label = source.slice(lo, hi);
      if (/^[\p{L}\p{N} \t.,!?:;'"“”‘’-]+$/u.test(label) && /\S/.test(label) && label.length === to - from) {
        var leading = /^[ \t]*/.exec(label)[0], trailing = /[ \t]*$/.exec(label)[0], body = label.slice(leading.length, label.length - trailing.length);
        var wrapped = action.link.wiki ? '[[' + action.link.target + (body === action.link.target ? '' : '|' + body) + ']]' : '[' + body + '](' + action.link.target.replace(/[\\()&<>]/g, '\\$&') + ')';
        var replacement = leading + wrapped + trailing, labelAt = lo + leading.length + (action.link.wiki ? 2 + (body === action.link.target ? 0 : action.link.target.length + 1) : 1);
        var linked = { source: source.slice(0, lo) + replacement + source.slice(hi), caret: lo + replacement.length, start: labelAt, end: labelAt + body.length, escapes: [] };
        if (history === 'project') return linked;
        if (history !== false) pushUndo(history || 'link');
        applyEdit(id, lo, hi, replacement, linked.caret); rememberLiteral(linked, []); return linked;
      }
    }
    // A style selection inside one owner leaves its ancestor's original bytes
    // in place, using Markdown wherever the new delimiter edges can flank.
    var styleChars = chars.slice(from, to), styleTag = { bold: 'strong', italic: 'em', highlight: 'mark', strike: 'del' }[action.style];
    if (!derivedAnchors.size && action.kind === 'style' && styleTag && styleChars.length && styleChars.every(function (c) { return !c.atom && c.parent === styleChars[0].parent && c.parent.tagName === styleTag.toUpperCase() && c.styles.indexOf(action.style) >= 0; })) {
      var owner = styleChars[0].owners.find(function (o) { return o.node === styleChars[0].parent; });
      var rawOwner = source.slice(owner.at, owner.end), htmlOpen = new RegExp('^<' + styleTag + '>', 'i').exec(rawOwner);
      var mark = htmlOpen ? htmlOpen[0] : ({ bold: /^(?:\*\*|__)/, italic: /^(?:\*|_)/, highlight: /^==/, strike: /^~~/ }[action.style].exec(rawOwner) || [''])[0];
      var close = htmlOpen ? (new RegExp('</' + styleTag + '>$', 'i').exec(rawOwner) || [''])[0] : mark;
      if (mark && close) {
        var lo = styleChars[0].rawAt, hi = styleChars[styleChars.length - 1].end;
        var left = source.slice(owner.at + mark.length, lo), middle = source.slice(lo, hi), right = source.slice(hi, owner.end - close.length);
        function wrappedPart(raw, previous, following) {
          if (!raw) return '';
          var edge = /^(\s*)([^]*?)(\s*)$/.exec(raw), body = edge[2];
          if (!body) return raw;
          var markdown = action.style === 'italic' ? '*' : mark;
          var keep = markdownFlanks(body, edge[1] ? ' ' : previous, edge[3] ? ' ' : following);
          return edge[1] + (htmlOpen ? mark : keep ? markdown : '<' + styleTag + '>') + body + (htmlOpen ? close : keep ? markdown : '</' + styleTag + '>') + edge[3];
        }
        var leftSource = wrappedPart(left, source.charAt(owner.at - 1), middle.charAt(0));
        var replacement = leftSource + middle + wrappedPart(right, middle.slice(-1), source.charAt(owner.end));
        var unstyled = { source: source.slice(0, owner.at) + replacement + source.slice(owner.end), start: owner.at + leftSource.length, end: owner.at + leftSource.length + middle.length };
        if (history === 'project') return unstyled;
        if (history !== false) pushUndo(history || 'style');
        applyEdit(id, owner.at, owner.end, replacement, unstyled.end);
        setCaret(id, unstyled.start, unstyled.end); return unstyled;
      }
    }
    if (!derivedAnchors.size && action.kind === 'style' && styleTag && styleChars.length && styleChars.every(function (c) { return !c.atom && c.parent === styleChars[0].parent && c.styles.indexOf('code') < 0 && c.styles.indexOf(action.style) < 0; }) && (styleChars[0].styles.length || styleChars[0].link) && !(styleChars[0].link && attr(styleChars[0].link, 'data-autolink'))) {
      var lo = styleChars[0].rawAt, hi = styleChars[styleChars.length - 1].end;
      var opening = '<' + styleTag + '>', closing = '</' + styleTag + '>', body = source.slice(lo, hi);
      var markdown = { bold: '**', italic: '*', highlight: '==', strike: '~~' }[action.style];
      if (markdownFlanks(body, source.charAt(lo - 1), source.charAt(hi))) opening = closing = markdown;
      var styled = { source: source.slice(0, lo) + opening + body + closing + source.slice(hi), start: lo + opening.length, end: hi + opening.length, caret: hi + opening.length };
      if (history === 'project') return styled;
      if (history !== false) pushUndo(history || 'style');
      applyEdit(id, lo, hi, opening + body + closing, styled.caret);
      setCaret(id, styled.start, styled.end); return styled;
    }
    // Updating a whole existing link changes its destination, not the label's
    // spelling or any ancestor delimiters. Partial selections use the shared
    // transaction below so that the unselected label remains outside the link.
    if (action.kind === 'link') {
      var currentLink = active && active.link;
      var linkChars = currentLink && chars.filter(function (c) { return c.link === currentLink; });
      if (currentLink && (from === to || chars.slice(from, to).every(function (c) { return c.link === currentLink; }) && (to - from === linkChars.length || chars.slice(from, to).every(function (c) { return !c.atom && c.parent === chars[from].parent; })))) {
        var members = nodes.filter(function (n) { return currentLink.contains(n.node); });
        var linkStart = members[0].at, linkEnd = members[members.length - 1].at + members[members.length - 1].len;
        var rawLink = source.slice(linkStart, linkEnd), labelSource, labelAt;
        if (rawLink.slice(0, 2) === '[[') {
          var pipe = rawLink.indexOf('|'); labelSource = pipe >= 0 ? rawLink.slice(pipe + 1, -2) : rawLink.slice(2, -2); labelAt = linkStart + (pipe >= 0 ? pipe + 1 : 2);
        } else { labelSource = rawLink.slice(1, rawLink.lastIndexOf('](')); labelAt = linkStart + 1; }
        var replacement = '[[' + action.link.target + (labelSource === action.link.target ? '' : '|' + labelSource) + ']]';
        var pickedCaret = linkStart + replacement.length;
        if (from !== to && to - from < linkChars.length) {
          var labelStart = chars[from].rawAt - labelAt, labelEnd = chars[to - 1].end - labelAt;
          var selectedLabel = labelSource.slice(labelStart, labelEnd);
          var fragment = '[[' + action.link.target + (selectedLabel === action.link.target ? '' : '|' + selectedLabel) + ']]';
          replacement = labelSource.slice(0, labelStart) + fragment + labelSource.slice(labelEnd);
          pickedCaret = linkStart + labelStart + fragment.length;
        }
        var picked = { source: source.slice(0, linkStart) + replacement + source.slice(linkEnd), caret: pickedCaret };
        if (history === 'project') return picked;
        if (history !== false) pushUndo(history || 'link');
        applyEdit(id, linkStart, linkEnd, replacement, picked.caret); return picked;
      }
    }
    // Inline code owns its delimiter and optional invisible padding. A body
    // edit can make that padding visible, or collide with the delimiter. Repair
    // only this span; all surrounding source and inline ancestors remain raw.
    if (!derivedAnchors.size && action.kind === 'text' && !action.link && !/\n/.test(action.text || '') && !(typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start)) {
      var codeRun = chars.slice(from, to)[0] || active;
      var codeOwner = codeRun && codeRun.owners && codeRun.owners.find(function (o) { return o.node.tagName === 'CODE'; });
      if (codeOwner && !(/%|\]/.test(action.text || '') && /%%|\[[A-Z][A-Z0-9 ]+:/.test(source)) && chars.slice(from, to).every(function (c) { return c.parent === codeRun.parent; })) {
        var members = ownerCharacters(codeOwner);
        var first = members.filter(function (c) { return c.end <= start; }).length, last = members.filter(function (c) { return c.end <= end; }).length;
        var head = members.slice(0, first).map(function (c) { return c.text; }).join('');
        var body = head + (action.text || '') + members.slice(last).map(function (c) { return c.text; }).join('');
        var ticks = (/^`+/.exec(source.slice(codeOwner.at)) || [''])[0];
        if (body && ticks) {
          var oldPad = source.slice(codeOwner.at + ticks.length, members[0].at), pad = '';
          while (body.indexOf(ticks) >= 0) ticks += '`';
          if (/\S/.test(body) && (oldPad || /^`|`$|^ .* $/.test(body))) pad = ' ';
          var replacement = ticks + pad + body + pad + ticks;
          var codeEdit = { source: source.slice(0, codeOwner.at) + replacement + source.slice(codeOwner.end), caret: codeOwner.at + ticks.length + pad.length + head.length + (action.text || '').length };
          if (history === 'project') return codeEdit;
          if (history !== false) pushUndo(history || (action.text ? 'replace' : 'delete'));
          applyEdit(id, codeOwner.at, codeOwner.end, replacement, codeEdit.caret); return codeEdit;
        }
      }
    }
    // Raw HTML is opaque to the editor's model: tags show as text, so a
    // reserialized paragraph can escape a tag with no visible change. In a
    // paragraph that holds raw HTML or an angle construct, a plain edit is a
    // byte splice: only the edited source range changes. The splice is taken
    // only when the result keeps the intended visible model and every raw
    // token outside the edit stays in place, byte for byte, with no new one;
    // otherwise the edit goes through the serializer below, unchanged.
    function rawTokens(value) {
      var pattern = /(?<!\\)(?:\\\\)*(?:<!--(?:>|->|[^]*?-->)|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<![A-Za-z][^>]*>|<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n][^<>]*?)?\/?>|<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>|<[^<>\s@]+@[^<>\s]+>|<[^<>\s]+>)/g, found = [], token;
      while ((token = pattern.exec(value))) { var lead = /^(?:\\\\)*/.exec(token[0])[0].length; found.push({ at: token.index + lead, raw: token[0].slice(lead) }); }
      return found;
    }
    function sourceSplice() {
      if (surface || (b.type !== 'p' && b.type !== 'inline') || typeof document === 'undefined' || !document.createElement) return null;
      if (pendingBefore.length || runEscapes.length || typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id) return null;
      if (source.indexOf('<') < 0) return null;
      var tokens = rawTokens(source);
      var selected = chars.slice(from, to), a, z, spellings, wanted;
      if (selected.some(function (c) { return c.atom; })) return null;
      if (action.kind === 'text' && !action.link) {
        var text = String(action.text || '');
        // Markdown characters and line breaks need the serializer's spelling.
        if (/[\\`*_\[\]()~<>#|=^%&\n\r\t]/.test(text)) return null;
        a = selected.length ? selected[0].rawAt : start; z = selected.length ? selected[selected.length - 1].end : end;
        // A typed ! before [ would open an image.
        if (/!$/.test(text) && source.charAt(z) === '[') return null;
        // Removing all of a styled element's words also removes its marks.
        if (!text && selected.some(function (c) { return (c.owners || []).some(function (o) { return /^(?:STRONG|EM|MARK|DEL|CODE|A|SUP|SUB|SPAN)$/.test(o.node.tagName) && ownerCharacters(o).every(function (x) { return selected.indexOf(x) >= 0; }); }); })) return null;
        spellings = [['', text, '']];
        // Typed indentation at a line start takes the serializer's own
        // spelling (literalIndent): the site drops bare leading whitespace.
        var lineAt = source.lastIndexOf('\n', a - 1) + 1, typedIndent = /^[ \t]+/.exec(text);
        if (typedIndent && a === lineAt && !/^[ \t]/.test(source.slice(z)) && b.type !== 'inline') {
          var indentOpen = '<span style="white-space:pre">' + typedIndent[0] + '</span>';
          spellings = [[indentOpen, text.slice(typedIndent[0].length), '', [{ at: 0, raw: '<span style="white-space:pre">' }, { at: indentOpen.length - 7, raw: '</span>' }]]];
        }
        wanted = chars.slice(); wanted.splice.apply(wanted, [from, to - from].concat(literal(text, active)));
      } else if (action.kind === 'style' && /^(?:bold|italic|strike|code)$/.test(action.style) && selected.length) {
        // Adding a style to plain words only; removing or nesting is the serializer's.
        var words = selected.map(function (c) { return c.text; }).join(''), mark = { bold: '**', italic: '*', strike: '~~', code: '`' }[action.style];
        var tag = { bold: 'strong', italic: 'em', strike: 'del', code: 'code' }[action.style];
        a = selected[0].rawAt; z = selected[selected.length - 1].end;
        if (source.slice(a, z) !== words || /^\s|\s$/.test(words) || /[<>&]/.test(words)) return null;
        if (selected.some(function (c) { return c.styles.length || c.link || c.automatic; })) return null;
        // Markdown first; the editor's own HTML form where delimiters cannot open or close.
        spellings = [[mark, words, mark], ['<' + tag + '>', words, '</' + tag + '>']];
        if (mark === '`' && /`/.test(words)) spellings.shift();
        wanted = chars.map(function (c) { return selected.indexOf(c) >= 0 ? Object.assign({}, c, { styles: c.styles.concat([action.style]) }) : c; });
      } else return null;
      // An edit inside a raw token changes that token, and a removed angle is
      // generated spelling: the serializer owns both.
      if (/[<>]/.test(source.slice(a, z))) return null;
      if (tokens.some(function (t) { var e = t.at + t.raw.length; return z > a ? a < e && z > t.at : a > t.at && a < e; })) return null;
      // An opener in the edited word that is not a kept token (<? <! </ or a
      // doubled, generated angle), or the editor's own empty separator span,
      // keeps the serializer's canonical spelling.
      function opener(text, lo, hi, starts) {
        var left = text.slice(0, lo).search(/\S*$/), right = hi + text.slice(hi).search(/\s|$/);
        if (text.slice(left, right).indexOf('<span></span>') >= 0) return true;
        for (var at = left; at < right; at++) if (text.charAt(at) === '<' && /^<[?!\/<]|<$/.test(text.slice(at - 1 < 0 ? at : at - 1, at + 2).replace(/^[^<]/, '')) && starts.indexOf(at) < 0 && !/(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(Math.max(0, at - 8), at))) return true;
        return false;
      }
      for (var i = 0; i < spellings.length; i++) {
        var open = spellings[i][0], close = spellings[i][2], inserted = open + spellings[i][1] + close;
        var value = source.slice(0, a) + inserted + source.slice(z), shift = inserted.length - (z - a);
        // Leading whitespace on a line is dropped by the site: an edit within
        // it keeps the serializer's spelling (literalIndent).
        var lineStart = value.lastIndexOf('\n', a - 1) + 1, indent = /^[ \t]*/.exec(value.slice(lineStart))[0].length;
        if (indent && a <= lineStart + indent) continue;
        // Every raw token outside the edit stays in place; the only new ones
        // are the style's own HTML tags.
        var expected = tokens.map(function (t) { return { at: t.at >= z ? t.at + shift : t.at, raw: t.raw }; });
        if (spellings[i][3]) spellings[i][3].forEach(function (t) { expected.push({ at: a + t.at, raw: t.raw }); });
        else if (open.charAt(0) === '<') expected.push({ at: a, raw: open }, { at: a + inserted.length - close.length, raw: close });
        expected.sort(function (x, y) { return x.at - y.at; });
        if (rawTokens(value).map(function (t) { return t.at + ':' + t.raw; }).join('\n') !== expected.map(function (t) { return t.at + ':' + t.raw; }).join('\n')) continue;
        if (typeof classify === 'function' && b.type === 'p' && classify(value) !== 'p') continue;
        var angle = opener(value, a, a + inserted.length, expected.map(function (t) { return t.at; })) || opener(source, a, z, tokens.map(function (t) { return t.at; }));
        if (angle) continue;
        // The edit view shows a Markdown hard break as its marker, not as a character.
        if (!matchesEmphasis({ source: value, full: b.type !== 'inline' }, wanted) && !(/\n/.test(value) && matchesEmphasis({ source: value, full: b.type !== 'inline', breaks: false }, wanted))) continue;
        var caret = a + inserted.length;
        return action.kind === 'style' ? { source: value, caret: caret, start: a + open.length, end: caret - close.length, escapes: [] } : { source: value, caret: caret, escapes: [] };
      }
      return null;
    }
    var spliced = sourceSplice();
    if (spliced) {
      if (history === 'project') return spliced;
      if (history !== false) pushUndo(history || (action.text ? 'replace' : 'delete'));
      applyEdit(id, 0, source.length, spliced.source, spliced.caret); rememberLiteral(spliced, []);
      if (action.kind === 'style') setCaret(id, spliced.start, spliced.end);
      return spliced;
    }
    // Text within one visible source run needs no block serialization. Expand
    // escapes at the edit edge, and spell only new literal characters. Fall back
    // when changing delimiter flanking or a code fence requires new delimiters.
    if (action.kind === 'text' && !action.link && !/\n/.test(action.text || '') && !(typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start)) {
      var selectedChars = chars.slice(from, to), run = selectedChars[0] || active;
      var sameRun = !selectedChars.length || run && selectedChars.every(function (c) { return !c.atom && c.parent === run.parent; });
      var rawStart = selectedChars.length ? selectedChars[0].rawAt : start;
      var rawEnd = selectedChars.length ? selectedChars[selectedChars.length - 1].end : end;
      if (!selectedChars.length && /^h[1-6]$/.test(b.type) && chars.length && /^[ \t]+#+[ \t]*$/.test(source.slice(chars[chars.length - 1].end)) && start > chars[chars.length - 1].end) rawStart = rawEnd = chars[chars.length - 1].end;
      if (!selectedChars.length && active && active.at === start && active.rawAt < start) rawStart = rawEnd = active.rawAt;
      var codeOwner = run && run.owners && run.owners.find(function (o) { return o.node.tagName === 'CODE'; });
      var safe = !derivedAnchors.size && sameRun && (!run || !run.atom) && !source.slice(rawStart, rawEnd).includes('\n');
      if (continuing && (runEscapes.length || /[\\`*_\[\]()~<>#|=^%&]/.test(action.text || '') || /<\?|<!/.test(source.slice(0, rawStart) + (action.text || '') + source.slice(rawEnd)))) safe = false;
      // Backslashes inside autolinks are displayed literally. A label edit
      // needs an explicit link so escaped writer input remains just its label.
      if (chars.some(function (c) { return c.link && attr(c.link, 'data-autolink'); }) || /<[^<>\s]+>/.test(source.slice(0, rawStart) + (action.text || '') + source.slice(rawEnd))) safe = false;
      if (run && run.styles.some(function (k) { return k !== 'code'; })) {
        // Spaces at delimiter edges, or word edits immediately outside a style,
        // may require closing/reopening an ancestor. The general path owns those.
        var edge = !selectedChars.length && (!active || active.at !== start && (!from || chars[from - 1].end !== start));
        if (edge || /^\s|\s$/.test(action.text || '') || selectedChars.length && (rawStart === run.owners[0].at || rawEnd === run.owners[0].end)) safe = false;
      }
      if (codeOwner && /`/.test(action.text || '') || !codeOwner && /[\[*_]/.test(action.text || '')) safe = false;
      if (!action.text && run && selectedChars.length) {
        if (run.owners.some(function (owner) { return /^(?:STRONG|EM|MARK|DEL|CODE|A|SUP|SUB|SPAN)$/.test(owner.node.tagName) && ownerCharacters(owner).every(function (x) { return selectedChars.indexOf(x) >= 0; }); })) safe = false;
      }
      if (!action.text && run && selectedChars.length) {
        run.owners.forEach(function (owner) {
          var rawOwner = source.slice(owner.at, owner.end);
          if (!/^(?:\*|_|==|~~)/.test(rawOwner)) return;
          var remaining = chars.filter(function (x) { return x.owners && x.owners.some(function (o) { return o.node === owner.node; }) && selectedChars.indexOf(x) < 0; });
          if (remaining.length && (/\s/.test(remaining[0].text) || /\s/.test(remaining[remaining.length - 1].text))) safe = false;
        });
      }
      var leftChar = chars[from - 1], rightChar = chars[to];
      if ([leftChar, rightChar].some(function (x) { return x && (x.styles.indexOf('italic') >= 0 || x.styles.indexOf('bold') >= 0) && (!run || x.parent !== run.parent); })) safe = false;
      // Preserve Markdown's italic flanking rule when inserting next to a run.
      if (!selectedChars.length && /[\p{L}\p{N}]/u.test(action.text || '') && chars.some(function (c) { return c.styles.indexOf('italic') >= 0 && (c.at > start && source.slice(start, c.at).match(/^[*_]+$/) || c.end < start && source.slice(c.end, start).match(/^[*_]+$/)); })) safe = false;
      if (safe) {
        var literalText = String(action.text || '');
        var rawCandidate = source.slice(0, rawStart) + literalText + source.slice(rawEnd);
        var bare = /https?:\/\/|www\.|@/i.test(rawCandidate) ? automaticPositions(rawCandidate) : [];
        var text = codeOwner ? literalText : literalText.replace(/[\\`*_\[\]()~<>#|=^%&]/g, function (ch, i) { return bare[rawStart + i] ? ch : '\\' + ch; }).replace(/!(?=\[|$)/g, function (ch, at, value) { return at + 1 < value.length || source.charAt(rawEnd) === '[' ? '\\!' : '!'; });
        if (!codeOwner && /https?:\/\/|www\.|@/i.test(rawCandidate)) {
          var wantedRaw = chars.slice();
          wantedRaw.splice.apply(wantedRaw, [from, to - from].concat(literal(literalText, active)));
          var rawPrefix = structuralPrefix(source.split('\n')[0]);
          if ([].every.call(literalText, function (ch, i) { return !/[\\`*_\[\]()~<>#|=^%&]/.test(ch) || bare[rawStart + i] || /[)_*\[\](]/.test(ch) && /https?:\/\/|www\./i.test(rawCandidate); }) && matchesEmphasis({ source: rawCandidate.slice(rawPrefix) }, wantedRaw)) text = literalText;
        }
        var generated = runEscapes.filter(function (at) { return at < rawStart; }), offset = 0;
        if (!codeOwner) for (var i = 0; i < literalText.length; i++) {
          if (text.slice(offset, offset + 2) === '\\' + literalText.charAt(i)) { generated.push(rawStart + offset); offset++; }
          offset++;
        }
        runEscapes.filter(function (at) { return at >= rawEnd; }).forEach(function (at) { generated.push(at + text.length - (rawEnd - rawStart)); });
        var directClean = cleanSpelling(source.slice(0, rawStart) + text + source.slice(rawEnd), generated, rawStart + text.length, b.type === 'inline');
        var cleanedStart = rawStart - (directClean.removed || []).filter(function (at) { return at < rawStart; }).length;
        text = directClean.source.slice(cleanedStart, directClean.source.length - source.length + rawEnd);
        var candidate = directClean.source;
        if (JSON.stringify(rawHTML(candidate)) !== JSON.stringify(rawHTML(source))) safe = false;
        if (b.type === 'p' && candidate.includes('\n') && MD().parse(candidate).blocks.some(function (block) { return block.type === 'table'; })) safe = false;
        // A continuation is a paragraph even inside a list or quote. Compare
        // its body, after the original structural prefix, before taking a splice.
        if (b.type !== 'inline') {
          var lineAt = source.lastIndexOf('\n', rawStart - 1) + 1;
          var lineEnd = source.indexOf('\n', rawEnd);
          if (lineEnd < 0) lineEnd = source.length;
          var prefixLength = structuralPrefix(source.slice(lineAt, lineEnd));
          var nextLine = candidate.slice(lineAt, lineEnd + candidate.length - source.length);
          if (opensBlock(nextLine.slice(prefixLength))) safe = false;
        }
        if (safe && typeof document !== 'undefined' && document.createElement && typeof MD === 'function' && MD().renderInline) {
          var expectedDirect = chars.slice();
          expectedDirect.splice.apply(expectedDirect, [from, to - from].concat(literal(action.text, active)));
          var inlineCandidate = b.type === 'inline' ? candidate : candidate.slice(typeof markerLen === 'function' ? markerLen(candidate) : 0);
          if (!matchesEmphasis({ source: inlineCandidate }, expectedDirect)) safe = false;
        }
        if (safe && !codeOwner && (/https?:\/\/|www\./i.test(candidate) || chars.some(function (c) { return c.automatic; }))) {
          var wanted = chars.slice();
          wanted.splice.apply(wanted, [from, to - from].concat(literal(literalText, active)));
          if (!matchesEmphasis({ source: candidate.slice(structuralPrefix(source.split('\n')[0])) }, wanted)) safe = false;
        }
        // Removing a run's final content also removes its empty delimiters.
        if (safe) {
          var direct = retainUntouched({ source: directClean.source, spellingFallback: !!directClean.spellingFallback, caret: directClean.caret, escapes: directClean.escapes }, expectedDirect);
          directClean = direct;
          if (history === 'project') return direct;
          if (history !== false) pushUndo(history || (action.text ? 'replace' : 'delete'));
          applyEdit(id, 0, source.length, directClean.source, direct.caret); rememberLiteral(direct, directClean.escapes); return direct;
        }
      }
    }
    if ((action.kind === 'style' || action.kind === 'text' && !action.link) && typeof document !== 'undefined' && document.createElement) {
      var sample = chars.slice(from, to)[0] || active, selection = chars.slice(from, to);
      var styleFor = { STRONG: 'bold', EM: 'italic', MARK: 'highlight', DEL: 'strike', CODE: 'code', SUP: 'sup', SUB: 'sub', SPAN: 'span' };
      var intent = typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start ? typingStyles : null;
      var window = sample && sample.owners && sample.owners.find(function (owner, index) {
        if (!/^(?:STRONG|EM|MARK|DEL|SUP|SUB|SPAN)$/.test(owner.node.tagName)) return false;
        var raw = source.slice(owner.at, owner.end), name = owner.node.tagName.toLowerCase();
        var open = new RegExp('^<' + name + (name === 'span' ? '(?: style="white-space:pre")?' : '') + '>', 'i').exec(raw), close = new RegExp('</' + name + '>$', 'i').exec(raw);
        if ((!open || !close) && typingRun && !/\n/.test(action.text || '')) {
          var delimiter = /^(\*\*|__|\*|_|==|~~)/.exec(raw);
          if (delimiter && raw.endsWith(delimiter[0])) open = close = delimiter;
        }
        if (typingRun && ownerCharacters(owner).every(function (c) { return c.typed; })) return false;
        if (!open || !close || start < owner.at + open[0].length || end > owner.end - close[0].length || !selection.every(function (c) { return c.owners && c.owners.some(function (o) { return o.node === owner.node; }); })) return false;
        var outside = sample.owners.slice(index).map(function (o) { return styleFor[o.node.tagName]; }).filter(Boolean);
        if (action.kind === 'style' && outside.indexOf(action.style) >= 0 || intent && outside.some(function (key) { return intent.styles.indexOf(key) < 0; })) return false;
        owner.open = open[0]; owner.close = close[0]; owner.outside = outside; return true;
      });
      if (window) {
        var bodyStart = window.at + window.open.length, bodyEnd = window.end - window.close.length;
        var body = source.slice(bodyStart, bodyEnd), probe = document.createElement('div');
        var context = typeof doc !== 'undefined' && doc || {};
        probe.innerHTML = MD().renderInline(body, { editSource: true, references: context.references, footnoteNumbers: context.footnoteNumbers, footnotes: context.footnotes });
        probe.cwLiteralContinuation = continuing; probe.cwSourcePrefix = source.slice(0, bodyStart); probe.cwSourceSuffix = source.slice(bodyEnd); probe.cwLiteralEscapes = runEscapes.filter(function (at) { return at >= bodyStart && at < bodyEnd; }).map(function (at) { return at - bodyStart; });
        if (probe.textContent === body) {
          var originalType = b.type, savedIntent = typeof typingStyles !== 'undefined' ? typingStyles : null, projection, projectedRun;
          var bodyFrom = chars.filter(function (c) { return c.end <= bodyStart; }).length;
          try {
            b.source = body; b.type = 'inline';
            if (intent) typingStyles = { blockId: id, at: start - bodyStart, styles: intent.styles.filter(function (key) { return window.outside.indexOf(key) < 0; }), run: typingRun && { from: typingRun.from - bodyFrom, styles: typingRun.styles.map(function (styles) { return styles.filter(function (key) { return window.outside.indexOf(key) < 0; }); }) } };
            projection = replaceVisible(id, start - bodyStart, end - bodyStart, action, 'project', probe, work);
            projectedRun = projection && projection.typingRun;
          } finally { b.source = source; b.type = originalType; if (typeof typingStyles !== 'undefined') typingStyles = savedIntent; }
          if (projection && projection.source != null) {
            var gaps = [], bodySource = projection.source.replace(/\n(?:[ \t]*\n)+/g, function (gap, at) { gaps.push({ at: at, end: at + gap.length }); return window.close + gap + window.open; });
            function projectedPoint(point) {
              if (point == null) return point;
              var delta = 0; gaps.forEach(function (gap) { if (point > gap.at) delta += window.close.length; if (point >= gap.end) delta += window.open.length; });
              return bodyStart + point + delta;
            }
            var local = { source: source.slice(0, bodyStart) + bodySource + source.slice(bodyEnd), escapes: (projection.escapes || []).map(projectedPoint), caret: projectedPoint(projection.caret == null ? projection.end : projection.caret), start: projectedPoint(projection.start), end: projectedPoint(projection.end), typingRun: projectedRun && { from: projectedRun.from + bodyFrom, styles: projectedRun.styles.map(function (styles) { return styles.concat(window.outside); }) } };
            var windowChars = chars.filter(function (c) { return c.at >= window.at && c.end <= window.end; });
            var windowFrom = chars.filter(function (c) { return c.end <= window.at; }).length;
            var expectedWindow = windowChars.slice();
            if (action.kind === 'text') expectedWindow.splice.apply(expectedWindow, [from - windowFrom, to - from].concat(literal(action.text, active)));
            else expectedWindow = expectedWindow.map(function (c, i) {
              if (i < from - windowFrom || i >= to - windowFrom) return c;
              var styles = c.styles.filter(function (key) { return key !== action.style; });
              if (!selection.every(function (x) { return x.styles.indexOf(action.style) >= 0; })) styles.push(action.style);
              return { text: c.text, styles: styles };
            });
            // The retained outer delimiters must still mean the edited model.
            // Invalid flanking (notably a trailing space) takes the same general
            // serializer and validation as every other visible transaction.
            var expectedBlock = chars.slice(0, windowFrom).concat(expectedWindow, chars.slice(windowFrom + windowChars.length));
            var wholeCandidate = source.slice(0, bodyStart) + bodySource + source.slice(bodyEnd);
            if (JSON.stringify(rawHTML(wholeCandidate).filter(function (token) { return /^<!/.test(token); })) === JSON.stringify(rawHTML(source).filter(function (token) { return /^<!/.test(token); })) && matchesEmphasis({ source: wholeCandidate.slice(structuralPrefix(source.split('\n')[0])) }, expectedBlock)) {
            if (history === 'project') return local;
            if (history !== false) pushUndo(history || (action.text ? 'replace' : 'delete'));
            if (intent) {
              intent.at = local.caret;
              if (projectedRun) intent.run = { from: projectedRun.from + bodyFrom, styles: projectedRun.styles.map(function (styles) { return styles.concat(window.outside); }) };
            }
            applyEdit(id, bodyStart, bodyEnd, bodySource, local.caret); rememberLiteral(local, local.escapes);
            if (action.kind === 'style') setCaret(id, local.start, local.end);
            return local;
            }
          }
        }
      }
    }
    var selected = chars.slice(from, to);
    if (action.kind === 'link') {
      var touched = selected.map(function (c) { return c.link; }).filter(Boolean);
      if (from === to && active && active.link) {
        var link = active.link;
        while (from > 0 && chars[from - 1].link === link) from--;
        while (to < chars.length && chars[to].link === link) to++;
        touched.push(link);
      } else if (from === to) {
        action = { kind: 'text', text: action.link.target, link: action.link };
      }
      chars.forEach(function (c) { if (touched.indexOf(c.link) >= 0) c.link = null; });
      for (var j = from; j < to; j++) if (!chars[j].atom) chars[j].link = action.link;
    } else if (action.kind === 'style') {
      var off = selected.length && selected.every(function (c) { return c.styles.indexOf(action.style) >= 0; });
      selected.forEach(function (c) { c.styles = c.styles.filter(function (s) { return s !== action.style; }); if (!off) c.styles.push(action.style); });
    }
    // Preserve each structural prefix. Only the affected block is serialized;
    // every other block retains its original source bytes.
    var rows = [], pos = 0;
    var visibleLines = [], lineStart = 0;
    for (var lineEnd = 0; lineEnd < source.length; lineEnd++) if (source.charAt(lineEnd) === '\n' && !chars.some(function (c) { return c.at === lineEnd && c.styles.indexOf('code') >= 0; })) { visibleLines.push(source.slice(lineStart, lineEnd)); lineStart = lineEnd + 1; }
    visibleLines.push(source.slice(lineStart));
    visibleLines.forEach(function (line) {
      var prefixSize = structuralPrefix(line);
      if (b.type === 'list' && !prefixSize) prefixSize = (/^[ \t]+/.exec(line) || [''])[0].length;
      var hard = /  $/.test(line) && source.charAt(pos + line.length) === '\n';
      var contentEnd = line.length - (hard ? 2 : 0);
      if (!chars.some(function (c) { return c.at >= pos && c.at < pos + contentEnd; })) prefixSize = contentEnd;
      var prefix = line.slice(0, prefixSize);
      rows.push({ at: pos, end: pos + line.length, prefix: prefix, suffix: hard ? '  ' : '', chars: chars.filter(function (c) { return c.at >= pos + prefix.length && c.at < pos + contentEnd; }) });
      pos += line.length + 1;
    });
    var firstRow = 0, lastRow = 0;
    rows.forEach(function (r, i) { if (r.at <= start) firstRow = i; if (r.at <= end) lastRow = i; });
    var headChars = rows[firstRow].chars.filter(function (c) { return c.end <= start; });
    var tailChars = rows[lastRow].chars.filter(function (c) { return c.at >= end; });
    var caretInRow = headChars.length, caretRow = firstRow;
    function trim(list) { while (list.length && /\s/.test(list[0].text)) list.shift(); while (list.length && /\s/.test(list[list.length - 1].text)) list.pop(); return list; }
    if (action.kind === 'split') {
      // A paragraph cannot begin or end with a space, so the split drops the spaces around
      // the caret. The new block keeps them for the Backspace that joins the halves again.
      var joint = [headChars.slice(headChars.length - (/[ \t]*$/.exec(headChars.map(function (x) { return x.text; }).join('')) || [''])[0].length).map(function (x) { return x.text; }).join(''),
        (/^[ \t]*/.exec(tailChars.map(function (x) { return x.text; }).join('')) || [''])[0]];
      var left = serialize(trim(headChars), headChars.length), right = serialize(trim(tailChars), 0);
      var before = rows.slice(0, firstRow).map(function (r) { return r.prefix + serialize(r.chars).source + (r.suffix || ''); });
      var after = rows.slice(lastRow + 1).map(function (r) { return r.prefix + serialize(r.chars).source + (r.suffix || ''); });
      var prefix = rows[firstRow].prefix, nextPrefix = prefix.replace(/(\d+)([.)])/, function (_, n, d) { return (+n + 1) + d; });
      var leftSource = before.concat(prefix + left.source).join('\n');
      var rightSource = right.source + (after.length ? '\n' + after.join('\n') : '');
      if (action.soft) {
        var lead = /^(?:\s*>)/.test(prefix) ? prefix : new Array(prefix.length + 1).join(' ');
        return { source: leftSource + '  \n' + lead + rightSource, caret: leftSource.length + 3 + lead.length };
      }
      return { head: leftSource, tail: rightSource, prefix: nextPrefix, caret: leftSource.length + 1 + nextPrefix.length, joint: joint };
    }
    if (action.kind === 'link' && to > from) {
      var last = chars[to - 1];
      rows.forEach(function (r, index) { var at = r.chars.indexOf(last); if (at >= 0) { caretRow = index; caretInRow = at + 1; } });
    }
    if (action.kind === 'text') {
      var add = literal(action.text, active);
      if (/^h[1-6]$/.test(b.type) || host.cwHeading) add.forEach(function (c) { if (c.text === '\n') c.breakSource = '<br>'; });
      if (typingRun) {
        typingRun.styles.splice.apply(typingRun.styles, [Math.max(0, from - typingRun.from), to - from].concat(add.map(function (c) { return c.styles.slice(); })));
      }
      if (action.link) add.forEach(function (c) { c.link = action.link; });
      rows.splice(firstRow, lastRow - firstRow + 1, { at: rows[firstRow].at, end: rows[lastRow].end, prefix: rows[firstRow].prefix, suffix: rows[lastRow].suffix, chars: headChars.concat(add, tailChars) });
      caretInRow += add.length;
    }
    var result = '', nextCaret = 0, selectionStart = 0, selectionEnd = 0, resultEscapes = [];
    function writeRows(variant) {
      result = ''; nextCaret = selectionStart = selectionEnd = 0; resultEscapes = [];
    rows.forEach(function (r, index) {
      var chunk = serialize(r.chars, index === caretRow ? caretInRow : null, variant);
      if (action.kind === 'text' && /\n/.test(action.text || '') && (b.type === 'list' || b.type === 'quote' || b.type === 'callout' || b.type === 'footnote-def')) {
        var continuation = b.type === 'footnote-def' ? '    ' : r.prefix.replace(/(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/g, function (marker) { return ' '.repeat(marker.length); });
        var beforeCaret = chunk.source.slice(0, chunk.caret);
        chunk.caret += (beforeCaret.match(/\n/g) || []).length * continuation.length;
        chunk.escapes = (chunk.escapes || []).map(function (at) { return at + (chunk.source.slice(0, at).match(/\n/g) || []).length * continuation.length; });
        chunk.source = chunk.source.replace(/\n/g, '\n' + continuation);
      }
      if (index) result += '\n';
      if (index === caretRow) nextCaret = result.length + r.prefix.length + chunk.caret;
      // Selection mapping comes from the same serialization as caret mapping.
      var lo = r.chars.filter(function (c) { return c.end <= start; }).length;
      var hi = r.chars.filter(function (c) { return c.end <= end; }).length;
      if (action.kind !== 'text' && index === firstRow) selectionStart = result.length + r.prefix.length + (index === caretRow && lo === caretInRow ? chunk.caret : serialize(r.chars, lo, variant).caret);
      if (action.kind !== 'text' && index === lastRow) selectionEnd = lo === hi && index === firstRow ? selectionStart : result.length + r.prefix.length + (index === caretRow && hi === caretInRow ? chunk.caret : serialize(r.chars, hi, variant).caret);
      (chunk.escapes || []).forEach(function (at) { resultEscapes.push(result.length + r.prefix.length + at); });
      result += r.prefix + chunk.source + (r.suffix || '');
    });
    }
    writeRows();
    if (b.type === 'p' && source.includes('\n')) {
      var expectedFull = [];
      rows.forEach(function (row, index) { if (index) expectedFull.push({ text: '\n', styles: [] }); expectedFull = expectedFull.concat(row.chars); });
      // Raw owners validated on one row may contain an unmatched delimiter
      // that pairs with a later row. Validate the complete paragraph once.
      if (!matchesEmphasis({ source: result }, expectedFull)) writeRows(8);
    }
    var cleaned = cleanSpelling(result, resultEscapes, nextCaret, b.type === 'inline');
    function cleanedPoint(at) { return at - resultEscapes.filter(function (p) { return p < at && cleaned.removed.indexOf(p) >= 0; }).length; }
    var next = { source: cleaned.source, spellingFallback: !!cleaned.spellingFallback, escapes: cleaned.escapes, caret: cleaned.caret, start: cleaned.removed ? cleanedPoint(selectionStart) : selectionStart, end: cleaned.removed ? cleanedPoint(selectionEnd) : selectionEnd, typingRun: typingRun };
    var wantedSource = [];
    rows.forEach(function (row, index) { if (index) wantedSource.push({ text: '\n', styles: [] }); wantedSource = wantedSource.concat(row.chars); });
    next = retainUntouched(next, wantedSource);
    if (history === 'project') return next;
    if (history !== false) pushUndo(history || (action.text ? 'replace' : 'delete'));
    var typed = typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === start;
    if (typed) { typingStyles.at = next.caret; typingStyles.run = typingRun; }
    applyEdit(id, 0, source.length, next.source, next.caret); rememberLiteral(next, next.escapes);
    if (action.kind === 'style') setCaret(id, next.start, next.end);
    return next;
  }
  function deleteVisible(type, c, deferNative) {
    var host = editOf(focusId), b = blockOf(focusId);
    if (!host || !b) return false;
    if (b.type === 'p' && b.source.includes('\n') && host.textContent === b.source && !host.querySelector('.cw-mk')) {
      var breakProjection = document.createElement('div');
      breakProjection.innerHTML = MD().renderInline(b.source, { editSource: true });
      if (breakProjection.textContent === b.source) host = breakProjection;
    }
    if (!host.querySelector || !host.querySelector('.cw-mk')) {
      var plainStart = c.start, plainEnd = c.end;
      if (plainStart === plainEnd) { if (/Backward$/.test(type)) plainStart = Math.max(0, plainStart - 1); else plainEnd = Math.min(b.source.length, plainEnd + 1); }
      var remaining = b.source.slice(0, plainStart) + b.source.slice(plainEnd);
      if (b.type !== 'p' || !/^(?:[-+*>]|#{1,6})$/.test(remaining)) return false;
    }
    var start = c.start, end = c.end;
    if (start === end) {
      // A rendered hard break has no text node. Its hidden source run is one
      // deletion unit, so Backspace must not skip back into the preceding word.
      var breakRun = sourceNodes(host).find(function (n) { return hiddenSource(n.node) && /^(?:  \n|<br\s*\/?>)$/i.test(n.node.nodeValue) && (/Backward$/.test(type) ? n.at + n.len === start : n.at === start); });
      if (breakRun) {
        var range = { start: breakRun.at, end: breakRun.at + breakRun.len };
        if (deferNative) return range;
        pushUndo('delete'); applyEdit(focusId, range.start, range.end, '', range.start); return true;
      }

      var back = /Backward$/.test(type);
      var candidates = interactionRuns(host);
      if (/Word/.test(type)) {
        var visible = '', positions = [], offset = 0;
        candidates.forEach(function (n) {
          for (var j = 0; j < n.len; j++) {
            positions.push(n.at + j);
            visible += n.node.nodeValue.charAt(j);
            if (n.at + j < c.start) offset++;
          }
        });
        var edge = selectionStep(visible, offset, back, true);
        var wordStart = positions[Math.min(edge, offset)], wordEnd = positions[Math.max(edge, offset) - 1];
        if (wordStart != null && wordEnd != null && edge !== offset) {
          start = wordStart; end = wordEnd + 1;
          // Atomic runs remain indivisible even when their raw source has words.
          candidates.forEach(function (n) { if (n.atomic && start < n.at + n.len && end > n.at) { start = Math.min(start, n.at); end = Math.max(end, n.at + n.len); } });
          if (deferNative) return { start: start, end: end };
          replaceVisible(focusId, start, end, '');
          return true;
        }
      }
      var picked = null;
      candidates.forEach(function (n) {
        if (back && n.at < start) picked = n;
        else if (!back && !picked && n.at + n.len > start) picked = n;
      });
      if (!picked) {
        if (!deferNative && back && markerLen(b.source.split('\n')[0])) { pushUndo('unmark'); applyEdit(b.id, 0, markerLen(b.source.split('\n')[0]), '', 0); return true; }
        return false;
      }
      if (picked.atomic) { start = picked.at; end = picked.at + picked.len; }
      else if (back) {
        end = Math.min(start, picked.at + picked.len);
        start = picked.at + selectionStep(picked.node.nodeValue, end - picked.at, true, /Word/.test(type));
      } else {
        start = Math.max(start, picked.at);
        end = picked.at + selectionStep(picked.node.nodeValue, start - picked.at, false, /Word/.test(type));
      }
    }
    if (deferNative) return { start: start, end: end };
    replaceVisible(focusId, start, end, '');
    return true;
  }
  function onBeforeInput(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!focusId) return;
    var el = editOf(focusId);
    if (!el || !el.contains(e.target) && e.target !== el) return;
    // Mobile selectionchange can arrive after beforeinput. Input needs the
    // current native range, not the range cached by an earlier overlay frame.
    frameReads.invalidateSelection();
    var t = e.inputType;
    if (/^(insert|delete|format)/.test(t || '') && crossHostRange(el)) {
      // A highlight may span reading blocks, but native input may mutate only
      // its one raw Markdown host. Never reinterpret a partial range as a caret.
      if (e.cancelable !== false) e.preventDefault();
      if (composing || t === 'insertCompositionText' || e.cancelable === false) retireNativeHost(el);
      return;
    }
    if (composing) return;
    if (handledBackspace && t === 'deleteContentBackward') { e.preventDefault(); return; }
    var liveInputCaret = caretSource(), visibleCaret = liveInputCaret;
    // Noncollapsed replacement targets are authoritative. A collapsed typing
    // target cannot override the live Selection, including a selected final
    // space: browsers may snap that target before whitespace or hidden fences.
    var targets = e.getTargetRanges && e.getTargetRanges();
    if (targets && targets.length === 1) {
      var target = targets[0], targetStart = domOffset(el, target.startContainer, target.startOffset), targetEnd = domOffset(el, target.endContainer, target.endOffset);
      if (targetStart != null && targetEnd != null &&
          (t !== 'insertText' || !liveInputCaret || targetStart !== targetEnd)) {
        visibleCaret = { start: Math.min(targetStart, targetEnd), end: Math.max(targetStart, targetEnd) };
      }
    }
    if (e.cancelable !== false && visibleCaret && liveInputCaret &&
        (visibleCaret.start !== liveInputCaret.start || visibleCaret.end !== liveInputCaret.end) &&
        /^(insertText|insertReplacementText)$/.test(t || '') && e.data != null) {
      e.preventDefault(); replaceVisible(focusId, visibleCaret.start, visibleCaret.end, e.data);
      finishInput(global.performance && performance.now ? performance.now() : Date.now()); return;
    }
    if (t === 'deleteContentBackward' && e.cancelable !== false && visibleCaret && visibleCaret.start === visibleCaret.end && pending.some(function (p) { return p.blockId === focusId && p.index === visibleCaret.start; }) && pairedDelete(focusId)) {
      e.preventDefault(); finishInput(global.performance && performance.now ? performance.now() : Date.now()); return;
    }
    var deletion = /^delete(?:Content|Word)(?:Backward|Forward)$/.test(t || '') && visibleCaret && deleteVisible(t, visibleCaret, e.cancelable === false);
    if (deletion) {
      if (e.cancelable === false) {
        // The browser still owns this deletion. Reconcile its input against the
        // original visible range instead of deleting once here and again natively.
        pushUndo('delete');
        nativeIntent = { literal: true, data: '', selectionEdit: deletion, host: el, blockId: focusId, source: blockOf(focusId).source,
          started: global.performance && performance.now ? performance.now() : Date.now() };
      } else { e.preventDefault(); finishInput(global.performance && performance.now ? performance.now() : Date.now()); }
      return;
    }
    if (e.cancelable !== false && visibleCaret && visibleCaret.end > visibleCaret.start && el.querySelector && el.querySelector('.cw-mk') &&
        (/^delete/.test(t || '') || /^(insertText|insertReplacementText)$/.test(t || '') && e.data != null)) {
      e.preventDefault(); replaceVisible(focusId, visibleCaret.start, visibleCaret.end, /^delete/.test(t) ? '' : e.data); finishInput(global.performance && performance.now ? performance.now() : Date.now()); return;
    }
    handledBackspace = false;
    var started = global.performance && performance.now ? performance.now() : Date.now();
    overlayMode = 'snap';
    if (e.cancelable === false && visibleCaret && visibleCaret.end > visibleCaret.start && el.querySelector && el.querySelector('.cw-mk') &&
        (/^delete/.test(t || '') || /^(insertText|insertReplacementText)$/.test(t || ''))) {
      pushUndo(/^delete/.test(t) ? 'delete' : 'replace');
      nativeIntent = { literal: true, data: /^delete/.test(t) ? '' : e.data, started: started,
        selectionEdit: { start: visibleCaret.start, end: visibleCaret.end } };
      return;
    }
    if ((e.cancelable === false || t === 'insertReplacementText') && visibleCaret && /^(insertText|insertReplacementText)$/.test(t || '') && e.data != null) {
      pushUndo(visibleCaret.end > visibleCaret.start ? 'replace' : 'type');
      nativeIntent = { literal: true, data: e.data, started: started, host: el, blockId: focusId, source: blockOf(focusId).source,
        pair: t === 'insertText' && e.data.length === 1, selectionEdit: { start: visibleCaret.start, end: visibleCaret.end } };
      return;
    }
    if (t === 'insertText' && e.data != null) {
      var chars = e.data;
      if (chars.length === 1 && insertText(focusId, chars)) {
        e.preventDefault(); finishInput(started); return;
      }
      var c = visibleCaret;
      pushUndo(chars.length === 1 ? (c && c.end > c.start ? 'replace' : 'type') : 'paste');
      var range = frameReads.selection().range;
      var inputBlock = blockOf(focusId), whitespaceEdge = c && inputBlock && /[ \t]/.test(inputBlock.source.slice(Math.max(0, c.start - 1), c.start + 1));
      // Native insertion may inherit the preceding style or discard collapsed
      // whitespace. Splice the source when the host contains hidden markers.
      if (c && c.start === c.end && range && (whitespaceEdge || /^[ \t]+$/.test(chars) || range.startContainer.nodeType === 1 || el.querySelector && el.querySelector('.cw-mk, a[data-autolink]') || typingStyles && typingStyles.blockId === focusId && typingStyles.at === c.start)) {
        e.preventDefault(); replaceVisible(focusId, c.start, c.end, chars, false); if (chars.length === 1) afterInsert(focusId, chars); finishInput(started); return;
      }
      nativeIntent = { literal: true, data: chars, started: started, host: el, blockId: focusId, source: inputBlock.source,
        selectionEdit: c && { start: visibleCaret.start, end: visibleCaret.end } };
      return;
    }
    if (t === 'insertParagraph') {
      e.preventDefault();
      var shifted = lastEnter && lastEnter.shift && (Date.now() - lastEnter.at) < 1000;
      if (shifted) softBreak(focusId); else splitBlock(focusId);
      finishInput(started);
      return;
    }
    if (t === 'insertLineBreak') { e.preventDefault(); softBreak(focusId); finishInput(started); return; }
    if (t === 'deleteContentBackward' || t === 'deleteWordBackward') {
      if (t === 'deleteContentBackward' && pairedDelete(focusId)) { e.preventDefault(); finishInput(started); return; }
      var cb = caretSource(), bb = blockOf(focusId);
      // the same normalisation as rule 6 in insertText: a delete at that
      // position would take the character in front of the break, not the break.
      var afterTail = cb && bb && cb.start === cb.end && cb.start === bb.source.length && /\n$/.test(bb.source);
      if (cb && ((cb.start === 0 && cb.end === 0) || afterTail)) { e.preventDefault(); backspace(focusId); finishInput(started); }
      else { pushUndo('delete'); nativeIntent = { literal: true, data: null, started: started }; }
      return;
    }
    if (t === 'deleteContentForward' || t === 'deleteWordForward') {
      var cf = caretSource(), bf = blockOf(focusId);
      if (cf && bf && cf.start === bf.source.length && cf.end === cf.start) { e.preventDefault(); forwardDelete(focusId); finishInput(started); }
      else { pushUndo('delete'); nativeIntent = { literal: true, data: null, started: started }; }
      return;
    }
    // A rich-text format request — the chord we did not catch, a Touch Bar, an
    // Edit menu — must never reach the host: the browser answers it by wrapping
    // our one raw text node in <b>, which is the invariant everything else
    // depends on. Markdown is the only formatting this editor has.
    if (t && t.indexOf('format') === 0) {
      e.preventDefault();
      if (t === 'formatBold') command('bold');
      else if (t === 'formatItalic') command('italic');
      else if (t === 'formatStrikeThrough') command('strike');
      finishInput(started);
      return;
    }
    if (t === 'historyUndo') { e.preventDefault(); undo(); finishInput(started); return; }
    if (t === 'historyRedo') { e.preventDefault(); redo(); finishInput(started); return; }
    if (t === 'insertFromPaste' || t === 'insertFromDrop') { e.preventDefault(); return; } // handled by the paste/drop listeners
    if (t && t.indexOf('delete') === 0) {
      pushUndo('delete'); nativeIntent = { literal: true, data: null, started: started };
    }
  }
  function onPaste(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!focusId || opts.readOnly) return;
    var started = global.performance && performance.now ? performance.now() : Date.now();
    e.preventDefault();
    var clipboard = e.clipboardData || global.clipboardData;
    var text = clipboard && clipboard.getData('text/plain');
    if (!text) return;
    editor.flush();
    var c = caretSource();
    if (!c) return;
    var pasted = replaceVisible(focusId, c.start, c.end, text.replace(/\r\n?/g, '\n'), 'paste');
    var b = blockOf(focusId);
    // Pasted paragraphs become blocks, and so do pasted definitions, one line each as
    // when the file is opened: an edit to one of them is then judged on its own line.
    var parts = /\n\s*\n/.test(b.source) || b.source.indexOf('\n') >= 0 && typeof standsAsDefinition === 'function' && standsAsDefinition(b) ? MD().parse(b.source).blocks : [];
    if (parts.length > 1) {
      var pastedId = focusId, index = idx(pastedId), wanted = pasted ? pasted.caret : b.source.length;
      var cursor = 0, partIndex = 0, localCaret = wanted;
      parts.forEach(function (part, i) {
        var at = b.source.indexOf(part.source, cursor);
        if (at <= wanted) { partIndex = i; localCaret = clamp(wanted - at, 0, part.source.length); }
        cursor = at + part.source.length;
      });
      focusId = null;
      refreshRendered(b);
      renderAll();
      typingStyles = null;
      focusBlock(blocks[index + partIndex].id, localCaret);
      requestOverlay('snap');
    }
    finishInput(started);
  }
  function selectionStep(text, off, backwards, word) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      var segments = new Intl.Segmenter(undefined, { granularity: word ? 'word' : 'grapheme' }).segment(text), previous = 0;
      for (var part of segments) {
        if (backwards && part.index >= off) break;
        if (word && !part.isWordLike) continue;
        var end = part.index + part.segment.length;
        if (!backwards && end > off) return end;
        previous = part.index;
      }
      return backwards ? previous : text.length;
    }
    if (word) {
      while ((backwards ? off > 0 : off < text.length) && !WORD_CHAR.test(text.charAt(backwards ? off - 1 : off))) off += backwards ? -1 : 1;
      return wordEdge(text, off, backwards);
    }
    if (backwards) return Math.max(0, off - (off > 1 && /[\uDC00-\uDFFF]/.test(text.charAt(off - 1)) ? 2 : 1));
    return Math.min(text.length, off + (text.codePointAt(off) > 65535 ? 2 : 1));
  }
  function extendBlockSelection(e) {
    var sel = global.getSelection && global.getSelection();
    if (!sel || !sel.rangeCount || !sel.focusNode || !sel.anchorNode) return false;
    var node = sel.focusNode.nodeType === 3 ? sel.focusNode.parentNode : sel.focusNode;
    var wrap = node && node.closest && node.closest('.cw-block');
    if (!wrap || !page.contains(wrap)) return false;
    var id = wrap.getAttribute('data-block-id'), host = editOf(id) || wrap;
    var off = host === wrap ? blockTextOffset(host, sel.focusNode, sel.focusOffset) : domOffset(host, sel.focusNode, sel.focusOffset);
    if (off == null) return false;
    var backwards = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    var boundary = backwards ? off === 0 : off === host.textContent.length;
    var i = idx(id), target = boundary ? (backwards ? firstVisibleBefore(i) : firstVisibleAfter(i)) : -1;
    var p;
    if (target < 0) {
      // Native modify can remain trapped by the anchor's editing host even
      // after the endpoint has crossed it. Advance the rendered endpoint.
      if (id === focusId) return false;
      if (/^Arrow(?:Left|Right)$/.test(e.key)) {
        p = positionAt(host, selectionStep(host.textContent, off, backwards, e.altKey));
      } else {
        var probe = document.createRange(); probe.setStart(sel.focusNode, sel.focusOffset); probe.collapse(true);
        var rect = probe.getBoundingClientRect();
        if (!rect.height) return false;
        p = pointToPosition(rect.left, rect.top + rect.height * (backwards ? -.5 : 1.5));
        if (!p || !page.contains(p.node)) return false;
      }
    } else {
      var targetWrap = elOf(blocks[target].id), targetHost = targetWrap && (editOf(blocks[target].id) || targetWrap);
      if (!targetHost) return false;
      p = positionAt(targetHost, backwards ? targetHost.textContent.length : 0);
    }
    if (!sel.setBaseAndExtent && !sel.extend) return false;
    e.preventDefault();
    if (sel.setBaseAndExtent) sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, p.node, p.offset);
    else { var anchorNode = sel.anchorNode, anchorOffset = sel.anchorOffset; sel.collapse(anchorNode, anchorOffset); sel.extend(p.node, p.offset); }
    frameReads.invalidateSelection();
    requestOverlay('navigate');
    return true;
  }
  function onKeyDown(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    handledBackspace = false;
    var mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter') lastEnter = { shift: !!e.shiftKey, at: Date.now() };
    if (e.key === 'Escape') {
      if (activePicker) { closePicker(); e.preventDefault(); return; }
      if (selMenu && !selMenu.hidden) { hideSelMenu(); e.preventDefault(); return; }
      if (focusId) { blurCurrent(); e.preventDefault(); }
      return;
    }
    // Undo lives here, and stops here: commands.js listens on document, so
    // swallowing the event is what keeps a keystroke from undoing twice.
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (!focusId) return;

    // At a nonempty host boundary iOS can send only keydown/keyup, with no
    // beforeinput or input. Handle only the structural Backspace here.
    if (e.key === 'Backspace' && !mod && !e.altKey && !composing && !e.isComposing && e.keyCode !== 229 &&
        !opts.readOnly && !nativeIntent && !e.defaultPrevented && e.cancelable !== false) {
      frameReads.invalidateSelection();
      var deleteHost = editOf(focusId), deleteBlock = blockOf(focusId), deleteCaret = caretSource();
      if (deleteHost && document.activeElement === deleteHost &&
          (e.target === deleteHost || deleteHost.contains(e.target)) && deleteBlock && deleteHost.textContent === deleteBlock.source &&
          deleteCaret && deleteCaret.start === 0 && deleteCaret.end === 0 &&
          (markerLen(deleteBlock.source.split('\n')[0]) || firstVisibleBefore(idx(focusId)) >= 0)) {
        e.preventDefault(); handledBackspace = true;
        backspace(focusId); requestOverlay('snap');
        finishInput(global.performance && performance.now ? performance.now() : Date.now());
        return;
      }
    }

    if (modKey(e) && !e.altKey) {
      var chord = FORMAT_KEYS[(e.shiftKey ? '⇧' : '') + keyChar(e)];
      if (chord) {
        e.preventDefault(); e.stopPropagation();
        overlayMode = 'snap';
        command(chord);
        return;
      }
    }

    if (IS_MAC && e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var lineHost = editOf(focusId);
      var ends = lineHost && selectionEnds(lineHost);
      if (ends) {
        e.preventDefault(); e.stopPropagation();
        var left = e.key === 'ArrowLeft';
        var want = left
          ? visualLineStart(lineHost, ends.focus)
          : visualLineEnd(lineHost, ends.focus);
        // going LEFT, the caret must paint at the head of this line, not at the
        // tail of the one above, which is the same offset and the wrong place.
        forwardAt = left ? { blockId: focusId, offset: want } : null;
        overlayMode = 'navigate';
        if (e.shiftKey) setCaret(focusId, Math.min(ends.anchor, want), Math.max(ends.anchor, want));
        else setCaret(focusId, want, want);
        requestOverlay('navigate');
        return;
      }
    }

    if (/^(Arrow|Home|End|Page)/.test(e.key)) {
      if (!composing && !e.isComposing && typeof typingStyles !== 'undefined' && typingStyles) {
        var moved = caretSource();
        if (!moved || moved.start !== moved.end || typingStyles.blockId !== focusId || typingStyles.at !== moved.start) typingStyles = null;
      }
      lastUndoKind = '';
      overlayMode = 'navigate';
      requestOverlay('navigate');
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.altKey && !composing) {
      var arrowHost = editOf(focusId), arrowEnds = arrowHost && arrowHost.querySelector && arrowHost.querySelector('.cw-mk') && selectionEnds(arrowHost);
      if (arrowHost && arrowHost.querySelector && arrowHost.querySelector('.cw-mk') && arrowEnds) {
        var backward = e.key === 'ArrowLeft', current = arrowEnds.focus;
        var visible = interactionRuns(arrowHost), next = null;
        visible.forEach(function (n) {
          if (backward && n.at < current) next = n;
          if (!backward && !next && n.at + n.len > current) next = n;
        });
        if (next) {
          var relative = clamp(current - next.at, 0, next.len);
          var want = next.atomic ? next.at + (backward ? 0 : next.len) : next.at + selectionStep(next.node.nodeValue, relative, backward, false);
          if (!e.shiftKey && arrowEnds.anchor !== current) want = backward ? Math.min(current, arrowEnds.anchor) : Math.max(current, arrowEnds.anchor);
          e.preventDefault();
          if (e.shiftKey) {
            var selection = global.getSelection(), a = sourcePoint(arrowHost, arrowEnds.anchor, true), z = sourcePoint(arrowHost, want, !backward);
            if (selection.setBaseAndExtent) selection.setBaseAndExtent(a.node, a.offset, z.node, z.offset);
            else setCaret(focusId, Math.min(arrowEnds.anchor, want), Math.max(arrowEnds.anchor, want));
            frameReads.invalidateSelection();
          } else setCaret(focusId, want);
          requestOverlay('navigate');
          return;
        }
      }
    }
    if (e.shiftKey && /^Arrow(?:Left|Right|Up|Down)$/.test(e.key)) {
      if (!composing && !e.isComposing) extendBlockSelection(e);
      return; // Within a paragraph the browser retains the anchor and direction.
    }
    if (e.key === 'Tab' && !mod) {
      var b = blockOf(focusId);
      if (MULTILINE[b.type]) {
        e.preventDefault();
        var c = caretSource();
        if (!c) return;
        var ls = b.source.lastIndexOf('\n', Math.max(0, c.start - 1)) + 1;
        pushUndo('indent');
        if (e.shiftKey) {
          var m = /^ {1,4}/.exec(b.source.slice(ls));
          if (m) applyEdit(focusId, ls, ls + m[0].length, '', Math.max(ls, c.start - m[0].length));
        } else {
          applyEdit(focusId, ls, ls, '    ', c.start + 4);
        }
        return;
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      overlayMode = 'navigate';
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        var sel = global.getSelection && global.getSelection();
        if (sel && typeof sel.modify === 'function') {
          e.preventDefault();
          /* Judge success by the VISUAL LINE, not the offset. On the first line of
             a block, modify() has no line to go to and collapses to offset 0
             instead -- a real change in offset that is not a line move, so an
             offset test returned early and the key stopped crossing into the
             previous paragraph. The line's y is the thing this key is about. */
          var wasY = liveCaretLineTop();
          sel.modify(e.shiftKey ? 'extend' : 'move',
            e.key === 'ArrowUp' ? 'backward' : 'forward', 'line');
          var nowY = liveCaretLineTop();
          if (wasY != null && nowY != null && Math.abs(nowY - wasY) > 1) {
            requestOverlay('navigate');
            return;
          }
        }
      }
      var cur = caretSource();
      if (!cur) return;
      var bb = blockOf(focusId), i = idx(focusId);
      var atTop = e.key === 'ArrowUp' && cur.start === 0;
      var atEnd = e.key === 'ArrowDown' && cur.end === bb.source.length;
      var up = firstVisibleBefore(i), down = firstVisibleAfter(i);
      if (atTop && up >= 0) { e.preventDefault(); focusBlock(blocks[up].id, blocks[up].source.length); }
      else if (atEnd && down >= 0) { e.preventDefault(); focusBlock(blocks[down].id, 0); }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      overlayMode = 'navigate';
      var c2 = caretSource(); if (!c2) return;
      var i2 = idx(focusId), b2 = blockOf(focusId);
      var back = firstVisibleBefore(i2), fwd = firstVisibleAfter(i2);
      if (e.key === 'ArrowLeft' && c2.start === 0 && back >= 0) { e.preventDefault(); focusBlock(blocks[back].id, blocks[back].source.length); }
      if (e.key === 'ArrowRight' && c2.end === b2.source.length && fwd >= 0) { e.preventDefault(); focusBlock(blocks[fwd].id, 0); }
    }
  }
  function onInput(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    // Ordinary typing reaches this point without preventDefault. Only the mirror
    // and source model are updated; the browser's text node and Range stay put.
    if (!focusId) return;
    frameReads.invalidateSelection();
    var host = editOf(focusId);
    if (e && e.target && (!host || e.target !== host && !host.contains(e.target))) return;
    if (composing) {
      var range = frameReads.selection().range;
      if (host && crossHostRange(host) || !host || !range || !host.contains(range.startContainer) || !host.contains(range.endContainer) || !compositionState || compositionState.host !== host) { retireNativeHost(host); return; }
      compositionState.source = host.textContent;
      compositionState.accepted = true;
      compositionState.data = e && e.data != null ? e.data : null;
      return;
    }
    if (handledBackspace && e && e.inputType === 'deleteContentBackward') return;
    handledBackspace = false;
    var intent = nativeIntent || { data: e && e.data, replacement: e && e.data == null && e.dataTransfer && e.dataTransfer.getData ? e.dataTransfer.getData('text/plain') : null, literal: !!(e && 'inputType' in e), started: global.performance && performance.now ? performance.now() : Date.now() };
    // iOS can emit only input for Backspace at a host boundary. Reuse the
    // structural edit only for unchanged text and a collapsed caret at the start.
    if (!nativeIntent && e && e.inputType === 'deleteContentBackward' && !e.isComposing && host) {
      var b = blockOf(focusId), c = caretSource();
      if (b && host.textContent === b.source && c && c.start === 0 && c.end === 0) {
        backspace(focusId); requestOverlay('snap'); finishInput(intent.started); return;
      }
    }
    var restored = restoreSingleTextNode(host);
    // Some mobile edits arrive without beforeinput. Capture the old model before
    // observing the native node, so toolbar and keyboard history stay identical.
    var current = blockOf(focusId);
    if (!nativeIntent && current && host && host.textContent !== current.source) {
      var deleting = e && e.inputType && e.inputType.indexOf('delete') === 0;
      var span = changedSpan(current.source, host.textContent), after = caretSource();
      var start = after ? Math.max(0, after.start - span.insertedLength) : span.start;
      var before = { start: start, end: start + span.end - span.start };
      if (deleting) before.start = before.end = /Backward$/.test(e.inputType) ? before.end : start;
      var saved = lastNativeCaret, raw = host.textContent;
      var inputText = e && e.data, nativeAt = after && inputText != null ? after.start - inputText.length : -1;
      var nativeEnd = nativeAt + (inputText == null ? 0 : inputText.length) - (raw.length - current.source.length);
      var nativeEdit = after && after.start === after.end && nativeAt >= 0 && nativeEnd >= nativeAt && nativeEnd <= current.source.length &&
        raw.replace(/\u00a0/g, ' ') === (current.source.slice(0, nativeAt) + inputText + current.source.slice(nativeEnd)).replace(/\u00a0/g, ' ');
      // An input-only valid splice is also a possible deliberate selection
      // replacement, even at terminal whitespace or a hidden code fence. The
      // old caret cannot distinguish it from a browser snap. Only repair a DOM
      // mutation that the current Range cannot explain; beforeinput records the
      // authoritative pre-edit range for actual browser snaps.
      var inputRange = frameReads.selection().range, inputParent = inputRange && inputRange.startContainer.parentElement;
      var codeTail = saved && nativeAt >= 0 && nativeAt < saved.start ? current.source.slice(nativeAt, saved.start) : '';
      var codeRelocation = !nativeEdit && saved && saved.blockId === focusId && saved.source === current.source && saved.start === saved.end &&
        /^[ \t]*`+[ \t]*$/.test(codeTail) && inputParent && inputParent.closest && inputParent.closest('code') &&
        raw.replace(/\u00a0/g, ' ') === current.source.slice(0, nativeAt) + inputText + codeTail.replace(/[ \t]/g, '') + current.source.slice(saved.end);
      var observedInsertion = inputText != null && (codeRelocation || raw.slice(span.start, span.start + span.insertedLength).replace(/\u00a0/g, ' ') === inputText);
      var modelInsertion = !nativeEdit && observedInsertion && saved && saved.blockId === focusId && saved.source === current.source && e && e.inputType === 'insertText' && !e.isComposing && e.data != null;
      if (nativeEdit) { before = { start: nativeAt, end: nativeEnd }; intent.selectionEdit = before; }
      if (modelInsertion) before = { start: saved.start, end: saved.end };

      if (saved && saved.blockId === focusId && saved.source === current.source && after && after.start === after.end) {
        var length = raw.length - (current.source.length - (saved.end - saved.start));
        var inserted = length >= 0 ? raw.slice(saved.start, saved.start + length) : null;
        if (inserted != null && (e.data == null || e.data === inserted) && after.start === saved.start + length &&
            raw === current.source.slice(0, saved.start) + inserted + current.source.slice(saved.end)) {
          before = { start: saved.start, end: saved.end };
          intent.selectionEdit = { start: saved.start, end: saved.end }; intent.data = inserted;
        }
      }
      pushUndo(modelInsertion ? saved.end > saved.start ? 'replace' : 'type' : deleting ? 'delete' : span.end > span.start ? 'replace' : 'type', before);
      // A malformed native mutation can still be repaired at the remembered
      // boundary. Valid splices follow the live Range above.
      if (modelInsertion) {
        host.innerHTML = editingHtml(liveHtml(current), current.source);
        replaceVisible(focusId, saved.start, saved.end, e.data, false);
        if (e.data && e.data.length === 1) afterInsert(focusId, e.data);
        requestOverlay('snap'); finishInput(intent.started); nativeIntent = null; return;
      }

    }
    var selectionApplied = syncNativeInput(intent, restored);
    if (selectionApplied) {
      if (intent.data && intent.data.length === 1) afterInsert(focusId, intent.data);
      else if (activePicker && activePicker.blockId === focusId) updatePicker();
    }
    requestOverlay('snap');
    finishInput(intent.started);
    nativeIntent = null;
  }
  function onCompositionStart(e) {
    var host = focusId && editOf(focusId);
    if (!host || e && e.target && e.target !== host && !host.contains(e.target)) return;
    frameReads.invalidateSelection();
    if (crossHostRange(host)) { retireNativeHost(host); return; }
    handledBackspace = false;
    composing = true;
    compositionId = focusId;
    compositionState = { source: host.textContent, original: host.textContent, html: host.innerHTML, host: host,
      caret: caretSource(), data: null, accepted: false };
    overlayMode = 'snap';
    pushUndo('composition');
    nativeIntent = { literal: true, data: null, selectionEdit: compositionState.caret && { start: compositionState.caret.start, end: compositionState.caret.end },
      started: global.performance && performance.now ? performance.now() : Date.now() };
  }
  function finishComposition(retiring) {
    // Composition owns the text node completely until this event. Only now may
    // the model and mirror observe it, and normalization is a last-resort pass.
    if (!composing) return;
    frameReads.invalidateSelection();
    var host = focusId && editOf(focusId);
    if (host && compositionId === focusId && compositionState && crossHostRange(host)) {
      retiring = true;
      var text = textOf(host);
      if (text) text.data = compositionState.source;
      else host.textContent = compositionState.source;
    }
    composing = false;
    var id = compositionId;
    compositionId = null;
    if (!id || focusId !== id) { nativeIntent = null; compositionState = null; return; }
    frameReads.invalidateSelection();
    var saved = compositionState;
    if (retiring && saved && host) {
      var checkpoint = textOf(host);
      if (checkpoint) checkpoint.data = saved.source;
      else host.textContent = saved.source;
      if (!saved.accepted && saved.data == null) {
        host.innerHTML = saved.html;
        blockOf(id).source = saved.original;
        if (saved.caret) setCaret(id, saved.caret.start, saved.caret.end);
      }
    }
    if (retiring && saved && !saved.accepted && saved.data == null) {
      // No accepted update exists. Retire without applying rejected native DOM.
    } else if (saved && saved.caret && saved.data === '' && host && host.textContent === saved.original) {
      // Cancellation can end with empty data after the browser restores its DOM.
      // Preserve both the source and the original selection in that case.
      setCaret(id, saved.caret.start, saved.caret.end);
    } else if (saved && saved.caret && (saved.caret.end > saved.caret.start || /cw-mk/.test(saved.html) || typeof typingStyles !== 'undefined' && typingStyles && typingStyles.blockId === id && typingStyles.at === saved.caret.start) && host && (saved.accepted || saved.data != null)) {
      // IME may delete hidden delimiters in its provisional DOM. Commit against
      // the original visible selection, once, without disrupting composition.
      var count = saved.source.length - (saved.original.length - (saved.caret.end - saved.caret.start));
      var committed = retiring ? saved.source : host.textContent;
      count = committed.length - (saved.original.length - (saved.caret.end - saved.caret.start));
      var replacement = !saved.accepted && committed === saved.original && saved.data ? saved.data : count >= 0 ? committed.slice(saved.caret.start, saved.caret.start + count) : '';
      host.innerHTML = saved.html;
      blockOf(id).source = saved.original;
      replaceVisible(id, saved.caret.start, saved.caret.end, replacement, false);
    } else {
      var restoredComposition = restoreSingleTextNode(editOf(focusId));
      syncNativeInput(nativeIntent, restoredComposition);
    }
    compositionState = null;
    requestOverlay('snap');
    finishInput(nativeIntent && nativeIntent.started || (global.performance && performance.now ? performance.now() : Date.now()));
    nativeIntent = null;
    emitHistory();
  }
  function onCompositionEnd(e) {
    if (!composing || e && e.target && compositionState && e.target !== compositionState.host && !compositionState.host.contains(e.target)) return;
    var host = focusId && editOf(focusId);
    frameReads.invalidateSelection();
    // A source caret exists only when both endpoints belong to this host.
    if (!host || crossHostRange(host) || !caretSource()) retireNativeHost(host);
    else {
      if (e && e.data != null) compositionState.data = e.data;
      finishComposition();
    }
  }
  function onFocusOut(e) {
    if (!composing || !focusId || e.target !== editOf(focusId)) return;
    var id = focusId, started = compositionState;
    setTimeout(function () { if (composing && compositionId === id && compositionState === started) finishComposition(); }, 0);
  }
  var dragFrom = null;
  function onDragStart(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    var sel = global.getSelection();
    if (!sel || sel.isCollapsed) return;
    var where = caretSource();
    var a = selAnchor || anchorFromSelection() || (where && { blockId: focusId });
    if (!a) return;
    dragFrom = (focusId && where && where.end > where.start)
      ? { blockId: focusId, start: where.start, end: where.end } : null;
    try {
      var text = where && focusId ? interactionRuns(editOf(focusId)).map(function (run) {
        var start = Math.max(where.start, run.at), end = Math.min(where.end, run.at + run.len);
        return end > start ? run.node.nodeValue.slice(start - run.at, end - run.at) : '';
      }).join('') : a.quote;
      if (!a.quote) a.quote = text;
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.setData('application/x-castor-anchor', JSON.stringify(a));
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (err) { /* older browsers */ }
  }
  function onDragEnd() { dragFrom = null; }

  var dropTarget = null;
  function clearDrop() {
    if (dropTarget) { dropTarget.classList.remove('cw-drop-before', 'cw-drop-after'); dropTarget = null; }
  }
  function onDragOver(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!e.dataTransfer) return;
    var types = Array.prototype.slice.call(e.dataTransfer.types || []);
    if (types.indexOf('text/plain') < 0 && types.indexOf('application/x-castor-anchor') < 0) return;
    e.preventDefault();
    /* Say which it is, so the pointer shows a move rather than a copy when the
       text is coming from the piece itself. */
    e.dataTransfer.dropEffect = (dragFrom && !e.altKey) ? 'move' : 'copy';
    var el = e.target.closest ? e.target.closest('.cw-block') : null;
    clearDrop();
    if (!el) return;
    dropTarget = el;
    var r = el.getBoundingClientRect();
    el.classList.add(e.clientY < Math.floor(r.top + r.height / 2) ? 'cw-drop-before' : 'cw-drop-after');
  }
  function onDrop(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (opts && opts.readOnly) { if (e.preventDefault) e.preventDefault(); clearDrop(); return; }
    var text = e.dataTransfer && e.dataTransfer.getData('text/plain');
    var before = dropTarget && dropTarget.classList.contains('cw-drop-before');
    var el = dropTarget;
    clearDrop();
    if (!text) return;
    e.preventDefault();
    editor.flush();
    var id = el ? el.getAttribute('data-block-id') : (blocks.length ? blocks[blocks.length - 1].id : null);
    pushUndo('drop');
    var nb = { id: mintId(), type: classify(text), source: text.replace(/\r\n?/g, '\n') };
    var at = id ? idx(id) + (before ? 0 : 1) : blocks.length;
    blocks.splice(at, 0, nb);
    if (/[\\`*_\[\]()~<>#|=^%&]/.test(nb.source)) {
      var droppedText = nb.source, dropSurface = document.createElement('div');
      nb.source = ''; nb.type = 'p';
      var dropped = replaceVisible(nb.id, 0, 0, droppedText, 'project', dropSurface);
      nb.source = dropped.source; nb.type = classify(nb.source);
    }
    var moved = dragFrom && !e.altKey ? dragFrom : null;
    dragFrom = null;
    if (moved && moved.blockId !== nb.id) {
      var src = blockOf(moved.blockId);
      if (src && typeof src.source === 'string') {
        var s = clamp(moved.start, 0, src.source.length);
        var en = clamp(moved.end, 0, src.source.length);
        if (en > s) {
          var surface = editOf(src.id) || document.createElement('div');
          if (!editOf(src.id)) {
            surface.innerHTML = editingHtml(liveHtml(src), src.source);
            if (surface.textContent !== src.source) { surface.textContent = ''; surface.appendChild(document.createTextNode(src.source)); }
          }
          src.source = replaceVisible(src.id, s, en, '', 'project', surface).source;
          if (!src.source.trim()) {
            var gone = idx(src.id);
            if (gone >= 0 && blocks.length > 1) blocks.splice(gone, 1);
          } else {
            refreshRendered(src);
          }
        }
      }
    }
    focusId = null;
    refreshRendered(nb);
    renderAll();
    changed();
    if (bus && bus.emit) bus.emit('editor:drop', { blockId: nb.id, text: text, moved: !!moved });
  }

  var WRAPS = { bold: '**', italic: '*', highlight: '==', code: '`', strike: '~~' };
  var LINE_MARK = { bullet: '- ', checkbox: '- [ ] ', numbered: '1. ', quote: '> ' };
  var COMMAND_IDS = ['heading', 'bold', 'italic', 'highlight', 'code', 'strike', 'bullet', 'checkbox',
    'numbered', 'quote', 'indent', 'outdent', 'link', 'footnote'];
  var PAIRED = [
    { open: '[[', close: ']]' },
    { open: '**', close: '**' },
    { open: '~~', close: '~~' },
    { open: '==', close: '==' },
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '*', close: '*' },
    { open: '_', close: '_' },
    { open: '`', close: '`' }
  ];

  var FORMAT_KEYS = { b: 'bold', i: 'italic', e: 'code', '⇧m': 'highlight', '⇧x': 'strike' };
  // The platform's own modifier, the same rule commands.js uses. Not
  // `meta || ctrl`: on a Mac Ctrl+B is the system's "back one character" and
  // Ctrl+Left is not "start of line" on Windows or Linux (Home is). Taking
  // either would be trading one broken key for another.
  var IS_MAC = /Mac|iPhone|iPad/.test(
    (global.navigator && (global.navigator.platform || global.navigator.userAgent)) || '');
  function modKey(e) { return IS_MAC ? e.metaKey : e.ctrlKey; }
  // Read from e.code so a chord survives a non-QWERTY layout, exactly as
  // commands.js does for its own map.
  function keyChar(e) {
    if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
    return (e.key || '').toLowerCase();
  }

  // A single-character marker standing inside a longer run of the same
  // character belongs to that run, not to a pair of its own: `**` is one bold
  // marker, so Cmd+I with the caret inside a bold run must never eat half of it.
  function standaloneMarker(src, i, d) {
    if (d.length > 1) return true;
    var ch = d.charAt(0);
    return src.charAt(i - 1) !== ch && src.charAt(i + 1) !== ch;
  }
  // The pair of `d` markers that encloses `at`, or null. Bounded to the caret's
  // own line: emphasis that "matches" three paragraphs away is a coincidence,
  // not a pair, and toggling it off would rewrite text he cannot see.
  function enclosingPair(src, at, d) {
    var n = d.length, i;
    var lineStart = src.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
    var lineEnd = src.indexOf('\n', at); if (lineEnd < 0) lineEnd = src.length;
    var open = -1, close = -1;
    for (i = at - n; i >= lineStart; i--) {
      if (src.substr(i, n) === d && standaloneMarker(src, i, d)) { open = i; break; }
    }
    if (open < 0) return null;
    for (i = at; i + n <= lineEnd; i++) {
      if (src.substr(i, n) === d && standaloneMarker(src, i, d)) { close = i; break; }
    }
    return close < 0 ? null : { open: open, close: close };
  }
  // `**||**` — the caret sitting in an empty pair, which is what Cmd+B with no
  // selection just made. Checked before enclosingPair because the two markers
  // touch, so each one is inside the other's run and standaloneMarker rejects
  // them both.
  function emptyPairAt(src, at, pair) {
    /* Takes either a {open, close} pair or a bare marker string. The command path
       (bold, italic, highlight) passes a string and has always meant a symmetric
       pair; changing its call sites to satisfy a new signature would have been a
       larger edit than the defect deserved. */
    if (typeof pair === 'string') pair = { open: pair, close: pair };
    var no = pair.open.length, nc = pair.close.length;
    if (at < no) return false;
    if (src.substr(at - no, no) !== pair.open) return false;
    if (src.substr(at, nc) !== pair.close) return false;
    if (pair.open === pair.close) {
      var ch = pair.open.charAt(0);
      if (src.charAt(at - no - 1) === ch || src.charAt(at + nc) === ch) return false;
    }
    return true;
  }

  function commandResult(id) {
    var c = caretSource();
    var anchor = null;
    try { anchor = anchorFromSelection(); } catch (e) { anchor = null; }
    if (!anchor && c && focusId) {
      var b = blockOf(focusId);
      anchor = { blockId: focusId, quote: b ? b.source.slice(c.start, c.end) : '', start: c.start, end: c.end, version: version };
    }
    if (anchor && c) { anchor.start = c.start; anchor.end = c.end; anchor.blockId = anchor.blockId || focusId; }
    if (anchor) anchor.command = id;
    return anchor;
  }
  function lineBounds(b, at) {
    var start = b.source.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
    var end = b.source.indexOf('\n', at);
    return { start: start, end: end < 0 ? b.source.length : end };
  }
  function can(id) {
    if (opts.readOnly || composing || !focusId || COMMAND_IDS.indexOf(id) < 0) return false;
    var b = blockOf(focusId), c = caretSource();
    if (!b || !c) return false;
    if (b.type === 'code' || b.type === 'frontmatter') return false;
    // Toolbar indentation nests list items. Moving quote markers, metadata or
    // fence delimiters changes their Markdown meaning; code uses native Tab.
    if (id === 'indent' || id === 'outdent') {
      if (b.type !== 'list') return false;
      var line = lineBounds(b, c.start), head = b.source.slice(line.start, line.end);
      return id === 'indent' || /^ {1,4}/.test(head);
    }
    if (id === 'link') return c.end > c.start || b.type === 'p' || !!headingLevel(b.type);
    if (id === 'footnote' && b.type === 'footnote-def') return false;
    return true;
  }

  function nextFootnote() {
    var max = 0, re = /\[\^([0-9]+)\]/g, m, src = getSource();
    while ((m = re.exec(src))) max = Math.max(max, +m[1]);
    return String(max + 1);
  }

  function insertFootnote(id, start, end) {
    var b = blockOf(id);
    if (opts.readOnly || !b || b.type === 'code' || b.type === 'frontmatter' || b.type === 'footnote-def') return null;
    var key = nextFootnote(), marker = '[^' + key + ']', caret = start + marker.length;
    pushUndo('footnote');
    b.source = b.source.slice(0, start) + marker + b.source.slice(end);
    adjustPending(id, start, end, marker.length);
    blocks.push({ id: mintId(), type: 'footnote-def', source: marker + ':' });
    focusId = null;
    parseAll();
    renderAll();
    changed(true);
    if (Castor.footnotes && Castor.footnotes.open) Castor.footnotes.open(key, id, caret);
    else focusBlock(id, caret);
    return { blockId: id, start: caret, end: caret };
  }

  function command(id, options) {
    if (!can(id)) return null;
    var opts2 = options || {};
    var b = blockOf(focusId), c = caretSource(), at = c.start;
    if (id === 'footnote') return insertFootnote(focusId, at, at);
    var line = lineBounds(b, at), head = b.source.slice(line.start, line.end);

    if (WRAPS[id]) {
      var d = WRAPS[id], n = d.length, src = b.source;

      if (c.end > c.start) {
        replaceVisible(focusId, c.start, c.end, { kind: 'style', style: id }, 'command:' + id);
        return commandResult(id);
      }
      var inherited = [], host = editOf(focusId);
      var node = sourceNodes(host).find(function (n) { return !hiddenSource(n.node) && n.at <= at && n.at + n.len >= at; });
      for (var p = node && node.node.parentElement; p && p !== host; p = p.parentElement) {
        var style = { STRONG: 'bold', EM: 'italic', MARK: 'highlight', DEL: 'strike', CODE: 'code', SUP: 'sup', SUB: 'sub', SPAN: 'span' }[p.tagName];
        if (style) inherited.push(style);
      }
      var styles = typingStyles && typingStyles.blockId === focusId && typingStyles.at === at ? typingStyles.styles.slice() : inherited;
      var has = styles.indexOf(id) >= 0;
      styles = styles.filter(function (x) { return x !== id; });
      if (!has) styles.push(id);
      var run = typingStyles && typingStyles.blockId === focusId && typingStyles.at === at ? typingStyles.run : null;
      typingStyles = { blockId: focusId, at: at, styles: styles, run: run };
      setCaret(focusId, c.start, c.end);
      return commandResult(id);
    }

    if (id === 'heading') {
      var m = /^(#{1,6})\s+/.exec(head);
      var level = m ? m[1].length : 0;
      var want = opts2.level != null ? opts2.level : (level === 0 ? 1 : (level >= 6 ? 0 : level + 1));
      var marker = want ? new Array(want + 1).join('#') + ' ' : '';
      pushUndo('command:heading');
      var wasLen = m ? m[0].length : 0;
      applyEdit(focusId, line.start, line.start + wasLen, marker,
        Math.max(line.start, at - wasLen + marker.length));
      return commandResult(id);
    }

    if (LINE_MARK[id]) {
      var mark = LINE_MARK[id];
      var current = markerLen(head), had = head.slice(0, current);
      var already = id === 'checkbox' ? /^\s*[-*+]\s+\[[ xX]\]\s+$/.test(had)
        : id === 'numbered' ? /^\s*\d+[.)]\s+$/.test(had)
          : id === 'quote' ? /^\s*>\s?$/.test(had) : /^\s*[-*+]\s+$/.test(had);
      pushUndo('command:' + id);
      var text = already ? '' : mark;
      applyEdit(focusId, line.start, line.start + current, text,
        Math.max(line.start, at - current + text.length));
      return commandResult(id);
    }

    if (id === 'indent' || id === 'outdent') {
      var lead = id === 'outdent' && /^ {1,4}/.exec(b.source.slice(line.start));
      if (id === 'outdent' && !lead) return commandResult(id);
      pushUndo('command:' + id);
      if (id === 'indent') applyEdit(focusId, line.start, line.start, '    ', at + 4);
      else {
        applyEdit(focusId, line.start, line.start + lead[0].length, '', Math.max(line.start, at - lead[0].length));
      }
      return commandResult(id);
    }

    if (id === 'link') {
      openPicker('wiki', focusId, c.start, 0, true, c.end);
      return commandResult(id);
    }
    return null;
  }

  // Type anywhere: a printable key with nothing focused starts writing in the
  // piece rather than going nowhere. Never while a picker, a palette or any
  // other field owns the keyboard.
  function onGlobalKey(e) {
    if (!page || focusId || activePicker) return;
    function inert(node) {
      for (; node; node = node.parentNode) if (node.inert) return true;
      return false;
    }
    if (inert(page) || inert(e.target) || inert(document.activeElement)) return;
    // Read only: typing on the page starts nothing, not even the last block's caret.
    if (opts && opts.readOnly) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return;
    // Space while reading is the browser's page-down (iPad keyboards too): it never
    // jumps to the end of the article or adds a space there.
    if (e.key === ' ') return;
    var el = document.activeElement;
    if (el && el !== document.body && el !== document.documentElement &&
      (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
    // Space on a focused control is its activation key, never a space at the end of the article.
    if (e.key === ' ' && el && (/^(button|a|summary)$/i.test(el.tagName || '') ||
      /^(button|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|switch|radio|treeitem|link)$/.test((el.getAttribute && el.getAttribute('role')) || ''))) return;
    if (document.querySelector('.cw-palette:not([hidden]), .cw-picker:not([hidden]), .changes-screen:not([hidden]), dialog[open], [popover]:popover-open, [aria-modal="true"]:not([hidden]):not([popover])')) return;
    var last = null;
    for (var i = blocks.length - 1; i >= 0; i--) if (visible(blocks[i])) { last = blocks[i]; break; }
    if (!last) return;
    // Only where the reader already is: with the article's end off screen, a key
    // would scroll the page away from what he is reading.
    var end = elOf(last.id), box = end && end.getBoundingClientRect && end.getBoundingClientRect();
    var height = global.innerHeight || (document.documentElement && document.documentElement.clientHeight);
    if (box && height && (box.top >= height || (box.bottom != null ? box.bottom : box.top + (box.height || 0)) <= 0)) return;
    e.preventDefault();
    focusBlock(last.id, last.source.length);
    pushUndo('type');
    applyEdit(last.id, last.source.length, last.source.length, e.key);
  }

  // The page visibly waits when the writer clicks away — but only once he has
  // actually been writing, so a page nobody has touched (a screenshot, a first
  // load) never wears it.
  function markAway(on) {
    if (!page || !isArticle) return;
    if (!everFocused) { page.classList.remove('cw-away'); return; }
    var style = getComputedStyle(page).getPropertyValue('--away-scrim').trim().toLowerCase();
    if (style === 'off' || style === '0') { page.classList.remove('cw-away'); return; }
    page.classList.toggle('cw-away', !!on);
  }

  var editor = {
    // Front matter changes (subtitle, title, tags) replace only the header block;
    // `transform` maps the whole source and must leave the body bytes alone.
    updateFrontmatter: function (transform, label) {
      if (opts.readOnly) return false;
      var before = getSource(), next = transform(before);
      if (next === before) return true;
      var header = blocks.find(function (b) { return b.type === 'frontmatter'; });
      if (!header) return false;
      var parsed = MD().parse(next).blocks[0];
      if (!parsed || parsed.type !== 'frontmatter' || next.slice(parsed.source.length) !== before.slice(header.source.length)) return false;
      pushUndo(label || 'frontmatter');
      header.source = parsed.source;
      parseAll();
      changed(true);
      return true;
    },
    updateSubtitle: function (value) {
      return editor.updateFrontmatter(function (source) { return Castor.subtitle.withSource(source, value); }, 'subtitle');
    },
    canEditSubtitle: function () { return !opts.readOnly; },
    // Observe browser-owned input before a caller replaces the document or its writer.
    flush: function () {
      // Composition interruption follows CodeMirror 5's forceCompositionEnd (MIT).
      if (composing) {
        var host = editOf(focusId), focused = host && document.activeElement === host;
        if (host && host.blur) host.blur();
        finishComposition();
        if (focused && host.focus) host.focus({ preventScroll: true });
      }
      if (focusId) {
        frameReads.invalidateSelection();
        syncNativeInput(nativeIntent, restoreSingleTextNode(editOf(focusId)));
        nativeIntent = null;
      }
      return getSource();
    },
    // opts: {onChange, onSelect, onComment, onLink, showFrontmatter=false,
    //        showWriterNotes=true, readOnly=false}
    isReadOnly: function () { return !!(opts && opts.readOnly); },
    setReadOnly: function (on) {
      opts = opts || {};
      opts.readOnly = !!on;
      if (on && focusId) blurCurrent();
      if (page) page.classList.toggle('cw-readonly', !!on);
      emitHistory();
    },
    mount: function (pageEl, docOrSource, options) {
      injectBase();
      finishComposition();
      if (reparseTimer) { clearTimeout(reparseTimer); reparseTimer = null; }
      cancelCaretReveal();
      focusId = null;
      composing = false;
      compositionId = null;
      compositionState = null;
      nativeIntent = null;
      handledBackspace = false;
      pointerSelecting = pointerStartedInPage = pointerCrossed = false; pointerAnchor = null;
      pending = []; literalRun = null;
      // Like CodeMirror 5's Doc history (MIT), undo belongs to this document.
      undoStack.length = redoStack.length = 0;
      lastUndoAt = 0; lastUndoKind = ''; lastUndoBlock = null; lastUndoCaret = lastNativeCaret = null; keyboardCaret = null;
      emitHistory();
      closePicker();
      page = pageEl;
      page.classList.add('cw-editor-page');
      ensureOverlays();
      opts = options || {};
      var md = MD();
      var parsed;
      if (typeof docOrSource === 'string') parsed = md.parse(docOrSource);
      else if (docOrSource && docOrSource.blocks) parsed = docOrSource;
      else parsed = md.parse('');
      doc = parsed;
      headingCache = {};
      tail = typeof parsed.trailing === 'string' ? parsed.trailing : '';
      version = (Castor.app && Castor.app.data && Castor.app.data.current) || null;
      blocks = parsed.blocks.map(function (b) {
        if (/^#{1,6}[ \t]*$/.test(b.source)) b.type = classify(b.source);
        rendered[b.id] = /^#{1,6}[ \t]*$/.test(b.source) ? renderFor(b, md) : b.html || md.blockToHtml(b);
        return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.type };
      });
      idSeq = blocks.length + 1;
      if (!blocks.some(visible)) blocks.push({ id: mintId(), type: 'p', source: '', sep: '\n\n', sepType: 'p', empty: true });
      syncHeadings();
      renderAll();

      if (!mounted) {
        page.addEventListener('mousedown', own(onMouseDown), true);
        page.addEventListener('click', own(onClick));
        page.addEventListener('beforeinput', own(onBeforeInput), true);
        page.addEventListener('input', own(onInput));
        page.addEventListener('keydown', own(onKeyDown));
        page.addEventListener('keyup', function (e) { if (e.key === 'Backspace') handledBackspace = false; });
        page.addEventListener('paste', own(onPaste));
        if (isArticle) document.addEventListener('copy', onCopy);
        else page.addEventListener('copy', onCopy);
        page.addEventListener('dragstart', own(onDragStart));
        page.addEventListener('dragover', own(onDragOver));
        page.addEventListener('dragleave', own(clearDrop));
        page.addEventListener('drop', own(onDrop));
        page.addEventListener('dragend', own(onDragEnd));
        page.addEventListener('compositionstart', own(onCompositionStart));
        page.addEventListener('compositionend', own(onCompositionEnd));
        page.addEventListener('focusout', own(onFocusOut));
        page.addEventListener('touchstart', own(onTouchStart), { passive: true });
        page.addEventListener('touchmove', own(onTouchMove), { passive: true });
        page.addEventListener('touchend', own(onTouchEnd), { passive: false });
        document.addEventListener('pointerdown', function (e) { if (e.pointerType) touchInput = e.pointerType === 'touch'; }, true);
        document.addEventListener('selectionchange', onSelectionChange);
        if (isArticle) document.addEventListener('keydown', onGlobalKey);   // typing while reading starts the article, never a field
        global.addEventListener('blur', function () { markAway(true); });
        global.addEventListener('focus', function () { markAway(false); });
        document.addEventListener('mousemove', own(onPointerMove), true);
        document.addEventListener('mouseup', onPointerUp, true);
        // A writer's own scroll wins: the typewriter line yields until the
        // caret moves again (setCaret clears the flag).
        if (global.visualViewport) global.visualViewport.addEventListener('resize', function () {
          if (revealPending) requestCaretReveal(false);
        });
        global.addEventListener('wheel', cancelCaretReveal, { passive: true, capture: true });
        global.addEventListener('scroll', function () { undoFocusScroll(); menuAfterMove(); requestOverlay('layout'); }, true);
        global.addEventListener('resize', function () { frameReads.invalidateStyles(); menuAfterMove(); requestOverlay('layout'); });
        if (Castor.bus && Castor.bus.on) {
          Castor.bus.on('layout', followLayout);
          Castor.bus.on('theme', function () { frameReads.invalidateStyles(); requestOverlay('layout'); });
        }
        if (typeof ResizeObserver === 'function') {
          var ro = new ResizeObserver(followLayout);
          ro.observe(page);
          // the scroller too: a fixed-measure column keeps its width while the
          // room around it shrinks, and only the room reports that.
          if (page.parentNode && page.parentNode.nodeType === 1) ro.observe(page.parentNode);
        }
        document.addEventListener('mousedown', function (e) {
          if (selMenu && !selMenu.hidden && !selMenu.contains(e.target)) hideSelMenu();
        });
        mounted = true;
      }
      markFocusParagraph();     // the token is true before anyone has written
      if (opts.notifyMount !== false) emit();
      return editor;
    },

    setWriterNotes: function (on) {
      var saved = editor.getCaret();
      opts.showWriterNotes = on !== false;
      /* renderAll() reuses the cache, so the cache is what has to change: the parse an
         edit runs renders every block with the page's link definitions. */
      parseAll();

      if (saved) {
        var focused = blockOf(saved.blockId);
        focusId = null;
        if (focused) refreshRendered(focused);
      }
      renderAll();
      if (saved) editor.restoreCaret(saved, 'navigate');
      emit();
      return opts.showWriterNotes;
    },

    // A writing mode IS its token: a theme turns one on with one line and no
    // script, and the palette overrides the theme by setting it on the page.
    setWritingMode: function (name, on) {
      if (!page) return false;
      var next = on == null ? !tokenOn(name) : !!on;
      page.style.setProperty(name, next ? 'on' : 'off');
      frameReads.invalidateStyles();
      if (bus && bus.emit) bus.emit('writing:mode', { name: name, on: next });
      if (name === '--typewriter') typewriterLast = null;
      markFocusParagraph();
      requestOverlay('navigate');
      return next;
    },
    writingMode: function (name) { return tokenOn(name); },
    setSpellcheck: function (on) {
      opts.spellcheck = !!on;
      if (page) page.querySelectorAll('.cw-edit').forEach(function (edit) { edit.spellcheck = !!on; });
    },

    updateFootnote: function (key, text) {
      if (opts && opts.readOnly) return false;
      var definition = doc.blocks.find(function (b) {
        return b.type === 'footnote-def' && b.meta && b.meta.footnoteKey === key;
      });
      var b = definition && blockOf(definition.id);
      if (!b) return false;
      var prefix = /^(\[\^[^\]]+\]:[ \t]*)/.exec(b.source);
      if (!prefix) return false;
      var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
      var start = lines[0] ? (/[ \t]$/.test(prefix[1]) ? prefix[1] : prefix[1] + ' ') : prefix[1].trimEnd();
      var source = start + lines[0] + lines.slice(1).map(function (line) { return '\n' + (line ? '  ' + line : ''); }).join('');
      if (source === b.source) return true;
      pushUndo('footnote:' + key);
      b.source = source;
      parseAll();
      repaint(b.id);
      changed(true);
      return true;
    },

    nextFootnote: nextFootnote,

    getSource: getSource,
    getCurrentSource: function () { return getSource(true); },
    getDoc: function () { return doc; },
    getBlocks: function () { return blocks.map(function (b) { return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.sepType }; }); },

    scrollToBlock: function (id) {
      var el = elOf(id);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return !!el;
    },

    flashAnchor: function (anchor) {
      var md = MD();
      var hit = null;
      if (anchor && anchor.blockId) {
        var exactBlock = (doc.blocks || []).filter(function (b) { return b.id === anchor.blockId; })[0];
        var exactAt = exactBlock && exactBlock.text.indexOf(anchor.quote || '');
        if (exactAt >= 0) hit = { blockId: anchor.blockId, start: exactAt, end: exactAt + anchor.quote.length };
      }
      if (!hit) try { hit = md.resolveAnchor ? md.resolveAnchor(doc, anchor) : null; } catch (e) { hit = null; }
      if (!hit) return false;
      editor.scrollToBlock(hit.blockId);
      var el = elOf(hit.blockId);
      if (!el) return false;
      var target = hit.blockId === focusId ? el.querySelector('.cw-mirror') : el;
      var marked = markRange(target || el, anchor && anchor.quote);
      el.classList.add('flash', 'cw-flash-block');
      setTimeout(function () {
        el.classList.remove('flash', 'cw-flash-block');
        if (marked) {
          var b = blockOf(hit.blockId);
          if (hit.blockId === focusId && b) updateMirror(el, b); else repaint(hit.blockId);
        }
      }, 1600);
      return true;
    },

    insertMarkdown: function (markdown, saved) {
      if (opts.readOnly || composing || typeof markdown !== 'string') return false;
      editor.flush();
      if (saved && !editor.restoreCaret(saved)) return false;
      var caret = caretSource(), id = focusId;
      if (!id || !caret) return false;
      pushUndo('insert-link');
      applyEdit(id, caret.start, caret.end, markdown);
      return true;
    },

    insertAt: function (blockId, markdown) {
      pushUndo('insert');
      var focused = focusId && blockOf(focusId);
      if (focused) { focusId = null; refreshRendered(focused); }
      var nb = { id: mintId(), type: classify(markdown), source: markdown };
      var at = blockId ? idx(blockId) + 1 : blocks.length;
      if (at < 0) at = blocks.length;
      blocks.splice(at, 0, nb);
      refreshRendered(nb);
      renderAll();
      changed();
      return nb.id;
    },

    replaceBlock: function (blockId, markdown) {
      var b = blockOf(blockId); if (!b) return false;
      pushUndo('replace-block');
      pending = pending.filter(function (p) { return p.blockId !== blockId; });
      b.source = markdown;
      b.type = classify(markdown);
      if (focusId === blockId) {
        var host = editOf(blockId), node = textOf(host), c = caretSource();
        if (node) node.data = markdown;
        updateMirror(elOf(blockId), b);
        setCaret(blockId, Math.min(c ? c.start : markdown.length, markdown.length));
      } else {
        refreshRendered(b); repaint(blockId);
      }
      changed();
      return true;
    },

    focusBlock: focusBlock,
    command: command,
    can: can,
    commands: function () { return COMMAND_IDS.slice(); },
    blur: blurCurrent,
    hideKeyboard: function () {
      var host = focusId && editOf(focusId);
      if (!host || document.activeElement !== host || !host.blur) return false;
      editor.flush();
      keyboardCaret = editor.getCaret();
      host.blur();
      requestOverlay('snap');
      return true;
    },
    historyState: historyState,
    undo: undo,
    redo: redo,
    getSelectionAnchor: function () { return selAnchor; },
    hideSelectionMenu: hideSelMenu,
    closePicker: closePicker,
    isFocused: function () { return !!focusId; },
    pickerOpen: function () { return !!activePicker; },
    focusedBlockId: function () { return focusId; },
    getCaret: function () {
      var c = caretSource();
      return c && focusId ? { blockId: focusId, start: c.start, end: c.end } : null;
    },
    getSourceRange: function () {
      var range = frameReads.selection().range, host = focusId && editOf(focusId);
      if (!range) return null;
      if (!host || !host.contains(range.startContainer) || !host.contains(range.endContainer)) {
        return page && page.contains(range.startContainer) ? { unsupported: true } : null;
      }
      var caret = caretSource(); if (!caret) return null;
      var offset = 0;
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        if (block.empty && !block.source) continue;
        // The gap getSource() writes: a block keeps its own separator whatever its type (since
        // 61cd44b5). A separator Enter gave a definition has no sepType and still counts.
        var gap = typeof block.sep === 'string' ? block.sep : (i === 0 ? '' : '\n\n');
        offset += gap.length;
        if (block.id === focusId) return { start: offset + caret.start, end: offset + caret.end };
        offset += block.source.length;
      }
      return null;
    },
    restoreCaret: function (saved, mode) {
      if (!saved || !blockOf(saved.blockId)) return false;
      overlayMode = mode === 'navigate' ? 'navigate' : 'snap';
      focusBlock(saved.blockId, saved.start);
      setCaret(saved.blockId, saved.start, saved.end);
      return true;
    },
    metrics: function () {
      return { inputs: metrics.inputs, lastInputMs: metrics.lastInputMs, maxInputMs: metrics.maxInputMs,
        mirrors: metrics.mirrors, lastMirrorMs: metrics.lastMirrorMs, maxMirrorMs: metrics.maxMirrorMs,
        trails: metrics.trails, lastTrailMs: metrics.lastTrailMs, maxTrailMs: metrics.maxTrailMs };
    },
    resetMetrics: function () {
      metrics = { inputs: 0, lastInputMs: 0, maxInputMs: 0, mirrors: 0, lastMirrorMs: 0, maxMirrorMs: 0, trails: 0, lastTrailMs: 0, maxTrailMs: 0 };
    },
    world: world,

    pairing: shouldAutoClose,
    _internals: { renderInline: renderInline, classify: classify, markerLen: markerLen }
  };

  // Wrap the first occurrence of `quote` in a <mark> for the flash. Safe to do
  // destructively: the block is repainted from its source afterwards.
  function markRange(el, quote) {
    if (!quote) return false;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node, acc = '', nodes = [];
    while ((node = walker.nextNode())) { nodes.push({ node: node, at: acc.length }); acc += node.nodeValue; }
    var at = acc.indexOf(quote);
    if (at < 0) return false;
    var end = at + quote.length, range = document.createRange(), s = null, e = null;
    nodes.forEach(function (n) {
      var len = n.node.nodeValue.length;
      if (s === null && at >= n.at && at <= n.at + len) s = { node: n.node, off: at - n.at };
      if (e === null && end >= n.at && end <= n.at + len) e = { node: n.node, off: end - n.at };
    });
    if (!s || !e) return false;
    try {
      range.setStart(s.node, s.off); range.setEnd(e.node, e.off);
      var mark = document.createElement('mark');
      mark.className = 'flash cw-flash';
      range.surroundContents(mark);
      return true;
    } catch (err) { return false; }
  }

  editor.role = role;
  editor.on = function (k, fn) { return bus.on(k, fn); };
  if (!isArticle) return editor;
  Castor.editor = editor;
  return editor;
  }

  // Castor.createEditor(name) mounts another editor (a comment, a reply, a side note).
  Castor.createEditor = function (name) { instanceCount += 1; return createEditor(String(name || 'field') + instanceCount); };
  createEditor('article');

  /* A field written with the article's editor: a comment, a reply, a side
     note. To its caller it is the textarea it replaces -- value, placeholder,
     focus(), and keydown/input/blur on its element -- so their flows stay as they
     were. Two event details make that true: the caller's keydown runs before the
     editor's (Enter saves before it splits a paragraph), and blur means focus
     leaving the whole field, not moving between its paragraphs. */
  Castor.editorField = function (o) {
    o = o || {};
    var host = document.createElement('div');
    host.className = 'cw-field' + (o.className ? ' ' + o.className : '');
    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-multiline', 'true');
    if (o.label) host.setAttribute('aria-label', o.label);
    var ed = Castor.createEditor(o.name || 'field'), placeholder = '';
    // the field's text, without the separators an empty first paragraph leaves around it
    function current() { return ed.getCurrentSource().replace(/^\s+|\s+$/g, ''); }
    function sync() { host.setAttribute('data-empty', current() ? '0' : '1'); }
    function mount(v) {
      ed.mount(host, String(v == null ? '' : v), { field: true, showFrontmatter: false, notifyMount: false, onChange: sync });
      sync();
    }
    mount(o.value);
    Object.defineProperty(host, 'value', { configurable: true, get: current, set: mount });
    Object.defineProperty(host, 'placeholder', { configurable: true,
      get: function () { return placeholder; },
      set: function (v) { placeholder = String(v || ''); host.setAttribute('data-placeholder', placeholder); } });
    host.placeholder = o.placeholder || '';
    var add = host.addEventListener.bind(host);
    host.addEventListener = function (type, fn, capture) {
      // while the @name picker is open its keys are its own, not the caller's Enter or Escape
      if (type === 'keydown') return add(type, function (e) { if (ed.pickerOpen()) return; fn.call(host, e); }, true);
      if (type === 'blur') return add('focusout', function (e) { if (e.relatedTarget && host.contains(e.relatedTarget)) return; fn.call(host, e); }, capture);
      return add(type, fn, capture);
    };
    // focus() returns to where the writer was (a layout may move the field), else the end
    var kept = null;
    add('focusout', function () { kept = ed.getCaret() || kept; });
    host.focus = function () {
      if (kept && ed.restoreCaret(kept)) return;
      var list = ed.getBlocks(), last = list[list.length - 1];
      if (last) ed.restoreCaret({ blockId: last.id, start: last.source.length, end: last.source.length });
    };
    host.castorEditor = ed;
    return host;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.editor;
})(typeof window !== 'undefined' ? window : globalThis);
