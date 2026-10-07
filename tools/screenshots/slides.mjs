// Puts the raw screenshots into browser and phone frames with a caption, one PNG
// per slide and theme:  SET=en|de node slides.mjs   → $WORK/slides-<set>/
import { createRequire } from 'module';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const DE = process.env.SET === 'de';
const SET = DE ? 'de' : 'en';
const OUT = `${WORK}/slides-${SET}`;
mkdirSync(OUT, { recursive: true });
const [, FILE_TOKEN] = readFileSync(`${WORK}/tokens-${SET}`, 'utf8').trim().split(/\s+/);
const X = (en, de) => (DE ? de : en);
const DOMAIN = X('yourdomain.com', 'deinedomain.com');

const W = 1600, H = 1000;
const theme = {
  light: { bg: 'radial-gradient(1200px 700px at 85% 110%, #FCE7D2 0%, rgba(252,231,210,0) 60%), radial-gradient(1100px 800px at 0% 0%, #DCEFF0 0%, rgba(220,239,240,0) 65%), #F4F7F8',
           ink: '#121B21', muted: '#4A5B65', chrome: '#E8EDEF', chromeLine: '#D3DCE0', url: '#FFFFFF', urlInk: '#3E4F59',
           shadow: '0 30px 80px -20px rgba(18,27,33,.35), 0 8px 24px -10px rgba(18,27,33,.18)', bezel: '#1A2329', public: '#B45309' },
  dark:  { bg: 'radial-gradient(1200px 700px at 85% 110%, #3A2410 0%, rgba(58,36,16,0) 60%), radial-gradient(1100px 800px at 0% 0%, #0F3337 0%, rgba(15,51,55,0) 65%), #0A1013',
           ink: '#E3EBEF', muted: '#97A8B2', chrome: '#1B252B', chromeLine: '#26333A', url: '#0F161A', urlInk: '#B6C4CC',
           shadow: '0 30px 80px -20px rgba(0,0,0,.8), 0 8px 24px -10px rgba(0,0,0,.6)', bezel: '#05090B', public: '#F0A54A' },
};

const lock = (c) => `<svg width="12" height="12" viewBox="0 0 24 24" fill="${c}"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4z"/></svg>`;

function browserWindow(t, { img, url, x, y, w, ratio, z = 1, crop = 1, cls = '', style = '' }) {
  const h = Math.round(w / ratio * crop);   // crop < 1 shows only the top of the page
  return `<div class="win ${cls}" style="left:${x}px; top:${y}px; width:${w}px; z-index:${z}; ${style}">
    <div class="bar"><span class="dots"><i style="background:#FF5F57"></i><i style="background:#FEBC2E"></i><i style="background:#28C840"></i></span>
      <span class="url">${lock(t.urlInk)}<span>${url}</span></span></div>
    <img src="${img}" style="width:${w}px; height:${h}px; object-fit:cover; object-position:top">
  </div>`;
}

// The same page light and dark, split in the middle by a (drawn) slider.
const sun = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const moon = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
function compare(light, dark, x, w) {
  const mid = x + w / 2;
  const top = 182, bottom = top + 42 + Math.round(w / 1.6);
  return browserWindow(theme.light, { ...light, cls: 'lt' })
    + browserWindow(theme.dark, { ...dark, cls: 'dk', z: 2, style: `clip-path:inset(-30px -30px -30px ${w / 2}px)` })
    + `<div class="split" style="left:${mid - 2}px; top:${top}px; height:${bottom - top}px"></div>
       <div class="knob" style="left:${mid - 32}px; top:${(top + bottom) / 2 - 32}px"><svg viewBox="0 0 24 24"><path d="M9.5 7 4.5 12l5 5M14.5 7l5 5-5 5"/></svg></div>
       <span class="mode lt" style="right:${1600 - mid + 22}px; top:${top + 62}px">${sun}${X('Light', 'Hell')}</span>
       <span class="mode dk" style="left:${mid + 22}px; top:${top + 62}px">${moon}${X('Dark', 'Dunkel')}</span>`;
}

const STATUS = 46;   // status bar above the page, as on a real phone
function phone(t, { img, x, y, w = 330, z = 2, scheme, bar = 'surface' }) {
  const h = Math.round(w * 2532 / 1170);
  return `<div class="phone" style="left:${x}px; top:${y}px; z-index:${z}">
    <div class="screen" style="width:${w}px; height:${h}px">
      <div class="status ${scheme} ${bar}"><b>9:41</b><span class="icons"><i></i><i></i><i></i><i></i><em></em></span></div>
      <img src="${img}" style="width:${w}px; height:${h - STATUS}px; object-fit:cover; object-position:top">
      <span class="island"></span></div>
  </div>`;
}

