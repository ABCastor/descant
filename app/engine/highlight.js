/* Castor engine: syntax colour for fenced code, with no library. */
(function (root) {
  'use strict';

  const Castor = root.Castor || (root.Castor = {});

  // c=line comments, b=block comments, q=quotes, k=keywords, v=literals and builtins
  const LANGUAGES = {
    js: { c: ['//'], b: ['/*', '*/'], q: '"\'`',
      k: 'as async await break case catch class const continue default delete do else export extends finally for from function get if implements import in instanceof interface let new of return set static super switch this throw try type typeof var void while yield',
      v: 'true false null undefined NaN Infinity console document window Math JSON Object Array Promise' },
    py: { c: ['#'], b: null, q: '"\'',
      k: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
      v: 'True False None self print len range dict list set str int float open enumerate zip' },
    sh: { c: ['#'], b: null, q: '"\'',
      k: 'if then else elif fi for while do done case esac function return export local source in',
      v: 'echo cd ls cat grep sed awk curl git python3 node npm mkdir rm cp mv sudo set' },
    json: { c: [], b: null, q: '"', k: '', v: 'true false null' },
    yaml: { c: ['#'], b: null, q: '"\'', k: '', v: 'true false null yes no ~' },
    go: { c: ['//'], b: ['/*', '*/'], q: '"\'`',
      k: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
      v: 'true false nil iota len cap make new append string int int64 float64 bool error' },
    rs: { c: ['//'], b: ['/*', '*/'], q: '"\'',
      k: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self struct trait type unsafe use where while',
      v: 'true false None Some Ok Err Vec String str usize u8 i32 f64 bool println' },
    sql: { c: ['--'], b: ['/*', '*/'], q: '"\'',
      k: 'select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter index union all limit offset with distinct case when then else end',
      v: 'null true false count sum avg min max coalesce' },
    css: { c: [], b: ['/*', '*/'], q: '"\'',
      k: '@media @supports @font-face @keyframes @import !important',
      v: 'inherit initial none auto var calc rgb hsl' },
    generic: { c: ['#', '//'], b: ['/*', '*/'], q: '"\'`', k: '', v: 'true false null' }
  };

  const ALIASES = {
    javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js',
    python: 'py', py3: 'py', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', golang: 'go',
    rust: 'rs', yml: 'yaml', html: 'ml', xml: 'ml', svg: 'ml', markdown: 'md', diff: 'diff', patch: 'diff'
  };

  const TOKEN_NAMES = {
    c: 'comment', s: 'string', k: 'keyword', n: 'number', v: 'name', f: 'name',
    a: 'name', p: 'punct', ins: 'keyword', del: 'comment'
  };

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function span(kind, value) {
    const name = TOKEN_NAMES[kind];
  return `<span class="code-${name}">${escapeHtml(value)}</span>`;
  }

  function words(value) {
    const result = Object.create(null);
    value.split(' ').forEach((word) => { if (word) result[word] = true; });
    return result;
  }

  function markup(source) {
    let html = '';
    const pattern = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|"[^"]*"|'[^']*'|[\w:-]+(?==)|\/?>/g;
    let index = 0;
    let match;
    while ((match = pattern.exec(source))) {
      html += escapeHtml(source.slice(index, match.index));
      const token = match[0];
      html += token.startsWith('<!--') ? span('c', token)
        : token[0] === '"' || token[0] === "'" ? span('s', token)
        : token[0] === '<' || token === '>' || token === '/>' ? span('k', token)
        : span('a', token);
      index = match.index + token.length;
    }
    return html + escapeHtml(source.slice(index));
  }

  function diff(source) {
    return source.split('\n').map((line) => {
      const kind = line[0] === '+' ? 'ins' : line[0] === '-' ? 'del' : line[0] === '@' ? 'k' : null;
      return kind ? span(kind, line) : escapeHtml(line);
    }).join('\n');
  }

  function tokenize(source, language) {
    const descriptor = LANGUAGES[language] || LANGUAGES.generic;
    const keywords = words(descriptor.k);
    const literals = words(descriptor.v);
    let html = '';
    let index = 0;

    while (index < source.length) {
      let character = source[index];
      let rest;
      let end;

      for (let comment = 0; comment < descriptor.c.length; comment += 1) {
        if (source.startsWith(descriptor.c[comment], index)) {
          end = source.indexOf('\n', index);
          if (end < 0) end = source.length;
          html += span('c', source.slice(index, end));
          index = end;
          character = null;
          break;
        }
      }
      if (character === null) continue;

      if (descriptor.b && source.startsWith(descriptor.b[0], index)) {
        end = source.indexOf(descriptor.b[1], index + descriptor.b[0].length);
        end = end < 0 ? source.length : end + descriptor.b[1].length;
        html += span('c', source.slice(index, end));
        index = end;
        continue;
      }

      if (descriptor.q.includes(character)) {
        const triple = source.startsWith(character.repeat(3), index);
        if (triple) {
          end = source.indexOf(character.repeat(3), index + 3);
          end = end < 0 ? source.length : end + 3;
        } else {
          end = index + 1;
          while (end < source.length && source[end] !== character) {
            if (source[end] === '\\') end += 1;
            if (source[end] === '\n' && character !== '`') break;
            end += 1;
          }
          end = Math.min(end + 1, source.length);
        }
        html += span('s', source.slice(index, end));
        index = end;
        continue;
      }

      if (character >= '0' && character <= '9') {
        rest = /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)[a-zA-Z]*/.exec(source.slice(index));
        if (rest) {
          html += span('n', rest[0]);
          index += rest[0].length;
          continue;
        }
      }

      if (/[A-Za-z_]/.test(character) || ((character === '@' || character === '$') && /[A-Za-z_]/.test(source[index + 1] || ''))) {
        rest = /^[@$]?[A-Za-z_][\w$]*/.exec(source.slice(index))[0];
        end = index + rest.length;
        while (source[end] === ' ') end += 1;
        html += keywords[rest] ? span('k', rest)
          : literals[rest] ? span('v', rest)
          : source[end] === '(' ? span('f', rest)
          : escapeHtml(rest);
        index += rest.length;
        continue;
      }

      if (/[^\w\s]/.test(character)) {
        rest = /^[^\w\s]+/.exec(source.slice(index))[0];
        html += span('p', rest);
        index += rest.length;
        continue;
      }

      html += escapeHtml(character);
      index += 1;
    }

    return html;
  }

  function highlight(source, language) {
    let lang = String(language || '').toLowerCase();
    lang = ALIASES[lang] || lang;
    if (!lang || lang === 'text' || lang === 'plain') return escapeHtml(source);
    if (lang === 'ml') return markup(String(source));
    if (lang === 'diff') return diff(String(source));
    return tokenize(String(source), lang);
  }

  const api = { highlight, languages: Object.keys(LANGUAGES).concat(['ml', 'diff']) };
  Castor.hl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
