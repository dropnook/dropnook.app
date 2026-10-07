// The light/dark slider on dropnook.app: drag it, click anywhere, or use the arrow keys.
for (const box of document.querySelectorAll('.compare')) {
  const input = box.querySelector('input');
  input.hidden = false;
  let touched = false;
  const set = (v) => {
    v = Math.min(100, Math.max(0, v));
    box.style.setProperty('--pos', v + '%');
    input.value = Math.round(v);
  };
  const follow = (e) => {
    const r = box.getBoundingClientRect();
    set((e.clientX - r.left) / r.width * 100);
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    touched = true;
    box.setPointerCapture(e.pointerId);
    // A finger may only want to scroll the page: it moves the slider once it moves sideways.
    if (e.pointerType !== 'touch') follow(e);
  });
  box.addEventListener('pointermove', (e) => { if (box.hasPointerCapture(e.pointerId)) follow(e); });
  input.addEventListener('input', () => { touched = true; set(+input.value); });

  // Once, when it comes into view: a small swing, so it is clear that it moves.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      const start = performance.now();
      const step = (now) => {
        const t = (now - start) / 1600;
        if (touched || t >= 1) { if (!touched) set(50); return; }
        set(50 - 14 * Math.sin(t * 2 * Math.PI) * (1 - t));
        requestAnimationFrame(step);
      };
      setTimeout(() => requestAnimationFrame(step), 400);
    }, { threshold: 0.5 });
    seen.observe(box);
  }
}

// The five colour layouts above the slider: both sides show the page in the colour picked.
const ACCENTS = {        // light: pill, writing on it; dark: the same — as in Drop's style.css
  teal: ['#0B6E75', '#FFFFFF', '#54C0C4', '#08161A'],
  gold: ['#F5A623', '#17130A', '#FFB229', '#000000'],
  blue: ['#2A62C9', '#FFFFFF', '#74A8FF', '#07121F'],
  violet: ['#6D4FC2', '#FFFFFF', '#B39BFF', '#140D24'],
  coral: ['#BF3F59', '#FFFFFF', '#FF8FA0', '#240A10'],
};
for (const group of document.querySelectorAll('.colours')) {
  const box = group.nextElementSibling;
  const [light, dark] = box.querySelectorAll('img');
  const file = (palette, mode) => `${group.dataset.shots}app-${palette === 'teal' ? '' : palette + '-'}${mode}.webp`;
  group.hidden = false;
  group.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const palette = button.dataset.palette;
    light.src = file(palette, 'light');
    dark.src = file(palette, 'dark');
    const [lb, li, db, di] = ACCENTS[palette];
    box.style.setProperty('--lt-bg', lb); box.style.setProperty('--lt-ink', li);
    box.style.setProperty('--dk-bg', db); box.style.setProperty('--dk-ink', di);
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  });
  // Fetched ahead when the pointer comes near, so the switch is instant.
  group.addEventListener('pointerover', (e) => {
    const button = e.target.closest('button');
    if (!button || button.dataset.ready) return;
    button.dataset.ready = '1';
    for (const mode of ['light', 'dark']) new Image().src = file(button.dataset.palette, mode);
  });
}
