// Takes the raw screenshots from the demo server (setup-demo.sh), light and dark.
//   SET=en|de node capture.mjs        (Playwright with Chromium, PWPATH = its module)
import { createRequire } from 'module';
import { readFileSync, mkdirSync } from 'fs';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const DE = process.env.SET === 'de';
const L = DE
  ? { set: 'de', ips: ['127.0.0.4', '127.0.0.5', '127.0.0.7'], locale: 'de-DE', tz: 'Europe/Berlin',
      file: 'Grundriss', menu: 'Im Internet teilen', random: 'Zufällig', langs: ['en-US', 'ja-JP', 'ar-EG'],
      news: 'Badetücher nicht vergessen 🏖️' }
  : { set: 'en', ips: ['127.0.0.2', '127.0.0.3', '127.0.0.6'], locale: 'en-US', tz: 'Europe/London',
      file: 'Floor plan', menu: 'Share on the internet', random: 'Random', langs: ['de-DE', 'ja-JP', 'ar-EG'],
      news: 'Don’t forget the beach towels 🏖️' };
const PALETTES = ['teal', 'gold', 'blue', 'violet', 'coral'];
const OUT = `${WORK}/raw-${L.set}`;
mkdirSync(OUT, { recursive: true });
const [TEXT_TOKEN, FILE_TOKEN, PASSWORD] = readFileSync(`${WORK}/tokens-${L.set}`, 'utf8').trim().split(/\s+/);
const LAN = 'http://drop.yourdomain.com/';
const SHARE = 'http://drop-share.yourdomain.com/';
const browser = await pw.chromium.launch({
  args: [`--host-resolver-rules=MAP drop.yourdomain.com ${L.ips[0]}, MAP drop-share.yourdomain.com ${L.ips[1]}`],
});
// The demo with users answers under the same name.
const usersBrowser = await pw.chromium.launch({
  args: [`--host-resolver-rules=MAP drop.yourdomain.com ${L.ips[2]}`],
});
// The page uses the system font; on Linux that would be Arial. Inter is close
// to what macOS and Windows show.
const FONT = `body, button, input, select, textarea { font-family: Inter, "Noto Sans", "Noto Sans CJK JP", "Noto Sans Arabic", "Noto Color Emoji", sans-serif !important; font-feature-settings: "cv11", "ss01"; } pre, code, kbd { font-family: "DejaVu Sans Mono", monospace !important; font-size: .92em; }`;
const errors = [];

async function open(url, { locale = L.locale, scheme = 'light', width = 1440, height = 900, scale = 2, mobile = false,
                           palette = '', from = browser } = {}) {
  const ctx = await from.newContext({
    locale, colorScheme: scheme, viewport: { width, height }, deviceScaleFactor: scale,
    isMobile: mobile, hasTouch: mobile, timezoneId: L.tz,
  });
  // The colour layout a browser picked (theme.js reads it before the page is drawn).
  if (palette) await ctx.addInitScript((p) => localStorage.setItem('drop.palette', p), palette);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.addStyleTag({ content: FONT });
  await p.waitForTimeout(1200);
  // Picture previews are made on first request; wait until the visible ones are there.
  await p.waitForFunction(() => [...document.images]
    .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; })
    .every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 })
    .catch(() => errors.push(`previews not loaded: ${url}`));
  return { ctx, p };
}

for (const scheme of ['light', 'dark']) {
  const s = (name) => `${OUT}/${name}-${scheme}.png`;

  let { ctx, p } = await open(LAN, { scheme });
  await p.screenshot({ path: s('overview') });

  await p.click(`.row:has-text("${L.file}") .more`);
  await p.click(`#menu button:has-text("${L.menu}")`);
  await p.waitForTimeout(300);
  await p.click(`#dialog-body button:has-text("${L.random}")`);
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(300);
  await p.screenshot({ path: s('share-dialog') });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);

  await p.click('#btn-shares');
  await p.waitForTimeout(400);
  await p.screenshot({ path: s('shares') });
  await ctx.close();

  ({ ctx, p } = await open(SHARE + FILE_TOKEN, { scheme, width: 1100, height: 640 }));
  await p.fill('input[type=password]', PASSWORD);
  await p.click('button[type=submit], form button');
  await p.waitForTimeout(800);
  await p.addStyleTag({ content: FONT });
  await p.screenshot({ path: s('public-file') });
  await ctx.close();
  ({ ctx, p } = await open(SHARE + TEXT_TOKEN, { scheme, width: 390, height: 844, scale: 3, mobile: true }));
  await p.screenshot({ path: s('public-text-phone') });
  await ctx.close();

  ({ ctx, p } = await open(LAN, { scheme, width: 390, height: 844, scale: 3, mobile: true }));
  await p.screenshot({ path: s('phone') });
  await p.evaluate(() => document.querySelector('#column-files').scrollIntoView());
  await p.waitForTimeout(300);
  await p.screenshot({ path: s('phone-files') });
  await ctx.close();

  for (const locale of L.langs) {
    ({ ctx, p } = await open(LAN, { scheme, locale, width: 1280, height: 800 }));
    await p.screenshot({ path: s(`lang-${locale.slice(0, 2)}`) });
    await ctx.close();
  }
}
// The five colour layouts, light and dark: the whole page and the phone.
for (const scheme of ['light', 'dark']) {
  for (const palette of PALETTES) {
    let { ctx, p } = await open(LAN, { scheme, palette });
    await p.screenshot({ path: `${OUT}/overview-${palette}-${scheme}.png` });
    await ctx.close();
    ({ ctx, p } = await open(LAN, { scheme, palette, width: 390, height: 844, scale: 3, mobile: true }));
    await p.screenshot({ path: `${OUT}/phone-${palette}-${scheme}.png` });
    await ctx.close();
  }
}

// Users: "Who's there?" on the phone, and Tom's own area in his colour, with
// a dot on the shared one — Anna just wrote something there.
async function signIn(p, palette, pin) {
  await p.click(`.u-${palette}`);
  if (pin) {
    await p.fill('input[name=pin]', pin);
    await p.click('button[type=submit]');
  }
  await p.waitForSelector('#areas:not([hidden])');
  await p.addStyleTag({ content: FONT });
  await p.waitForTimeout(1000);
}
for (const scheme of ['light', 'dark']) {
  let { ctx, p } = await open(LAN, { scheme, from: usersBrowser, width: 390, height: 844, scale: 3, mobile: true });
  await p.screenshot({ path: `${OUT}/users-picker-${scheme}.png` });
  await ctx.close();
  ({ ctx, p } = await open(LAN, { scheme, from: usersBrowser }));
  await signIn(p, 'gold', '1357');
  const anna = await open(LAN, { scheme, from: usersBrowser });
  await signIn(anna.p, 'teal', '2468');
  await anna.p.evaluate(async (text) => {
    await fetch('/api/text/2?area=shared', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }) });
  }, L.news);
  await anna.ctx.close();
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/users-own-${scheme}.png` });
  await ctx.close();
}
console.log('errors', errors);
await usersBrowser.close();
await browser.close();
