// Architecture diagram for the README — who reaches what — in light/dark, en/de:
//   node diagram.mjs   → $WORK/diagram/architecture-<lang>-<scheme>.png
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const OUT = `${WORK}/diagram`;
mkdirSync(OUT, { recursive: true });
const ICONS = fileURLToPath(new URL('../../.github/icons', import.meta.url));
const W = 1600, H = 740;

const T = {
  en: {
    lan: 'Your network', unraid: 'Unraid', net: 'Internet',
    devices: 'Computers and phones', devicesSub: 'at home or via VPN',
    dropSub: '&lt;drop-IP&gt; · HTTPS 443', dropText: 'Drop itself —<br>files, texts, shares',
    shareSub: '&lt;share-IP&gt; · HTTP 80', shareText: 'share links only —<br>no root, read-only',
    store: 'Unraid share <b>drop</b>', files: 'uploads', texts: 'text fields', shares: 'what is shared',
    certs: 'certificates · read-only',
    who: 'Anyone with a link', whoSub: 'anywhere on the internet',
    proxy: 'Your reverse proxy', proxySub: 'HTTPS 443 · your certificate', blackbox: 'yours to run',
    aLan: 'drop.yourdomain.com', aNet: 'drop-share.yourdomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80',
    aRW: 'reads &amp; writes everything', aRO: 'reads shares/ only',
    refused: 'refused — nothing reaches drop through the proxy',
  },
  de: {
    lan: 'Dein Netzwerk', unraid: 'Unraid', net: 'Internet',
    devices: 'Computer und Handys', devicesSub: 'zu Hause oder per VPN',
    dropSub: '&lt;drop-IP&gt; · HTTPS 443', dropText: 'Drop selbst —<br>Dateien, Texte, Freigaben',
    shareSub: '&lt;share-IP&gt; · HTTP 80', shareText: 'nur Freigabe-Links —<br>ohne root, nur lesend',
    store: 'Unraid-Share <b>drop</b>', files: 'Uploads', texts: 'Textfelder', shares: 'was geteilt ist',
    certs: 'Zertifikate · nur lesend',
    who: 'Alle mit einem Link', whoSub: 'irgendwo im Internet',
    proxy: 'Dein Reverse Proxy', proxySub: 'HTTPS 443 · dein Zertifikat', blackbox: 'betreibst du',
    aLan: 'drop.deinedomain.com', aNet: 'drop-share.deinedomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80',
    aRW: 'liest &amp; schreibt alles', aRO: 'liest nur shares/',
    refused: 'abgewiesen — über den Proxy kommt nichts an drop',
  },
};
const C = {
  light: { bg: '#F4F7F8', ink: '#121B21', muted: '#4A5B65', line: '#B9C7CE', card: '#FFFFFF', cardLine: '#D6DFE3',
           lan: '#0B6E75', lanSoft: 'rgba(11,110,117,.07)', pub: '#B45309', pubSoft: 'rgba(180,83,9,.07)',
           box: 'rgba(18,27,33,.035)', red: '#B42318', shadow: '0 10px 30px -18px rgba(18,27,33,.45)' },
  dark:  { bg: '#0A1013', ink: '#E3EBEF', muted: '#97A8B2', line: '#46585F', card: '#141C21', cardLine: '#26333A',
           lan: '#54C0C4', lanSoft: 'rgba(84,192,196,.08)', pub: '#F0A54A', pubSoft: 'rgba(240,165,74,.08)',
           box: 'rgba(255,255,255,.03)', red: '#F07B6E', shadow: '0 10px 30px -18px rgba(0,0,0,.9)' },
};

