// Content slides in gently as it scrolls into view. Only what is still below
// the window when the page loads — nothing above jumps. Without JavaScript, or
// with reduced motion asked for, everything simply stands there.
document.addEventListener('DOMContentLoaded', () => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const items = [...document.querySelectorAll(
    'main section h2, main section .sub, .why, .card, .compare, .shots > a, .diagram, .checks li, .steps li, #faq details')]
    .filter((el) => el.getBoundingClientRect().top > innerHeight);
  const io = new IntersectionObserver((entries) => {
    entries.filter((e) => e.isIntersecting).forEach((entry, i) => {
      io.unobserve(entry.target);
      setTimeout(() => entry.target.classList.add('is-in'), Math.min(i * 70, 280));
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  items.forEach((el) => { el.classList.add('reveal'); io.observe(el); });
});
