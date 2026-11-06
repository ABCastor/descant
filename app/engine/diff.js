(function (root) {
  'use strict';

  const Castor = root.Castor || (root.Castor = {});

  // Tokens are words or punctuation with their leading whitespace attached. This
  // keeps LCS matching about prose, not interchangeable spaces, while concatenating
  // the returned operations still reconstructs each input byte for byte.
  function tokens(value) {
    const parts = String(value).match(/\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu) || [];
    const result = [];
    let whitespace = '';
    for (const part of parts) {
      if (/^\s+$/.test(part)) {
        whitespace += part;
      } else {
        result.push(whitespace + part);
        whitespace = '';
      }
    }
    if (whitespace) result.push(whitespace);
    return result;
  }

  function appendOp(ops, op, text) {
    if (!text) return;
    const previous = ops.at(-1);
    if (previous && previous.op === op) previous.text += text;
    else ops.push({ op, text });
  }

  function words(a, b) {
    const oldTokens = tokens(a);
    const newTokens = tokens(b);
    const rows = oldTokens.length + 1;
    const columns = newTokens.length + 1;
    const lcs = Array.from({ length: rows }, () => new Uint32Array(columns));

    for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
        lcs[oldIndex][newIndex] = oldTokens[oldIndex] === newTokens[newIndex]
          ? lcs[oldIndex + 1][newIndex + 1] + 1
          : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
      }
    }

    const ops = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
      if (oldTokens[oldIndex] === newTokens[newIndex]) {
        appendOp(ops, 'eq', oldTokens[oldIndex]);
        oldIndex += 1;
        newIndex += 1;
      } else if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
        appendOp(ops, 'del', oldTokens[oldIndex]);
        oldIndex += 1;
      } else {
        appendOp(ops, 'ins', newTokens[newIndex]);
        newIndex += 1;
      }
    }
    while (oldIndex < oldTokens.length) appendOp(ops, 'del', oldTokens[oldIndex++]);
    while (newIndex < newTokens.length) appendOp(ops, 'ins', newTokens[newIndex++]);
    return ops;
  }

  function significantCount(text) {
    return tokens(text).filter((token) => token.trim()).length;
  }

  function editRuns(ops) {
    let runs = 0;
    let editing = false;
    for (const entry of ops) {
      if (entry.op === 'eq') {
        if (entry.text.trim()) editing = false;
      } else if (!editing && entry.text.trim()) {
        runs += 1;
        editing = true;
      }
    }
    return runs;
  }

  function lightEdit(oldText, newText, ops) {
    const changed = ops
      .filter((entry) => entry.op !== 'eq')
      .reduce((total, entry) => total + significantCount(entry.text), 0);
    const total = significantCount(oldText) + significantCount(newText);
    const ratio = total ? changed / total : 0;
    // The product rule is strict: no more than two contiguous edit runs and less
    // than 20% of the combined old/new prose tokens participating in the change.
    return changed > 0 && editRuns(ops) <= 2 && ratio < 0.2;
  }

  // A replacement is the one shape the margin can honestly show as `before -> after`:
  // a single deleted run immediately followed by a single inserted run, each of them
  // short enough to read as a swap rather than a rewrite. Anything longer, or any run
  // that stands alone (a pure cut, a pure insertion), is left to the in-page marks.
  const REPLACEMENT_WORDS = 4;

  function runWords(text) {
    return tokens(text).filter((token) => token.trim()).length;
  }

  function replacements(ops) {
    const result = [];
    let newOffset = 0;
    for (let index = 0; index < ops.length; index += 1) {
      const entry = ops[index];
      if (entry.op === 'ins') { newOffset += entry.text.length; continue; }
      if (entry.op === 'eq') { newOffset += entry.text.length; continue; }

      // entry is a del; runs of the same op are already merged by appendOp, so the
      // only thing that can follow a del is an eq or an ins.
      const next = ops[index + 1];
      if (!next || next.op !== 'ins') continue;
      const from = entry.text.trim();
      const to = next.text.trim();
      if (from && to &&
          runWords(from) <= REPLACEMENT_WORDS && runWords(to) <= REPLACEMENT_WORDS) {
        result.push({ from, to, at: newOffset });
      }
      newOffset += next.text.length;
      index += 1;                       // the ins is consumed with its del
    }
    return result;
  }

  function comparableTokens(block) {
    return tokens(block && block.text || '')
      .map((token) => token.trim().toLocaleLowerCase())
      .filter(Boolean);
  }

  function similarity(oldBlock, newBlock) {
    if (!oldBlock || !newBlock) return 0;
    const oldHeading = /^h[1-6]$/.test(oldBlock.type);
    const newHeading = /^h[1-6]$/.test(newBlock.type);
    if (oldBlock.type !== newBlock.type && !(oldHeading && newHeading)) return 0;
    const a = comparableTokens(oldBlock);
    const b = comparableTokens(newBlock);
    if (!a.length || !b.length) return oldBlock.text === newBlock.text ? 1 : 0;
    const counts = new Map();
    for (const token of a) counts.set(token, (counts.get(token) || 0) + 1);
    let overlap = 0;
    for (const token of b) {
      const remaining = counts.get(token) || 0;
      if (remaining) {
        overlap += 1;
        counts.set(token, remaining - 1);
      }
    }
    return 2 * overlap / (a.length + b.length);
  }

  function pairBlocks(oldBlocks, newBlocks) {
    const pairedOld = new Set();
    const pairedNew = new Set();
    const pairs = [];

    // Exact prose is paired before the similarity pass. This is what makes a
    // paragraph moved across another paragraph remain the same paragraph.
    const exact = [];
    for (let oldIndex = 0; oldIndex < oldBlocks.length; oldIndex += 1) {
      for (let newIndex = 0; newIndex < newBlocks.length; newIndex += 1) {
        if (oldBlocks[oldIndex].type === newBlocks[newIndex].type && oldBlocks[oldIndex].text === newBlocks[newIndex].text) {
          exact.push({ oldIndex, newIndex, distance: Math.abs(oldIndex - newIndex) });
        }
      }
    }
    exact.sort((a, b) => a.distance - b.distance || a.newIndex - b.newIndex || a.oldIndex - b.oldIndex);
    for (const candidate of exact) {
      if (pairedOld.has(candidate.oldIndex) || pairedNew.has(candidate.newIndex)) continue;
      pairedOld.add(candidate.oldIndex);
      pairedNew.add(candidate.newIndex);
      pairs.push(candidate);
    }

    const candidates = [];
    for (let oldIndex = 0; oldIndex < oldBlocks.length; oldIndex += 1) {
      if (pairedOld.has(oldIndex)) continue;
      for (let newIndex = 0; newIndex < newBlocks.length; newIndex += 1) {
        if (pairedNew.has(newIndex)) continue;
        const score = similarity(oldBlocks[oldIndex], newBlocks[newIndex]);
        if (score >= 0.24) candidates.push({ oldIndex, newIndex, score, distance: Math.abs(oldIndex - newIndex) });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || a.newIndex - b.newIndex);
    for (const candidate of candidates) {
      if (pairedOld.has(candidate.oldIndex) || pairedNew.has(candidate.newIndex)) continue;
      pairedOld.add(candidate.oldIndex);
      pairedNew.add(candidate.newIndex);
      pairs.push(candidate);
    }
    return { pairs, pairedOld, pairedNew };
  }

  function stayedInOrder(pairs) {
    const order = pairs.slice().sort((a, b) => a.newIndex - b.newIndex);
    const values = order.map((pair) => pair.oldIndex);
    const n = values.length;
    const stayed = new Set();
    if (!n) return stayed;

    // best[i] = length of the longest increasing run that STARTS at i.
    const best = new Array(n).fill(1);
    for (let i = n - 2; i >= 0; i -= 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (values[j] > values[i] && best[j] + 1 > best[i]) best[i] = best[j] + 1;
      }
    }
    let longest = 0;
    for (let i = 0; i < n; i += 1) longest = Math.max(longest, best[i]);

    let need = longest;
    let last = -Infinity;
    for (let i = 0; i < n && need > 0; i += 1) {
      if (values[i] > last && best[i] === need) {
        stayed.add(order[i].newIndex);
        last = values[i];
        need -= 1;
      }
    }
    return stayed;
  }

  function changeForPair(oldBlock, newBlock, oldIndex, newIndex, moved) {
    const ops = words(oldBlock.text, newBlock.text);
    const sameText = oldBlock.text === newBlock.text;
    let kind;
    if (moved) kind = 'moved';
    else if (sameText) kind = 'same';
    else kind = lightEdit(oldBlock.text, newBlock.text, ops) ? 'light' : 'dense';
    const lightLike = sameText || lightEdit(oldBlock.text, newBlock.text, ops);
    return {
      blockId: newBlock.id,
      kind,
      ops,
      replacements: lightLike ? replacements(ops) : [],
      movedFrom: moved ? oldIndex : null,
      summary: null
    };
  }

  function blocks(oldBlocks, newBlocks) {
    const oldList = Array.isArray(oldBlocks) ? oldBlocks : [];
    const newList = Array.isArray(newBlocks) ? newBlocks : [];
    const pairing = pairBlocks(oldList, newList);
    const byNew = new Map(pairing.pairs.map((pair) => [pair.newIndex, pair]));
    const stayed = stayedInOrder(pairing.pairs);
    const result = [];

    for (let newIndex = 0; newIndex < newList.length; newIndex += 1) {
      const pair = byNew.get(newIndex);
      if (pair) {
        result.push(changeForPair(oldList[pair.oldIndex], newList[newIndex],
          pair.oldIndex, newIndex, !stayed.has(newIndex)));
      } else {
        result.push({
          blockId: newList[newIndex].id,
          kind: 'added',
          ops: newList[newIndex].text ? [{ op: 'ins', text: newList[newIndex].text }] : [],
          replacements: [],
          movedFrom: null,
          summary: null
        });
      }
    }

    for (let oldIndex = 0; oldIndex < oldList.length; oldIndex += 1) {
      if (pairing.pairedOld.has(oldIndex)) continue;
      result.push({
        blockId: oldList[oldIndex].id,
        kind: 'removed',
        ops: oldList[oldIndex].text ? [{ op: 'del', text: oldList[oldIndex].text }] : [],
        replacements: [],
        movedFrom: oldIndex,
        summary: null
      });
    }
    return result;
  }

  /* --- versions side by side (round 1035) ---------------------------------------
     Rows for reading the article (A) beside up to two other versions. Each row
     holds a run of A's paragraphs and, per version, the paragraphs that answer
     them: one to one, a split (one A paragraph, two in B), a join (two in A, one
     in B), a rewrite in the same place, or a paragraph only one side has. */

  function joined(list, indices) {
    return { type: list[indices[0]].type, text: indices.map((i) => list[i].text).join(' ') };
  }

  // Widen a pair over a free neighbour while the joined text reads closer.
  function widen(row, side, list, used, other) {
    if (row[side === 'a' ? 'x' : 'a'].length > 1) return;
    const score = (indices) => side === 'a'
      ? similarity(joined(list, indices), joined(other, row.x))
      : similarity(joined(other, row.a), joined(list, indices));
    for (const step of [1, -1]) {
      for (;;) {
        const edge = step > 0 ? row[side][row[side].length - 1] + 1 : row[side][0] - 1;
        if (edge < 0 || edge >= list.length || used.has(edge) || list[edge].type !== list[row[side][0]].type) break;
        const wider = step > 0 ? row[side].concat(edge) : [edge].concat(row[side]);
        if (score(wider) <= score(row[side]) + 0.02) break;
        row[side] = wider;
        used.add(edge);
      }
    }
  }

  function alignTwo(a, x) {
    const { pairs } = pairBlocks(a, x);
    const stayed = stayedInOrder(pairs);
    const anchors = pairs.filter((pair) => stayed.has(pair.newIndex))
      .sort((p, q) => p.oldIndex - q.oldIndex)
      .map((pair) => ({ a: [pair.oldIndex], x: [pair.newIndex] }));
    const usedA = new Set(anchors.map((row) => row.a[0]));
    const usedX = new Set(anchors.map((row) => row.x[0]));
    for (const row of anchors) { widen(row, 'x', x, usedX, a); widen(row, 'a', a, usedA, x); }
    const kind = (block) => /^h[1-6]$/.test(block.type) ? 'h' : block.type;
    const rows = [];
    let lastA = -1, lastX = -1;
    for (const anchor of anchors.concat({ a: [a.length], x: [x.length], end: true })) {
      const gapA = [], gapX = [];
      for (let i = lastA + 1; i < anchor.a[0]; i += 1) gapA.push(i);
      for (let j = lastX + 1; j < anchor.x[0]; j += 1) gapX.push(j);
      if (gapA.length && gapX.length) {
        // The same place, rewritten: pair in order when the shapes match, else one row.
        if (gapA.length === gapX.length && gapA.every((i, k) => kind(a[i]) === kind(x[gapX[k]]))) {
          gapA.forEach((i, k) => rows.push({ a: [i], x: [gapX[k]] }));
        } else rows.push({ a: gapA, x: gapX });
      } else {
        gapA.forEach((i) => rows.push({ a: [i], x: [] }));
        gapX.forEach((j) => rows.push({ a: [], x: [j], at: anchor.a[0] }));
      }
      if (anchor.end) break;
      rows.push(anchor);
      lastA = anchor.a[anchor.a.length - 1];
      lastX = anchor.x[anchor.x.length - 1];
    }
    return rows;
  }

  const NOTE = /^\[\^([^\]\s]+)\]:/;
  // Footnotes pair by their label, wherever they sit; the prose pairs in order.
  function alignWithNotes(a, x) {
    const prose = (list) => list.map((b, i) => i).filter((i) => !NOTE.test(list[i].source || ''));
    const pa = prose(a), px = prose(x);
    const rows = alignTwo(pa.map((i) => a[i]), px.map((j) => x[j])).map((row) => ({
      a: row.a.map((k) => pa[k]), x: row.x.map((k) => px[k]),
      at: row.at == null ? undefined : row.at < pa.length ? pa[row.at] : pa.length ? pa[pa.length - 1] + 1 : 0
    }));
    const label = (b) => (NOTE.exec(b.source || '') || [])[1];
    const notesX = new Map(x.map((b, j) => [label(b), j]).filter(([name]) => name));
    a.forEach((b, i) => {
      const name = label(b);
      if (!name) return;
      rows.push({ a: [i], x: notesX.has(name) ? [notesX.get(name)] : [] });
      notesX.delete(name);
    });
    notesX.forEach((j) => rows.push({ a: [], x: [j], at: a.length }));
    return rows;
  }

  // [{ a: [A indices], cells: [[indices in each other version]], at (rows with no A) }]
  function align(base, others) {
    const per = others.map((other) => alignWithNotes(base, other));
    const together = new Array(base.length).fill(false);
    // A row holds one run of A: a footnote between two paragraphs B joins goes into their row.
    per.forEach((rows) => rows.forEach((row) => {
      if (row.a.length < 2) return;
      for (let i = Math.min(...row.a) + 1; i <= Math.max(...row.a); i += 1) together[i] = true;
    }));
    const empty = () => others.map(() => []);
    const owner = new Map(), segments = [];
    base.forEach((block, i) => {
      if (i && together[i]) segments[segments.length - 1].a.push(i);
      else segments.push({ a: [i], cells: empty() });
      owner.set(i, segments[segments.length - 1]);
    });
    const inserts = new Map();
    per.forEach((list, v) => list.forEach((row) => {
      if (row.a.length) { owner.get(row.a[0]).cells[v].push(...row.x); return; }
      const inside = owner.get(row.at);
      if (inside && inside.a[0] < row.at) { inside.cells[v].push(row.x[0]); return; }
      if (!inserts.has(row.at)) inserts.set(row.at, empty());
      inserts.get(row.at)[v].push(row.x[0]);
    }));
    const rows = [];
    const place = (at) => {
      const waiting = inserts.get(at) || [];
      const depth = Math.max(0, ...waiting.map((list) => list.length));
      for (let k = 0; k < depth; k += 1) rows.push({ a: [], at, cells: waiting.map((list) => list[k] == null ? [] : [list[k]]) });
    };
    segments.forEach((row) => {
      place(row.a[0]);
      row.cells.forEach((cell) => cell.sort((p, q) => p - q));
      rows.push(row);
    });
    place(base.length);
    return rows;
  }

  /* The article after the chosen takes. `blocks` is the article's parse without
     its front matter; `results` maps a row index to the version index taken there
     (absent: the article's own text). `results` is never changed.
     A taken paragraph brings what it cites and the article lacks:
     - a footnote the article lacks: that footnote's row comes along (reported in `info.carried`);
     - a footnote whose label the article uses for another note: it gets its own label, `[^1-b]`;
     - a reference-link definition only its version has: added at the end;
     - a link label the article defines with another URL: its own label, `[r-b]`.
     A retake finds the note or link already here and cites it again. */
  const LINK_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*\S.*$/gm;
  const linkKey = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const linkDest = (def) => def.slice(def.indexOf(']:') + 2).trim().replace(/\s+/g, ' ');
  // [text][label], [label][] and [label], but not [^note], [text](url) or [label]:.
  const LINK_REF = /\[([^\]]*)\]\[([^\]]*)\]|\[([^\]^][^\]]*)\](?![[(:])/g;
  const noteBody = (text) => text.replace(/^\[\^[^\]\s]+\]:/, '').replace(/\s+/g, ' ').trim();
  function compose(source, blocks, rows, results, versions, info) {
    const body = blocks.map((b) => b.sep + b.source).join('');
    const at = source.indexOf(body);
    if (at < 0) throw new Error('The article text could not be laid out for comparison.');
    const head = source.slice(0, at), tail = source.slice(at + body.length);
    const chosen = Object.assign({}, results), carried = {};
    const taken = (r) => typeof chosen[r] === 'number';
    const before = new Map(), rowOfA = new Map();
    rows.forEach((row, r) => {
      if (row.a.length) row.a.forEach((i) => rowOfA.set(i, r));
      else before.set(row.at, (before.get(row.at) || []).concat(r));
    });
    const noteOf = (v, label) => versions[v].find((b) => b.source.startsWith('[^' + label + ']:'));
    for (let round = 0; round < 8; round += 1) {
      const pieces = [];
      const emit = (r) => rows[r].cells[chosen[r]].forEach((j) => pieces.push({ text: versions[chosen[r]][j].source, from: chosen[r] }));
      for (let i = 0; i <= blocks.length; i += 1) {
        (before.get(i) || []).forEach((r) => { if (taken(r)) emit(r); });
        if (i === blocks.length) break;
        const r = rowOfA.get(i);
        if (r != null && taken(r)) { if (rows[r].a[0] === i) emit(r); }
        else pieces.push({ text: blocks[i].source, own: i });
      }
      const notes = new Map();
      pieces.forEach((piece) => { const m = /^\[\^([^\]\s]+)\]:/.exec(piece.text); if (m && !notes.has(m[1])) notes.set(m[1], piece.text); });
      const missing = [], clash = new Map();
      pieces.forEach((piece) => {
        if (piece.from == null) return;
        for (const m of piece.text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
          const own = noteOf(piece.from, m[1]);
          if (!notes.has(m[1])) { notes.set(m[1], own ? own.source : ''); missing.push({ label: m[1], v: piece.from }); }
          else if (own && noteBody(notes.get(m[1])) !== noteBody(own.source)) clash.set(piece.from + ':' + m[1], { v: piece.from, label: m[1], note: own.source });
        }
      });
      let more = false;
      missing.forEach(({ label, v }) => {
        const j = versions[v].findIndex((b) => b.source.startsWith('[^' + label + ']:'));
        const r = rows.findIndex((row, k) => j >= 0 && !taken(k) && !row.a.length && row.cells[v].includes(j));
        if (r >= 0) { chosen[r] = v; carried[r] = v; more = true; }
      });
      if (more) continue;
      // Clashing labels: the taken text keeps citing its own source under a new label.
      const extra = [], used = new Set(notes.keys());
      const renamed = new Map();
      clash.forEach(({ v, label, note }, key) => {
        // Taken before: the note is already here under its own label, so cite that one.
        const same = [...notes].find(([, text]) => text && noteBody(text) === noteBody(note));
        if (same) { renamed.set(key, same[0]); return; }
        let name = label + '-' + 'bc'[v], n = 2;
        while (used.has(name)) name = label + '-' + 'bc'[v] + (n++);
        used.add(name); renamed.set(key, name);
        extra.push('[^' + name + ']:' + note.slice(('[^' + label + ']:').length));
      });
      pieces.forEach((piece) => {
        if (piece.from == null) return;
        piece.text = piece.text.replace(/\[\^([^\]\s]+)\](?!:)/g, (all, label) => renamed.has(piece.from + ':' + label) ? '[^' + renamed.get(piece.from + ':' + label) + ']' : all);
      });
      // Reference links a taken paragraph uses: a definition only its version has comes along;
      // a label the article uses for another URL gets its own label, as notes do.
      const links = new Map();
      pieces.forEach((piece) => { for (const m of piece.text.matchAll(LINK_DEF)) if (!links.has(linkKey(m[1]))) links.set(linkKey(m[1]), linkDest(m[0])); });
      pieces.forEach((piece) => {
        if (piece.from == null || /^\[\^/.test(piece.text)) return;
        const rename = new Map();
        const own = (key) => {
          for (const b of versions[piece.from]) { const def = [...b.source.matchAll(LINK_DEF)].find((m) => linkKey(m[1]) === key); if (def) return def[0]; }
          return null;
        };
        piece.text = piece.text.replace(LINK_REF, (all, text, ref, short) => {
          const label = short != null ? short : (ref || text), key = linkKey(label), def = own(key);
          if (!def) return all;
          const dest = linkDest(def);
          if (!links.has(key)) { links.set(key, dest); extra.push(def); return all; }
          if (links.get(key) === dest) return all;
          if (!rename.has(key)) {
            let name = [...links].filter(([, d]) => d === dest).map(([k]) => k)[0];
            if (name == null) {
              const stem = label.trim() + '-' + 'bc'[piece.from];
              let n = 2; name = stem;
              while (links.has(linkKey(name))) name = stem + (n++);
              links.set(linkKey(name), dest); extra.push('[' + name + ']: ' + dest);
            }
            rename.set(key, name);
          }
          return '[' + (short != null ? short : text) + '][' + rename.get(key) + ']';
        });
      });
      if (info) info.carried = carried;
      const sep = (piece, k) => k === 0 ? (blocks[0] ? blocks[0].sep : '') : piece.own > 0 ? blocks[piece.own].sep : '\n\n';
      return head + pieces.map((piece, k) => sep(piece, k) + piece.text).join('') + extra.map((text) => '\n\n' + text).join('') + tail;
    }
    throw new Error('The footnotes could not be settled.');
  }

  const api = { blocks, words, align, compose };
  Castor.diff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
