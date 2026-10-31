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
    const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (!match) return null;
    return { level: match[1].length, text: match[2].replace(/[ \t]+#+[ \t]*$/, '') };
  }

  function fenceMatch(line) {
    const match = /^\s{0,3}(`{3,}|~{3,})(?:[ \t]*([^\s`]+))?(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    return match ? { marker: match[1], lang: match[2] || '', info: match[3] || '' } : null;
  }

  function listMatch(line) {
    const match = /^(\s*)([-+*]|\d+[.)])[ \t]+(.*)$/.exec(line);
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
    if (index + 1 >= lines.length || !lines[index].includes('|')) return false;
    const alignment = lines[index + 1].trim().replace(/^\||\|$/g, '');
    if (!alignment.includes('-')) return false;
    const cells = splitTableRow(alignment);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function referenceText(value) {
    return String(value).replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  }

  function referenceLabel(value) {
    return referenceText(value).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function referenceMatch(line) {
    const match = /^ {0,3}\[((?:\\.|[^\]\\\r\n])+)\]:[ \t]*(?:<([^<>\r\n]*)>|(\S+?))(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^()\\])*)\)))?[ \t\r]*$/.exec(line);
    if (!match || match[1][0] === '^' || !referenceLabel(match[1])) return null;
    if (match[3] && (/[<>]/.test(match[3]) || findParenClose('(' + match[3] + ')', 1) !== match[3].length + 1)) return null;
    const title = match[4] ?? match[5] ?? match[6];
    return { referenceKey: referenceLabel(match[1]), destination: referenceText(match[2] ?? match[3]), ...(title === undefined ? {} : { title: referenceText(title) }) };
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
      headingMatch(line) || fenceMatch(line) || listMatch(line) || isHr(line) ||
      /^\s{0,3}>/.test(line) || /^\[\^[^\]]+\]:/.test(line) || (referenceMatch(line) && !referenceInsideCode(lines, paragraphStart, index)) ||
      isTableStart(lines, index) || /^\s*!\[\[[\s\S]+\]\]\s*$/.test(line)
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

      const reference = referenceMatch(lines[index]);
      if (reference) {
        index += 1;
        blocks.push({ type: 'reference-def', source: lines[start], text: '', meta: reference });
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
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
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
        index += 1;
        while (index < lines.length) {
          if (listMatch(lines[index])) {
            index += 1;
            continue;
          }
          if (lines[index].trim() === '') {
            if (index + 1 < lines.length && (listMatch(lines[index + 1]) || /^\s+\S/.test(lines[index + 1]))) {
              index += 1;
              continue;
            }
            break;
          }
          if (/^\s+\S/.test(lines[index])) {
            index += 1;
            continue;
          }
          break;
        }
        const listSource = lines.slice(start, index).join('\n');
        const listRows = listSource.split('\n').filter((line) => listMatch(line));
        const hasTasks = listRows.some((line) => /^\s*[-+*]\s+\[[ xX]\]/.test(line));
        blocks.push({
          type: 'list',
          source: listSource,
          text: listRows.map((line) => plainInline(listMatch(line).content.replace(/^\[[ xX]\]\s*/, ''), references)).join('\n'),
          meta: { ordered: Boolean(listMatch(listRows[0])?.ordered), hasTasks }
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
      while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines, index, start)) index += 1;
      const paragraphSource = lines.slice(start, index).join('\n');
      blocks.push({ type: 'p', source: paragraphSource, text: plainInline(paragraphSource, references), meta: {} });
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
      if (text[index - 1] !== '\\') return index;
      index += delimiter.length;
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

  function emphasisCanOpen(text, index, size) {
    const previous = text[index - 1] || '';
    const next = text[index + size] || '';
    return Boolean(next && !/\s/.test(next) && !(size === 1 && /[\p{L}\p{N}]/u.test(previous)));
  }

  function emphasisCanClose(text, index, size) {
    const previous = text[index - 1] || '';
    const next = text[index + size] || '';
    return Boolean(previous && !/\s/.test(previous) && !(size === 1 && /[\p{L}\p{N}]/u.test(next)));
  }

  function findEmphasisClose(text, delimiter, start) {
    let index = start;
    while ((index = text.indexOf(delimiter, index)) >= 0) {
      if (emphasisCanClose(text, index, delimiter.length)) return index;
      index += delimiter.length;
    }
    return -1;
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

  function renderInlineInternal(text, options) {
    const opts = options || {};
    const footnotes = opts.footnotes || null;
    let html = '';
    let index = 0;

    while (index < text.length) {
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
              html += `<span class="writer-note" data-owner="${escapeHtml(marker[1].trim())}">` +
                `<span class="wn-who">${escapeHtml(whole.slice(0, cut + 1))}</span>` +
                `<span class="wn-brief">${escapeHtml(whole.slice(cut + 1))}</span></span>`;
            }
            index = close + 1;
            continue;
          }
        }
      }
      if (text.startsWith('%%', index)) {
        const end = findClosing(text, '%%', index + 2);
        if (end >= 0) {
          if (opts.showWriterNotes) html += `<span class="writer-note">${escapeHtml(text.slice(index + 2, end))}</span>`;
          index = end + 2;
          continue;
        }
      }

      if (text[index] === '`') {
        let ticks = 1;
        while (text[index + ticks] === '`') ticks += 1;
        const delimiter = '`'.repeat(ticks);
        const end = findClosing(text, delimiter, index + ticks);
        if (end >= 0) {
          let code = text.slice(index + ticks, end);
          if (/^\s[\s\S]*\s$/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
          html += `<code>${escapeHtml(code)}</code>`;
          index = end + ticks;
          continue;
        }
      }

      if (text.startsWith('![[', index)) {
        const end = text.indexOf(']]', index + 3);
        if (end >= 0) {
          html += renderEmbed(parseEmbedSpec(text.slice(index + 3, end)));
          index = end + 2;
          continue;
        }
      }

      if (text.startsWith('[[', index)) {
        const end = text.indexOf(']]', index + 2);
        if (end >= 0) {
          const wiki = parseWikiSpec(text.slice(index + 2, end));
          const label = wiki.shown || wiki.target;
          html += `<a class="wikilink" data-target="${escapeHtml(wiki.target)}">${escapeHtml(label)}</a>`;
          index = end + 2;
          continue;
        }
      }

      const imageStart = text.startsWith('![', index);
      const linkStart = !opts.inLink && text[index] === '[' && !text.startsWith('[[', index);
      if (imageStart || linkStart) {
        const labelStart = index + (imageStart ? 2 : 1);
        let labelEnd = -1, labelDepth = 0;
        for (let at = labelStart; at < text.length; at += 1) {
          if (text[at] === '\\') { at += 1; continue; }
          if (text[at] === '`') {
            let ticks = 1;
            while (text[at + ticks] === '`') ticks += 1;
            const close = findClosing(text, '`'.repeat(ticks), at + ticks);
            if (close >= 0) { at = close + ticks - 1; continue; }
          }
          if (text[at] === '[') labelDepth += 1;
          if (text[at] === ']') {
            if (!labelDepth) { labelEnd = at; break; }
            labelDepth -= 1;
          }
        }
        if (labelEnd >= 0 && text[labelEnd + 1] === '(') {
          const urlEnd = findParenClose(text, labelEnd + 2);
          if (urlEnd >= 0) {
            const label = text.slice(labelStart, labelEnd);
            const url = safeUrl(text.slice(labelEnd + 2, urlEnd));
            html += imageStart
              ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}">`
              : `<a href="${escapeHtml(url)}">${renderInlineInternal(label, { ...opts, inLink: true, referenceOffset: (opts.referenceOffset || 0) + labelStart })}</a>`;
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
          if (reference) {
            const label = text.slice(labelStart, labelEnd), url = safeUrl(reference.destination);
            if (opts.referenceSpans) opts.referenceSpans.push({ start: (opts.referenceOffset || 0) + index, end: (opts.referenceOffset || 0) + end + 1, label, image: imageStart });
            const title = reference.title === undefined ? '' : ` title="${escapeHtml(reference.title)}"`;
            html += imageStart ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}"${title}>`
              : `<a href="${escapeHtml(url)}"${title}>${renderInlineInternal(label, { ...opts, inLink: true, referenceSpans: null })}</a>`;
            index = end + 1;
            continue;
          }
          if (explicit && end >= 0) {
            html += (imageStart ? '!' : '') + '[' + renderInlineInternal(text.slice(labelStart, labelEnd), { ...opts, inLink: true, referenceOffset: (opts.referenceOffset || 0) + labelStart }) + ']' + escapeHtml(text.slice(labelEnd + 1, end + 1));
            index = end + 1;
            continue;
          }
        }
      }

      const allowedHtml = /^(?:<br\s*\/?\s*>|<\/?(?:sup|sub)>)/i.exec(text.slice(index));
      if (allowedHtml) {
        html += allowedHtml[0].toLowerCase().replace(/\s+/g, '');
        index += allowedHtml[0].length;
        continue;
      }

      if (text.startsWith('[^', index)) {
        const end = text.indexOf(']', index + 2);
        if (end >= 0) {
          const key = text.slice(index + 2, end);
          const exists = footnotes && Object.prototype.hasOwnProperty.call(footnotes, key);
          const missing = exists ? '' : ' missing-note';
          const title = exists ? '' : ' title="Missing note"';
          // The KEY is the author's (`[^tao]`); the READER sees a number, assigned by
          // first appearance in the page. A named key printed as a superscript is as
          // wide as a word and overprints the note beside it at the foot.
          const label = footnoteNumber(opts, key);
          html += `<sup class="footnote-ref${missing}"${title} data-key="${escapeHtml(key)}"><a href="#fn-${escapeHtml(key)}" data-footnote="${escapeHtml(key)}">${label}</a></sup>`;
          index = end + 1;
          continue;
        }
      }

      const emphasis = [
        { delimiter: '**', open: '<strong>', close: '</strong>' },
        { delimiter: '~~', open: '<del>', close: '</del>' },
        { delimiter: '==', open: '<mark>', close: '</mark>' },
        { delimiter: '*', open: '<em>', close: '</em>' },
        { delimiter: '_', open: '<em>', close: '</em>' }
      ].find((entry) => text.startsWith(entry.delimiter, index) && emphasisCanOpen(text, index, entry.delimiter.length));
      if (emphasis) {
        const end = findEmphasisClose(text, emphasis.delimiter, index + emphasis.delimiter.length);
        if (end >= 0) {
          const inside = text.slice(index + emphasis.delimiter.length, end);
          html += emphasis.open + renderInlineInternal(inside, { ...opts, referenceOffset: (opts.referenceOffset || 0) + index + emphasis.delimiter.length }) + emphasis.close;
          index = end + emphasis.delimiter.length;
          continue;
        }
      }

      if (text[index] === '#') {
        const previous = text[index - 1] || '';
        const tag = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(text.slice(index));
        if (tag && (!previous || /[\s([{'"“‘]/.test(previous))) {
          html += `<a class="tag" data-tag="${escapeHtml(tag[1])}">#${escapeHtml(tag[1])}</a>`;
          index += tag[0].length;
          continue;
        }
      }

      if (text.startsWith('  \n', index)) {
        html += '<br>';
        index += 3;
        continue;
      }
      if (text[index] === '\n') {
        html += '\n';
        index += 1;
        continue;
      }
      if (text[index] === '\\' && index + 1 < text.length && /[\\`*_[\]{}()#+.!~-]/.test(text[index + 1])) {
        html += escapeHtml(text[index + 1]);
        index += 2;
        continue;
      }

      html += escapeHtml(text[index]);
      index += 1;
    }
    return html;
  }

  function renderInline(text) {
    const options = arguments[1];
    return renderInlineInternal(String(text), options || {});
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
    value = value.replace(/<\/?(?:br|sup|sub)\s*\/?>/gi, ' ');
    value = value.replace(/\[\^([^\]]+)\]/g, '$1');
    value = value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/~~([^~]+)~~/g, '$1').replace(/==([^=]+)==/g, '$1');
    value = value.replace(/(^|[^\p{L}\p{N}])([*_])([^\n]+?)\2(?=$|[^\p{L}\p{N}])/gu, '$1$3');
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
    const value = String(line).trim().replace(/^\||\|$/g, '');
    const cells = [];
    let cell = '';
    let escaped = false;
    let ticks = 0;
    for (const character of value) {
      if (character === '\\' && !escaped) {
        escaped = true;
        cell += character;
        continue;
      }
      if (character === '`' && !escaped) ticks ^= 1;
      if (character === '|' && !escaped && !ticks) {
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
    const rows = source.split('\n');
    const header = splitTableRow(rows[0]);
    const align = splitTableRow(rows[1]).map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
    const head = header.map((cell, index) => `<th${align[index] ? ` style="text-align:${align[index]}"` : ''}>${renderInlineInternal(cell, context)}</th>`).join('');
    const body = rows.slice(2).map((row) => `<tr>${splitTableRow(row).map((cell, index) => `<td${align[index] ? ` style="text-align:${align[index]}"` : ''}>${renderInlineInternal(cell, context)}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function listRows(source) {
    const rows = [];
    for (const line of source.split('\n')) {
      const match = listMatch(line);
      if (match) {
        rows.push(match);
      } else if (rows.length && line.trim()) {
        rows.at(-1).content += `\n${line.trim()}`;
      }
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
          let content = rows[index].content;
          const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(content);
          const checked = task && task[1].toLowerCase() === 'x';
          if (task) content = task[2];
          html += `<li${task ? ` class="task-item${checked ? ' is-checked' : ''}"` : ''}>`;
          if (task) html += `<input type="checkbox" disabled${checked ? ' checked' : ''}>`;
          html += renderInlineInternal(content, context);
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

  function renderNested(source, context) {
    if (!source.trim()) return '';
    const nested = scan(source, false).blocks;
    return nested.map((block) => renderBlock(block, context)).join('');
  }

  function renderBlock(block, context) {
    const ctx = context || {};
    const attrs = block.id ? ` data-block-id="${escapeHtml(block.id)}"` : '';
    if (/^h[1-6]$/.test(block.type)) {
      const level = block.meta.level || Number(block.type.slice(1));
      const id = block.meta.headingId || slug(block.text);
      return `<h${level}${attrs} id="${escapeHtml(id)}">${renderInlineInternal(block.meta.rawText || block.text, ctx)}</h${level}>`;
    }
    switch (block.type) {
      case 'frontmatter':
      case 'reference-def': return '';
      case 'p': {
        const inline = renderInlineInternal(block.source, ctx);
        return inline ? `<p${attrs}>${inline}</p>` : '';
      }
      case 'quote': return `<blockquote${attrs}>${renderNested(block.meta.bodySource, ctx)}</blockquote>`;
      case 'callout': {
        const title = `${calloutIcon(block.meta.calloutKind)}${renderInlineInternal(block.meta.title, ctx)}`;
        const body = block.meta.bodySource.trim() ? `<div class="callout-body">${renderNested(block.meta.bodySource, ctx)}</div>` : '';
        if (block.meta.fold) return `<details${attrs} class="callout callout-${block.meta.calloutKind}" data-callout="${block.meta.calloutKind}"${block.meta.fold === '+' ? ' open' : ''}><summary class="callout-title">${title}</summary>${body}</details>`;
        return `<aside${attrs} class="callout callout-${block.meta.calloutKind}" data-callout="${block.meta.calloutKind}"><div class="callout-title">${title}</div>${body}</aside>`;
      }
      case 'list': return `<div${attrs} class="list-block">${renderList(block.source, ctx)}</div>`;
      case 'code': {
        const language = block.meta.lang ? ` class="language-${escapeHtml(block.meta.lang)}"` : '';
        if (FIGURE_LANGUAGES.has(block.meta.lang.toLowerCase())) return renderFigureRail(block, attrs, ctx);
        const body = Castor.hl && typeof Castor.hl.highlight === 'function' ? Castor.hl.highlight(block.text, block.meta.lang) : escapeHtml(block.text);
        return `<pre${attrs}><code${language}>${body}</code></pre>`;
      }
      case 'table': return `<div${attrs} class="table-block">${renderTable(block.source, ctx)}</div>`;
      case 'hr': return `<hr${attrs}>`;
      case 'embed': return `<figure${attrs} class="embed-block">${renderEmbed(block.meta)}${block.meta.caption ? `<figcaption>${renderInlineInternal(block.meta.caption, ctx)}</figcaption>` : ''}</figure>`;
      case 'footnote-def': return `<aside${attrs} class="footnote-definition" id="fn-${escapeHtml(block.meta.footnoteKey)}" data-key="${escapeHtml(block.meta.footnoteKey)}"><sup>${footnoteNumber(ctx, block.meta.footnoteKey)}</sup> ${renderInlineInternal(block.meta.body, ctx)}</aside>`;
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
    const footnoteBodies = {};
    for (const block of scanned.blocks) {
      if (block.type === 'footnote-def') footnoteBodies[block.meta.footnoteKey] = block.meta.body;
    }
    const context = { references, footnotes: footnoteBodies, showWriterNotes: Boolean(opts.showWriterNotes), figures: opts.figures || null };
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
    return { blocks, references, footnotes, footnoteNumbers, footnoteOrder, frontmatter: scanned.frontmatter, headings, trailing };
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
