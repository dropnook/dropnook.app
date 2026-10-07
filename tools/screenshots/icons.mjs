// The app icons in static/, drawn from static/icon.svg:
//   node tools/screenshots/icons.mjs   (Playwright with Chromium, PWPATH = its module)
// icon-192/512: the rounded icon as it is. apple-touch-icon (180) and
// icon-maskable-512: square to the edges — iOS and Android cut their own shape,
// so the drop sits smaller in the middle (the safe zone of a maskable icon).
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const STATIC = fileURLToPath(new URL('../../static/', import.meta.url));
const svg = readFileSync(STATIC + 'icon.svg', 'utf8');
const inner = svg.slice(svg.indexOf('<defs>'), svg.lastIndexOf('</svg>'));
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${inner
  .replace(/<rect [^>]*\/>/, '<rect width="256" height="256" fill="url(#bg)"/>')
  .replace(/(<path [^>]*\/>\s*<path [^>]*\/>)/, `<g transform="translate(128 128) scale(${scale}) translate(-128 -134)">$1</g>`)}</svg>`;
const out = [
  ['icon-192.png', 192, svg], ['icon-512.png', 512, svg],
  ['apple-touch-icon.png', 180, square(0.92)], ['icon-maskable-512.png', 512, square(0.78)],
];
const browser = await pw.chromium.launch();
const page = await browser.newPage();
for (const [name, size, markup] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`);
  await page.screenshot({ path: STATIC + name, omitBackground: true });
  console.log('static/' + name);
}
await browser.close();
