/* import.js: bring a Ulysses library or an Obsidian vault into Descant in one step.
 *
 * Read-only on the source: the page reads a picked folder or a .zip/.ulyz copy and
 * never writes back. Each sheet or note becomes one item (the article's words, tags,
 * goal, group, pictures, notes and passage comments); /api/import saves each item as
 * an article through the app's own commit path. The receipt names everything that
 * came in, what was converted and what was not, and why. Repeating an import is safe:
 * the server compares each item's fingerprint with what it saved before.
 */
(function (global) {
  'use strict';

  var Castor = global.Castor || (global.Castor = {});

  /* ------------------------------------------------------------ bytes */

  function utf8(bytes) { return new TextDecoder('utf-8').decode(bytes); }
  function bytesOf(text) { return new TextEncoder().encode(text); }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    var out = '', i;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      var n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    if (i < bytes.length) {
      var m = bytes[i] << 16 | (i + 1 < bytes.length ? bytes[i + 1] << 8 : 0);
      out += B64[m >> 18 & 63] + B64[m >> 12 & 63] + (i + 1 < bytes.length ? B64[m >> 6 & 63] : '=') + '=';
    }
    return out;
  }

  /* SHA-256 of bytes or a string, in hex. Written out so it works on any page,
     secure context or not. */
  var K = [];
  (function () {
    function frac(x) { return (x - Math.floor(x)) * 4294967296 | 0; }
    for (var n = 2, found = 0; found < 64; n++) {
      var prime = true;
      for (var d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) { K.push(frac(Math.pow(n, 1 / 3))); found++; }
    }
  })();
  function sha256(input) {
    var bytes = typeof input === 'string' ? bytesOf(input) : input;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var length = bytes.length, padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[length] = 0x80;
    var bits = length * 8, view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 4294967296)); view.setUint32(padded.length - 4, bits >>> 0);
    var W = new Int32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var t = 0; t < 16; t++) W[t] = view.getInt32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var a0 = W[t - 15], a1 = W[t - 2];
        var s0 = (a0 >>> 7 | a0 << 25) ^ (a0 >>> 18 | a0 << 14) ^ a0 >>> 3;
        var s1 = (a1 >>> 17 | a1 << 15) ^ (a1 >>> 19 | a1 << 13) ^ a1 >>> 10;
        W[t] = W[t - 16] + s0 + W[t - 7] + s1 | 0;
      }
      var a = H[0], b = H[1], c = H[2], d2 = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        var t1 = h + S1 + (e & f ^ ~e & g) + K[t] + W[t] | 0;
        var S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        var t2 = S0 + (a & b ^ a & c ^ b & c) | 0;
        h = g; g = f; f = e; e = d2 + t1 | 0; d2 = c; c = b; b = a; a = t1 + t2 | 0;
      }
      H[0] = H[0] + a | 0; H[1] = H[1] + b | 0; H[2] = H[2] + c | 0; H[3] = H[3] + d2 | 0;
      H[4] = H[4] + e | 0; H[5] = H[5] + f | 0; H[6] = H[6] + g | 0; H[7] = H[7] + h | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  /* ------------------------------------------------------------ zip */

  /* The entries of a .zip (or .ulyz), each read only when asked for. Stored and
     deflated entries; anything else is listed as unreadable. */
  function readZip(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var end = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This file is not a zip archive.');
    var count = view.getUint16(end + 10, true), at = view.getUint32(end + 16, true), out = [];
    if (at === 0xffffffff || count === 0xffff) throw new Error('This archive is too large to read here. Unzip it and choose the folder.');
    for (var n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error('This zip archive is damaged.');
      var method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
      var nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
      var local = view.getUint32(at + 42, true);
      var name = utf8(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extra + comment;
      if (/\/$/.test(name)) continue;
      out.push(zipEntry(bytes, view, name, method, compressed, size, local));
    }
    return out;
  }
  function zipEntry(bytes, view, name, method, compressed, size, local) {
    return {
      path: name, size: size,
      read: function () {
        var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        var raw = bytes.subarray(start, start + compressed);
        if (method === 0) return Promise.resolve(raw);
        if (method !== 8 || typeof global.DecompressionStream !== 'function') return Promise.reject(new Error('unreadable'));
        var stream = new global.Blob([raw]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
        return new global.Response(stream).arrayBuffer().then(function (data) { return new Uint8Array(data); });
      }
    };
  }

  /* A picked folder (webkitdirectory) or picked files, as entries. A zip among the
     files is opened and its entries take its place. */
  function fromFiles(files) {
    var list = Array.prototype.slice.call(files || []), out = [], zips = [];
    list.forEach(function (file) {
      var path = file.webkitRelativePath || file.name;
      if (/\.(zip|ulyz)$/i.test(file.name)) zips.push(file);
      else out.push({ path: path, size: file.size, modified: file.lastModified || 0, read: function () { return file.arrayBuffer().then(function (b) { return new Uint8Array(b); }); } });
    });
    return Promise.all(zips.map(function (file) {
      return file.arrayBuffer().then(function (buffer) {
        var entries = readZip(buffer), stem = file.name.replace(/\.(zip|ulyz)$/i, '');
        // A .ulyz is one sheet: its Content.xml sits at the top of the archive.
        if (/\.ulyz$/i.test(file.name) && entries.some(function (e) { return e.path === 'Content.xml'; })) {
          entries.forEach(function (e) { e.path = stem + '.ulysses/' + e.path; });
        }
        return entries;
      });
    })).then(function (lists) { return out.concat.apply(out, lists); });
  }

  /* ------------------------------------------------------------ plists */

  function plist(bytes) {
    if (utf8(bytes.subarray(0, 8)) === 'bplist00') return binaryPlist(bytes);
    return xmlPlistValue(firstElement(xml(utf8(bytes)), 'plist'));
  }
  function binaryPlist(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 32;
    var offsetSize = bytes[end + 6], refSize = bytes[end + 7];
    var count = view.getUint32(end + 12), top = view.getUint32(end + 20), table = view.getUint32(end + 28);
    function uint(at, size) { var v = 0; for (var i = 0; i < size; i++) v = v * 256 + bytes[at + i]; return v; }
    function offset(ref) { return uint(table + ref * offsetSize, offsetSize); }
    function object(ref, depth) {
      if (depth > 64 || ref >= count) throw new Error('This property list is damaged.');
      var at = offset(ref), marker = bytes[at], kind = marker >> 4, info = marker & 15, start = at + 1;
      function length() {
        if (info !== 15) return info;
        var size = 1 << (bytes[start] & 15), value = uint(start + 1, size);
        start += 1 + size;
        return value;
      }
      if (kind === 0) return info === 8 ? false : info === 9 ? true : null;
      if (kind === 1) { var s = 1 << info; return s === 8 ? Number(view.getBigInt64(start)) : uint(start, s); }
      if (kind === 2) return info === 2 ? view.getFloat32(start) : view.getFloat64(start);
      if (kind === 3) return new Date(Date.UTC(2001, 0, 1) + view.getFloat64(start) * 1000);
      var n = length();
      if (kind === 4) return bytes.subarray(start, start + n);
      if (kind === 5) return String.fromCharCode.apply(null, bytes.subarray(start, start + n));
      if (kind === 6) { var text = ''; for (var i = 0; i < n; i++) text += String.fromCharCode(view.getUint16(start + i * 2)); return text; }
      if (kind === 7) return utf8(bytes.subarray(start, start + n));
      if (kind === 8) return uint(start, info + 1);
      if (kind === 10 || kind === 12) {
        var list = [];
        for (var j = 0; j < n; j++) list.push(object(uint(start + j * refSize, refSize), depth + 1));
        return list;
      }
      if (kind === 13) {
        var dict = {};
        for (var k = 0; k < n; k++) dict[object(uint(start + k * refSize, refSize), depth + 1)] = object(uint(start + (n + k) * refSize, refSize), depth + 1);
        return dict;
      }
      throw new Error('This property list holds an unknown kind of value.');
    }
    return object(top, 0);
  }
  function xmlPlistValue(node) {
    if (!node) return null;
    var kids = node.children.filter(function (c) { return typeof c !== 'string'; });
    if (node.name === 'plist') return xmlPlistValue(kids[0]);
    if (node.name === 'dict') {
      var out = {};
      for (var i = 0; i + 1 < kids.length; i += 2) out[textOf(kids[i])] = xmlPlistValue(kids[i + 1]);
      return out;
    }
    if (node.name === 'array') return kids.map(xmlPlistValue);
    if (node.name === 'integer' || node.name === 'real') return Number(textOf(node));
    if (node.name === 'true') return true;
    if (node.name === 'false') return false;
    return textOf(node);
  }

  /* ------------------------------------------------------------ xml */

  var ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  function decode(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (all, name) {
      if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
      return Object.prototype.hasOwnProperty.call(ENTITY, name) ? ENTITY[name] : all;
    });
  }
  /* A small non-validating reader: elements, attributes, text, CDATA. Enough for
     Ulysses sheets and XML property lists; it never fetches anything. */
  function xml(text) {
    var root = { name: '#root', attrs: {}, children: [] }, stack = [root], at = 0, pattern = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g, m;
    while ((m = pattern.exec(text))) {
      if (m.index > at) stack[stack.length - 1].children.push(decode(text.slice(at, m.index)));
      at = pattern.lastIndex;
      if (m[1] !== undefined) stack[stack.length - 1].children.push(m[1]);
      else if (m[2]) { if (stack.length > 1 && stack[stack.length - 1].name === m[2]) stack.pop(); }
      else if (m[3]) {
        var node = { name: m[3], attrs: {}, children: [] }, attr = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, a;
        while ((a = attr.exec(m[4] || ''))) node.attrs[a[1]] = decode(a[3] !== undefined ? a[3] : a[4]);
        stack[stack.length - 1].children.push(node);
        if (!m[5]) stack.push(node);
      }
    }
    if (at < text.length) stack[stack.length - 1].children.push(decode(text.slice(at)));
    return root;
  }
  function elements(node, name) { return (node ? node.children : []).filter(function (c) { return typeof c !== 'string' && (!name || c.name === name); }); }
  function firstElement(node, name) {
    if (!node || typeof node === 'string') return null;
    if (node.name === name) return node;
    for (var i = 0; i < node.children.length; i++) { var found = firstElement(node.children[i], name); if (found) return found; }
    return null;
  }
  function textOf(node) {
    if (typeof node === 'string') return node;
    return node ? node.children.map(textOf).join('') : '';
  }

  /* ------------------------------------------------------------ shared */

  function slug(text) {
    return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'untitled';
  }
  function folderFor(title, key) { return slug(title) + '-' + key.split(':')[1].slice(0, 6); }
  function safeName(name, taken) {
    var clean = String(name || 'file').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-._]+/, '').replace(/-+(\.[A-Za-z0-9]+)$/, '$1').slice(-100) || 'file';
    var dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
    var out = clean, n = 2;
    while (taken[out.toLowerCase()]) out = stem + '-' + (n++) + ext;
    taken[out.toLowerCase()] = true;
    return out;
  }
  function groupOf(name) {
    var ext = String(name).toLowerCase().split('.').pop();
    if (/^(png|jpe?g|gif|webp|svg)$/.test(ext)) return 'images';
    if (/^(pdf|txt|md|json|canvas)$/.test(ext)) return 'documents';
    return 'other';
  }
  function titleFrom(text) {
    var line = String(text || '').replace(/\s+/g, ' ').trim();
    if (line.length <= 120) return line;
    var cut = line.slice(0, 120), space = cut.lastIndexOf(' ');
    return (space > 60 ? cut.slice(0, space) : cut) + '…';
  }
  function plainOf(md) {
    return String(md).replace(/%%[\s\S]*?%%/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\^\d+\]/g, '').replace(/(\*\*|==|~~|`)/g, '').replace(/(^|\W)\*(\S[^*]*)\*/g, '$1$2')
      .replace(/^(#{1,6} |> |[-*+] |\d+[.)] )/, '').replace(/\\(.)/g, '$1').trim();
  }
  function note(report, kind, what, why) {
    var list = report[kind];
    var found = list.filter(function (n) { return n.what === what && n.why === why; })[0];
    if (found) found.count++; else list.push({ what: what, why: why, count: 1 });
  }
  function newReport() { return { converted: [], dropped: [] }; }
  var LINK = '\uE000', LINK_END = '\uE001';
  function placeholder(key, heading, shown) {
    return '[[' + LINK + key + (heading ? '#' + heading : '') + LINK_END + '|' + String(shown).replace(/[|\]\n]/g, ' ').trim() + ']]';
  }

  /* ------------------------------------------------------------ Ulysses */

  var GOAL_TYPE = { close_to: 'about', at_least: 'at-least', at_most: 'at-most', daily: 'daily' };
  var GOAL_UNIT = { words: 'words', characters: 'characters', sentences: 'sentences', paragraphs: 'paragraphs', pages: 'pages', readingTime: 'reading-time' };
  var GROUP_FALLBACK = { 'Unfiled-ulgroup': 'Inbox', 'Extras-ulgroup': 'Material', 'Imported-ulgroup': 'Pending', 'Templates-ulgroup': 'Templates' };
  var STRUCTURAL = { 'Groups-ulgroup': true, 'Main-ulgroup': true };

  function dirOf(path) { var i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
  function baseOf(path) { return path.slice(path.lastIndexOf('/') + 1); }
  function isGroupDir(name) { return /-(ulgroup|ulproject|ultrash)$/.test(name); }

  function ulysses(entries) {
    var byPath = {}, sheets = {}, groups = {}, report = { notes: [] };
    entries.forEach(function (e) {
      var path = e.path.replace(/^\/+/, '');
      if (/(^|\/)__MACOSX\//.test(path) || /(^|\/)\._/.test(path)) return;
      byPath[path] = e;
      var sheet = path.match(/^(.*?[^/]*\.ulysses)\/(.+)$/);
      if (sheet) (sheets[sheet[1]] = sheets[sheet[1]] || {})[sheet[2]] = e;
      var info = path.match(/^(.*)\/Info\.(ulgroup|ultrash)$/);
      if (info) groups[info[1]] = e;
    });
    var groupInfo = {};
    return Promise.all(Object.keys(groups).map(function (dir) {
      return groups[dir].read().then(function (b) { try { groupInfo[dir] = plist(b) || {}; } catch (e) { groupInfo[dir] = {}; } });
    })).then(function () {
      var ordered = orderSheets(Object.keys(sheets), groupInfo, report);
      var items = [], ids = {};
      ordered.forEach(function (s) { ids[s.dir] = sheetKey(s.dir); });
      return ordered.reduce(function (chain, s) {
        return chain.then(function () {
          return convertSheet(s, sheets[s.dir], ids).then(function (item) { if (item) items.push(item); else report.notes.push({ what: 'An empty sheet' + (s.group ? ' in “' + s.group + '”' : ''), why: 'there was nothing to import' }); });
        });
      }, Promise.resolve()).then(function () {
        Object.keys(groupInfo).forEach(function (dir) {
          var goal = groupInfo[dir].countingGoal;
          if (goal && goal.targetResult) report.notes.push({ what: 'The goal of “' + (groupInfo[dir].displayName || baseOf(dir)) + '”', why: 'Descant keeps goals on articles, not groups, so this one was not imported (' + goal.targetResult + ' ' + (GOAL_UNIT[goal.counterIdentifier] || goal.counterIdentifier || 'words') + ')' });
        });
        return { source: 'ulysses', label: 'Ulysses', items: items, notes: report.notes };
      });
    });
  }

  function sheetKey(dir) {
    var id = baseOf(dir).replace(/\.ulysses$/, '').toLowerCase();
    return 'ulysses:' + (/^[0-9a-f]{32}$/.test(id) ? id : sha256(dir).slice(0, 32));
  }

  /* Sheets in the order Ulysses shows them: a group's own sheets (sheetClusters),
     then its groups (childOrder), depth first. Trash and Templates stay out. */
  function orderSheets(dirs, info, report) {
    var bySheetGroup = {};
    dirs.forEach(function (dir) {
      var parent = dirOf(dir);
      (bySheetGroup[parent] = bySheetGroup[parent] || []).push(dir);
    });
    var allGroups = {};
    Object.keys(info).concat(Object.keys(bySheetGroup)).forEach(function (dir) {
      for (var d = dir; d; d = dirOf(d)) { allGroups[d] = true; if (!isGroupDir(baseOf(d))) break; }
    });
    function children(dir) {
      var listed = (info[dir] && info[dir].childOrder) || [];
      var found = Object.keys(allGroups).filter(function (g) { return dirOf(g) === dir && isGroupDir(baseOf(g)); });
      var rank = function (g) {
        var i = listed.indexOf(baseOf(g));
        var fixed = ['Main-ulgroup', 'Groups-ulgroup', 'Unfiled-ulgroup', 'Extras-ulgroup', 'Imported-ulgroup', 'Templates-ulgroup', 'Trash-ultrash'].indexOf(baseOf(g));
        return i >= 0 ? i : 1000 + (fixed >= 0 ? fixed : 100);
      };
      return found.sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : 1); });
    }
    function sheetsOf(dir) {
      var mine = bySheetGroup[dir] || [], clusters = (info[dir] && info[dir].sheetClusters) || [], order = [], glued = [];
      clusters.forEach(function (cluster) {
        (cluster || []).forEach(function (name) { if (mine.indexOf(dir + '/' + name) >= 0 && order.indexOf(dir + '/' + name) < 0) order.push(dir + '/' + name); });
        if (cluster && cluster.length > 1) glued.push(cluster.length);
      });
      mine.slice().sort().forEach(function (d) { if (order.indexOf(d) < 0) order.push(d); });
      if (glued.length) report.notes.push({ what: 'Glued sheets in “' + nameOf(dir) + '”', why: 'Descant keeps each sheet as its own article, in the same order' });
      return order;
    }
    function nameOf(dir) {
      var base = baseOf(dir);
      return (info[dir] && info[dir].displayName) || GROUP_FALLBACK[base] || base.replace(/-(ulgroup|ulproject)$/, '');
    }
    function path(dir) {
      var names = [];
      for (var d = dir; d && isGroupDir(baseOf(d)); d = dirOf(d)) if (!STRUCTURAL[baseOf(d)]) names.unshift(nameOf(d));
      return names.join(' / ');
    }
    var out = [], seen = {};
    function walk(dir) {
      var base = baseOf(dir);
      if (/-ultrash$/.test(base) || base === 'Templates-ulgroup') {
        var skipped = dirs.filter(function (d) { return d.indexOf(dir + '/') === 0; }).length;
        if (skipped) report.notes.push({ what: skipped + (skipped === 1 ? ' sheet' : ' sheets') + ' in ' + (/-ultrash$/.test(base) ? 'the Trash' : 'Templates'), why: 'Trash and Templates are not writing, so they stay in Ulysses' });
        dirs.forEach(function (d) { if (d.indexOf(dir + '/') === 0) seen[d] = true; });
        return;
      }
      sheetsOf(dir).forEach(function (d) { if (!seen[d]) { seen[d] = true; out.push({ dir: d, group: path(dir) }); } });
      children(dir).forEach(walk);
    }
    var roots = Object.keys(allGroups).filter(function (g) { var p = dirOf(g); return !allGroups[p] || !isGroupDir(baseOf(g)) && !p; });
    roots.sort().forEach(function (r) { if (isGroupDir(baseOf(r))) walk(r); else { sheetsOf(r).forEach(function (d) { if (!seen[d]) { seen[d] = true; out.push({ dir: d, group: '' }); } }); children(r).forEach(walk); } });
    dirs.forEach(function (d) { if (!seen[d]) { seen[d] = true; out.push({ dir: d, group: path(dirOf(d)) }); } });
    return out;
  }

  function convertSheet(s, files, ids) {
    if (!files['Content.xml']) return Promise.resolve(null);
    return Promise.all([files['Content.xml'].read(), files['Metadata.plist'] ? files['Metadata.plist'].read() : null]).then(function (got) {
      var doc = xml(utf8(got[0])), sheet = firstElement(doc, 'sheet') || doc;
      var meta = null;
      try { meta = got[1] ? plist(got[1]) : null; } catch (e) { meta = null; }
      var report = newReport(), key = ids[s.dir], media = {}, mediaNames = {}, taken = {};
      Object.keys(files).forEach(function (name) { if (/^Media\//.test(name)) media[name.slice(6)] = files[name]; });
      var wanted = [];   // [{name in Media, group, path}]
      function mediaFor(id) {
        var names = Object.keys(media), hit = names.filter(function (n) { return n === id || n.indexOf('.' + id + '.') >= 0 || n.indexOf(id + '.') === 0; })[0];
        if (!hit) return null;
        if (!mediaNames[hit]) {
          var clean = hit.replace(new RegExp('\\.' + id.replace(/[^0-9a-zA-Z]/g, '') + '(?=\\.)'), '');
          var group = groupOf(clean), name = safeName(clean, taken);
          mediaNames[hit] = group + '/' + name;
          wanted.push({ name: hit, path: mediaNames[hit] });
        }
        return 'materials/' + mediaNames[hit];
      }
      var ctx = { report: report, ids: ids, mediaFor: mediaFor, footnotes: [], comments: [], key: key, anchors: {} };
      var body = blocks(firstElement(sheet, 'string'), ctx);
      if (ctx.footnotes.length) body += '\n\n' + ctx.footnotes.map(function (text, i) { return '[^' + (i + 1) + ']: ' + text; }).join('\n');
      var item = { source: 'ulysses', key: key, sourceName: s.dir, group: s.group, tags: [], goal: null, extra: [], comments: ctx.comments, report: report, materials: [], anchors: ctx.anchors };
      var notes = [];
      elements(sheet, 'attachment').forEach(function (att) {
        var type = att.attrs.type;
        if (type === 'keywords' || type === '3') {
          textOf(att).split(',').map(function (k) { return k.trim(); }).filter(Boolean).forEach(function (k) { if (item.tags.indexOf(k) < 0) item.tags.push(k); });
          note(report, 'converted', 'Keywords', 'became tags');
        } else if (type === 'goal') {
          var target = parseInt(att.attrs.targetResult, 10), kind = GOAL_TYPE[att.attrs.goalType], unit = GOAL_UNIT[att.attrs.counterIdentifier || 'words'];
          var due = Object.keys(att.attrs).filter(function (n) { return /deadline/i.test(n) && /^\d{4}-\d{2}-\d{2}/.test(att.attrs[n]); })[0];
          if (target > 0 && kind && unit) {
            item.goal = { target: target, type: kind, unit: unit };
            if (due) item.goal.due = att.attrs[due].slice(0, 10);
            note(report, 'converted', 'The goal', 'is kept in the article’s front matter for goals');
          } else note(report, 'dropped', 'A goal', 'its kind could not be read');
        } else if (type === 'note' || type === '1') {
          var noteCtx = { report: report, ids: ids, mediaFor: mediaFor, footnotes: [], comments: null, key: key };
          var text = blocks(firstElement(att, 'string'), noteCtx);
          if (noteCtx.footnotes.length) text += '\n\n' + noteCtx.footnotes.map(function (t, i) { return '[^' + (i + 1) + ']: ' + t; }).join('\n');
          if (text.trim()) notes.push(text.trim() + '\n');
        } else if (type === 'file' || type === 'image' || type === '2') {
          var file = textOf(att).trim(), id = (file.match(/\.([0-9a-f]{6,})\.[a-z0-9]+$/i) || [])[1] || file;
          if (mediaFor(id) || mediaFor(file)) note(report, 'converted', 'Attached files', 'are in the article’s materials');
          else note(report, 'dropped', 'An attached file', 'it is not in this copy of the library');
        } else note(report, 'dropped', 'An attachment (' + type + ')', 'Descant has no place for it yet');
      });
      notes.forEach(function (text, i) {
        item.materials.push({ path: 'notes/' + (notes.length > 1 ? 'note-' + (i + 1) : 'note') + '.md', text: text });
      });
      if (notes.length) note(report, 'converted', 'Notes on sheets', 'became Markdown files in materials/notes');
      if (!body.trim()) return null;
      var first = body.split('\n').filter(function (l) { return l.trim(); })[0] || '';
      // A sheet that holds only a comment is shown in Ulysses by that comment, so it is named by it here.
      item.title = titleFrom(plainOf(first)) || titleFrom(plainOf(String(first).replace(/%%/g, ''))) || 'Untitled sheet';
      item.body = body.replace(/[ \t]+$/gm, '') + '\n';
      item.folder = folderFor(item.title, key);
      if (meta && meta.lastEditingDate) {
        var when = typeof meta.lastEditingDate === 'number' ? new Date(Date.UTC(2001, 0, 1) + meta.lastEditingDate * 1000) : meta.lastEditingDate;
        if (when instanceof Date && !isNaN(when)) item.date = when.toISOString().slice(0, 10);
      }
      return Promise.all(wanted.map(function (w) {
        return media[w.name].read().then(function (bytes) { item.materials.push({ path: w.path, bytes: bytes }); });
      })).then(function () { return item; });
    });
  }

  /* The paragraphs of a <string>, as Markdown blocks. Ulysses keeps one paragraph per
     <p>; each becomes its own block, so no two paragraphs run together. */
  function blocks(string, ctx) {
    if (!string) return '';
    var out = [], code = null, kinds = [];
    function flushCode() { if (code) { out.push({ md: '```' + (code.native ? '' : '') + '\n' + code.lines.join('\n') + '\n```', kind: 'code' }); code = null; } }
    elements(string, 'p').forEach(function (p) {
      var tags = elements(firstElement(p, 'tags'), 'tag'), indent = 0, kind = '', marker = '';
      tags.forEach(function (t) {
        var k = t.attrs.kind;
        if (!k) { if (/\t/.test(textOf(t))) indent++; } else { kind = k; marker = textOf(t); }
      });
      var content = p.children.filter(function (c) { return !(typeof c !== 'string' && c.name === 'tags'); });
      if (kind === 'codeblock' || kind === 'nativeblock') {
        if (!code) code = { lines: [], native: kind === 'nativeblock' };
        code.lines.push(content.map(textOf).join(''));
        if (kind === 'nativeblock') note(ctx.report, 'converted', 'Native blocks', 'became code blocks');
        return;
      }
      flushCode();
      var line = inline(content, ctx), plain = plainOf(line);
      if (!line.trim() && !kind) return;
      var pad = new Array(indent + 1).join('    ');
      if (/^heading[1-6]$/.test(kind)) {
        out.push({ md: new Array(+kind.slice(7) + 1).join('#') + ' ' + line.trim(), kind: 'heading', plain: plain });
        if (p.attrs.anchor && ctx.anchors) ctx.anchors[p.attrs.anchor] = plain;
      }
      else if (kind === 'unorderedList') out.push({ md: pad + '- ' + line, kind: 'list' });
      else if (kind === 'orderedList') out.push({ md: pad + ((marker.match(/\d+/) || ['1'])[0]) + '. ' + line, kind: 'list' });
      else if (kind === 'blockquote') out.push({ md: '> ' + line, kind: 'quote' });
      else if (kind === 'comment') { out.push({ md: '%%' + line.trim() + '%%', kind: 'para' }); note(ctx.report, 'converted', 'Comment paragraphs (%%)', 'became writer’s notes, hidden from readers'); }
      else if (kind === 'divider') out.push({ md: '---', kind: 'para' });
      else if (kind === 'filename') { note(ctx.report, 'dropped', 'An export file name (@:)', 'Descant names files itself'); }
      else if (kind) { out.push({ md: line, kind: 'para' }); note(ctx.report, 'dropped', 'A “' + kind + '” paragraph mark', 'Descant has no such paragraph; the words are kept'); }
      else out.push({ md: line, kind: 'para', plain: plain });
      kinds.push(kind);
    });
    flushCode();
    return out.reduce(function (text, block, i) {
      if (!i) return block.md;
      var prev = out[i - 1];
      var joint = block.kind === 'list' && prev.kind === 'list' ? '\n' : block.kind === 'quote' && prev.kind === 'quote' ? '\n>\n' : '\n\n';
      return text + joint + block.md;
    }, '');
  }

  function attributes(node) {
    var out = {};
    elements(node, 'attribute').forEach(function (a) { out[a.attrs.identifier] = a; });
    return out;
  }
  function fence(text, mark) { var run = mark; while (text.indexOf(run) >= 0) run += mark[0]; return run; }

  function inline(nodes, ctx) {
    var md = '';
    nodes.forEach(function (n) {
      if (typeof n === 'string') { md += n.replace(/\n/g, ' '); return; }
      if (n.name === 'escape') { md += textOf(n); return; }
      if (n.name === 'attribute' || n.name === 'tags') return;
      if (n.name !== 'element') { md += inline(n.children, ctx); return; }
      var kind = n.attrs.kind, attrs = attributes(n), inner = function () { return inline(n.children, ctx); };
      if (kind === 'strong') { md += '**' + inner() + '**'; return; }
      if (kind === 'emph') { md += '*' + inner() + '*'; return; }
      if (kind === 'mark') { md += '==' + inner() + '=='; note(ctx.report, 'converted', 'Highlights (::)', 'became Descant highlights'); return; }
      if (kind === 'delete') { md += '~~' + inner() + '~~'; note(ctx.report, 'converted', 'Deletions (||)', 'became strikethrough'); return; }
      if (kind === 'code') { var c = textOf({ children: n.children.filter(function (x) { return typeof x === 'string' || x.name !== 'attribute'; }) }), f = fence(c, '`'); md += f + c + f; return; }
      if (kind === 'inlineComment') { md += '%%' + plainOf(inner()) + '%%'; note(ctx.report, 'converted', 'Inline comments (++)', 'became writer’s notes, hidden from readers'); return; }
      if (kind === 'inlineNative') { md += plainOf(inner()); note(ctx.report, 'converted', 'Inline native text (~)', 'kept as plain text'); return; }
      if (kind === 'link') {
        var shown = inner();
        if (attrs.sheetRef) {
          var target = Object.keys(ctx.ids).filter(function (d) { return baseOf(d) === textOf(attrs.sheetRef).trim(); })[0];
          if (target) { md += placeholder(ctx.ids[target], attrs.anchorRef ? '^' + textOf(attrs.anchorRef).trim() : '', plainOf(shown) || 'link'); note(ctx.report, 'converted', 'Links to other sheets', 'became links between articles'); }
          else { md += shown; note(ctx.report, 'dropped', 'A link to a sheet outside this import', 'its words are kept, without the link'); }
          return;
        }
        var url = textOf(attrs.URL || '').trim();
        if (!url) { md += shown; note(ctx.report, 'dropped', 'A link without an address', 'its words are kept'); return; }
        var title = textOf(attrs.title || '').trim();
        md += '[' + shown + '](' + (/[\s()<>]/.test(url) ? '<' + url.replace(/>/g, '%3E') + '>' : url) + (title ? ' "' + title.replace(/"/g, '\u201d') + '"' : '') + ')';
        return;
      }
      if (kind === 'annotation') {
        var quoted = inner();
        md += quoted;
        var words = attrs.text ? elements(firstElement(attrs.text, 'string'), 'p').map(function (p) { return plainOf(inline(p.children, ctx)); }).filter(Boolean).join('\n\n') : '';
        if (ctx.comments && words) {
          ctx.comments.push({ text: words, quote: plainOf(quoted), at: md.length - quoted.length, md: quoted });
          note(ctx.report, 'converted', 'Annotations', 'became Descant comments on the same words');
        } else if (words) {
          md += ' %%' + words.replace(/\n+/g, ' ') + '%%';
          note(ctx.report, 'converted', 'Annotations inside notes', 'became writer’s notes');
        }
        return;
      }
      if (kind === 'footnote') {
        var foot = attrs.text ? elements(firstElement(attrs.text, 'string'), 'p').map(function (p) { return inline(p.children, ctx).trim(); }).filter(Boolean).join(' ') : '';
        ctx.footnotes.push(foot || '…');
        md += '[^' + ctx.footnotes.length + ']';
        note(ctx.report, 'converted', 'Footnotes', 'became Markdown footnotes');
        return;
      }
      if (kind === 'image' || kind === 'video') {
        var id = textOf(attrs.image || attrs.video || '').trim(), remote = textOf(attrs.URL || '').trim();
        var alt = textOf(attrs.description || '').trim().replace(/[\[\]]/g, ''), ttl = textOf(attrs.title || '').trim();
        var path = id ? ctx.mediaFor(id) : null;
        var where = path || remote;
        if (!where) {
          note(ctx.report, 'dropped', kind === 'image' ? 'A picture' : 'A video',
            id ? 'its file is not in this copy of the library' : 'it is an empty ' + (kind === 'image' ? 'picture' : 'video') + ' placeholder in Ulysses');
          return;
        }
        if (kind === 'image') { md += '![' + alt + '](' + where + (ttl ? ' "' + ttl.replace(/"/g, '\u201d') + '"' : '') + ')'; note(ctx.report, 'converted', 'Pictures', path ? 'are in the article’s materials' : 'link to their web address'); }
        else { md += '[' + (alt || ttl || baseOf(where)) + '](' + where + ')'; note(ctx.report, 'converted', 'Videos', 'are in materials and linked from the text'); }
        return;
      }
      if (kind === 'math') { md += '$$' + textOf(attrs.text || attrs.math || n).trim() + '$$'; note(ctx.report, 'converted', 'Equations', 'kept as TeX between $$'); return; }
      if (kind === 'tableOfContents') { note(ctx.report, 'dropped', 'A table of contents', 'Descant’s Outline shows the headings'); return; }
      if (kind === 'table') { var cells = plainOf(textOf(n)); if (cells) md += cells; note(ctx.report, 'dropped', 'A table', 'its words are kept as plain text'); return; }
      md += inner();
      note(ctx.report, 'dropped', 'A “' + kind + '” mark', 'Descant has no such mark; the words are kept');
    });
    return md;
  }

  /* ------------------------------------------------------------ Obsidian */

  var PROTECTED = { slug: 1, order: 1, status: 1, phase: 1, owner: 1, published: 1, site: 1, chip: 1, language: 1, group: 1, goal: 1, 'goal-type': 1, 'goal-unit': 1, 'goal-due': 1 };

  function obsidian(entries) {
    var files = entries.map(function (e) { return { path: e.path.replace(/^\/+/, ''), entry: e }; })
      .filter(function (f) { return !/(^|\/)__MACOSX\//.test(f.path) && !/(^|\/)\._/.test(f.path) && !/(^|\/)\.DS_Store$/.test(f.path); });
    var config = files.filter(function (f) { return /(^|\/)\.obsidian\/app\.json$/.test(f.path); })[0];
    var root = config ? config.path.replace(/\.obsidian\/app\.json$/, '') : commonRoot(files);
    var vault = root.replace(/\/$/, '').split('/').pop() || 'Vault';
    var notes = [], attachments = {}, skipped = { config: 0, trash: 0, canvas: 0, hidden: 0 }, report = { notes: [] };
    files.forEach(function (f) {
      if (f.path.indexOf(root) !== 0) return;
      var rel = f.path.slice(root.length);
      if (/^\.obsidian\//.test(rel)) { skipped.config++; return; }
      if (/^\.trash\//.test(rel)) { skipped.trash++; return; }
      if (/(^|\/)\./.test(rel)) { skipped.hidden++; return; }
      if (/\.(canvas|base)$/i.test(rel)) { skipped.canvas++; return; }
      if (/\.md$/i.test(rel)) notes.push({ rel: rel, entry: f.entry });
      else attachments[rel] = f.entry;
    });
    if (skipped.trash) report.notes.push({ what: skipped.trash + (skipped.trash === 1 ? ' file' : ' files') + ' in .trash', why: 'deleted notes stay out' });
    if (skipped.canvas) report.notes.push({ what: skipped.canvas + (skipped.canvas === 1 ? ' canvas or base' : ' canvases and bases'), why: 'Descant has no canvas import yet; they stay in Obsidian' });
    if (skipped.config) report.notes.push({ what: 'The vault’s settings and plugins (.obsidian)', why: 'only the line-break setting is read' });
    var readConfig = config ? config.entry.read().then(function (b) { try { return JSON.parse(utf8(b)); } catch (e) { return {}; } }) : Promise.resolve({});
    return readConfig.then(function (settings) {
      var strict = settings.strictLineBreaks === true;
      return Promise.all(notes.map(function (n) { return n.entry.read().then(function (b) { n.text = utf8(b).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, ''); }); })).then(function () {
        var index = { names: {}, paths: {}, files: {} };
        notes.forEach(function (n) {
          n.key = 'obsidian:' + sha256(n.rel).slice(0, 32);
          n.name = baseOf(n.rel).replace(/\.md$/i, '');
          (index.names[n.name.toLowerCase()] = index.names[n.name.toLowerCase()] || []).push(n);
          index.paths[n.rel.replace(/\.md$/i, '').toLowerCase()] = n;
          n.front = frontMatter(n.text);
          (n.front.aliases || []).forEach(function (a) { var k = a.toLowerCase(); if (!index.names[k]) index.names[k] = [n]; });
        });
        Object.keys(attachments).forEach(function (rel) {
          (index.files[baseOf(rel).toLowerCase()] = index.files[baseOf(rel).toLowerCase()] || []).push(rel);
          index.files[rel.toLowerCase()] = [rel];
        });
        var items = [];
        return notes.sort(function (a, b) { return a.rel < b.rel ? -1 : 1; }).reduce(function (chain, n) {
          return chain.then(function () {
            return convertNote(n, index, attachments, vault, strict).then(function (item) { if (item) items.push(item); else report.notes.push({ what: n.rel, why: 'the note is empty, so nothing was imported' }); });
          });
        }, Promise.resolve()).then(function () {
          if (!strict) report.notes.push({ what: 'Single line breaks', why: 'Obsidian shows them as breaks (strict line breaks off), so they became line breaks in Descant', converted: true });
          return { source: 'obsidian', label: config ? 'Obsidian' : 'Markdown', items: items, notes: report.notes };
        });
      });
    });
  }

  function commonRoot(files) {
    var parts = files.map(function (f) { return f.path.split('/').slice(0, -1); });
    if (!parts.length) return '';
    var root = parts[0];
    parts.forEach(function (p) { var i = 0; while (i < root.length && p[i] === root[i]) i++; root = root.slice(0, i); });
    return root.length ? root.join('/') + '/' : '';
  }

  /* Top-level keys of a note's front matter, each with its raw lines, plus the
     values Descant reads (title, tags, aliases, date). Nothing else is parsed. */
  function frontMatter(text) {
    var m = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
    if (!m) return { lines: [], keys: [], body: text, tags: [], aliases: [] };
    var keys = [], current = null;
    m[1].split('\n').forEach(function (line) {
      var k = line.match(/^([^\s:#'"-][^:]*?)[ \t]*:(?:[ \t]|$)/) || line.match(/^(["'][^"']+["'])[ \t]*:(?:[ \t]|$)/);
      if (k) { current = { key: k[1].replace(/^["']|["']$/g, ''), lines: [line.replace(/[ \t]+$/, '')] }; keys.push(current); }
      else if (current && line.trim()) current.lines.push(line.replace(/[ \t]+$/, ''));
    });
    function list(entry) {
      if (!entry) return [];
      var first = entry.lines[0].replace(/^[^:]*:\s*/, '');
      var items = first ? (/^\[.*\]$/.test(first) ? first.slice(1, -1).split(',') : first.split(/,\s*|\s+(?=#)/)) : entry.lines.slice(1).map(function (l) { return l.replace(/^\s*-\s*/, ''); });
      return items.map(function (v) { return v.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''); }).filter(Boolean);
    }
    function scalar(entry) { return entry ? entry.lines[0].replace(/^[^:]*:\s*/, '').trim().replace(/^["']|["']$/g, '') : ''; }
    var find = function (name) { return keys.filter(function (k) { return k.key.toLowerCase() === name; })[0]; };
    return { keys: keys, body: text.slice(m[0].length), tags: list(find('tags') || find('tag')), aliases: list(find('aliases') || find('alias')),
      title: scalar(find('title')), date: (scalar(find('date')).match(/^\d{4}-\d{2}-\d{2}/) || [''])[0] };
  }

  function resolveNote(target, from, index) {
    var t = target.replace(/\.md$/i, '').toLowerCase();
    if (index.paths[t]) return index.paths[t];
    var here = dirOf(from.rel).toLowerCase();
    if (here && index.paths[here + '/' + t]) return index.paths[here + '/' + t];
    var named = index.names[baseOf(t)] || [];
    if (named.length > 1) named = named.filter(function (n) { return n.rel.toLowerCase().slice(0, -3).endsWith(t); });
    return named.sort(function (a, b) { return a.rel.length - b.rel.length; })[0] || null;
  }
  function resolveFile(target, from, index) {
    var t = decodeURISafe(target).replace(/^\.\//, '').toLowerCase();
    var here = dirOf(from.rel).toLowerCase();
    var hit = index.files[(here ? here + '/' : '') + t] || index.files[t] || index.files[baseOf(t)];
    return hit ? hit[0] : null;
  }
  function decodeURISafe(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }

  function convertNote(n, index, attachments, vault, strict) {
    var report = newReport(), item = { source: 'obsidian', key: n.key, sourceName: n.rel, report: report, materials: [], comments: [], goal: null };
    var front = n.front, extra = [], tags = front.tags.slice();
    front.keys.forEach(function (k) {
      var name = k.key.toLowerCase();
      if (name === 'title' || name === 'tags' || name === 'tag' || name === 'date' || name === 'subtitle') return;
      if (PROTECTED[name]) {
        extra.push.apply(extra, ['obsidian-' + k.lines[0].replace(/^["']?([^:"']*)["']?\s*:/, '$1:')].concat(k.lines.slice(1)));
        note(report, 'converted', 'The property “' + k.key + '”', 'renamed obsidian-' + k.key + ', so it does not change Descant’s own field');
        return;
      }
      extra.push.apply(extra, k.lines);
    });
    if (front.keys.length) note(report, 'converted', 'Properties', 'kept in the article’s front matter');
    var taken = {}, wanted = {};
    function material(rel) {
      if (!wanted[rel]) {
        var name = safeName(baseOf(rel), taken);
        wanted[rel] = groupOf(name) + '/' + name;
      }
      return 'materials/' + wanted[rel];
    }
    var body = front.body, out = [], fenceMark = null, math = false, blockRefs = 0;
    var lines = body.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var f = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMark) { out.push({ text: line, raw: true }); if (f && f[1][0] === fenceMark[0] && f[1].length >= fenceMark.length && !line.trim().slice(f[1].length).trim()) fenceMark = null; continue; }
      if (f) { fenceMark = f[1]; out.push({ text: line, raw: true }); continue; }
      if (/^\s*\$\$\s*$/.test(line)) { math = !math; out.push({ text: line, raw: true }); continue; }
      if (math) { out.push({ text: line, raw: true }); continue; }
      var hard = / {2,}$/.test(line) || /\\$/.test(line);
      line = line.replace(/\s+\^[A-Za-z0-9-]+\s*$/, function () { blockRefs++; return ''; });
      line = rewriteLine(line, n, index, report, material);
      out.push({ text: line.replace(/[ \t]+$/, '').replace(/\\$/, ''), hard: hard });
    }
    if (blockRefs) note(report, 'dropped', 'Block ids (^id)', 'Descant has no block links; the words are kept');
    item.body = joinLines(out, strict).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
    if (!item.body.trim()) return Promise.resolve(null);
    var firstHeading = (item.body.match(/^# (.+)$/m) || [])[1];
    item.title = titleFrom(front.title || n.name || plainOf(firstHeading || ''));
    item.folder = folderFor(item.title, n.key);
    item.group = [vault].concat(dirOf(n.rel) ? dirOf(n.rel).split('/') : []).join(' / ');
    item.tags = tags.filter(function (t, i) { return t && tags.indexOf(t) === i; });
    item.extra = extra;
    if (front.date) item.date = front.date;
    else if (n.entry.modified) item.date = new Date(n.entry.modified).toISOString().slice(0, 10);
    var too = [];
    return Promise.all(Object.keys(wanted).map(function (rel) {
      var entry = attachments[rel];
      return entry.read().then(function (bytes) { item.materials.push({ path: wanted[rel], bytes: bytes }); }, function () { too.push(rel); });
    })).then(function () {
      too.forEach(function () { note(report, 'dropped', 'An attachment', 'it could not be read from this copy'); });
      if (Object.keys(wanted).length) note(report, 'converted', 'Attachments', 'are in the article’s materials');
      return item;
    });
  }

  /* Wikilinks, embeds and local Markdown links on one line, outside inline code. */
  function rewriteLine(line, from, index, report, material) {
    return line.split(/(`+[^`]*`+)/).map(function (part, i) {
      if (i % 2) return part;
      part = part.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, function (all, bang, spec) {
        var bar = spec.indexOf('|'), target = bar >= 0 ? spec.slice(0, bar) : spec, shown = bar >= 0 ? spec.slice(bar + 1) : '';
        var hash = target.indexOf('#'), heading = hash >= 0 ? target.slice(hash + 1) : '', name = (hash >= 0 ? target.slice(0, hash) : target).trim();
        var file = name && !/\.md$/i.test(name) && /\.[a-z0-9]{2,5}$/i.test(name) ? resolveFile(name, from, index) : null;
        if (file) {
          var path = material(file);
          if (bang && groupOf(path) === 'images') {
            var width = /^\d+(x\d+)?$/.test(shown.trim()) ? shown.trim() : '';
            if (width) return '![[' + path + '|' + width + ']]';
            return '![' + (shown || baseOf(name)).replace(/[\[\]]/g, '') + '](' + path + ')';
          }
          if (bang) note(report, 'converted', 'Embedded files', 'became links to the file in materials');
          return '[' + (shown || baseOf(name)).replace(/[\[\]]/g, '') + '](' + path + ')';
        }
        var target2 = name ? resolveNote(name, from, index) : from;
        if (heading.charAt(0) === '^') note(report, 'dropped', 'Links to a block (#^)', 'they became links to the note');
        if (bang) note(report, 'converted', 'Embedded notes', 'became links to the note');
        if (!target2) { note(report, 'dropped', 'A link to a note that is not in the vault', 'kept as a link to an article not written yet'); return '[[' + spec + ']]'; }
        note(report, 'converted', 'Wikilinks', 'became links between articles');
        return placeholder(target2.key, heading, shown || (heading && !name ? heading : name));
      });
      return part.replace(/(!?)\[([^\]\n]*)\]\((?!https?:|mailto:|#)<?([^)>\s]+)>?\)/g, function (all, bang, shown, target) {
        var clean = decodeURISafe(target);
        if (/\.md$/i.test(clean)) {
          var note2 = resolveNote(clean.replace(/^\.\//, ''), from, index);
          if (note2) { note(report, 'converted', 'Markdown links to notes', 'became links between articles'); return placeholder(note2.key, '', shown || note2.name); }
          return all;
        }
        var file = resolveFile(clean, from, index);
        if (!file) return all;
        var path = material(file);
        return (bang && groupOf(path) === 'images' ? '!' : '') + '[' + shown + '](' + path + ')';
      });
    }).join('');
  }

  /* Obsidian shows a single line break as a break unless strict line breaks are on.
     Descant keeps a paragraph on one line: a break inside one becomes a backslash
     break (or, with strict breaks, a space), and a blank line still parts paragraphs. */
  function startsBlock(text) {
    return /^\s*$/.test(text) || /^ {0,3}(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||(-{3,}|\*{3,}|_{3,})\s*$|<\/?[a-z]|\$\$|%%\s*$)/i.test(text) || /^\s*(`{3,}|~{3,})/.test(text);
  }
  function joinLines(lines, strict) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.raw) { out.push(line.text); continue; }
      var next = lines[i + 1], text = line.text;
      var continues = next && !next.raw && next.text.trim() && text.trim() && !/^ {0,3}(#{1,6}\s|(-{3,}|\*{3,}|_{3,})\s*$|\|)/.test(text) && !/^ {0,3}(\$\$|<\/?[a-z])/i.test(text) && !/^\s*(>\s*)+\[![A-Za-z-]+\]/.test(text);
      var nextStarts = next && startsBlock(next.text.replace(/^(\s*>)+\s?/, function (q) { return /^\s*>/.test(text) ? '' : q; }));
      var quoteBoth = next && /^\s*>/.test(text) && /^\s*>/.test(next.text) && !startsBlock(next.text.replace(/^(\s*>\s?)+/, ''));
      if (continues && (!nextStarts || quoteBoth) && !(/^\s*>/.test(next.text) && !/^\s*>/.test(text))) {
        if (strict && !line.hard) {
          var joined = text;
          while (lines[i + 1] && !lines[i + 1].raw && lines[i + 1].text.trim() && !startsBlock(lines[i + 1].text) && !lines[i].hard) {
            i++; joined += ' ' + lines[i].text.trim();
          }
          out.push(joined);
          continue;
        }
        out.push(text + '\\');
        continue;
      }
      out.push(text);
    }
    return out.join('\n');
  }

  /* ------------------------------------------------------------ the plan */

  function detect(entries) {
    var paths = entries.map(function (e) { return e.path; });
    if (paths.some(function (p) { return /\.ulysses\/Content\.xml$/.test(p); })) return 'ulysses';
    if (paths.some(function (p) { return /\.md$/i.test(p); })) return 'obsidian';
    return null;
  }

  function read(entries) {
    var kind = detect(entries);
    if (kind === 'ulysses') return ulysses(entries);
    if (kind === 'obsidian') return obsidian(entries);
    return Promise.reject(new Error('This holds no Ulysses sheets and no Markdown notes. Choose a Ulysses library, a .ulyz export or an Obsidian vault.'));
  }

  /* Link targets, then fingerprints. `known` is the server's plan: {key: folder}
     for the articles an earlier import made, whose folder names links must use. */
  function finish(result, known) {
    var folders = {}, anchors = {};
    result.items.forEach(function (item) { if (known[item.key]) item.folder = known[item.key]; folders[item.key] = item.folder; anchors[item.key] = item.anchors || {}; });
    var pattern = new RegExp('\\[\\[' + LINK + '([^' + LINK_END + '#]+)(#[^' + LINK_END + ']*)?' + LINK_END + '\\|([^\\]]*)\\]\\]', 'g');
    result.items.forEach(function (item) {
      item.body = item.body.replace(pattern, function (all, key, heading, shown) {
        var folder = folders[key] || known[key];
        if (!folder) return shown;
        var place = !heading ? '' : heading.charAt(1) !== '^' ? heading : (anchors[key] || {})[heading.slice(2)] ? '#' + anchors[key][heading.slice(2)] : '';
        return '[[' + folder + place.replace(/[|\]]/g, ' ') + '|' + shown + ']]';
      });
      item.comments = anchorComments(item);
      item.materials.forEach(function (m) { m.sha = sha256(m.bytes || bytesOf(m.text)); m.size = m.bytes ? m.bytes.length : bytesOf(m.text).length; });
      item.fingerprint = sha256(JSON.stringify([item.key, item.title, item.folder, item.group || '', item.date || '', item.tags || [], item.goal || null,
        item.extra || [], item.body, item.materials.map(function (m) { return [m.path, m.sha]; }), item.comments]));
    });
    return result;
  }

  /* An annotation's place, as the reader sees the paragraph: the quote with up to 32
     characters around it, and the whole paragraph's text. */
  function anchorComments(item) {
    if (!item.comments || !item.comments.length || item.comments[0].id) return item.comments || [];
    var paragraphs = item.body.split(/\n\n+/);
    return item.comments.map(function (c, i) {
      var block = '', at = -1;
      for (var p = 0; p < paragraphs.length && at < 0; p++) {
        var plain = plainOf(paragraphs[p]);
        at = plain.indexOf(c.quote);
        if (at >= 0) block = plain;
      }
      return { id: sha256(item.key + '\n' + i + '\n' + c.quote + '\n' + c.text).slice(0, 16), text: c.text, quote: c.quote,
        prefix: at >= 0 ? block.slice(Math.max(0, at - 32), at) : '', suffix: at >= 0 ? block.slice(at + c.quote.length, at + c.quote.length + 32) : '', block: block };
    });
  }

  /* The request body of one item. Files larger than `room` bytes travel on their own. */
  var ROOM = 3 * 1024 * 1024;
  function payload(item) {
    var inside = [], later = [], used = 0;
    item.materials.forEach(function (m) {
      if (m.size > ROOM) { later.push(m); return; }
      if (used + m.size > ROOM) { later.push(m); return; }
      used += m.size;
      inside.push(m);
    });
    return {
      item: { source: item.source, key: item.key, fingerprint: item.fingerprint, folder: item.folder, title: item.title, group: item.group || '',
        date: item.date || '', tags: item.tags || [], goal: item.goal || null, extra: item.extra || [], body: item.body, comments: item.comments,
        materials: inside.map(wire) },
      later: later
    };
  }
  function wire(m) {
    return m.text != null && !m.bytes ? { path: m.path, text: m.text } : { path: m.path, data: 'data:application/octet-stream;base64,' + base64(m.bytes) };
  }

  var MAX_FILE = 3 * 1024 * 1024;
  function post(body) {
    var who = Castor.who && (Castor.who.session ? Castor.who.session().map(function (p) { return p.id || { name: p.name, email: p.email }; }) : Castor.who.get && Castor.who.get());
    body.who = who;
    return global.fetch(Castor.endpoints.api('import'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok || !data.ok) throw new Error(data.error || (r.status === 413 ? 'This item is too large to send.' : 'The server answered ' + r.status + '.'));
          return data;
        });
      });
  }
  function plan(result) {
    var keys = result.items.map(function (i) { return { key: i.key, fingerprint: '' }; });
    return post({ mode: 'plan', items: keys }).then(function (answer) {
      var known = {};
      answer.items.forEach(function (a) { if (a.folder) known[a.key] = a.folder; });
      finish(result, known);
      return post({ mode: 'plan', items: result.items.map(function (i) { return { key: i.key, fingerprint: i.fingerprint }; }) });
    }).then(function (answer) {
      var byKey = {};
      answer.items.forEach(function (a) { byKey[a.key] = a; });
      result.items.forEach(function (i) { i.state = (byKey[i.key] || {}).state || 'new'; i.path = (byKey[i.key] || {}).path || ''; });
      return result;
    });
  }
  /* Writes the items one by one, in order, and calls back after each. */
  function apply(result, progress) {
    var done = [];
    return result.items.reduce(function (chain, item, n) {
      return chain.then(function () {
        if (item.state === 'same') { done.push({ item: item, state: 'same' }); progress(n + 1, item); return; }
        var p = payload(item), outcome = { item: item };
        return post({ mode: 'write', item: p.item }).then(function (answer) {
          outcome.state = answer.state; outcome.path = answer.path; outcome.kept = answer.kept || []; outcome.version = answer.version || '';
          outcome.comments = answer.comments || 0; outcome.late = [];
          return p.later.reduce(function (c2, m) {
            return c2.then(function () {
              if (m.size > MAX_FILE) { outcome.late.push({ path: m.path, why: 'it is larger than 3 MB' }); return; }
              return post({ mode: 'attach', key: item.key, material: wire(m) }).catch(function (e) { outcome.late.push({ path: m.path, why: e.message }); });
            });
          }, Promise.resolve());
        }, function (error) { outcome.state = 'refused'; outcome.error = error.message; }).then(function () { done.push(outcome); progress(n + 1, item); });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  /* What the receipt says, from the outcomes: counts, then every note, grouped. */
  function receipt(result, outcomes) {
    var count = function (state) { return outcomes.filter(function (o) { return o.state === state; }).length; };
    var converted = {}, dropped = {};
    outcomes.forEach(function (o) {
      (o.item.report.converted || []).forEach(function (n) { var k = n.what + '\u0000' + n.why; converted[k] = (converted[k] || 0) + n.count; });
      (o.item.report.dropped || []).forEach(function (n) { var k = n.what + '\u0000' + n.why; dropped[k] = (dropped[k] || 0) + n.count; });
      (o.kept || []).forEach(function (path) { var k = baseOf(path) + '\u0000your changed copy in Descant was kept'; dropped[k] = (dropped[k] || 0) + 1; });
      (o.late || []).forEach(function (l) { var k = baseOf(l.path) + ' (' + o.item.title + ')\u0000' + l.why; dropped[k] = (dropped[k] || 0) + 1; });
      if (o.state === 'refused') { var k = '“' + o.item.title + '”\u0000' + o.error; dropped[k] = (dropped[k] || 0) + 1; }
    });
    (result.notes || []).forEach(function (n) { var k = n.what + '\u0000' + n.why, map = n.converted ? converted : dropped; map[k] = (map[k] || 0) + 1; });
    function rows(map) { return Object.keys(map).map(function (k) { var p = k.split('\u0000'); return { what: p[0], why: p[1], count: map[k] }; }); }
    return { label: result.label, created: count('created'), updated: count('updated'), same: count('same'), kept: count('kept'),
      refused: count('refused'), converted: rows(converted), notConverted: rows(dropped), outcomes: outcomes };
  }


  /* ------------------------------------------------------------ the sheet */

  /* The import view takes the Files panel's body (phone sheet or laptop card) until
     Back. States: start, reading, preview, importing, receipt. */
  var view = { body: null, stage: 'start', result: null, outcomes: null, error: '', at: 0, onClose: null, busy: false };
  function el(tag, cls, text) {
    var n = global.document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function phone() { var app = global.document.getElementById('app'); return !!(app && app.dataset.mode === 'phone'); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var STATE_WORDS = { 'new': 'New', update: 'Update', same: 'Already here', edited: 'Changed in Descant' };
  var DONE_WORDS = { created: 'Imported', updated: 'Updated', same: 'Already here', kept: 'Your text kept', refused: 'Not imported' };

  function active() { return !!view.body; }
  function mount(body, onClose) { view.body = body; view.onClose = onClose || null; render(); }
  function close() {
    if (view.busy) return;
    var done = view.onClose;
    view = { body: null, stage: 'start', result: null, outcomes: null, error: '', at: 0, onClose: null, busy: false };
    if (done) done();
  }
  function setStage(stage) { view.stage = stage; render(); }

  function choose(folder) {
    var input = el('input');
    input.type = 'file';
    input.hidden = true;
    if (folder) { input.webkitdirectory = true; input.multiple = true; }
    else {
      input.multiple = true;
      // iOS greys out any file whose type it does not know (.ulyz), so the phone takes every file.
      if (!phone()) input.accept = '.zip,.ulyz,.md';
    }
    input.addEventListener('change', function () {
      var files = input.files;
      input.remove();
      if (!files || !files.length) return;
      view.error = ''; setStage('reading');
      fromFiles(files).then(read).then(plan).then(function (result) {
        view.result = result; setStage('preview');
      }).catch(function (error) {
        view.error = (error && error.message) || 'This could not be read.'; setStage('start');
      });
    });
    (view.body || global.document.body).appendChild(input);
    input.click();
  }

  function start() {
    view.busy = true; view.at = 0; setStage('importing');
    apply(view.result, function (n) { view.at = n; render(); }).then(function (outcomes) {
      view.busy = false; view.outcomes = outcomes; setStage('receipt');
      if (Castor.pieces && Castor.pieces.refresh) Castor.pieces.refresh();
    }, function (error) {
      view.busy = false; view.error = error.message; setStage('preview');
    });
  }

  function head(parent, title) {
    var top = el('div', 'import-top');
    top.appendChild(button('import-back', 'Files', close));
    parent.appendChild(top);
    parent.appendChild(el('h3', 'import-title', title));
  }

  function itemRow(item, state, extra) {
    var row = el('li', 'import-row');
    var name = el('span', 'import-name', item.title);
    row.appendChild(name);
    row.appendChild(el('span', 'import-state import-state-' + state, extra || STATE_WORDS[state] || DONE_WORDS[state] || state));
    return row;
  }
  function groupedList(items, rowFor) {
    var list = el('div', 'import-groups'), last = null, ul = null;
    items.forEach(function (item) {
      var group = item.group || '';
      if (!ul || group !== last) {
        if (group) list.appendChild(el('p', 'import-group', group));
        ul = el('ul', 'import-list'); list.appendChild(ul); last = group;
      }
      ul.appendChild(rowFor(item));
    });
    return list;
  }
  function notesList(rows, title) {
    var box = el('section', 'import-notes');
    box.appendChild(el('h4', 'import-notes-title', title));
    var ul = el('ul', 'import-note-list');
    rows.forEach(function (r) {
      var li = el('li', 'import-note');
      li.appendChild(el('span', 'import-note-what', r.what + (r.count > 1 ? ' (' + r.count + ')' : '')));
      li.appendChild(el('span', 'import-note-why', r.why));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  function render() {
    var body = view.body;
    if (!body) return;
    body.textContent = '';
    var box = el('div', 'import-view');
    box.setAttribute('aria-live', 'polite');
    body.appendChild(box);
    if (view.stage === 'start') {
      head(box, 'Import');
      box.appendChild(el('p', 'import-lead', 'Bring in a Ulysses library or an Obsidian vault. Descant reads a copy and never changes the original.'));
      var actions = el('div', 'import-actions');
      if (!phone()) actions.appendChild(button('import-pill import-primary', 'Choose a folder', function () { choose(true); }));
      actions.appendChild(button('import-pill' + (phone() ? ' import-primary' : ''), phone() ? 'Choose a file' : 'Choose a .zip or .ulyz', function () { choose(false); }));
      box.appendChild(actions);
      box.appendChild(el('p', 'import-hint', phone()
        ? 'A .zip of the library or vault, or a .ulyz export. Importing again later adds only what changed.'
        : 'The library or vault folder, a .zip of it, or a .ulyz export. Importing again later adds only what changed.'));
      if (view.error) box.appendChild(el('p', 'import-error', view.error));
      return;
    }
    if (view.stage === 'reading') {
      head(box, 'Import');
      var reading = el('p', 'import-progress castor-pending', 'Reading');
      reading.setAttribute('aria-busy', 'true');
      box.appendChild(reading);
      return;
    }
    var result = view.result;
    if (view.stage === 'preview') {
      var items = result.items, count = function (s) { return items.filter(function (i) { return i.state === s; }).length; };
      var fresh = count('new'), update = count('update'), edited = count('edited'), same = count('same');
      head(box, result.label === 'Ulysses' ? 'From Ulysses' : result.label === 'Obsidian' ? 'From Obsidian' : 'From Markdown files');
      var parts = [];
      if (fresh) parts.push(plural(fresh, 'new article', 'new articles'));
      if (update) parts.push(plural(update, 'update', 'updates'));
      if (edited) parts.push(plural(edited, 'you changed here', 'you changed here'));
      if (same) parts.push(same + ' already here');
      box.appendChild(el('p', 'import-lead', items.length ? parts.join(', ') + '.' : 'Nothing to import.'));
      if (edited) box.appendChild(el('p', 'import-hint', 'Articles you changed in Descant keep your words; the newer text goes beside them in Versions.'));
      var go = el('div', 'import-actions');
      var todo = fresh + update + edited;
      if (todo) go.appendChild(button('import-pill import-primary', 'Import ' + todo, start));
      go.appendChild(button('import-pill', todo ? 'Cancel' : 'Done', close));
      box.appendChild(go);
      if (view.error) box.appendChild(el('p', 'import-error', view.error));
      box.appendChild(groupedList(items, function (item) { return itemRow(item, item.state); }));
      return;
    }
    if (view.stage === 'importing') {
      head(box, 'Importing');
      var all = result.items.length, current = result.items[Math.min(view.at, all - 1)];
      var line = el('p', 'import-progress castor-pending', view.at + ' of ' + all + (current ? ': ' + current.title : ''));
      line.setAttribute('aria-busy', 'true');
      box.appendChild(line);
      var track = el('div', 'import-track'), fill = el('span', 'import-fill');
      fill.style.transform = 'scaleX(' + (all ? view.at / all : 0) + ')';
      track.appendChild(fill); box.appendChild(track);
      box.appendChild(el('p', 'import-hint', 'Each article is saved on its own. If this stops, import again: what came in stays, and nothing is doubled.'));
      return;
    }
    var r = receipt(result, view.outcomes);
    head(box, 'Imported');
    var sums = [];
    if (r.created) sums.push(plural(r.created, 'new article', 'new articles'));
    if (r.updated) sums.push(r.updated + ' updated');
    if (r.kept) sums.push(plural(r.kept, 'kept your text', 'kept your text') + ' (the newer one is in Versions)');
    if (r.same) sums.push(r.same + ' already here');
    if (r.refused) sums.push(r.refused + ' not imported');
    box.appendChild(el('p', 'import-lead', (sums.join(', ') || 'Nothing changed') + '.'));
    var end = el('div', 'import-actions');
    var first = r.outcomes.filter(function (o) { return o.path && o.state !== 'refused'; })[0];
    if (first && Castor.pieces && Castor.pieces.open) end.appendChild(button('import-pill import-primary', 'Open “' + titleFrom(first.item.title).slice(0, 40) + '”', function () {
      var path = first.path; close();
      Promise.resolve(Castor.pieces.open(path)).then(function (ok) { if (ok && phone() && Castor.panels && Castor.panels.close) Castor.panels.close('files'); });
    }));
    end.appendChild(button('import-pill', 'Done', close));
    box.appendChild(end);
    // What did not come across leads: it is what the writer may want to go back for.
    if (r.notConverted.length) box.appendChild(notesList(r.notConverted, 'Not brought across'));
    if (r.converted.length) box.appendChild(notesList(r.converted, 'Converted'));
    box.appendChild(groupedList(r.outcomes.map(function (o) { return o.item; }), function (item) {
      var o = r.outcomes.filter(function (x) { return x.item === item; })[0];
      var row = itemRow(item, o.state);
      if (o.path && o.state !== 'refused' && Castor.pieces && Castor.pieces.open) {
        row.classList.add('import-row-open');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        var open = function () { var path = o.path; close(); Castor.pieces.open(path); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
      return row;
    }));
  }

  var api = {
    readZip: readZip, fromFiles: fromFiles, plist: plist, xml: xml, sha256: sha256, base64: base64,
    detect: detect, read: read, ulysses: ulysses, obsidian: obsidian, finish: finish, payload: payload,
    plan: plan, apply: apply, receipt: receipt, joinLines: joinLines, frontMatter: frontMatter,
    mount: mount, close: close, active: active, render: render, _view: function () { return view; }
  };
  Castor.importer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
