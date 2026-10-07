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
