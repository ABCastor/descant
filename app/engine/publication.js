/* The article's last action: a private preview, followed by an explicit publication. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {}), D = global.document;
  var ctx, card, candidate, summary, chip, tags, assets, replace, message, actions, dialog, fields;
  var path = '', epoch = 0, busy = false, changed = false, bound = false, configured = false, existing = false, revision = 0;
  function el(tag, text) {
    var n = D.createElement(tag);
    if (text != null) n.textContent = text;
    return n;
  }
  function isWriter(id) { return !!(C.people && C.people.isWriter(id)); }
  function founder() {
    if ((C.role && (C.role.role === 'reviewer' || C.role.publicWriter)) || /^\/write(?:\/|$)/.test((global.location || {}).pathname || '')) return '';
    var session = C.who && C.who.session ? C.who.session() : [];
    return session[0] && isWriter(session[0].id) ? session[0].id : '';
  }
  function current() { return C.pieces && C.pieces.current ? C.pieces.current() : ''; }
  function button(text, fn) {
    var n = el('button', text); n.type = 'button'; n.addEventListener('click', fn); return n;
  }
  function closeDialog() { if (dialog) { dialog.close(); dialog.remove(); dialog = null; } }
  function field(label, tag) {
    var wrap = el('label'), n = el(tag || 'input');
    wrap.appendChild(el('span', label)); n.setAttribute('aria-label', label); wrap.appendChild(n); fields.appendChild(wrap);
    n.addEventListener('input', function () { revision++; if (candidate) { changed = true; closeDialog(); controls(); } });
    return n;
  }
  function say(text) { if (message) message.textContent = text; }
  function request(url, body) {
    return global.fetch(url, body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {cache:'no-store'})
      .then(function (r) { return r.json().then(function (data) { if (!r.ok) throw Error(data.error || 'Publication could not finish.'); return data; }); });
  }
  function fill(data) {
    var m = (candidate && candidate.metadata) || data.site_metadata || {};
    summary.value = m.summary || ''; chip.value = m.chip || 'wave';
    tags.value = Array.isArray(m.tags) ? m.tags.join(', ') : '';
    replace.checked = !!data.site_existing;
  }
  function details() {
    if (!candidate || !card) return;
    if (card._details) card._details.remove();
    var box = el('div'); box.className = 'publication-details';
    if (candidate.created) box.appendChild(el('p', 'Prepared: ' + new Date(candidate.created).toLocaleString()));
    box.appendChild(el('p', 'Site page: ' + candidate.url));
    box.appendChild(el('p', 'Summary: ' + candidate.metadata.summary));
    box.appendChild(el('p', 'Chip: ' + candidate.metadata.chip + '. Date: ' + candidate.metadata.date + '.'));
    box.appendChild(el('p', (replace.checked ? 'Replace the page at this URL.' : 'Add a page at this URL.') + ' Approved images: ' + candidate.changes.filter(function (name) { return name.indexOf('public/descant/') === 0; }).length + '.'));
    if (candidate.changes.indexOf('src/data/assets.json') >= 0) box.appendChild(el('p', 'Refresh the site cache timestamp.'));
    card._details = box; card.appendChild(box);
  }
  function controls() {
    if (!actions) return;
    actions.replaceChildren();
    if (busy) { say('Checking the saved article and building the preview. This may take a few minutes.'); return; }
    if (candidate) {
      details();
      var link = el('a', 'Open private preview'); link.href = candidate.preview; link.target = '_blank'; link.rel = 'noopener';
      link.addEventListener('click', function () {
        // The server records the actual preview GET. Refresh when this tab regains focus.
        if (global.setTimeout) global.setTimeout(refresh, 1500);
      });
      actions.appendChild(link);
      if (changed) say('The article or site details changed since preview. Prepare again.');
      else if (candidate.descant_commit) {
        say(candidate.deployment === 'command succeeded' ? 'Site commit saved. Deployment command succeeded. Check the live page.' : 'Site commit saved. Deployment: ' + candidate.deployment + '.');
        var live = el('a', 'Open site page'); live.href = candidate.url; live.target = '_blank'; live.rel = 'noopener'; actions.appendChild(live);
      } else say(candidate.viewed ? 'Prepared. Review the changes, then publish this version.' : 'Prepared. Open the private preview before publishing.');
      if (!changed && candidate.viewed && (!candidate.descant_commit || candidate.deployment !== 'command succeeded')) actions.appendChild(button(candidate.site_commit ? 'Retry Publish' : 'Publish', confirmPublish));
    } else say(configured ? (existing ? 'A page already exists at this URL. Review it as a correction.' : 'Draft. Not public.') : 'Publication is not set up yet.');
    var label = changed ? 'Prepare again' : candidate && candidate.descant_commit ? 'Prepare correction' : 'Prepare publication';
    var prepareButton = button(label, prepare); prepareButton.disabled = !configured; actions.appendChild(prepareButton);
  }
  function refresh() {
    var captured = epoch;
    if (!path || !founder()) return Promise.resolve();
    return request('/api/publication?path=' + encodeURIComponent(path)).then(function (data) {
      if (captured !== epoch || !card) return;
      configured = data.configured; existing = !!data.site_existing;
      card.hidden = !configured;
      if (data.id) candidate = data;
      changed = changed || !!data.changed;
      controls();
    }).catch(function (error) { if (captured === epoch) say(error.message); });
  }
  function prepare() {
    var captured = epoch, capturedRevision = revision, article = path, who = founder();
    if (!who || busy) return Promise.resolve();
    if (!summary.value.trim()) { fields.open = true; say('Write a public summary in Site details first.'); if (summary.focus) summary.focus(); return Promise.resolve(); }
    var metadata = {summary:summary.value, chip:chip.value, tags:tags.value.split(',').map(function (v) { return v.trim(); }).filter(Boolean),
      assets:assets.value.split('\n').map(function (v) { return v.trim(); }).filter(Boolean), replace:replace.checked};
    busy = true; controls();
    return C.saver.flush().then(function () {
      if (captured !== epoch || founder() !== who) throw Error('Open this article again to prepare it.');
      if (['saved', 'ready'].indexOf(C.saver.state()) < 0) throw Error('Save the article before preparing publication.');
      return request('/api/piece?path=' + encodeURIComponent(article));
    }).then(function (data) {
      var latest = data.versions && data.versions[data.versions.length - 1];
      if (!latest || latest.markdown !== C.app.source) throw Error('The saved article differs from this page. Save or reload it first.');
      return request('/api/publication?path=' + encodeURIComponent(article));
    }).then(function (data) {
      if (captured !== epoch || founder() !== who) throw Error('Open this article again to prepare it.');
      return request('/api/publication/prepare', {path:article, who:who, source:data.current_source, metadata:metadata});
    }).then(function (data) {
      if (captured !== epoch) return;
      candidate = data; changed = revision !== capturedRevision;
    }).catch(function (error) { if (captured === epoch) { say(error.message); card._error = error.message; } })
      .finally(function () { if (captured === epoch) { busy = false; controls(); if (card._error) { say(card._error); card._error = ''; } } });
  }
  function confirmPublish() {
    if (!candidate || changed || busy || !founder()) return;
    closeDialog();
    var release = candidate, who = founder(), captured = epoch;
    dialog = el('dialog'); dialog.className = 'publication-confirm'; dialog.setAttribute('aria-labelledby', 'publication-confirm-title');
    var title = el('h2', 'Publish this version?'); title.id = 'publication-confirm-title'; dialog.appendChild(title);
    dialog.appendChild(el('p', 'The private preview will be sent to ' + (release.site_name || 'the site') + '. This confirms the owner has agreed and this is the current canonical copy.'));
    dialog.appendChild(el('p', release.title));
    if (release.created) dialog.appendChild(el('p', 'Prepared: ' + new Date(release.created).toLocaleString()));
    var keyLabel = el('label', 'Publication key'), key = el('input');
    key.type = 'password'; key.autocomplete = 'off'; key.setAttribute('aria-label', 'Publication key');
    keyLabel.appendChild(key); dialog.appendChild(keyLabel);
    dialog.appendChild(button('Cancel', closeDialog));
    dialog.appendChild(button('Publish', function () {
      if (captured !== epoch || founder() !== who || changed || release !== candidate) { closeDialog(); return; }
      if (!key.value.trim()) { key.focus(); return; }
      var entered = key.value.trim(); key.value = '';
      closeDialog(); busy = true; controls(); say('Publishing the reviewed version.');
      return request('/api/publication/approve', {id:release.id, path:path, who:who, key:entered})
        .then(function (approval) {
          if (captured !== epoch || founder() !== who || changed || release !== candidate) throw Error('Open this article again to approve it.');
          return request('/api/publication/publish', {id:release.id, path:path, who:who, confirm:true, approval:approval.approval});
        })
        .then(function (data) { if (captured === epoch) { candidate = data; return C.app.reload && C.app.reload(); } })
        .catch(function (error) { if (captured === epoch) card._error = error.message; })
        .finally(function () { if (captured === epoch) { busy = false; controls(); if (card._error) { say(card._error); card._error = ''; } } });
    }));
    D.body.appendChild(dialog); dialog.showModal();
  }
  function mount(context) {
    ctx = context;
    if (!bound) {
      bound = true;
      ctx.bus.on('doc:change', function () { revision++; if (candidate) { changed = true; closeDialog(); controls(); } });
      ctx.bus.on('who:set', function () { if (ctx) mount(ctx); });
      if (global.addEventListener) global.addEventListener('focus', refresh);
    }
    epoch++; closeDialog();
    if (card) card.remove(); card = null; candidate = null; busy = false; changed = false;
    path = current();
    if (!/^articles\/[^/]+\/article\.md$/.test(path) || !founder() || !/^https?:$/.test(global.location.protocol)) return;
    card = el('section'); card.className = 'publication-card'; card.setAttribute('aria-label', 'Publication');
    card.hidden = true;
    card.appendChild(el('h2', 'Publication'));
    fields = el('details'); fields.className = 'publication-fields'; fields.appendChild(el('summary', 'Site details')); card.appendChild(fields);
    summary = field('Public summary', 'textarea'); summary.rows = 3; summary.maxLength = 2000;
    chip = field("Chip's act", 'select');
    ['wave','slap','pet','heart','skunk'].forEach(function (value) { var option = el('option', value.charAt(0).toUpperCase() + value.slice(1)); option.value = value; chip.appendChild(option); });
    tags = field('Tags, separated by commas');
    assets = field('Images to make public, one file path per line', 'textarea'); assets.rows = 2;
    assets.placeholder = 'images/diagram.png';
    replace = field('Replace an existing page at this URL'); replace.type = 'checkbox';
    message = el('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); card.appendChild(message);
    actions = el('div'); actions.className = 'publication-actions'; card.appendChild(actions);
    context.article.parentNode.appendChild(card);
    var captured = epoch;
    request('/api/publication?path=' + encodeURIComponent(path)).then(function (data) {
      if (captured !== epoch) return;
      configured = data.configured; existing = !!data.site_existing; candidate = data.id ? data : null; changed = !!data.changed; fill(data); controls();
      card.hidden = !configured;
    }).catch(function (error) { if (captured === epoch) say(error.message); });

  }
  C.publication = {mount:mount};
})(typeof window !== 'undefined' ? window : globalThis);