function page(t, scheme, title, sub, body) {
  return `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0}
    body{width:${W}px; height:${H}px; overflow:hidden; background:${t.bg}; color:${t.ink};
         font-family:Inter, "Noto Sans", "Noto Sans CJK JP", "Noto Sans Arabic", sans-serif; position:relative}
    .cap{position:absolute; left:120px; right:120px; top:54px; text-align:center}
    h1{margin:0; font-size:46px; line-height:1.1; font-weight:750; letter-spacing:-.02em}
    h1 em{font-style:normal; color:${t.public}}
    p{margin:14px 0 0; font-size:22px; line-height:1.4; color:${t.muted}}
    .win{position:absolute; border-radius:14px; overflow:hidden; box-shadow:${t.shadow}; background:${t.chrome}; outline:1px solid ${t.chromeLine}}
    .bar{height:42px; display:flex; align-items:center; padding:0 16px; border-bottom:1px solid ${t.chromeLine}; position:relative}
    .dots{display:flex; gap:8px} .dots i{width:12px; height:12px; border-radius:50%; display:block}
    .url{position:absolute; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:7px;
         background:${t.url}; color:${t.urlInk}; font-size:13.5px; padding:5px 16px; border-radius:7px; min-width:340px; justify-content:center}
    .win img, .screen img{display:block}
    .phone{position:absolute; padding:13px; border-radius:58px; background:${t.bezel}; box-shadow:${t.shadow};
           outline:1.5px solid ${scheme === 'dark' ? '#2A363D' : '#3B4850'}}
    .screen{border-radius:46px; overflow:hidden; position:relative}
    .status{height:${STATUS}px; display:flex; align-items:center; justify-content:space-between; padding:6px 30px 0 34px; font-size:15px}
    .status.light{background:#FFFFFF; color:#121B21} .status.dark{background:#141C21; color:#E3EBEF}
    .status.light.page{background:#F2F5F6} .status.dark.page{background:#0C1216}
    .status .icons{display:flex; align-items:flex-end; gap:2px}
    .status .icons i{display:block; width:3px; background:currentColor; border-radius:1px}
    .status .icons i:nth-child(1){height:4px} .status .icons i:nth-child(2){height:6px}
    .status .icons i:nth-child(3){height:8px} .status .icons i:nth-child(4){height:10px}
    .status .icons em{display:block; width:22px; height:11px; margin-left:7px; border:1.5px solid currentColor; border-radius:3px; position:relative}
    .status .icons em::after{content:""; position:absolute; inset:1.5px 5px 1.5px 1.5px; background:currentColor; border-radius:1px}
    .win.lt{background:${theme.light.chrome}; outline-color:${theme.light.chromeLine}} .win.lt .bar{border-color:${theme.light.chromeLine}}
    .win.lt .url{background:${theme.light.url}; color:${theme.light.urlInk}}
    .win.dk{background:${theme.dark.chrome}; outline-color:${theme.dark.chromeLine}} .win.dk .bar{border-color:${theme.dark.chromeLine}}
    .win.dk .url{background:${theme.dark.url}; color:${theme.dark.urlInk}}
    .split{position:absolute; width:4px; z-index:5; background:#FFFFFF; box-shadow:0 0 0 1px rgba(10,16,19,.18), 0 0 18px rgba(10,16,19,.35)}
    .knob{position:absolute; z-index:6; width:64px; height:64px; border-radius:50%; background:#FFFFFF; display:grid; place-items:center;
          box-shadow:0 0 0 1px rgba(10,16,19,.12), 0 8px 24px rgba(10,16,19,.4)}
    .knob svg{width:34px; height:34px; fill:none; stroke:#121B21; stroke-width:2.2; stroke-linecap:round; stroke-linejoin:round}
    .mode{position:absolute; z-index:6; display:flex; align-items:center; gap:7px; font-size:17px; font-weight:650; padding:7px 14px 7px 11px; border-radius:999px;
          box-shadow:0 4px 14px rgba(10,16,19,.25)}
    .mode svg{width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
    .mode.lt{background:#0B6E75; color:#FFFFFF} .mode.dk{background:#54C0C4; color:#08161A}
    .island{position:absolute; top:11px; left:50%; transform:translateX(-50%); width:100px; height:29px; border-radius:16px; background:#000}
  </style>
  <div class="cap"><h1>${title}</h1><p>${sub}</p></div>
  ${body}`;
}

