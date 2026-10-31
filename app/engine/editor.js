/* Castor engine · editor.js — Markdown without seeing it.
 *
 * Unfocused blocks are md.js HTML. A focused block is deliberately simpler:
 * one browser-owned text node containing its exact Markdown, plus an inert
 * mirror which paints dim markers and formatting. Input never rebuilds the
 * contenteditable, so the visible caret and the insertion point cannot split.
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
  /* One editor, mounted as often as it is needed (round 1030, I1): the article,
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

  // The mirror paints source text, never caret state.
  var PAIRS_INLINE = [
    { d: '**', tag: 'strong' },
    { d: '__', tag: 'strong' },
    { d: '==', tag: 'mark' },
    { d: '~~', tag: 's' },
    { d: '*', tag: 'em' },
    { d: '_', tag: 'em' }
  ];

  function renderInline(src) {
    function mk(s, e, cls) { // a marker run
      return '<span class="cw-mk' + (cls ? ' ' + cls : '') + '">' + esc(src.slice(s, e)) + '</span>';
    }
    function tx(s, e, cls) { // a run of content characters
      if (e <= s) return '';
      return '<span class="cw-tx' + (cls ? ' ' + cls : '') + '">' + esc(src.slice(s, e)) + '</span>';
    }
    function walk(from, to) {
      var out = '', i = from, plain = from;
      function flush(at) { if (at > plain) out += tx(plain, at); plain = at; }
      while (i < to) {
        var c = src.charAt(i), j, k, m, rest;
        // backslash escape: the slash is a marker, the next char is literal
        if (c === '\\' && i + 1 < to) {
          flush(i); out += mk(i, i + 1) + tx(i + 1, i + 2); i += 2; plain = i; continue;
        }
        // `code span` — literal inside, no further parsing
        if (c === '`') {
          j = src.indexOf('`', i + 1);
          if (j >= 0 && j < to) {
            flush(i);
            out += '<code class="cw-code">' + mk(i, i + 1) + tx(i + 1, j) + mk(j, j + 1) + '</code>';
            i = j + 1; plain = i; continue;
          }
        }
        // ![[embed]] and ![[embed|400]]
        if (c === '!' && src.substr(i + 1, 2) === '[[') {
          j = src.indexOf(']]', i + 3);
          if (j >= 0 && j + 2 <= to) {
            flush(i);
            out += '<span class="cw-embed">' + mk(i, i + 3) + tx(i + 3, j, 'cw-target') + mk(j, j + 2) + '</span>';
            i = j + 2; plain = i; continue;
          }
        }
        // [[wiki]], [[wiki|shown]], [[wiki#heading]]
        if (c === '[' && src.charAt(i + 1) === '[') {
          j = src.indexOf(']]', i + 2);
          if (j >= 0 && j + 2 <= to) {
            flush(i);
            var inner = src.slice(i + 2, j);
            var bar = inner.indexOf('|');
            out += '<a class="wikilink cw-wiki" data-target="' + esc(bar >= 0 ? inner.slice(0, bar) : inner) + '">';
            if (bar >= 0) {
              // the target and the pipe are markers; the shown label is content
              out += mk(i, i + 2 + bar + 1) + tx(i + 2 + bar + 1, j) + mk(j, j + 2);
            } else {
              out += mk(i, i + 2) + tx(i + 2, j) + mk(j, j + 2);
            }
            out += '</a>';
            i = j + 2; plain = i; continue;
          }
        }
        // [^footnote] reference
        if (c === '[' && src.charAt(i + 1) === '^') {
          j = src.indexOf(']', i + 2);
          if (j >= 0 && j < to) {
            flush(i);
            out += '<sup class="cw-fnref" data-footnote="' + esc(src.slice(i + 2, j)) + '" data-source-end="' + (j + 1) + '">' + mk(i, i + 2) + tx(i + 2, j) + mk(j, j + 1) + '</sup>';
            i = j + 1; plain = i; continue;
          }
        }
        // ![alt](src) image, then [text](url) link
        if ((c === '!' && src.charAt(i + 1) === '[') || c === '[') {
          var isImg = c === '!';
          var open = isImg ? i + 2 : i + 1;
          var close = matchBracket(open, to);
          if (close > 0 && src.charAt(close + 1) === '(') {
            var paren = src.indexOf(')', close + 2);
            if (paren > 0 && paren < to) {
              flush(i);
              var tag = isImg ? 'span class="cw-img"' : 'a class="cw-link"';
              var end = isImg ? 'span' : 'a';
              out += '<' + tag + '>' + mk(i, open) + tx(open, close) + mk(close, paren + 1) + '</' + end + '>';
              i = paren + 1; plain = i; continue;
            }
          }
        }
        // emphasis family. Longest delimiter first (** before *).
        for (k = 0; k < PAIRS_INLINE.length; k++) {
          var p = PAIRS_INLINE[k], d = p.d;
          if (src.substr(i, d.length) !== d) continue;
          if (!canOpen(i, d)) continue;
          var closeAt = findClose(i + d.length, d, to);
          if (closeAt < 0) continue;
          flush(i);
          out += '<' + p.tag + '>' + mk(i, i + d.length) + walk(i + d.length, closeAt) + mk(closeAt, closeAt + d.length) + '</' + p.tag + '>';
          i = closeAt + d.length; plain = i;
          break;
        }
        if (k < PAIRS_INLINE.length) continue;
        // #tag — only at a line start or after whitespace, never `#` mid-word
        if (c === '#' && (i === from || /\s/.test(src.charAt(i - 1)))) {
          rest = /^#[A-Za-z0-9_À-ɏ/-]+/.exec(src.slice(i, to));
          if (rest) { flush(i); out += tx(i, i + rest[0].length, 'cw-tag'); i += rest[0].length; plain = i; continue; }
        }
        i++;
      }
      flush(to);
      return out;
    }
    // A `*`/`_`/`**` run only opens when it is not glued to a word on its left
    // and has something other than a space on its right. This is why the
    // fixture's `snake*case*here` stays plain text: `*` is preceded by `e`.
    function canOpen(i, d) {
      var before = i > 0 ? src.charAt(i - 1) : '';
      var after = src.charAt(i + d.length);
      if (!after || /\s/.test(after)) return false;
      if (isAlnum(before)) return false;
      return true;
    }
    function findClose(from, d, to) {
      var i = from;
      while (i < to) {
        var at = src.indexOf(d, i);
        if (at < 0 || at + d.length > to) return -1;
        var before = src.charAt(at - 1);
        var after = src.charAt(at + d.length);
        if (at > from && !/\s/.test(before) && !isAlnum(after)) return at;
        i = at + 1;
      }
      return -1;
    }
    function matchBracket(from, to) {
      var depth = 1, i = from;
      while (i < to) {
        var c = src.charAt(i);
        if (c === '\\') { i += 2; continue; }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (!depth) return i; }
        i++;
      }
      return -1;
    }
    return { html: walk(0, src.length) };
  }
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
    if (/^\s*\|/.test(first)) return 'table';
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(src.trim())) return 'hr';
    if (/^\[\^[^\]]+\]:/.test(first)) return 'footnote-def';
    if (/^!\[\[[^\]]+\]\]\s*$/.test(src.trim())) return 'embed';
    return 'p';
  }

  // Length of the markdown marker at the head of a source line (heading hashes,
  // list bullet, quote arrows, task box). Rendered dim, kept in the source.
  function markerLen(line) {
    var m = /^(#{1,6})(?:[ \t]+|$)/.exec(line);
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

  function lineHtml(line) {
    var mlen = markerLen(line);
    var out = '';
    if (mlen) out += '<span class="cw-mk cw-mk-block">' + esc(line.slice(0, mlen)) + '</span>';
    return out + renderInline(line.slice(mlen)).html;
  }

  function liveHtml(block) {
    var src = block.source, type = block.type, lvl = headingLevel(type);
    if (type === 'code') {
      return '<pre class="cw-live"><code>' + linesHtml(src, true) + '</code></pre>';
    }
    if (MULTILINE[type]) {
      var tag = (type === 'quote' || type === 'callout') ? 'blockquote' : 'div';
      var cls = 'cw-live cw-lines cw-t-' + type;
      return '<' + tag + ' class="' + cls + '">' + linesHtml(src, false) + '</' + tag + '>';
    }
    var t = lvl ? 'h' + lvl : 'p';
    var html = lineHtml(src);
    return '<' + t + ' class="cw-live">' + (html || '<br>') + '</' + t + '>';
  }

  function linesHtml(src, raw) {
    var lines = src.split('\n'), out = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var html = raw ? (line ? '<span class="cw-tx">' + esc(line) + '</span>' : '<br>') : lineHtml(line);
      out += '<div class="cw-line">' + (html || '<br>') + '</div>';
    }
    return out;
  }

  function MD() {
    if (!Castor.md || !Castor.md.parse) throw new Error('Castor editor requires md.js before mount');
    return Castor.md;
  }

  // A focused host is intentionally boring: exactly one text node. Offsets are
  // therefore browser offsets, not a reconstruction through formatted spans.
  function editOf(id) {
    var el = elOf(id);
    return el && el.querySelector('.cw-edit');
  }
  function textOf(host) {
    return host && host.childNodes.length === 1 && host.firstChild.nodeType === 3 ? host.firstChild : null;
  }
  function domOffset(host, node, offset) {
    var text = textOf(host);
    // An empty native host may hold a caret on itself or its placeholder <br>.
    if (!text) return host && host.textContent === '' && (node === host || host.contains(node)) ? 0 : null;
    if (!host.contains(node)) return null;
    if (node === text) return clamp(offset, 0, text.data.length);
    if (node === host) return offset > 0 ? text.data.length : 0;
    var r = document.createRange();
    try { r.selectNodeContents(host); r.setEnd(node, offset); return r.toString().length; }
    catch (e) { return null; }
  }

  var OPENERS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '*': '*', '_': '_', '`': '`' };
  var CLOSERS = { ')': 1, ']': 1, '}': 1, '"': 1, "'": 1, '*': 1, '_': 1, '`': 1, '=': 1, '~': 1 };

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
  var pending = [];              // auto-inserted closers awaiting a step-over
  var stepOver = null;           // the closer the last keystroke stepped over
  var selMenu = null, selAnchor = null;
  var activePicker = null;       // {kind, start, len, handle}
  var reparseTimer = null, composing = false, compositionId = null, compositionState = null, mounted = false;
  var caretEl = null, caretLayer = null, selectionLayer = null, washLayer = null, overlayRaf = 0;
  var handles = null, draggingHandle = null, lastCaret = null;
  var CARET_TYPE_MS = 90, CARET_JUMP_MS = 140, CARET_GLIDE_CAP_MS = 160;
  var caretRaf = 0, caretMotion = null, caretVisual = null;
  var caretReducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)');
  var touchInput = false, touchMoved = false, touchStart = null, everFocused = false;
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
      '.cw-block>*{margin:0}',
      '.cw-editor-stack{display:grid;position:relative}',
      '.cw-editor-stack>.cw-edit,.cw-editor-stack>.cw-mirror{grid-area:1/1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.cw-edit{position:relative;z-index:2;outline:none;color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent}',
      '.cw-edit::selection{background:transparent;color:transparent;-webkit-text-fill-color:transparent}',
      '.cw-mirror{position:relative;z-index:1;pointer-events:none;user-select:none}',
      '.cw-mirror .cw-live{margin:0}',
      '.cw-mirror strong{font-weight:inherit;text-shadow:.018em 0 currentColor,-.018em 0 currentColor}',
      '.cw-mirror em{font-style:oblique 8deg}.cw-mirror mark{padding:0}.cw-mirror code,.cw-mirror .cw-code,.cw-mirror .cw-fnref{font:inherit;vertical-align:baseline}',
      '.cw-mk{opacity:.32;font-weight:400;font-style:normal}',
      // A source that ends in a newline gets NO line box from `pre-wrap`: the
      // soft break the writer just made is invisible and its caret has no rect.
      // A zero-width pseudo-element after both layers gives that last line its
      // box without adding a child node, so `textOf(host)` still sees exactly
      // one browser-owned text node.
      '.cw-edit::after,.cw-mirror .cw-live:not(.cw-lines)::after{content:"\\200B"}',
      '.cw-writer-only{opacity:.45;font-style:italic}',
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
      '.cw-wash-layer{position:fixed;inset:0;z-index:2;pointer-events:none}',
      '.cw-focus-wash{position:absolute;left:0;top:0;width:1px;height:1px;transform-origin:0 0}',
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
    syncHeadings();
    return fresh;
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
    return esc(String(b.source || '').replace(/%%/g, '').trim());
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
    edit.setAttribute('aria-label', 'Markdown block');
    // The visible text is the mirror; the host's own text is transparent, so a
    // spell underline would be drawn under characters nobody can see, and an
    // autocorrect would rewrite Markdown markers behind the writer's back.
    edit.setAttribute('autocorrect', 'off');
    edit.setAttribute('autocapitalize', 'off');
    edit.setAttribute('autocomplete', 'off');
    edit.setAttribute('data-enable-grammarly', 'false');
    edit.spellcheck = !!opts.spellcheck;
    // This node is never replaced while focused. Native typing and IME own it.
    edit.appendChild(document.createTextNode(b.source));
    stack.appendChild(mirror); stack.appendChild(edit); wrap.appendChild(stack);
    updateMirror(wrap, b);
  }

  function updateMirror(wrap, b) {
    var started = global.performance && performance.now ? performance.now() : Date.now();
    b.type = classify(b.source);
    wrap.setAttribute('data-type', b.type);
    var mirror = wrap.querySelector('.cw-mirror');
    if (mirror) {
      mirror.innerHTML = liveHtml(b);
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
      focusedContents(wrap, b);
      wrap.classList.add('cw-focused');
    } else {
      wrap.classList.remove('cw-focused');
      var html = rendered[b.id] != null ? rendered[b.id] : MD().blockToHtml(b);
      // Frontmatter and %%writer notes%% render as nothing for a reader. For a
      // WRITER they must still be visible and clickable, or a block exists in
      // the file that cannot be reached in the page. Show the source, dimmed.
      /* asked of what the block RENDERS, not of whether the string is empty: a
         `**[NAME: …]**` block renders `<strong></strong>`, which is a non-empty
         string and an empty paragraph on the page. */
      wrap.innerHTML = !writerOnly(b) ? html
        : (opts.showWriterNotes === false ? ''
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
        if (writerOnly(b)) html = opts.showWriterNotes === false ? ''
          : '<div class="cw-writer-only">' + writerNoteHtml(b) + '</div>';
        return '<div class="cw-block" data-block-id="' + esc(b.id) + '" data-type="' + esc(b.type) + '">' + html + '</div>';
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

  function setCaret(id, start, end) {
    var el = editOf(id), text = textOf(el); if (!el || !text) return;
    var b = blockOf(id); if (!b) return;
    start = clamp(start, 0, b.source.length);
    end = clamp(end == null ? start : end, 0, b.source.length);
    var sel = global.getSelection();
    var r = document.createRange();
    try {
      r.setStart(text, start);
      r.setEnd(text, end);
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
    if (!washLayer) {
      washLayer = document.createElement('div');
      washLayer.className = 'cw-wash-layer';
      washLayer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(washLayer);
    }
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
    [washLayer, selectionLayer, caretLayer].forEach(function (layer) { layer.style.clipPath = clip; });
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
  function rectsBetween(text, a, b) {
    var r = document.createRange();
    try { r.setStart(text, a); r.setEnd(text, b); }
    catch (e) { return []; }
    return Array.prototype.slice.call(r.getClientRects()).filter(function (x) { return x.height > 0; });
  }

  function caretGeometry(host, offset, forward) {
    var text = textOf(host); if (!text) return null;
    var style = frameReads.style(host);
    var lineHeight = parseFloat(style.lineHeight);
    if (!lineHeight) lineHeight = (parseFloat(style.fontSize) || 16) * 1.4;
    var data = text.data, len = data.length, rects, r;
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
    var text = textOf(host); if (!text) return off;
    var len = text.data.length;
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
    return { caret: caret, selection: [], bounds: bounds, wash: readWash(caret) };
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
    // The shade behind the caret. It sits with the other per-frame painters and
    // ABOVE the caret's own early return: a hidden caret still has a sentence,
    // and a world that lights it (Typewell) must not lose the wash the moment
    // the caret is hidden by a selection.
    paintWash(state.wash, mode);
    paintTrail(state.caret);
    typewriterLine(state.caret);
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

  // "The shade that it creates behind" — a wash under the sentence the caret is
  // in. Off unless the world sets --focus-wash to a real colour, so a world that
  // wants a quiet page pays nothing for it.
  function washColor(host) {
    if (frameReads.style(host).getPropertyValue('--focus-sentence').trim() === 'off') return '';
    var v = frameReads.style(host).getPropertyValue('--focus-wash').trim();
    return (!v || v === 'none' || v === 'transparent') ? '' : v;
  }
  function sentenceRange(source, at) {
    var start = 0, end = source.length, i;
    for (i = Math.min(at, source.length) - 1; i >= 0; i--) {
      if (/[.!?\n]/.test(source.charAt(i)) && !(source.charAt(i) === '.' && /\d/.test(source.charAt(i + 1) || ''))) { start = i + 1; break; }
    }
    for (i = Math.max(0, at); i < source.length; i++) {
      if (/[.!?\n]/.test(source.charAt(i))) { end = i + 1; break; }
    }
    while (start < end && /\s/.test(source.charAt(start))) start++;
    return { start: start, end: end };
  }
  function readWash(caret) {
    var host = caret && caret.host, text = host && textOf(host);
    var colour = host ? washColor(host) : '';
    var rects = [];
    if (colour && text && focusId) {
      var b = blockOf(focusId);
      var range = frameReads.selection().range;
      var off = range ? domOffset(host, range.startContainer, range.startOffset) : null;
      if (b && off != null) {
        var s = sentenceRange(b.source, off);
        rects = mergeLineRects(rectsBetween(text, s.start, s.end).map(function (r) {
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        }));
      }
      if (!rects.length) rects = [{ left: caret.left, top: caret.lineTop, right: caret.left, bottom: caret.lineTop + caret.lineHeight, width: 0, height: caret.lineHeight }];
    }
    // Line boxes are measured before any overlay style is written.
    var band = caret && caret.lineHeight ? caret.lineHeight : 0;
    return { colour: colour, rects: rects.map(function (r) {
      var height = Math.max(band, r.height * 1.24);
      return { left: r.left, top: r.top + r.height / 2 - height / 2, width: r.width, height: height };
    }) };
  }
  function paintWash(wash, mode) {
    if (!washLayer) return;
    var rects = wash ? wash.rects : [], colour = wash ? wash.colour : '';
    // Keep the world's resting shade; only our own nodes are ours to paint.
    var mine = Array.prototype.filter.call(washLayer.children, function (n) {
      return n.getAttribute('data-owner') === 'editor';
    });
    while (mine.length < rects.length) {
      var node = document.createElement('i');
      node.className = 'cw-focus-wash';
      node.setAttribute('data-owner', 'editor');
      washLayer.appendChild(node);
      mine.push(node);
    }
    mine.forEach(function (node, i) {
      var r = rects[i];
      node.style.opacity = r ? '1' : '0';
      if (!r) return;
      node.setAttribute('data-snap', mode === 'snap' ? '1' : '0');
      if (node.style.background !== colour) node.style.background = colour;
      node.style.transform = 'translate3d(' + r.left + 'px,' + r.top + 'px,0) scale(' + r.width + ',' + r.height + ')';
    });
  }
  // --- touch: real drag handles at both ends of a selection --------------------
  function coarsePointer() {
    return touchInput || !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
  }
  function paintHandles(selection) {
    if (!handles) return;
    var on = selection.length > 0 && coarsePointer();
    var first = selection[0], last = selection[selection.length - 1];
    handles.forEach(function (h, i) {
      h.hidden = !on;
      if (!on) return;
      var r = i === 0 ? first : last;
      var x = i === 0 ? r.left : r.right;
      h.style.transform = 'translate3d(' + x + 'px,' + r.bottom + 'px,0)';
      h.style.setProperty('--handle-line', r.height + 'px');
    });
  }
  function startHandleDrag(e, which) {
    var sel = global.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    e.preventDefault();
    var range = sel.getRangeAt(0).cloneRange();
    draggingHandle = { which: which, range: range };
    var node = e.currentTarget;
    try { node.setPointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    function move(ev) {
      var p = pointToPosition(ev.clientX, ev.clientY);
      if (!p) return;
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
    var text = textOf(host); if (!text) return null;
    var data = text.data, len = data.length;
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
    if (dx > pick.w / 2) return wordEdge(data, pick.off, x < pick.x);
    return pick.off;
  }
  function pointToPosition(x, y) {
    var r = pointToCaret(x, y);
    if (!r) return null;
    var host = r.startContainer;
    if (host.nodeType === 3) host = host.parentNode;
    var edit = host && host.closest ? host.closest('.cw-edit') : null;
    if (edit && textOf(edit)) {
      var off = offsetFromPoint(edit, x, y);
      if (off != null) return { node: textOf(edit), offset: off };
    }
    return { node: r.startContainer, offset: r.startOffset };
  }
  function placePreciseCaret(id, x, y) {
    var host = editOf(id);
    if (!host || !textOf(host)) return false;
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
        pending = [];
        requestOverlay('snap');
        return;
      }
      refreshRendered(b);
    }
    repaint(was);
    pending = [];
    requestOverlay('snap');
  }

  function snapshot() {
    var c = caretSource();
    return {
      blocks: blocks.map(function (b) { return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.sepType, empty: b.empty }; }),
      focusId: focusId,
      caret: c ? c.start : null,
      selectionEnd: c ? c.end : null
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
    var scroll = scroller(), left = scroll === global ? global.scrollX || 0 : scroll.scrollLeft;
    var top = scroll === global ? global.scrollY || 0 : scroll.scrollTop;
    blocks = s.blocks.map(function (b) { return { id: b.id, type: b.type, source: b.source, sep: b.sep, sepType: b.sepType, empty: b.empty }; });
    focusId = null;
    blocks.forEach(function (b) { refreshRendered(b); });
    focusId = s.focusId && idx(s.focusId) >= 0 ? s.focusId : null;
    keyboardCaret = null;
    renderAll();
    if (focusId) setCaret(focusId, s.caret == null ? 0 : s.caret, s.selectionEnd == null ? undefined : s.selectionEnd);
    changed(true);
    if (scroll === global) { if (global.scrollTo) global.scrollTo({ left: left, top: top, behavior: 'instant' }); }
    else { scroll.scrollLeft = left; scroll.scrollTop = top; }
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
      parseAll();
      // The focused text node is never touched. A block under a reader selection
      // also keeps the DOM to which the native Range points.
      blocks.forEach(function (b) {
        var old = before[b.id];
        if (b.id !== keep && !held[b.id] &&
            (!old || old.source !== b.source || old.type !== b.type || old.html !== rendered[b.id])) repaint(b.id);
      });
      repositionSelMenu();
      requestOverlay('snap');
      emit();
    }, 160);
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
    metrics.inputs++;
    metrics.lastInputMs = took;
    metrics.maxInputMs = Math.max(metrics.maxInputMs, took);
  }

  function changedSpan(before, after) {
    var start = 0;
    while (start < before.length && start < after.length && before.charAt(start) === after.charAt(start)) start++;
    var a = before.length, b = after.length;
    while (a > start && b > start && before.charAt(a - 1) === after.charAt(b - 1)) { a--; b--; }
    return { start: start, end: a, insertedLength: b - start };
  }

  function syncNativeInput(intent, restoreOffset) {
    var host = focusId && editOf(focusId), b = focusId && blockOf(focusId);
    if (!host || !b) return;
    var raw = host.textContent.replace(/\r\n?/g, '\n');
    if (raw === b.source) { if (restoreOffset != null) setCaret(b.id, restoreOffset); return; }
    var span = changedSpan(b.source, raw);
    b.source = raw;
    if (restoreOffset != null) setCaret(b.id, restoreOffset);
    adjustPending(b.id, span.start, span.end, span.insertedLength);
    b.type = classify(raw);
    updateMirror(elOf(b.id), b);
    changed();
    if (intent && intent.data && intent.data.length === 1) afterInsert(b.id, intent.data);
    else if (activePicker && activePicker.blockId === b.id) updatePicker();
  }

  function restoreSingleTextNode(host) {
    if (!host || textOf(host)) return null;
    var sel = global.getSelection(), off = null;
    if (sel && sel.rangeCount && host.contains(sel.anchorNode)) {
      try {
        var before = document.createRange();
        before.selectNodeContents(host); before.setEnd(sel.anchorNode, sel.anchorOffset);
        off = before.toString().length;
      } catch (e) { off = null; }
    }
    var raw = host.textContent.replace(/\r\n?/g, '\n');
    host.textContent = '';
    host.appendChild(document.createTextNode(raw));
    return off;
  }

  // Programmatic mutations (pairs, pickers, structural edits) splice the one
  // text node in place. Ordinary typing does not come through here: the browser
  // edits that node natively and onInput mirrors its resulting string.

  function applyEdit(id, start, end, text, caretAt) {
    if (opts && opts.readOnly) return;
    var b = blockOf(id); if (!b) return;
    start = clamp(start, 0, b.source.length);
    end = clamp(end, start, b.source.length);
    var oldEnd = end;
    b.source = b.source.slice(0, start) + text + b.source.slice(end);
    adjustPending(id, start, oldEnd, text.length);
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
      return !!b && b.source.charAt(p.index) === p.ch;
    });
  }

  function insertText(id, ch) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return false;

    // 1 · a selection plus a pair character wraps the selection
    if (c.end > c.start && OPENERS[ch] && ch.length === 1) {
      pushUndo('wrap');
      var inner = b.source.slice(c.start, c.end);
      applyEdit(id, c.start, c.end, ch + inner + OPENERS[ch], c.start + 1 + inner.length + 1);
      return true;
    }
    if (c.end > c.start) return false;

    var at = c.start, next = b.source.charAt(at), prev = b.source.charAt(at - 1);
    var wasStep = stepOver; stepOver = null;

    if ((ch === '*' || ch === '_' || ch === '`') && prev === ch && next === ch &&
        b.source.charAt(at - 2) !== ch &&
        !(wasStep && wasStep.blockId === id && wasStep.index === at && wasStep.ch === ch) &&
        pending.some(function (p) { return p.blockId === id && p.index === at && p.ch === ch; })) {
      pushUndo('pair');
      applyEdit(id, at, at, ch + ch, at + 1);
      pending.push({ blockId: id, index: at + 1, ch: ch });
      return true;
    }

    // 3 · step over an auto-inserted closer instead of doubling it
    if (CLOSERS[ch] && next === ch) {
      var hit = pending.filter(function (p) { return p.blockId === id && p.index === at && p.ch === ch; })[0];
      if (hit) {
        pending = pending.filter(function (p) { return p !== hit; });
        overlayMode = 'snap';
        stepOver = { blockId: id, index: at + 1, ch: ch };
        setCaret(id, at + 1);
        return true;
      }
    }

    if (ch === ' ' && next === '*') {
      var ls = b.source.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
      if (/^[ \t]*\*$/.test(b.source.slice(ls, at)) &&
          pending.some(function (p) { return p.blockId === id && p.index === at && p.ch === '*'; })) {
        pushUndo('type');
        applyEdit(id, at, at + 1, ' ', at + 1);
        return true;
      }
    }

    // 4 · `[[` — the second bracket lands inside the pair the first one made,
    //     so `[|]` becomes `[[|]]` and the wiki picker opens.
    if (ch === '[' && prev === '[' && next === ']') {
      pushUndo('pair');
      applyEdit(id, at, at, '[]', at + 1);
      pending.push({ blockId: id, index: at + 1, ch: ']' });
      openPicker('wiki', id, at - 1, 2);
      return true;
    }

    // 5 · plain auto-close
    if (OPENERS[ch] && shouldAutoClose(ch, prev, next)) {
      pushUndo('pair');
      applyEdit(id, at, at, ch + OPENERS[ch], at + 1);
      pending.push({ blockId: id, index: at + 1, ch: OPENERS[ch] });
      afterInsert(id, ch);
      return true;
    }

    if (at === b.source.length && /\n$/.test(b.source)) {
      pushUndo('type');
      applyEdit(id, at, at, ch, at + ch.length);
      afterInsert(id, ch);
      return true;
    }
    return false;
  }

  function shouldAutoClose(ch, prev, next) {
    // never close into a word: don't't, snake_case, 3*4
    if ((ch === "'" || ch === '"') && isAlnum(prev)) return false;
    if ((ch === '*' || ch === '_' || ch === '`') && isAlnum(prev)) return false;
    if (isAlnum(next) || next === OPENERS[ch]) return false;
    return true;
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
    if (ch === '^' && b.source.charAt(at - 2) === '[') { openPicker('footnote', id, at - 2, 2); return; }
  }

  function splitBlock(id) {
    var b = blockOf(id), c = caretSource();
    if (!b || !c) return;
    pushUndo('split');
    var head = b.source.slice(0, c.start), tail = b.source.slice(c.end);
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
      applyEdit(id, c.start, c.end, '\n' + nextMarker, c.start + 1 + nextMarker.length);
      return;
    }

    b.source = head;
    b.type = classify(head);
    var nb = { id: mintId(), type: classify(tail), source: tail };
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
    var raw = b.type === 'code' || b.type === 'frontmatter' || b.type === 'table';
    var lineStart = b.source.lastIndexOf('\n', Math.max(0, c.start - 1)) + 1;
    var line = b.source.slice(lineStart, c.start);
    var lead = '';
    if (!raw && MULTILINE[b.type]) {
      var quoted = /^(\s*)((?:>\s?)+)/.exec(line);
      // a quote keeps its arrows; a list item keeps the hang of its own marker
      lead = quoted ? quoted[0] : new Array(markerLen(line) + 1).join(' ');
    }
    var text = raw ? '\n' : '  \n' + lead;
    pushUndo('break');
    applyEdit(id, c.start, c.end, text, c.start + text.length);
  }

  function mergeBack(id) {
    var i = idx(id); if (i <= 0) return false;
    var p = firstVisibleBefore(i); if (p < 0) return false;
    var b = blocks[i], prev = blocks[p];
    pushUndo('merge');
    var at = prev.source.length;
    prev.source = prev.source + b.source;
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
    for (var i = 0; i < PAIRED.length; i++) {
      var d = PAIRED[i];
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
  function openPicker(kind, id, start, len) {
    if (!Castor.commands || !Castor.commands.picker) return;
    if (!isArticle && kind !== 'mention') return;   // a field takes @names, not blocks, links or footnotes
    closePicker();
    var handle = Castor.commands.picker(kind, {
      anchorRect: null,
      query: '',
      doc: doc,
      onPick: function (item) { applyPick(item); },
      onCancel: function () { activePicker = null; requestOverlay('navigate'); }
    });
    if (!handle) return;
    activePicker = { kind: kind, blockId: id, start: start, len: len, handle: handle };
    updatePicker();
  }
  function updatePicker() {
    if (pickerRaf) return;
    pickerRaf = requestAnimationFrame(function () { pickerRaf = 0; updatePickerNow(); });
  }
  function updatePickerNow() {
    if (!activePicker) return;
    var b = blockOf(activePicker.blockId), c = caretSource();
    if (!b || !c || c.start < activePicker.start + activePicker.len) { closePicker(); return; }
    var q = b.source.slice(activePicker.start + activePicker.len, c.start);
    if (/\n/.test(q) || q.length > 80 || activePicker.kind === 'block' && q.charAt(0) === ' ') { closePicker(); return; }
    if (activePicker.kind === 'wiki') q = q.replace(/\]\]$/, '');
    activePicker.handle.update(q, caretRect());
  }
  function closePicker() {
    if (pickerRaf) { cancelAnimationFrame(pickerRaf); pickerRaf = 0; }
    if (activePicker && activePicker.handle) activePicker.handle.close();
    activePicker = null;
    requestOverlay('navigate');
  }
  function applyPick(item) {
    if (!activePicker || !item) { closePicker(); return; }
    var p = activePicker, b = blockOf(p.blockId), c = caretSource();
    activePicker = null;
    if (!b || !c) return;
    var end = c.start;
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
    if (p.kind === 'wiki' && b.source.substr(end, 2) === ']]') end += 2;
    else if (p.kind === 'footnote' && p.len && b.source.charAt(end) === ']') end += 1;
    if (p.kind === 'footnote' || item.id === 'footnote') {
      if (p.handle) p.handle.close();
      insertFootnote(p.blockId, p.start, end);
      return;
    }
    var text = item.insert != null ? item.insert : (item.label || '');
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
    if (!el || !page.contains(el)) return null;
    var id = el.getAttribute('data-block-id');
    var b = (doc.blocks || []).filter(function (x) { return x.id === id; })[0] || blockOf(id);
    var quote = sel.toString();
    if (!quote.trim()) return null;
    var selectedHost = host.closest && host.closest('.cw-edit,.cw-mirror');
    var textNode = selectedHost && el.contains(selectedHost) ? selectedHost : el;
    if (!textNode.contains(r.startContainer) || !textNode.contains(r.endContainer)) return null;
    var text = textNode.textContent, at = blockTextOffset(textNode, r.startContainer, r.startOffset);
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
    caretSource();
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
  function onClick(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (e.target.closest && e.target.closest('a[href]')) return; // let a real link work
    var el = e.target.closest ? e.target.closest('.cw-block') : null;
    if (!el) return;
    var sel = global.getSelection();
    if (sel && !sel.isCollapsed) return;      // a drag-select, not a caret click
    if (opts && opts.readOnly) return;        // read only: a click never opens a block for typing
    var id = el.getAttribute('data-block-id');
    if (id === focusId) {
      // A mouse inside the focused host is already exact and owns double-click
      // word selection; a finger is not, so it is re-placed on the boundary.
      if (touchInput) { placePreciseCaret(id, e.clientX, e.clientY); requestOverlay('navigate'); }
      return;
    }
    focusBlock(id, 0);
    // Re-hit-test against the raw text node at the same screen point. From this
    // moment onward the browser owns the position; the mirror cannot receive it.
    placePreciseCaret(id, e.clientX, e.clientY);
    requestOverlay('navigate');
  }
  function onTouchStart(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    lastUndoKind = '';
    touchInput = true;
    touchMoved = false;
    touchStart = e.touches && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }
  function onTouchMove(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (!touchStart || !e.touches || !e.touches.length) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - touchStart.x) > 8 || Math.abs(t.clientY - touchStart.y) > 8) touchMoved = true;
  }
  function onTouchEnd(e) {
    var subtitle = e.target && e.target.closest && e.target.closest('.cw-subtitle');
    if (subtitle && subtitle.classList && subtitle.classList.contains('cw-subtitle')) return;
    if (touchMoved || !page || !e.changedTouches || e.changedTouches.length !== 1) return;
    // Read only: a tap never opens a block for typing, the same rule as a click,
    // and it must not collapse a long-press selection someone is about to comment on.
    if (opts && opts.readOnly) return;
    var sel = global.getSelection && global.getSelection();
    var selected = sel && sel.rangeCount && !sel.isCollapsed && sel.getRangeAt(0);
    if (selected && page.contains(selected.startContainer) && page.contains(selected.endContainer)) return;
    var t = e.changedTouches[0];
    var at = document.elementFromPoint(t.clientX, t.clientY);
    if (at && at.closest && at.closest('a[href]')) return; // the synthetic click opens the link
    var el = at && at.closest ? at.closest('.cw-block') : null;
    if (!el || !page.contains(el)) return;
    var id = el.getAttribute('data-block-id');
    if (id !== focusId) focusBlock(id, 0);
    placePreciseCaret(id, t.clientX, t.clientY);
    requestOverlay('navigate');
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
  }
  function crossHostRange(host) {
    var r = frameReads.selection().range;
    return !!(r && page && page.contains(r.startContainer) && page.contains(r.endContainer) &&
      (!host.contains(r.startContainer) || !host.contains(r.endContainer)));
  }
  function retireNativeHost(host) {
    // End only the unsupported editing host. A preceding valid IME input may
    // be kept, but a later cross-host mutation must never reach finishComposition.
    finishComposition();
    if (host.blur) host.blur();
    blurCurrent();
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
    handledBackspace = false;
    var started = global.performance && performance.now ? performance.now() : Date.now();
    overlayMode = 'snap';
    if (t === 'insertText' && e.data != null) {
      var chars = e.data;
      if (chars.length === 1 && insertText(focusId, chars)) {
        e.preventDefault(); finishInput(started); return;
      }
      var c = caretSource();
      pushUndo(chars.length === 1 ? (c && c.end > c.start ? 'replace' : 'type') : 'paste');
      nativeIntent = { data: chars, started: started };
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
      else { pushUndo('delete'); nativeIntent = { data: null, started: started }; }
      return;
    }
    if (t === 'deleteContentForward' || t === 'deleteWordForward') {
      var cf = caretSource(), bf = blockOf(focusId);
      if (cf && bf && cf.start === bf.source.length && cf.end === cf.start) { e.preventDefault(); forwardDelete(focusId); finishInput(started); }
      else { pushUndo('delete'); nativeIntent = { data: null, started: started }; }
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
      pushUndo('delete'); nativeIntent = { data: null, started: started };
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
    pushUndo('paste');
    applyEdit(focusId, c.start, c.end, text.replace(/\r\n?/g, '\n'));
    var b = blockOf(focusId);
    if (/\n\s*\n/.test(b.source)) {
      var pastedId = focusId;
      focusId = null;
      refreshRendered(b);
      renderAll();
      focusBlock(pastedId, b.source.length);
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
      lastUndoKind = '';
      overlayMode = 'navigate';
      requestOverlay('navigate');
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
      if (host && crossHostRange(host)) { retireNativeHost(host); return; }
      var range = frameReads.selection().range;
      if (host && range && host.contains(range.startContainer) && host.contains(range.endContainer) && compositionState && compositionState.host === host) compositionState.source = host.textContent;
      return;
    }
    if (handledBackspace && e && e.inputType === 'deleteContentBackward') return;
    handledBackspace = false;
    var intent = nativeIntent || { data: e && e.data, started: global.performance && performance.now ? performance.now() : Date.now() };
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
      if (saved && saved.blockId === focusId && saved.source === current.source && after && after.start === after.end) {
        var length = raw.length - (current.source.length - (saved.end - saved.start));
        var inserted = length >= 0 ? raw.slice(saved.start, saved.start + length) : null;
        if (inserted != null && (e.data == null || e.data === inserted) && after.start === saved.start + length &&
            raw === current.source.slice(0, saved.start) + inserted + current.source.slice(saved.end)) {
          before = { start: saved.start, end: saved.end };
        }
      }
      pushUndo(deleting ? 'delete' : span.end > span.start ? 'replace' : 'type', before);
    }
    syncNativeInput(intent, restored);
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
    compositionState = { source: host.textContent, host: host };
    overlayMode = 'snap';
    pushUndo('composition');
    nativeIntent = { data: null, started: global.performance && performance.now ? performance.now() : Date.now() };
  }
  function finishComposition() {
    // Composition owns the text node completely until this event. Only now may
    // the model and mirror observe it, and normalization is a last-resort pass.
    if (!composing) return;
    frameReads.invalidateSelection();
    var host = focusId && editOf(focusId);
    if (host && compositionId === focusId && compositionState && crossHostRange(host)) {
      var text = textOf(host);
      if (text) text.data = compositionState.source;
      else host.textContent = compositionState.source;
    }
    composing = false;
    var id = compositionId;
    compositionId = null;
    if (!id || focusId !== id) { nativeIntent = null; compositionState = null; return; }
    frameReads.invalidateSelection();
    var restoredComposition = restoreSingleTextNode(editOf(focusId));
    syncNativeInput(nativeIntent, restoredComposition);
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
    if (host && crossHostRange(host)) retireNativeHost(host);
    else finishComposition();
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
    var a = selAnchor || anchorFromSelection();
    var sel = global.getSelection();
    if (!a || !sel || sel.isCollapsed) return;
    var where = caretSource();
    dragFrom = (focusId && where && where.end > where.start)
      ? { blockId: focusId, start: where.start, end: where.end } : null;
    try {
      e.dataTransfer.setData('text/plain', sel.toString());
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
    var moved = dragFrom && !e.altKey ? dragFrom : null;
    dragFrom = null;
    if (moved && moved.blockId !== nb.id) {
      var src = blockOf(moved.blockId);
      if (src && typeof src.source === 'string') {
        var s = clamp(moved.start, 0, src.source.length);
        var en = clamp(moved.end, 0, src.source.length);
        if (en > s) {
          src.source = src.source.slice(0, s) + src.source.slice(en);
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
        var s = c.start, e = c.end;
        while (s < e && /\s/.test(src.charAt(s))) s++;
        while (e > s && /\s/.test(src.charAt(e - 1))) e--;
        if (e > s) {
          var sel = src.slice(s, e);
          pushUndo('command:' + id);
          if (src.slice(Math.max(0, s - n), s) === d && src.slice(e, e + n) === d) {
            applyEdit(focusId, e, e + n, '');                  // marked around it: take it off
            applyEdit(focusId, s - n, s, '', s - n);
            setCaret(focusId, s - n, e - n);
          } else if (sel.length >= n * 2 && sel.slice(0, n) === d && sel.slice(-n) === d) {
            applyEdit(focusId, s, e, sel.slice(n, sel.length - n), s);
            setCaret(focusId, s, e - n * 2);
          } else {
            applyEdit(focusId, s, e, d + sel + d, s + n + sel.length);
            setCaret(focusId, s + n, s + n + sel.length);      // the words stay selected
          }
          return commandResult(id);
        }
      }

      var pair = emptyPairAt(src, at, d) ? { open: at - n, close: at } : enclosingPair(src, at, d);
      if (pair && at === pair.close && pair.close > pair.open + n) {
        setCaret(focusId, pair.close + n);                     // the end-of-run skip, not a toggle
        return commandResult(id);                              // nothing changed: nothing to undo
      }
      pushUndo('command:' + id);
      if (pair) {
        applyEdit(focusId, pair.close, pair.close + n, '');
        applyEdit(focusId, pair.open, pair.open + n, '', Math.max(pair.open, at - n));
      } else {
        applyEdit(focusId, at, at, d + d, at + n);
        for (var pi = 0; pi < n; pi++) pending.push({ blockId: focusId, index: at + n + pi, ch: d.charAt(pi) });
      }
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
      pushUndo('command:link');
      var words = b.source.slice(c.start, c.end);
      applyEdit(focusId, c.start, c.end, '[[' + words + ']]', c.start + 2 + words.length);
      pending.push({ blockId: focusId, index: c.start + 2 + words.length, ch: ']' });
      openPicker('wiki', focusId, c.start, 2);
      if (activePicker && words) activePicker.handle.update(words, caretRect());
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
        if (focused && host.focus) host.focus();
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
      focusId = null;
      composing = false;
      compositionId = null;
      compositionState = null;
      nativeIntent = null;
      handledBackspace = false;
      pointerSelecting = pointerStartedInPage = pointerCrossed = false; pointerAnchor = null;
      pending = [];
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
        page.addEventListener('copy', onCopy);
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
        page.addEventListener('touchend', own(onTouchEnd), { passive: true });
        document.addEventListener('pointerdown', function (e) { if (e.pointerType) touchInput = e.pointerType === 'touch'; }, true);
        document.addEventListener('selectionchange', onSelectionChange);
        if (isArticle) document.addEventListener('keydown', onGlobalKey);   // typing while reading starts the article, never a field
        global.addEventListener('blur', function () { markAway(true); });
        global.addEventListener('focus', function () { markAway(false); });
        document.addEventListener('mousemove', own(onPointerMove), true);
        document.addEventListener('mouseup', onPointerUp, true);
        // A writer's own scroll wins: the typewriter line yields until the
        // caret moves again (setCaret clears the flag).
        global.addEventListener('scroll', function () { hideSelMenu(); requestOverlay('layout'); }, true);
        global.addEventListener('resize', function () { frameReads.invalidateStyles(); hideSelMenu(); requestOverlay('layout'); });
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
      /* renderAll() reuses the cache, so the cache is what has to change. */
      var mdNow = MD();
      blocks.forEach(function (b) { rendered[b.id] = renderFor(b, mdNow); });

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
        var gap = typeof block.sep === 'string' && block.type === block.sepType ? block.sep : (i === 0 ? '' : '\n\n');
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

  /* A field written with the article's editor (I1): a comment, a reply, a side
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