const laptop = (c) => `<svg width="66" height="46" viewBox="0 0 66 46" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"><rect x="9" y="3" width="48" height="32" rx="3"/><path d="M2 41h62l-4 3H6z"/></svg>`;
const phoneIcon = (c) => `<svg width="30" height="48" viewBox="0 0 30 48" fill="none" stroke="${c}" stroke-width="3"><rect x="2" y="2" width="26" height="44" rx="5"/><path d="M11 39h8" stroke-linecap="round"/></svg>`;
const globe = (c) => `<svg width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="${c}" stroke-width="3"><circle cx="23" cy="23" r="20"/><ellipse cx="23" cy="23" rx="9" ry="20"/><path d="M3 23h40M6 13h34M6 33h34"/></svg>`;
const shield = (c) => `<svg width="40" height="46" viewBox="0 0 40 46" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"><path d="M20 3l15 6v12c0 11-7 18-15 22C12 39 5 32 5 21V9z"/><rect x="13" y="20" width="14" height="11" rx="2"/><path d="M16 20v-3a4 4 0 0 1 8 0v3"/></svg>`;

function page(t, c) {
  const pill = (x, y, w, txt, color, mono) => `<div class="pill${mono ? ' mono' : ''}" style="left:${x - w / 2}px;top:${y}px;width:${w}px;color:${color}">${txt}</div>`;
  const marker = (k) => `<marker id="a-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${k === 'muted' ? c.muted : c[k]}"/></marker>`;
  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0}
  body{width:${W}px;height:${H}px;background:${c.bg};color:${c.ink};position:relative;overflow:hidden;font-family:Inter,"Noto Sans",sans-serif}
  .zone{position:absolute;border-radius:22px;padding:14px 22px}
  .zone > .label{font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
  .card{position:absolute;background:${c.card};border:1.5px solid ${c.cardLine};border-radius:16px;box-shadow:${c.shadow};padding:16px 18px}
  .card h3{margin:0;font-size:24px;font-weight:750;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
  .card h3 img{width:34px;height:34px;border-radius:9px}
  .sub{font-size:15px;color:${c.muted};margin-top:4px}
  .text{font-size:16px;margin-top:10px;line-height:1.35}
  .chip{position:absolute;border-radius:12px;padding:9px 14px;border:1.5px solid ${c.cardLine};background:${c.card}}
  .chip code{font:600 18px/1.2 "DejaVu Sans Mono",monospace}
  .chip span{display:block;font-size:14px;color:${c.muted};margin-top:3px}
  .lbl{position:absolute;font-size:14.5px;color:${c.muted};white-space:nowrap}
  .pill{position:absolute;text-align:center;font-size:14px;background:${c.bg};border-radius:8px;padding:2px 6px;z-index:3;white-space:nowrap}
  .pill.mono{font-family:"DejaVu Sans Mono",monospace;font-size:13px}
  svg.wires{position:absolute;inset:0;z-index:2}
  </style>
  <div class="zone" style="left:28px;top:30px;width:300px;height:680px;background:${c.lanSoft};border:1.5px solid ${c.lan}55"><div class="label" style="color:${c.lan}">${t.lan}</div></div>
  <div class="zone" style="left:360px;top:30px;width:800px;height:680px;background:${c.box};border:1.5px solid ${c.line}"><div class="label" style="color:${c.muted}">${t.unraid}</div></div>
  <div class="zone" style="left:1192px;top:30px;width:380px;height:680px;background:${c.pubSoft};border:1.5px solid ${c.pub}55"><div class="label" style="color:${c.pub}">${t.net}</div></div>

  <div class="card" style="left:52px;top:222px;width:200px;height:156px;text-align:center;padding:16px 10px">
    <div style="display:flex;justify-content:center;align-items:flex-end;gap:12px">${laptop(c.lan)}${phoneIcon(c.lan)}</div>
    <div style="font-weight:700;font-size:17px;margin-top:10px">${t.devices}</div><div class="sub">${t.devicesSub}</div></div>

  <div class="chip" style="left:400px;top:76px;width:320px;text-align:center"><span style="margin:0;font-size:15px">🔒 ${t.certs}</span></div>
  <div class="card" style="left:400px;top:205px;width:320px;height:180px;border-color:${c.lan}">
    <h3><img src="file://${ICONS}/drop.png">drop</h3><div class="sub">${t.dropSub}</div><div class="text">${t.dropText}</div></div>
  <div class="card" style="left:810px;top:205px;width:320px;height:180px;border-color:${c.pub}">
    <h3><img src="file://${ICONS}/drop-share.png">drop-share</h3><div class="sub">${t.shareSub}</div><div class="text">${t.shareText}</div></div>

  <div class="card" style="left:400px;top:540px;width:730px;height:140px"><div style="font-size:19px">${t.store}</div></div>
  <div class="chip" style="left:430px;top:592px;width:200px"><code>files/</code><span>${t.files}</span></div>
  <div class="chip" style="left:650px;top:592px;width:200px"><code>texts/</code><span>${t.texts}</span></div>
  <div class="chip" style="left:870px;top:592px;width:230px;border-color:${c.pub}"><code>shares/</code><span>${t.shares}</span></div>

  <div class="card" style="left:1232px;top:76px;width:300px;height:112px;text-align:center;padding:12px">
    ${globe(c.pub)}<div style="font-weight:700;font-size:17px;margin-top:4px">${t.who}</div><div class="sub" style="margin-top:0">${t.whoSub}</div></div>
  <div class="card" style="left:1232px;top:268px;width:300px;height:132px;text-align:center;border-style:dashed;border-color:${c.line};background:${c.bg};box-shadow:none;padding:12px">
    ${shield(c.muted)}<div style="font-weight:700;font-size:17px;margin-top:4px">${t.proxy}</div><div class="sub" style="margin-top:1px">${t.proxySub}</div>
    <div class="sub" style="font-style:italic;font-size:13.5px;margin-top:1px">${t.blackbox}</div></div>

  <svg class="wires" width="${W}" height="${H}">
    <defs>${['lan', 'pub', 'muted', 'red'].map(marker).join('')}</defs>
    <path d="M252 300 H392" stroke="${c.lan}" stroke-width="3" fill="none" marker-end="url(#a-lan)"/>
    <path d="M560 118 V197" stroke="${c.muted}" stroke-width="2.5" stroke-dasharray="6 5" fill="none" marker-end="url(#a-muted)"/>
    <path d="M1382 188 V260" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M1232 330 H1138" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M515 385 V532" stroke="${c.lan}" stroke-width="3" fill="none" marker-start="url(#a-lan)" marker-end="url(#a-lan)"/>
    <path d="M1080 592 V393" stroke="${c.pub}" stroke-width="3" stroke-dasharray="7 6" fill="none" marker-end="url(#a-pub)"/>
    <path d="M1300 400 V455 H660 V393" stroke="${c.red}" stroke-width="2.5" stroke-dasharray="4 6" fill="none" marker-end="url(#a-red)"/>
    <g transform="translate(1160 455)"><circle r="14" fill="${c.bg}" stroke="${c.red}" stroke-width="2.5"/><path d="M-5.5 -5.5L5.5 5.5M5.5 -5.5L-5.5 5.5" stroke="${c.red}" stroke-width="3" stroke-linecap="round"/></g>
  </svg>

  ${pill(322, 270, 170, t.aLan, c.lan, true)}
  ${pill(1382, 212, 330, t.aNet, c.pub, true)}
  ${pill(1185, 302, 92, t.aProxy, c.pub)}
  <div class="lbl" style="left:528px;top:500px">${t.aRW}</div>
  <div class="lbl" style="left:870px;top:510px;width:198px;text-align:right;color:${c.pub}">${t.aRO}</div>
  <div class="lbl" style="left:676px;top:463px;color:${c.red}">${t.refused}</div>
  `;
}

const browser = await pw.chromium.launch();
for (const lang of ['en', 'de']) for (const scheme of ['light', 'dark']) {
  const file = `${OUT}/architecture-${lang}-${scheme}.html`;
  writeFileSync(file, page(T[lang], C[scheme]));
  const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
  await p.goto('file://' + file); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/architecture-${lang}-${scheme}.png` });
  await p.close();
}
await browser.close();
console.log('diagram in', OUT);
