// Light, dark or automatic (as the system), chosen per browser with the button
// in the header — and, without users, the colour layout. Loaded in <head>,
// before the page is drawn, so it never shows in the wrong colours first. With
// users the server has already set the user's colour on <html>.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem('drop.theme');
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  const palette = localStorage.getItem('drop.palette');
  if (!('user' in root.dataset) && /^(gold|blue|violet|coral)$/.test(palette || '')) root.dataset.palette = palette;
} catch (e) { /* storage blocked — automatic and teal it is */ }
