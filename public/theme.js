/* Runs before first paint: resolve the saved theme, else the OS preference.
   Kept in its own file so the strict CSP (script-src 'self') permits it. */
(function () {
  try {
    var saved = localStorage.getItem('tabletap_theme');
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : (dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
