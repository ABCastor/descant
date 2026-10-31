/* files.js: the piece's real folder, its beside-reading pane, and Drafts.
 *
 * Files is a tree, not a styled list of paths. Served actions go only through the
 * sandboxed /api/files routes; file:// actions stay in localStorage and say so.
 * Loose root files are grouped by what they are; real folders keep their tree.
 * The canvas file appears among
 * Documents; its text and link cards never become a scatter of tiny files.
 */
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});
  var DOC = global.document;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var MIME_FILE = 'application/x-castor-file';
  var MIME_CARD = 'application/x-castor-card';
  var RESOURCE_GROUPS = [
    { id: 'images', label: 'Images' },
    { id: 'documents', label: 'Documents' },
    { id: 'other', label: 'Other' }
  ];

  var S = {
    data: null, page: null, besideBody: null, filesBody: null,
    target: null, entries: [], order: {}, folded: {}, dragPath: null,
    canvas: null, canvasStamp: '', status: '', mounted: false
  };

  function bus() { return Castor.bus; }
  function on(name, fn) {
    if (bus() && bus().on) bus().on(name, fn);
    else DOC.addEventListener(name, fn);
  }
  function el(tag, cls, text) {
    var n = DOC.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(tag, parent, attrs) {
    var n = DOC.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { n.setAttribute(key, attrs[key]); });
    if (parent) parent.appendChild(n);
    return n;
  }
  function data() { return S.data || (Castor.app && Castor.app.data) || {}; }
  function sources() { return data().pieceSources || {}; }
  function world() { return data().world || (Castor.app && Castor.app.world) || 'dev'; }
  function piece() { return data().piece || {}; }
  function pieceFolder() { return String(piece().folder || '').replace(/^\/+|\/+$/g, ''); }
  function served() { return /^https?:$/.test(global.location && global.location.protocol || ''); }
  function storeKey() { return 'castor.' + world() + '.files'; }
  function canvasKey() { return 'castor.' + world() + '.canvas.' + pieceFolder(); }

  function baseName(path) { return String(path || '').split('/').pop() || ''; }
  function parentOf(path) {
    var parts = String(path || '').split('/');
    parts.pop();
    return parts.join('/');
  }
  function cleanPath(path) {
    var value = String(path || '').replace(/^\/+|\/+$/g, '');
    if (!value || value.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) return '';
    return value;
  }
  function relativePath(path) {
    var value = String(path || '').replace(/^\/+/, '');
    var folder = pieceFolder();
    if (folder && value.indexOf(folder + '/') === 0) value = value.slice(folder.length + 1);
    return cleanPath(value);
  }
  function kindFrom(path, mime) {
    var ext = baseName(path).toLowerCase().split('.').pop();
    if (/^image\//.test(mime || '') || /^(svg|png|jpe?g|gif|webp|avif)$/.test(ext)) return 'image';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'md' || ext === 'txt') return 'markdown';
    if (ext === 'canvas') return 'canvas';
    return 'file';
  }
  function resourceGroup(entry) {
    var preview = entry.preview || kindFrom(entry.path, entry.type);
    if (preview === 'image') return 'images';
    if (preview === 'markdown' || preview === 'pdf' || preview === 'canvas') return 'documents';
    return 'other';
  }
  function mimeFrom(path) {
    var ext = baseName(path).toLowerCase().split('.').pop();
    return ({
      svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', pdf: 'application/pdf',
      md: 'text/markdown', txt: 'text/plain', canvas: 'application/json'
    })[ext] || 'application/octet-stream';
  }

  function normaliseEntries() {
    var p = piece(), supplied = Array.isArray(p.fileEntries) ? p.fileEntries : [];
    var files = supplied.length ? supplied : (p.files || []).map(function (path) { return { path: path }; });
    var out = [], seen = {};

    function add(entry) {
      var path = relativePath(entry.path);
      if (!path || seen[path]) return;
      seen[path] = true;
      var copy = {};
      Object.keys(entry).forEach(function (key) { copy[key] = entry[key]; });
      copy.path = path;
      copy.sourcePath = entry.sourcePath || path;
      copy.kind = entry.kind === 'folder' ? 'folder' : 'file';
      copy.type = copy.type || mimeFrom(path);
      copy.preview = copy.preview || kindFrom(path, copy.type);
      out.push(copy);
    }

    files.forEach(function (entry) { add(typeof entry === 'string' ? { path: entry } : entry); });
    out.slice().forEach(function (entry) {
      var parent = parentOf(entry.path);
      while (parent) {
        add({ path: parent, kind: 'folder', sourcePath: parent });
        parent = parentOf(parent);
      }
    });
    return out;
  }

  function restoreArrangement(base) {
    if (served()) {
      S.order = {};
      Object.keys(piece().fileOrder || {}).forEach(function (folder) {
        S.order[folder] = piece().fileOrder[folder].map(function (name) { return folder ? folder + '/' + name : name; });
      });
      return base;
    }
    var raw = null, saved = null;
    try { raw = global.localStorage.getItem(storeKey()); } catch (e) { raw = null; }
    if (raw) { try { saved = JSON.parse(raw); } catch (e2) { saved = null; } }
    if (!saved || saved.piece !== pieceFolder() || !Array.isArray(saved.entries)) return base;

    var bySource = {};
    base.forEach(function (entry) { bySource[entry.sourcePath || entry.path] = entry; });
    var used = {}, restored = [];
    saved.entries.forEach(function (held) {
      var original = bySource[held.sourcePath || held.path];
      if (held.kind !== 'folder' && !original) return;
      var copy = {};
      Object.keys(original || {}).forEach(function (key) { copy[key] = original[key]; });
      copy.path = cleanPath(held.path);
      copy.kind = held.kind;
      copy.sourcePath = held.sourcePath || (original && original.sourcePath) || held.path;
      if (!copy.path) return;
      restored.push(copy);
      used[copy.sourcePath] = true;
    });
    base.forEach(function (entry) { if (!used[entry.sourcePath || entry.path]) restored.push(entry); });
    S.order = saved.order || {};
    S.folded = saved.folded || {};
    return restored;
  }

  function persist() {
    var state = {
      piece: pieceFolder(), order: S.order, folded: S.folded,
      entries: S.entries.map(function (entry) {
        return { path: entry.path, kind: entry.kind, sourcePath: entry.sourcePath || entry.path };
      })
    };
    try { global.localStorage.setItem(storeKey(), JSON.stringify(state)); } catch (e) { /* blocked or full */ }
  }

  function entryAt(path) {
    return S.entries.filter(function (entry) { return entry.path === path; })[0] || null;
  }
  function articleEntry() {
    var exact = entryAt('article.md');
    if (exact) return exact;
    return S.entries.filter(function (entry) {
      return entry.kind !== 'folder' && parentOf(entry.path) === '' && /\.md$/i.test(entry.path);
    })[0] || null;
  }
  function inMaterials(entry) {
    return entry.path === 'materials' || entry.path.indexOf('materials/') === 0;
  }
  function groupEntries(group) {
    var article = articleEntry();
    var rows = S.entries.filter(function (entry) {
      if (entry.path === '.order' || /^\.order-/.test(entry.path)) return false;
      if (article && entry.path === article.path) return false;
      if (entry.kind === 'folder' || parentOf(entry.path)) return false;
      return resourceGroup(entry) === group;
    });
    var explicit = S.order['@' + group] || [];
    return rows.sort(function (a, b) {
      var ai = explicit.indexOf(a.path), bi = explicit.indexOf(b.path);
      if (ai >= 0 || bi >= 0) {
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      }
      if (parentOf(a.path) === parentOf(b.path)) {
        var siblings = S.order[parentOf(a.path)] || [];
        ai = siblings.indexOf(a.path); bi = siblings.indexOf(b.path);
        if (ai >= 0 || bi >= 0) {
          if (ai < 0) return 1;
          if (bi < 0) return -1;
          return ai - bi;
        }
      }
      return baseName(a.path).localeCompare(baseName(b.path));
    });
  }
  function childrenOf(folder) {
    var list = S.entries.filter(function (entry) { return parentOf(entry.path) === folder; });
    var explicit = S.order[folder] || [];
    function defaultWeight(entry) {
      if (!folder && entry.path === 'article.md') return 0;
      if (!folder && entry.kind === 'folder' && entry.path === 'materials') return 1;
      if (!folder && entry.kind === 'folder' && entry.path === 'attachments') return 2;
      if (!folder && entry.kind === 'folder') return 3;
      if (entry.kind === 'folder') return 4;
      return 5;
    }
    return list.sort(function (a, b) {
      var ai = explicit.indexOf(a.path), bi = explicit.indexOf(b.path);
      if (ai >= 0 || bi >= 0) {
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      }
      var aw = defaultWeight(a), bw = defaultWeight(b);
      return aw === bw ? baseName(a.path).localeCompare(baseName(b.path)) : aw - bw;
    });
  }

  function formatSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return 'size unknown';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function markSvg(preview) {
    var span = el('span', 'files-thumb files-thumb-' + preview);
    span.setAttribute('aria-hidden', 'true');
    var svg = svgEl('svg', span, { viewBox: '0 0 28 28', fill: 'none', focusable: 'false' });
    var stroke = { stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    function path(d) { var attrs = Object.assign({ d: d }, stroke); return svgEl('path', svg, attrs); }
    if (preview === 'canvas') {
      path('M5 7.5h5v4H5zM18 16.5h5v4h-5zM10 9.5c5 0 3 9 8 9');
      svgEl('circle', svg, Object.assign({ cx: '14', cy: '14', r: '1.75' }, stroke));
    } else {
      path('M7 3.5h9l5 5v16H7zM16 3.5v5h5');
      if (preview === 'pdf') path('M10 18c2-5 4-5 7 1M10 20.5h8');
      else if (preview === 'image') path('M10 19l3-3 2.5 2 2.5-3 1.5 2M11 11.5h.01');
      else path('M10 12h8M10 16h8M10 20h5');
    }
    return span;
  }

  function fileUrl(entry) {
    if (entry.url) return entry.url;
    if (!served() || entry.kind === 'folder') return '';
    var folder = pieceFolder();
    if (folder.indexOf('design/app/') === 0) return '/' + folder.slice('design/app/'.length) + '/' + entry.path;
    return '/api/files/content?piece=' + encodeURIComponent(folder) + '&path=' + encodeURIComponent(entry.path);
  }

  function thumbnail(entry) {
    var source = entry.thumbnail || (entry.preview === 'image' ? fileUrl(entry) : '');
    if (source && entry.preview === 'image') {
      var frame = el('span', 'files-thumb files-thumb-image');
      frame.setAttribute('aria-hidden', 'true');
      var img = el('img');
      img.alt = '';
      img.draggable = false;
      img.src = source;
      frame.appendChild(img);
      return frame;
    }
    return markSvg(entry.preview || kindFrom(entry.path, entry.type));
  }

  function tooltip(entry) {
    var parts = [formatSize(entry.size)];
    if (entry.date) parts.push(entry.date);
    return parts.join(' · ');
  }

  function dragPayload(entry) {
    var payload = {
      path: entry.path, name: baseName(entry.path),
      type: entry.kind === 'folder' ? 'folder' : (entry.type || mimeFrom(entry.path)),
      group: entry.kind === 'folder' ? '' : resourceGroup(entry)
    };
    if (entry.thumbnail && /^data:/.test(entry.thumbnail)) payload.dataUrl = entry.thumbnail;
    var url = fileUrl(entry);
    if (url) payload.url = url;
    return payload;
  }

  function onDragStart(event, entry) {
    var dt = event.dataTransfer;
    if (!dt) return;
    S.dragPath = entry.path;
    dt.effectAllowed = 'copyMove';
    dt.setData(MIME_FILE, JSON.stringify(dragPayload(entry)));
    dt.setData('text/plain', '[[' + entry.path + ']]');
    event.currentTarget.classList.add('is-dragging');
  }
  function onDragEnd(event) {
    event.currentTarget.classList.remove('is-dragging');
    if (S.filesBody) S.filesBody.querySelectorAll('.is-drop-target').forEach(function (n) { n.classList.remove('is-drop-target'); });
    global.setTimeout(function () { S.dragPath = null; }, 0);
  }

  function setStatus(message) {
    S.status = message || '';
    var line = S.filesBody && S.filesBody.querySelector('.files-status');
    if (line) line.textContent = S.status;
  }

  function postFileRoute(route, body) {
    if (!served()) return Promise.resolve({ saved: false, local: true });
    body.who = Castor.who && (Castor.who.session ? Castor.who.session().map(function (person) { return person.id || { name: person.name, email: person.email }; }) : Castor.who.get && Castor.who.get());
    return global.fetch('/api/files/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.error || ('The server returned ' + response.status));
        return payload;
      });
    });
  }

  function hasTransfer(dt, type) {
    return !!(dt && dt.types && Array.prototype.indexOf.call(dt.types, type) >= 0);
  }

  function readCard(dt) {
    if (!hasTransfer(dt, MIME_CARD)) return null;
    try { return JSON.parse(dt.getData(MIME_CARD) || '{}'); }
    catch (e) { return null; }
  }

  function putEntry(value) {
    value = value && value.entry ? value.entry : value;
    if (!value || !value.path) return null;
    var path = relativePath(value.path);
    if (!path) return null;
    var entry = entryAt(path);
    if (!entry) {
      entry = { path: path, sourcePath: path, kind: 'file' };
      S.entries.push(entry);
    }
    Object.keys(value).forEach(function (key) { if (key !== 'path') entry[key] = value[key]; });
    entry.path = path;
    entry.sourcePath = entry.sourcePath || path;
    entry.kind = value.kind === 'folder' ? 'folder' : 'file';
    entry.type = entry.type || mimeFrom(path);
    entry.preview = entry.preview || kindFrom(path, entry.type);
    var parent = parentOf(path);
    while (parent) {
      if (!entryAt(parent)) S.entries.push({ path: parent, sourcePath: parent, kind: 'folder', type: 'folder', preview: 'folder' });
      parent = parentOf(parent);
    }
    persist();
    renderFiles();
    return entry;
  }

  function ensureCanvasEntry() {
    if (entryAt('workspace.canvas')) return entryAt('workspace.canvas');
    return putEntry({
      path: 'workspace.canvas', kind: 'file', type: 'application/json', preview: 'canvas',
      size: null, date: new Date().toISOString().slice(0, 10)
    });
  }

  function saveCanvasCard() {
    var canvas = Castor.canvas && Castor.canvas.instance;
    var saving = canvas && typeof canvas.save === 'function' ? canvas.save() : null;
    setStatus(served() ? 'Saving workspace in Git.' : 'Saving this browser\'s workspace canvas.');
    if (saving && typeof saving.then === 'function') saving.then(function (payload) {
      if (served() && (!payload || !payload.saved)) { setStatus('Workspace is still unsaved.'); return; }
      ensureCanvasEntry();
      setStatus(served() ? 'Saved in workspace.canvas in Git.' : 'Saved in this browser\'s workspace canvas.');
    }).catch(function (error) { setStatus(error.message); });
    else setStatus('Open Workspace before saving it.');
  }

  function uploadCard(payload, group) {
    if (!payload.dataUrl) {
      setStatus('This card has no file data to save.');
      return;
    }
    postFileRoute('upload', {
      piece: pieceFolder(), name: payload.name || payload.text || 'resource',
      data: payload.dataUrl, group: group || payload.group || ''
    }).then(function (saved) {
      putEntry(saved);
      setStatus(served() ? 'Saved in Git.' : 'Saved in this browser.');
    }).catch(function (error) { setStatus(error.message); });
  }

  function applyMove(source, destination) {
    var moving = entryAt(source);
    if (!moving) return;
    var from = source + '/', to = destination + '/';
    S.entries.forEach(function (entry) {
      if (entry.path === source) entry.path = destination;
      else if (moving.kind === 'folder' && entry.path.indexOf(from) === 0) entry.path = to + entry.path.slice(from.length);
    });
    var nextOrder = {};
    Object.keys(S.order).forEach(function (folder) {
      var nextFolder = folder === source ? destination
        : (moving.kind === 'folder' && folder.indexOf(from) === 0 ? to + folder.slice(from.length) : folder);
      nextOrder[nextFolder] = (S.order[folder] || []).map(function (path) {
        if (path === source) return destination;
        if (moving.kind === 'folder' && path.indexOf(from) === 0) return to + path.slice(from.length);
        return path;
      });
    });
    S.order = nextOrder;
    var nextFolded = {};
    Object.keys(S.folded).forEach(function (path) {
      var nextPath = path === source ? destination
        : (moving.kind === 'folder' && path.indexOf(from) === 0 ? to + path.slice(from.length) : path);
      nextFolded[nextPath] = S.folded[path];
    });
    S.folded = nextFolded;
    persist();
    renderFiles();
  }

  function moveInto(source, folder) {
    var moving = entryAt(source);
    if (!moving || source === folder || (moving.kind === 'folder' && folder.indexOf(source + '/') === 0)) return;
    var destination = cleanPath((folder ? folder + '/' : '') + baseName(source));
    if (!destination || destination === source || entryAt(destination)) {
      setStatus('That name already exists in this folder.');
      return;
    }
    var body = { piece: pieceFolder(), source: source, destination: destination };
    postFileRoute('move', body).then(function () {
      applyMove(source, destination);
      setStatus(served() ? 'Moved in Git.' : 'Moved in this browser.');
    }).catch(function (error) { setStatus(error.message); });
  }

  function moveIntoGroup(source, group) {
    var moving = entryAt(source);
    if (!moving || moving.kind === 'folder') return;
    if (resourceGroup(moving) !== group) {
      setStatus('That file belongs in ' + RESOURCE_GROUPS.filter(function (g) { return g.id === resourceGroup(moving); })[0].label + '.');
      return;
    }
    if (parentOf(source).toLowerCase() === group) {
      setStatus('Already in ' + group + '.');
      return;
    }
    postFileRoute('move', { piece: pieceFolder(), source: source, group: group }).then(function (saved) {
      var destination = relativePath(saved.path);
      if (destination && destination !== source) applyMove(source, destination);
      setStatus(served() ? 'Moved into ' + group + ' in Git.' : 'Moved into ' + group + ' in this browser.');
    }).catch(function (error) { setStatus(error.message); });
  }

  function receiveCard(payload, group) {
    if (!payload) return;
    var real = payload.type === 'image' || payload.type === 'file' || !!payload.path || !!payload.dataUrl;
    if (!real) { saveCanvasCard(); return; }
    if (payload.path && entryAt(relativePath(payload.path))) {
      var path = relativePath(payload.path);
      if (group) moveIntoGroup(path, group);
      else setStatus('That file is already in this piece.');
      return;
    }
    uploadCard(payload, group);
  }

  function reorder(source, target, after) {
    var folder = parentOf(source);
    if (source === target || folder !== parentOf(target)) return;
    var order = childrenOf(folder).map(function (entry) { return entry.path; });
    order.splice(order.indexOf(source), 1);
    var at = Math.max(0, order.indexOf(target));
    order.splice(at + (after ? 1 : 0), 0, source);
    postFileRoute('order', {
      piece: pieceFolder(), folder: folder,
      order: order.map(function (path) { return baseName(path); })
    }).then(function () {
      S.order[folder] = order;
      persist();
      renderFiles();
      setStatus(served() ? 'Order saved in Git.' : 'Order saved in this browser.');
    }).catch(function (error) { setStatus(error.message); });
  }

  function wireDrop(row, entry, opts) {
    opts = opts || {};
    row.addEventListener('dragover', function (event) {
      var card = hasTransfer(event.dataTransfer, MIME_CARD);
      if (!card && (!S.dragPath || S.dragPath === entry.path)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = card ? 'copy' : 'move';
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', function () { row.classList.remove('is-drop-target'); });
    row.addEventListener('drop', function (event) {
      var card = readCard(event.dataTransfer);
      if (!card && !S.dragPath) return;
      event.preventDefault(); event.stopPropagation();
      row.classList.remove('is-drop-target');
      if (card) { receiveCard(card, opts.group || ''); return; }
      if (opts.group && entry.path.indexOf('@group-') === 0) moveIntoGroup(S.dragPath, opts.group);
      else if (entry.kind === 'folder' || opts.root) moveInto(S.dragPath, opts.root ? '' : entry.path);
      else {
        var rect = row.getBoundingClientRect();
        reorder(S.dragPath, entry.path, event.clientY > rect.top + rect.height / 2);
      }
    });
  }

  function fileRow(entry, depth, opts) {
    opts = opts || {};
    var row = el('button', 'files-row files-tree-item' + (entry.kind === 'folder' ? ' files-folder-row' : ''));
    row.type = 'button';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth));
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;
    if (opts.root) row.classList.add('files-folder');
    row.tabIndex = -1;
    row.draggable = !opts.readOnly && !opts.virtual && entry.path !== '';
    if (opts.group) row.dataset.group = opts.group;

    var branch = el('i', 'files-branch');
    branch.setAttribute('aria-hidden', 'true');
    row.appendChild(branch);
    if (entry.kind !== 'folder') row.appendChild(thumbnail(entry));
    else row.appendChild(el('span', 'files-thumb files-thumb-folder'));
    row.appendChild(el('span', 'files-name', opts.label || baseName(entry.path)));
    if (entry.kind === 'folder') {
      row.setAttribute('aria-expanded', String(!S.folded[entry.path]));
    } else {
      var kind = baseName(entry.path).indexOf('.') >= 0 ? baseName(entry.path).split('.').pop().toLowerCase() : 'file';
      row.appendChild(el('span', 'files-kind', kind));
      row.title = tooltip(entry);
      row.setAttribute('aria-label', (opts.label || baseName(entry.path)) + ', ' + tooltip(entry));
    }

    if (!opts.readOnly) {
      row.addEventListener('dragstart', function (event) { onDragStart(event, entry); });
      row.addEventListener('dragend', onDragEnd);
      wireDrop(row, entry, opts);
    } else if (opts.dropTarget) {
      wireDrop(row, entry, opts);
    }

    row.addEventListener('click', function () {
      if (entry.kind === 'folder') {
        S.folded[entry.path] = !S.folded[entry.path];
        persist(); renderFiles(entry.path);
      } else if (opts.otherPiece && opts.articlePath && Castor.pieces && Castor.pieces.open) {
        Castor.pieces.open(opts.articlePath);
      } else if (/\.md$/i.test(entry.path) || opts.otherPiece) {
        openBeside(opts.openTarget || entry.path);
      }
    });
    return row;
  }

  function folderNode(entry, depth, opts) {
    opts = opts || {};
    var node = el('div', 'files-node');
    node.dataset.entryPath = entry.path;
    node.appendChild(fileRow(entry, depth, opts));
    if (!S.folded[entry.path]) {
      var children = opts.children || childrenOf(entry.path);
      if (children.length) {
        var group = el('div', 'files-tree-group');
        group.setAttribute('role', 'group');
        children.forEach(function (child) {
          group.appendChild(child.kind === 'folder' ? folderNode(child, depth + 1) : fileRow(child, depth + 1));
        });
        node.appendChild(group);
      }
    }
    return node;
  }

  function resourceNode(def, children, depth) {
    var entry = { path: '@group-' + def.id, kind: 'folder', type: 'folder', preview: 'folder' };
    var node = el('div', 'files-node files-resource-group');
    node.dataset.group = def.id;
    node.appendChild(fileRow(entry, depth, {
      readOnly: true, virtual: true, dropTarget: true, group: def.id, label: def.label
    }));
    if (!S.folded[entry.path]) {
      var group = el('div', 'files-tree-group');
      group.setAttribute('role', 'group');
      children.forEach(function (child) {
        if (child.kind === 'folder') group.appendChild(folderNode(child, depth + 1));
        else group.appendChild(fileRow(child, depth + 1, { group: def.id }));
      });
      node.appendChild(group);
    }
    return node;
  }

  function rowsIn(tree) {
    return tree ? Array.prototype.slice.call(tree.querySelectorAll('.files-tree-item')).filter(function (row) {
      return row.getClientRects().length && global.getComputedStyle(row).display !== 'none';
    }) : [];
  }
  function visibleRows() {
    return rowsIn(S.filesBody && S.filesBody.querySelector('.files-tree'));
  }
  function focusRow(row) {
    if (!row) return;
    rowsIn(row.closest('[role="tree"]')).forEach(function (candidate) { candidate.tabIndex = candidate === row ? 0 : -1; });
    row.focus();
  }
  function rowFor(path) {
    return visibleRows().filter(function (row) { return row.dataset.path === path; })[0] || null;
  }
  function onTreeKey(event) {
    var row = event.target && event.target.closest && event.target.closest('.files-tree-item');
    if (!row) return;
    var rows = rowsIn(row.closest('[role="tree"]')), at = rows.indexOf(row), path = row.dataset.path;
    var entry = (path === '' || path === '@other-pieces' || path.indexOf('@group-') === 0)
      ? { path: path, kind: 'folder' } : entryAt(path);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (event.key === 'Home') focusRow(rows[0]);
      else if (event.key === 'End') focusRow(rows[rows.length - 1]);
      else focusRow(rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]);
      return;
    }
    if (!entry || entry.kind !== 'folder') return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (S.folded[path]) { S.folded[path] = false; persist(); renderFiles(path); }
      else if (rows[at + 1]) focusRow(rows[at + 1]);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (!S.folded[path]) { S.folded[path] = true; persist(); renderFiles(path); }
      else focusRow(rowFor(parentOf(path)));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); row.click();
    }
  }

  function renderNewFolder(parent) {
    var area = el('div', 'files-new-area');
    var word = el('button', 'files-new-folder', 'New folder');
    word.type = 'button';
    area.appendChild(word);
    word.addEventListener('click', function () {
      word.hidden = true;
      var form = el('form', 'files-new-form');
      var input = el('input', 'files-new-input');
      input.type = 'text'; input.maxLength = 80; input.placeholder = 'Folder name';
      input.setAttribute('aria-label', 'New folder name');
      var create = el('button', 'files-new-create', 'Create'); create.type = 'submit';
      var cancel = el('button', 'files-new-cancel', 'Cancel'); cancel.type = 'button';
      form.appendChild(input); form.appendChild(create); form.appendChild(cancel);
      area.appendChild(form); input.focus();
      cancel.addEventListener('click', function () { form.remove(); word.hidden = false; word.focus(); });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var name = input.value.trim();
        if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) {
          setStatus('Use a folder name without slashes.'); input.focus(); return;
        }
        var path = cleanPath((parent ? parent + '/' : '') + name);
        if (entryAt(path)) { setStatus('That folder already exists.'); input.focus(); return; }
        postFileRoute('mkdir', { piece: pieceFolder(), parent: parent, name: name }).then(function () {
          S.entries.push({ path: path, sourcePath: path, kind: 'folder', type: 'folder', preview: 'folder' });
          S.folded[path] = false;
          persist(); renderFiles(path);
          setStatus(served() ? 'Folder created in Git.' : 'Folder created in this browser.');
        }).catch(function (error) { setStatus(error.message); });
      });
    });
    return area;
  }

  function readCanvas(value) {
    var json = value && value.detail !== undefined ? value.detail : value;
    if (typeof json === 'string') { try { json = JSON.parse(json); } catch (e) { return; } }
    if (!json || !Array.isArray(json.nodes)) return;
    var stamp = '';
    try { stamp = JSON.stringify(json); } catch (e2) { stamp = String(Date.now()); }
    if (stamp === S.canvasStamp) return;
    S.canvasStamp = stamp;
    S.canvas = json;
    var extra = json['x-castor'] || {};
    if ((json.nodes && json.nodes.length) || (extra.strokes && extra.strokes.length)) ensureCanvasEntry();
  }

  function readCanvasStore() {
    var raw = null;
    try { raw = global.localStorage.getItem(canvasKey()); } catch (e) { raw = null; }
    if (raw) { try { var held = JSON.parse(raw); readCanvas(held.canvas || held); } catch (error) { /* invalid cache */ } }
    else if (data().canvas) readCanvas(data().canvas);
  }

  function mountFiles(body) {
    S.filesBody = body;
    renderFiles();
    readCanvasStore();
  }

  function renderFiles(focusPath) {
    var body = S.filesBody;
    if (!body) return;
    var active = DOC.activeElement;
    var hadFocus = body.contains(active);
    var activeRow = hadFocus && active.closest && active.closest('.files-tree-item');
    var wantedPath = focusPath || (activeRow && activeRow.dataset.path);
    body.textContent = '';

    var tree = el('div', 'files-tree');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', 'Piece files');
    tree.addEventListener('keydown', onTreeKey);

    var rootName = baseName(pieceFolder()) || piece().title || 'This piece';
    var root = { path: '', kind: 'folder', type: 'folder', preview: 'folder' };
    var rootNode = el('div', 'files-node files-piece-root');
    rootNode.appendChild(fileRow(root, 1, { root: true, label: rootName }));
    if (!S.folded['']) {
      var rootGroup = el('div', 'files-tree-group');
      rootGroup.setAttribute('role', 'group');
      var article = articleEntry();
      if (article) rootGroup.appendChild(fileRow(article, 2, { label: piece().title || baseName(article.path) }));
      var materials = entryAt('materials');
      if (materials) rootGroup.appendChild(folderNode(materials, 2, { label: 'Materials' }));
      childrenOf('').forEach(function (entry) {
        if (entry.kind === 'folder' && !inMaterials(entry)) rootGroup.appendChild(folderNode(entry, 2));
      });
      RESOURCE_GROUPS.forEach(function (def) {
        var entries = groupEntries(def.id);
        if (entries.length) rootGroup.appendChild(resourceNode(def, entries, 2));
      });
      rootNode.appendChild(rootGroup);
    }
    tree.appendChild(rootNode);

    var articleList = Castor.pieces && Castor.pieces.list ? Castor.pieces.list() : [];
    var currentPath = Castor.pieces && Castor.pieces.current ? Castor.pieces.current() : (pieceFolder() ? pieceFolder() + '/article.md' : '');
    var others = (articleList.length ? articleList : (data().pieces || []).map(function (name) { return { title: name }; }))
      .filter(function (article) { return article.title && (!article.path || article.path !== currentPath); });
    if (others.length) {
      var otherEntry = { path: '@other-pieces', kind: 'folder', type: 'folder', preview: 'folder' };
      var otherChildren = others.map(function (article) {
        return { path: '@other-pieces/' + (article.path || article.title + '.md'), kind: 'file', type: 'text/markdown', preview: 'markdown', otherName: article.title, articlePath: article.path };
      });
      var otherNode = el('div', 'files-node files-other-pieces');
      var otherRow = fileRow(otherEntry, 1, { readOnly: true, label: 'Articles' });
      otherRow.setAttribute('aria-expanded', String(!S.folded[otherEntry.path]));
      otherNode.appendChild(otherRow);
      if (!S.folded[otherEntry.path]) {
        var otherGroup = el('div', 'files-tree-group'); otherGroup.setAttribute('role', 'group');
        otherChildren.forEach(function (entry) {
          otherGroup.appendChild(fileRow(entry, 2, { readOnly: true, otherPiece: true, articlePath: entry.articlePath, openTarget: entry.otherName, label: entry.otherName }));
        });
        otherNode.appendChild(otherGroup);
      }
      tree.appendChild(otherNode);
    }
    body.appendChild(tree);
    body.appendChild(renderNewFolder(''));

    var note = el('p', 'files-mode-note', served()
      ? 'Changes happen in a sandbox copy of this piece.'
      : 'Changes stay in this browser until you open this page through serve.py.');
    body.appendChild(note);
    body.appendChild(el('p', 'files-status', S.status));
    var rows = visibleRows();
    var chosen = wantedPath && rowFor(wantedPath);
    var first = chosen || rows[0];
    if (first) first.tabIndex = 0;
    if (chosen && hadFocus) focusRow(chosen);
  }

  /* A wiki target can carry a heading and can be written with or without .md. */
  function baseOf(target) { return String(target || '').split('#')[0].trim(); }
  function normal(value) { return String(value || '').toLowerCase().replace(/\.md$/, '').replace(/^.*\//, '').trim(); }
  function pathOf(target) {
    var name = baseOf(target), piece = (data().piece && data().piece.folder) || '';
    var files = (data().piece && data().piece.files) || [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i], path = f && (f.path || f);
      if (path && baseOf(path) === name) return path.indexOf('/') >= 0 ? path : (piece ? piece + '/' + path : path);
    }
    return piece ? piece + '/' + name : name;
  }

  function sourceFor(target) {
    var src = sources(), base = baseOf(target);
    if (Object.prototype.hasOwnProperty.call(src, base)) return src[base];
    var keys = Object.keys(src), wanted = normal(base);
    for (var i = 0; i < keys.length; i++) if (normal(keys[i]) === wanted) return src[keys[i]];
    return null;
  }

  function mountBeside(body) { S.besideBody = body; renderBeside(); }
  function headingId(target) {
    var hash = String(target || '').split('#')[1];
    if (!hash) return null;
    if (Castor.md && Castor.md.slug) { try { return Castor.md.slug(hash); } catch (e) { /* below */ } }
    return hash.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function renderBeside() {
    var body = S.besideBody;
    if (!body) return;
    body.textContent = '';
    if (!S.target) {
      body.appendChild(el('p', 'beside-empty', 'Click a link in the piece, or a file, and it opens here beside the article.'));
      return;
    }
    var aside = S.articleAside;
    if (aside && aside.markdown == null) { body.appendChild(el('p', 'beside-empty', aside.error || 'Opening…')); return; }
    var src = aside ? aside.markdown : sourceFor(S.target);
    if (src == null) {
      var known = (data().piece && data().piece.files || []).some(function (f) {
        return baseOf(f && (f.path || f)) === baseOf(S.target);
      });
      if (!known) { body.appendChild(el('p', 'beside-empty', 'Not in this folder yet')); return; }
      body.appendChild(el('div', 'beside-name', baseOf(S.target)));
      var waiting = el('p', 'beside-empty', 'Opening\u2026');
      body.appendChild(waiting);
      /* Served, the folder is really there, so ask for it: the built file carries the
         pieces and not the working notes, but the app running over the repository can
         open anything in the piece's folder. Opened as a plain file, say so instead. */
      var served = /^https?:$/.test(global.location && global.location.protocol);
      if (!served) {
        waiting.textContent = 'This file opens beside the article when the app runs over the repository.';
        return;
      }
      var want = S.target;
      global.fetch('/api/piece?path=' + encodeURIComponent(pathOf(want)))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (payload) {
          if (S.target !== want) return;
          var text = payload && (payload.markdown || payload.source);
          if (text == null) { waiting.textContent = 'Not in this folder yet'; return; }
          sources()[baseOf(want)] = text;
          renderBeside();
        })
        .catch(function () { if (S.target === want) waiting.textContent = 'Not in this folder yet'; });
      return;
    }
    body.appendChild(el('div', 'beside-name', aside ? aside.title : baseOf(S.target)));
    var article = el('article', 'beside-page');
    if (Castor.md && Castor.md.parse) {
      var doc = Castor.md.parse(src);
      article.innerHTML = doc.blocks.map(function (block) {
        return block.html != null ? block.html : (Castor.md.blockToHtml ? Castor.md.blockToHtml(block) : '');
      }).filter(Boolean).join('\n');
    } else article.appendChild(el('pre', null, src));
    article.addEventListener('click', function (event) {
      var link = event.target && event.target.closest && event.target.closest('a.wikilink[data-target]');
      if (!link) return;
      event.preventDefault(); openBeside(link.getAttribute('data-target'));
    });
    body.appendChild(article);
    var id = headingId(S.target);
    if (id) {
      var heading = article.querySelector('#' + (global.CSS && CSS.escape ? CSS.escape(id) : id));
      if (heading && heading.scrollIntoView) heading.scrollIntoView({ block: 'start' });
    }
  }
  function openBeside(target) {
    S.articleAside = null;
    S.target = target || null;
    if (Castor.panels && Castor.panels.open) Castor.panels.open('beside', 'right');
    renderBeside();
    if (bus() && bus().emit) bus().emit('beside:open', S.target);
  }

  function openArticleBeside(path, title) {
    if (!/^articles\/[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\/article\.md$/.test(path || '')) return Promise.resolve(false);
    var held = { path: path, title: title || path, markdown: null };
    S.articleAside = held; S.target = path;
    if (Castor.panels && Castor.panels.open) Castor.panels.open('beside', 'right');
    if (Castor.pieces && Castor.pieces.current && Castor.pieces.current() === path && Castor.editor && Castor.editor.getCurrentSource) {
      held.markdown = Castor.editor.getCurrentSource(); renderBeside(); return Promise.resolve(true);
    }
    renderBeside();
    return global.fetch('/api/piece?path=' + encodeURIComponent(path)).then(function (r) {
      if (!r.ok) throw Error('This article could not be opened.');
      return r.json();
    }).then(function (payload) {
      if (S.articleAside !== held) return false;
      if (typeof payload.markdown !== 'string') throw Error('This article could not be opened.');
      held.markdown = payload.markdown; renderBeside(); return true;
    }).catch(function () { if (S.articleAside === held) { held.error = 'This article could not be opened.'; renderBeside(); } return false; });
  }

  function wirePage(page) {
    if (!page || page.dataset.besideWired) return;
    page.dataset.besideWired = '1';
    page.addEventListener('click', function (event) {
      var link = event.target && event.target.closest && event.target.closest('a.wikilink[data-target]');
      if (!link) return;
      event.preventDefault(); openBeside(link.getAttribute('data-target'));
    });
  }

  function mount(ctx) {
    ctx = ctx || {};
    S.data = ctx.data || (Castor.app && Castor.app.data) || {};
    S.page = ctx.page || DOC.getElementById('page');
    if (!S.mounted) S.entries = restoreArrangement(normaliseEntries());
    wirePage(S.page);
    if (Castor.panels && Castor.panels.register) {
      Castor.panels.register('files', { title: 'Files', mount: mountFiles });
      Castor.panels.register('beside', { title: 'Beside', mount: mountBeside });
      /* Drafts carries no mount here: panels.js owns the one truthful paragraph
         and refuses any replacement that does not declare ready:true, so a second
         copy of that sentence in this file would be dead text that never renders. */
      Castor.panels.register('drafts', { title: 'Drafts' });
    }
    if (Castor.commands && Castor.commands.register) {
      Castor.commands.register({
        id: 'beside.open', title: 'Open a piece beside this one', section: 'Go to',
        hint: 'read another piece next to the article',
        run: function () {
          var names = (data().pieces || []).concat((piece().files || []));
          if (!names.length) return;
          Castor.commands.openList({
            title: 'Open beside', items: names.map(function (name) { return { id: name, label: name }; }),
            onPick: function (item) { openBeside(item.id); }
          });
        }
      });
    }
    if (!S.mounted) {
      S.mounted = true;
      on('doc:change', function () { wirePage(S.page); });
      on('canvas:changed', readCanvas);
      on('piece:open', function () {
        S.entries = restoreArrangement(normaliseEntries());
        S.canvas = null; S.canvasStamp = '';
        readCanvasStore(); renderFiles();
      });
      on('files:stored', function (value) {
        var entry = value && value.detail !== undefined ? value.detail : value;
        putEntry(entry);
      });
      on('open:beside', function (value) {
        var detail = value && value.detail !== undefined ? value.detail : value;
        openBeside(detail && detail.target ? detail.target : detail);
      });
      global.addEventListener('storage', function (event) {
        if (event.key === null || event.key === canvasKey()) readCanvasStore();
      });
    }
    return api;
  }

  var api = {
    mount: mount, open: openBeside, openArticle: openArticleBeside,
    target: function () { return S.target; },
    render: renderFiles, mime: MIME_FILE, mimes: { file: MIME_FILE, card: MIME_CARD }, _state: S
  };
  Castor.files = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