const raw = (n, scheme) => `${WORK}/raw-${SET}/${n}-${scheme}.png`;
const win = (img, s, more = {}) => ({ img: raw(img, s), url: `drop.${DOMAIN}`, x: 200, y: 182, w: 1200, ratio: 1.6, ...more });
const slides = [
  ['1-overview', X('Text, files and screenshots, live on every device', 'Text, Dateien und Screenshots, live auf jedem Gerät'),
   X('Open <b>drop.&lt;your domain&gt;</b> on any device in your home network or VPN — no app, no login, all see the same.',
     '<b>drop.&lt;deine Domain&gt;</b> auf jedem Gerät im Heimnetz oder per VPN öffnen — ohne App und Login, alle sehen dasselbe.'),
   (t, s) => browserWindow(t, win('overview', s))],
  ['2-share', X('Share to the internet — <em>on your terms</em>', 'Ins Internet teilen — <em>zu deinen Bedingungen</em>'),
   X('From inside your network, share single items to the internet — with expiry, optionally a password.',
     'Aus dem Heimnetz einzelne Inhalte ins Internet teilen — mit Ablaufzeit, auf Wunsch mit Passwort.'),
   (t, s) => browserWindow(t, win('share-dialog', s))],
  ['3-shares', X('Always clear <em>what is public</em>', 'Immer klar, <em>was öffentlich ist</em>'),
   X('In Drop, everything reachable from the internet is marked orange — one click ends the link.',
     'In Drop ist alles, was im Internet abrufbar ist, orange markiert — ein Klick beendet den Link.'),
   (t, s) => browserWindow(t, win('shares', s))],
  ['4-public', X('What the recipient sees', 'Was der Empfänger sieht'),
   X('Anyone with the link, anywhere — but only that one item, served by a separate, locked-down container.',
     'Wer den Link hat, von überall — aber nur dieser eine Inhalt, aus einem eigenen, abgeschotteten Container.'),
   (t, s) => browserWindow(t, { img: raw('public-file', s), url: `drop-share.${DOMAIN}/${FILE_TOKEN}`, x: 150, y: 300, w: 1000, ratio: 1100 / 640, crop: 0.62 })
           + phone(t, { img: raw('public-text-phone', s), x: 1080, y: 200, w: 330, scheme: s, bar: 'page' })],
  ['5-phone', X('Made for the phone, too', 'Auch fürs Handy gemacht'),
   X('On your home Wi-Fi or VPN: drop from the phone, pick up on the computer — or the other way round.',
     'Im WLAN zu Hause oder per VPN: vom Handy ablegen, am Computer abholen — oder umgekehrt.'),
   (t, s) => phone(t, { img: raw('phone', s), x: 415, y: 205, w: 330, scheme: s })
           + phone(t, { img: raw('phone-files', s), x: 830, y: 205, w: 330, scheme: s, bar: 'page' })],
  ['6-languages', X('Speaks <em>17 languages</em>', 'Spricht <em>17 Sprachen</em>'),
   X('Picked from the browser automatically: English, Deutsch, Español, Français, 日本語, 中文, العربية, Русский, Türkçe …',
     'Automatisch nach dem Browser: Deutsch, English, Español, Français, 日本語, 中文, العربية, Русский, Türkçe …'),
   (t, s) => browserWindow(t, win(DE ? 'lang-en' : 'lang-de', s, { x: 110, y: 205, w: 860, z: 1 }))
           + browserWindow(t, win('lang-ja', s, { x: 370, y: 285, w: 860, z: 2 }))
           + browserWindow(t, win('lang-ar', s, { x: 630, y: 365, w: 860, z: 3 }))],
  ['7-theme', X('Light or dark — <em>as you like</em>', 'Hell oder dunkel — <em>wie du magst</em>'),
   X('Drop follows the system — or switches with one click. Each browser remembers its choice.',
     'Drop folgt dem System — oder wechselt mit einem Klick. Jeder Browser merkt sich seine Wahl.'),
   () => compare(win('overview', 'light'), win('overview', 'dark'), 200, 1200)],
];

const browser = await pw.chromium.launch();
for (const scheme of ['light', 'dark']) {
  const t = theme[scheme];
  for (const [name, title, sub, body] of slides) {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) continue;
    const file = `${OUT}/${name}-${scheme}.html`;
    writeFileSync(file, page(t, scheme, title, sub, body(t, scheme)));
    const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
    await p.goto('file://' + file);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${OUT}/${name}-${scheme}.png` });
    await p.close();
  }
}
await browser.close();
console.log('slides in', OUT);
