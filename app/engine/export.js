/* Descant readable article copy. The Markdown renderer owns syntax and references. */
(function (global) {
  'use strict';
  var Castor = global.Castor || (global.Castor = {});
  var OMIT = ['cw-mirror', 'footnote-ref', 'cw-fnref', 'footnote-definition', 'footnote-margin', 'footnote-inline',
    'footnote-back', 'writer-note', 'castor-thread', 'castor-inline', 'castor-comments', 'cw-selmenu', 'cw-picker'];

  function currentSource() {
    var editor = Castor.editor;
    if (!editor || !editor.getCurrentSource) throw Error('Current native article text is unavailable.');
    return editor.getCurrentSource();
  }

  function textFromNode(node, references) {
    if (node.nodeType === 3) return node.textContent;
    var tag = (node.tagName || '').toLowerCase();
    if (/^(button|input|textarea|select|script|style|svg|audio|video|embed|iframe)$/.test(tag)) return '';
    if (node.getAttribute && node.getAttribute('data-type') === 'frontmatter') return '';
    if (node.classList && OMIT.some(function (name) { return node.classList.contains(name); })) return '';
    if (node.classList && node.classList.contains('cw-edit')) {
      var parsed = Castor.md.parse(node.textContent, { references: references });
      return bodyText(parsed) + '\n\n';
    }
    if (tag === 'br') return '\n';
    if (tag === 'img') return node.getAttribute('alt') || '';
    var text = Array.prototype.map.call(node.childNodes || [], function (child) { return textFromNode(child, references); }).join('');
    if (tag === 'td' || tag === 'th') return text.trim() + '\t';
    if (tag === 'tr') return text.replace(/\t+$/, '') + '\n';
    if (tag === 'li') return text.trim() + '\n';
    if (/^(p|h[1-6]|pre|blockquote|aside|details|summary|figure|figcaption)$/.test(tag) ||
      node.classList && (node.classList.contains('callout-title') || node.classList.contains('cw-block'))) return text + '\n\n';
    return text;
  }

  function clean(text) {
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function htmlText(html, references) {
    var holder = global.document.createElement('div');
    holder.innerHTML = html;
    return clean(textFromNode(holder, references));
  }

  function bodyText(doc) {
    return doc.blocks.filter(function (block) { return block.type !== 'frontmatter' && block.type !== 'footnote-def' && block.type !== 'reference-def'; })
      .map(function (block) { return htmlText(block.html, doc.references); }).filter(Boolean).join('\n\n');
  }

  function articleText(options) {
    var doc = Castor.md.parse(currentSource()), text = bodyText(doc);
    if (options && options.includeNotes) {
      var keys = (doc.footnoteOrder || []).filter(function (key) { return Object.prototype.hasOwnProperty.call(doc.footnotes, key); });
      Object.keys(doc.footnotes).forEach(function (key) { if (keys.indexOf(key) < 0) keys.push(key); });
      var notes = keys.map(function (key, i) { return (i + 1) + '. ' + htmlText(doc.footnotes[key], doc.references); });
      if (notes.length) text += (text ? '\n\n' : '') + 'Notes\n\n' + notes.join('\n\n');
    }
    return text;
  }

  function selectionText(range) {
    var references = Castor.md.parse(currentSource()).references;
    return clean(textFromNode(range.cloneContents(), references));
  }

  function showFallback(text) {
    var document = global.document, previous = document.activeElement;
    var dialog = document.createElement('dialog'); dialog.className = 'castor-export-dialog';
    dialog.setAttribute('aria-label', 'Copy article');
    var explanation = document.createElement('p');
    explanation.textContent = 'Clipboard access is unavailable. Select this text and copy it.';
    var field = document.createElement('textarea'); field.value = text; field.readOnly = true; field.rows = 12;
    field.setAttribute('aria-label', 'Article text to copy');
    var close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
    function finish() { dialog.remove(); if (previous && previous.focus) previous.focus({ preventScroll: true }); }
    close.addEventListener('click', function () { if (dialog.close) dialog.close(); else finish(); });
    dialog.addEventListener('close', finish);
    dialog.appendChild(explanation); dialog.appendChild(field); dialog.appendChild(close);
    document.body.appendChild(dialog);
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    field.focus(); field.select();
    return dialog;
  }

  async function copyArticle(options) {
    var text = articleText(options);
    if (!text) return { copied: false, text: text, reason: 'empty' };
    try {
      var clipboard = global.navigator && global.navigator.clipboard;
      if (global.isSecureContext === false || !clipboard || !clipboard.writeText) throw Error('Clipboard unavailable');
      await clipboard.writeText(text);
      return { copied: true, text: text };
    } catch (e) {
      return { copied: false, text: text, reason: 'clipboard-unavailable', fallback: showFallback(text) };
    }
  }

  Castor.export = { articleText: articleText, selectionText: selectionText, copyArticle: copyArticle, showFallback: showFallback };
})(window);
