/* Where the engine's own server answers. A request built with api() goes under base: /write on
   the writer page (its data says publicWriter), where that server listens, and the root on
   every other page. A host that serves the page from elsewhere (the app) sets
   Castor.endpoints = { base: … } before this script runs, and those requests follow it. */
(function (global) {
  'use strict';
  var Castor = global.Castor = global.Castor || {};
  var preset = Castor.endpoints && typeof Castor.endpoints.base === 'string' ? Castor.endpoints.base : null;
  /* No closing slash here: the writer page's build adds /write before every app path it
     finds in the page, and base already carries it. */
  var API = '/api';
  function writerPage() {
    try {
      var tag = global.document && global.document.getElementById && global.document.getElementById('castor-data');
      return !!tag && JSON.parse(tag.textContent || '{}').publicWriter === true;
    } catch (e) { return false; }
  }
  var endpoints = Castor.endpoints = {
    base: preset !== null ? preset : writerPage() ? '/write' : '',
    /* The address of one of the server's API routes, query included, under base. */
    api: function (path) { return endpoints.base + API + '/' + path; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
