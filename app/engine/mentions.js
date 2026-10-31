/* People mentions are an inbox across articles. Opening it does not mark anything read. */
(function (global) {
  'use strict';
  var C = global.Castor = global.Castor || {}, D = global.document;
  var body, word, page, person = '', rendered = '', mounted = false, epoch = 0, problem = '';
  function node(tag, text) {
    var n = D.createElement(tag);
    if (text) n.textContent = text;
    return n;
  }
  function badge(text) {
    if (word) word.textContent = text;
    var more = D.getElementById('more-word'), count = /\(([^)]+)\)/.exec(text);
    if (more) {
      var text = 'More' + (count ? ' (' + count[1] + ')' : '');
      var label = more.querySelector && more.querySelector('.more-label');
      (label || more).textContent = text;
      more.setAttribute('aria-label', text);
      var indicator = more.querySelector && more.querySelector('.more-count');
      if (indicator) { indicator.textContent = count ? count[1] : ''; indicator.hidden = !count; }
    }
  }
  function isWriter(id) { return !!(C.people && C.people.isWriter(id)); }
  function mentionPattern() {
    if (!C.people || !C.people.ids().length) return /@[\w-]/;
    var words = [];
    C.people.ids().forEach(function (id) { words.push(id, C.people.name(id).toLowerCase()); });
    return new RegExp('@(' + words.filter(Boolean).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\b', 'i');
  }
  function excerpt(text) {
    var at = text.search(mentionPattern()), start = Math.max(0, at - 120);
    return (start ? '...' : '') + text.slice(start, start + 600) + (text.length > start + 600 ? '...' : '');
  }
  function paint() {
    if (problem) {
      badge('For you (?)'); rendered = '';
      if (body) body.textContent = problem;
      return;
    }
    if (!page) {
      badge('For you');
      if (body) body.textContent = person ? 'Loading mentions...' : 'Choose who is writing to see your mentions.';
      return;
    }
    var unread = page.mentions.filter(function (e) { return e.id > page.read; }).length;
    badge('For you' + (unread ? ' (' + unread + ')' : ''));
    if (!body) return;
    var signature = person + JSON.stringify(page);
    if (signature === rendered) return;
    rendered = signature;
    body.textContent = '';
    if (C.role && C.role.publicWriter && C.agentTray) {
      body.appendChild(node('p', 'Ask @agent in a saved comment for evidence and a counter-case. The reply appears in that thread. The agent never writes your article.'));
      var agent = node('button', 'Enable agent tray'); agent.type = 'button';
      agent.addEventListener('click', function () { C.agentTray.setEnabled(true); agent.textContent = 'Agent tray enabled. Add comments to collect notes.'; });
      body.appendChild(agent);
    }
    if (!page.mentions.length) { body.appendChild(node('p', 'No mentions yet.')); return; }
    if (unread) {
      var read = node('button', 'Mark all read');
      read.type = 'button';
      read.addEventListener('click', function () {
        var who = person, cursor = page.cursor, request = epoch;
        read.disabled = true;
        return global.fetch('/api/mentions/read', {method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify({who:who,cursor:cursor})})
          .then(function (r) { if (!r.ok) throw Error('read refused'); return r.json(); })
          .then(function () { if (request === epoch) return refresh(); })
          .catch(function () { if (request !== epoch) return; read.disabled = false; read.textContent = 'Could not mark read. Try again.'; });
      });
      body.appendChild(read);
    }
    var list = node('ol'); body.appendChild(list);
    page.mentions.slice().reverse().forEach(function (e) {
      var item = node('li'), link = node('a', e.author + ' in ' + e.path.split('/')[1].replace(/^\d+-/, '').replace(/-/g, ' '));
      link.href = '?live=' + encodeURIComponent(e.path) + '&thread=' + encodeURIComponent(e.thread);
      item.appendChild(link);
      if (e.id > page.read) item.appendChild(node('span', ' · Unread'));
      item.appendChild(node('p', excerpt(e.text)));
      list.appendChild(item);
    });
  }
  function refresh() {
    var who = C.who && C.who.get(), request = ++epoch;
    if (who !== person) { person = who; page = null; rendered = ''; problem = ''; if (body) body.textContent = ''; badge('For you'); }
    if (!isWriter(who)) {
      if (body) body.textContent = 'Choose who is writing to see your mentions.';
      return Promise.resolve();
    }
    return global.fetch('/api/mentions?who=' + who, {cache:'no-store'})
      .then(function (r) { if (!r.ok) throw Error('mentions unavailable'); return r.json(); })
      .then(function (data) { if (request !== epoch) return; page = data; problem = ''; paint(); })
      .catch(function () {
        if (request !== epoch) return;
        problem = 'Mentions could not load. They will retry when you reconnect.'; paint();
      });
  }
  function mount() {
    if (mounted || (C.role && C.role.reviewer) || !C.app || !C.app.live) return;
    mounted = true;
    word = D.querySelector('[data-panel="for-you"]');
    if (!D.getElementById('castor-mentions-style')) {
      var style = node('style', '.castor-mentions{padding:.8rem;font-size:.9rem}.castor-mentions ol{list-style:none;padding:0;margin:.8rem 0}.castor-mentions li{border-top:1px solid var(--rule);padding:.8rem 0;overflow-wrap:anywhere}.castor-mentions p{white-space:pre-wrap;margin:.4rem 0}.castor-mentions a{color:inherit}.castor-mentions button{font:inherit;color:inherit;background:transparent;border:1px solid var(--rule);padding:.5rem;min-height:44px;cursor:pointer}');
      style.id = 'castor-mentions-style'; D.head.appendChild(style);
    }
    C.panels.register('for-you', {title:'For you',ready:true,mount:function (el) {
      body = el; body.className += ' castor-mentions'; rendered = ''; paint();
    }});
    C.bus.on('who:set', refresh);
    C.bus.on('comments:saved', refresh);
    global.addEventListener('online', refresh);
    global.addEventListener('focus', refresh);
    global.setInterval(function () { if (!D.hidden) refresh(); }, 5000);
    refresh();
  }
  C.mentions = {mount:mount,refresh:refresh};
})(typeof window !== 'undefined' ? window : globalThis);
