/* people.js — the writers of this installation.
 *
 * build.py embeds them from people.json in the page's #castor-data block, as
 * [{id, name, color}]. A page with no writers listed has none. The key rule is
 * space_config.WRITER_KEY (one rule with the comment service's writers.ts).
 * Every module asks Castor.people instead of spelling out the keys.
 */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {};
  var KEY = /^[a-z][a-z0-9-]{0,23}$/;
  var RESERVED = ['both', 'unassigned'];          /* owner values, never a writer */
  var listed = [];
  try {
    var tag = global.document && global.document.getElementById('castor-data');
    var data = tag ? JSON.parse(tag.textContent || '{}') : {};
    listed = (Array.isArray(data.people) ? data.people : []).filter(function (p) {
      return p && typeof p.id === 'string' && KEY.test(p.id) && RESERVED.indexOf(p.id) < 0 && p.kind !== 'agent' && typeof p.name === 'string' && p.name.trim();
    });
  } catch (e) { listed = []; }

  var names = Object.create(null), shorts = Object.create(null), ids = [];
  listed.forEach(function (p) {
    if (names[p.id]) return;
    var first = p.name.trim().split(/\s+/)[0];
    ids.push(p.id);
    names[p.id] = first;
    shorts[p.id] = first.charAt(0).toUpperCase() + first.charAt(1).toLowerCase();
  });

  Castor.people = {
    ids: function () { return ids.slice(); },
    isWriter: function (id) { return typeof id === 'string' && ids.indexOf(id) >= 0; },
    name: function (id) { return names[id] || ''; },
    short: function (id) { return shorts[id] || ''; },
    names: function () { var out = Object.create(null); ids.forEach(function (id) { out[id] = names[id]; }); return out; },
    shorts: function () { var out = Object.create(null); ids.forEach(function (id) { out[id] = shorts[id]; }); return out; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
