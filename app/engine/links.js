/* Links are the open article's neighbourhood, never a global map or a suggestion. */
(function (global) {
  'use strict';
  var C = global.Castor = global.Castor || {}, D = global.document, NS = 'http://www.w3.org/2000/svg';
  var mounted = false, body, list, picture, message, toggle = {}, graph, article = '', epoch = 0;
  var savedCaret = null, view = read('descant.links.view') === 'picture' ? 'picture' : 'list';
  var svg, nodeLayer, edgeLayer, nodeMap = new Map(), edgeMap = new Map(), animation = 0, grace = 0;
  var activeNodes = [], activeEdges = [];

  function read(key) { try { return global.localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { global.localStorage.setItem(key, String(value)); } catch (e) { /* Private mode still works. */ } }
  function current() { return C.pieces && C.pieces.current ? C.pieces.current() : ''; }
  function founder() { return !(C.role && C.role.reviewer); }
  function element(tag, text, cls) {
    var n = D.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n;
  }
  function vector(tag, attrs) {
    var n = D.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { n.setAttribute(key, attrs[key]); }); return n;
  }
  function button(text, fn, cls) {
    var n = element('button', text, cls); n.type = 'button'; n.addEventListener('click', fn); return n;
  }
  function key(node) { return node.path || node.kind + ':' + node.slug; }
  function liveState(node) {
    if (node.live && typeof node.live === 'object') return node.live.matches ? 'live-matching' : 'live-changed';
    return node.live || 'none';
  }
  function liveWords(node) {
    var state = liveState(node);
    return state === 'live-matching' ? 'Live, matches the saved article' : state === 'live-changed' ? 'Live, with unpublished changes' : 'Draft, no published version recorded';
  }
  function dot(node) {
    var n = element('span', '', 'links-dot'); n.setAttribute('data-live', liveState(node));
    n.setAttribute('title', liveWords(node)); n.setAttribute('aria-label', liveWords(node)); return n;
  }
  function groups(data) {
    var sections = { out: [], incoming: [], both: [], tags: [], missing: [], materials: data.sources || [] };
    (data.nodes || []).forEach(function (node) {
      if (node.kind === 'missing') { sections.missing.push(node); return; }
      var id = key(node), links = (data.edges || []).filter(function (edge) { return edge.kind === 'link' && (edge.from === id || edge.to === id); });
      if (links.some(function (edge) { return edge.both; })) sections.both.push(node);
      else {
        if (links.some(function (edge) { return edge.from === data.centre.path; })) sections.out.push(node);
        if (links.some(function (edge) { return edge.to === data.centre.path; })) sections.incoming.push(node);
      }
      var shared = (data.edges || []).filter(function (edge) { return edge.kind === 'tag' && (edge.from === id || edge.to === id); });
      if (shared.length) sections.tags.push({ node: node, tags: shared.map(function (edge) { return edge.tag; }) });
    });
    return sections;
  }
  function rememberCaret() {
    if (!C.editor || !C.editor.getCaret) return;
    var caret = C.editor.getCaret();
    if (caret) savedCaret = { path: current(), caret: caret };
  }
  function insert(node) {
    if (!founder() || !C.editor || !C.editor.insertMarkdown) return false;
    var caret = savedCaret && savedCaret.path === current() ? savedCaret.caret : null;
    var title = (node.title || node.slug).replace(/([\\\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ');
    var markdown = '[' + title + '](/writing/' + encodeURIComponent(node.slug) + '/)';
    var ok = C.editor.insertMarkdown(markdown, caret);
    if (message) message.textContent = ok ? 'Link inserted.' : 'Choose a place in the article, then insert the link.';
    if (ok) rememberCaret();
    return ok;
  }
  function open(node) {
    if (!founder() || node.kind === 'missing') return;
    if (node.kind === 'material') {
      var folder = graph.centre.path.slice(0, graph.centre.path.lastIndexOf('/')), relative = node.path.slice(folder.length + 1);
      if (/\.(md|txt)$/i.test(node.path) && C.files && C.files.open) C.files.open(relative);
      else if (global.open) global.open(C.endpoints.api('files/content?piece=') + encodeURIComponent(folder) + '&path=' + encodeURIComponent(relative), '_blank', 'noopener');
    } else if (C.pieces && C.pieces.open) C.pieces.open(node.path);
  }
  function paintList() {
    list.textContent = '';
    var sections = groups(graph);
    [['out', 'Links to →'], ['incoming', 'Linked from ←'], ['both', 'Both ways ↔'], ['tags', 'Shares a tag'],
      ['missing', 'Not written yet'], ['materials', 'Notes beside it']].forEach(function (section) {
      var items = sections[section[0]]; if (!items.length) return;
      list.appendChild(element('h3', section[1])); var rows = element('ul'); list.appendChild(rows);
      items.forEach(function (item) {
        var node = item.node || item, row = element('li'), title = node.title || node.name || node.slug;
        row.setAttribute('data-kind', node.kind);
        if (node.kind === 'missing') row.appendChild(element('span', title, 'links-missing'));
        else {
          var go = button('', function () { open(node); }, 'links-go');
          if (node.kind === 'article') go.appendChild(dot(node));
          go.appendChild(element('span', title, 'links-title')); row.appendChild(go);
        }
        if (item.tags) row.appendChild(element('small', item.tags.map(function (tag) { return '#' + tag; }).join(' '), 'links-tags'));
        if (node.kind === 'material') row.appendChild(element('small', node.size < 1024 ? node.size + ' B' : Math.ceil(node.size / 1024) + ' KB', 'links-size'));
        if (node.kind === 'article') {
          var add = button('Insert link', function () { insert(node); }, 'links-insert');
          add.setAttribute('aria-label', 'Insert link to ' + title);
          add.addEventListener('pointerdown', function (event) { rememberCaret(); event.preventDefault(); });
          row.appendChild(add);
        }
        rows.appendChild(row);
      });
    });
    if (!(graph.nodes || []).length && !(graph.sources || []).length) {
      list.appendChild(element('p', 'No connections yet. Links you write and shared tags will appear here.'));
    }
  }

  function highlight(ids, selectedEdge) {
    global.clearTimeout(grace);
    var neighbours = new Set(ids);
    if (!selectedEdge) activeEdges.forEach(function (edge) {
      if (ids.indexOf(edge.from) >= 0 || ids.indexOf(edge.to) >= 0) { neighbours.add(edge.from); neighbours.add(edge.to); }
    });
    activeNodes.forEach(function (node) { node.el.style.opacity = neighbours.has(node.id) ? '1' : '.22'; node.el.classList.toggle('is-lit', neighbours.has(node.id)); });
    activeEdges.forEach(function (edge) {
      var lit = selectedEdge ? edge === selectedEdge : ids.indexOf(edge.from) >= 0 || ids.indexOf(edge.to) >= 0;
      edge.el.style.opacity = lit ? '1' : '.15'; edge.el.classList.toggle('is-lit', lit);
    });
  }
  function unhighlight() {
    global.clearTimeout(grace);
    grace = global.setTimeout(function () {
      activeNodes.forEach(function (node) { node.el.style.opacity = '1'; node.el.classList.remove('is-lit'); });
      activeEdges.forEach(function (edge) { edge.el.style.opacity = '1'; edge.el.classList.remove('is-lit'); });
    }, 140);
  }
  function ensurePicture() {
    if (svg) return;
    svg = vector('svg', { role: 'group', 'aria-label': 'Connections around this article', class: 'links-graph' });
    var defs = vector('defs'); svg.appendChild(defs);
    var marker = vector('marker', { id: 'links-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' });
    marker.appendChild(vector('path', { d: 'M 1 1.5 L 9.5 5 L 1 8.5 Z', fill: 'context-stroke', stroke: 'none' })); defs.appendChild(marker);
    edgeLayer = vector('g'); nodeLayer = vector('g'); svg.appendChild(edgeLayer); svg.appendChild(nodeLayer); picture.appendChild(svg);
  }
  function graphNode(data) {
    var id = key(data), held = nodeMap.get(id);
    if (!held) {
      var group = vector('g', { class: 'links-node', 'data-node': id, tabindex: 0, role: 'button' });
      var shape = vector('circle'), ring = vector('circle', { r: 17, class: 'links-ring', fill: 'none' });
      var status = vector('circle', { r: 3, cx: 12, cy: -12, class: 'links-status' });
      var labelBox = vector('foreignObject', { x: -74, y: 22, width: 148, height: 48 });
      var label = D.createElementNS('http://www.w3.org/1999/xhtml', 'div'); label.setAttribute('class', 'links-label'); labelBox.appendChild(label);
      var title = vector('title'); group.appendChild(title); group.appendChild(ring); group.appendChild(shape); group.appendChild(status); group.appendChild(labelBox);
      held = { id: id, el: group, shape: shape, ring: ring, status: status, label: label, title: title, data: data, x: 180, y: 60 };
      nodeMap.set(id, held); nodeLayer.appendChild(group);
      group.addEventListener('pointerenter', function () { highlight([id]); });
      group.addEventListener('pointerleave', unhighlight);
      group.addEventListener('focus', function () { highlight([id]); });
      group.addEventListener('blur', unhighlight);
      function activate() { if (held.data.path !== graph.centre.path) open(held.data); }
      group.addEventListener('click', activate);
      group.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    }
    held.data = data;
    var centre = id === graph.centre.path, material = data.kind === 'material', missing = data.kind === 'missing';
    if ((material && held.shape.tagName.toLowerCase() !== 'rect') || (!material && held.shape.tagName.toLowerCase() !== 'circle')) {
      var replacement = vector(material ? 'rect' : 'circle'); held.el.replaceChild(replacement, held.shape); held.shape = replacement;
    }
    if (material) { held.shape.setAttribute('x', -8); held.shape.setAttribute('y', -8); held.shape.setAttribute('width', 16); held.shape.setAttribute('height', 16); }
    else held.shape.setAttribute('r', centre ? 10 : 7.5);
    held.shape.setAttribute('class', 'links-shape kind-' + data.kind); held.shape.setAttribute('stroke-dasharray', missing ? '3 3' : 'none');
    held.ring.style.display = centre ? '' : 'none'; held.status.style.display = missing || material ? 'none' : '';
    held.status.setAttribute('data-live', centre ? 'live-matching' : liveState(data));
    var title = data.title || data.name || data.slug;
    held.label.textContent = title; held.title.textContent = title + (centre ? ', you are here' : material || missing ? '' : ', ' + liveWords(data));
    held.el.setAttribute('aria-label', held.title.textContent); held.el.setAttribute('data-centre', centre ? 'true' : 'false');
    held.el.setAttribute('aria-disabled', centre || missing ? 'true' : 'false');
    held.el.style.opacity = '1'; held.el.classList.remove('is-lit'); held.el.style.pointerEvents = ''; held.el.style.display = '';
    return held;
  }
  function graphEdge(data) {
    var id = data.kind + ':' + data.from + ':' + data.to + ':' + (data.tag || ''), held = edgeMap.get(id);
    if (!held) {
      var group = vector('g', { class: 'links-edge', tabindex: 0 }), line = vector('line', { class: 'links-line' });
      var hit = vector('line', { class: 'links-line-hit', stroke: 'transparent', 'stroke-width': 14 });
      var title = vector('title'); group.appendChild(title); group.appendChild(line); group.appendChild(hit); edgeLayer.appendChild(group);
      held = { el: group, line: line, hit: hit, title: title }; edgeMap.set(id, held);
      group.addEventListener('pointerenter', function () { highlight([held.from, held.to], held); });
      group.addEventListener('pointerleave', unhighlight);
      group.addEventListener('focus', function () { highlight([held.from, held.to], held); }); group.addEventListener('blur', unhighlight);
    }
    held.from = data.from; held.to = data.to; held.el.setAttribute('data-kind', data.kind);
    held.line.setAttribute('marker-end', data.kind === 'link' ? 'url(#links-arrow)' : 'none');
    held.line.setAttribute('marker-start', data.kind === 'link' && data.both ? 'url(#links-arrow)' : 'none');
    held.title.textContent = data.kind === 'tag' ? 'Shared tag: #' + data.tag : data.kind === 'material' ? 'Note beside this article' : data.both ? 'Linked both ways' : 'Link direction';
    held.el.setAttribute('aria-label', held.title.textContent); held.el.style.display = ''; held.el.style.opacity = '1'; held.el.classList.remove('is-lit');
    return held;
  }
  function positionEdges() {
    activeEdges.forEach(function (edge) {
      var a = nodeMap.get(edge.from), b = nodeMap.get(edge.to), dx = b.x - a.x, dy = b.y - a.y;
      var length = Math.sqrt(dx * dx + dy * dy) || 1, inset = 20;
      [edge.line, edge.hit].forEach(function (line) {
        line.setAttribute('x1', a.x + dx / length * inset); line.setAttribute('y1', a.y + dy / length * inset);
        line.setAttribute('x2', b.x - dx / length * inset); line.setAttribute('y2', b.y - dy / length * inset);
      });
    });
  }
  function reducedMotion() { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function paintPicture() {
    ensurePicture(); global.clearTimeout(grace);
    if (animation) global.cancelAnimationFrame(animation);
    nodeMap.forEach(function (node) { node.el.style.display = 'none'; }); edgeMap.forEach(function (edge) { edge.el.style.display = 'none'; });
    var centre = Object.assign({ kind: 'article' }, graph.centre), neighbours = (graph.nodes || []).concat(graph.sources || []);
    activeNodes = [graphNode(centre)].concat(neighbours.map(graphNode));
    // A ring around the piece, like the public graph: every line runs from the centre outward,
    // so no line can pass behind another piece and look like it connects to it.
    var n = neighbours.length, ry = Math.max(110, Math.min(260, 26 * n)), height = 2 * ry + 110;
    svg.setAttribute('viewBox', '0 0 360 ' + height); svg.setAttribute('height', height);
    activeNodes[0].tx = 180; activeNodes[0].ty = ry + 45;
    // Turn the ring so no neighbour sits level with the centre, where its label would hit the centre's.
    var step = 2 * Math.PI / Math.max(n, 1), turn = [0.5, 0, 0.25, 0.75].find(function (o) {
      for (var k = 0; k < n; k++) { var deg = ((-90 + (k + o) * step * 180 / Math.PI) % 180 + 180) % 180; if (Math.min(deg, 180 - deg) < 24) return false; }
      return true;
    }); if (turn === undefined) turn = 0.5;
    activeNodes.slice(1).forEach(function (node, i) {
      var a = -Math.PI / 2 + (i + turn) * step;
      node.tx = 180 + Math.cos(a) * 118; node.ty = ry + 45 + Math.sin(a) * ry;
    });
    activeEdges = (graph.edges || []).concat((graph.sources || []).map(function (node) {
      return { from: centre.path, to: node.path, kind: 'material' };
    })).filter(function (edge) { return nodeMap.has(edge.from) && nodeMap.has(edge.to); }).map(graphEdge);
    var starts = activeNodes.map(function (node) { return { x: node.x, y: node.y }; }), began = null;
    function frame(now) {
      if (began === null) began = now;
      var t = reducedMotion() ? 1 : Math.min(1, (now - began) / 650), ease = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      activeNodes.forEach(function (node, i) {
        node.x = starts[i].x + (node.tx - starts[i].x) * ease; node.y = starts[i].y + (node.ty - starts[i].y) * ease;
        node.el.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');
      }); positionEdges();
      animation = t < 1 ? global.requestAnimationFrame(frame) : 0;
    }
    if (reducedMotion()) frame(0); else animation = global.requestAnimationFrame(frame);
  }
  function chooseView(value) {
    view = value; write('descant.links.view', view);
    if (!body) return;
    list.hidden = view !== 'list'; picture.hidden = view !== 'picture';
    Object.keys(toggle).forEach(function (mode) { toggle[mode].setAttribute('aria-pressed', view === mode ? 'true' : 'false'); });
    if (graph && view === 'picture') paintPicture();
  }
  function paint() {
    if (!body || !graph) return;
    message.textContent = 'Connections around ' + graph.centre.title + '. Insert a link to connect your ideas.';
    paintList(); if (view === 'picture') paintPicture();
  }
  function refresh() {
    if (!mounted || !founder()) return Promise.resolve();
    var path = current(), request = ++epoch;
    if (path !== article) { article = path; savedCaret = null; if (list) list.textContent = ''; }
    if (!/^articles\/[^/]+\/article\.md$/.test(path)) {
      graph = null; if (picture) picture.hidden = true;
      if (message) message.textContent = 'Open an article to see its connections.'; return Promise.resolve();
    }
    if ((!graph || graph.centre.path !== path) && message) message.textContent = 'Loading connections...';
    return global.fetch(C.endpoints.api('graph?path=') + encodeURIComponent(path), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw Error('links unavailable'); return response.json(); })
      .then(function (data) {
        if (request !== epoch || path !== current() || !founder()) return;
        graph = data; if (picture) picture.hidden = view !== 'picture'; paint();
      }).catch(function () {
        if (request !== epoch) return;
        if (message) message.textContent = 'Connections could not load. Reopen Links or reconnect to try again.';
      });
  }
  function mountPanel(el) {
    body = el; body.classList.add('castor-links'); body.textContent = '';
    var modes = element('div', '', 'links-views'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Show connections as');
    ['list', 'picture'].forEach(function (mode) { toggle[mode] = button(mode === 'list' ? 'List' : 'Picture', function () { chooseView(mode); }); modes.appendChild(toggle[mode]); });
    body.appendChild(modes); message = element('p', '', 'links-message'); message.setAttribute('role', 'status'); body.appendChild(message);
    list = element('div', '', 'links-list'); picture = element('div', '', 'links-picture'); body.appendChild(list); body.appendChild(picture);
    svg = null; nodeMap.clear(); edgeMap.clear(); chooseView(view); if (graph) paint(); else refresh();
  }
  function mount() {
    if (mounted || !founder() || !C.app || !C.app.live) return;
    mounted = true;
    if (!D.getElementById('castor-links-style')) {
      var style = element('style',
        '.castor-links{padding:.8rem;font-size:.9rem;min-width:0}.castor-links [hidden]{display:none!important}' +
        '.castor-links button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;min-height:44px;text-align:left}' +
        '.castor-links button:focus-visible,.links-node:focus-visible,.links-edge:focus-visible{outline:2px solid var(--ink);outline-offset:2px}' +
        '.links-views{display:flex;gap:.8rem;border-bottom:1px solid var(--rule)}.links-views [aria-pressed="true"]{text-decoration:underline;text-underline-offset:.4rem}' +
        '.links-message{line-height:1.5;overflow-wrap:anywhere}.links-list h3{font:inherit;font-weight:600;margin:1.5rem 0 .4rem}.links-list ul{list-style:none;margin:0;padding:0}' +
        '.links-list li{display:flex;flex-wrap:wrap;align-items:center;gap:0 .5rem;border-top:1px solid var(--rule);padding:.2rem 0}' +
        '.links-go{display:flex;align-items:center;gap:.5rem;flex:1 1 140px;min-width:0;padding:0}.links-title{overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}' +
        '.links-insert{font-size:.8rem!important;text-decoration:underline;text-underline-offset:.2rem;padding:0 .2rem}.links-tags{flex-basis:100%;overflow-wrap:anywhere}.links-size{margin-left:auto}' +
        '.links-missing{border-bottom:1px dashed var(--rule);overflow-wrap:anywhere;padding:.6rem 0}.links-dot{display:inline-block;flex-shrink:0;width:6px;height:6px;border-radius:50%;background:var(--ink-3,#888)}' +
        '.links-dot[data-live="live-matching"]{background:var(--between,#667D2F)}.links-dot[data-live="live-changed"]{background:var(--amber,#B27C32)}' +
        '.links-graph{display:block;width:100%;height:auto;overflow:visible;color:var(--ink)}.links-node,.links-edge{transition:opacity .3s ease}.links-node{cursor:pointer}.links-node[aria-disabled="true"]{cursor:default}' +
        '.links-label{color:var(--ink);background:var(--paper);font-size:13px;line-height:20px;font-family:inherit;text-align:center;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}' +
        '.links-shape{fill:var(--paper);stroke:var(--ink);stroke-width:1.2}.links-ring{stroke:var(--ink);stroke-width:1.2}.links-status{fill:var(--ink-3,#888)}' +
        '.links-status[data-live="live-matching"]{fill:var(--between,#667D2F)}.links-status[data-live="live-changed"]{fill:var(--amber,#B27C32)}' +
        '.links-line{stroke:var(--ink);stroke-width:1;fill:none}.links-edge[data-kind="tag"] .links-line,.links-edge[data-kind="material"] .links-line{stroke:var(--ink-3,#888);stroke-width:.7}' +
        '.links-edge.is-lit .links-line{stroke:var(--ink);stroke-width:1.5}.links-line-hit{pointer-events:stroke}.links-node[data-centre="true"] .links-label{font-weight:600}' +
        '.links-node.is-lit .links-shape{stroke:var(--ink)}.links-shape.kind-article{fill:var(--ink);fill-opacity:.82;stroke:none}.links-node.is-lit .links-shape.kind-article{fill:var(--ink);fill-opacity:1}.links-shape.kind-missing{fill:var(--paper)}.links-node{transition:opacity .3s cubic-bezier(.22,.9,.25,1)}' +
        '@media(prefers-reduced-motion:reduce){.links-node,.links-edge{transition:none}}');
      style.id = 'castor-links-style'; D.head.appendChild(style);
    }
    C.panels.register('links', { title: 'Links', ready: true, mount: mountPanel });
    C.bus.on('piece:open', refresh);
    C.bus.on('save:state', function (event) { if (event && event.state === 'saved') refresh(); });
    C.bus.on('panel:open', function (id) {
      if (id !== 'links' || !founder()) return;
      var count = Number(read('descant.links.opens')) || 0; write('descant.links.opens', count + 1); refresh();
    });
    D.addEventListener('selectionchange', rememberCaret);
    D.addEventListener('pointerdown', rememberCaret, true);
    global.addEventListener('online', refresh);
    refresh();
  }
  C.links = { mount: mount, refresh: refresh, groups: groups, insert: insert };
})(typeof window !== 'undefined' ? window : globalThis);
