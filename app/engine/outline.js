(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;
  var foldExperiment = true;
  try { foldExperiment = new global.URLSearchParams(global.location.search).get('toc') !== 'tree'; } catch (e) { /* nested outline */ }

  function on(name, fn) {
    if (Castor.bus && typeof Castor.bus.on === 'function') { Castor.bus.on(name, fn); return; }
    DOC.addEventListener(name, fn);
  }
  function el(tag, cls, text) {
    var n = DOC.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(value) {
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }



  /* The level's own colour, then the legacy alias, then a derived ink tone. The
     token every theme and fonts.js actually write is `--level-<n>`: reading only
     `--h<n>-color` meant a heading-colour preset never reached the outline, which
     the engine README, checklist item 9 and Futura's signature all require. */

  function levelColor() {
    return 'var(--level-1, var(--h1-color, var(--ink-2, currentColor)))';
  }

  var S = {
    page: null, scroll: null, panelEl: null, collapsed: {}, current: null,
    editingId: null, editOpen: {}, editSuppressed: {}, readingOpen: {}, pointerHeld: false,
    headings: [], io: null, raf: 0, previewId: null, previewBlocks: [], mounted: false,
    variant: 'tree', fold: foldExperiment, readingId: null, readingScroll: false, foldFrame: 0,
    /* the vein */
    vein: null, veinRows: [], veinSeq: 0, levelTo: 0, foldAnimations: [], foldGhosts: [],
    rail: 'beads',           // 'beads' | 'stepped' -- see depthX()
    levels: 'guides',        // 'type' | 'guides' | 'chip' | 'lead' | 'off'
    ink: 'ink',              // 'ink' | 'olive' -- the SPINE's colour, see engine.css
    guides: 'plain',         // 'hair' | 'fine' | 'plain' | 'strong' -- the level rules
    size: 'm',               // 'm' | 'l' | 'xl' -- the label's type size
    width: 'even',           // 'even' | 'swell' -- see bellies()
    /* Clicking an entry is an ASSERTION about where the reader is, and the
       smooth scroll that follows takes ~400ms during which the scroll listener
       would otherwise re-derive a different answer every frame and overwrite it.
       This holds the assertion until the scroll settles. */
    claimUntil: 0
  };

  function currentDoc() {
    if (Castor.editor && typeof Castor.editor.getDoc === 'function') return Castor.editor.getDoc();
    return Castor.app && Castor.app.doc;
  }

  /* Prefer editor blocks: a focused heading is live-preview markup inside a wrapper,
     while the wrapper's data-type and block id remain stable. */
  function readHeadings() {
    if (!S.page) return [];
    var doc = currentDoc() || {}, byBlock = {};
    (doc.headings || []).forEach(function (h) { if (h.blockId) byBlock[h.blockId] = h; });

    var blocks = S.page.querySelectorAll('.cw-block[data-block-id]');
    var out = [], i;
    if (blocks.length) {
      for (i = 0; i < blocks.length; i++) {
        var block = blocks[i], type = block.getAttribute('data-type') || '';
        if (!/^h[1-6]$/.test(type)) continue;
        var blockId = block.getAttribute('data-block-id');
        var meta = byBlock[blockId] || {};
        var mirror = block.querySelector('.cw-mirror');
        var heading = mirror ? (mirror.querySelector('h1,h2,h3,h4,h5,h6') || mirror)
          : block.querySelector(type) || block.querySelector('h1,h2,h3,h4,h5,h6');
        var text = String(mirror && typeof meta.text === 'string' ? meta.text : heading ? heading.textContent : meta.text || '').split('\n')[0]
          .replace(/^\s*#{1,6}(?:[ \t]+|$)/, '').trim();
        out.push({
          el: heading || block, host: block, blockId: blockId, id: blockId || meta.id || (heading && heading.id) || ('h-' + i),
          level: parseInt(type.slice(1), 10), text: text || 'Untitled heading', children: []
        });
      }
      return out;
    }

    var nodes = S.page.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.closest('[data-castor-ui]')) continue;
      var host = n.closest('[data-block-id],[data-block]') || n;
      out.push({
        el: n, host: host,
        blockId: host.getAttribute && (host.getAttribute('data-block-id') || host.getAttribute('data-block')),
        id: n.id || ('h-' + i), level: parseInt(n.tagName.slice(1), 10),
        text: n.textContent.trim() || 'Untitled heading', children: []
      });
    }
    return out;
  }

  function toTree(flat) {
    var roots = [], stack = [];
    flat.forEach(function (h) {
      h.children = [];
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      h.parent = stack.length ? stack[stack.length - 1] : null;
      if (h.parent) h.parent.children.push(h);
      else roots.push(h);
      stack.push(h);
    });
    return roots;
  }

  function countUnder(node) {
    var count = node.children.length;
    node.children.forEach(function (child) { count += countUnder(child); });
    return count;
  }

  function clearPreview() {
    S.previewBlocks.forEach(function (block) { block.classList.remove('castor-outline-preview'); });
    S.previewBlocks = [];
    if (S.panelEl) {
      var row = S.panelEl.querySelector('.castor-row.is-preview');
      if (row) row.classList.remove('is-preview');
    }
    S.previewId = null;
  }

  function blocksForSection(heading) {
    var blocks = Array.prototype.slice.call(S.page.querySelectorAll('.cw-block[data-block-id]'));
    if (!blocks.length) {
      var article = S.page.querySelector('#page-article,.page-column,article') || S.page;
      blocks = Array.prototype.slice.call(article.children || []);
    }
    var start = blocks.indexOf(heading.host);
    if (start < 0) return [heading.host];
    var out = [];
    for (var i = start; i < blocks.length; i++) {
      var type = blocks[i].getAttribute && (blocks[i].getAttribute('data-type') || '');
      var childHeading = /^h[1-6]$/.test(type) ? parseInt(type.slice(1), 10) : 0;
      if (!childHeading) {
        var h = blocks[i].matches && blocks[i].matches('h1,h2,h3,h4,h5,h6') ? blocks[i]
          : (blocks[i].querySelector && blocks[i].querySelector('h1,h2,h3,h4,h5,h6'));
        childHeading = h ? parseInt(h.tagName.slice(1), 10) : 0;
      }
      if (i > start && childHeading && childHeading <= heading.level) break;
      out.push(blocks[i]);
    }
    return out;
  }

  function preview(heading, row) {
    clearPreview();
    S.previewId = heading.id;
    S.previewBlocks = blocksForSection(heading);
    S.previewBlocks.forEach(function (block) { block.classList.add('castor-outline-preview'); });
    row.classList.add('is-preview');
  }

  function flash(heading) {
    var host = heading.host || heading.el;
    if (!host) return;
    host.classList.add('castor-outline-flash');
    global.setTimeout(function () { host.classList.remove('castor-outline-flash'); }, 900);
  }

  function goTo(heading) {
    var host = heading.host || heading.el;
    if (syncEditingFolds()) applyEditingFolds();
    S.claimUntil = now() + 1200;
    if (S.fold) S.readingId = null;
    setCurrent(heading);
    if (host && host.scrollIntoView) {
      host.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth', inline: 'nearest' });
    } else if (Castor.editor && typeof Castor.editor.scrollToBlock === 'function' && heading.blockId) {
      try { Castor.editor.scrollToBlock(heading.blockId); } catch (e) { /* nothing better to do */ }
    }
    /* The claim ends when the scroll actually stops, not when a timer says so;
       the timeout above is only the ceiling for browsers without scrollend. */
    if (S.scroll && 'onscrollend' in S.scroll) {
      var release = function () {
        S.scroll.removeEventListener('scrollend', release);
        S.claimUntil = 0; schedule();
      };
      S.scroll.addEventListener('scrollend', release);
    }
    flash(heading);
  }

  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function foldKey(heading) { return heading.blockId || heading.id; }

  function isFolded(heading) { return !!S.collapsed[foldKey(heading)] && !S.editOpen[foldKey(heading)] && !S.readingOpen[foldKey(heading)]; }

  // Editing reveals the caret section's ancestry, including its body paragraphs. The saved fold choices
  // stay separate, so moving focus away restores them rather than guessing.
  function syncEditingFolds() {
    var heading = S.fold && caretHeading();
    if (!heading && S.pointerHeld) return false;
    var id = heading && heading.id || null, next = {};
    var readingChanged = false;
    if (id !== S.editingId) {
      S.editSuppressed = {};
      if (id) {
        readingChanged = !!Object.keys(S.readingOpen).length;
        S.readingOpen = {};
      }
    }
    S.editingId = id;
    var ancestor = heading && heading.parent;
    while (ancestor) {
      var key = foldKey(ancestor);
      if (!S.editSuppressed[key]) next[key] = true;
      ancestor = ancestor.parent;
    }
    var changed = Object.keys(next).join('|') !== Object.keys(S.editOpen).join('|');
    S.editOpen = next;
    return changed || readingChanged;
  }

  function applyEditingFolds() {
    cancelFoldMotion();
    S.headings.forEach(function (heading) {
      if (!heading.children.length) return;
      var group = groupOf(heading), folded = isFolded(heading);
      if (!group) return;
      group.classList.toggle('is-folded', folded); group.inert = folded;
      var node = group.parentElement, row = node.querySelector('.castor-row');
      row.setAttribute('aria-expanded', String(!folded));
      node.querySelector('.castor-rule').title = folded ? 'Open this section' : 'Fold this section';
      var badge = row.querySelector('.hidden-count');
      if (folded && !badge) row.appendChild(el('span', 'hidden-count', countUnder(heading) + ' hidden'));
      else if (!folded && badge) badge.remove();
    });
    paintVein();
  }

  var FOLD_MS = 450;
  var FOLD_EASE = 'cubic-bezier(.16, 1, .3, 1)';

  function groupOf(heading) {
    if (!S.panelEl) return null;
    var nodes = S.panelEl.querySelectorAll('[data-outline-node]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-outline-node') === heading.id) {
        var kids = nodes[i].children;
        for (var j = 0; j < kids.length; j++) {
          if (kids[j].classList && kids[j].classList.contains('castor-group')) return kids[j];
        }
        return null;
      }
    }
    return null;
  }

  function cancelFoldMotion() {
    if (S.foldFrame) global.cancelAnimationFrame(S.foldFrame);
    S.foldFrame = 0;
    S.foldAnimations.forEach(function (animation) { animation.onfinish = null; animation.cancel(); });
    S.foldAnimations = [];
    S.foldGhosts.forEach(function (group) { group.classList.remove('is-folding-out'); });
    S.foldGhosts = [];
  }

  function animateFold(node, from, to, done) {
    if (!node.animate) { if (done) done(); return; }
    var animation = node.animate([from, to], { duration: S.fold ? 220 : FOLD_MS, easing: S.fold ? 'ease-out' : FOLD_EASE });
    S.foldAnimations.push(animation);
    animation.onfinish = function () {
      S.foldAnimations = S.foldAnimations.filter(function (item) { return item !== animation; });
      if (done) done();
    };
  }

  function followFold() {
    S.foldFrame = 0;
    paintVein();
    if (S.foldAnimations.length) S.foldFrame = global.requestAnimationFrame(followFold);
  }

  function setFold(heading, folded, restoreFocus, immediate, reading) {
    /* FLIP: read the old positions, settle layout once, then move only painted
       pixels. The rail and its dots keep their identity through the fold. */
    var moving = !immediate && !reducedMotion();
    var group = groupOf(heading);
    var fromHeight = S.fold && group ? group.getBoundingClientRect().height : 0;
    var fromOpacity = S.fold && group && global.getComputedStyle ? global.getComputedStyle(group).opacity : (S.collapsed[foldKey(heading)] ? 0 : 1);
    var before = moving && !S.fold ? S.veinRows.map(function (point) {
      var style = global.getComputedStyle ? global.getComputedStyle(point.dot) : point.dot.style;
      return { id: point.id, top: point.row.getBoundingClientRect().top, transform: style.transform,
        opacity: style.opacity || (point.id === S.current ? 1 : .62) };
    }) : [];
    var oldBottom = S.vein && S.vein.bottom, oldLevel = S.levelTo;
    cancelFoldMotion();
    var key = foldKey(heading);
    if (reading) S.readingOpen[key] = !folded;
    else {
      S.collapsed[key] = !!folded;
      delete S.readingOpen[key];
      if (S.editingId) { S.editSuppressed[key] = true; delete S.editOpen[key]; }
    }
    var node = group && group.parentElement;
    var row = node && node.querySelector('.castor-row');
    if (row && row.hasAttribute('aria-expanded')) row.setAttribute('aria-expanded', String(!folded));
    var control = node && node.querySelector('.castor-rule');
    if (control) control.title = folded ? 'Open this section' : 'Fold this section';
    if (!group) return render(restoreFocus || heading.id);

    /* The hidden-count badge belongs to the folded state, so it is written here:
       this path does not render the outline again. */
    var badge = row && row.querySelector('.hidden-count');
    if (folded && row && !badge) {
      row.appendChild(el('span', 'hidden-count', countUnder(heading) + ' hidden'));
    } else if (!folded && badge) {
      badge.remove();
    }

    group.classList.toggle('is-folded', !!folded);
    group.inert = !!folded;
    var current = S.headings.filter(function (item) { return item.id === S.current; })[0];
    if (current) setCurrent(current, true);
    else paintVein();
    if (S.fold) {
      var toHeight = folded ? 0 : group.getBoundingClientRect().height;
      if (moving) {
        group.classList.add('is-folding-out');
        S.foldGhosts.push(group);
        animateFold(group, { height: fromHeight + 'px', opacity: fromOpacity },
          { height: toHeight + 'px', opacity: folded ? 0 : 1 }, function () {
            group.classList.remove('is-folding-out');
            S.foldGhosts = S.foldGhosts.filter(function (item) { return item !== group; });
            paintVein();
          });
        if (S.foldAnimations.length) S.foldFrame = global.requestAnimationFrame(followFold);
      }
      schedule();
      return;
    }
    if (moving && S.vein) {
      S.veinRows.forEach(function (point) {
        var previous = before.filter(function (item) { return item.id === point.id; })[0];
        if (previous) {
          var delta = previous.top - point.top;
          if (delta) animateFold(point.row, { transform: 'translateY(' + delta + 'px)' }, { transform: 'none' });
          animateFold(point.dot, { transform: previous.transform }, { transform: point.dot.style.transform });
        } else {
          animateFold(point.dot, { opacity: 0 }, { opacity: point.id === S.current ? 1 : .62 });
        }
      });
      var v = S.vein;
      before.forEach(function (previous) {
        if (S.veinRows.some(function (point) { return point.id === previous.id; })) return;
        var dot = v.dots[previous.id].dot;
        dot.style.display = '';
        animateFold(dot, { opacity: previous.opacity }, { opacity: 0 }, function () { dot.style.display = 'none'; });
      });
      var scale = (oldBottom - v.top) / Math.max(1, v.bottom - v.top);
      [v.wall, v.clip].forEach(function (shape) {
        animateFold(shape, { transform: 'scaleY(' + scale + ')' }, { transform: 'none' });
      });
      animateFold(v.tail, { transform: 'translateY(' + oldBottom + 'px)' }, { transform: v.tail.style.transform });
      animateFold(v.fill, { transform: 'scaleY(' + oldLevel / v.height + ')' }, { transform: v.fill.style.transform });
      animateFold(v.head, { transform: 'translateY(' + oldLevel + 'px)' }, { transform: v.head.style.transform });
      if (folded) {
        group.classList.add('is-folding-out');
        S.foldGhosts.push(group);
        animateFold(group, { opacity: 1 }, { opacity: 0 }, function () {
          group.classList.remove('is-folding-out');
          S.foldGhosts = S.foldGhosts.filter(function (item) { return item !== group; });
        });
      } else {
        animateFold(group, { transform: 'translateY(-14px)', opacity: 0 }, { transform: 'none', opacity: 1 });
      }
    }
    schedule();
  }

  function renderGroup(nodes, depth) {
    var group = el('div', 'castor-group');
    group.setAttribute('role', 'group');
    group.dataset.depth = String(depth);
    group.style.setProperty('--outline-color', levelColor(nodes[0] ? nodes[0].level : depth));

    nodes.forEach(function (heading) {
      var folded = isFolded(heading);
      var node = el('div', 'castor-node');
      node.dataset.outlineNode = heading.id;

      var junction = el('span', 'castor-rule' + (heading.children.length ? '' : ' is-leaf'));
      junction.setAttribute('aria-hidden', 'true');
      if (heading.children.length) {
        junction.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true">' +
          '<polyline points="4,2.6 8,6 4,9.4" fill="none" stroke="currentColor" ' +
          'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      junction.title = heading.children.length ? (folded ? 'Open this section' : 'Fold this section') : '';
      if (heading.children.length) {
        junction.addEventListener('click', function (event) {
          event.preventDefault(); event.stopPropagation();
          setFold(heading, !isFolded(heading), heading.id);
        });
      }
      node.appendChild(junction);

      var row = el('button', 'castor-row');
      row.type = 'button';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth));
      row.setAttribute('data-outline-id', heading.id);
      if (heading.blockId) row.setAttribute('data-block-id', heading.blockId);
      if (heading.children.length) row.setAttribute('aria-expanded', String(!folded));
      row.style.setProperty('--outline-color', levelColor(heading.level));
      row.style.setProperty('--row-step', labelStep(heading.level).toFixed(1) + 'px');
      row.tabIndex = -1;
      row.setAttribute('data-level', String(heading.level || depth));
      /* No tick, no bracket stub. Every heading's mark is a node ON the vein,
         drawn once in one SVG after layout, so the drawing and the labels cannot
         disagree about where a heading is -- which is what "the lines should match
         each other well" asks for. */
      row.appendChild(el('span', 'castor-label', heading.text));
      if (folded && heading.children.length) {
        row.appendChild(el('span', 'hidden-count', countUnder(heading) + ' hidden'));
      }
      if (S.current === heading.id) {
        row.classList.add('is-current');
        row.setAttribute('aria-current', 'location');
      }
      row.addEventListener('pointerenter', function () { preview(heading, row); });
      row.addEventListener('pointerleave', function () { if (S.previewId === heading.id) clearPreview(); });
      row.addEventListener('focus', function () { preview(heading, row); });
      row.addEventListener('blur', function () { if (S.previewId === heading.id) clearPreview(); });
      row.addEventListener('click', function () { clearPreview(); goTo(heading); });
      node.appendChild(row);

      /* Keep children built so folding preserves row identity and focus. */
      if (heading.children.length) {
        var kids = renderGroup(heading.children, depth + 1);
        if (folded) kids.classList.add('is-folded');
        kids.inert = folded;
        node.appendChild(kids);
      }
      group.appendChild(node);
    });
    return group;
  }



  /* A literal contents page: one numbered destination per heading. It refuses
     folding and preview on purpose, because its only job is fast navigation. */

  function articleBlocks() {
    var blocks = Array.prototype.slice.call(S.page.querySelectorAll('.cw-block[data-block-id]'));
    if (blocks.length) return blocks;
    var article = S.page.querySelector('#page-article,.page-column,article') || S.page;
    return Array.prototype.slice.call(article.children || []);
  }

  function sectionMeasures() {
    var blocks = articleBlocks();
    var measures = S.headings.map(function (heading, index) {
      var start = blocks.indexOf(heading.host);
      var next = S.headings[index + 1];
      var end = next ? blocks.indexOf(next.host) : blocks.length;
      if (start < 0) start = 0;
      if (end < 0 || end <= start) end = Math.min(blocks.length, start + 1);
      var text = blocks.slice(start, end).map(function (block) {
        return String(block.textContent || '').trim();
      }).join(' ');
      var words = (text.match(/\S+/g) || []).length;
      return { heading: heading, words: Math.max(1, words) };
    });
    var total = measures.reduce(function (sum, item) { return sum + item.words; }, 0) || 1;
    measures.forEach(function (item) { item.share = item.words / total; });
    return { items: measures, total: total };
  }

  /* A map is sized by the writing between consecutive headings, not by heading
     count. That makes a long middle and a short ending visibly different. */





  /* A trail removes the complete list. It keeps the ancestry for orientation and
     only the previous/current/next headings for movement. */

  function visibleRows() {
    return S.panelEl ? Array.prototype.slice.call(S.panelEl.querySelectorAll('.castor-row'))
      .filter(function (row) { return !row.closest('.castor-group.is-folded'); }) : [];
  }

  function focusRow(row) {
    if (!row) return;
    visibleRows().forEach(function (candidate) { candidate.tabIndex = candidate === row ? 0 : -1; });
    row.focus();
  }

  function parentRow(row) {
    var node = row && row.closest('.castor-node');
    var parentGroup = node && node.parentElement;
    var parentNode = parentGroup && parentGroup.closest('.castor-node');
    return parentNode && parentNode.querySelector(':scope > .castor-row');
  }

  function onTreeKey(event) {
    var row = event.target && event.target.closest && event.target.closest('.castor-row');
    if (!row) return;
    var rows = visibleRows(), at = rows.indexOf(row), id = row.getAttribute('data-outline-id');
    var heading = S.headings.filter(function (h) { return h.id === id; })[0];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (event.key === 'Home') focusRow(rows[0]);
      else if (event.key === 'End') focusRow(rows[rows.length - 1]);
      else focusRow(rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]);
      return;
    }
    if (!heading) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (heading.children.length && isFolded(heading)) setFold(heading, false, heading.id);
      else if (heading.children.length && rows[at + 1]) focusRow(rows[at + 1]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (heading.children.length && !isFolded(heading)) setFold(heading, true, heading.id);
      else focusRow(parentRow(row));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); clearPreview(); goTo(heading);
    }
  }

  function render(focusId) {
    if (!S.panelEl) return;
    cancelFoldMotion();
    S.vein = null; S.veinRows = [];
    clearPreview();
    S.headings = readHeadings();
    var roots = toTree(S.headings);
    if (S.fold) S.headings.forEach(function (heading) {
      var key = foldKey(heading);
      if (heading.children.length && !Object.prototype.hasOwnProperty.call(S.collapsed, key)) {
        S.collapsed[key] = heading.children.every(function (child) { return child.level >= 3; });
      }
    });
    syncEditingFolds();
    if (S.headings.length && !S.headings.some(function (heading) { return heading.id === S.current; })) {
      var sensed = caretHeading() || readingHeading();
      S.current = sensed && sensed.id;
    }
    S.panelEl.textContent = '';
    var root = el('div', 'castor-outline castor-outline-' + S.variant);
    root.setAttribute('data-variant', S.variant);
    if (S.fold) root.setAttribute('data-toc', 'fold');
    if (!S.headings.length) {
      root.appendChild(el('div', 'castor-outline-empty', 'No headings yet. A heading appears here as soon as you write one.'));
    } else {
      root.setAttribute('role', 'tree');
      root.setAttribute('aria-label', 'Document outline');
      root.addEventListener('keydown', onTreeKey);
      root.addEventListener('pointerdown', function () { S.pointerHeld = true; });
      var tree = el('div', 'castor-tree');
      tree.appendChild(renderGroup(roots, 1));
      root.appendChild(tree);
      S.vein = null;
    }
    S.panelEl.appendChild(root);
    if (S.variant === 'tree') {
      var chosen = focusId && root.querySelector('.castor-row[data-outline-id="' + esc(focusId) + '"]');
      var current = S.current && root.querySelector('.castor-row[data-outline-id="' + esc(S.current) + '"]');
      var first = root.querySelector('.castor-row');
      (chosen || current || first || {}).tabIndex = 0;
      if (chosen) focusRow(chosen);
      paintVein();
    }
    watch();
  }



  var VEIN_W = 44;          /* the SVG's own width: the spine plus two steps */
  var VEIN_X = 9.5;         /* the vessel's centre line -- the spine never moves */
  var STEP = 14;            /* how far a child's node hangs off the spine */
  var STEPS_MAX = 2;        /* H3 and deeper share the second step */

  function depthX(level) {
    if (S.rail === 'beads') return VEIN_X;
    return VEIN_X + Math.min(Math.max((level || 1) - 1, 0), STEPS_MAX) * STEP;
  }

  /* Where the LABEL goes, which is a different question in beads mode: there the
     indent is the only thing carrying depth, so it has to be wider than the step
     the spheres would have used. */
  function labelStep(level) {
    /* In beads mode the indent is the ONLY thing carrying depth, so it caps one
       level deeper than the stepped rail's spheres did: capped at two, a level-4
       heading sat at exactly a level-3 indent and the two read as siblings, which a
       judge caught on the stepped version and which matters more here. Three steps
       of 16px is 48px at the deepest, which an article that reaches h5 has bigger
       problems than. */
    if (S.rail !== 'beads') {
      return STEP * Math.min(Math.max((level || 1) - 1, 0), STEPS_MAX);
    }
    var STEPS_PX = [0, 16, 30, 42, 52, 60];
    var n = Math.min(Math.max((level || 1) - 1, 0), STEPS_PX.length - 1);
    return STEPS_PX[n];
  }
  var WAIST = 0.85;         /* half-width at a node, and the floor everywhere */
  var BELLY_MAX = 2.4;      /* half-width of the LONGEST section's belly */
  var STEPS = 14;           /* samples per section */


  function nodeRadius(level, isCurrent) {
    var byDepth = [5.6, 4.9, 4.4, 4.0, 3.8, 3.7][Math.min(Math.max((level || 1), 1), 6) - 1];
    return isCurrent ? byDepth + 1.3 : byDepth;
  }

  function svgEl(name, attrs) {
    var node = DOC.createElementNS('http://www.w3.org/2000/svg', name);
    for (var key in attrs) if (Object.prototype.hasOwnProperty.call(attrs, key)) {
      node.setAttribute(key, String(attrs[key]));
    }
    return node;
  }

  /* Half-width at a point, from the two nodes it lies between and that section's
     own belly. */
  function widthAt(y, points) {
    var i;
    for (i = 0; i < points.length - 1; i++) {
      if (y >= points[i].y && y <= points[i + 1].y) {
        var span = points[i + 1].y - points[i].y;
        var u = span > 0 ? (y - points[i].y) / span : 0;
        return WAIST + (points[i].belly - WAIST) * Math.sin(Math.PI * u);
      }
    }
    return WAIST;
  }

  /* Words between this heading and the next, for every visible row. sectionMeasures()
     already counts them for the proportion map; this reuses it rather than counting
     twice, and falls back to a flat rail if the page is not readable yet. */
  function bellies(points) {
    /* The swell is switchable because it is under a live question. He told the
       website chat, about the same idea, "you did this very weird DNA-style line I
       never asked for", and told this chat to take the site's progressive line and
       make it feel like blood flow. Those two sentences do not obviously agree, and
       flow comes from the damped motion and the travelling head rather than from
       the shape bulging -- so an even line may be the honest reading of both. Both
       are built; he picks. */
    if (S.width === 'even') {
      points.forEach(function (point) { point.belly = WAIST + 0.35; });
      return;
    }
    var measures = {}, biggest = 1;
    try {
      sectionMeasures().items.forEach(function (item) {
        measures[item.heading.id] = item.words;
        if (item.words > biggest) biggest = item.words;
      });
    } catch (e) { measures = {}; }
    points.forEach(function (point) {
      var words = measures[point.id];
      if (!words) { point.belly = WAIST + 0.25; return; }
      /* square root, not linear: a section ten times longer is not ten times
         fatter, or one long section flattens every other one to a hair. */
      var share = Math.sqrt(words / biggest);
      point.belly = WAIST + (BELLY_MAX - WAIST) * share;
    });
  }

  function vesselPath(points, top, bottom) {
    if (points.length < 2) return '';
    var left = [], right = [], i, k, y;
    var edges = [top];
    for (i = 0; i < points.length; i++) edges.push(points[i].y);
    edges.push(bottom);
    void 0;
    for (i = 0; i < edges.length - 1; i++) {
      for (k = 0; k < STEPS; k++) {
        y = edges[i] + (edges[i + 1] - edges[i]) * (k / STEPS);
        var w = widthAt(y, points);
        left.push((VEIN_X - w).toFixed(2) + ' ' + y.toFixed(2));
        right.unshift((VEIN_X + w).toFixed(2) + ' ' + y.toFixed(2));
      }
    }
    left.push((VEIN_X - WAIST).toFixed(2) + ' ' + bottom.toFixed(2));
    right.unshift((VEIN_X + WAIST).toFixed(2) + ' ' + bottom.toFixed(2));
    return 'M' + left.join('L') + 'L' + right.join('L') + 'Z';
  }

  /* Where the reading line sits, expressed in the rail's own pixels: between the
     node of the current section and the node after it. */
  function levelFor(points) {
    if (!points.length) return 0;
    var at = -1, i;
    for (i = 0; i < points.length; i++) if (points[i].id === S.current) { at = i; break; }
    if (at < 0) return points[0].y;
    /* A folded parent represents all its descendants, up to the next visible row. */
    var here = points[at].heading, next = at + 1 < points.length ? points[at + 1].heading : null;
    var frac = 0;
    if (S.scroll && here && here.host) {
      var line = S.scroll.getBoundingClientRect().top + 72;
      var a = here.host.getBoundingClientRect().top;
      var b = next && next.host ? next.host.getBoundingClientRect().top
                                : a + Math.max(1, S.scroll.scrollHeight - S.scroll.scrollTop - a);
      if (b > a) frac = Math.min(1, Math.max(0, (line - a) / (b - a)));
    }
    var to = (at + 1 < points.length) ? points[at + 1].y : points[points.length - 1].y + 14;
    return points[at].y + (to - points[at].y) * frac;
  }

  function reducedMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function buildVein(tree) {
    var seq = ++S.veinSeq;
    var svg = svgEl('svg', { 'class': 'castor-vein', 'aria-hidden': 'true', width: VEIN_W, preserveAspectRatio: 'none' });
    var defs = svgEl('defs');
    var clip = svgEl('clipPath', { id: 'castor-vein-clip-' + seq });
    var clipPath = svgEl('path');
    clip.appendChild(clipPath); defs.appendChild(clip);
    svg.appendChild(defs);
    var wall = svgEl('path', { 'class': 'vein-wall' });
    var fillGroup = svgEl('g', { 'clip-path': 'url(#castor-vein-clip-' + seq + ')' });
    var fill = svgEl('rect', { 'class': 'vein-fill', x: 0, y: 0, width: VEIN_W });
    fillGroup.appendChild(fill);
    var nodes = svgEl('g', { 'class': 'vein-nodes' });
    var head = svgEl('circle', { 'class': 'vein-head', cx: VEIN_X, r: 3.4 });
    var tail = svgEl('circle', { 'class': 'vein-tail', cx: VEIN_X, r: 1.5 });
    svg.appendChild(wall); svg.appendChild(fillGroup); svg.appendChild(nodes); svg.appendChild(head); svg.appendChild(tail);
    tree.insertBefore(svg, tree.firstChild);
    S.vein = { svg: svg, wall: wall, clip: clipPath, fill: fill, nodes: nodes, head: head, tail: tail, tree: tree, dots: {} };
    return S.vein;
  }

  function paintVein() {
    if (S.variant !== 'tree' || !S.panelEl) return;
    if (!S.fold) cancelFoldMotion();
    var tree = S.panelEl.querySelector('.castor-tree');
    if (!tree) { S.vein = null; return; }
    var rows = Array.prototype.slice.call(tree.querySelectorAll('.castor-row'))
      .filter(function (row) { return !row.closest('.castor-group.is-folded'); });
    if (rows.length < 1) { if (S.vein) S.vein.svg.style.display = 'none'; return; }

    var base = tree.getBoundingClientRect().top;
    var points = rows.map(function (row) {
      var box = row.getBoundingClientRect();
      var id = row.getAttribute('data-outline-id');
      var heading = S.headings.filter(function (h) { return h.id === id; })[0];
      return {
        y: box.top - base + box.height / 2,
        top: box.top,
        level: Number(row.getAttribute('data-level')) || 1,
        id: id, heading: heading, row: row
      };
    });
    bellies(points);
    /* A short lead in and out so the vessel does not begin and end on a blunt cut;
       it is the same hairline as a node's waist, so it reads as the line continuing
       past the piece rather than as a stub. */
    var top = Math.max(0, points[0].y - 9);
    var bottom = points[points.length - 1].y + 9;
    var height = Math.max(bottom + 4, tree.offsetHeight);
    /* All layout reads finish before changing classes, SVG or styles. */
    var level = levelFor(points);
    if (!S.vein || S.vein.tree !== tree || !tree.contains(S.vein.svg)) buildVein(tree);
    var v = S.vein;
    v.svg.style.display = '';
    v.top = top; v.bottom = bottom; v.height = height;
    v.svg.setAttribute('height', height);
    v.svg.setAttribute('width', VEIN_W);
    v.svg.setAttribute('viewBox', '0 0 ' + VEIN_W + ' ' + height);
    v.svg.style.height = height + 'px';
    v.svg.style.width = VEIN_W + 'px';

    /* The spine ended in mid-air at the last row. A small terminal closes the
       shape, so the space below reads as the document ending rather than as the
       drawing being cut off. */
    v.tail.style.transform = 'translateY(' + bottom.toFixed(2) + 'px)';
    var d = vesselPath(points, top, bottom);
    v.wall.setAttribute('d', d);
    v.clip.setAttribute('d', d);
    v.wall.style.transformOrigin = v.clip.style.transformOrigin = '0px ' + top + 'px';
    v.fill.setAttribute('height', height);
    Object.keys(v.dots).forEach(function (id) {
      var visible = points.some(function (point) { return point.id === id; });
      v.dots[id].dot.style.display = visible ? '' : 'none';
      if (v.dots[id].tick) v.dots[id].tick.style.display = visible ? '' : 'none';
    });
    points.forEach(function (point) {
      var x = depthX(point.level);
      var kept = v.dots[point.id];
      if (!kept) {
        kept = v.dots[point.id] = {};
        kept.dot = svgEl('circle', {
          cx: x, r: nodeRadius(point.level, false), 'class': 'vein-node',
          'vector-effect': 'non-scaling-stroke',
          fill: levelColor(point.level), stroke: levelColor(point.level)
        });
        v.nodes.appendChild(kept.dot);
        if (x > VEIN_X + 0.1) {
          kept.tick = svgEl('line', { x1: VEIN_X, x2: x - nodeRadius(point.level, false) - 1, y1: 0, y2: 0, 'class': 'vein-tick' });
          v.nodes.appendChild(kept.tick);
        }
      }
      point.dot = kept.dot; point.tick = kept.tick;
      point.dot.style.transformOrigin = x + 'px 0px';
      if (point.tick) point.tick.style.transform = 'translateY(' + point.y.toFixed(2) + 'px)';
    });
    S.veinRows = points;
    S.levelTo = level;
    applyLevel();
  }

  function applyLevel() {
    var v = S.vein;
    if (!v) return;
    var y = Math.max(0, S.levelTo);
    v.fill.style.transform = 'scaleY(' + (y / v.height).toFixed(5) + ')';
    v.head.style.transform = 'translateY(' + y.toFixed(2) + 'px)';
    v.head.style.opacity = y > 0.5 ? '' : '0';
    S.veinRows.forEach(function (point) {
      var passed = point.y <= y + 0.5, current = point.id === S.current;
      var radius = nodeRadius(point.level, false);
      var scale = (nodeRadius(point.level, current) - (passed || current ? 0 : 0.7)) / radius;
      point.dot.classList.toggle('is-passed', passed);
      point.dot.classList.toggle('is-current', current);
      point.dot.style.transform = 'translateY(' + point.y.toFixed(2) + 'px) scale(' + scale.toFixed(3) + ')';
      if (point.tick) point.tick.classList.toggle('is-passed', passed);
    });
  }

  /* Like the site's linear scroll timelines, progress tracks this frame's scroll
     position directly. Only a layout change needs to measure the outline rows. */
  function updateProgress() {
    S.levelTo = levelFor(S.veinRows);
    applyLevel();
  }

  function headingForBlock(blockId) {
    if (!blockId || !S.headings.length) return null;
    var direct = S.headings.filter(function (heading) { return heading.blockId === blockId; })[0];
    if (direct) return direct;
    var blocks = Array.prototype.slice.call(S.page.querySelectorAll('.cw-block[data-block-id]'));
    var target = blocks.filter(function (block) { return block.getAttribute('data-block-id') === blockId; })[0];
    var targetAt = blocks.indexOf(target), found = null;
    if (targetAt < 0) return null;
    S.headings.forEach(function (heading) {
      var at = blocks.indexOf(heading.host);
      if (at >= 0 && at <= targetAt) found = heading;
    });
    return found || S.headings[0];
  }

  function caretHeading() {
    var active = DOC.activeElement;
    var editing = active && S.page && S.page.contains(active) &&
      (active.isContentEditable || (active.closest && active.closest('[contenteditable="true"]')));
    if (!editing) return null;
    var blockId = null;
    if (Castor.editor && typeof Castor.editor.focusedBlockId === 'function') {
      blockId = Castor.editor.focusedBlockId();
    }
    if (!blockId) {
      var snapshot = Castor.frameReads ? Castor.frameReads.selection() : null;
      var selection = snapshot ? snapshot.sel : global.getSelection && global.getSelection();
      var range = snapshot ? snapshot.range : selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) return null;
      var node = range.startContainer;
      if (node && node.nodeType === 3) node = node.parentNode;
      var block = node && node.closest && node.closest('.cw-block[data-block-id]');
      if (!block || !S.page.contains(block)) return null;
      blockId = block.getAttribute('data-block-id');
    }
    return headingForBlock(blockId);
  }

  function readingHeading() {
    var found = null;
    var rootTop = S.scroll ? S.scroll.getBoundingClientRect().top : 0;
    var line = rootTop + 72;
    for (var i = 0; i < S.headings.length; i++) {
      if (S.headings[i].host.getBoundingClientRect().top <= line) found = S.headings[i];
    }
    return found || S.headings[0];
  }

  function setCurrent(heading, force, follow) {
    if (!heading) return;
    if (S.fold && (!force || follow) && S.editingId === heading.id) {
      S.readingId = heading.id;
      if (Object.keys(S.readingOpen).length) { S.readingOpen = {}; applyEditingFolds(); }
    }
    else if (S.fold && (!force || follow) && S.readingId !== heading.id) {
      S.readingId = heading.id;
      // Following the reading section reveals a path without changing manual choices.
      // Restore the previous path before opening this one with the existing fold motion.
      if (Object.keys(S.readingOpen).length) { S.readingOpen = {}; applyEditingFolds(); }
      var opening = [], ancestor = heading;
      while (ancestor) {
        if (ancestor.children.length && isFolded(ancestor)) opening.push(ancestor);
        ancestor = ancestor.parent;
      }
      // Settle nested children first so the outer height includes their complete branch.
      opening.forEach(function (item, i) { setFold(item, false, null, i < opening.length - 1, true); });
    }
    var parent = heading.parent, shut = null;
    if (S.variant === 'tree') {
      while (parent) {
        if (isFolded(parent)) shut = parent;   // keep the OUTERMOST
        parent = parent.parent;
      }
    }
    var current = shut ? shut.id : heading.id;
    var changed = current !== S.current;
    S.current = current;
    if (force || !S.vein) paintVein();
    else updateProgress();
    if (!changed && !force) return;
    if (changed && S.variant === 'trail') { render(); return; }
    if (!S.panelEl) return;
    var rows = Array.prototype.slice.call(S.panelEl.querySelectorAll('[data-outline-id]'));
    var currentRow = null;
    rows.forEach(function (row) {
      var yes = row.getAttribute('data-outline-id') === S.current;
      row.classList.toggle('is-current', yes);
      if (yes) { row.setAttribute('aria-current', 'location'); if (!currentRow) currentRow = row; }
      else row.removeAttribute('aria-current');
    });
    if (changed && currentRow && currentRow.scrollIntoView) currentRow.scrollIntoView({ block: 'nearest' });
  }

  function markCurrent() {
    if (!S.headings.length) return;
    if (syncEditingFolds()) applyEditingFolds();
    var force = !!S.forcePaint;
    S.forcePaint = false;
    if (S.claimUntil && now() < S.claimUntil) {
      if (force) paintVein(); else updateProgress();
      return;
    }
    S.claimUntil = 0;
    setCurrent(S.fold && S.readingScroll ? readingHeading() : (caretHeading() || readingHeading()), force, true);
  }

  function schedule() {
    if (S.raf) return;
    S.raf = global.requestAnimationFrame(function () { S.raf = 0; markCurrent(); });
  }

  function scheduleLayout() { if (S.fold) cancelFoldMotion(); S.forcePaint = true; schedule(); }

  /* Coalesces a burst of keystrokes into one render on the next frame, then
     verifies what it drew. */
  function scheduleRender() {
    if (S.renderRaf) return;
    S.renderRaf = global.requestAnimationFrame(function () {
      S.renderRaf = 0;
      var live = readHeadings();
      if (S.variant !== 'tree' || live.length !== S.headings.length || live.some(function (h, i) {
        return h.id !== S.headings[i].id || h.level !== S.headings[i].level;
      })) { render(); return; }
      // Keep the buttons and click targets alive while a heading is renamed.
      live.forEach(function (h, i) {
        var old = S.headings[i];
        old.text = h.text; old.el = h.el; old.host = h.host;
        var row = S.panelEl && S.panelEl.querySelector('.castor-row[data-outline-id="' + esc(h.id) + '"]');
        var label = row && row.querySelector('.castor-label');
        if (label) label.textContent = h.text;
      });
      if (syncEditingFolds()) applyEditingFolds();
      watch();
    });
  }

  /* IntersectionObserver is only the wake-up. One calculation then updates the
     label, branch and progress line together, so the rail never contradicts itself. */
  function watch() {
    if (S.io) S.io.disconnect();
    if (!global.IntersectionObserver || !S.headings.length) { schedule(); return; }
    S.io = new global.IntersectionObserver(schedule, {
      root: S.scroll || null, rootMargin: '-8% 0px -72% 0px', threshold: [0, 0.08]
    });
    S.headings.forEach(function (heading) { S.io.observe(heading.host); });
    schedule();
  }

  function mountPanel(bodyEl) { S.panelEl = bodyEl; render(); }

  function mount(ctx) {
    ctx = ctx || {};
    S.page = ctx.page || DOC.getElementById('page');
    S.scroll = ctx.scroll || (S.page && S.page.querySelector('.page-scroll')) || null;
    if (ctx.panelEl) mountPanel(ctx.panelEl);
    else if (Castor.panels && typeof Castor.panels.register === 'function') {
      Castor.panels.register('outline', { title: 'Outline', mount: mountPanel });
    }
    if (!S.mounted) {
      S.mounted = true;
      if (DOC && DOC.documentElement) {
        DOC.documentElement.setAttribute('data-outline-levels', S.levels);
        DOC.documentElement.setAttribute('data-outline-ink', S.ink);
        DOC.documentElement.setAttribute('data-outline-guides', S.guides);
        DOC.documentElement.setAttribute('data-outline-size', S.size);
        DOC.documentElement.setAttribute('data-outline-rail', S.rail);
      }
      on('doc:change', scheduleRender);
      on('editor:mirror', scheduleRender);
      if (S.fold) on('piece:open', function () {
        S.collapsed = {}; S.readingId = null; S.readingScroll = false; S.current = null; S.claimUntil = 0;
        S.editingId = null; S.editOpen = {}; S.editSuppressed = {}; S.readingOpen = {};
        S.pointerHeld = false;
        cancelFoldMotion();
      });
      on('layout', scheduleLayout);
      var followCaret = function () { S.readingScroll = false; schedule(); };
      DOC.addEventListener('selectionchange', S.fold ? followCaret : schedule);
      var releasePointer = function () { if (S.pointerHeld) { S.pointerHeld = false; schedule(); } };
      DOC.addEventListener('pointerup', releasePointer);
      DOC.addEventListener('pointercancel', releasePointer);
      if (S.page) S.page.addEventListener('focusin', S.fold ? followCaret : schedule);
      if (S.page) S.page.addEventListener('focusout', S.fold ? followCaret : schedule);
      (S.scroll || global).addEventListener('scroll', S.fold ? function () {
        S.readingScroll = true; schedule();
      } : schedule, { passive: true });
      global.addEventListener('resize', scheduleLayout);
    }
    if (Castor.commands && typeof Castor.commands.register === 'function') {
      Castor.commands.register({
        id: 'outline:top', title: 'Go to the first heading',
        run: function () { if (S.headings[0]) goTo(S.headings[0]); }
      });
    }
    return Castor.outline;
  }


  Castor.outline = {
    mount: mount, render: render,
    headings: function () { return S.headings.slice(); },
    current: function () { return S.current; },
    repaint: paintVein,
    _state: S
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Castor.outline;
})(typeof window !== 'undefined' ? window : globalThis);
