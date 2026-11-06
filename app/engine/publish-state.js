/* Public-version evidence and the founder's Mac publishing action. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {}), D = global.document;
  var ctx, marker, panel, sheet, path = '', epoch = 0, bound = false, busy = false, requestSeq = 0, saveRevision = 0, inFlight;
  var helper = 'http://127.0.0.1:47231';
  var startCommand = 'design/app/tools/descant-publish serve';
  var syncSheet;
  var words = {
    tags: 'Tags', suggestions: 'Tag suggestions', placeholder: 'Search or add a tag', newTag: 'new', remove: 'Remove tag ',
    invalid: 'Use letters a-z and numbers, with hyphens between words.', limit: 'Use at most 12 tags.',
    frontmatter: 'This article needs front matter before adding tags.', duplicate: 'Keep one tags field in the front matter.',
    unavailable: 'Site suggestions are unavailable. You can still add tags.', loading: 'Reading site tags.',
    saving: 'Saving tags. Publish will be ready when the save finishes.', saved: 'Tags saved.',
    saveFailed: 'Tags are not saved yet. Check the save status, then try again.',
    required: 'Add at least one tag for ', noSites: 'No publishing site is set up for this writing space. Ask your agent to add one to .descant/config.json.', pending: 'Add the typed tag or clear the input before publishing.'
  };
  function normalizeTag(value) { return String(value).trim().toLowerCase().replace(/\s+/g, '-'); }
  function validTags(tags) {
    if (tags.length > 12) throw Error(words.limit);
    if (tags.some(function (tag) { return !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag); })) throw Error(words.invalid);
  }
  // Replace only the tags field and its list items, never reserialize the document.
  function withTagsSource(source, tags) {
    validTags(tags);
    var text = String(source), header = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
    if (!header) throw Error(words.frontmatter);
    var newline = header[1].includes('\r') ? '\r\n' : '\n', rows = header[2].split(newline);
    var hits = rows.reduce(function (all, row, i) { if (/^tags:/.test(row)) all.push(i); return all; }, []);
    if (hits.length > 1) throw Error(words.duplicate);
    if (!hits.length) rows.push('tags: [' + tags.join(', ') + ']');
    else {
      var at = hits[0], block = /^tags:[ \t]*(?:#.*)?$/.test(rows[at]), end = at + 1;
      while (end < rows.length && (!rows[end].trim() || /^(?:[ \t]+|#|-\s)/.test(rows[end]))) end++;
      var items = rows.slice(at + 1, end).filter(function (row) { return /^[ \t]*-\s/.test(row); });
      var indent = items.length ? items[0].match(/^[ \t]*/)[0] : '  ';
      var replacement = block ? ['tags:'].concat(tags.map(function (tag) { return indent + '- ' + tag; })) : ['tags: [' + tags.join(', ') + ']'];
      // Blank lines and comments between keys are not owned by the tags field.
      var tail = rows.slice(at + 1, end).filter(function (row) { return !/^[ \t]*-\s/.test(row); });
      rows.splice.apply(rows, [at, end - at].concat(replacement, tail));
    }
    return header[1] + rows.join(newline) + header[3] + text.slice(header[0].length);
  }
  function tagsIn(text) {
    var value = C.md.parse(text).frontmatter.tags;
    return Array.isArray(value) ? value.slice() : value ? [String(value)] : [];
  }
  // Count whole words (or hyphenated phrases), folding simple English plurals.
  function suggestTags(text, available, chosen) {
    function stem(word) { return word.replace(/ies$/, 'y').replace(/(ch|sh|ss|x|z)es$/, '$1').replace(/([^s])s$/, '$1'); }
    function tokens(value) { return (String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []).map(stem); }
    var parsed = C.md.parse(text), fields = parsed.frontmatter;
    var body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    var sections = [fields.title, fields.subtitle, body].map(tokens);
    var selected = chosen.map(normalizeTag), seen = [];
    return available.filter(function (entry) {
      if (!entry.onSite || typeof entry.tag !== 'string') return false;
      var tag = normalizeTag(entry.tag);
      if (selected.indexOf(tag) >= 0 || seen.indexOf(tag) >= 0) return false;
      seen.push(tag); return true;
    }).map(function (entry) {
      var phrase = tokens(entry.tag), count = 0;
      if (phrase.length) sections.forEach(function (words) {
        words.forEach(function (_, i) {
          if (phrase.every(function (word, offset) { return words[i + offset] === word; })) count++;
        });
      });
      return { tag: normalizeTag(entry.tag), count: count };
    }).filter(function (entry) { return entry.count > 0; }).sort(function (a, b) {
      return b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
    }).slice(0, 4).map(function (entry) { return entry.tag; });
  }
  function tagPicker(box, site, changed, locked) {
    var tags = tagsIn(source()), suggestions = [], liveAvailable = false, generation = 0, active = -1, options = [];
    var group = el('div'); group.className = 'descant-tags'; box.appendChild(group);
    var label = el('label', words.tags); label.setAttribute('for', 'descant-tag-input'); group.appendChild(label);
    var row = el('div'); row.className = 'descant-tag-row'; group.appendChild(row);
    var chips = el('span'); chips.className = 'descant-tag-chips'; row.appendChild(chips);
    var input = el('input'); input.id = 'descant-tag-input'; input.type = 'text'; input.placeholder = words.placeholder; input.autocomplete = 'off';
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'descant-tag-list');
    input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-describedby', 'descant-tag-message'); row.appendChild(input);
    var list = el('div'); list.id = 'descant-tag-list'; list.className = 'descant-tag-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', words.suggestions); list.hidden = true; group.appendChild(list);
    var suggested = el('div'); suggested.className = 'descant-tag-suggestions'; suggested.setAttribute('role', 'group'); suggested.setAttribute('aria-label', 'Suggested tags'); suggested.hidden = true; group.appendChild(suggested);
    var message = el('p'); message.id = 'descant-tag-message'; message.className = 'descant-tag-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); group.appendChild(message);
    function isNew(tag) { return liveAvailable && !suggestions.some(function (s) { return s.tag === tag && s.onSite; }); }
    function mark(node, tag) { if (isNew(tag)) { var n = el('small', words.newTag); n.className = 'descant-tag-new'; node.appendChild(n); } }
    function close() { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    function renderChips() {
      suggested.replaceChildren();
      var ranked = suggestTags(source(), suggestions, tags);
      suggested.hidden = !ranked.length;
      if (ranked.length) { var caption = el('span', 'Suggested '); caption.className = 'descant-tag-message'; suggested.appendChild(caption); }
      ranked.forEach(function (tag) {
        var chip = button(tag, function () { add(tag); }); chip.className = 'descant-tag-chip'; chip.setAttribute('aria-label', 'Add tag ' + tag);
        chip.disabled = locked(); suggested.appendChild(chip);
      });
      chips.replaceChildren();
      tags.forEach(function (tag) {
        var chip = el('span', tag); chip.className = 'descant-tag-chip'; mark(chip, tag);
        var remove = button('', function () { update(tags.filter(function (t) { return t !== tag; })); input.focus(); });
        remove.className = 'descant-tag-remove'; remove.setAttribute('aria-label', words.remove + tag);
        remove.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
        remove.disabled = locked(); chip.appendChild(remove); chips.appendChild(chip);
      });
    }
    function update(next) {
      if (locked() || !founder() || C.editor.isReadOnly && C.editor.isReadOnly()) return false;
      try {
        var before = source(), after = withTagsSource(before, next);
        var header = C.editor.getBlocks().find(function (b) { return b.type === 'frontmatter'; });
        if (!header || !C.editor.replaceBlock(header.id, C.md.parse(after).blocks[0].source)) throw Error(words.frontmatter);
        tags = next; message.textContent = ''; changed(after); renderChips(); chips.scrollLeft = chips.scrollWidth; return true;
      } catch (error) { message.textContent = error.message; return false; }
    }
    function add(tag) {
      tag = normalizeTag(tag);
      if (!tag) return false;
      try { validTags([tag]); } catch (error) { message.textContent = error.message; return false; }
      if (tags.indexOf(tag) < 0 && !update(tags.concat(tag))) return false;
      input.value = ''; message.textContent = ''; close(); changed(); return true;
    }
    function show() {
      var query = normalizeTag(input.value);
      options = suggestions.filter(function (s) { return tags.indexOf(s.tag) < 0 && s.tag.includes(query); }).map(function (s) { return s.tag; }).slice(0, 5);
      if (query && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(query) && tags.indexOf(query) < 0 && options.indexOf(query) < 0) options.push(query);
      options = options.slice(0, 6); list.replaceChildren(); active = -1;
      options.forEach(function (tag, i) {
        var option = button(tag, function () { add(tag); input.focus(); }); option.id = 'descant-tag-option-' + i;
        option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false'); option.tabIndex = -1; mark(option, tag);
        option.addEventListener('mousedown', function (e) { e.preventDefault(); }); list.appendChild(option);
      });
      list.hidden = !options.length; input.setAttribute('aria-expanded', String(!!options.length)); input.removeAttribute('aria-activedescendant');
    }
    input.addEventListener('focus', show);
    input.addEventListener('input', function () { message.textContent = ''; show(); changed(); });
    // Do not move a dialog action between pointerdown and click. Hiding an
    // in-flow list recentres the sheet; the intended button would move away.
    input.addEventListener('blur', function (e) { if (!e.relatedTarget || !box.contains(e.relatedTarget)) close(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation(); if (e.isComposing) return;
      if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } return; }
      if (e.key === 'Backspace' && !input.value) { e.preventDefault(); update(tags.slice(0, -1)); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (list.hidden) show(); if (!options.length) return;
        active = (active + (e.key === 'ArrowDown' ? 1 : active < 0 ? 0 : -1) + options.length) % options.length;
        Array.from(list.children).forEach(function (n, i) { n.setAttribute('aria-selected', String(i === active)); });
        input.setAttribute('aria-activedescendant', 'descant-tag-option-' + active); return;
      }
      if (['Enter', 'Tab', ','].indexOf(e.key) >= 0 && (input.value.trim() || active >= 0)) {
        var tag = active >= 0 && !list.hidden ? options[active] : input.value;
        if (e.key !== 'Tab' || !add(tag)) e.preventDefault();
        if (e.key !== 'Tab') add(tag);
      } else if (e.key === 'Tab') close();
    });
    function load() {
      if (!site.value) { suggestions = []; close(); renderChips(); message.textContent = ''; return Promise.resolve(); }
      var selected = site.value, held = ++generation; suggestions = []; liveAvailable = false; close(); renderChips();
      message.textContent = words.loading;
      return request('/api/site-tags?site=' + encodeURIComponent(selected)).then(function (data) {
        if (sheet !== box || held !== generation || selected !== site.value) return;
        suggestions = Array.isArray(data.tags) ? data.tags : []; liveAvailable = data.liveAvailable === true;
        message.textContent = liveAvailable ? '' : words.unavailable; renderChips();
        if (D.activeElement === input) show();
      }).catch(function () { if (sheet === box && held === generation) message.textContent = words.unavailable; });
    }
    site.addEventListener('change', function () { load(); changed(); }); load();
    return { tags: function () { return tags; }, pending: function () { return !!input.value.trim(); }, lock: function () { input.disabled = locked(); renderChips(); close(); } };
  }
  function el(tag, text) { var n = D.createElement(tag); if (text != null) n.textContent = text; return n; }
  function button(text, fn) { var n = el('button', text); n.type = 'button'; n.addEventListener('click', fn); return n; }
  // A founder is whoever the server confirmed, even before "Who's writing?" is answered:
  // the public writer is already signed in as one founder (10 Oct: the marker never
  // appeared there until the dialog was answered).
  function isWriter(id) { return !!(C.people && C.people.isWriter(id)); }
  function founder() {
    var role = C.role || {};
    if (role.role === 'reviewer' || role.reviewer === true) return '';
    var who = C.who && C.who.session ? C.who.session() : [];
    if (who[0]) return isWriter(who[0].id) ? who[0].id : '';
    if (isWriter(role.who || '')) return role.who;
    return role.confirmed === true || role.role === 'founder' ? 'founder' : '';
  }
  function source() { return C.editor && C.editor.getSource ? C.editor.getSource() : C.app.source; }
  function piece() { return (C.app.data && C.app.data.piece) || {}; }
  // The writing space's sites come with the piece (space_config.client_sites on the server).
  function sites() { return Array.isArray(piece().sites) ? piece().sites : []; }
  function siteRule(name) { return sites().filter(function (s) { return s.name === name; })[0] || {}; }
  function defaultSite(fields) {
    var list = sites(), chip = fields.chip && list.filter(function (s) { return s.chip; })[0];
    var plain = list.filter(function (s) { return s.default; })[0] || list[0];
    return (chip || plain || {}).name || '';
  }
  function loadedEvidence() {
    var p = piece();
    return Object.prototype.hasOwnProperty.call(p, 'live') && typeof p.savedMarkdown === 'string'
      && /^[a-f0-9]{64}$/.test(p.article_sha256_now || '');
  }
  function clean() { return !!(C.saver && C.saver.snapshot && C.saver.snapshot().clean && ['ready', 'saved'].indexOf(C.saver.state()) >= 0); }
  function state() {
    var p = piece(), live = p.live;
    if (!live) return 'Not published';
    var prefix = 'Live on ' + live.site;
    if (!canDiff()) return prefix + '. Descant has no record of which version. Update the live version to record it.';
    if (p.article_sha256_now === live.article_sha256 && source() === p.savedMarkdown) return prefix + ', matches what you are reading';
    return prefix + ', changed since ' + date(live.published_at);
  }
  function date(value) { var d = new Date(value); return isNaN(d.getTime()) ? 'publication' : d.toLocaleDateString(); }
  function statusWords() {
    var p = piece(), live = p.live;
    if (!live) return 'Not published';
    if (!canDiff()) return 'Live, version not recorded';
    return p.article_sha256_now === live.article_sha256 && source() === p.savedMarkdown ? 'Matches website' : 'Unpublished changes';
  }
  /* A personal installation (someone's own Descant) has no Castor sites to publish to. */
  function personal() { var install = C.app && C.app.data && C.app.data.install; return !!(install && install.kind === 'personal'); }
  function reason() {
    if (personal()) return 'Publishing is not set up yet. Your coding agent can set it up: see PUBLISHING.md in your writing folder.';
    if (!founder()) return 'Only a founder can publish this article.';
    if (busy) return 'Publishing is in progress.';
    if (!clean()) return 'Save the article before publishing.';
    return '';
  }
  function comparison(article, record) {
    if (!record || !record.commit || !record.article_sha256) return Promise.reject(Error('Published text is unavailable.'));
    return global.fetch('/api/piece/live?path=' + encodeURIComponent(article), {cache:'no-store'}).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) { var e = Error(data.error || 'Published text is unavailable.'); e.unavailable = [404,409,422].indexOf(r.status) >= 0; throw e; }
        if (data.commit !== record.commit || typeof data.markdown !== 'string') throw Error('The website changed while loading. Try again.');
        return data;
      });
    });
  }
  function canDiff() { return piece().live && piece().live.article_sha256 && piece().live.commit; }
  function request(url, options) {
    return global.fetch(url, options || {cache:'no-store'}).then(function (r) {
      return r.json().then(function (data) { if (!r.ok) throw Error(data.error || 'The request failed.'); return data; });
    });
  }
  function refresh() {
    var captured = epoch, article = path, who = founder(), p = piece(), text = source();
    if (!article || !who) return Promise.resolve();
    // Share duplicate focus/receipt reads. A completed save starts a new read,
    // even if a pending pre-save request saw the same editor buffer.
    if (inFlight && inFlight.epoch === captured && inFlight.path === article && inFlight.who === who && inFlight.piece === p && inFlight.text === text && inFlight.saved === p.savedMarkdown && inFlight.save === saveRevision) return inFlight.promise;
    var held = { epoch: captured, path: article, who: who, piece: p, text: text, saved: p.savedMarkdown, save: saveRevision }, sequence = ++requestSeq;
    inFlight = held;
    held.promise = request('/api/piece?path=' + encodeURIComponent(article)).then(function (data) {
      if (captured !== epoch || sequence !== requestSeq || who !== founder() || article !== path || p !== piece()
        || C.pieces && C.pieces.current && C.pieces.current() !== article) return;
      p.live = data.live || null; p.article_sha256_now = data.article_sha256_now;
      p.savedMarkdown = data.markdown; paint();
      if (C.changes && C.changes.refresh) C.changes.refresh();
      return data;
    }).catch(function () { /* Keep the last received evidence, never invent a match. */ })
      .finally(function () { if (inFlight === held) inFlight = null; });
    return held.promise;
  }
  async function waitForRecord(record, captured) {
    // Reads can precede the hub's background pull. Wait for its receipt rather
    // than replacing the article with the stale snapshot from an immediate read.
    for (var attempt = 0; attempt < 30 && captured === epoch; attempt++) {
      var data = await refresh(), live = data && data.live;
      if (live && ['site','url','commit','article_sha256','published_at'].every(function (key) { return live[key] === record[key]; })) return true;
      await new Promise(function (resolve) { global.setTimeout(resolve, 1000); });
    }
    return false;
  }
  function hideSheet() { syncSheet = null; if (sheet) { var old = sheet; sheet = null; old.close(); old.remove(); } }
  function dialog(title) {
    hideSheet(); sheet = el('dialog'); sheet.className = 'descant-publish-sheet';
    sheet.setAttribute('aria-label', title); sheet.appendChild(el('h2', title));
    var opened = sheet; sheet.addEventListener('close', function () { if (sheet === opened) hideSheet(); });
    D.body.appendChild(sheet); sheet.showModal(); return sheet;
  }
  function showDiff() {
    if (C.changes && C.changes.open) { hideSheet(); C.changes.open('website'); return Promise.resolve(); }
    var article = path, captured = epoch, current = source();
    var box = dialog('Changes since publication'), status = el('p', 'Reading the published version.');
    box.appendChild(status); box.appendChild(button('Close', hideSheet));
    return request('/api/piece/live?path=' + encodeURIComponent(article)).then(function (data) {
      if (captured !== epoch || sheet !== box) return;
      status.textContent = 'Removed text is struck through. Added text is underlined.';
      var diff = el('pre'); diff.className = 'descant-live-diff';
      // Reuse the engine word diff; textContent prevents Markdown from becoming HTML.
      C.diff.words(data.markdown, current).forEach(function (part) {
        diff.appendChild(el(part.op === 'del' ? 'del' : part.op === 'ins' ? 'ins' : 'span', part.text));
      });
      box.insertBefore(diff, box.lastChild);
    }).catch(function (error) { if (sheet === box) status.textContent = error.message; });
  }
  function paint() {
    if (!marker) return;
    var live = piece().live, words = statusWords();
    // One dot, like the green dot that marks where you are in the article tabs:
    // green = the live version is what you are reading, amber = changed since, grey = not live.
    var code = !live ? 'none' : !canDiff() ? 'unknown' : words === 'Matches website' ? 'match' : 'changed';
    marker.setAttribute('data-state', code);
    var long = el('span', words), short = el('span', code === 'none' ? 'Not live' : code === 'changed' ? 'Changed' : 'Live');
    long.className = 'live-long'; short.className = 'live-short';
    marker.replaceChildren(long, short); marker.setAttribute('title', words); marker.setAttribute('aria-label', words);
    if (!panel) return;
    panel.replaceChildren(); var live = piece().live;
    panel.appendChild(el('p', live ? live.site : 'Not published'));
    if (live) {
      var url;
      try { url = new URL(live.url); } catch (error) { url = null; }
      if (url && url.protocol === 'https:' && (url.hostname === live.site || url.hostname === 'www.' + live.site)) {
        var link = el('a', 'Open live article'); link.href = live.url; link.target = '_blank'; link.rel = 'noopener'; panel.appendChild(link);
      }
      panel.appendChild(el('p', 'Published ' + date(live.published_at)));
      panel.appendChild(el('p', state()));
      if (canDiff()) panel.appendChild(button('See changes', showDiff));
    }
    var publish = button(live ? 'Update the live version' : 'Publish', confirm);
    var blocked = reason(); publish.disabled = !!blocked; panel.appendChild(publish);
    if (blocked) panel.appendChild(el('p', blocked));
  }
  function confirm() {
    if (busy) return;
    if (panel && panel.hidePopover) panel.hidePopover();
    if (C.editor && C.editor.flush) C.editor.flush();
    if (!clean()) { var saved = dialog('Save first'); saved.appendChild(el('p', 'Save first')); saved.appendChild(button('Close', hideSheet)); return; }
    var blocked = reason();
    if (blocked) { var unavailable = dialog('Publish unavailable'); unavailable.appendChild(el('p', blocked)); unavailable.appendChild(button('Close', hideSheet)); return; }
    var article = path, captured = epoch, who = founder(), original = source();
    var fields = C.md.parse(original).frontmatter;
    var box = dialog(piece().live ? 'Update the live version' : 'Publish this article');
    ['title', 'subtitle', 'slug'].forEach(function (key) { box.appendChild(el('p', key.charAt(0).toUpperCase() + key.slice(1) + ': ' + (fields[key] || '(missing)'))); });
    var label = el('label', 'Site'), site = el('select'); site.setAttribute('aria-label', 'Site');
    sites().forEach(function (entry) { var option = el('option', entry.name); option.value = entry.name; site.appendChild(option); });
    var preferred = [fields.site, piece().live && piece().live.site, defaultSite(fields)].filter(function (name) { return name && siteRule(name).name; })[0];
    site.value = preferred || ''; label.appendChild(site); box.appendChild(label);
    if (!sites().length) { site.disabled = true; box.appendChild(el('p', words.noSites)); }
    var tagsChanged = false;
    var picker = tagPicker(box, site, function (next) {
      if (next) { original = next; tagsChanged = true; }
      if (syncSheet) syncSheet();
    }, function () { return busy; });
    var metadata = el('p'); box.appendChild(metadata);
    function describe() { metadata.textContent = siteRule(site.value).chip ? 'Chip: ' + (fields.chip || '(missing)') : ''; }
    function tagsRequired() { return siteRule(site.value).tagsRequired === true && !picker.tags().length; }
    site.addEventListener('change', function () { describe(); if (syncSheet) syncSheet(); }); describe();
    var health = null, healthFailed = false, checking = true;
    var availability = el('p', 'Checking the publishing connection.'); availability.setAttribute('role', 'status'); box.appendChild(availability);
    // Configuration belongs to the helper, not to the article's optional site field.
    // Reading /health never publishes or changes article metadata.
    request(helper + '/health').then(function (data) {
      if (sheet !== box || captured !== epoch) return;
      health = data; checking = false; if (syncSheet) syncSheet();
    }).catch(function () {
      if (sheet !== box || captured !== epoch) return;
      healthFailed = true; checking = false;
      var command = el('input'); command.value = startCommand; command.readOnly = true; command.setAttribute('aria-label', 'Start publishing helper');
      command.addEventListener('click', function () { command.select(); }); box.insertBefore(command, availability);
      if (syncSheet) syncSheet();
    });
    var steps = el('div'); steps.className = 'descant-publish-steps'; steps.setAttribute('role', 'status'); steps.setAttribute('aria-live', 'polite'); box.appendChild(steps);
    var go = button('Publish', function () {
      if (captured !== epoch || who !== founder() || article !== path) return;
      if (!clean() || source() !== original) { steps.replaceChildren(el('p', 'Save first')); return; }
      if (!site.value || picker.pending() || tagsRequired()) { syncSheet(); return; }
      busy = true; pendingButton(true, 'Publishing…'); go.disabled = true; site.disabled = true; picker.lock(); paint();
      var selected = site.value, success = null;
      return request(helper + '/health').catch(function () {
        steps.appendChild(el('p', 'Publishing runs from your Mac. Start it with:'));
        var command = el('input'); command.value = startCommand; command.readOnly = true; command.setAttribute('aria-label', 'Start publishing helper');
        command.addEventListener('click', function () { command.select(); }); steps.appendChild(command);
        throw Error('The publishing helper is unreachable.');
      }).then(function (health) {
        var ready = health.sites && health.sites[selected];
        if (ready !== 'ready') throw Error(ready || 'The receiving site is not ready.');
        // The remote save must have reached origin/main before the helper fetches it.
        return request('/api/piece?path=' + encodeURIComponent(article));
      }).then(function (saved) {
        if (captured !== epoch || !clean() || source() !== original || saved.markdown !== original) throw Error('Save first');
        if (!saved.save || !saved.save.shared || saved.save.shared.ok !== true) throw Error('The save has not reached the shared copy yet. Try again after it syncs.');
        return global.fetch(helper + '/publish', {method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({article:article, site:selected, live:true, article_sha256:saved.article_sha256_now})});
      }).then(async function (response) {
        if (!response.ok || !response.body) throw Error('The publishing helper refused the request.');
        var reader = response.body.getReader(), decoder = new TextDecoder(), pending = '';
        function event(line) {
          if (!line.trim()) return;
          var data = JSON.parse(line);
          if (Object.prototype.hasOwnProperty.call(data, 'ok')) { success = data; return; }
          if (sheet === box) steps.appendChild(el('p', [data.step, data.status, data.message].filter(Boolean).join(': ')));
        }
        while (true) {
          var chunk = await reader.read();
          pending += decoder.decode(chunk.value || new Uint8Array(), {stream:!chunk.done});
          var rows = pending.split('\n'); pending = rows.pop(); rows.forEach(event);
          if (chunk.done) { if (pending.trim()) event(pending); break; }
        }
        if (!success || !success.ok) throw Error((success && (success.error || success.message)) || 'Publishing did not finish.');
        if (!success.live_record || !success.live_record.article_sha256 || !success.verification || !success.verification.ok) throw Error('The helper did not return a verified published version.');
        if (sheet === box) steps.appendChild(el('p', 'Published. HTTP 200, title found.'));
        if (captured === epoch) {
          if (sheet === box) steps.appendChild(el('p', 'Waiting for Descant to receive the published version.'));
          var received = await waitForRecord(success.live_record, captured);
          if (!received && captured === epoch) throw Error('The article is live, but Descant has not received the record yet. Reopen it after it syncs.');
          if (captured === epoch && clean() && source() === original && C.app.reload) await C.app.reload();
        }
      }).catch(function (error) { if (sheet === box) steps.appendChild(el('p', error.message)); })
        .finally(function () { busy = false; go.disabled = false; site.disabled = false; picker.lock(); if (syncSheet) syncSheet(); paint(); });
    });
    function pendingButton(waiting, label) {
      go.className = 'descant-primary' + (waiting ? ' castor-pending' : '');
      if (waiting) go.setAttribute('aria-busy', 'true'); else go.removeAttribute('aria-busy');
      go.textContent = waiting ? label : 'Publish';
    }
    var saveStatus = el('p'); saveStatus.className = 'descant-tag-save'; saveStatus.setAttribute('role', 'status'); saveStatus.setAttribute('aria-live', 'polite');
    box.appendChild(saveStatus);
    syncSheet = function () {
      if (sheet !== box || busy) return;
      var waiting = !clean() || source() !== original, required = tagsRequired();
      var configured = health && health.sites && health.sites[site.value] === 'ready';
      var savingTags = waiting && tagsChanged && ['ready', 'saved', 'unsaved', 'saving'].indexOf(C.saver.state()) >= 0;
      pendingButton(savingTags, 'Saving tags…');
      go.disabled = !site.value || waiting || required || picker.pending() || checking || healthFailed || !configured;
      availability.textContent = checking ? 'Checking the publishing connection.' : healthFailed ? 'The publishing helper is not running on this Mac. Ask your agent to start it with the command above.'
        : !site.value ? '' : !configured ? 'Publishing is not set up for ' + site.value + '. Ask your agent to connect this site.' : '';
      saveStatus.textContent = waiting ? (tagsChanged ? (['error', 'conflict', 'offline', 'refused', 'dirty'].indexOf(C.saver.state()) >= 0 ? words.saveFailed : words.saving) : 'Save first')
        : required ? words.required + site.value + '.' : picker.pending() ? words.pending : tagsChanged ? words.saved : '';
    };
    go.className = 'descant-primary'; syncSheet(); box.appendChild(go); box.appendChild(button('Close', hideSheet));
  }
  function mount(context) {
    ctx = context; epoch++;
    if (marker) marker.remove(); if (panel) panel.remove(); marker = panel = null;
    if (!busy) hideSheet();
    path = C.pieces && C.pieces.current ? C.pieces.current() : '';
    if (!/^articles\/[^/]+\/article\.md$/.test(path) || !founder()) return;
    marker = button('', paint); marker.className = 'descant-live-marker';
    panel = el('div'); panel.className = 'descant-live-popover'; panel.id = 'descant-live-popover';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Published version');
    // It lives in the status row beside the save state, where he looks for "is this safe": bottom right, part of Save.
    var foot = D.querySelector ? D.querySelector('.foot-meta') : null, save = foot && foot.querySelector('.foot-save');
    if (foot) { marker.classList.add('in-foot'); foot.insertBefore(marker, save || null); }
    else (ctx.page || ctx.article.parentNode).appendChild(marker);
    D.body.appendChild(panel);
    if (C.popovers) C.popovers.bind(marker, panel, paint);
    else { panel.hidden = true; marker.addEventListener('click', function () { panel.hidden = !panel.hidden; }); }
    marker.addEventListener('click', function (event) {
      if (statusWords() !== 'Unpublished changes' || !C.changes || !C.changes.open) return;
      event.preventDefault(); event.stopImmediatePropagation();
      C.changes.open('website');
    }, true);
    if (!bound) {
      bound = true;
      ctx.bus.on('doc:change', function () { paint(); if (syncSheet) syncSheet(); });
      ctx.bus.on('save:state', function (e) {
        paint(); if (syncSheet) syncSheet();
        if (e && e.state === 'saved') { saveRevision++; refresh(); }
        else if (e && e.state === 'ready' && !loadedEvidence()) refresh();
      });
      ctx.bus.on('who:set', function () { mount(ctx); });
      if (global.addEventListener) global.addEventListener('focus', refresh);
    }
    paint(); if (!loadedEvidence()) refresh();
  }
  C.publishState = { suggestTags: suggestTags, withTagsSource: withTagsSource, normalizeTag: normalizeTag, mount: mount, state: state, statusWords: statusWords, reason: reason, open: function () { if (personal()) { if (C.commands && C.commands.run) C.commands.run('publish.setup'); return; } return confirm(); }, comparison: comparison, refresh: refresh };
})(typeof window !== 'undefined' ? window : globalThis);
