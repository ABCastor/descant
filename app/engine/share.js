/* Named-email invitations for the open article. No anonymous or founder links are copied. */
(function (global) {
  'use strict';
  var C = global.Castor || (global.Castor = {}), D = global.document;
  var control, sheet, epoch = 0, bound = false;
  function el(tag, text) { var n = D.createElement(tag); if (text != null) n.textContent = text; return n; }
  function button(text, fn) { var n = el('button', text); n.type = 'button'; n.addEventListener('click', fn); return n; }
  function path() { return C.pieces && C.pieces.current ? C.pieces.current() : ''; }
  function founder() {
    if ((C.role || {}).reviewer || (C.role || {}).role === 'reviewer') return '';
    var session = C.who && C.who.session ? C.who.session() : [];
    var who = session.length ? session[0].id : (C.role || {}).who;
    return C.people && C.people.isWriter(who) ? who : '';
  }
  /* Sharing goes through Castor's hosted reader; a personal installation has none. */
  function personal() { var install = C.app && C.app.data && C.app.data.install; return !!(install && install.kind === 'personal'); }
  function close() { if (sheet) { var old = sheet; sheet = null; old.close(); old.remove(); } }
  function request(article, who, action, fields) {
    return global.fetch('/api/share/article', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.assign({path:article, who:who, action:action}, fields || {}))}).then(function (r) {
        return r.json().then(function (data) { if (!r.ok) throw Error(data.error || 'Sharing could not be loaded. Try again.'); return data; });
      });
  }
  function open() {
    close();
    if (personal()) return;
    var article = path(), who = founder(), held = epoch;
    if (!who || !/^articles\/[^/]+\/article\.md$/.test(article)) return;
    var box = sheet = el('dialog'); box.className = 'descant-publish-sheet descant-share-sheet'; box.setAttribute('aria-label','Share this article');
    box.appendChild(el('h2','Share this article'));
    box.appendChild(el('p', 'Invite someone to read and comment on the saved article. They cannot edit it or see your private notes.'));
    var access = el('section'); access.setAttribute('aria-label','Who has access'); box.appendChild(access);
    var status = el('p','Loading who has access.'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); box.appendChild(status);
    var form = el('form'); form.className = 'descant-share-form'; form.hidden = true; box.appendChild(form);
    var title = el('h3','Add a commenter'); form.appendChild(title);
    function field(label, type) { var row = el('label',label), input = el('input'); input.type = type; input.required = true; row.appendChild(input); form.appendChild(row); return input; }
    var name = field('Name','text'); name.maxLength = 60; name.autocomplete = 'name';
    var email = field('Email','email'); email.maxLength = 254; email.autocomplete = 'email';
    form.appendChild(el('p','The link works once, for 14 days. They must use this email address and enter the code sent to their inbox.'));
    form.appendChild(el('p','Their email must be a verified destination on the reader service before they can receive a code. Ask your agent if it is not.'));
    var make = el('button','Make comment link'); make.type = 'submit'; make.className = 'descant-primary'; form.appendChild(make);
    var links = el('div'); box.appendChild(links);
    var retry = button('Try again',load); retry.hidden = true; box.appendChild(retry);
    box.appendChild(button('Close',close));
    box.addEventListener('close',function () { if (sheet === box) close(); });
    D.body.appendChild(box); box.showModal();
    function current() { return sheet === box && held === epoch && article === path() && who === founder(); }
    function render(data) {
      access.replaceChildren(el('h3','Who has access'));
      var people = data.people || [], invites = data.invitations || [];
      if (!people.length && !invites.length) access.appendChild(el('p','No outside commenters yet.'));
      people.forEach(function (p) { access.appendChild(el('p',p.name + ' (' + p.email + ') · Can comment')); });
      invites.forEach(function (p) { access.appendChild(el('p',p.label + ' (' + p.email + ') · Invitation pending')); });
      if (invites.length) access.appendChild(el('p','Existing invitation links are shown only when made. Make another link below if you did not keep one.'));
      form.hidden = data.mayShare !== true;
      if (!data.mayShare) access.appendChild(el('p','Only the owner can invite someone to this article.'));
    }
    function load() {
      retry.hidden = true;
      return request(article,who,'read').then(function (data) { if (current()) { render(data); status.textContent = ''; } })
        .catch(function (error) { if (current()) { status.textContent = error.message; retry.hidden = false; } });
    }
    form.addEventListener('submit',function (event) {
      event.preventDefault(); if (!current() || make.disabled) return;
      make.disabled = true; name.disabled = email.disabled = true; status.textContent = 'Making a comment link.';
      return request(article,who,'invite',{label:name.value,email:email.value}).then(function (data) {
        if (!current()) return;
        var url;
        try { url = new URL(data.url); } catch (error) { throw Error('The reader connection returned an invalid link.'); }
        if (url.protocol !== 'https:' || !/^\/join\/[A-Za-z0-9_-]{43}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw Error('The reader connection returned an invalid link.');
        links.hidden = false; links.replaceChildren(el('h3','Link for ' + name.value));
        var input = el('input'); input.value = url.href; input.readOnly = true; input.setAttribute('aria-label','Comment link'); links.appendChild(input);
        input.addEventListener('click',function () { input.select(); });
        var copy = button('Copy link',function () {
          if (!current()) return;
          if (!global.navigator.clipboard || !global.navigator.clipboard.writeText) { input.focus(); input.select(); status.textContent = 'Select and copy the link above.'; return; }
          return global.navigator.clipboard.writeText(input.value).then(function () { if (current()) status.textContent = 'Link copied.'; })
            .catch(function () { if (current()) { input.focus(); input.select(); status.textContent = 'Copy was blocked. Select and copy the link above.'; } });
        });
        copy.className = 'descant-primary'; links.appendChild(copy);
        links.appendChild(el('p','They can read and comment on this saved article. They sign in with the invited email address and a code sent to their inbox.'));
        links.appendChild(el('p','Copy it before closing. Send it yourself; making a link sends no email.'));
        links.appendChild(button('Invite another person',function () { form.hidden = false; links.hidden = true; name.value = email.value = ''; status.textContent = ''; name.focus(); }));
        var result = data.warning || 'Comment link ready. Copy it before closing.';
        return load().then(function () { if (current()) { form.hidden = true; status.textContent = result; copy.focus(); } });
      }).catch(function (error) { if (current()) status.textContent = error.message; })
        .finally(function () { if (current()) { make.disabled = false; name.disabled = email.disabled = false; } });
    });
    return load();
  }
  function mount() {
    epoch++; close(); if (control) control.remove(); control = null;
    if (!bound && C.bus && C.bus.on) { bound = true; C.bus.on('who:set',mount); }
    var bar = D.querySelector('#topbar .topwords');
    if (!bar || personal() || !founder() || !/^articles\/[^/]+\/article\.md$/.test(path())) return;
    control = button('Share',open); control.className = 'word descant-share'; control.setAttribute('aria-haspopup','dialog'); control.setAttribute('title','Share this article for comments'); bar.appendChild(control);
  }
  C.share = {mount:mount,open:open};
})(typeof window !== 'undefined' ? window : globalThis);
