// The social preview card (GitHub "Social preview", og:image of dropnook.app):
//   node social.mjs   → docs/social-preview.png, 1280×640 (SCHEME=light for the light one)
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SCHEME = process.env.SCHEME === 'light' ? 'light' : 'dark';
const title = readFileSync(`${REPO}docs/title-${SCHEME}.svg`, 'utf8');
const shot = `file://${WORK}/raw-en/overview-${SCHEME}.png`;
const c = SCHEME === 'dark'
  ? { ink: '#E3EBEF', muted: '#97A8B2', chip: '#141C21', chipLine: '#26333A', chipInk: '#B6C4CC',
      pub: '#F0A54A', pubLine: '#6B4417', pubBg: '#2A1C0D', chrome: '#1B252B', line: '#26333A',
      bg: 'radial-gradient(900px 600px at 100% 110%, #3A2410 0%, rgba(58,36,16,0) 60%), radial-gradient(900px 700px at 0% 0%, #0F3337 0%, rgba(15,51,55,0) 65%), #0A1013',
      shadow: '0 30px 80px -20px rgba(0,0,0,.8), 0 8px 24px -10px rgba(0,0,0,.6)' }
  : { ink: '#121B21', muted: '#4A5B65', chip: '#FFFFFF', chipLine: '#D3DCE0', chipInk: '#3E4F59',
      pub: '#B45309', pubLine: '#F3C99A', pubBg: '#FFF6EC', chrome: '#E8EDEF', line: '#D3DCE0',
      bg: 'radial-gradient(900px 600px at 100% 110%, #FCE7D2 0%, rgba(252,231,210,0) 60%), radial-gradient(900px 700px at 0% 0%, #DCEFF0 0%, rgba(220,239,240,0) 65%), #F4F7F8',
      shadow: '0 30px 80px -20px rgba(18,27,33,.35), 0 8px 24px -10px rgba(18,27,33,.18)' };

const html = `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0}
  body{width:1280px; height:640px; overflow:hidden; position:relative; color:${c.ink};
       font-family:Inter, "Noto Sans", sans-serif; background:${c.bg}}
  .text{position:absolute; left:72px; top:92px; width:520px}
  .title svg{height:58px; width:auto; display:block}
  h1{margin:34px 0 0; font-size:44px; line-height:1.12; font-weight:760; letter-spacing:-.02em}
  p{margin:22px 0 0; font-size:23px; line-height:1.45; color:${c.muted}}
  .chips{margin-top:30px; display:flex; flex-wrap:wrap; gap:10px}
  .chips span{font-size:17px; padding:7px 14px; border-radius:99px; background:${c.chip}; border:1px solid ${c.chipLine}; color:${c.chipInk}}
  .chips span.pub{color:${c.pub}; border-color:${c.pubLine}; background:${c.pubBg}}
  .win{position:absolute; left:640px; top:96px; width:900px; border-radius:14px; overflow:hidden;
       background:${c.chrome}; outline:1px solid ${c.line}; box-shadow:${c.shadow}}
  .bar{height:36px; display:flex; align-items:center; gap:7px; padding:0 14px; border-bottom:1px solid ${c.line}}
  .bar i{width:11px; height:11px; border-radius:50%; display:block}
  .win img{display:block; width:900px; height:560px; object-fit:cover; object-position:left top}
</style>
<div class="text">
  <div class="title">${title}</div>
  <h1>Instant sharing for your home network</h1>
  <p>Like AirDrop, but for every device and every system. No cloud, no login — drop it in on one device, and it is there on every other one instantly.</p>
  <div class="chips"><span>instant</span><span>no app</span><span>any browser</span><span class="pub">expiring share links</span></div>
</div>
<div class="win"><div class="bar"><i style="background:#FF5F57"></i><i style="background:#FEBC2E"></i><i style="background:#28C840"></i></div>
  <img src="${shot}"></div>`;

const file = `${WORK}/social.html`;
writeFileSync(file, html);
const browser = await pw.chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await p.goto('file://' + file);
await p.waitForTimeout(300);
await p.screenshot({ path: `${REPO}docs/social-preview.png` });
await browser.close();
console.log('docs/social-preview.png');
