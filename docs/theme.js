// Light, dark or automatic (as the system) on dropnook.app: the ☀/☾ switch in the
// header. Loaded in <head>, so a page never shows in the wrong colours first.
// A click picks one; a second click on it goes back to automatic.
(() => {
  const KEY = 'dropnook.theme';
  const SYSTEM = '(prefers-color-scheme: dark)';
  const system = matchMedia(SYSTEM);
  const root = document.documentElement;
  let chosen = null;
  try { chosen = localStorage.getItem(KEY); } catch (e) { /* blocked: automatic */ }
  if (chosen !== 'light' && chosen !== 'dark') chosen = null;
  if (chosen) root.dataset.theme = chosen;

  function apply() {
    if (chosen) root.dataset.theme = chosen; else delete root.dataset.theme;
    // Pictures with a dark variant follow the choice, not only the system.
    const media = chosen === 'dark' ? 'all' : chosen === 'light' ? 'not all' : SYSTEM;
    document.querySelectorAll('source[data-scheme]').forEach((s) => { s.media = media; });
    const group = document.getElementById('theme-switch');
    if (group) {
      const shown = chosen || (system.matches ? 'dark' : 'light');
      group.setAttribute('aria-label', chosen ? group.querySelector(`[data-mode=${chosen}]`).dataset.label : group.dataset.auto);
      group.querySelectorAll('button').forEach((b) => {
        const label = b.dataset.mode === chosen ? `${b.dataset.label} — ${group.dataset.again}` : b.dataset.label;
        b.setAttribute('aria-pressed', String(b.dataset.mode === chosen));
        b.classList.toggle('shown', b.dataset.mode === shown);
        b.title = label;
        b.setAttribute('aria-label', label);
      });
    }
    document.dispatchEvent(new Event('dropnook-theme'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll(`source[media="${SYSTEM}"]`).forEach((s) => { s.dataset.scheme = 'dark'; });
    const group = document.getElementById('theme-switch');
    if (group) {
      group.hidden = false;
      group.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          chosen = b.dataset.mode === chosen ? null : b.dataset.mode;
          try { if (chosen) localStorage.setItem(KEY, chosen); else localStorage.removeItem(KEY); } catch (e) { /* not kept */ }
          apply();
        };
      });
    }
    apply();
  });
  system.addEventListener('change', apply);
})();
