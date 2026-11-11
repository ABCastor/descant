(function (root) {
  'use strict';

  const Castor = root.Castor || (root.Castor = {});
  const CALLOUTS = new Set(['note', 'tip', 'warning', 'info', 'quote', 'abstract', 'question', 'example']);
  const IMAGE_EXT = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;
  const AUDIO_EXT = /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#].*)?$/i;
  const VIDEO_EXT = /\.(?:m4v|mov|mp4|ogv|webm)(?:[?#].*)?$/i;
  const PDF_EXT = /\.pdf(?:[?#].*)?$/i;
  const FIGURE_LANGUAGES = new Set(['mermaid', 'chart', 'math']);
  // build.py inlines the sample's images as data URLs so a built world is one file
  // with no folder behind it. A base64 image URL has no extension to test, and it is
  // the ONE data: form allowed through: an <img> cannot run script, not even from an
  // SVG, and every other scheme still resolves to '#'.
  const IMAGE_DATA_URL = /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);base64,[A-Za-z0-9+/=\s]+$/i;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    let url = String(value).trim();
    if (IMAGE_DATA_URL.test(url)) return url;
    // URL parsing removes tabs/newlines and surrounding ASCII controls before
    // interpreting a scheme. Validate that spelling without rewriting source.
    const schemeUrl = url.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
    if (/^(?:javascript|vbscript|data):/i.test(schemeUrl)) return '#';
    // Only rendered destinations change. Editor source and selection offsets
    // remain exact canonical Markdown, including attachment links.
    let relative;
    try { relative = decodeURIComponent(url); } catch (e) { relative = ''; }
    if (relative && !/^(?:[a-z][a-z0-9+.-]*:|\/)|[\\\u0000-\u001f\u007f:#?]|(?:^|\/)\.{1,2}(?:\/|$)|\/\//i.test(relative)) {
      const piece = Castor.app && Castor.app.data && Castor.app.data.piece;
      const entries = piece && Array.isArray(piece.fileEntries) ? piece.fileEntries : [];
      const entry = entries.find(file => file && file.kind === 'file' && file.path === url);
      if (entry && typeof entry.url === 'string' && /^\/(?:write\/)?api\/files\/content\?/.test(entry.url)) url = entry.url;
    }
    if (Castor.role && Castor.role.publicWriter && /^\/api\/files\/content\?/.test(url)) return '/write' + url;
    return url;
  }

  function slug(text) {
    const result = String(text)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return result || 'section';
  }

  function scalar(value) {
    const raw = value.trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null' || raw === '~') return null;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    if ((raw[0] === '"' && raw.at(-1) === '"') || (raw[0] === "'" && raw.at(-1) === "'")) {
      if (raw[0] === '"') { try { return JSON.parse(raw); } catch (e) { /* legacy YAML */ } }
      return raw.slice(1, -1).replace(/''/g, "'");
    }
    if (raw[0] === '[' && raw.at(-1) === ']') {
      return raw.slice(1, -1).split(',').map((part) => scalar(part));
    }
    return raw;
  }

  function parseFrontmatter(lines) {
    const value = {};
    let key = null;
    for (const line of lines) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (match) { key = match[1]; value[key] = scalar(match[2]); }
      else if (key && /^\s+-\s+/.test(line) && (value[key] === '' || Array.isArray(value[key]))) {
        value[key] = (value[key] || []).concat(scalar(line.replace(/^\s+-\s+/, '')));
      }
    }
    return value;
  }

  function headingMatch(line) {
    const match = /^(#{1,6})[ \t](.+?)\s*$/.exec(line);
    if (!match) return null;
    return { level: match[1].length, text: match[2].replace(/[ \t]+#+[ \t]*$/, '') };
  }

  function fenceMatch(line) {
    const match = /^\s{0,3}(`{3,}|~{3,})(?:[ \t]*([^\s`]+))?(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    return match ? { marker: match[1], lang: match[2] || '', info: match[3] || '' } : null;
  }

  function listMatch(line) {
    const match = /^(\s*)([-+*]|\d+[.)])[ \t](.*)$/.exec(line);
    if (!match) return null;
    return {
      indent: match[1].replace(/\t/g, '    ').length,
      ordered: /^\d/.test(match[2]),
      marker: match[2],
      content: match[3]
    };
  }

  function isHr(line) {
    const text = line.trim();
    return /^(?:\*\s*){3,}$/.test(text) || /^(?:-\s*){3,}$/.test(text) || /^(?:_\s*){3,}$/.test(text);
  }

  function isTableStart(lines, index) {
    if (index + 1 >= lines.length || /^[ \t]{4}|^ *\t/.test(lines[index]) || /^[ \t]{4}|^ *\t/.test(lines[index + 1]) || /^ {0,3}(?:-+|=+)[ \t]*$/.test(lines[index + 1]) || listMatch(lines[index + 1])) return false;
    if (!/^ {0,3}[|: \t-]+[ \t]*$/.test(lines[index + 1])) return false;
    const cells = splitTableRow(lines[index + 1]);
    // GFM accepts one or more dashes and a one-column header without a pipe.
    // Both rows must still have the same number of cells.
    return cells.length === splitTableRow(lines[index]).length && cells.every(cell => /^:?-+:?$/.test(cell.trim()));
  }

  function htmlBlockEnd(line, interrupt) {
    const special = /^ {0,3}<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(line);
    if (special) return new RegExp('</' + special[1].toLowerCase() + '>');
    if (/^ {0,3}<!--/.test(line)) return /-->/;
    if (/^ {0,3}<\?/.test(line)) return /\?>/;
    if (/^ {0,3}<!\[CDATA\[/.test(line)) return /\]\]>/;
    if (/^ {0,3}<![A-Z]/.test(line)) return />/;
    if (/^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$)/i.test(line)) return /^[ \t]*$/;
    if (!interrupt && /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/.test(line)) return /^[ \t]*$/;
    return null;
  }

  function referenceText(value) {
    return String(value).replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  }

  // Decode Markdown escapes and entities in one pass. An escaped ampersand
  // cannot become the start of an entity during a second decoding pass.
  function destinationText(value) {
    return String(value).replace(/\\([!-/:-@\[-`{-~])|&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, escaped) => {
      if (escaped) return escaped;
      const entity = whole.slice(1, -1);
      if (entity[0] !== '#') return HTML_ENTITIES[entity] || whole;
      const n = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return String.fromCodePoint(!n || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff || n < 0x20 && ![9, 10, 13].includes(n) || n >= 0x7f && n <= 0x9f ? 0xfffd : n);
    });
  }

  function inlineDestination(text, start) {
    const closing = findParenClose(text, start);
    if (closing >= 0 && safeUrl(destinationText(text.slice(start, closing))) === '#') return { end: closing, destination: '#' };
    let at = start;
    while (/[ \t\r\n]/.test(text[at] || '') && at < text.length) at++;
    let destination = '', title;
    if (text[at] === '<') {
      const begin = ++at;
      for (; at < text.length && text[at] !== '>'; at++) {
        if (text[at] === '\\' && /[!-/:-@\[-`{-~]/.test(text[at + 1] || '')) at++;
        else if (/[<\r\n]/.test(text[at])) return null;
      }
      if (text[at] !== '>') return null;
      destination = text.slice(begin, at++);
    } else {
      const begin = at;
      let depth = 0;
      for (; at < text.length; at++) {
        if (text[at] === '\\' && /[!-/:-@\[-`{-~]/.test(text[at + 1] || '')) { at++; continue; }
        if (/[\x00-\x20]/.test(text[at])) break;
        if (text[at] === '(') depth++;
        if (text[at] === ')' && depth-- === 0) break;
      }
      if (depth > 0) return null;
      destination = text.slice(begin, at);
    }
    const stop = at;
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
    if (at > stop && /["'(]/.test(text[at] || '') && text[at]) {
      const closer = text[at] === '(' ? ')' : text[at], begin = ++at;
      for (; at < text.length && text[at] !== closer; at++) {
        if (text[at] === '\\' && /[!-/:-@\[-`{-~]/.test(text[at + 1] || '')) at++;
        else if (closer === ')' && text[at] === '(' || /\n[ \t]*\n/.test(text.slice(at, at + 16))) return null;
      }
      if (text[at] !== closer) return null;
      title = destinationText(text.slice(begin, at++));
      while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
    }
    return text[at] === ')' ? { end: at, destination: destinationText(destination), title } : null;
  }

  function referenceLabel(value) {
    return referenceText(value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  // A link reference definition may spread over lines, as on the site (CommonMark): its
  // destination on the line after the label, its title on the line after the destination or
  // over several lines, never across a blank line. The longest such run is the definition.
  const REFERENCE_SPAN = /^ {0,3}\[((?:\\.|[^\]\\\r\n])+)\]:[ \t]*(?:\n[ \t]*)?(?:<([^<>\r\n]*)>|(\S+?))(?:(?:[ \t]+|[ \t]*\n[ \t]*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?[ \t\r]*$/;
  function referenceSpan(lines, index) {
    const line = lines[index];
    if (line == null || !/^ {0,3}\[(?:\\.|[^\]\\\r\n])+\]:/.test(line)) return null;
    let last = index;
    while (last + 1 < lines.length && lines[last + 1].trim() !== '' && last - index < 20) last++;
    for (let end = last; end >= index; end--) {
      const match = REFERENCE_SPAN.exec(lines.slice(index, end + 1).join('\n'));
      if (!match || match[1][0] === '^' || !referenceLabel(match[1])) continue;
      if (match[3] && (/[<>]/.test(match[3]) || findParenClose('(' + match[3] + ')', 1) !== match[3].length + 1)) continue;
      const title = match[4] ?? match[5] ?? match[6];
      return { end: end + 1, reference: { referenceKey: referenceLabel(match[1]), destination: destinationText(match[2] ?? match[3]), ...(title === undefined ? {} : { title: destinationText(title) }) } };
    }
    return null;
  }

  function referenceInsideCode(lines, start, index) {
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== '') end += 1;
    const text = lines.slice(start, end).join('\n');
    const boundary = lines.slice(start, index).join('\n').length + 1;
    for (let at = 0; at < boundary; at += 1) {
      if (text[at] === '\\') { at += 1; continue; }
      if (text[at] !== '`') continue;
      let ticks = 1;
      while (text[at + ticks] === '`') ticks += 1;
      const close = findClosing(text, '`'.repeat(ticks), at + ticks);
      if (close >= boundary) return true;
      if (close >= 0) at = close + ticks - 1;
      else at += ticks - 1;
    }
    return false;
  }

  function isBlockStart(lines, index, paragraphStart) {
    const line = lines[index] || '';
    return Boolean(
      headingMatch(line) || fenceMatch(line) || (listMatch(line) && (paragraphStart == null || listMatch(line).indent < 4)) || (isHr(line) && !/^(?: {4}| {0,3}\t)/.test(line)) ||
      /^\s{0,3}>/.test(line) || /^\[\^[^\]]+\]:/.test(line) ||
      // A link reference definition cannot interrupt a paragraph (CommonMark, and the site).
      (paragraphStart == null && referenceSpan(lines, index) && !referenceInsideCode(lines, paragraphStart, index)) ||
      isTableStart(lines, index) || htmlBlockEnd(line, true) || /^\s*!\[\[[\s\S]+\]\]\s*$/.test(line)
    );
  }

  // Block structure is deliberately scanned line by line. Fences, list indentation,
  // quoted containers and definition continuations each have explicit states.
  function scan(source, allowFrontmatter, references) {
    const lines = String(source).split('\n');
    const blocks = [];
    let frontmatter = {};
    let index = 0;

    if (allowFrontmatter && lines[0] === '---') {
      let end = 1;
      while (end < lines.length && lines[end] !== '---') end += 1;
      if (end < lines.length) {
        const sourceLines = lines.slice(0, end + 1);
        frontmatter = parseFrontmatter(sourceLines.slice(1, -1));
        blocks.push({ type: 'frontmatter', source: sourceLines.join('\n'), text: '', meta: { value: frontmatter } });
        index = end + 1;
      }
    }

    while (index < lines.length) {
      if (lines[index].trim() === '') {
        index += 1;
        continue;
      }

      const start = index;
      // Indented code is decided before tables. An unindented following line
      // starts a fresh block, and may itself be a setext heading or table.
      if (/^(?: {4}| {0,3}\t)/.test(lines[index])) {
        const body = [];
        while (index < lines.length && /^(?: {4}| {0,3}\t)/.test(lines[index])) {
          body.push(lines[index].replace(/^(?: {4}| {0,3}\t)/, '')); index++;
        }
        blocks.push({ type: 'code', source: lines.slice(start, index).join('\n'), text: body.join('\n'), meta: { lang: '', indented: true } });
        continue;
      }
      // A raw HTML block owns its lines before Markdown table recognition.
      // Retain the existing safe, literal HTML display in the app.
      const htmlEnd = htmlBlockEnd(lines[index]);
      if (htmlEnd) {
        const blankEnded = htmlEnd.source === '^[ \\t]*$';
        do { index++; } while (index < lines.length && !(blankEnded ? lines[index].trim() === '' : htmlEnd.test(lines[index - 1])));
        const htmlSource = lines.slice(start, index).join('\n');
        blocks.push({ type: 'p', source: htmlSource, text: plainInline(htmlSource, references), meta: { htmlBlock: true } });
        continue;
      }
      const fence = fenceMatch(lines[index]);
      if (fence) {
        index += 1;
        const body = [];
        let closed = false;
        while (index < lines.length) {
          const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
          if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
            index += 1;
            closed = true;
            break;
          }
          body.push(lines[index]);
          index += 1;
        }
        blocks.push({
          type: 'code',
          source: lines.slice(start, index).join('\n'),
          text: body.join('\n'),
          meta: { lang: fence.lang, info: fence.info, fence: fence.marker, closed }
        });
        continue;
      }

      const heading = headingMatch(lines[index]);
      if (heading) {
        index += 1;
        blocks.push({ type: `h${heading.level}`, source: lines[start], text: plainInline(heading.text, references), meta: { level: heading.level, rawText: heading.text } });
        continue;
      }

      if (isHr(lines[index])) {
        index += 1;
        blocks.push({ type: 'hr', source: lines[start], text: '', meta: {} });
        continue;
      }

      // Right under a table row or a footnote definition, with no blank line between,
      // the line is that table's row or that note's text on the site: not a definition.
      const continues = start > 0 && lines[start - 1].trim() !== '' && blocks.length > 0 &&
        (blocks[blocks.length - 1].type === 'table' || blocks[blocks.length - 1].type === 'footnote-def');
      const reference = !continues && referenceSpan(lines, index);
      if (reference) {
        index = reference.end;
        blocks.push({ type: 'reference-def', source: lines.slice(start, index).join('\n'), text: '', meta: reference.reference });
        continue;
      }

      const definition = /^\[\^([^\]]+)\]:[ \t]*(.*)$/.exec(lines[index]);
      if (definition) {
        const body = [definition[2]];
        index += 1;
        while (index < lines.length && (/^(?: {2,}|\t)/.test(lines[index]) || lines[index].trim() === '')) {
          if (lines[index].trim() === '' && (index + 1 >= lines.length || !/^(?: {2,}|\t)/.test(lines[index + 1]))) break;
          body.push(lines[index].replace(/^(?: {2,}|\t)/, ''));
          index += 1;
        }
        blocks.push({
          type: 'footnote-def',
          source: lines.slice(start, index).join('\n'),
          text: plainInline(body.join('\n'), references),
          meta: { footnoteKey: definition[1], body: body.join('\n') }
        });
        continue;
      }

      if (/^\s{0,3}>/.test(lines[index])) {
        const quoted = [];
        let lazyParagraph = null;
        while (index < lines.length) {
          if (!/^\s{0,3}>/.test(lines[index])) {
            const previous = (quoted.at(-1) || '').replace(/^\s{0,3}>[ \t]?/, '');
            if (lazyParagraph == null) {
              let last = scan(quoted.map(line => line.replace(/^\s{0,3}>[ \t]?/, '')).join('\n'), false, references).blocks.at(-1);
              // Laziness belongs to the deepest open paragraph, including a
              // paragraph nested in a quote or the final list item.
              while (last && (last.type === 'quote' || last.type === 'list')) {
                const body = last.type === 'quote' ? last.meta.bodySource : listRows(last.source).at(-1)?.content || '';
                last = scan(body, false, references).blocks.at(-1);
              }
              lazyParagraph = last?.type === 'p' && !last.meta.htmlBlock;
            }
            // A plain continuation can omit the quote marker. Block starters
            // and a preceding non-paragraph line end that lazy continuation.
            if (!lazyParagraph || !lines[index].trim() || !previous.trim() || isBlockStart(lines, index, start) || /^ {0,3}=+[ \t]*$/.test(lines[index]) || headingMatch(previous) || fenceMatch(previous) || isHr(previous)) break;
          } else if (lazyParagraph) {
            const innerLine = lines[index].replace(/^\s{0,3}>[ \t]?/, '');
            const prior = (quoted.at(-1) || '').replace(/^\s{0,3}>[ \t]?/, '');
            // Ordinary marked lines keep the open paragraph. Do not reparse
            // its growing prefix after every lazy/marked transition.
            if (!innerLine.trim() || isBlockStart([innerLine], 0) || /^ {0,3}[-=]+[ \t]*$/.test(innerLine) || isTableStart([prior, innerLine], 0)) lazyParagraph = null;
          }
          quoted.push(lines[index]);
          index += 1;
        }
        const inner = quoted.map((line) => line.replace(/^\s{0,3}>[ \t]?/, ''));
        const callout = /^\[!([^\]]+)\]([+-]?)[ \t]*(.*)$/.exec(inner[0] || '');
        if (callout && CALLOUTS.has(callout[1].toLowerCase())) {
          const kind = callout[1].toLowerCase();
          const fold = callout[2] || '';
          const title = callout[3] || kind[0].toUpperCase() + kind.slice(1);
          const body = inner.slice(1).join('\n');
          blocks.push({
            type: 'callout',
            source: quoted.join('\n'),
            text: plainInline(`${title}\n${body}`, references),
            meta: { calloutKind: kind, fold, title, bodySource: body }
          });
        } else {
          const body = inner.join('\n');
          blocks.push({ type: 'quote', source: quoted.join('\n'), text: plainInline(body, references), meta: { bodySource: body } });
        }
        continue;
      }

      if (listMatch(lines[index])) {
        let lazyParagraph = null;
        index += 1;
        while (index < lines.length) {
          if (listMatch(lines[index])) {
            lazyParagraph = null;
            index += 1;
            continue;
          }
          if (lines[index].trim() === '') {
            lazyParagraph = null;
            if (index + 1 < lines.length && (listMatch(lines[index + 1]) || /^\s+\S/.test(lines[index + 1]))) {
              index += 1;
              continue;
            }
            break;
          }
          if (/^\s+\S/.test(lines[index])) {
            const inner = lines[index].trimStart();
            if (!inner || isBlockStart([inner], 0) || /^[-=]+[ \t]*$/.test(inner)) lazyParagraph = null;
            index += 1;
            continue;
          }
          if (!isBlockStart(lines, index, start) && !/^ {0,3}[-=]+[ \t]*$/.test(lines[index])) {
            if (lazyParagraph == null) {
              const item = listRows(lines.slice(start, index).join('\n')).at(-1);
              const last = item && scan(item.content, false, references).blocks.at(-1);
              lazyParagraph = last?.type === 'p' && !last.meta.htmlBlock;
            }
            if (lazyParagraph) { index++; continue; }
          }
          break;
        }
        const listSource = lines.slice(start, index).join('\n');
        const itemRows = listSource.split('\n').filter((line) => listMatch(line));
        const hasTasks = itemRows.some((line) => /^\s*[-+*]\s+\[[ xX]\]/.test(line));
        blocks.push({
          type: 'list',
          source: listSource,
          text: itemRows.map((line) => plainInline(listMatch(line).content.replace(/^\[[ xX]\]\s*/, ''), references)).join('\n'),
          meta: { ordered: Boolean(listMatch(itemRows[0])?.ordered), hasTasks }
        });
        continue;
      }

      if (isTableStart(lines, index)) {
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') index += 1;
        const tableSource = lines.slice(start, index).join('\n');
        const rows = tableSource.split('\n');
        blocks.push({
          type: 'table',
          source: tableSource,
          text: rows.filter((_, rowIndex) => rowIndex !== 1).flatMap(splitTableRow).map(cell => plainInline(cell, references)).join(' '),
          meta: { columns: splitTableRow(rows[0]).length }
        });
        continue;
      }

      const embed = /^\s*!\[\[([\s\S]+)\]\]\s*$/.exec(lines[index]);
      if (embed) {
        index += 1;
        const info = parseEmbedSpec(embed[1]);
        blocks.push({
          type: 'embed',
          source: lines[start],
          text: info.target,
          meta: {
            target: info.target,
            imageWidth: info.width,
            imageHeight: info.height,
            caption: info.caption,
            mediaKind: info.mediaKind,
            isImage: info.isImage
          }
        });
        continue;
      }

      index += 1;
      const setext = () => !/^(?: {4}| *\t)/.test(lines[start]) && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index] || '') && !referenceInsideCode(lines, start, index);
      while (index < lines.length && lines[index].trim() !== '' && !setext() && !isBlockStart(lines, index, start)) index += 1;
      const paragraphSource = lines.slice(start, index).join('\n');
      if (setext()) {
        const level = lines[index].trim()[0] === '=' ? 1 : 2;
        index += 1;
        blocks.push({ type: `h${level}`, source: lines.slice(start, index).join('\n'), text: plainInline(paragraphSource, references), meta: { level, rawText: paragraphSource } });
      } else blocks.push({ type: 'p', source: paragraphSource, text: plainInline(paragraphSource, references), meta: {} });
    }

    return { blocks, frontmatter };
  }

  function parseWikiSpec(raw) {
    const pipe = raw.indexOf('|');
    const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    const shown = pipe >= 0 ? raw.slice(pipe + 1).trim() : '';
    return { target, shown };
  }

  function parseEmbedSpec(raw) {
    const parts = raw.split('|').map((part) => part.trim());
    const target = parts.shift() || '';
    let size = null;
    const captions = [];
    for (const part of parts) {
      if (!size && /^\d+(?:x\d+)?$/i.test(part)) size = part;
      else if (part) captions.push(part);
    }
    const dimensions = size ? size.toLowerCase().split('x').map(Number) : [];
    /* A data URL states its own kind, and an inlined file has no extension left to
       read, so the MIME type is consulted first. */
    const dataKind = /^data:(image|audio|video)\//i.test(target) ? RegExp.$1.toLowerCase()
      : /^data:application\/pdf/i.test(target) ? 'pdf' : '';
    const mediaKind = dataKind ? dataKind
      : IMAGE_EXT.test(target) || IMAGE_DATA_URL.test(target) ? 'image'
      : AUDIO_EXT.test(target) ? 'audio'
      : VIDEO_EXT.test(target) ? 'video'
      : PDF_EXT.test(target) ? 'pdf'
      : '';
    return {
      target,
      width: dimensions[0] || null,
      height: dimensions[1] || null,
      caption: captions.join(' | '),
      mediaKind,
      isImage: mediaKind === 'image'
    };
  }

  function findClosing(text, delimiter, start) {
    let index = start;
    while (index < text.length) {
      index = text.indexOf(delimiter, index);
      if (index < 0) return -1;
      if (delimiter[0] === '`') {
        let end = index;
        while (text[end] === '`') end++;
        if (text[index - 1] !== '`' && end - index === delimiter.length) return index;
        index = end; continue;
      }
      let escapes = 0;
      for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) escapes++;
      if (escapes % 2 === 0) return index;
      index += 1;
    }
    return -1;
  }

  function findParenClose(text, start) {
    let depth = 1;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === '\\') {
        index += 1;
      } else if (text[index] === '(') {
        depth += 1;
      } else if (text[index] === ')' && --depth === 0) {
        return index;
      }
    }
    return -1;
  }

  function escapedAt(text, index) {
    let slashes = 0;
    for (let at = index - 1; at >= 0 && text[at] === '\\'; at--) slashes++;
    return slashes % 2 === 1;
  }

  function emphasisCanOpen(text, index, size) {
    let lo = index, hi = index + size;
    while (hi < text.length && text[hi] === text[index]) hi++;
    const previous = (text.slice(Math.max(0, lo - 2), lo).match(/.$/u) || [''])[0], next = (text.slice(hi).match(/^./u) || [''])[0];
    const punct = c => !!c && /[\p{P}\p{S}]/u.test(c);
    // Match the site's satteri renderer at adjacent delimiter boundaries. The
    // scanner passes the whole unescaped run; an escaped preceding marker is
    // a separate literal character, not part of this run.
    const adjacent = c => (text[index] === '*' || text[index] === '_') && (c === '*' || c === '_' || c === '~');
    const left = !!next && !/\p{White_Space}/u.test(next) && (adjacent(next) || !punct(next) || !previous || /\p{White_Space}/u.test(previous) || punct(previous));
    const right = !!previous && !/\p{White_Space}/u.test(previous) && (adjacent(previous) || !punct(previous) || !next || /\p{White_Space}/u.test(next) || punct(next));
    return left && (text[index] !== '_' || !right || punct(previous));
  }

  function emphasisCanClose(text, index, size) {
    let lo = index, hi = index + size;
    while (hi < text.length && text[hi] === text[index]) hi++;
    const previous = (text.slice(Math.max(0, lo - 2), lo).match(/.$/u) || [''])[0], next = (text.slice(hi).match(/^./u) || [''])[0];
    const punct = c => !!c && /[\p{P}\p{S}]/u.test(c);
    const adjacent = c => (text[index] === '*' || text[index] === '_') && (c === '*' || c === '_' || c === '~');
    const right = !!previous && !/\p{White_Space}/u.test(previous) && (adjacent(previous) || !punct(previous) || !next || /\p{White_Space}/u.test(next) || punct(next));
    const left = !!next && !/\p{White_Space}/u.test(next) && (adjacent(next) || !punct(next) || !previous || /\p{White_Space}/u.test(previous) || punct(previous));
    return right && (text[index] !== '_' || !left || punct(next));
  }

  // Every suffix/delimiter pair is solved once. Explicit frames avoid both
  // exponential revisits of failed nested searches and a JS recursion limit on
  // an unmatched block. The cache belongs to this inline render only.
  function findEmphasisClose(text, delimiter, start, searches) {
    searches = searches || { results: new Map(), closing: new Map(), links: new Map() };
    function results(mark) {
      if (!searches.results.has(mark)) searches.results.set(mark, new Map());
      return searches.results.get(mark);
    }
    function closing(mark, at) {
      const key = mark + ':' + at;
      if (!searches.closing.has(key)) searches.closing.set(key, findClosing(text, mark, at));
      return searches.closing.get(key);
    }
    function frame(mark, at) { return { mark, at, visited: [], pending: null }; }
    const stack = [frame(delimiter, start)];
    let answer = -1;
    function finish(value) {
      const current = stack.pop(), cache = results(current.mark);
      for (const at of current.visited) cache.set(at, value);
      answer = value;
    }
    while (stack.length) {
      const current = stack[stack.length - 1], cache = results(current.mark);
      if (current.pending) {
        const nested = current.pending;
        if (answer >= 0 && !(current.mark === '**' && nested === '*' && /^\*{2}(?!\*)/.test(text.slice(answer)))) current.at = answer + nested.length;
        else current.at++;
        current.pending = null;
        continue;
      }
      if (cache.has(current.at)) { finish(cache.get(current.at)); continue; }
      if (current.at >= text.length) { finish(-1); continue; }
      const index = current.at;
      current.visited.push(index);
      if (text[index] === '\\') { current.at += 2; continue; }
      if (text[index] === '[') {
        if (!searches.links.has(index)) {
          const close = closing(']', index + 1);
          searches.links.set(index, close >= 0 && text[close + 1] === '(' && inlineDestination(text, close + 2));
        }
        const link = searches.links.get(index);
        if (link) { current.at = link.end + 1; continue; }
      }
      if (text[index] === '`') {
        let ticks = 1;
        while (text[index + ticks] === '`') ticks++;
        const end = closing('`'.repeat(ticks), index + ticks);
        if (end >= 0) { current.at = end + ticks; continue; }
        current.at += ticks; continue;
      }
      if (text.startsWith(current.mark, index) && (current.mark === '==' || emphasisCanClose(text, index, current.mark.length))) { finish(index); continue; }
      const nested = ['**', '~~', '==', '*', '_'].find(d => d !== current.mark && text.startsWith(d, index) && emphasisCanOpen(text, index, d.length));
      if (nested) {
        current.pending = nested;
        stack.push(frame(nested, index + nested.length));
      } else current.at++;
    }
    return answer;
  }

  /* Footnote numbers, 1..n by first appearance in the page.
     The number lives on the render CONTEXT, which parse() shares across every
     block and every definition body, so one page counts once and a ref and its
     definition always agree. A caller that renders one block on its own gets 1,
     which is the honest answer when there is no page to count against. */
  function footnoteNumber(ctx, key) {
    if (!ctx) return 1;
    const map = ctx.footnoteNumbers || (ctx.footnoteNumbers = new Map());
    if (!map.has(key)) map.set(key, map.size + 1);
    return map.get(key);
  }

  // Editing uses the reader's renderer. Source-only characters stay in the DOM,
  // but never take a glyph cell; textContent remains a lossless Markdown string.
  // With the marks shown (Settings, Show Markdown marks), a line break inside a
  // mark keeps its own run, so it stays hidden while the characters around it are painted.
  function sourceMark(value, opts) {
    if (!(opts && opts.editSource && value)) return '';
    if (!opts.showMarks || value.indexOf('\n') < 0) return `<span class="cw-mk">${escapeHtml(value)}</span>`;
    return value.split(/(\n)/).filter(Boolean).map(part =>
      `<span class="cw-mk${part === '\n' ? ' cw-mk-nl' : ''}">${escapeHtml(part)}</span>`).join('');
  }
  function sourceAtom(source, html, opts) {
    return opts && opts.editSource ? `<span class="cw-atom" contenteditable="false">${sourceMark(source, opts)}${html}</span>` : html;
  }

  // satteri-pulldown-cmark has two GFM literal-link passes: source scanning,
  // followed by text-event recognition after escapes/entities and emphasis.
  // Keeping the passes separate is essential: a raw URL owns literal escapes,
  // while a text-event URL owns already decoded characters.
  function literalAutolink(text, index, raw, brackets, emailOnly) {
    const tail = text.slice(index), previous = text[index - 1] || '';
    const www = /^www\./i.test(tail), scheme = /^https?:\/\//i.exec(tail);
    if (!emailOnly && raw && www) { const email = literalAutolink(text, index, raw, brackets, true); if (email) return email; }
    if (!emailOnly && (www || scheme) && !(www ? /[\p{L}\p{N}]/u : raw ? /[A-Za-z]/ : /[\p{L}\p{N}]/u).test(previous)) {
      const match = (raw ? /^(?:https?:\/\/|www\.)[^\s<]*/i : /^(?:https?:\/\/|www\.)[^\s]*/i).exec(tail);
      let label = raw ? match[0].split(/\](?=[(\[])/)[0] : match[0];
      if (raw && (www && (previous && !/[\s(*_~\]]/.test(previous) && !(previous === '[' && escapedAt(text, index - 1))) || brackets)) return null;
      const punctuation = raw ? /[?!.,:;*_~\]\"']$/ : /[?!.,:;&<>\]}\"']$/;
      while (label && (punctuation.test(label) || raw && /[?!.,:;*_~\]\"']\)+$/.test(label) || label.endsWith(')') && (label.match(/\)/g) || []).length > (label.match(/\(/g) || []).length)) {
        label = raw && /[?!.,:;*_~\]\"']\)+$/.test(label) ? label.replace(/\)+$/, '') : raw && label.endsWith(';') && /&[A-Za-z]+;$/.test(label) ? label.replace(/&[A-Za-z]+;$/, '') : label.slice(0, -1);
      }
      const body = (raw ? label : match[0]).replace(/^https?:\/\//i, '');
      const domain = (raw ? /^[A-Za-z0-9._\-\u0080-\uffff]+/ : /^[A-Za-z0-9._-]+/).exec(body);
      if (label.length > (scheme ? scheme[0].length : 0) && (domain && (!raw ? domain[0].includes('.') && /^[A-Za-z0-9._-]/.test(body) : /^[A-Za-z0-9\u0080-\uffff]/.test(body)) && !domain[0].split('.').slice(-2).some(part => part.includes('_') || !raw && /^-+$/.test(part)))) {
        return { length: label.length, label, destination: www ? 'http://' + label : label };
      }
    }
    // Punctuation after a literal backslash joins its decoded text event.
    // Alphanumeric starts still qualify for raw-source email recognition.
    if (!(raw && brackets) && !(raw && previous === '\\' && /^[.+-]/.test(tail)) && !(raw ? /[A-Za-z0-9.+_\/-]/ : /[A-Za-z0-9\/]/).test(previous) && !(raw && /[.+_-]/.test(previous) && escapedAt(text, index - 1))) {
      const match = /^[A-Za-z0-9.+_-]+@[A-Za-z0-9._-]+/.exec(tail);
      if (match) {
        let label = match[0].replace(/\.+$/, '');
        let domain = label.slice(label.indexOf('@') + 1);
        domain = domain.replace(raw ? /\.(?=[._-]).*$/ : /\.\..*$/, '').replace(/\.+$/, '');
        label = label.slice(0, label.indexOf('@') + 1) + domain;
        const last = domain.slice(domain.lastIndexOf('.') + 1);
        if (domain.includes('.') && !domain.includes('..') && /[A-Za-z]$/.test(last) && (!raw || /^[A-Za-z0-9]/.test(last)) && !/^\.[._-]/.test(domain) && !(domain[0] === '.' && (!raw || brackets))) {
          return { length: label.length, label, destination: 'mailto:' + label };
        }
      }
    }
    return null;
  }

  // Conservative serializer prefilter. Raw source and decoded text-event
  // candidates use the very same matcher as rendering, without building a DOM.
  // Markup can only add event boundaries; the exact renderer still decides.
  function hasAutolinkCandidate(value) {
    for (const text of [String(value), destinationText(value)]) {
      const starts = /https?:\/\/|www\.|@/gi;
      let match;
      while ((match = starts.exec(text))) {
        let at = match.index;
        if (match[0] !== '@') {
          // Only the host can rule out a URL. A slash prevents quadratic
          // trailing-parenthesis trimming; trimming dots/underscores is permissive
          // because the raw URL pass can discard them at a label's end.
          const host = /^(?:https?:\/\/|www\.)[A-Za-z0-9._\-\u0080-\uffff]*/i.exec(text.slice(at))[0];
          for (const candidate of [host + '/', host.replace(/[._]+$/, '') + '/']) {
            if (literalAutolink(candidate, 0, true, false) || literalAutolink(candidate, 0, false, false)) return true;
          }
          continue;
        }
        if (match[0] === '@') {
          while (at > 0 && /[A-Za-z0-9.+_-]/.test(text[at - 1])) at--;
          // A slash can exclude the first local part while a following dot,
          // plus or underscore starts a valid text-event email suffix.
          while (at < match.index && /[A-Za-z0-9\/]/.test(text[at - 1] || '')) at++;
          if (at === match.index) continue;
        }
        if (literalAutolink(text, at, true, false, true) || literalAutolink(text, at, false, false, true)) return true;
      }
    }
    return false;
  }

  // HTML named characters, from the HTML Living Standard table shipped in
  // Python html.entities (semicolon forms). No runtime package is required.
  const HTML_ENTITIES = {"Aacute":"\u00c1","aacute":"\u00e1","Abreve":"\u0102","abreve":"\u0103","ac":"\u223e","acd":"\u223f","acE":"\u223e\u0333","Acirc":"\u00c2","acirc":"\u00e2","acute":"\u00b4","Acy":"\u0410","acy":"\u0430","AElig":"\u00c6","aelig":"\u00e6","af":"\u2061","Afr":"\ud835\udd04","afr":"\ud835\udd1e","Agrave":"\u00c0","agrave":"\u00e0","alefsym":"\u2135","aleph":"\u2135","Alpha":"\u0391","alpha":"\u03b1","Amacr":"\u0100","amacr":"\u0101","amalg":"\u2a3f","AMP":"&","amp":"&","And":"\u2a53","and":"\u2227","andand":"\u2a55","andd":"\u2a5c","andslope":"\u2a58","andv":"\u2a5a","ang":"\u2220","ange":"\u29a4","angle":"\u2220","angmsd":"\u2221","angmsdaa":"\u29a8","angmsdab":"\u29a9","angmsdac":"\u29aa","angmsdad":"\u29ab","angmsdae":"\u29ac","angmsdaf":"\u29ad","angmsdag":"\u29ae","angmsdah":"\u29af","angrt":"\u221f","angrtvb":"\u22be","angrtvbd":"\u299d","angsph":"\u2222","angst":"\u00c5","angzarr":"\u237c","Aogon":"\u0104","aogon":"\u0105","Aopf":"\ud835\udd38","aopf":"\ud835\udd52","ap":"\u2248","apacir":"\u2a6f","apE":"\u2a70","ape":"\u224a","apid":"\u224b","apos":"'","ApplyFunction":"\u2061","approx":"\u2248","approxeq":"\u224a","Aring":"\u00c5","aring":"\u00e5","Ascr":"\ud835\udc9c","ascr":"\ud835\udcb6","Assign":"\u2254","ast":"*","asymp":"\u2248","asympeq":"\u224d","Atilde":"\u00c3","atilde":"\u00e3","Auml":"\u00c4","auml":"\u00e4","awconint":"\u2233","awint":"\u2a11","backcong":"\u224c","backepsilon":"\u03f6","backprime":"\u2035","backsim":"\u223d","backsimeq":"\u22cd","Backslash":"\u2216","Barv":"\u2ae7","barvee":"\u22bd","Barwed":"\u2306","barwed":"\u2305","barwedge":"\u2305","bbrk":"\u23b5","bbrktbrk":"\u23b6","bcong":"\u224c","Bcy":"\u0411","bcy":"\u0431","bdquo":"\u201e","becaus":"\u2235","Because":"\u2235","because":"\u2235","bemptyv":"\u29b0","bepsi":"\u03f6","bernou":"\u212c","Bernoullis":"\u212c","Beta":"\u0392","beta":"\u03b2","beth":"\u2136","between":"\u226c","Bfr":"\ud835\udd05","bfr":"\ud835\udd1f","bigcap":"\u22c2","bigcirc":"\u25ef","bigcup":"\u22c3","bigodot":"\u2a00","bigoplus":"\u2a01","bigotimes":"\u2a02","bigsqcup":"\u2a06","bigstar":"\u2605","bigtriangledown":"\u25bd","bigtriangleup":"\u25b3","biguplus":"\u2a04","bigvee":"\u22c1","bigwedge":"\u22c0","bkarow":"\u290d","blacklozenge":"\u29eb","blacksquare":"\u25aa","blacktriangle":"\u25b4","blacktriangledown":"\u25be","blacktriangleleft":"\u25c2","blacktriangleright":"\u25b8","blank":"\u2423","blk12":"\u2592","blk14":"\u2591","blk34":"\u2593","block":"\u2588","bne":"=\u20e5","bnequiv":"\u2261\u20e5","bNot":"\u2aed","bnot":"\u2310","Bopf":"\ud835\udd39","bopf":"\ud835\udd53","bot":"\u22a5","bottom":"\u22a5","bowtie":"\u22c8","boxbox":"\u29c9","boxDL":"\u2557","boxDl":"\u2556","boxdL":"\u2555","boxdl":"\u2510","boxDR":"\u2554","boxDr":"\u2553","boxdR":"\u2552","boxdr":"\u250c","boxH":"\u2550","boxh":"\u2500","boxHD":"\u2566","boxHd":"\u2564","boxhD":"\u2565","boxhd":"\u252c","boxHU":"\u2569","boxHu":"\u2567","boxhU":"\u2568","boxhu":"\u2534","boxminus":"\u229f","boxplus":"\u229e","boxtimes":"\u22a0","boxUL":"\u255d","boxUl":"\u255c","boxuL":"\u255b","boxul":"\u2518","boxUR":"\u255a","boxUr":"\u2559","boxuR":"\u2558","boxur":"\u2514","boxV":"\u2551","boxv":"\u2502","boxVH":"\u256c","boxVh":"\u256b","boxvH":"\u256a","boxvh":"\u253c","boxVL":"\u2563","boxVl":"\u2562","boxvL":"\u2561","boxvl":"\u2524","boxVR":"\u2560","boxVr":"\u255f","boxvR":"\u255e","boxvr":"\u251c","bprime":"\u2035","Breve":"\u02d8","breve":"\u02d8","brvbar":"\u00a6","Bscr":"\u212c","bscr":"\ud835\udcb7","bsemi":"\u204f","bsim":"\u223d","bsime":"\u22cd","bsol":"\\","bsolb":"\u29c5","bsolhsub":"\u27c8","bull":"\u2022","bullet":"\u2022","bump":"\u224e","bumpE":"\u2aae","bumpe":"\u224f","Bumpeq":"\u224e","bumpeq":"\u224f","Cacute":"\u0106","cacute":"\u0107","Cap":"\u22d2","cap":"\u2229","capand":"\u2a44","capbrcup":"\u2a49","capcap":"\u2a4b","capcup":"\u2a47","capdot":"\u2a40","CapitalDifferentialD":"\u2145","caps":"\u2229\ufe00","caret":"\u2041","caron":"\u02c7","Cayleys":"\u212d","ccaps":"\u2a4d","Ccaron":"\u010c","ccaron":"\u010d","Ccedil":"\u00c7","ccedil":"\u00e7","Ccirc":"\u0108","ccirc":"\u0109","Cconint":"\u2230","ccups":"\u2a4c","ccupssm":"\u2a50","Cdot":"\u010a","cdot":"\u010b","cedil":"\u00b8","Cedilla":"\u00b8","cemptyv":"\u29b2","cent":"\u00a2","CenterDot":"\u00b7","centerdot":"\u00b7","Cfr":"\u212d","cfr":"\ud835\udd20","CHcy":"\u0427","chcy":"\u0447","check":"\u2713","checkmark":"\u2713","Chi":"\u03a7","chi":"\u03c7","cir":"\u25cb","circ":"\u02c6","circeq":"\u2257","circlearrowleft":"\u21ba","circlearrowright":"\u21bb","circledast":"\u229b","circledcirc":"\u229a","circleddash":"\u229d","CircleDot":"\u2299","circledR":"\u00ae","circledS":"\u24c8","CircleMinus":"\u2296","CirclePlus":"\u2295","CircleTimes":"\u2297","cirE":"\u29c3","cire":"\u2257","cirfnint":"\u2a10","cirmid":"\u2aef","cirscir":"\u29c2","ClockwiseContourIntegral":"\u2232","CloseCurlyDoubleQuote":"\u201d","CloseCurlyQuote":"\u2019","clubs":"\u2663","clubsuit":"\u2663","Colon":"\u2237","colon":":","Colone":"\u2a74","colone":"\u2254","coloneq":"\u2254","comma":",","commat":"@","comp":"\u2201","compfn":"\u2218","complement":"\u2201","complexes":"\u2102","cong":"\u2245","congdot":"\u2a6d","Congruent":"\u2261","Conint":"\u222f","conint":"\u222e","ContourIntegral":"\u222e","Copf":"\u2102","copf":"\ud835\udd54","coprod":"\u2210","Coproduct":"\u2210","COPY":"\u00a9","copy":"\u00a9","copysr":"\u2117","CounterClockwiseContourIntegral":"\u2233","crarr":"\u21b5","Cross":"\u2a2f","cross":"\u2717","Cscr":"\ud835\udc9e","cscr":"\ud835\udcb8","csub":"\u2acf","csube":"\u2ad1","csup":"\u2ad0","csupe":"\u2ad2","ctdot":"\u22ef","cudarrl":"\u2938","cudarrr":"\u2935","cuepr":"\u22de","cuesc":"\u22df","cularr":"\u21b6","cularrp":"\u293d","Cup":"\u22d3","cup":"\u222a","cupbrcap":"\u2a48","CupCap":"\u224d","cupcap":"\u2a46","cupcup":"\u2a4a","cupdot":"\u228d","cupor":"\u2a45","cups":"\u222a\ufe00","curarr":"\u21b7","curarrm":"\u293c","curlyeqprec":"\u22de","curlyeqsucc":"\u22df","curlyvee":"\u22ce","curlywedge":"\u22cf","curren":"\u00a4","curvearrowleft":"\u21b6","curvearrowright":"\u21b7","cuvee":"\u22ce","cuwed":"\u22cf","cwconint":"\u2232","cwint":"\u2231","cylcty":"\u232d","Dagger":"\u2021","dagger":"\u2020","daleth":"\u2138","Darr":"\u21a1","dArr":"\u21d3","darr":"\u2193","dash":"\u2010","Dashv":"\u2ae4","dashv":"\u22a3","dbkarow":"\u290f","dblac":"\u02dd","Dcaron":"\u010e","dcaron":"\u010f","Dcy":"\u0414","dcy":"\u0434","DD":"\u2145","dd":"\u2146","ddagger":"\u2021","ddarr":"\u21ca","DDotrahd":"\u2911","ddotseq":"\u2a77","deg":"\u00b0","Del":"\u2207","Delta":"\u0394","delta":"\u03b4","demptyv":"\u29b1","dfisht":"\u297f","Dfr":"\ud835\udd07","dfr":"\ud835\udd21","dHar":"\u2965","dharl":"\u21c3","dharr":"\u21c2","DiacriticalAcute":"\u00b4","DiacriticalDot":"\u02d9","DiacriticalDoubleAcute":"\u02dd","DiacriticalGrave":"`","DiacriticalTilde":"\u02dc","diam":"\u22c4","Diamond":"\u22c4","diamond":"\u22c4","diamondsuit":"\u2666","diams":"\u2666","die":"\u00a8","DifferentialD":"\u2146","digamma":"\u03dd","disin":"\u22f2","div":"\u00f7","divide":"\u00f7","divideontimes":"\u22c7","divonx":"\u22c7","DJcy":"\u0402","djcy":"\u0452","dlcorn":"\u231e","dlcrop":"\u230d","dollar":"$","Dopf":"\ud835\udd3b","dopf":"\ud835\udd55","Dot":"\u00a8","dot":"\u02d9","DotDot":"\u20dc","doteq":"\u2250","doteqdot":"\u2251","DotEqual":"\u2250","dotminus":"\u2238","dotplus":"\u2214","dotsquare":"\u22a1","doublebarwedge":"\u2306","DoubleContourIntegral":"\u222f","DoubleDot":"\u00a8","DoubleDownArrow":"\u21d3","DoubleLeftArrow":"\u21d0","DoubleLeftRightArrow":"\u21d4","DoubleLeftTee":"\u2ae4","DoubleLongLeftArrow":"\u27f8","DoubleLongLeftRightArrow":"\u27fa","DoubleLongRightArrow":"\u27f9","DoubleRightArrow":"\u21d2","DoubleRightTee":"\u22a8","DoubleUpArrow":"\u21d1","DoubleUpDownArrow":"\u21d5","DoubleVerticalBar":"\u2225","DownArrow":"\u2193","Downarrow":"\u21d3","downarrow":"\u2193","DownArrowBar":"\u2913","DownArrowUpArrow":"\u21f5","DownBreve":"\u0311","downdownarrows":"\u21ca","downharpoonleft":"\u21c3","downharpoonright":"\u21c2","DownLeftRightVector":"\u2950","DownLeftTeeVector":"\u295e","DownLeftVector":"\u21bd","DownLeftVectorBar":"\u2956","DownRightTeeVector":"\u295f","DownRightVector":"\u21c1","DownRightVectorBar":"\u2957","DownTee":"\u22a4","DownTeeArrow":"\u21a7","drbkarow":"\u2910","drcorn":"\u231f","drcrop":"\u230c","Dscr":"\ud835\udc9f","dscr":"\ud835\udcb9","DScy":"\u0405","dscy":"\u0455","dsol":"\u29f6","Dstrok":"\u0110","dstrok":"\u0111","dtdot":"\u22f1","dtri":"\u25bf","dtrif":"\u25be","duarr":"\u21f5","duhar":"\u296f","dwangle":"\u29a6","DZcy":"\u040f","dzcy":"\u045f","dzigrarr":"\u27ff","Eacute":"\u00c9","eacute":"\u00e9","easter":"\u2a6e","Ecaron":"\u011a","ecaron":"\u011b","ecir":"\u2256","Ecirc":"\u00ca","ecirc":"\u00ea","ecolon":"\u2255","Ecy":"\u042d","ecy":"\u044d","eDDot":"\u2a77","Edot":"\u0116","eDot":"\u2251","edot":"\u0117","ee":"\u2147","efDot":"\u2252","Efr":"\ud835\udd08","efr":"\ud835\udd22","eg":"\u2a9a","Egrave":"\u00c8","egrave":"\u00e8","egs":"\u2a96","egsdot":"\u2a98","el":"\u2a99","Element":"\u2208","elinters":"\u23e7","ell":"\u2113","els":"\u2a95","elsdot":"\u2a97","Emacr":"\u0112","emacr":"\u0113","empty":"\u2205","emptyset":"\u2205","EmptySmallSquare":"\u25fb","emptyv":"\u2205","EmptyVerySmallSquare":"\u25ab","emsp13":"\u2004","emsp14":"\u2005","emsp":"\u2003","ENG":"\u014a","eng":"\u014b","ensp":"\u2002","Eogon":"\u0118","eogon":"\u0119","Eopf":"\ud835\udd3c","eopf":"\ud835\udd56","epar":"\u22d5","eparsl":"\u29e3","eplus":"\u2a71","epsi":"\u03b5","Epsilon":"\u0395","epsilon":"\u03b5","epsiv":"\u03f5","eqcirc":"\u2256","eqcolon":"\u2255","eqsim":"\u2242","eqslantgtr":"\u2a96","eqslantless":"\u2a95","Equal":"\u2a75","equals":"=","EqualTilde":"\u2242","equest":"\u225f","Equilibrium":"\u21cc","equiv":"\u2261","equivDD":"\u2a78","eqvparsl":"\u29e5","erarr":"\u2971","erDot":"\u2253","Escr":"\u2130","escr":"\u212f","esdot":"\u2250","Esim":"\u2a73","esim":"\u2242","Eta":"\u0397","eta":"\u03b7","ETH":"\u00d0","eth":"\u00f0","Euml":"\u00cb","euml":"\u00eb","euro":"\u20ac","excl":"!","exist":"\u2203","Exists":"\u2203","expectation":"\u2130","ExponentialE":"\u2147","exponentiale":"\u2147","fallingdotseq":"\u2252","Fcy":"\u0424","fcy":"\u0444","female":"\u2640","ffilig":"\ufb03","fflig":"\ufb00","ffllig":"\ufb04","Ffr":"\ud835\udd09","ffr":"\ud835\udd23","filig":"\ufb01","FilledSmallSquare":"\u25fc","FilledVerySmallSquare":"\u25aa","fjlig":"fj","flat":"\u266d","fllig":"\ufb02","fltns":"\u25b1","fnof":"\u0192","Fopf":"\ud835\udd3d","fopf":"\ud835\udd57","ForAll":"\u2200","forall":"\u2200","fork":"\u22d4","forkv":"\u2ad9","Fouriertrf":"\u2131","fpartint":"\u2a0d","frac12":"\u00bd","frac13":"\u2153","frac14":"\u00bc","frac15":"\u2155","frac16":"\u2159","frac18":"\u215b","frac23":"\u2154","frac25":"\u2156","frac34":"\u00be","frac35":"\u2157","frac38":"\u215c","frac45":"\u2158","frac56":"\u215a","frac58":"\u215d","frac78":"\u215e","frasl":"\u2044","frown":"\u2322","Fscr":"\u2131","fscr":"\ud835\udcbb","gacute":"\u01f5","Gamma":"\u0393","gamma":"\u03b3","Gammad":"\u03dc","gammad":"\u03dd","gap":"\u2a86","Gbreve":"\u011e","gbreve":"\u011f","Gcedil":"\u0122","Gcirc":"\u011c","gcirc":"\u011d","Gcy":"\u0413","gcy":"\u0433","Gdot":"\u0120","gdot":"\u0121","gE":"\u2267","ge":"\u2265","gEl":"\u2a8c","gel":"\u22db","geq":"\u2265","geqq":"\u2267","geqslant":"\u2a7e","ges":"\u2a7e","gescc":"\u2aa9","gesdot":"\u2a80","gesdoto":"\u2a82","gesdotol":"\u2a84","gesl":"\u22db\ufe00","gesles":"\u2a94","Gfr":"\ud835\udd0a","gfr":"\ud835\udd24","Gg":"\u22d9","gg":"\u226b","ggg":"\u22d9","gimel":"\u2137","GJcy":"\u0403","gjcy":"\u0453","gl":"\u2277","gla":"\u2aa5","glE":"\u2a92","glj":"\u2aa4","gnap":"\u2a8a","gnapprox":"\u2a8a","gnE":"\u2269","gne":"\u2a88","gneq":"\u2a88","gneqq":"\u2269","gnsim":"\u22e7","Gopf":"\ud835\udd3e","gopf":"\ud835\udd58","grave":"`","GreaterEqual":"\u2265","GreaterEqualLess":"\u22db","GreaterFullEqual":"\u2267","GreaterGreater":"\u2aa2","GreaterLess":"\u2277","GreaterSlantEqual":"\u2a7e","GreaterTilde":"\u2273","Gscr":"\ud835\udca2","gscr":"\u210a","gsim":"\u2273","gsime":"\u2a8e","gsiml":"\u2a90","GT":">","Gt":"\u226b","gt":">","gtcc":"\u2aa7","gtcir":"\u2a7a","gtdot":"\u22d7","gtlPar":"\u2995","gtquest":"\u2a7c","gtrapprox":"\u2a86","gtrarr":"\u2978","gtrdot":"\u22d7","gtreqless":"\u22db","gtreqqless":"\u2a8c","gtrless":"\u2277","gtrsim":"\u2273","gvertneqq":"\u2269\ufe00","gvnE":"\u2269\ufe00","Hacek":"\u02c7","hairsp":"\u200a","half":"\u00bd","hamilt":"\u210b","HARDcy":"\u042a","hardcy":"\u044a","hArr":"\u21d4","harr":"\u2194","harrcir":"\u2948","harrw":"\u21ad","Hat":"^","hbar":"\u210f","Hcirc":"\u0124","hcirc":"\u0125","hearts":"\u2665","heartsuit":"\u2665","hellip":"\u2026","hercon":"\u22b9","Hfr":"\u210c","hfr":"\ud835\udd25","HilbertSpace":"\u210b","hksearow":"\u2925","hkswarow":"\u2926","hoarr":"\u21ff","homtht":"\u223b","hookleftarrow":"\u21a9","hookrightarrow":"\u21aa","Hopf":"\u210d","hopf":"\ud835\udd59","horbar":"\u2015","HorizontalLine":"\u2500","Hscr":"\u210b","hscr":"\ud835\udcbd","hslash":"\u210f","Hstrok":"\u0126","hstrok":"\u0127","HumpDownHump":"\u224e","HumpEqual":"\u224f","hybull":"\u2043","hyphen":"\u2010","Iacute":"\u00cd","iacute":"\u00ed","ic":"\u2063","Icirc":"\u00ce","icirc":"\u00ee","Icy":"\u0418","icy":"\u0438","Idot":"\u0130","IEcy":"\u0415","iecy":"\u0435","iexcl":"\u00a1","iff":"\u21d4","Ifr":"\u2111","ifr":"\ud835\udd26","Igrave":"\u00cc","igrave":"\u00ec","ii":"\u2148","iiiint":"\u2a0c","iiint":"\u222d","iinfin":"\u29dc","iiota":"\u2129","IJlig":"\u0132","ijlig":"\u0133","Im":"\u2111","Imacr":"\u012a","imacr":"\u012b","image":"\u2111","ImaginaryI":"\u2148","imagline":"\u2110","imagpart":"\u2111","imath":"\u0131","imof":"\u22b7","imped":"\u01b5","Implies":"\u21d2","in":"\u2208","incare":"\u2105","infin":"\u221e","infintie":"\u29dd","inodot":"\u0131","Int":"\u222c","int":"\u222b","intcal":"\u22ba","integers":"\u2124","Integral":"\u222b","intercal":"\u22ba","Intersection":"\u22c2","intlarhk":"\u2a17","intprod":"\u2a3c","InvisibleComma":"\u2063","InvisibleTimes":"\u2062","IOcy":"\u0401","iocy":"\u0451","Iogon":"\u012e","iogon":"\u012f","Iopf":"\ud835\udd40","iopf":"\ud835\udd5a","Iota":"\u0399","iota":"\u03b9","iprod":"\u2a3c","iquest":"\u00bf","Iscr":"\u2110","iscr":"\ud835\udcbe","isin":"\u2208","isindot":"\u22f5","isinE":"\u22f9","isins":"\u22f4","isinsv":"\u22f3","isinv":"\u2208","it":"\u2062","Itilde":"\u0128","itilde":"\u0129","Iukcy":"\u0406","iukcy":"\u0456","Iuml":"\u00cf","iuml":"\u00ef","Jcirc":"\u0134","jcirc":"\u0135","Jcy":"\u0419","jcy":"\u0439","Jfr":"\ud835\udd0d","jfr":"\ud835\udd27","jmath":"\u0237","Jopf":"\ud835\udd41","jopf":"\ud835\udd5b","Jscr":"\ud835\udca5","jscr":"\ud835\udcbf","Jsercy":"\u0408","jsercy":"\u0458","Jukcy":"\u0404","jukcy":"\u0454","Kappa":"\u039a","kappa":"\u03ba","kappav":"\u03f0","Kcedil":"\u0136","kcedil":"\u0137","Kcy":"\u041a","kcy":"\u043a","Kfr":"\ud835\udd0e","kfr":"\ud835\udd28","kgreen":"\u0138","KHcy":"\u0425","khcy":"\u0445","KJcy":"\u040c","kjcy":"\u045c","Kopf":"\ud835\udd42","kopf":"\ud835\udd5c","Kscr":"\ud835\udca6","kscr":"\ud835\udcc0","lAarr":"\u21da","Lacute":"\u0139","lacute":"\u013a","laemptyv":"\u29b4","lagran":"\u2112","Lambda":"\u039b","lambda":"\u03bb","Lang":"\u27ea","lang":"\u27e8","langd":"\u2991","langle":"\u27e8","lap":"\u2a85","Laplacetrf":"\u2112","laquo":"\u00ab","Larr":"\u219e","lArr":"\u21d0","larr":"\u2190","larrb":"\u21e4","larrbfs":"\u291f","larrfs":"\u291d","larrhk":"\u21a9","larrlp":"\u21ab","larrpl":"\u2939","larrsim":"\u2973","larrtl":"\u21a2","lat":"\u2aab","lAtail":"\u291b","latail":"\u2919","late":"\u2aad","lates":"\u2aad\ufe00","lBarr":"\u290e","lbarr":"\u290c","lbbrk":"\u2772","lbrace":"{","lbrack":"[","lbrke":"\u298b","lbrksld":"\u298f","lbrkslu":"\u298d","Lcaron":"\u013d","lcaron":"\u013e","Lcedil":"\u013b","lcedil":"\u013c","lceil":"\u2308","lcub":"{","Lcy":"\u041b","lcy":"\u043b","ldca":"\u2936","ldquo":"\u201c","ldquor":"\u201e","ldrdhar":"\u2967","ldrushar":"\u294b","ldsh":"\u21b2","lE":"\u2266","le":"\u2264","LeftAngleBracket":"\u27e8","LeftArrow":"\u2190","Leftarrow":"\u21d0","leftarrow":"\u2190","LeftArrowBar":"\u21e4","LeftArrowRightArrow":"\u21c6","leftarrowtail":"\u21a2","LeftCeiling":"\u2308","LeftDoubleBracket":"\u27e6","LeftDownTeeVector":"\u2961","LeftDownVector":"\u21c3","LeftDownVectorBar":"\u2959","LeftFloor":"\u230a","leftharpoondown":"\u21bd","leftharpoonup":"\u21bc","leftleftarrows":"\u21c7","LeftRightArrow":"\u2194","Leftrightarrow":"\u21d4","leftrightarrow":"\u2194","leftrightarrows":"\u21c6","leftrightharpoons":"\u21cb","leftrightsquigarrow":"\u21ad","LeftRightVector":"\u294e","LeftTee":"\u22a3","LeftTeeArrow":"\u21a4","LeftTeeVector":"\u295a","leftthreetimes":"\u22cb","LeftTriangle":"\u22b2","LeftTriangleBar":"\u29cf","LeftTriangleEqual":"\u22b4","LeftUpDownVector":"\u2951","LeftUpTeeVector":"\u2960","LeftUpVector":"\u21bf","LeftUpVectorBar":"\u2958","LeftVector":"\u21bc","LeftVectorBar":"\u2952","lEg":"\u2a8b","leg":"\u22da","leq":"\u2264","leqq":"\u2266","leqslant":"\u2a7d","les":"\u2a7d","lescc":"\u2aa8","lesdot":"\u2a7f","lesdoto":"\u2a81","lesdotor":"\u2a83","lesg":"\u22da\ufe00","lesges":"\u2a93","lessapprox":"\u2a85","lessdot":"\u22d6","lesseqgtr":"\u22da","lesseqqgtr":"\u2a8b","LessEqualGreater":"\u22da","LessFullEqual":"\u2266","LessGreater":"\u2276","lessgtr":"\u2276","LessLess":"\u2aa1","lesssim":"\u2272","LessSlantEqual":"\u2a7d","LessTilde":"\u2272","lfisht":"\u297c","lfloor":"\u230a","Lfr":"\ud835\udd0f","lfr":"\ud835\udd29","lg":"\u2276","lgE":"\u2a91","lHar":"\u2962","lhard":"\u21bd","lharu":"\u21bc","lharul":"\u296a","lhblk":"\u2584","LJcy":"\u0409","ljcy":"\u0459","Ll":"\u22d8","ll":"\u226a","llarr":"\u21c7","llcorner":"\u231e","Lleftarrow":"\u21da","llhard":"\u296b","lltri":"\u25fa","Lmidot":"\u013f","lmidot":"\u0140","lmoust":"\u23b0","lmoustache":"\u23b0","lnap":"\u2a89","lnapprox":"\u2a89","lnE":"\u2268","lne":"\u2a87","lneq":"\u2a87","lneqq":"\u2268","lnsim":"\u22e6","loang":"\u27ec","loarr":"\u21fd","lobrk":"\u27e6","LongLeftArrow":"\u27f5","Longleftarrow":"\u27f8","longleftarrow":"\u27f5","LongLeftRightArrow":"\u27f7","Longleftrightarrow":"\u27fa","longleftrightarrow":"\u27f7","longmapsto":"\u27fc","LongRightArrow":"\u27f6","Longrightarrow":"\u27f9","longrightarrow":"\u27f6","looparrowleft":"\u21ab","looparrowright":"\u21ac","lopar":"\u2985","Lopf":"\ud835\udd43","lopf":"\ud835\udd5d","loplus":"\u2a2d","lotimes":"\u2a34","lowast":"\u2217","lowbar":"_","LowerLeftArrow":"\u2199","LowerRightArrow":"\u2198","loz":"\u25ca","lozenge":"\u25ca","lozf":"\u29eb","lpar":"(","lparlt":"\u2993","lrarr":"\u21c6","lrcorner":"\u231f","lrhar":"\u21cb","lrhard":"\u296d","lrm":"\u200e","lrtri":"\u22bf","lsaquo":"\u2039","Lscr":"\u2112","lscr":"\ud835\udcc1","Lsh":"\u21b0","lsh":"\u21b0","lsim":"\u2272","lsime":"\u2a8d","lsimg":"\u2a8f","lsqb":"[","lsquo":"\u2018","lsquor":"\u201a","Lstrok":"\u0141","lstrok":"\u0142","LT":"<","Lt":"\u226a","lt":"<","ltcc":"\u2aa6","ltcir":"\u2a79","ltdot":"\u22d6","lthree":"\u22cb","ltimes":"\u22c9","ltlarr":"\u2976","ltquest":"\u2a7b","ltri":"\u25c3","ltrie":"\u22b4","ltrif":"\u25c2","ltrPar":"\u2996","lurdshar":"\u294a","luruhar":"\u2966","lvertneqq":"\u2268\ufe00","lvnE":"\u2268\ufe00","macr":"\u00af","male":"\u2642","malt":"\u2720","maltese":"\u2720","Map":"\u2905","map":"\u21a6","mapsto":"\u21a6","mapstodown":"\u21a7","mapstoleft":"\u21a4","mapstoup":"\u21a5","marker":"\u25ae","mcomma":"\u2a29","Mcy":"\u041c","mcy":"\u043c","mdash":"\u2014","mDDot":"\u223a","measuredangle":"\u2221","MediumSpace":"\u205f","Mellintrf":"\u2133","Mfr":"\ud835\udd10","mfr":"\ud835\udd2a","mho":"\u2127","micro":"\u00b5","mid":"\u2223","midast":"*","midcir":"\u2af0","middot":"\u00b7","minus":"\u2212","minusb":"\u229f","minusd":"\u2238","minusdu":"\u2a2a","MinusPlus":"\u2213","mlcp":"\u2adb","mldr":"\u2026","mnplus":"\u2213","models":"\u22a7","Mopf":"\ud835\udd44","mopf":"\ud835\udd5e","mp":"\u2213","Mscr":"\u2133","mscr":"\ud835\udcc2","mstpos":"\u223e","Mu":"\u039c","mu":"\u03bc","multimap":"\u22b8","mumap":"\u22b8","nabla":"\u2207","Nacute":"\u0143","nacute":"\u0144","nang":"\u2220\u20d2","nap":"\u2249","napE":"\u2a70\u0338","napid":"\u224b\u0338","napos":"\u0149","napprox":"\u2249","natur":"\u266e","natural":"\u266e","naturals":"\u2115","nbsp":"\u00a0","nbump":"\u224e\u0338","nbumpe":"\u224f\u0338","ncap":"\u2a43","Ncaron":"\u0147","ncaron":"\u0148","Ncedil":"\u0145","ncedil":"\u0146","ncong":"\u2247","ncongdot":"\u2a6d\u0338","ncup":"\u2a42","Ncy":"\u041d","ncy":"\u043d","ndash":"\u2013","ne":"\u2260","nearhk":"\u2924","neArr":"\u21d7","nearr":"\u2197","nearrow":"\u2197","nedot":"\u2250\u0338","NegativeMediumSpace":"\u200b","NegativeThickSpace":"\u200b","NegativeThinSpace":"\u200b","NegativeVeryThinSpace":"\u200b","nequiv":"\u2262","nesear":"\u2928","nesim":"\u2242\u0338","NestedGreaterGreater":"\u226b","NestedLessLess":"\u226a","NewLine":"\n","nexist":"\u2204","nexists":"\u2204","Nfr":"\ud835\udd11","nfr":"\ud835\udd2b","ngE":"\u2267\u0338","nge":"\u2271","ngeq":"\u2271","ngeqq":"\u2267\u0338","ngeqslant":"\u2a7e\u0338","nges":"\u2a7e\u0338","nGg":"\u22d9\u0338","ngsim":"\u2275","nGt":"\u226b\u20d2","ngt":"\u226f","ngtr":"\u226f","nGtv":"\u226b\u0338","nhArr":"\u21ce","nharr":"\u21ae","nhpar":"\u2af2","ni":"\u220b","nis":"\u22fc","nisd":"\u22fa","niv":"\u220b","NJcy":"\u040a","njcy":"\u045a","nlArr":"\u21cd","nlarr":"\u219a","nldr":"\u2025","nlE":"\u2266\u0338","nle":"\u2270","nLeftarrow":"\u21cd","nleftarrow":"\u219a","nLeftrightarrow":"\u21ce","nleftrightarrow":"\u21ae","nleq":"\u2270","nleqq":"\u2266\u0338","nleqslant":"\u2a7d\u0338","nles":"\u2a7d\u0338","nless":"\u226e","nLl":"\u22d8\u0338","nlsim":"\u2274","nLt":"\u226a\u20d2","nlt":"\u226e","nltri":"\u22ea","nltrie":"\u22ec","nLtv":"\u226a\u0338","nmid":"\u2224","NoBreak":"\u2060","NonBreakingSpace":"\u00a0","Nopf":"\u2115","nopf":"\ud835\udd5f","Not":"\u2aec","not":"\u00ac","NotCongruent":"\u2262","NotCupCap":"\u226d","NotDoubleVerticalBar":"\u2226","NotElement":"\u2209","NotEqual":"\u2260","NotEqualTilde":"\u2242\u0338","NotExists":"\u2204","NotGreater":"\u226f","NotGreaterEqual":"\u2271","NotGreaterFullEqual":"\u2267\u0338","NotGreaterGreater":"\u226b\u0338","NotGreaterLess":"\u2279","NotGreaterSlantEqual":"\u2a7e\u0338","NotGreaterTilde":"\u2275","NotHumpDownHump":"\u224e\u0338","NotHumpEqual":"\u224f\u0338","notin":"\u2209","notindot":"\u22f5\u0338","notinE":"\u22f9\u0338","notinva":"\u2209","notinvb":"\u22f7","notinvc":"\u22f6","NotLeftTriangle":"\u22ea","NotLeftTriangleBar":"\u29cf\u0338","NotLeftTriangleEqual":"\u22ec","NotLess":"\u226e","NotLessEqual":"\u2270","NotLessGreater":"\u2278","NotLessLess":"\u226a\u0338","NotLessSlantEqual":"\u2a7d\u0338","NotLessTilde":"\u2274","NotNestedGreaterGreater":"\u2aa2\u0338","NotNestedLessLess":"\u2aa1\u0338","notni":"\u220c","notniva":"\u220c","notnivb":"\u22fe","notnivc":"\u22fd","NotPrecedes":"\u2280","NotPrecedesEqual":"\u2aaf\u0338","NotPrecedesSlantEqual":"\u22e0","NotReverseElement":"\u220c","NotRightTriangle":"\u22eb","NotRightTriangleBar":"\u29d0\u0338","NotRightTriangleEqual":"\u22ed","NotSquareSubset":"\u228f\u0338","NotSquareSubsetEqual":"\u22e2","NotSquareSuperset":"\u2290\u0338","NotSquareSupersetEqual":"\u22e3","NotSubset":"\u2282\u20d2","NotSubsetEqual":"\u2288","NotSucceeds":"\u2281","NotSucceedsEqual":"\u2ab0\u0338","NotSucceedsSlantEqual":"\u22e1","NotSucceedsTilde":"\u227f\u0338","NotSuperset":"\u2283\u20d2","NotSupersetEqual":"\u2289","NotTilde":"\u2241","NotTildeEqual":"\u2244","NotTildeFullEqual":"\u2247","NotTildeTilde":"\u2249","NotVerticalBar":"\u2224","npar":"\u2226","nparallel":"\u2226","nparsl":"\u2afd\u20e5","npart":"\u2202\u0338","npolint":"\u2a14","npr":"\u2280","nprcue":"\u22e0","npre":"\u2aaf\u0338","nprec":"\u2280","npreceq":"\u2aaf\u0338","nrArr":"\u21cf","nrarr":"\u219b","nrarrc":"\u2933\u0338","nrarrw":"\u219d\u0338","nRightarrow":"\u21cf","nrightarrow":"\u219b","nrtri":"\u22eb","nrtrie":"\u22ed","nsc":"\u2281","nsccue":"\u22e1","nsce":"\u2ab0\u0338","Nscr":"\ud835\udca9","nscr":"\ud835\udcc3","nshortmid":"\u2224","nshortparallel":"\u2226","nsim":"\u2241","nsime":"\u2244","nsimeq":"\u2244","nsmid":"\u2224","nspar":"\u2226","nsqsube":"\u22e2","nsqsupe":"\u22e3","nsub":"\u2284","nsubE":"\u2ac5\u0338","nsube":"\u2288","nsubset":"\u2282\u20d2","nsubseteq":"\u2288","nsubseteqq":"\u2ac5\u0338","nsucc":"\u2281","nsucceq":"\u2ab0\u0338","nsup":"\u2285","nsupE":"\u2ac6\u0338","nsupe":"\u2289","nsupset":"\u2283\u20d2","nsupseteq":"\u2289","nsupseteqq":"\u2ac6\u0338","ntgl":"\u2279","Ntilde":"\u00d1","ntilde":"\u00f1","ntlg":"\u2278","ntriangleleft":"\u22ea","ntrianglelefteq":"\u22ec","ntriangleright":"\u22eb","ntrianglerighteq":"\u22ed","Nu":"\u039d","nu":"\u03bd","num":"#","numero":"\u2116","numsp":"\u2007","nvap":"\u224d\u20d2","nVDash":"\u22af","nVdash":"\u22ae","nvDash":"\u22ad","nvdash":"\u22ac","nvge":"\u2265\u20d2","nvgt":">\u20d2","nvHarr":"\u2904","nvinfin":"\u29de","nvlArr":"\u2902","nvle":"\u2264\u20d2","nvlt":"<\u20d2","nvltrie":"\u22b4\u20d2","nvrArr":"\u2903","nvrtrie":"\u22b5\u20d2","nvsim":"\u223c\u20d2","nwarhk":"\u2923","nwArr":"\u21d6","nwarr":"\u2196","nwarrow":"\u2196","nwnear":"\u2927","Oacute":"\u00d3","oacute":"\u00f3","oast":"\u229b","ocir":"\u229a","Ocirc":"\u00d4","ocirc":"\u00f4","Ocy":"\u041e","ocy":"\u043e","odash":"\u229d","Odblac":"\u0150","odblac":"\u0151","odiv":"\u2a38","odot":"\u2299","odsold":"\u29bc","OElig":"\u0152","oelig":"\u0153","ofcir":"\u29bf","Ofr":"\ud835\udd12","ofr":"\ud835\udd2c","ogon":"\u02db","Ograve":"\u00d2","ograve":"\u00f2","ogt":"\u29c1","ohbar":"\u29b5","ohm":"\u03a9","oint":"\u222e","olarr":"\u21ba","olcir":"\u29be","olcross":"\u29bb","oline":"\u203e","olt":"\u29c0","Omacr":"\u014c","omacr":"\u014d","Omega":"\u03a9","omega":"\u03c9","Omicron":"\u039f","omicron":"\u03bf","omid":"\u29b6","ominus":"\u2296","Oopf":"\ud835\udd46","oopf":"\ud835\udd60","opar":"\u29b7","OpenCurlyDoubleQuote":"\u201c","OpenCurlyQuote":"\u2018","operp":"\u29b9","oplus":"\u2295","Or":"\u2a54","or":"\u2228","orarr":"\u21bb","ord":"\u2a5d","order":"\u2134","orderof":"\u2134","ordf":"\u00aa","ordm":"\u00ba","origof":"\u22b6","oror":"\u2a56","orslope":"\u2a57","orv":"\u2a5b","oS":"\u24c8","Oscr":"\ud835\udcaa","oscr":"\u2134","Oslash":"\u00d8","oslash":"\u00f8","osol":"\u2298","Otilde":"\u00d5","otilde":"\u00f5","Otimes":"\u2a37","otimes":"\u2297","otimesas":"\u2a36","Ouml":"\u00d6","ouml":"\u00f6","ovbar":"\u233d","OverBar":"\u203e","OverBrace":"\u23de","OverBracket":"\u23b4","OverParenthesis":"\u23dc","par":"\u2225","para":"\u00b6","parallel":"\u2225","parsim":"\u2af3","parsl":"\u2afd","part":"\u2202","PartialD":"\u2202","Pcy":"\u041f","pcy":"\u043f","percnt":"%","period":".","permil":"\u2030","perp":"\u22a5","pertenk":"\u2031","Pfr":"\ud835\udd13","pfr":"\ud835\udd2d","Phi":"\u03a6","phi":"\u03c6","phiv":"\u03d5","phmmat":"\u2133","phone":"\u260e","Pi":"\u03a0","pi":"\u03c0","pitchfork":"\u22d4","piv":"\u03d6","planck":"\u210f","planckh":"\u210e","plankv":"\u210f","plus":"+","plusacir":"\u2a23","plusb":"\u229e","pluscir":"\u2a22","plusdo":"\u2214","plusdu":"\u2a25","pluse":"\u2a72","PlusMinus":"\u00b1","plusmn":"\u00b1","plussim":"\u2a26","plustwo":"\u2a27","pm":"\u00b1","Poincareplane":"\u210c","pointint":"\u2a15","Popf":"\u2119","popf":"\ud835\udd61","pound":"\u00a3","Pr":"\u2abb","pr":"\u227a","prap":"\u2ab7","prcue":"\u227c","prE":"\u2ab3","pre":"\u2aaf","prec":"\u227a","precapprox":"\u2ab7","preccurlyeq":"\u227c","Precedes":"\u227a","PrecedesEqual":"\u2aaf","PrecedesSlantEqual":"\u227c","PrecedesTilde":"\u227e","preceq":"\u2aaf","precnapprox":"\u2ab9","precneqq":"\u2ab5","precnsim":"\u22e8","precsim":"\u227e","Prime":"\u2033","prime":"\u2032","primes":"\u2119","prnap":"\u2ab9","prnE":"\u2ab5","prnsim":"\u22e8","prod":"\u220f","Product":"\u220f","profalar":"\u232e","profline":"\u2312","profsurf":"\u2313","prop":"\u221d","Proportion":"\u2237","Proportional":"\u221d","propto":"\u221d","prsim":"\u227e","prurel":"\u22b0","Pscr":"\ud835\udcab","pscr":"\ud835\udcc5","Psi":"\u03a8","psi":"\u03c8","puncsp":"\u2008","Qfr":"\ud835\udd14","qfr":"\ud835\udd2e","qint":"\u2a0c","Qopf":"\u211a","qopf":"\ud835\udd62","qprime":"\u2057","Qscr":"\ud835\udcac","qscr":"\ud835\udcc6","quaternions":"\u210d","quatint":"\u2a16","quest":"?","questeq":"\u225f","QUOT":"\"","quot":"\"","rAarr":"\u21db","race":"\u223d\u0331","Racute":"\u0154","racute":"\u0155","radic":"\u221a","raemptyv":"\u29b3","Rang":"\u27eb","rang":"\u27e9","rangd":"\u2992","range":"\u29a5","rangle":"\u27e9","raquo":"\u00bb","Rarr":"\u21a0","rArr":"\u21d2","rarr":"\u2192","rarrap":"\u2975","rarrb":"\u21e5","rarrbfs":"\u2920","rarrc":"\u2933","rarrfs":"\u291e","rarrhk":"\u21aa","rarrlp":"\u21ac","rarrpl":"\u2945","rarrsim":"\u2974","Rarrtl":"\u2916","rarrtl":"\u21a3","rarrw":"\u219d","rAtail":"\u291c","ratail":"\u291a","ratio":"\u2236","rationals":"\u211a","RBarr":"\u2910","rBarr":"\u290f","rbarr":"\u290d","rbbrk":"\u2773","rbrace":"}","rbrack":"]","rbrke":"\u298c","rbrksld":"\u298e","rbrkslu":"\u2990","Rcaron":"\u0158","rcaron":"\u0159","Rcedil":"\u0156","rcedil":"\u0157","rceil":"\u2309","rcub":"}","Rcy":"\u0420","rcy":"\u0440","rdca":"\u2937","rdldhar":"\u2969","rdquo":"\u201d","rdquor":"\u201d","rdsh":"\u21b3","Re":"\u211c","real":"\u211c","realine":"\u211b","realpart":"\u211c","reals":"\u211d","rect":"\u25ad","REG":"\u00ae","reg":"\u00ae","ReverseElement":"\u220b","ReverseEquilibrium":"\u21cb","ReverseUpEquilibrium":"\u296f","rfisht":"\u297d","rfloor":"\u230b","Rfr":"\u211c","rfr":"\ud835\udd2f","rHar":"\u2964","rhard":"\u21c1","rharu":"\u21c0","rharul":"\u296c","Rho":"\u03a1","rho":"\u03c1","rhov":"\u03f1","RightAngleBracket":"\u27e9","RightArrow":"\u2192","Rightarrow":"\u21d2","rightarrow":"\u2192","RightArrowBar":"\u21e5","RightArrowLeftArrow":"\u21c4","rightarrowtail":"\u21a3","RightCeiling":"\u2309","RightDoubleBracket":"\u27e7","RightDownTeeVector":"\u295d","RightDownVector":"\u21c2","RightDownVectorBar":"\u2955","RightFloor":"\u230b","rightharpoondown":"\u21c1","rightharpoonup":"\u21c0","rightleftarrows":"\u21c4","rightleftharpoons":"\u21cc","rightrightarrows":"\u21c9","rightsquigarrow":"\u219d","RightTee":"\u22a2","RightTeeArrow":"\u21a6","RightTeeVector":"\u295b","rightthreetimes":"\u22cc","RightTriangle":"\u22b3","RightTriangleBar":"\u29d0","RightTriangleEqual":"\u22b5","RightUpDownVector":"\u294f","RightUpTeeVector":"\u295c","RightUpVector":"\u21be","RightUpVectorBar":"\u2954","RightVector":"\u21c0","RightVectorBar":"\u2953","ring":"\u02da","risingdotseq":"\u2253","rlarr":"\u21c4","rlhar":"\u21cc","rlm":"\u200f","rmoust":"\u23b1","rmoustache":"\u23b1","rnmid":"\u2aee","roang":"\u27ed","roarr":"\u21fe","robrk":"\u27e7","ropar":"\u2986","Ropf":"\u211d","ropf":"\ud835\udd63","roplus":"\u2a2e","rotimes":"\u2a35","RoundImplies":"\u2970","rpar":")","rpargt":"\u2994","rppolint":"\u2a12","rrarr":"\u21c9","Rrightarrow":"\u21db","rsaquo":"\u203a","Rscr":"\u211b","rscr":"\ud835\udcc7","Rsh":"\u21b1","rsh":"\u21b1","rsqb":"]","rsquo":"\u2019","rsquor":"\u2019","rthree":"\u22cc","rtimes":"\u22ca","rtri":"\u25b9","rtrie":"\u22b5","rtrif":"\u25b8","rtriltri":"\u29ce","RuleDelayed":"\u29f4","ruluhar":"\u2968","rx":"\u211e","Sacute":"\u015a","sacute":"\u015b","sbquo":"\u201a","Sc":"\u2abc","sc":"\u227b","scap":"\u2ab8","Scaron":"\u0160","scaron":"\u0161","sccue":"\u227d","scE":"\u2ab4","sce":"\u2ab0","Scedil":"\u015e","scedil":"\u015f","Scirc":"\u015c","scirc":"\u015d","scnap":"\u2aba","scnE":"\u2ab6","scnsim":"\u22e9","scpolint":"\u2a13","scsim":"\u227f","Scy":"\u0421","scy":"\u0441","sdot":"\u22c5","sdotb":"\u22a1","sdote":"\u2a66","searhk":"\u2925","seArr":"\u21d8","searr":"\u2198","searrow":"\u2198","sect":"\u00a7","semi":";","seswar":"\u2929","setminus":"\u2216","setmn":"\u2216","sext":"\u2736","Sfr":"\ud835\udd16","sfr":"\ud835\udd30","sfrown":"\u2322","sharp":"\u266f","SHCHcy":"\u0429","shchcy":"\u0449","SHcy":"\u0428","shcy":"\u0448","ShortDownArrow":"\u2193","ShortLeftArrow":"\u2190","shortmid":"\u2223","shortparallel":"\u2225","ShortRightArrow":"\u2192","ShortUpArrow":"\u2191","shy":"\u00ad","Sigma":"\u03a3","sigma":"\u03c3","sigmaf":"\u03c2","sigmav":"\u03c2","sim":"\u223c","simdot":"\u2a6a","sime":"\u2243","simeq":"\u2243","simg":"\u2a9e","simgE":"\u2aa0","siml":"\u2a9d","simlE":"\u2a9f","simne":"\u2246","simplus":"\u2a24","simrarr":"\u2972","slarr":"\u2190","SmallCircle":"\u2218","smallsetminus":"\u2216","smashp":"\u2a33","smeparsl":"\u29e4","smid":"\u2223","smile":"\u2323","smt":"\u2aaa","smte":"\u2aac","smtes":"\u2aac\ufe00","SOFTcy":"\u042c","softcy":"\u044c","sol":"/","solb":"\u29c4","solbar":"\u233f","Sopf":"\ud835\udd4a","sopf":"\ud835\udd64","spades":"\u2660","spadesuit":"\u2660","spar":"\u2225","sqcap":"\u2293","sqcaps":"\u2293\ufe00","sqcup":"\u2294","sqcups":"\u2294\ufe00","Sqrt":"\u221a","sqsub":"\u228f","sqsube":"\u2291","sqsubset":"\u228f","sqsubseteq":"\u2291","sqsup":"\u2290","sqsupe":"\u2292","sqsupset":"\u2290","sqsupseteq":"\u2292","squ":"\u25a1","Square":"\u25a1","square":"\u25a1","SquareIntersection":"\u2293","SquareSubset":"\u228f","SquareSubsetEqual":"\u2291","SquareSuperset":"\u2290","SquareSupersetEqual":"\u2292","SquareUnion":"\u2294","squarf":"\u25aa","squf":"\u25aa","srarr":"\u2192","Sscr":"\ud835\udcae","sscr":"\ud835\udcc8","ssetmn":"\u2216","ssmile":"\u2323","sstarf":"\u22c6","Star":"\u22c6","star":"\u2606","starf":"\u2605","straightepsilon":"\u03f5","straightphi":"\u03d5","strns":"\u00af","Sub":"\u22d0","sub":"\u2282","subdot":"\u2abd","subE":"\u2ac5","sube":"\u2286","subedot":"\u2ac3","submult":"\u2ac1","subnE":"\u2acb","subne":"\u228a","subplus":"\u2abf","subrarr":"\u2979","Subset":"\u22d0","subset":"\u2282","subseteq":"\u2286","subseteqq":"\u2ac5","SubsetEqual":"\u2286","subsetneq":"\u228a","subsetneqq":"\u2acb","subsim":"\u2ac7","subsub":"\u2ad5","subsup":"\u2ad3","succ":"\u227b","succapprox":"\u2ab8","succcurlyeq":"\u227d","Succeeds":"\u227b","SucceedsEqual":"\u2ab0","SucceedsSlantEqual":"\u227d","SucceedsTilde":"\u227f","succeq":"\u2ab0","succnapprox":"\u2aba","succneqq":"\u2ab6","succnsim":"\u22e9","succsim":"\u227f","SuchThat":"\u220b","Sum":"\u2211","sum":"\u2211","sung":"\u266a","sup1":"\u00b9","sup2":"\u00b2","sup3":"\u00b3","Sup":"\u22d1","sup":"\u2283","supdot":"\u2abe","supdsub":"\u2ad8","supE":"\u2ac6","supe":"\u2287","supedot":"\u2ac4","Superset":"\u2283","SupersetEqual":"\u2287","suphsol":"\u27c9","suphsub":"\u2ad7","suplarr":"\u297b","supmult":"\u2ac2","supnE":"\u2acc","supne":"\u228b","supplus":"\u2ac0","Supset":"\u22d1","supset":"\u2283","supseteq":"\u2287","supseteqq":"\u2ac6","supsetneq":"\u228b","supsetneqq":"\u2acc","supsim":"\u2ac8","supsub":"\u2ad4","supsup":"\u2ad6","swarhk":"\u2926","swArr":"\u21d9","swarr":"\u2199","swarrow":"\u2199","swnwar":"\u292a","szlig":"\u00df","Tab":"\t","target":"\u2316","Tau":"\u03a4","tau":"\u03c4","tbrk":"\u23b4","Tcaron":"\u0164","tcaron":"\u0165","Tcedil":"\u0162","tcedil":"\u0163","Tcy":"\u0422","tcy":"\u0442","tdot":"\u20db","telrec":"\u2315","Tfr":"\ud835\udd17","tfr":"\ud835\udd31","there4":"\u2234","Therefore":"\u2234","therefore":"\u2234","Theta":"\u0398","theta":"\u03b8","thetasym":"\u03d1","thetav":"\u03d1","thickapprox":"\u2248","thicksim":"\u223c","ThickSpace":"\u205f\u200a","thinsp":"\u2009","ThinSpace":"\u2009","thkap":"\u2248","thksim":"\u223c","THORN":"\u00de","thorn":"\u00fe","Tilde":"\u223c","tilde":"\u02dc","TildeEqual":"\u2243","TildeFullEqual":"\u2245","TildeTilde":"\u2248","times":"\u00d7","timesb":"\u22a0","timesbar":"\u2a31","timesd":"\u2a30","tint":"\u222d","toea":"\u2928","top":"\u22a4","topbot":"\u2336","topcir":"\u2af1","Topf":"\ud835\udd4b","topf":"\ud835\udd65","topfork":"\u2ada","tosa":"\u2929","tprime":"\u2034","TRADE":"\u2122","trade":"\u2122","triangle":"\u25b5","triangledown":"\u25bf","triangleleft":"\u25c3","trianglelefteq":"\u22b4","triangleq":"\u225c","triangleright":"\u25b9","trianglerighteq":"\u22b5","tridot":"\u25ec","trie":"\u225c","triminus":"\u2a3a","TripleDot":"\u20db","triplus":"\u2a39","trisb":"\u29cd","tritime":"\u2a3b","trpezium":"\u23e2","Tscr":"\ud835\udcaf","tscr":"\ud835\udcc9","TScy":"\u0426","tscy":"\u0446","TSHcy":"\u040b","tshcy":"\u045b","Tstrok":"\u0166","tstrok":"\u0167","twixt":"\u226c","twoheadleftarrow":"\u219e","twoheadrightarrow":"\u21a0","Uacute":"\u00da","uacute":"\u00fa","Uarr":"\u219f","uArr":"\u21d1","uarr":"\u2191","Uarrocir":"\u2949","Ubrcy":"\u040e","ubrcy":"\u045e","Ubreve":"\u016c","ubreve":"\u016d","Ucirc":"\u00db","ucirc":"\u00fb","Ucy":"\u0423","ucy":"\u0443","udarr":"\u21c5","Udblac":"\u0170","udblac":"\u0171","udhar":"\u296e","ufisht":"\u297e","Ufr":"\ud835\udd18","ufr":"\ud835\udd32","Ugrave":"\u00d9","ugrave":"\u00f9","uHar":"\u2963","uharl":"\u21bf","uharr":"\u21be","uhblk":"\u2580","ulcorn":"\u231c","ulcorner":"\u231c","ulcrop":"\u230f","ultri":"\u25f8","Umacr":"\u016a","umacr":"\u016b","uml":"\u00a8","UnderBar":"_","UnderBrace":"\u23df","UnderBracket":"\u23b5","UnderParenthesis":"\u23dd","Union":"\u22c3","UnionPlus":"\u228e","Uogon":"\u0172","uogon":"\u0173","Uopf":"\ud835\udd4c","uopf":"\ud835\udd66","UpArrow":"\u2191","Uparrow":"\u21d1","uparrow":"\u2191","UpArrowBar":"\u2912","UpArrowDownArrow":"\u21c5","UpDownArrow":"\u2195","Updownarrow":"\u21d5","updownarrow":"\u2195","UpEquilibrium":"\u296e","upharpoonleft":"\u21bf","upharpoonright":"\u21be","uplus":"\u228e","UpperLeftArrow":"\u2196","UpperRightArrow":"\u2197","Upsi":"\u03d2","upsi":"\u03c5","upsih":"\u03d2","Upsilon":"\u03a5","upsilon":"\u03c5","UpTee":"\u22a5","UpTeeArrow":"\u21a5","upuparrows":"\u21c8","urcorn":"\u231d","urcorner":"\u231d","urcrop":"\u230e","Uring":"\u016e","uring":"\u016f","urtri":"\u25f9","Uscr":"\ud835\udcb0","uscr":"\ud835\udcca","utdot":"\u22f0","Utilde":"\u0168","utilde":"\u0169","utri":"\u25b5","utrif":"\u25b4","uuarr":"\u21c8","Uuml":"\u00dc","uuml":"\u00fc","uwangle":"\u29a7","vangrt":"\u299c","varepsilon":"\u03f5","varkappa":"\u03f0","varnothing":"\u2205","varphi":"\u03d5","varpi":"\u03d6","varpropto":"\u221d","vArr":"\u21d5","varr":"\u2195","varrho":"\u03f1","varsigma":"\u03c2","varsubsetneq":"\u228a\ufe00","varsubsetneqq":"\u2acb\ufe00","varsupsetneq":"\u228b\ufe00","varsupsetneqq":"\u2acc\ufe00","vartheta":"\u03d1","vartriangleleft":"\u22b2","vartriangleright":"\u22b3","Vbar":"\u2aeb","vBar":"\u2ae8","vBarv":"\u2ae9","Vcy":"\u0412","vcy":"\u0432","VDash":"\u22ab","Vdash":"\u22a9","vDash":"\u22a8","vdash":"\u22a2","Vdashl":"\u2ae6","Vee":"\u22c1","vee":"\u2228","veebar":"\u22bb","veeeq":"\u225a","vellip":"\u22ee","Verbar":"\u2016","verbar":"|","Vert":"\u2016","vert":"|","VerticalBar":"\u2223","VerticalLine":"|","VerticalSeparator":"\u2758","VerticalTilde":"\u2240","VeryThinSpace":"\u200a","Vfr":"\ud835\udd19","vfr":"\ud835\udd33","vltri":"\u22b2","vnsub":"\u2282\u20d2","vnsup":"\u2283\u20d2","Vopf":"\ud835\udd4d","vopf":"\ud835\udd67","vprop":"\u221d","vrtri":"\u22b3","Vscr":"\ud835\udcb1","vscr":"\ud835\udccb","vsubnE":"\u2acb\ufe00","vsubne":"\u228a\ufe00","vsupnE":"\u2acc\ufe00","vsupne":"\u228b\ufe00","Vvdash":"\u22aa","vzigzag":"\u299a","Wcirc":"\u0174","wcirc":"\u0175","wedbar":"\u2a5f","Wedge":"\u22c0","wedge":"\u2227","wedgeq":"\u2259","weierp":"\u2118","Wfr":"\ud835\udd1a","wfr":"\ud835\udd34","Wopf":"\ud835\udd4e","wopf":"\ud835\udd68","wp":"\u2118","wr":"\u2240","wreath":"\u2240","Wscr":"\ud835\udcb2","wscr":"\ud835\udccc","xcap":"\u22c2","xcirc":"\u25ef","xcup":"\u22c3","xdtri":"\u25bd","Xfr":"\ud835\udd1b","xfr":"\ud835\udd35","xhArr":"\u27fa","xharr":"\u27f7","Xi":"\u039e","xi":"\u03be","xlArr":"\u27f8","xlarr":"\u27f5","xmap":"\u27fc","xnis":"\u22fb","xodot":"\u2a00","Xopf":"\ud835\udd4f","xopf":"\ud835\udd69","xoplus":"\u2a01","xotime":"\u2a02","xrArr":"\u27f9","xrarr":"\u27f6","Xscr":"\ud835\udcb3","xscr":"\ud835\udccd","xsqcup":"\u2a06","xuplus":"\u2a04","xutri":"\u25b3","xvee":"\u22c1","xwedge":"\u22c0","Yacute":"\u00dd","yacute":"\u00fd","YAcy":"\u042f","yacy":"\u044f","Ycirc":"\u0176","ycirc":"\u0177","Ycy":"\u042b","ycy":"\u044b","yen":"\u00a5","Yfr":"\ud835\udd1c","yfr":"\ud835\udd36","YIcy":"\u0407","yicy":"\u0457","Yopf":"\ud835\udd50","yopf":"\ud835\udd6a","Yscr":"\ud835\udcb4","yscr":"\ud835\udcce","YUcy":"\u042e","yucy":"\u044e","Yuml":"\u0178","yuml":"\u00ff","Zacute":"\u0179","zacute":"\u017a","Zcaron":"\u017d","zcaron":"\u017e","Zcy":"\u0417","zcy":"\u0437","Zdot":"\u017b","zdot":"\u017c","zeetrf":"\u2128","ZeroWidthSpace":"\u200b","Zeta":"\u0396","zeta":"\u03b6","Zfr":"\u2128","zfr":"\ud835\udd37","ZHcy":"\u0416","zhcy":"\u0436","zigrarr":"\u21dd","Zopf":"\u2124","zopf":"\ud835\udd6b","Zscr":"\ud835\udcb5","zscr":"\ud835\udccf","zwj":"\u200d","zwnj":"\u200c"};

  function literalHref(destination) {
    if (safeUrl(destination) === '#') return '#';
    return escapeHtml(safeUrl(encodeURI(destination).replace(/%25([A-Za-z0-9]{2})/g, '%$1')));
  }

  function textAutolinks(html) {
    if (!/https?:\/\/|www\.|@/i.test(html)) return html;

    function decoded(value) {
      return value.replace(/&(#x[0-9a-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);/gi, (whole, entity) => {
        if (entity[0] !== '#') return HTML_ENTITIES[entity] || whole;
        const n = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return String.fromCodePoint(!n || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff || n < 0x20 && ![9, 10, 13].includes(n) || n >= 0x7f && n <= 0x9f ? 0xfffd : n);
      });
    }
    let out = '', units = [], hidden = '', blocked = 0;
    function flush() {
      const value = units.map(c => c.value).join('');
      // The text-event pass recognizes URLs before emails. An email-like
      // prefix cannot steal a later www/http destination in the same event.
      const urls = [];
      for (let at = 0; at < value.length; at++) {
        if (!/^(?:https?:\/\/|www\.)/i.test(value.slice(at))) continue;
        const link = literalAutolink(value, at, false, false);
        if (link && !link.destination.startsWith('mailto:')) { urls.push({ start: at, end: at + link.length }); at += link.length - 1; }
      }
      let cursor = 0, point = 0;
      while (point < value.length) {
        let link = literalAutolink(value, point, false, false);
        if (link && link.destination.startsWith('mailto:') && urls.some(url => url.start > point && url.start < point + link.length)) { point++; continue; }
        if (!link) {
          const invalidEmail = /^[A-Za-z0-9.+_-]+@[A-Za-z0-9._-]+/.exec(value.slice(point));
          point += invalidEmail && !/[A-Za-z0-9\/]/.test(value[point - 1] || '') ? invalidEmail[0].indexOf('@') + 1 : 1;
          continue;
        }
        const before = units.slice(cursor, point).map(c => c.html).join('');
        out += before + `<a href="${literalHref(link.destination)}" data-autolink="true">` + units.slice(point, point + link.length).map(c => c.html).join('') + '</a>';
        point += link.length; cursor = point;
      }
      out += units.slice(cursor).map(c => c.html).join('') + hidden;
      units = []; hidden = '';
    }
    for (const token of html.match(/<span class="cw-mk">[^]*?<\/span>|<span class="cw-atom"[^>]*>[^]*?<\/span><\/span>|<[^>]*>|[^<]+/g) || []) {
      if (!blocked && /^<span class="cw-mk">/.test(token) && decoded(token.replace(/<[^>]+>/g, '')) === '\\') { hidden += token; continue; }
      const atom = !blocked && /^<span class="cw-atom"[^>]*data-label="([^"]*)"/.exec(token);
      if (token[0] === '<' && !atom) {
        flush(); out += token;
        if (/^<(?:a|code)\b/i.test(token)) blocked++;
        if (/^<\/(?:a|code)>/i.test(token)) blocked--;
        continue;
      }
      if (blocked) { out += token; continue; }
      const value = atom ? decoded(atom[1]) : decoded(token);
      if (atom) {
        // Entity atoms are indivisible source owners, usually one character.
        for (let i = 0; i < value.length; i++) units.push({ value: value[i], html: i ? '' : hidden + token });
        hidden = '';
      } else {
        for (const piece of token.match(/&(?:#x[0-9a-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);|[^]/gi) || []) {
          const chars = decoded(piece);
          if (chars === piece && piece.length > 1) {
            for (const ch of piece) { units.push({ value: ch, html: hidden + escapeHtml(ch) }); hidden = ''; }
            continue;
          }
          for (let i = 0; i < chars.length; i++) units.push({ value: chars[i], html: i ? '' : hidden + piece });
          hidden = '';
        }
      }
    }
    flush(); return out;
  }

  // Source-only marks and decoded entity spans stay in the same text event.
  // Actual tags are boundaries. Ask the existing text-event URL matcher before
  // a hashtag can split that event, retaining the original tag rule otherwise.
  function tagContinuesAutolink(html, tag) {
    function decoded(value) { return destinationText(value.replace(/\\/g, '\\\\')); }
    const visible = html.replace(/<span class="cw-atom"[^>]*data-label="([^"]*)"[^>]*><span class="cw-mk">[^]*?<\/span><\/span>/g, (_, label) => escapeHtml(decoded(label)))
      .replace(/<span class="cw-mk">[^]*?<\/span>/g, '');
    const tail = decoded((/(?:^|>)([^<]*)$/.exec(visible) || ['', ''])[1]);
    const start = /(?:https?:\/\/|www\.)[^\s]*$/i.exec(tail);
    if (!start) return false;
    const text = tail + tag, link = literalAutolink(text, start.index, false, false);
    return !!link && start.index + link.length === text.length;
  }

  // The site's Descant extension runs after Markdown and automatic links.
  // Pair source == tokens only among siblings, never across a code/link or
  // emphasis boundary, and never across a source newline. Escaped equals use
  // an entity spelling so they cannot become extension delimiters here.
  function textHighlights(html, opts) {
    if (!html.includes('==')) return html;
    const root = { parts: [], open: '', close: '', blocked: false }, stack = [root];
    function finish(frame) {
      if (frame.blocked) return frame.open + frame.parts.map(p => typeof p === 'string' ? p : p.html).join('') + frame.close;
      const tokens = [];
      for (const part of frame.parts) {
        if (typeof part !== 'string') { tokens.push(part); continue; }
        let at = 0;
        for (const match of part.matchAll(/==|\n/g)) {
          if (match.index > at) tokens.push({ html: part.slice(at, match.index) });
          tokens.push({ delimiter: match[0] === '==', newline: match[0] === '\n', html: match[0] });
          at = match.index + match[0].length;
        }
        if (at < part.length) tokens.push({ html: part.slice(at) });
      }
      let out = '';
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].delimiter) { out += tokens[i].html; continue; }
        let end = i + 1;
        while (end < tokens.length && !tokens[end].delimiter && !tokens[end].newline) end++;
        if (end < tokens.length && tokens[end].delimiter && end > i + 1) {
          out += '<mark>' + sourceMark('==', opts) + tokens.slice(i + 1, end).map(t => t.html).join('') + sourceMark('==', opts) + '</mark>'; i = end;
        } else out += '==';
      }
      return frame.open + out + frame.close;
    }
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      const frame = stack[stack.length - 1], open = /^<([a-z][\w-]*)(?:\s|>)/i.exec(token), close = /^<\/([a-z][\w-]*)>/i.exec(token);
      if (close && stack.length > 1 && frame.tag === close[1].toLowerCase()) {
        frame.close = token; stack.pop(); stack[stack.length - 1].parts.push({ html: finish(frame) });
      } else if (open && !/^(?:br|hr|img|input|meta|link|wbr)$/i.test(open[1])) {
        stack.push({ tag: open[1].toLowerCase(), open: token, close: '', parts: [], blocked: frame.blocked || /^(?:code|pre|script|style)$/i.test(open[1]) || /class="cw-mk"/.test(token) });
      } else if (token[0] === '<') frame.parts.push({ html: token });
      else frame.parts.push(token);
    }
    while (stack.length > 1) { const frame = stack.pop(); stack[stack.length - 1].parts.push({ html: finish(frame) }); }
    return finish(root);
  }

  function renderInlineInternal(text, options) {
    const opaqueTokens = [];
    const opts = options || {};
    const footnotes = opts.footnotes || null;
    let html = '';
    let index = 0;
    const stars = [];
    // A link label's brackets remain punctuation for delimiter flanking and
    // the rule of three, even though its body is rendered recursively.
    const emphasisText = opts.inLink ? '[' + text + ']' : text, emphasisOffset = opts.inLink ? 1 : 0;
    const searches = { results: new Map(), closing: new Map(), links: new Map() };
    let brackets = 0;
    const automaticCandidate = /https?:\/\/|www\.|@/i.test(text);
    const labels = new Map();
    let wikiCloser, embedCloser;
    function labelAt(opener) {
      if (labels.has(opener)) return labels.get(opener);
      const stack = [{ at: opener, nestedLink: false }];
      for (let at = opener + 1; at < text.length; at++) {
        if (text[at] === '\\') { at++; continue; }
        if (text[at] === '`') {
          let ticks = 1; while (text[at + ticks] === '`') ticks++;
          const close = findClosing(text, '`'.repeat(ticks), at + ticks);
          at = close >= 0 ? close + ticks - 1 : at + ticks - 1; continue;
        }
        if (text[at] === '[') stack.push({ at, nestedLink: false });
        if (text[at] === ']') {
          const frame = stack.pop(), info = { end: at, nestedLink: frame.nestedLink };
          labels.set(frame.at, info);
          if (!stack.length) return info;
          if (frame.nestedLink || !(text[frame.at - 1] === '!' && !escapedAt(text, frame.at - 1)) && text[at + 1] === '(' && inlineDestination(text, at + 2)) stack[stack.length - 1].nestedLink = true;
        }
      }
      // Every unmatched ancestor shares this failed suffix. Reusing both
      // matched and failed labels keeps deep [[... input linear.
      for (const frame of stack) labels.set(frame.at, { end: -1, nestedLink: false });
      return labels.get(opener);
    }


    while (index < text.length) {
      // Ordinary text cannot introduce syntax. Autolink candidates retain the
      // character scanner because URL punctuation belongs to the destination.
      if (!automaticCandidate) {
        const plain = /^[^\\`*_~=#<&[\]!%\n]+/.exec(text.slice(index));
        if (plain) { var chunk = plain[0]; if (text[index + chunk.length] === '\n' && chunk.endsWith('  ')) chunk = chunk.slice(0, -2); if (chunk) { html += escapeHtml(chunk); index += chunk.length; continue; } }
      }
      // `[NAME: …]`, a note addressed to a named writer, the form drafts use. It is
      // the same kind of thing as %%a writer note%% and is treated the same way: nothing to a reader, dimmed to a writer. The name must
      // be two or more capitals followed by a colon, so `[Names matter](url)` is
      // still an ordinary link.
      if (text[index] === '[' && !text.startsWith('[[', index)) {
        const marker = /^\[([A-Z][A-Z0-9 ]+):/.exec(text.slice(index));
        if (marker) {
          const close = text.indexOf(']', index + marker[0].length);
          if (close >= 0) {
            if (opts.showWriterNotes) {
              /* Same text, byte for byte -- comment anchors match a block's text and
                 a marker that quietly changed shape would move every anchor in the
                 paragraph. What is added is structure the stylesheet can reach: whose
                 it is, and where the name ends and the instruction begins. */
              const whole = text.slice(index + 1, close);
              const cut = whole.indexOf(':');
              html += sourceMark("[", opts) + `<span class="writer-note" data-owner="${escapeHtml(marker[1].trim())}">` +
                `<span class="wn-who">${escapeHtml(whole.slice(0, cut + 1))}</span>` +
                `<span class="wn-brief">${escapeHtml(whole.slice(cut + 1))}</span></span>` + sourceMark("]", opts);
            }
            index = close + 1;
            continue;
          }
        }
      }
      if (text.startsWith('%%', index)) {
        const end = findClosing(text, '%%', index + 2);
        if (end >= 0) {
          if (opts.showWriterNotes) html += sourceMark("%%", opts) + `<span class="writer-note">${escapeHtml(text.slice(index + 2, end))}</span>` + sourceMark("%%", opts);
          index = end + 2;
          continue;
        }
      }

      {
        const tail = text.slice(index), previous = text[index - 1] || '';
        // Opaque inline HTML owns its contents before bare-link discovery.
        // The app displays it safely as literal source; do not invent links
        // inside declarations, comments or complete processing instructions.
        const opaqueHTML = /^(?:<!--(?:>|->|[^]*?-->)|<\?[^]*?\?>|<!\[CDATA\[[^]*?\]\]>|<![A-Za-z][^>]*>)/.exec(tail);
        if (opaqueHTML) { html += '<cw-opaque-' + opaqueTokens.length + '>'; opaqueTokens.push(opaqueHTML[0]); index += opaqueHTML[0].length; continue; }
        const angle = !/^<!(?:[A-Za-z]|@)/.test(tail) && /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)>/.exec(tail);
        const escapedEmail = !opts.inLink && !brackets && /^\\[.+_-][A-Za-z0-9.+_-]*_/.test(tail) && literalAutolink(tail.slice(1), 0, true, false);
        if (escapedEmail && escapedEmail.destination.startsWith('mailto:')) {
          html += `<a href="${literalHref(escapedEmail.destination)}" data-autolink="true">${sourceMark('\\', opts)}${escapeHtml(escapedEmail.label)}</a>`;
          index += escapedEmail.length + 1; continue;
        }
        const link = !opts.inLink && literalAutolink(text, index, true, brackets);
        const label = angle ? angle[1] : link && link.label;
        if (label) {
          const destination = angle ? (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(label) ? label : 'mailto:' + label) : link.destination;
          html += `<a href="${literalHref(destination)}" data-autolink="true">${angle ? sourceMark('<', opts) : ''}${escapeHtml(label)}${angle ? sourceMark('>', opts) : ''}</a>`;
          index += angle ? angle[0].length : link.length;
          continue;
        }
      }

      if (text[index] === '&') {
        const entity = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(text.slice(index));
        if (entity && (entity[0][1] === '#' || Object.hasOwn(HTML_ENTITIES, entity[0].slice(1, -1)))) {
          let value = entity[0];
          if (value[1] === '#') {
            const number = /^&#[xX]/.test(value) ? parseInt(value.slice(3), 16) : parseInt(value.slice(2), 10);
            value = escapeHtml(String.fromCodePoint(!number || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff || number < 0x20 && ![9, 10, 13].includes(number) || number >= 0x7f && number <= 0x9f ? 0xfffd : number));
          }
          html += opts.editSource ? `<span class="cw-atom" contenteditable="false" data-label="${value}">${sourceMark(entity[0], opts)}</span>` : value;
          index += entity[0].length;
          continue;
        }
      }

      if (text[index] === '`') {
        let ticks = 1;
        while (text[index + ticks] === '`') ticks += 1;
        const delimiter = '`'.repeat(ticks);
        const end = findClosing(text, delimiter, index + ticks);
        if (end >= 0) {
          const raw = text.slice(index + ticks, end), normalized = raw.replace(/\r\n?|\n/g, ' ');
          const padded = /^ [\s\S]* $/.test(normalized) && /[^ ]/.test(normalized);
          const padStart = padded ? (/^(?:\r\n|\r|\n| )/.exec(raw) || [''])[0] : '';
          const padEnd = padded ? (/(?:\r\n|\r|\n| )$/.exec(raw) || [''])[0] : '';
          const code = raw.slice(padStart.length, raw.length - padEnd.length);
          const prefix = delimiter + padStart;
          const suffix = padEnd + delimiter;
          // Keep the source projection lossless. A source newline occupies one
          // editable offset, but paints as the code span's normalized space.
          let body = opts.editSource ? escapeHtml(code).replace(/\n/g, '<span class="cw-code-newline">\n</span>') : escapeHtml(code.replace(/\r\n?|\n/g, ' '));
          // GFM removes the table escape even inside an inline code span.
          if (opts.tableCell) body = body.replace(/\\\|/g, () => sourceMark('\\', opts) + '|');
          html += `<code>${sourceMark(prefix, opts)}${body}${sourceMark(suffix, opts)}</code>`;
          index = end + ticks;
          continue;
        }
        html += delimiter;
        index += ticks;
        continue;
      }

      if (text.startsWith('![[', index)) {
        if (embedCloser === undefined || embedCloser >= 0 && embedCloser < index + 3) embedCloser = text.indexOf(']]', index + 3);
        const end = embedCloser;
        if (end >= 0) {
          html += sourceAtom(text.slice(index, end + 2), renderEmbed(parseEmbedSpec(text.slice(index + 3, end))), opts);
          index = end + 2;
          continue;
        }
      }

      if (text.startsWith('[[', index)) {
        if (wikiCloser === undefined || wikiCloser >= 0 && wikiCloser < index + 2) wikiCloser = findClosing(text, ']]', index + 2);
        const end = wikiCloser;
        if (end >= 0) {
          const wiki = parseWikiSpec(text.slice(index + 2, end));
          const label = wiki.shown || wiki.target;
          const bar = text.slice(index + 2, end).indexOf('|');
          const rawStart = bar >= 0 && wiki.shown ? index + 3 + bar : index + 2;
          const labelAt = text.indexOf(label, rawStart);
          html += `<a class="wikilink" data-target="${escapeHtml(wiki.target)}">${sourceMark(text.slice(index, labelAt), opts)}${wiki.shown ? renderInlineInternal(label, { ...opts, inLink: true, referenceOffset: (opts.referenceOffset || 0) + labelAt }) : escapeHtml(label)}${sourceMark(text.slice(labelAt + label.length, end + 2), opts)}</a>`;
          index = end + 2;
          continue;
        }
      }

      const imageStart = text.startsWith('![', index);
      // Complete wiki tokens were consumed above; an incomplete opener
      // can still be an ordinary nested Markdown link label.
      const linkStart = !opts.inLink && text[index] === '[';
      if (imageStart || linkStart) {
        const labelStart = index + (imageStart ? 2 : 1);
        const label = labelAt(labelStart - 1), labelEnd = label.end, nestedLabelLink = !imageStart && label.nestedLink;
        if (labelEnd >= 0 && !nestedLabelLink && text[labelEnd + 1] === '(') {
          const target = inlineDestination(text, labelEnd + 2);
          const urlEnd = target ? target.end : -1;
          if (target) {
            const label = text.slice(labelStart, labelEnd);
            const url = literalHref(target.destination);
            const title = target.title === undefined ? '' : ` title="${escapeHtml(target.title)}"`;
            html += imageStart
              ? sourceAtom(text.slice(index, urlEnd + 1), `<img src="${url}" alt="${escapeHtml(label)}"${title}>`, opts)
              : `<a href="${url}"${title}>${sourceMark('[', opts)}${renderInlineInternal(label, { ...opts, inLink: true, referenceOffset: (opts.referenceOffset || 0) + labelStart })}${sourceMark(text.slice(labelEnd, urlEnd + 1), opts)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
        // A malformed definition stays visible instead of becoming a shortcut.
        const definitionLike = labelEnd >= 0 && text[labelEnd + 1] === ':' && /^ {0,3}$/.test(text.slice(0, index));
        if (labelEnd >= 0 && text[labelStart] !== '^' && opts.references && !definitionLike) {
          let end = labelEnd, key = text.slice(labelStart, labelEnd);
          const explicit = text[labelEnd + 1] === '[';
          if (explicit) {
            end = findClosing(text, ']', labelEnd + 2);
            if (end >= 0) key = text.slice(labelEnd + 2, end) || key;
          }
          const reference = end >= 0 && opts.references[referenceLabel(key)];
          if (reference && opts.usedReferences) opts.usedReferences.add(referenceLabel(key));
          if (reference) {
            const label = text.slice(labelStart, labelEnd), url = literalHref(reference.destination);
            if (opts.referenceSpans) opts.referenceSpans.push({ start: (opts.referenceOffset || 0) + index, end: (opts.referenceOffset || 0) + end + 1, label, image: imageStart });
            const title = reference.title === undefined ? '' : ` title="${escapeHtml(reference.title)}"`;
            html += imageStart ? sourceAtom(text.slice(index, end + 1), `<img src="${url}" alt="${escapeHtml(label)}"${title}>`, opts)
              : `<a href="${url}"${title}>${sourceMark('[', opts)}${renderInlineInternal(label, { ...opts, inLink: true, referenceSpans: null })}${sourceMark(text.slice(labelEnd, end + 1), opts)}</a>`;
            index = end + 1;
            continue;
          }

        }
      }

      const allowedHtml = /^(?:<br\s*\/?\s*>|<span style="white-space:pre">|<\/?(?:sup|sub|strong|em|mark|del|span)>)/i.exec(text.slice(index));
      if (allowedHtml) {
        html += sourceMark(allowedHtml[0], opts) + allowedHtml[0].toLowerCase().replace(/<br\s*\/?\s*>/, '<br>');
        index += allowedHtml[0].length;
        continue;
      }

      if (text.startsWith('[^', index)) {
        const end = text.indexOf(']', index + 2);
        if (end > index + 2) {
          const key = text.slice(index + 2, end);
          const exists = footnotes && Object.prototype.hasOwnProperty.call(footnotes, key);
          const missing = exists ? '' : ' missing-note';
          const title = exists ? '' : ' title="Missing note"';
          // The KEY is the author's (`[^tao]`); the READER sees a number, assigned by
          // first appearance in the page. A named key printed as a superscript is as
          // wide as a word and overprints the note beside it at the foot.
          const label = footnoteNumber(opts, key);
          html += opts.editSource
            ? `<sup class="footnote-ref${missing}"${title} data-key="${escapeHtml(key)}"><a class="cw-atom cw-fnref" href="#fn-${escapeHtml(key)}" data-footnote="${escapeHtml(key)}" data-source-end="${(opts.referenceOffset || 0) + end + 1}" contenteditable="false" data-label="${label}">${sourceMark(text.slice(index, end + 1), opts)}</a></sup>`
            : `<sup class="footnote-ref${missing}"${title} data-key="${escapeHtml(key)}"><a href="#fn-${escapeHtml(key)}" data-footnote="${escapeHtml(key)}">${label}</a></sup>`;
          index = end + 1;
          continue;
        }
      }

      if (text[index] === '*' || text[index] === '_') {
        const marker = text[index];
        let size = 1;
        while (text[index + size] === marker) size++;
        stars.push({ at: index, marker, size, left: size, open: emphasisCanOpen(emphasisText, index + emphasisOffset, size), close: emphasisCanClose(emphasisText, index + emphasisOffset, size), opens: [], closes: [] });
        html += `<cw-star-${stars.length - 1}>`;
        index += size;
        continue;
      }

      if (text[index] === '~') {
        let size = 1;
        while (text[index + size] === '~') size++;
        if (size <= 2) {
          stars.push({ at: index, marker: '~', size, left: size, open: emphasisCanOpen(emphasisText, index + emphasisOffset, size), close: emphasisCanClose(emphasisText, index + emphasisOffset, size), opens: [], closes: [] });
          html += `<cw-star-${stars.length - 1}>`;
        } else html += '~'.repeat(size);
        index += size;
        continue;
      }
      if (text[index] === '#') {
        const previous = text[index - 1] || '';
        const tag = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(text.slice(index));
        if (tag && !/(?:https?:\/\/|www\.)[^\s<]*$/i.test(text.slice(0, index)) && !tagContinuesAutolink(html, tag[0]) && (!previous || /[\s([{'"“‘]/.test(previous)) && !/^(?:www\.|https?:\/\/)|^\S*@\S+/i.test(text.slice(index + 1))) {
          html += `<a class="tag" data-tag="${escapeHtml(tag[1])}">#${escapeHtml(tag[1])}</a>`;
          index += tag[0].length;
          continue;
        }
      }

      if (text.startsWith('  \n', index)) {
        html += sourceMark('  \n', opts) + '<br>';
        index += 3;
        continue;
      }
      if (text.startsWith('\\\n', index)) {
        html += sourceMark('\\', opts) + '<br>\n';
        index += 2;
        continue;
      }
      if (text[index] === '\n') {
        html += '\n';
        index += 1;
        continue;
      }
      if (text[index] === '\\' && index + 1 < text.length && /[!-/:-@\[-`{-~]/.test(text[index + 1])) {
        html += sourceMark('\\', opts) + (text[index + 1] === '=' ? '&#61;' : escapeHtml(text[index + 1]));
        index += 2;
        continue;
      }

      if (text[index] === '[') brackets++;
      if (text[index] === ']' && brackets) brackets--;
      html += escapeHtml(text[index]);
      index += 1;
    }
    // CommonMark process-emphasis. Each delimiter stays on a linked stack
    // until consumed or removed by a match. A failed opener search establishes
    // a lower bound for this marker, closer kind and remaining-length mod 3.
    // GFM strike boundaries in link labels are resolved before emphasis.
    // Use the nearest eligible opener, never a forward greedy span: another
    // tilde can open after punctuation before the final closer arrives.
    if (opts.inLink) {
      const openers = [];
      stars.forEach((closer, end) => {
        if (closer.marker !== '~') return;
        let found = -1;
        if (closer.close) for (let i = openers.length - 1; i >= 0; i--) {
          if (stars[openers[i]].size === closer.size) { found = i; break; }
        }
        if (found >= 0) {
          const start = openers[found], opener = stars[start], marker = sourceMark('~'.repeat(closer.size), opts);
          opener.opens.push('<del>' + marker); closer.closes.push(marker + '</del>');
          opener.left = closer.left = 0;
          for (let i = start + 1; i < end; i++) { if (stars[i].strikeScope == null) stars[i].strikeScope = start; }
          openers.length = found;
        } else if (closer.open) openers.push(end);
      });
    }
    const scopeBottoms = new Map();
    stars.forEach((run, at) => { run.prev = at - 1; run.next = at + 1; });
    function remove(at) {
      const run = stars[at];
      if (run.prev >= 0) stars[run.prev].next = run.next;
      if (run.next < stars.length) stars[run.next].prev = run.prev;
    }
    let end = 0;
    while (end < stars.length) {
      const closer = stars[end];
      if (!closer.left || opts.inLink && closer.marker === '~' || !closer.close) { end = closer.next; continue; }
      const kind = (closer.open ? 3 : 0) + closer.left % 3;
      if (!scopeBottoms.has(closer.strikeScope)) scopeBottoms.set(closer.strikeScope, { '*': Array(6).fill(-1), '_': Array(6).fill(-1), '~': Array(6).fill(-1) });
      const bottoms = scopeBottoms.get(closer.strikeScope);
      const bottom = bottoms[closer.marker][kind];
      let start = closer.prev, oddMatch = false;
      while (start > bottom) {
        const opener = stars[start];
        const odd = closer.marker !== '~' && (opener.close || closer.open) && (opener.left + closer.left) % 3 === 0 &&
          (opener.left % 3 !== 0 || closer.left % 3 !== 0);
        if (opener.strikeScope === closer.strikeScope && opener.left && opener.marker === closer.marker && opener.open && (closer.marker !== '~' || opener.size === closer.size)) {
          if (!odd) break;
          oddMatch = true;
        }
        start = opener.prev;
      }
      if (start <= bottom) {
        if (!oddMatch) bottoms[closer.marker][kind] = closer.prev;
        const next = closer.next;
        if (!closer.open) remove(end);
        end = next;
        continue;
      }
      const opener = stars[start], size = closer.marker === '~' ? closer.size : opener.left >= 2 && closer.left >= 2 ? 2 : 1;
      const tag = closer.marker === '~' ? 'del' : size === 2 ? 'strong' : 'em', marker = sourceMark(opener.marker.repeat(size), opts);
      opener.opens.unshift('<' + tag + '>' + marker);
      closer.closes.push(marker + '</' + tag + '>');
      opener.left -= size; closer.left -= size;
      // Unmatched delimiters inside the newly formed emphasis are literal and
      // cannot pair with a later closer outside that emphasis.
      let inside = opener.next;
      while (inside < end) { const next = stars[inside].next; remove(inside); inside = next; }
      if (!opener.left) remove(start);
      if (!closer.left) { const next = closer.next; remove(end); end = next; }
    }
    html = html.replace(/<cw-star-(\d+)>/g, (_, index) => {
      const run = stars[Number(index)];
      return run.closes.join('') + run.marker.repeat(run.left) + run.opens.join('');
    });
    return textHighlights(opts.inLink ? html : textAutolinks(html), opts).replace(/<cw-opaque-(\d+)>/g, (_, id) => escapeHtml(opaqueTokens[Number(id)]));
  }

  function renderInline(text) {
    const options = arguments[1] || {}, value = String(text);
    // Serialization can query the existing raw-address matcher without parsing
    // visible punctuation as Markdown. Keep the result on the HTML interface.
    if (options.literalAutolinkAt != null) {
      const link = literalAutolink(value, options.literalAutolinkAt, true, false);
      return link ? `<a href="${literalHref(link.destination)}">${escapeHtml(link.label)}</a>` : '';
    }
    // Serializer probes need no HTML when neither literal-link pass can match.
    // The opt-in probe mode otherwise uses the full, unchanged renderer.
    if (options.autolinkProbe && !hasAutolinkCandidate(value)) return '';
    return renderInlineInternal(value, options);
  }

  function referenceSourceText(value, references, inLink) {
    // The renderer owns reference matching, including escapes, code and nesting.
    // Replace only its resolved source spans before the existing text cleanup.
    const referenceSpans = [];
    renderInlineInternal(value, { references, referenceSpans, inLink });
    for (const span of referenceSpans.sort((a, b) => b.start - a.start)) value = value.slice(0, span.start) + (span.image ? span.label : referenceSourceText(span.label, references, true)) + value.slice(span.end);
    return value;
  }

  function plainInline(text, references) {
    let value = String(text);
    if (references && Object.keys(references).length) value = referenceSourceText(value, references, false);
    value = value.replace(/%%[\s\S]*?%%/g, '');
    // a named writer marker is not part of the piece's text either, so it can never
    // be anchored to, diffed, or dragged into a comment. The emphasis it is usually
    // written inside goes with it, or the plain text keeps a stray `**`.
    value = value.replace(/(\*\*|__|\*|_)?\[[A-Z][A-Z0-9 ]+:[^\]]*\]\1?/g, '');
    value = value.replace(/(`+)([\s\S]*?)\1/g, '$2');
    value = value.replace(/!\[\[([^\]]+)\]\]/g, (_, raw) => parseEmbedSpec(raw).target);
    value = value.replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
      const wiki = parseWikiSpec(raw);
      return wiki.shown || wiki.target;
    });
    value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    value = value.replace(/<\/?(?:strong|em|mark|del|span)>/gi, '');
    value = value.replace(/<\/?(?:br|sup|sub)\s*\/?>/gi, ' ');
    value = value.replace(/\[\^([^\]]+)\]/g, '$1');
    value = value.replace(/__([^_]+)__/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/~~([^~]+)~~/g, '$1').replace(/==([^=]+)==/g, '$1');
    value = value.replace(/\*([^*]+)\*/g, (raw, body, at) => emphasisCanOpen(value, at, 1) && emphasisCanClose(value, at + raw.length - 1, 1) ? body : raw).replace(/(^|[^\p{L}\p{N}])_([^\n]+?)_(?=$|[^\p{L}\p{N}])/gu, '$1$2');
    return value.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  }

  function inlineMeta(source) {
    const scrubbed = String(source).replace(/(`+)[\s\S]*?\1/g, '').replace(/%%[\s\S]*?%%/g, '');
    const tags = [];
    const wikilinks = [];
    const tagPattern = /(^|[\s([{'"“‘])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;
    let match;
    while ((match = tagPattern.exec(scrubbed))) if (!tags.includes(match[2])) tags.push(match[2]);
    const wikiPattern = /(?<!!)\[\[([^\]]+)\]\]/g;
    while ((match = wikiPattern.exec(scrubbed))) wikilinks.push(parseWikiSpec(match[1]).target);
    return { tags, wikilinks };
  }

  function renderEmbed(info) {
    const mediaKind = info.mediaKind || (info.isImage ? 'image' : '');
    if (mediaKind === 'image') {
      const imageWidth = info.width || info.imageWidth;
      const imageHeight = info.height || info.imageHeight;
      const width = imageWidth ? ` width="${imageWidth}"` : '';
      const height = imageHeight ? ` height="${imageHeight}"` : '';
      return `<img class="embed-image" src="${escapeHtml(safeUrl(info.target))}" alt="${escapeHtml(info.alt || info.target)}"${width}${height}>`;
    }
    const inlined = /^data:/i.test(String(info.target || ''));
    if (mediaKind && !inlined) {
      return `<span class="embed embed-placeholder" data-target="${escapeHtml(info.target)}" data-kind="${escapeHtml(mediaKind)}">${escapeHtml(info.target)}</span>`;
    }
    if (mediaKind === 'audio') return `<audio class="embed-audio" controls preload="metadata" src="${escapeHtml(safeUrl(info.target))}">Audio: ${escapeHtml(info.target)}</audio>`;
    if (mediaKind === 'video') return `<video class="embed-video" controls preload="metadata" src="${escapeHtml(safeUrl(info.target))}">Video: ${escapeHtml(info.target)}</video>`;
    if (mediaKind === 'pdf') return `<embed class="embed-pdf" src="${escapeHtml(safeUrl(info.target))}" type="application/pdf">`;
    return `<span class="embed embed-placeholder" data-target="${escapeHtml(info.target)}">Embedded piece: ${escapeHtml(info.target)}</span>`;
  }

  function figureHash(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `figure-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function figureSource(figures, path, name) {
    if (!figures) return '';
    if (Array.isArray(figures)) return figures.includes(path) ? path : '';
    const value = figures instanceof Map ? (figures.get(path) || figures.get(name)) : (figures[path] || figures[name]);
    if (value === true) return path;
    if (typeof value === 'string') return value;
    return value && typeof value.src === 'string' ? value.src : '';
  }

  function renderFigureRail(block, attrs, context) {
    const kind = block.meta.lang.toLowerCase();
    const named = /(?:^|\s)figure=([^\s]+)/.exec(block.meta.info || '');
    const name = named ? slug(named[1]) : figureHash(block.text);
    const path = `figures/${name}.svg`;
    const labels = { mermaid: 'Mermaid diagram', chart: 'Chart', math: 'Display math' };
    const source = figureSource(context.figures, path, name);
    if (source) {
      return `<figure${attrs} class="figure-block" data-figure="${escapeHtml(path)}" data-figure-kind="${kind}">${renderEmbed({ target: source, alt: path, mediaKind: 'image' })}</figure>`;
    }
    return `<figure${attrs} class="figure-block figure-placeholder" data-figure="${escapeHtml(path)}" data-figure-kind="${kind}"><div class="figure-label">${labels[kind]}</div><p>The agent will draw it at <code>${escapeHtml(path)}</code>.</p></figure>`;
  }

  function calloutIcon(kind) {
    const paths = {
      note: 'M5 3h10v14H5z M8 7h4 M8 11h4',
      tip: 'M10 2a6 6 0 0 0-3 11v3h6v-3a6 6 0 0 0-3-11z M7 13h6',
      warning: 'M10 2 2 17h16z M10 7v4 M10 14h.01',
      info: 'M10 9v6 M10 5h.01 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
      quote: 'M4 5h5v6H6l-2 4 M11 5h5v6h-3l-2 4',
      abstract: 'M4 4h12v12H4z M7 8h6 M7 12h4',
      question: 'M7 7a3 3 0 1 1 4 2.8c-1 .5-1 1.2-1 2.2 M10 15h.01 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
      example: 'M4 4h12v12H4z M7 7h6 M7 10h6 M7 13h4'
    };
    return `<svg class="callout-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="${paths[kind]}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function splitTableRow(line) {
    let value = String(line).trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !escapedAt(value, value.length - 1)) value = value.slice(0, -1);
    if (!value && String(line).trim() === '|') return [];
    const cells = [];
    let cell = '';
    let escaped = false;
    for (const character of value) {
      if (character === '\\' && !escaped) {
        escaped = true;
        cell += character;
        continue;
      }
      if (character === '|' && !escaped) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += character;
      }
      escaped = false;
    }
    cells.push(cell.trim());
    return cells;
  }

  function renderTable(source, context) {
    context = { ...context, tableCell: true };
    const rows = source.split('\n');
    const header = splitTableRow(rows[0]);
    const align = splitTableRow(rows[1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
    const head = header.map((cell, index) => `<th${align[index] ? ` style="text-align:${align[index]}"` : ''}>${renderInlineInternal(cell, context)}</th>`).join('');
    const body = rows.slice(2).map(row => {
      const cells = splitTableRow(row);
      return `<tr>${header.map((_, index) => `<td${align[index] ? ` style="text-align:${align[index]}"` : ''}>${renderInlineInternal(cells[index] || '', context)}</td>`).join('')}</tr>`;
    }).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function editableTable(source, context) {
    context = { ...context, tableCell: true };
    const rows = source.split('\n'), header = splitTableRow(rows[0]), align = splitTableRow(rows[1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
    function cells(line, tag, prefix) {
      const values = splitTableRow(line).slice(0, header.length);
      const authored = Math.max(1, values.length);
      while (values.length < header.length) values.push('');
      let at = 0;
      return values.map((value, i) => {
        if (i >= authored) return `<${tag} data-cw-table-pad="${i - authored + (!splitTableRow(line).length || !(line.trim().endsWith('|') && !escapedAt(line.trim(), line.trim().length - 1)) ? 1 : 0)}"${align[i] ? ` style="text-align:${align[i]}"` : ''}></${tag}>`;
        const start = line.indexOf(value, at), end = start + value.length;
        const marks = sourceMark((i ? '' : prefix) + line.slice(at, start), context);
        at = end;
        const tail = i === Math.min(authored, values.length) - 1 ? sourceMark(line.slice(end), context) : '';
        return `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ''}>${marks}${renderInlineInternal(value, context)}${tail}</${tag}>`;
      }).join('');
    }
    let head = cells(rows[0], 'th', '');
    if (rows.length < 3) head = head.replace(/<\/th>$/, sourceMark('\n' + rows[1], context) + '</th>');
    const body = rows.slice(2).map((line, i) => `<tr>${cells(line, 'td', i ? '\n' : '\n' + rows[1] + '\n')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function listRows(source) {
    const rows = [];
    let cursor = 0, previousEnd = 0;
    for (const line of source.split('\n')) {
      const match = listMatch(line);
      if (match) {
        const at = cursor + line.length - match.content.length;
        match.sourcePrefix = source.slice(previousEnd, at);
        match.firstContent = match.content;
        match.continuations = [];
        rows.push(match);
        previousEnd = cursor + line.length;
      } else if (rows.length && line.trim()) {
        rows.at(-1).content += source.slice(previousEnd, cursor).replace(/[ \t]+(?=\n)/g, '') + line.trimStart();
        rows.at(-1).continuations.push({ prefix: source.slice(previousEnd, cursor + line.indexOf(line.trim())), content: line.trimStart() });
        previousEnd = cursor + line.length;
      }
      cursor += line.length + 1;
    }
    return rows;
  }

  function renderList(source, context) {
    const rows = listRows(source);
    if (!rows.length) return '';

    function group(start, indent) {
      let index = start;
      let html = '';
      while (index < rows.length && rows[index].indent === indent) {
        const ordered = rows[index].ordered;
        const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}>`;
        while (index < rows.length && rows[index].indent === indent && rows[index].ordered === ordered) {
          const row = rows[index];
          let content = context.editSource ? row.firstContent : row.content;
          const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(content);
          const checked = task && task[1].toLowerCase() === 'x';
          if (task) content = task[2];
          html += `<li${task ? ` class="task-item${checked ? ' is-checked' : ''}"` : ''}>`;
          if (task) html += `<input type="checkbox" disabled${checked ? ' checked' : ''}>`;
          const loose = row.continuations.some(part => /\n[ \t]*\n/.test(part.prefix));
          const body = row.firstContent + row.continuations.map(part => part.prefix + part.content).join('');
          const lines = body.split('\n'), prefixes = lines.map((line, i) => i ? (/^[ \t]*/.exec(line) || [''])[0] : '');
          html += sourceMark(row.sourcePrefix + (task ? row.firstContent.slice(0, row.firstContent.length - content.length) : ''), context) + (loose ? prefixedNested(lines, prefixes, context) : /^ {0,3}>/.test(content) ? renderNested(context.editSource ? body : row.content, context) : renderInlineInternal(content, context));
          if (context.editSource && !loose && !/^ {0,3}>/.test(content)) row.continuations.forEach(part => { const hard = /  $/.test(html); if (hard) html = html.slice(0, -2) + sourceMark('  ', context); html += (hard ? sourceMark(part.prefix, context) + '<br>' : '\n' + sourceMark(part.prefix.slice(1), context)) + renderInlineInternal(part.content, context); });
          index += 1;
          while (index < rows.length && rows[index].indent > indent) {
            const nested = group(index, rows[index].indent);
            html += nested.html;
            index = nested.index;
          }
          html += '</li>';
        }
        html += `</${tag}>`;
      }
      return { html, index };
    }

    return group(0, rows[0].indent).html;
  }

  function prefixedNested(lines, prefixes, context) {
    const body = lines.map((line, i) => line.slice(prefixes[i].length)).join('\n');
    const html = renderNested(body, context);
    if (!context.editSource) return html;
    let line = 0;
    return sourceMark(prefixes[0], context) + html.replace(/<[^>]*>|[^<]+/g, token =>
      token[0] === '<' ? token : token.replace(/\n/g, () => '\n' + sourceMark(prefixes[++line] || '', context)));
  }

  function quoteSource(source, context) {
    const lines = source.split('\n'), prefixes = [], bodies = [];
    lines.forEach(line => { const m = /^ {0,3}>[ \t]?/.exec(line); prefixes.push(m ? m[0] : ''); bodies.push(m ? line.slice(m[0].length) : line); });
    let line = 0;
    const html = renderNested(bodies.join('\n'), context);
    // Nested rendering retains source gaps. Weave each stripped quote prefix
    // back at its exact line start, including blank and nested quote lines.
    return sourceMark(prefixes[0], context) + html.replace(/<[^>]*>|[^<]+/g, token =>
      token[0] === '<' ? token : token.replace(/\n/g, () => '\n' + sourceMark(prefixes[++line] || '', context)));
  }

  function renderNested(source, context) {
    if (!source.trim()) return sourceMark(source, context);
    const nested = scan(source, false).blocks;
    if (!context.editSource) return nested.map((block) => renderBlock(block, context)).join('');
    let cursor = 0, html = '';
    nested.forEach(block => {
      const at = source.indexOf(block.source, cursor);
      html += sourceMark(source.slice(cursor, at), context) + renderBlock(block, context);
      cursor = at + block.source.length;
    });
    return html + sourceMark(source.slice(cursor), context);
  }

  function renderBlock(block, context) {
    const ctx = context || {};
    const attrs = block.id ? ` data-block-id="${escapeHtml(block.id)}"` : '';
    if (/^h[1-6]$/.test(block.type)) {
      const level = block.meta.level || Number(block.type.slice(1));
      const id = block.meta.headingId || slug(block.text);
      const label = block.meta.rawText || block.text;
      const at = label ? block.source.indexOf(label) : block.source.length;
      return `<h${level}${attrs} id="${escapeHtml(id)}">${sourceMark(block.source.slice(0, at), ctx)}${renderInlineInternal(label, ctx)}${/^[ \t]*$/.test(block.source.slice(at + label.length)) ? block.source.slice(at + label.length) : sourceMark(block.source.slice(at + label.length), ctx)}</h${level}>`;
    }
    switch (block.type) {
      case 'frontmatter':
      case 'reference-def': return sourceMark(block.source, ctx);
      case 'p': {
        const inline = renderInlineInternal(block.source, ctx);
        return inline ? `<p${attrs}>${inline}</p>` : '';
      }
      case 'quote': return `<blockquote${attrs}>${ctx.editSource ? quoteSource(block.source, ctx) : renderNested(block.meta.bodySource, ctx)}</blockquote>`;
      case 'callout': {
        const first = block.source.split('\n')[0], titleAt = first.indexOf(block.meta.title);
        const title = `${calloutIcon(block.meta.calloutKind)}${ctx.editSource ? sourceMark(titleAt >= 0 ? first.slice(0, titleAt) : first, ctx) : ''}${ctx.editSource && titleAt < 0 ? `<span class="cw-atom" data-label="${escapeHtml(block.meta.title)}"></span>` : renderInlineInternal(block.meta.title, ctx)}`;
        const rest = block.source.slice(first.length);
        const content = ctx.editSource ? sourceMark(rest ? '\n' : '', ctx) + quoteSource(rest.slice(1), ctx) : renderNested(block.meta.bodySource, ctx);
        const body = block.meta.bodySource.trim() ? `<div class="callout-body">${content}</div>` : (ctx.editSource ? sourceMark(rest, ctx) : '');
        if (block.meta.fold) return `<details${attrs} class="callout callout-${block.meta.calloutKind}" data-callout="${block.meta.calloutKind}"${block.meta.fold === '+' ? ' open' : ''}><summary class="callout-title">${title}</summary>${body}</details>`;
        return `<aside${attrs} class="callout callout-${block.meta.calloutKind}" data-callout="${block.meta.calloutKind}"><div class="callout-title">${title}</div>${body}</aside>`;
      }
      case 'list': return `<div${attrs} class="list-block">${renderList(block.source, ctx)}</div>`;
      case 'code': {
        const language = block.meta.lang ? ` class="language-${escapeHtml(block.meta.lang)}"` : '';
        if (FIGURE_LANGUAGES.has(block.meta.lang.toLowerCase())) return renderFigureRail(block, attrs, ctx);
        const body = Castor.hl && typeof Castor.hl.highlight === 'function' ? Castor.hl.highlight(block.text, block.meta.lang) : escapeHtml(block.text);
        if (ctx.editSource) {
          if (block.meta.indented) return `<pre${attrs}><code${language}>${block.source.split('\n').map(line => { const prefix = /^(?: {4}| {0,3}\t)/.exec(line)[0]; return sourceMark(prefix, ctx) + escapeHtml(line.slice(prefix.length)); }).join('\n')}</code></pre>`;
          const first = block.source.indexOf('\n'), last = block.source.lastIndexOf('\n');
          const closed = block.meta.closed && last > first;
          if (first < 0) return `<pre${attrs}><code${language}>${sourceMark(block.source, ctx)}</code></pre>`;
          return `<pre${attrs}><code${language}>${sourceMark(block.source.slice(0, first + 1), ctx)}${body}${sourceMark(closed ? block.source.slice(last) : '', ctx)}</code></pre>`;
        }
        return `<pre${attrs}><code${language}>${body}</code></pre>`;
      }
      case 'table': return `<div${attrs} class="table-block">${ctx.editSource ? editableTable(block.source, ctx) : renderTable(block.source, ctx)}</div>`;
      case 'hr': return sourceMark(block.source, ctx) + `<hr${attrs}>`;
      case 'embed': return `<figure${attrs} class="embed-block">${renderEmbed(block.meta)}${block.meta.caption ? `<figcaption>${renderInlineInternal(block.meta.caption, ctx)}</figcaption>` : ''}</figure>`;
      case 'footnote-def': {
        const label = footnoteNumber(ctx, block.meta.footnoteKey);
        if (!ctx.editSource) return `<aside${attrs} class="footnote-definition" id="fn-${escapeHtml(block.meta.footnoteKey)}" data-key="${escapeHtml(block.meta.footnoteKey)}"><sup>${label}</sup> ${/\n[ \t]*\n/.test(block.meta.body) ? renderNested(block.meta.body, ctx) : renderInlineInternal(block.meta.body, ctx)}</aside>`;
        const lines = block.source.split('\n');
        const body = /\n[ \t]*\n/.test(block.meta.body) ? prefixedNested(lines, lines.map((line, i) => ((i ? /^(?: {2,}|\t)/.exec(line) : /^\[\^[^\]]+\]:[ \t]*/.exec(line)) || [''])[0]), ctx) : lines.map((line, i) => {
          const m = i ? /^(?: {2,}|\t)/.exec(line) : /^\[\^[^\]]+\]:[ \t]*/.exec(line);
          const prefix = m ? m[0] : '';
          return (i ? '\n' : '') + sourceMark(prefix, ctx) + renderInlineInternal(line.slice(prefix.length), ctx);
        }).join('');
        return `<aside${attrs} class="footnote-definition" id="fn-${escapeHtml(block.meta.footnoteKey)}" data-key="${escapeHtml(block.meta.footnoteKey)}"><sup class="cw-atom" data-label="${label}"></sup><span class="cw-definition-gap"></span>${body}</aside>`;
      }
      default: return '';
    }
  }

  function blockToHtml(block) {
    const options = arguments[1];
    if (!options && typeof block.html === 'string') return block.html;
    return renderBlock(block, options || {});
  }

  function parse(source) {
    const options = arguments[1];
    const opts = options || {};
    let scanned = scan(String(source), true);
    const references = Object.assign(Object.create(null), opts.references || {});
    function collectReferences(blocks) {
      for (const block of blocks) {
        if (block.type === 'reference-def' && !Object.hasOwn(references, block.meta.referenceKey)) references[block.meta.referenceKey] = { destination: block.meta.destination, ...(block.meta.title === undefined ? {} : { title: block.meta.title }) };
        if (block.type === 'quote' || block.type === 'callout') collectReferences(scan(block.meta.bodySource, false).blocks);
      }
    }
    collectReferences(scanned.blocks);
    if (Object.keys(references).length) scanned = scan(String(source), true, references);
    const footnoteBodies = { ...(opts.footnotes || {}) };
    for (const block of scanned.blocks) {
      if (block.type === 'footnote-def') footnoteBodies[block.meta.footnoteKey] = block.meta.body;
    }
    // usedReferences: the definitions some link or image of the page resolves to.
    const context = { editSource: Boolean(opts.editSource), showMarks: Boolean(opts.showMarks), references, footnotes: footnoteBodies, showWriterNotes: Boolean(opts.showWriterNotes), figures: opts.figures || null, usedReferences: new Set() };
    /* A caller re-parsing ONE block of a page it already parsed passes the page's
       numbers back in, so a block that loses focus keeps the number it had. */
    if (opts.footnoteNumbers) {
      context.footnoteNumbers = new Map(Object.entries(opts.footnoteNumbers).map(([k, n]) => [k, Number(n)]));
    }

    const headings = [];
    const slugCounts = new Map();
    const blocks = scanned.blocks.map((raw, index) => {
      const block = { id: `b${index + 1}`, type: raw.type, source: raw.source, text: raw.text, html: '', meta: { ...raw.meta, ...inlineMeta(raw.source) } };
      if (/^h[1-6]$/.test(block.type)) {
        const base = slug(block.text);
        const count = (slugCounts.get(base) || 0) + 1;
        slugCounts.set(base, count);
        block.meta.headingId = count === 1 ? base : `${base}-${count}`;
        headings.push({ level: block.meta.level, text: block.text, id: block.meta.headingId, blockId: block.id });
      }
      block.html = renderBlock(block, context);
      return block;
    });

    /* AFTER the blocks: a footnote's number is its first appearance in the PAGE,
       so the page has to be rendered before the notes are, or a ref inside a note
       body would claim number 1. */
    const footnotes = {};
    for (const [key, body] of Object.entries(footnoteBodies)) footnotes[key] = renderInlineInternal(body, context);
    const footnoteNumbers = {};
    (context.footnoteNumbers || new Map()).forEach((n, key) => { footnoteNumbers[key] = n; });
    const footnoteOrder = Array.from((context.footnoteNumbers || new Map()).keys());
    const text = String(source);
    let cursor = 0;
    for (const block of blocks) {
      const at = typeof block.source === 'string' ? text.indexOf(block.source, cursor) : -1;
      if (at < 0 || /\S/.test(text.slice(cursor, at))) continue;
      block.sep = text.slice(cursor, at);
      cursor = at + block.source.length;
    }
    const trailing = /\S/.test(text.slice(cursor)) ? '' : text.slice(cursor);
    return { blocks, references, footnotes, footnoteNumbers, footnoteOrder, frontmatter: scanned.frontmatter, headings, trailing, usedReferences: context.usedReferences };
  }

  function makeAnchor(doc, blockId, start, end) {
    const version = arguments[4];
    const block = doc && doc.blocks && doc.blocks.find((candidate) => candidate.id === blockId);
    if (!block) return null;
    const from = Math.max(0, Math.min(block.text.length, Number(start) || 0));
    const to = Math.max(from, Math.min(block.text.length, Number(end) || 0));
    return {
      quote: block.text.slice(from, to),
      prefix: block.text.slice(Math.max(0, from - 32), from),
      suffix: block.text.slice(to, to + 32),
      blockText: block.text,
      version: version == null ? (doc.version || '') : String(version)
    };
  }

  function contextScore(blockText, index, quoteLength, anchor) {
    let score = 0;
    if (anchor.prefix) {
      const before = blockText.slice(Math.max(0, index - anchor.prefix.length), index);
      if (before === anchor.prefix) score += 2;
      else if (before.toLowerCase().endsWith(anchor.prefix.toLowerCase().slice(-16))) score += 1;
    }
    if (anchor.suffix) {
      const after = blockText.slice(index + quoteLength, index + quoteLength + anchor.suffix.length);
      if (after === anchor.suffix) score += 2;
      else if (after.toLowerCase().startsWith(anchor.suffix.toLowerCase().slice(0, 16))) score += 1;
    }
    if (anchor.blockText === blockText) score += 3;
    return score;
  }

  function normaliseWithMap(value) {
    const text = String(value);
    let normal = '';
    const map = [];
    let inSpace = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (/\s/.test(character)) {
        if (!inSpace && normal.length) {
          normal += ' ';
          map.push(index);
        }
        inSpace = true;
      } else {
        normal += character.toLowerCase();
        map.push(index);
        inSpace = false;
      }
    }
    if (normal.endsWith(' ')) {
      normal = normal.slice(0, -1);
      map.pop();
    }
    return { normal, map };
  }

  const mappedBlocks = new WeakMap();

  function mappedBlock(block) {
    const cached = mappedBlocks.get(block);
    if (cached && cached.text === block.text) return cached.mapped;
    const mapped = normaliseWithMap(block.text);
    mappedBlocks.set(block, { text: block.text, mapped });
    return mapped;
  }

  // A free start in row zero finds the closest nonempty substring in one pass.
  // Equal costs retain the earliest start; scanning ends left to right retains
  // the shortest match when both cost and start are equal.
  function approximateSubstring(needle, haystack, limit) {
    const width = haystack.length;
    if (!width) return null;
    // Each needle character absent from the whole block requires an edit.
    // Refuse an impossible match before allocating the distance matrix rows.
    let missing = 0;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack.indexOf(needle[i]) < 0 && ++missing > limit) return null;
    }
    let previous = new Int32Array(width + 1);
    let current = new Int32Array(width + 1);
    let previousStart = new Int32Array(width + 1);
    let currentStart = new Int32Array(width + 1);
    for (let column = 0; column <= width; column += 1) previousStart[column] = column;
    for (let row = 1; row <= needle.length; row += 1) {
      current[0] = row;
      currentStart[0] = 0;
      const character = needle[row - 1];
      for (let column = 1; column <= width; column += 1) {
        let cost = previous[column] + 1;
        let start = previousStart[column];
        const inserted = current[column - 1] + 1;
        if (inserted < cost || (inserted === cost && currentStart[column - 1] < start)) {
          cost = inserted;
          start = currentStart[column - 1];
        }
        const changed = previous[column - 1] + (character === haystack[column - 1] ? 0 : 1);
        if (changed < cost || (changed === cost && previousStart[column - 1] < start)) {
          cost = changed;
          start = previousStart[column - 1];
        }
        current[column] = cost;
        currentStart[column] = start;
      }
      [previous, current] = [current, previous];
      [previousStart, currentStart] = [currentStart, previousStart];
    }
    let distance = limit + 1, matches = [];
    for (let end = 1; end <= width; end += 1) {
      const start = previousStart[end], cost = previous[end];
      if (start === end || cost > limit || cost > distance) continue;
      if (cost < distance) { distance = cost; matches = []; }
      matches.push({ start, end, distance: cost });
    }
    // Overlapping fuzzy spans name one place; disjoint equal matches name distinct places.
    matches.sort((a, b) => a.start - b.start || a.end - b.end);
    const separate = [];
    for (const match of matches) {
      if (!separate.length || match.start >= separate[separate.length - 1].end) separate.push(match);
    }
    const best = separate.length ? Object.assign({}, separate[0], { matches: separate }) : null;
    return best;
  }

  // Equally good places remain detached until a person chooses one.
  function anchorChoice(candidates) {
    if (!candidates.length) return null;
    return candidates.length === 1 ? candidates[0] : { ambiguous: true, candidates };
  }

  // Resolution checks a literal quote, its context, normalised text, then edit distance.
  function resolveAnchor(doc, anchor) {
    if (!doc || !Array.isArray(doc.blocks) || !anchor || !anchor.quote) return null;
    const exact = [];
    for (const block of doc.blocks) {
      let from = 0;
      while (from <= block.text.length) {
        const index = block.text.indexOf(anchor.quote, from);
        if (index < 0) break;
        exact.push({ block, index, score: contextScore(block.text, index, anchor.quote.length, anchor) });
        from = index + Math.max(1, anchor.quote.length);
      }
    }
    if (exact.length) {
      exact.sort((a, b) => b.score - a.score);
      const best = exact[0];
      return anchorChoice(exact.filter((hit) => hit.score === best.score).map((hit) => ({
        blockId: hit.block.id, start: hit.index, end: hit.index + anchor.quote.length,
        confidence: hit.score >= 3 ? 1 : 0.95
      })));
    }

    let contextual = [];
    function contextCandidate(block, start, end, confidence) {
      if (!contextual.length || confidence > contextual[0].confidence) contextual = [];
      if (!contextual.length || confidence === contextual[0].confidence) contextual.push({ blockId: block.id, start, end, confidence });
    }
    for (const block of doc.blocks) {
      let from = 0, prefixIndex;
      const prefixes = [];
      if (anchor.prefix) while ((prefixIndex = block.text.indexOf(anchor.prefix, from)) >= 0) {
        prefixes.push(prefixIndex); from = prefixIndex + Math.max(1, anchor.prefix.length);
      }
      if (prefixes.length) {
        prefixes.forEach((index) => {
          const start = index + anchor.prefix.length;
          const suffix = anchor.suffix ? block.text.indexOf(anchor.suffix, start) : -1;
          contextCandidate(block, start, suffix >= start ? suffix : Math.min(block.text.length, start + anchor.quote.length), suffix >= start ? 0.84 : 0.68);
        });
      } else if (anchor.suffix) {
        let index; from = 0;
        while ((index = block.text.indexOf(anchor.suffix, from)) >= 0) {
          contextCandidate(block, Math.max(0, index - anchor.quote.length), index, 0.68);
          from = index + Math.max(1, anchor.suffix.length);
        }
      }
    }
    if (contextual.length) return anchorChoice(contextual);

    const needle = normaliseWithMap(anchor.quote).normal;
    if (!needle) return null;
    const normal = [];
    for (const block of doc.blocks) {
      const mapped = mappedBlock(block);
      let from = 0, index;
      while ((index = mapped.normal.indexOf(needle, from)) >= 0) {
        normal.push({ blockId: block.id, start: mapped.map[index], end: mapped.map[index + needle.length - 1] + 1, confidence: 0.78 });
        from = index + Math.max(1, needle.length);
      }
    }
    if (normal.length) return anchorChoice(normal);

    const limit = Math.min(4, Math.max(1, Math.floor(needle.length * 0.12)));
    let best = [];
    for (const block of doc.blocks) {
      const mapped = mappedBlock(block);
      const found = approximateSubstring(needle, mapped.normal, limit);
      if (!found) continue;
      if (!best.length || found.distance < best[0].distance) best = [];
      if (!best.length || found.distance === best[0].distance) {
        found.matches.forEach((hit) => best.push({ blockId: block.id, start: mapped.map[hit.start],
          end: mapped.map[hit.end - 1] + 1, distance: hit.distance }));
      }
    }
    return anchorChoice(best.map((hit) => ({ blockId: hit.blockId, start: hit.start, end: hit.end,
      confidence: Math.max(0.5, 0.74 - hit.distance / Math.max(needle.length, 1)) })));
  }

  const api = { parse, renderInline, blockToHtml, resolveAnchor, makeAnchor, slug };
  Castor.md = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
