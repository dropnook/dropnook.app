// The start page is English. A browser that prefers German goes to /de/ before
// anything is drawn — unless EN or DE was clicked here before, which is kept.
(() => {
  let chosen = null;
  try { chosen = localStorage.getItem('dropnook.lang'); } catch (e) { /* blocked: browser language only */ }
  const german = /^de\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || '');
  const onEnglish = !location.pathname.startsWith('/de/');
  if (onEnglish && (chosen === 'de' || (!chosen && german))) {
    location.replace('/de/' + location.search + location.hash);
    return;
  }
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('.langs a[hreflang]');
    if (link) try { localStorage.setItem('dropnook.lang', link.hreflang); } catch (err) { /* not kept */ }
  });
})();
