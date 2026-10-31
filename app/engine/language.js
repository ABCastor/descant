/* The language the browser checks spelling in. The article's front matter
   `language:` names it; a paragraph clearly written in another language (an
   Italian quote in an English piece) gets its own. The page can only declare
   the language: which dictionaries exist is the browser's and the system's. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {}), D = global.document;
  var NAMES = { en: 'English', it: 'Italiano', es: 'Español', fr: 'Français', de: 'Deutsch' };
  // Short, frequent words that belong to one language only (shared ones like
  // "la", "de" or "no" are left out so they cannot tip the count).
  var WORDS = {
    en: 'the and of to is that it with for was this are be you not have but they what which from when would there their been were has had will an or by at',
    it: 'il gli di che è non per una sono del della dello con ma questo questa anche più nel nella alla dei delle ho ha cosa perché come mi si ci io lui lei noi voi loro quando dove sempre',
    es: 'el los las que y en por para del pero más está son muy también cuando como lo su sus yo nosotros es una un',
    fr: 'les des et est une qui dans pour pas ce au du sur avec mais sont nous vous je ne elle cette aux été être',
    de: 'der die das und ist nicht ein eine zu den mit sich auf für im dem auch ich sie wir aber wie oder wenn noch'
  };
  var SETS = {};
  Object.keys(WORDS).forEach(function (code) {
    SETS[code] = {}; WORDS[code].split(' ').forEach(function (w) { SETS[code][w] = true; });
  });
  // Words several lists claim count for none of them.
  (function () {
    var seen = {};
    Object.keys(SETS).forEach(function (code) { Object.keys(SETS[code]).forEach(function (w) { seen[w] = (seen[w] || 0) + 1; }); });
    Object.keys(SETS).forEach(function (code) { Object.keys(SETS[code]).forEach(function (w) { if (seen[w] > 1) delete SETS[code][w]; }); });
  })();

  function detect(text) {
    var words = String(text || '').toLowerCase().replace(/\[[^\]]*\]\([^)]*\)/g, ' ').match(/[a-zà-öø-ÿ']+/g) || [];
    if (words.length < 6) return null;
    var score = {};
    Object.keys(SETS).forEach(function (code) { score[code] = 0; });
    words.forEach(function (w) { Object.keys(SETS).forEach(function (code) { if (SETS[code][w]) score[code]++; }); });
    var ranked = Object.keys(score).sort(function (a, b) { return score[b] - score[a]; });
    var top = score[ranked[0]], second = score[ranked[1]];
    return top >= 3 && top >= second * 2 && top / words.length >= 0.08 ? ranked[0] : null;
  }

  function normal(code) {
    var c = String(code || '').trim().toLowerCase().slice(0, 2);
    return NAMES[c] ? c : '';
  }
  // `language:` changes alone; every other byte of the file stays.
  function withLanguage(source, code) {
    var text = String(source), lang = normal(code);
    if (!lang) throw Error('Choose one of the listed languages.');
    var header = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
    if (!header) throw Error('This article needs front matter before choosing its language.');
    var newline = header[1].indexOf('\r') >= 0 ? '\r\n' : '\n';
    var rows = header[2].split(newline), found = false;
    rows = rows.map(function (row) { if (/^language:/.test(row)) { found = true; return 'language: ' + lang; } return row; });
    if (!found) rows.push('language: ' + lang);
    return header[1] + rows.join(newline) + header[3] + text.slice(header[0].length);
  }

  /* Editing must not pay for a whole-document parse: the article language is
     read from the front matter block alone, and each block is detected again
     only when its own text changed. The memo holds one entry per current block
     and starts over when another article opens. */
  var ctx, control, row, bound = false, frame = 0, memo = {}, head = { key: null, code: 'en', declared: false };
  function blocks() { return C.editor && C.editor.getBlocks ? C.editor.getBlocks() : []; }
  function articleLanguage(list) {
    var fm = list[0] && list[0].type === 'frontmatter' ? list[0].source : '';
    var path = C.pieces && C.pieces.current ? C.pieces.current() : '';
    if (head.key === path + '\n' + fm) return head;
    var declared = normal((/^language:[ \t]*["']?([A-Za-z-]+)/m.exec(fm) || [])[1]);
    var code = declared || detect(list.filter(function (b) { return b.type !== 'frontmatter'; }).slice(0, 40).map(function (b) { return b.source; }).join('\n')) || 'en';
    head = { key: path + '\n' + fm, code: code, declared: !!declared };
    return head;
  }
  function own(b) {
    if (b.type === 'frontmatter' || b.type === 'code') return null;
    var seen = memo[b.id];
    if (seen && seen.source === b.source) return seen.lang;
    var lang = detect(b.source);
    memo[b.id] = { source: b.source, lang: lang };
    return lang;
  }
  function founder() {
    var role = C.role || {};
    if (role.role === 'reviewer' || role.reviewer === true) return false;
    return !!(C.editor && C.editor.canEditSubtitle && C.editor.canEditSubtitle());
  }
  function paint() {
    frame = 0;
    if (!ctx || !ctx.article) return;
    var list = blocks(), article = articleLanguage(list), live = {};
    if (ctx.article.getAttribute('lang') !== article.code) ctx.article.setAttribute('lang', article.code);
    var els = {};
    Array.prototype.forEach.call(ctx.article.querySelectorAll('.cw-block[data-block-id]'), function (el) { els[el.getAttribute('data-block-id')] = el; });
    list.forEach(function (b) {
      live[b.id] = true;
      var el = els[b.id], lang = own(b);
      if (!el) return;
      var want = lang && lang !== article.code ? lang : null;
      if (el.getAttribute('lang') !== want) { if (want) el.setAttribute('lang', want); else el.removeAttribute('lang'); }
    });
    Object.keys(memo).forEach(function (id) { if (!live[id]) delete memo[id]; });
    if (control) control.value = article.code;
    if (row) row.hidden = !founder();
  }
  function queue() {
    if (frame) return;
    frame = global.requestAnimationFrame ? global.requestAnimationFrame(paint) : (paint(), 0);
  }
  function choose() {
    if (!founder() || !control) return;
    var value = control.value;
    try {
      if (C.editor.updateFrontmatter) C.editor.updateFrontmatter(function (text) { return withLanguage(text, value); }, 'language');
    } catch (error) { control.setCustomValidity(error.message); control.reportValidity(); }
    queue();
  }
  function mount(context) {
    ctx = context;
    if (!control && D && D.getElementById) {
      control = D.getElementById('set-language');
      row = control && control.closest ? control.closest('.set-row') : null;
      if (control) {
        Object.keys(NAMES).forEach(function (code) {
          var option = D.createElement('option'); option.value = code; option.textContent = NAMES[code]; control.appendChild(option);
        });
        control.addEventListener('change', choose);
      }
    }
    if (!bound && ctx.bus) {
      bound = true;
      ctx.bus.on('doc:change', queue); ctx.bus.on('who:set', queue);
      ctx.bus.on('piece:open', function () { memo = {}; queue(); });
    }
    queue();
  }
  C.language = { mount: mount, detect: detect, withLanguage: withLanguage, names: NAMES,
    remembered: function () { return Object.keys(memo).length; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = C.language;
})(typeof window !== 'undefined' ? window : globalThis);
