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

  const api = { blocks, words };
  Castor.diff = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
