// Blocking classic script: sets the saved theme on <html> before the stylesheet paints, so the dark palette does not flash.
(function () {
  try {
    var theme = localStorage.getItem('zakupy-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (e) { /* no storage: the system palette stays */ }
})();
