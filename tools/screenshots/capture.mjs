// Takes the raw screenshots from the demo server (setup-demo.sh), light and dark.
//   SET=en|de node capture.mjs        (Playwright with Chromium, PWPATH = its module)
import { createRequire } from 'module';
import { readFileSync, mkdirSync } from 'fs';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const DE = process.env.SET === 'de';
const L = DE
  ? { set: 'de', ips: ['127.0.0.4', '127.0.0.5'], locale: 'de-DE', tz: 'Europe/Berlin',
      file: 'Grundriss', menu: 'Im Internet teilen', random: 'Zufällig', langs: ['en-US', 'ja-JP', 'ar-EG'] }
  : { set: 'en', ips: ['127.0.0.2', '127.0.0.3'], locale: 'en-US', tz: 'Europe/London',
      file: 'Floor plan', menu: 'Share on the internet', random: 'Random', langs: ['de-DE', 'ja-JP', 'ar-EG'] };
const OUT = `${WORK}/raw-${L.set}`;
mkdirSync(OUT, { recursive: true });
const [TEXT_TOKEN, FILE_TOKEN, PASSWORD] = readFileSync(`${WORK}/tokens-${L.set}`, 'utf8').trim().split(/\s+/);
const LAN = 'http://drop.yourdomain.com/';
const SHARE = 'http://drop-share.yourdomain.com/';
const browser = await pw.chromium.launch({
  args: [`--host-resolver-rules=MAP drop.yourdomain.com ${L.ips[0]}, MAP drop-share.yourdomain.com ${L.ips[1]}`],
});
// The page uses the system font; on Linux that would be Arial. Inter is close
// to what macOS and Windows show.
const FONT = `body, button, input, select, textarea { font-family: Inter, "Noto Sans", "Noto Sans CJK JP", "Noto Sans Arabic", "Noto Color Emoji", sans-serif !important; font-feature-settings: "cv11", "ss01"; } pre, code, kbd { font-family: "DejaVu Sans Mono", monospace !important; font-size: .92em; }`;
const errors = [];

async function open(url, { locale = L.locale, scheme = 'light', width = 1440, height = 900, scale = 2, mobile = false } = {}) {
  const ctx = await browser.newContext({
    locale, colorScheme: scheme, viewport: { width, height }, deviceScaleFactor: scale,
    isMobile: mobile, hasTouch: mobile, timezoneId: L.tz,
  });
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
console.log('errors', errors);
await browser.close();
