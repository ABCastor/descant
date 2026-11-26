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

  /* The picture is version A of the writing graph, "Around one piece", drawn as on the website:
     the open article in the middle with the green dot, the written pieces it links to, that link
     to it and that share a tag around it. Arrows give a link's direction, two heads mean both ways.
     Unwritten pieces and notes stay in the list; nothing here is chosen by an agent. */
  var LINE = 17, NARROW = 560, MOTION = 650;
  function wrap(title, n) {
    title = String(title || '');
    if (title.length <= n) return [title];
    var cut = title.lastIndexOf(' ', n); if (cut < 8) cut = title.indexOf(' ', n); if (cut < 0) return [title];
    var rest = title.slice(cut + 1); if (rest.length > n + 6) rest = rest.slice(0, n + 3).replace(/\s+\S*$/, '') + '…';
    return [title.slice(0, cut), rest];
  }
  function clip(title, n) { title = String(title || ''); return title.length <= n ? title : title.slice(0, n).replace(/\s+\S*$/, '') + '…'; }
  var ruler = null;
  function measurer() {
    if (ruler === null) {
      ruler = false;
      try { var canvas = D.createElement('canvas'), context = canvas.getContext && canvas.getContext('2d'); if (context && context.measureText) ruler = context; } catch (e) { /* estimate below */ }
    }
    var family = 'Newsreader, Georgia, serif';
    try { var css = global.getComputedStyle && global.getComputedStyle(D.documentElement).getPropertyValue('--font-ui-heading'); if (css && css.trim()) family = css.trim(); } catch (e) { /* default */ }
    return function (text, size, weight) {
      if (ruler) { ruler.font = (weight || 600) + ' ' + size + 'px ' + family; return ruler.measureText(text).width; }
      return text.length * size * 0.56;
    };
  }
  // Every piece around the centre, strongest reason first: a link counts 3, each shared tag 1.
  function around(data) {
    var centre = data.centre.path, out = [];
    (data.nodes || []).forEach(function (node) {
      if (node.kind !== 'article' || node.path === centre) return;
      var edges = (data.edges || []).filter(function (edge) { return (edge.from === centre && edge.to === node.path) || (edge.to === centre && edge.from === node.path); });
      var links = edges.filter(function (edge) { return edge.kind === 'link'; }), tags = edges.filter(function (edge) { return edge.kind === 'tag'; }).map(function (edge) { return edge.tag; });
      var outgoing = links.some(function (edge) { return edge.from === centre; }), incoming = links.some(function (edge) { return edge.to === centre; });
      var dir = links.some(function (edge) { return edge.both; }) || (outgoing && incoming) ? 'both' : outgoing ? 'out' : incoming ? 'in' : tags.length ? 'tag' : '';
      if (dir) out.push({ data: node, dir: dir, tags: tags, score: (dir === 'tag' ? 0 : 3) + tags.length });
    });
    return out.sort(function (a, b) { return b.score - a.score || String(a.data.title || a.data.slug).localeCompare(String(b.data.title || b.data.slug)); });
  }
  function labelBox(x, y, lines, size, anchor, measure, weight) {
    var w = Math.max.apply(null, lines.map(function (line) { return measure(line, size, weight); })) + 4;
    var x0 = anchor === 'start' ? x - 2 : anchor === 'end' ? x - w + 2 : x - w / 2;
    return { x0: x0, x1: x0 + w, y0: y - size * 0.82, y1: y + (lines.length - 1) * LINE + size * 0.28 };
  }
  // Places the pieces in pixels for a picture `width` wide: one ring on a narrow panel, the
  // website's two rings (links inside, shared tags outside) on a wide one. The ring is turned and
  // stretched until no label touches another, a piece or the centre, and every label fits inside.
  function layout(data, width, measure) {
    var raw = measure || measurer(), known = {};
    measure = function (text, size, weight) { var k = size + '|' + (weight || 600) + '|' + text; return k in known ? known[k] : (known[k] = raw(text, size, weight)); };
    var W = Math.max(200, Math.round(width || 320)), cx = W / 2, narrow = W < NARROW, pieces = around(data);
    var centreTitle = data.centre.title || data.centre.slug, centreChars = narrow ? 22 : 26, centreLines;
    do centreLines = wrap(centreTitle, centreChars); while (labelBox(0, 0, centreLines, 17, 'start', measure).x1 > W - 16 && --centreChars >= 9);
    var centre = { id: data.centre.path, data: Object.assign({ kind: 'article' }, data.centre), ring: 0, r: 11, x: 0, y: 0, lines: centreLines, size: 17, anchor: 'middle' };
    var strong = pieces.filter(function (p) { return p.dir !== 'tag'; }), weak = pieces.filter(function (p) { return p.dir === 'tag'; });
    var rings = narrow || !strong.length ? [strong.concat(weak)] : [strong, weak];
    // Titles wrap over two lines. On a narrow panel they first wrap shorter so two pieces fit side
    // by side; if they still do not, each piece takes its own row.
    var nodes, widest;
    function titles(chars, room, least) {
      do {
        nodes = pieces.map(function (p) {
          var small = p.dir === 'tag', title = p.data.title || p.data.slug;
          return { id: p.data.path, data: p.data, dir: p.dir, tags: p.tags, ring: small && rings.length > 1 ? 2 : 1, r: small ? 5.5 : 8,
            size: small ? 12 : narrow ? 13 : 14, lines: small ? [clip(title, narrow ? Math.min(18, chars) : 26)] : wrap(title, chars) };
        });
        widest = Math.max.apply(null, [40].concat(nodes.map(function (node) { return labelBox(0, 0, node.lines, node.size, 'start', measure).x1; })));
      } while (widest > room && --chars >= least);
      return widest <= room;
    }
    if (!narrow) titles(22, W / 2 - 80, 9);
    else if (!titles(17, cx - 8, 12)) titles(17, W - 84, 9);
    var byId = {}; nodes.forEach(function (node) { byId[node.id] = node; });
    function place(members, rx, ry, turn) {
      var step = 2 * Math.PI / Math.max(members.length, 1);
      members.forEach(function (p, i) {
        var node = byId[p.data.path], a = -Math.PI / 2 + (i + turn) * step, c = Math.cos(a), s = Math.sin(a);
        node.x = Math.cos(a) * rx; node.y = Math.sin(a) * ry; node.a = a;
        node.anchor = narrow ? 'middle' : c > 0.25 ? 'start' : c < -0.25 ? 'end' : 'middle';
        var dx = node.anchor === 'start' ? node.r + 6 : node.anchor === 'end' ? -node.r - 6 : 0;
        var above = node.anchor === 'middle' && s <= -0.3, dy = node.anchor !== 'middle' ? 5 : above ? -node.r - 8 - (node.lines.length - 1) * LINE : node.r + 17;
        node.lx = node.x + dx; node.ly = node.y + dy;
      });
    }
    function boxes() {
      centre.lx = 0; centre.ly = 40; centre.box = labelBox(0, 40, centre.lines, 17, 'middle', measure); centre.dot = { x0: -25, x1: 25, y0: -25, y1: 25 };
      nodes.forEach(function (node) {
        node.box = labelBox(node.lx, node.ly, node.lines, node.size, node.anchor, measure);
        node.dot = { x0: node.x - node.r - 3, x1: node.x + node.r + 3, y0: node.y - node.r - 3, y1: node.y + node.r + 3 };
      });
    }
    function cost() {
      var all = [centre].concat(nodes), score = 0;
      function hit(a, b) { var w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); return w > 0 && h > 0 ? w * h + 1000 : 0; }
      // Two lines leaving the centre side by side read as one: keep them apart.
      for (var p = 0; p < nodes.length; p++) for (var q = p + 1; q < nodes.length; q++) {
        var turn = Math.abs(Math.atan2(nodes[p].y, nodes[p].x) - Math.atan2(nodes[q].y, nodes[q].x)); turn = Math.min(turn, 2 * Math.PI - turn);
        if (turn < 0.22) score += 300;
      }
      for (var i = 0; i < all.length; i++) {
        var b = all[i].box; score += Math.max(0, -cx - b.x0) * 500 + Math.max(0, b.x1 - cx) * 500;
        for (var j = 0; j < all.length; j++) if (i !== j) { score += hit(all[i].box, all[j].dot); if (j > i) score += hit(all[i].box, all[j].box) + hit(all[i].dot, all[j].dot); }
      }
      return score;
    }
    if (narrow) rows(); else rings2();
    // A narrow panel has no room beside a label, so the ring becomes rows around the piece, in pairs
    // left and right on an oval, labels away from the centre; one alone sits at the top.
    function rows() {
      var n = rings[0].length, rx = Math.max(0, cx - widest / 2 - 2), xmin = widest / 2 + 6, paired = xmin <= rx;
      var topSingle = n % 2 === 1 || n === 2 || !paired && n > 0, bottomSingle = n === 2 && paired;
      var rest = n - (topSingle ? 1 : 0) - (bottomSingle ? 1 : 0), up = [], down = [];
      if (paired) for (var k = 0; k < rest / 2; k++) (k % 2 ? up : down).push(2);
      else for (var m = 0; m < rest; m++) (m % 2 ? up : down).push(1);
      if (topSingle) up.push(1); if (bottomSingle) down.push(1);
      // Clockwise from the top: the lone top piece, the right side down, the bottom, the left side up.
      var slots = [], i;
      if (topSingle) slots.push([up.length - 1, 'up', 0]);
      for (i = up.length - 1; i >= 0; i--) if (up[i] === 2) slots.push([i, 'up', 1]);
      for (i = 0; i < down.length; i++) if (down[i] === 2) slots.push([i, 'down', 1]);
      if (bottomSingle) slots.push([down.length - 1, 'down', 0]);
      for (i = down.length - 1; i >= 0; i--) if (down[i] === 2) slots.push([i, 'down', -1]);
      for (i = 0; i < up.length; i++) if (up[i] === 2) slots.push([i, 'up', -1]);
      if (!paired) { slots = []; var side = 1; for (i = 0; i < Math.max(up.length, down.length); i++) { if (i < up.length) slots.push([i, 'up', i === up.length - 1 && topSingle ? 0 : (side = -side)]); if (i < down.length) slots.push([i, 'down', side = -side]); } }
      var members = { up: up.map(function () { return []; }), down: down.map(function () { return []; }) };
      rings[0].forEach(function (p, index) { var slot = slots[index], node = byId[p.data.path]; node.side = slot[2]; members[slot[1]][slot[0]].push(node); });
      // The nearest pieces sit far enough out for a line with an arrow at each end to read.
      var edge = -56;
      members.up.forEach(function (row) {
        var reach = 0; row.forEach(function (node) { reach = Math.max(reach, node.r + 8 + (node.lines.length - 1) * LINE + node.size * 0.82); });
        var y = edge - 10 - Math.max.apply(null, row.map(function (node) { return node.r + 3; }));
        row.forEach(function (node) { node.y = y; node.ly = y - node.r - 8 - (node.lines.length - 1) * LINE; });
        edge = y - reach;
      });
      edge = labelBox(0, 40, centreLines, 17, 'middle', measure).y1 + 30;
      members.down.forEach(function (row) {
        var y = edge + 10 + Math.max.apply(null, row.map(function (node) { return node.r + 3; })), reach = 0;
        row.forEach(function (node) { node.y = y; node.ly = y + node.r + 17; reach = Math.max(reach, node.r + 17 + (node.lines.length - 1) * LINE + node.size * 0.28); });
        edge = y + reach;
      });
      var R = Math.max.apply(null, [60].concat(nodes.map(function (node) { return Math.abs(node.y); }))) + 40;
      nodes.forEach(function (node) {
        var x = paired ? Math.min(rx, Math.max(xmin, rx * Math.sqrt(Math.max(0, 1 - node.y * node.y / (R * R))))) : Math.min(rx, Math.max(24, cx * 0.42));
        node.x = node.side * x; node.lx = node.x; node.anchor = 'middle';
      });
      boxes();
    }
    // A wide sheet keeps the website's two rings: links inside, shared tags outside, labels beside.
    function rings2() {
      var best = null, turns = [0.5, 0.25, 0.75, 0, 0.125, 0.375, 0.625, 0.875], side = widest + 14;
      var rx = Math.max(40, Math.min(215, cx - side - 4)), rx2 = Math.max(rx + 40, Math.min(330, cx - Math.min(side, 110) - 4));
      function trial(ry, t, u) {
        place(rings[0], rx, ry, t); if (rings.length > 1) place(rings[1], rx2, ry + 70, u + 0.5 / Math.max(rings[1].length, 1));
        boxes(); var score = cost();
        if (!best || score < best.score) best = { score: score, ry: ry, t: t, u: u };
        return score;
      }
      // Turn the inner ring first, then the outer one around it: a few hundred trials at most.
      for (var ry = 150; ry <= 640; ry += 20) {
        var inner = turns[0], least = Infinity;
        for (var t = 0; t < turns.length; t++) { var score = trial(ry, turns[t], turns[0]); if (score < least) { least = score; inner = turns[t]; } if (!score) break; }
        if (rings.length > 1 && least) for (var u = 1; u < turns.length; u++) if (!trial(ry, inner, turns[u])) break;
        if (best.score === 0 || !pieces.length || ry - best.ry >= 160) break;
      }
      place(rings[0], rx, best.ry, best.t); if (rings.length > 1) place(rings[1], rx2, best.ry + 70, best.u + 0.5 / Math.max(rings[1].length, 1)); boxes();
    }
    var all = [centre].concat(nodes), top = Math.min.apply(null, all.map(function (n) { return Math.min(n.box.y0, n.dot.y0); })) - 10;
    var bottom = Math.max.apply(null, all.map(function (n) { return Math.max(n.box.y1, n.dot.y1); })) + 10;
    function shift(box) { return { x0: box.x0 + cx, x1: box.x1 + cx, y0: box.y0 - top, y1: box.y1 - top }; }
    all.forEach(function (node) { node.x += cx; node.y -= top; node.lx += cx; node.ly -= top; node.box = shift(node.box); node.dot = shift(node.dot); });
    return { width: W, height: Math.ceil(bottom - top), narrow: narrow, centre: centre, nodes: all,
      edges: nodes.map(function (node) { return { id: [centre.id, node.id].sort().join('|'), from: centre.id, to: node.id, dir: node.dir, tags: node.tags }; }) };
  }

  var trail = [], viaPicture = false, here, plan = null, lastWidth = 0, observer = null;
  function setDim(on, nodes, edges) {
    activeNodes.forEach(function (node) { var lit = !on || nodes.indexOf(node.id) >= 0; node.el.style.opacity = lit ? '1' : '.22'; node.el.classList.toggle('is-lit', on && lit); });
    activeEdges.forEach(function (edge) { var lit = !on || edges.indexOf(edge) >= 0; edge.el.style.opacity = lit ? '1' : '.12'; edge.el.classList.toggle('is-lit', on && lit); edge.why.classList.toggle('is-lit', on && lit); });
  }
  function highlight(ids, selectedEdge) {
    global.clearTimeout(grace);
    if (!selectedEdge && plan && ids.length === 1 && ids[0] === plan.centre.id) { setDim(false); return; }
    var edges = selectedEdge ? [selectedEdge] : activeEdges.filter(function (edge) { return ids.indexOf(edge.to) >= 0; });
    var nodes = ids.slice(); edges.forEach(function (edge) { nodes.push(edge.from, edge.to); });
    setDim(true, nodes, edges);
  }
  function unhighlight() {
    global.clearTimeout(grace);
    grace = global.setTimeout(function () { setDim(false); }, 140);
  }
  function ensurePicture() {
    if (svg) return;
    svg = vector('svg', { role: 'group', class: 'links-graph' });
    edgeLayer = vector('g', { class: 'links-edges' }); svg.appendChild(edgeLayer);
    here = vector('g', { class: 'links-here', 'aria-hidden': 'true' });
    here.appendChild(vector('circle', { r: 21, class: 'links-here-ring' }));
    var orbit = vector('g', { class: 'links-here-orbit' }); orbit.appendChild(vector('circle', { cx: 0, cy: -21, r: 3.6, class: 'links-here-dot' })); here.appendChild(orbit);
    svg.appendChild(here);
    nodeLayer = vector('g', { class: 'links-nodes' }); svg.appendChild(nodeLayer);
    wordLayer = vector('g', { class: 'links-words', 'aria-hidden': 'true' }); svg.appendChild(wordLayer);
    picture.appendChild(svg);
    trailEl = element('p', '', 'links-trail'); picture.appendChild(trailEl);
    emptyEl = element('p', 'Nothing connects here yet. Pieces you link to, pieces that link here and pieces that share a tag will gather around it.', 'links-empty'); picture.appendChild(emptyEl);
    picture.appendChild(legend());
    if (global.ResizeObserver) {
      if (observer) observer.disconnect();
      observer = new global.ResizeObserver(function () { var w = picture.clientWidth; if (graph && !picture.hidden && w && Math.abs(w - lastWidth) >= 24) paintPicture(); });
      observer.observe(picture);
    }
  }
  var trailEl, emptyEl, wordLayer;
  function legend() {
    var list = element('ul', '', 'links-key'); list.setAttribute('aria-label', 'What the picture shows');
    [['M0 6H14', 'M20 6L13 2.6V9.4Z', 'Links to'], ['M7 6H15', 'M1 6L8 2.6V9.4Z M21 6L14 2.6V9.4Z', 'Link each other'], ['M0 6H20', '', 'Share a tag'], ['', '', 'You are here']].forEach(function (item) {
      var row = element('li'), mark = vector('svg', { width: 22, height: 12, viewBox: '0 0 22 12', 'aria-hidden': 'true' });
      if (item[2] === 'You are here') {
        mark.appendChild(vector('circle', { cx: 11, cy: 6, r: 5, class: 'links-here-ring' })); mark.appendChild(vector('circle', { cx: 11, cy: 1, r: 2.2, class: 'links-here-dot' }));
      } else {
        mark.appendChild(vector('path', { d: item[0], class: item[1] ? 'links-line' : 'links-line is-tag' }));
        if (item[1]) mark.appendChild(vector('path', { d: item[1], class: 'links-head' }));
      }
      row.appendChild(mark); row.appendChild(element('span', item[2])); list.appendChild(row);
    });
    return list;
  }
  function graphNode(id) {
    var held = nodeMap.get(id);
    if (held) return held;
    var group = vector('g', { class: 'links-node', 'data-node': id, tabindex: 0, role: 'button' }), body = vector('g', { class: 'links-node-body' });
    var hit = vector('circle', { r: 24, class: 'links-hit' }), focus = vector('circle', { r: 15, class: 'links-focus' }), shape = vector('circle', { r: 8, class: 'links-shape' });
    var label = vector('text', { class: 'links-label', 'text-anchor': 'middle' }), plate = vector('rect', { class: 'links-plate', rx: 3 }), name = vector('title');
    // The plate is the panel's own ground under a label, so no line runs through its words.
    group.appendChild(name); body.appendChild(hit); body.appendChild(plate); body.appendChild(focus); body.appendChild(shape); body.appendChild(label); group.appendChild(body); nodeLayer.appendChild(group);
    held = { id: id, el: group, body: body, shape: shape, label: label, plate: plate, name: name, x: null, y: null, o: 0 };
    nodeMap.set(id, held);
    function activate() { if (plan && held.id !== plan.centre.id && held.data) go(held.data); }
    group.addEventListener('pointerenter', function () { highlight([id]); });
    group.addEventListener('pointerleave', unhighlight);
    group.addEventListener('focus', function () { highlight([id]); });
    group.addEventListener('blur', unhighlight);
    group.addEventListener('click', activate);
    group.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
    return held;
  }
  function paintNode(held, node) {
    var centre = node.ring === 0, title = node.data.title || node.data.slug;
    held.data = node.data; held.r = node.r;
    held.shape.setAttribute('r', node.r);
    held.label.textContent = ''; held.label.setAttribute('class', 'links-label' + (centre ? ' is-centre' : node.dir === 'tag' ? ' is-small' : ''));
    held.label.setAttribute('text-anchor', node.anchor);
    node.lines.forEach(function (line, i) {
      var span = vector('tspan', { x: node.lx - node.x, dy: i ? LINE : 0 }); span.textContent = line; held.label.appendChild(span);
    });
    held.label.setAttribute('x', node.lx - node.x); held.label.setAttribute('y', node.ly - node.y);
    held.plate.setAttribute('x', (node.box.x0 - node.x - 2).toFixed(1)); held.plate.setAttribute('y', (node.box.y0 - node.y - 1).toFixed(1));
    held.plate.setAttribute('width', (node.box.x1 - node.box.x0 + 4).toFixed(1)); held.plate.setAttribute('height', (node.box.y1 - node.box.y0 + 2).toFixed(1));
    held.name.textContent = title;
    var words = centre ? title + ', you are here' : 'Open ' + title + ', ' + (node.dir === 'both' ? 'they link to each other' : node.dir === 'out' ? 'linked from here' : node.dir === 'in' ? 'links here' : 'shares ' + node.tags.map(function (t) { return '#' + t; }).join(' '));
    held.el.setAttribute('aria-label', words); held.el.setAttribute('data-centre', centre ? 'true' : 'false');
    held.el.setAttribute('aria-disabled', centre ? 'true' : 'false'); held.el.setAttribute('tabindex', centre ? -1 : 0);
    held.el.style.display = ''; held.el.style.opacity = '1'; held.el.classList.remove('is-lit');
  }
  function graphEdge(edge) {
    var held = edgeMap.get(edge.id);
    if (!held) {
      var group = vector('g', { class: 'links-edge', 'data-edge': edge.id }), body = vector('g', { class: 'links-edge-body' });
      var line = vector('path', { class: 'links-line' }), hit = vector('path', { class: 'links-line-hit' }), why = vector('text', { class: 'links-why', 'text-anchor': 'middle', 'data-why': edge.id });
      // The reason is written above every piece and label, so a short line never hides it.
      body.appendChild(line); group.appendChild(body); group.appendChild(hit); edgeLayer.appendChild(group); wordLayer.appendChild(why);
      held = { id: edge.id, el: group, body: body, line: line, hit: hit, why: why, heads: [], o: 0 };
      edgeMap.set(edge.id, held);
      hit.addEventListener('pointerenter', function () { highlight([held.from, held.to], held); });
      hit.addEventListener('pointerleave', unhighlight);
    }
    held.from = edge.from; held.to = edge.to; held.dir = edge.dir;
    held.el.setAttribute('data-dir', edge.dir); held.line.setAttribute('class', 'links-line' + (edge.dir === 'tag' ? ' is-tag' : ''));
    var count = edge.dir === 'both' ? 2 : edge.dir === 'tag' ? 0 : 1;
    while (held.heads.length > count) held.body.replaceChild(vector('g'), held.heads.pop());
    while (held.heads.length < count) { var head = vector('path', { class: 'links-head' }); held.body.appendChild(head); held.heads.push(head); }
    held.why.style.display = ''; held.why.classList.remove('is-lit'); held.why.textContent = edge.dir === 'both' ? 'they link to each other' : edge.dir === 'out' ? 'linked from here' : edge.dir === 'in' ? 'links here' : edge.tags.map(function (t) { return '#' + t; }).join(' ');
    held.el.style.display = ''; held.el.style.opacity = '1'; held.el.classList.remove('is-lit');
    return held;
  }
  // How far a line from the centre starts: past the ring, and past the title when it runs under it.
  function clear(centre, ux, uy) {
    var box = plan.centre.box, dx = centre.x - plan.centre.x, dy = centre.y - plan.centre.y, out = 25, enter = 0, exit = Infinity;
    [[ux, centre.x, box.x0 + dx - 2, box.x1 + dx + 2], [uy, centre.y, box.y0 + dy - 2, box.y1 + dy + 2]].forEach(function (axis) {
      var u = axis[0], c = axis[1], lo = axis[2], hi = axis[3];
      if (Math.abs(u) < 1e-9) { if (c < lo || c > hi) exit = -1; return; }
      var a = (lo - c) / u, b = (hi - c) / u; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    });
    return exit > enter ? Math.max(out, exit + 4) : out;
  }
  function arrow(x, y, ux, uy) {
    var L = 8, w = 3.6;
    return 'M' + x.toFixed(1) + ' ' + y.toFixed(1) + 'L' + (x - ux * L - uy * w).toFixed(1) + ' ' + (y - uy * L + ux * w).toFixed(1) + 'L' + (x - ux * L + uy * w).toFixed(1) + ' ' + (y - uy * L - ux * w).toFixed(1) + 'Z';
  }
  function positionAll() {
    nodeMap.forEach(function (node) {
      if (node.x === null) return;
      node.el.setAttribute('transform', 'translate(' + node.x.toFixed(1) + ',' + node.y.toFixed(1) + ')');
      node.body.setAttribute('opacity', node.o.toFixed(3));
    });
    edgeMap.forEach(function (edge) {
      var a = nodeMap.get(edge.from), b = nodeMap.get(edge.to);
      if (!a || !b || a.x === null || b.x === null) return;
      // The arrow points along the link: out from here, in towards here.
      var s = edge.dir === 'in' ? b : a, t = edge.dir === 'in' ? a : b, dx = t.x - s.x, dy = t.y - s.y, l = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / l, uy = dy / l;
      var rs = (s === a ? a.r || 11 : s.r || 8) + 4, rt = (t.r || 8) + 4;
      if (s.id === (plan && plan.centre.id)) rs = clear(s, ux, uy); if (t.id === (plan && plan.centre.id)) rt = clear(t, -ux, -uy);
      var x1 = s.x + ux * rs, y1 = s.y + uy * rs, x2 = t.x - ux * rt, y2 = t.y - uy * rt, d = 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1);
      edge.line.setAttribute('d', d); edge.hit.setAttribute('d', d);
      if (edge.heads[0]) edge.heads[0].setAttribute('d', arrow(x2, y2, ux, uy));
      if (edge.heads[1]) edge.heads[1].setAttribute('d', arrow(x1, y1, -ux, -uy));
      var far = s.id === (plan && plan.centre.id) ? 0.6 : 0.4;
      edge.why.setAttribute('x', (x1 + (x2 - x1) * far).toFixed(1)); edge.why.setAttribute('y', (y1 + (y2 - y1) * far - 6).toFixed(1));
      edge.why.setAttribute('opacity', edge.o.toFixed(3));
      edge.body.setAttribute('opacity', edge.o.toFixed(3));
    });
  }
  function reducedMotion() { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function paintPicture() {
    ensurePicture(); global.clearTimeout(grace);
    if (animation) global.cancelAnimationFrame(animation);
    lastWidth = picture.clientWidth || lastWidth || 320;
    var previous = plan; plan = layout(graph, lastWidth);
    // While pieces glide the picture keeps the taller of its two heights, so nothing under it jumps mid-move.
    function size(height) { svg.setAttribute('viewBox', '0 0 ' + plan.width + ' ' + height); svg.setAttribute('width', plan.width); svg.setAttribute('height', height); }
    size(previous && previous.width === plan.width && !reducedMotion() ? Math.max(previous.height, plan.height) : plan.height);
    svg.setAttribute('aria-label', 'Pieces around ' + (graph.centre.title || graph.centre.slug));
    here.setAttribute('transform', 'translate(' + plan.centre.x.toFixed(1) + ',' + plan.centre.y.toFixed(1) + ')');
    // Pieces new to the picture come out of the piece just opened; the rest glide from where they are.
    var held = nodeMap.get(plan.centre.id), origin = held && held.x !== null && previous ? { x: held.x, y: held.y } : { x: plan.centre.x, y: plan.centre.y };
    var wanted = {}, wantedEdges = {};
    activeNodes = plan.nodes.map(function (node) {
      var item = graphNode(node.id); wanted[node.id] = true;
      // On first drawing the pieces open out a little from the centre; later, new ones come out of the piece just opened.
      if (item.x === null || item.o === 0) {
        item.x = previous ? origin.x : origin.x + (node.x - origin.x) * 0.85; item.y = previous ? origin.y : origin.y + (node.y - origin.y) * 0.85; item.o = 0;
      }
      item.tx = node.x; item.ty = node.y; item.aim = 1; paintNode(item, node); return item;
    });
    nodeMap.forEach(function (item, id) { if (!wanted[id]) { item.tx = item.x; item.ty = item.y; item.aim = 0; } });
    activeEdges = plan.edges.map(function (edge) { var item = graphEdge(edge); wantedEdges[edge.id] = true; item.aim = 1; return item; });
    edgeMap.forEach(function (item, id) { if (!wantedEdges[id]) item.aim = 0; });
    trailEl.textContent = '';
    if (trail.length) {
      trailEl.appendChild(element('span', 'Came from ', 'links-trail-lead'));
      trail.forEach(function (step, i) {
        var back = button(step.title, function () { trail = trail.slice(0, i); viaPicture = true; if (C.pieces && C.pieces.open) C.pieces.open(step.path); }, 'links-back');
        back.setAttribute('data-back', step.path); trailEl.appendChild(back); trailEl.appendChild(element('span', ' › ', 'links-trail-sep'));
      });
      trailEl.appendChild(element('span', graph.centre.title || graph.centre.slug, 'links-trail-here'));
    }
    trailEl.hidden = !trail.length; emptyEl.hidden = plan.nodes.length > 1;
    var starts = [], began = null;
    nodeMap.forEach(function (item) { starts.push([item, item.x, item.y, item.o]); });
    var edgeStarts = []; edgeMap.forEach(function (item) { edgeStarts.push([item, item.o]); });
    function frame(now) {
      if (began === null) began = now;
      var t = reducedMotion() ? 1 : Math.min(1, (now - began) / MOTION), ease = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      starts.forEach(function (s) { var item = s[0]; item.x = s[1] + (item.tx - s[1]) * ease; item.y = s[2] + (item.ty - s[2]) * ease; item.o = s[3] + (item.aim - s[3]) * ease; });
      edgeStarts.forEach(function (s) { s[0].o = s[1] + (s[0].aim - s[1]) * ease; });
      positionAll();
      if (t < 1) { animation = global.requestAnimationFrame(frame); return; }
      animation = 0; size(plan.height);
      nodeMap.forEach(function (item) { if (!item.aim) { item.el.style.display = 'none'; item.x = null; } });
      edgeMap.forEach(function (item) { if (!item.aim) { item.el.style.display = 'none'; item.why.style.display = 'none'; } });
    }
    if (reducedMotion()) frame(0); else animation = global.requestAnimationFrame(frame);
  }
  function go(node) {
    trail.push({ path: graph.centre.path, title: graph.centre.title || graph.centre.slug });
    if (trail.length > 4) trail.shift();
    viaPicture = true; early = { path: node.path, answer: ask(node.path) }; early.answer.catch(function () { /* refresh reports it */ });
    open(node);
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
  // A piece tapped in the picture asks for its connections at once, while the article itself opens.
  var early = null;
  function ask(path) {
    return global.fetch(C.endpoints.api('graph?path=') + encodeURIComponent(path), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw Error('links unavailable'); return response.json(); });
  }
  function refresh() {
    if (!mounted || !founder()) return Promise.resolve();
    var path = current(), request = ++epoch;
    if (path !== article) { article = path; savedCaret = null; if (list) list.textContent = ''; if (!viaPicture) trail = []; viaPicture = false; }
    if (!/^articles\/[^/]+\/article\.md$/.test(path)) {
      graph = null; if (picture) picture.hidden = true;
      if (message) message.textContent = 'Open an article to see its connections.'; return Promise.resolve();
    }
    if ((!graph || graph.centre.path !== path) && message) message.textContent = 'Loading connections...';
    var asked = early && early.path === path ? early.answer : ask(path); early = null;
    return asked
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
    svg = null; plan = null; nodeMap.clear(); edgeMap.clear(); chooseView(view); if (graph) paint(); else refresh();
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
        // The picture: the website's drawing (graph A) in Descant's ink, paper and green.
        '.links-picture{margin-top:.4rem}.links-graph{display:block;max-width:100%;height:auto;margin:0 auto;overflow:visible;-webkit-tap-highlight-color:transparent}' +
        '.links-graph text{-webkit-user-select:none;user-select:none}.links-node{cursor:pointer;outline:none}.links-node[aria-disabled="true"]{cursor:default}' +
        '.links-hit{fill:transparent}.links-shape{fill:var(--ink);transition:transform .35s cubic-bezier(.22,.9,.25,1)}' +
        '.links-node.is-lit .links-shape,.links-node:focus-visible .links-shape{transform:scale(1.28)}.links-focus{fill:none;stroke:none}.links-node:focus-visible .links-focus{stroke:var(--ink);stroke-width:2}' +
        '.links-label,.links-why{font-family:var(--font-ui-heading,Newsreader,Georgia,serif);paint-order:stroke;stroke:var(--links-ground);stroke-width:4px;stroke-linejoin:round}' +
        '.links-plate{fill:var(--links-ground)}.links-label{font-size:13px;font-weight:600;fill:var(--ink)}.links-label.is-centre{font-size:17px}.links-label.is-small{font-size:12px;font-weight:500;fill:var(--ink-2)}' +
        '.castor-links{--links-ground:var(--surface,var(--paper))}' +
        '.links-line{fill:none;stroke:var(--ink);stroke-opacity:.42;stroke-width:1.3;transition:stroke-opacity .3s cubic-bezier(.22,.9,.25,1),stroke-width .3s cubic-bezier(.22,.9,.25,1)}' +
        '.links-line.is-tag{stroke:var(--ink-3);stroke-opacity:.45;stroke-width:1}.links-head{fill:var(--ink);fill-opacity:.55}' +
        '.links-edge.is-lit .links-line{stroke-opacity:.95;stroke-width:2.2}.links-edge.is-lit .links-line.is-tag{stroke-width:1.6}.links-edge.is-lit .links-head{fill-opacity:.95}' +
        '.links-line-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke}' +
        '.links-why{font-size:12.5px;font-style:italic;fill:var(--ink);opacity:0;pointer-events:none;transition:opacity .3s cubic-bezier(.22,.9,.25,1)}.links-why.is-lit{opacity:1}' +
        '.links-here-ring{fill:none;stroke:var(--rule);stroke-width:1}.links-here-dot{fill:var(--between,#667D2F)}' +
        '.links-here-orbit{animation:links-orbit 14s linear infinite}@keyframes links-orbit{to{transform:rotate(360deg)}}' +
        '.links-node,.links-edge{transition:opacity .3s cubic-bezier(.22,.9,.25,1)}' +
        '.links-trail{margin:.4rem 0 0;color:var(--ink-2);font-size:.85rem;line-height:1.4;overflow-wrap:anywhere}.links-trail-here{color:var(--ink)}' +
        '.castor-links .links-back{min-height:44px;padding:0;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:.2rem}' +
        '.links-key{display:flex;flex-wrap:wrap;gap:.35rem 1rem;list-style:none;margin:.8rem 0 0;padding:0;font-size:12px;line-height:1.4;color:var(--ink-2)}' +
        '.links-key li{display:flex;align-items:center;gap:.4rem}.links-key svg{flex:none;overflow:visible}' +
        '.links-empty{margin:.6rem 0 0;color:var(--ink-2);line-height:1.5}' +
        '@media(prefers-reduced-motion:reduce){.links-here-orbit{animation:none}.links-node,.links-edge,.links-shape,.links-line,.links-why{transition:none}}');
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
  C.links = { mount: mount, refresh: refresh, groups: groups, insert: insert, layout: layout };
})(typeof window !== 'undefined' ? window : globalThis);
