/* The theme before the first paint. build.py inlines this into <head>, so a page whose
   stored choice differs from the system's never shows the system's colours first.
   The choice is the one app.js stores (castor.<world>.theme: light, dark or system);
   with none stored the page follows the system. app.js's setTheme repaints the same
   four attributes once it boots and owns them from then on. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var params = new URLSearchParams(window.location.search);
  var logo = params.get('logo'), signature = params.get('signature');
  root.setAttribute('data-logo', /^(?:[1-6]|none)$/.test(logo || '') ? logo : '2');
  if (signature === 'full' || signature === 'small') root.setAttribute('data-signature', signature);
  root.setAttribute('data-underline', params.get('underline') === 'orange' ? 'orange' : 'green');
  var header = params.get('header');
  if (/^(compact|regular|large|quiet)$/.test(header || '')) root.setAttribute('data-header', header);
  if (params.get('controls') === 'quiet') root.setAttribute('data-controls', 'quiet');
  var choice = 'system';
  try { choice = localStorage.getItem('castor.' + (root.getAttribute('data-world') || 'dev') + '.theme') || 'system'; } catch (e) { /* no storage: follow the system */ }
  if (choice !== 'light' && choice !== 'dark') choice = 'system';
  var dark = choice === 'dark' ||
    (choice === 'system' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  root.setAttribute('data-theme-choice', choice);
  root.setAttribute('data-resolved', dark ? 'dark' : 'light');
})();
