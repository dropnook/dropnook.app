// Light, dark or automatic (as the system), chosen per browser with the button
// in the header. Loaded in <head>, before the page is drawn, so it never shows
// in the wrong colours first.
try {
  const theme = localStorage.getItem('drop.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) { /* storage blocked — automatic it is */ }
