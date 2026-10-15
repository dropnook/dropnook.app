// Architecture diagram for the README and the site — who reaches what over
// which network, how the two containers are walled off, and how a share is a
// hard link — light/dark, en/de:
//   node diagram.mjs   → $WORK/diagram/architecture-<lang>-<scheme>.png
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const OUT = `${WORK}/diagram`;
mkdirSync(OUT, { recursive: true });
const ICONS = fileURLToPath(new URL('../../.github/icons', import.meta.url));
const W = 1600, H = 900;

const T = {
  en: {
    lan: 'Your network', host: 'Unraid · Docker', net: 'Internet',
    devices: 'Computers and phones', devicesSub: 'at home or via VPN',
    dns: 'DNS — at your domain hoster', dnsLan: 'LAN address of drop', dnsPub: 'your public IP',
    dnsNote: 'A private address in public DNS is harmless. Router blocks it? Allow the name in its DNS rebind protection.',
    addr: 'Two separate IP addresses', addrSub: 'like two devices on your network',
    c1: 'container 1', c2: 'container 2 · optional',
    dropSub: '192.168.1.20 · :443 HTTPS',
    dropSpec: [['net', 'your network only'], ['guard', 'proxy headers or public IP → 404'],
               ['sees', 'files/ · texts/ · users/ · shares/'], ['certs', 'read-only · found by itself'],
               ['sign-in', 'PIN or users (optional)']],
    shareSub: '192.168.1.21 · :80 HTTP',
    shareSpec: [['net', 'only through your reverse proxy'], ['serves', 'only /&lt;link&gt; — else 404'],
                ['sees', 'shares/ only, read-only']],
    shareOff: 'SHARING=off — and it is not needed at all',
    wall: 'walled off · shares/ in common',
    store: 'Unraid share <b>drop</b> → /data', storeSub: 'one mount — hard links only work within it',
    onlyDrop: 'drop only', inShares: 'shares/ · drop-share reads only this',
    files: 'shared area', texts: 'text fields', users: 'own areas (users)',
    blob: 'the shared file · same data', record: 'record · name = hash of the link', counters: 'views · all drop-share writes',
    link: '⛓ hard link', noCopy: 'no copy',
    who: 'Anyone with a link', whoSub: 'anywhere on the internet',
    proxy: 'Your reverse proxy', proxySub: 'HTTPS 443 · your certificate', blackbox: 'yours to run',
    token: 'The link', tokenSpec: ['k7m3x-9pq2r · 50 bit random', 'stored only as a hash', '15 min – 30 days, then gone', 'optional password'],
    aNet: 'drop-share.yourdomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80', aLan: 'https://drop.yourdomain.com',
    aRW: 'reads &amp; writes everything', aRO: 'reads shares/ only',
    fw: 'firewall', fwDoor: 'the only door: proxy → drop-share',
  },
  de: {
    lan: 'Dein Netzwerk', host: 'Unraid · Docker', net: 'Internet',
    devices: 'Computer und Handys', devicesSub: 'zu Hause oder per VPN',
    dns: 'DNS — beim Domain-Hoster', dnsLan: 'LAN-Adresse von drop', dnsPub: 'deine öffentliche IP',
    dnsNote: 'Eine private Adresse im öffentlichen DNS schadet nicht. Blockt der Router? Den Namen beim DNS-Rebind-Schutz erlauben.',
    addr: 'Zwei getrennte IP-Adressen', addrSub: 'wie zwei Geräte im Heimnetz',
    c1: 'Container 1', c2: 'Container 2 · optional',
    dropSub: '192.168.1.20 · :443 HTTPS',
    dropSpec: [['netz', 'nur im Heimnetz'], ['schutz', 'Proxy-Header oder öffentliche IP → 404'],
               ['sieht', 'files/ · texts/ · users/ · shares/'], ['certs', 'nur lesend · selbst gefunden'],
               ['login', 'PIN oder Benutzer (optional)']],
    shareSub: '192.168.1.21 · :80 HTTP',
    shareSpec: [['netz', 'nur über deinen Reverse Proxy'], ['liefert', 'nur /&lt;Link&gt; — sonst 404'],
                ['sieht', 'nur shares/, nur lesend']],
    shareOff: 'SHARING=off — dann braucht es ihn gar nicht',
    wall: 'getrennt · gemeinsam nur shares/',
    store: 'Unraid-Share <b>drop</b> → /data', storeSub: 'ein Mount — Hardlinks gehen nur innerhalb',
    onlyDrop: 'nur drop', inShares: 'shares/ · nur das liest drop-share',
    files: 'gemeinsamer Bereich', texts: 'Textfelder', users: 'eigene Bereiche (Benutzer)',
    blob: 'geteilte Datei · dieselben Daten', record: 'Datensatz · Name = Hash des Links', counters: 'Aufrufe · hier schreibt drop-share',
    link: '⛓ Hardlink', noCopy: 'keine Kopie',
    who: 'Alle mit einem Link', whoSub: 'irgendwo im Internet',
    proxy: 'Dein Reverse Proxy', proxySub: 'HTTPS 443 · dein Zertifikat', blackbox: 'betreibst du',
    token: 'Der Link', tokenSpec: ['k7m3x-9pq2r · 50 bit Zufall', 'gespeichert nur als Hash', '15 Min. – 30 Tage, dann weg', 'optional mit Passwort'],
    aNet: 'drop-share.deinedomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80', aLan: 'https://drop.deinedomain.com',
    aRW: 'liest &amp; schreibt alles', aRO: 'liest nur shares/',
    fw: 'Firewall', fwDoor: 'einzige Tür: Proxy → drop-share',
  },
};
const C = {
  light: { bg: '#F4F7F8', ink: '#121B21', muted: '#4A5B65', line: '#B9C7CE', card: '#FFFFFF', cardLine: '#D6DFE3',
           lan: '#0B6E75', lanSoft: 'rgba(11,110,117,.07)', pub: '#B45309', pubSoft: 'rgba(180,83,9,.07)',
           box: 'rgba(18,27,33,.035)', red: '#B42318', code: '#33434C', shadow: '0 10px 30px -18px rgba(18,27,33,.45)' },
  dark:  { bg: '#0A1013', ink: '#E3EBEF', muted: '#97A8B2', line: '#46585F', card: '#141C21', cardLine: '#26333A',
           lan: '#54C0C4', lanSoft: 'rgba(84,192,196,.08)', pub: '#F0A54A', pubSoft: 'rgba(240,165,74,.08)',
           box: 'rgba(255,255,255,.03)', red: '#F07B6E', code: '#C2CFD6', shadow: '0 10px 30px -18px rgba(0,0,0,.9)' },
};

const laptop = (c) => `<svg width="66" height="46" viewBox="0 0 66 46" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"><rect x="9" y="3" width="48" height="32" rx="3"/><path d="M2 41h62l-4 3H6z"/></svg>`;
const phoneIcon = (c) => `<svg width="30" height="48" viewBox="0 0 30 48" fill="none" stroke="${c}" stroke-width="3"><rect x="2" y="2" width="26" height="44" rx="5"/><path d="M11 39h8" stroke-linecap="round"/></svg>`;
const globe = (c) => `<svg width="40" height="40" viewBox="0 0 46 46" fill="none" stroke="${c}" stroke-width="3"><circle cx="23" cy="23" r="20"/><ellipse cx="23" cy="23" rx="9" ry="20"/><path d="M3 23h40M6 13h34M6 33h34"/></svg>`;
const shield = (c) => `<svg width="36" height="40" viewBox="0 0 40 46" fill="none" stroke="${c}" stroke-width="3" stroke-linejoin="round"><path d="M20 3l15 6v12c0 11-7 18-15 22C12 39 5 32 5 21V9z"/><rect x="13" y="20" width="14" height="11" rx="2"/><path d="M16 20v-3a4 4 0 0 1 8 0v3"/></svg>`;

function page(t, c) {
  const pill = (x, y, w, txt, color, mono) => `<div class="pill${mono ? ' mono' : ''}" style="left:${x - w / 2}px;top:${y}px;width:${w}px;color:${color}">${txt}</div>`;
  const marker = (k) => `<marker id="a-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${k === 'muted' ? c.muted : c[k]}"/></marker>`;
  const spec = (rows) => `<dl class="spec">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const chip = (x, y, w, name, sub, color = '') => `<div class="chip" style="left:${x}px;top:${y}px;width:${w}px${color ? `;border-color:${color}` : ''}"><code${color ? ` style="color:${color}"` : ''}>${name}</code><span>${sub}</span></div>`;
  const group = (x, y, w, h, label, color, dashed) => `<div class="group" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:2px ${dashed ? 'dashed' : 'solid'} ${color}"><span class="tag" style="color:${color}">${label}</span></div>`;
  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0}
  body{width:${W}px;height:${H}px;background:${c.bg};color:${c.ink};position:relative;overflow:hidden;font-family:Inter,"Noto Sans",sans-serif}
  .zone{position:absolute;border-radius:22px;padding:14px 22px}
  .zone > .label{font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
  .card{position:absolute;background:${c.card};border:1.5px solid ${c.cardLine};border-radius:16px;box-shadow:${c.shadow};padding:14px 16px}
  .card h4{margin:0;font-size:16px;font-weight:700}
  .sandbox{position:absolute;border-radius:20px;border:2px dashed;padding:30px 18px 14px}
  .sandbox h3{margin:0;font-size:24px;font-weight:750;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
  .sandbox h3 img{width:34px;height:34px;border-radius:9px}
  .tag{position:absolute;top:-12px;left:18px;font:600 13px/1 "DejaVu Sans Mono",monospace;letter-spacing:.06em;
       text-transform:uppercase;background:${c.bg};padding:4px 8px;border-radius:6px}
  .group{position:absolute;border-radius:16px}
  .group .tag{background:${c.card};text-transform:none;letter-spacing:0;font-size:13.5px}
  .sub{font-size:14.5px;color:${c.muted};margin-top:4px}
  .mono{font-family:"DejaVu Sans Mono",monospace}
  .spec{display:grid;grid-template-columns:auto 1fr;gap:7px 12px;margin:16px 0 0;font-size:14px;line-height:1.3}
  .spec dt{font:600 13px/1.4 "DejaVu Sans Mono",monospace;color:${c.muted};text-align:right}
  .spec dd{margin:0;font-size:14.5px;line-height:1.3;color:${c.code}}
  .chip{position:absolute;border-radius:12px;padding:8px 12px;border:1.5px solid ${c.cardLine};background:${c.card}}
  .chip code{font:600 16px/1.2 "DejaVu Sans Mono",monospace}
  .chip span{display:block;font-size:13.5px;color:${c.muted};margin-top:3px;line-height:1.25}
  .lbl{position:absolute;font-size:14px;color:${c.muted};white-space:nowrap}
  .pill{position:absolute;text-align:center;font-size:14px;background:${c.bg};border-radius:8px;padding:2px 6px;z-index:3;white-space:nowrap}
  .pill.mono{font-size:13px}
  .dns{font:13px/1.55 "DejaVu Sans Mono",monospace;margin-top:8px;color:${c.code}}
  .dns b{color:${c.ink}}
  .note{font-size:13px;color:${c.muted};margin-top:8px;line-height:1.35}
  .wall{position:absolute;width:22px;writing-mode:vertical-rl;transform:rotate(180deg);text-align:center;
        font:600 11.5px/22px "DejaVu Sans Mono",monospace;letter-spacing:.04em;white-space:nowrap;border-left:2px dotted ${c.line}}
  svg.wires{position:absolute;inset:0;z-index:2;pointer-events:none}
  .fw{position:absolute;left:1225px;width:22px;border-radius:5px;background-color:${c.red};
      background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0 2px,transparent 2px 14px);
      writing-mode:vertical-rl;transform:rotate(180deg);text-align:center;color:${c.bg};
      font:700 12px/22px "DejaVu Sans Mono",monospace;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
  </style>
  <div class="zone" style="left:24px;top:24px;width:296px;height:${H - 48}px;background:${c.lanSoft};border:1.5px solid ${c.lan}55"><div class="label" style="color:${c.lan}">${t.lan}</div></div>
  <div class="zone" style="left:344px;top:24px;width:880px;height:${H - 48}px;background:${c.box};border:1.5px solid ${c.line}"><div class="label" style="color:${c.muted}">${t.host}</div></div>
  <div class="zone" style="left:1248px;top:24px;width:328px;height:${H - 48}px;background:${c.pubSoft};border:1.5px solid ${c.pub}55"><div class="label" style="color:${c.pub}">${t.net}</div></div>

  <div class="card" style="left:46px;top:150px;width:252px;height:178px;text-align:center;padding:16px 10px">
    <div style="display:flex;justify-content:center;align-items:flex-end;gap:12px">${laptop(c.lan)}${phoneIcon(c.lan)}</div>
    <div style="font-weight:700;font-size:17px;margin-top:10px">${t.devices}</div><div class="sub">${t.devicesSub}</div>
    <div class="mono" style="font-size:12.5px;color:${c.lan};margin-top:8px">${t.aLan}</div></div>
  <div class="card" style="left:46px;top:430px;width:252px;height:266px">
    <h4>${t.dns}</h4>
    <div class="dns"><b>drop</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;A 192.168.1.20<br><span style="color:${c.lan}">↳ ${t.dnsLan}</span><br>
      <b>drop-share</b> A 203.0.113.7<br><span style="color:${c.pub}">↳ ${t.dnsPub}</span></div>
    <div class="note">${t.dnsNote}</div></div>
  <div class="card" style="left:46px;top:718px;width:252px;height:134px">
    <h4>${t.addr}</h4>
    <div class="dns"><b>drop</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:${c.lan}">192.168.1.20</span><br>
      <b>drop-share</b> <span style="color:${c.pub}">192.168.1.21</span></div>
    <div class="note">${t.addrSub}</div></div>

  <div class="sandbox" style="left:372px;top:140px;width:412px;height:256px;border-color:${c.lan}99;background:${c.lanSoft}">
    <span class="tag" style="color:${c.lan}">${t.c1}</span>
    <h3><img src="file://${ICONS}/drop.png">drop</h3>
    <div class="sub mono" style="font-size:13.5px;color:${c.lan}">${t.dropSub}</div>
    ${spec(t.dropSpec)}</div>
  <div class="sandbox" style="left:806px;top:140px;width:396px;height:256px;border-color:${c.pub}99;background:${c.pubSoft}">
    <span class="tag" style="color:${c.pub}">${t.c2}</span>
    <h3><img src="file://${ICONS}/drop-share.png">drop-share</h3>
    <div class="sub mono" style="font-size:13.5px;color:${c.pub}">${t.shareSub}</div>
    ${spec(t.shareSpec)}
    <div class="note" style="margin-top:12px;font-style:italic">${t.shareOff}</div></div>
  <div class="wall" style="left:784px;top:146px;height:244px;color:${c.muted}">${t.wall}</div>

  <div class="card" style="left:372px;top:510px;width:830px;height:342px">
    <div style="font-size:19px">${t.store}</div><div class="sub" style="margin-top:2px">${t.storeSub}</div></div>
  ${group(394, 598, 340, 234, t.onlyDrop, c.lan, true)}
  ${chip(414, 624, 300, 'files/', t.files)}
  ${chip(414, 690, 300, 'texts/', t.texts)}
  ${chip(414, 756, 300, 'users/&lt;name&gt;/', t.users)}
  ${group(830, 598, 352, 234, t.inShares, c.pub, false)}
  ${chip(850, 624, 312, 'files/3f9c…e1', t.blob, c.pub)}
  ${chip(850, 690, 312, '3f9c…e1.json', t.record)}
  ${chip(850, 756, 312, 'counters/', t.counters)}

  <div class="fw" style="top:40px;height:236px">${t.fw}</div>
  <div class="fw" style="top:360px;height:${H - 400}px;text-transform:none;letter-spacing:.02em">${t.fwDoor}</div>
  <div class="card" style="left:1270px;top:80px;width:284px;height:100px;text-align:center;padding:10px">
    ${globe(c.pub)}<div style="font-weight:700;font-size:16px;margin-top:2px">${t.who}</div><div class="sub" style="margin-top:0">${t.whoSub}</div></div>
  <div class="card" style="left:1270px;top:250px;width:284px;height:126px;text-align:center;border-style:dashed;border-color:${c.line};background:${c.bg};box-shadow:none;padding:10px">
    ${shield(c.muted)}<div style="font-weight:700;font-size:16px;margin-top:2px">${t.proxy}</div><div class="sub" style="margin-top:1px">${t.proxySub}</div>
    <div class="sub" style="font-style:italic;font-size:13px;margin-top:1px">${t.blackbox}</div></div>
  <div class="card" style="left:1270px;top:598px;width:284px;height:150px">
    <h4>${t.token}</h4>
    <div class="dns">${t.tokenSpec.join('<br>')}</div></div>

  <svg class="wires" width="${W}" height="${H}">
    <defs>${['lan', 'pub', 'muted'].map(marker).join('')}</defs>
    <path d="M298 240 H364" stroke="${c.lan}" stroke-width="3" fill="none" marker-end="url(#a-lan)"/>
    <path d="M172 422 V336" stroke="${c.muted}" stroke-width="2" stroke-dasharray="3 5" fill="none" marker-end="url(#a-muted)"/>
    <path d="M1412 180 V242" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M1270 320 H1210" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M520 404 V502" stroke="${c.lan}" stroke-width="3" fill="none" marker-start="url(#a-lan)" marker-end="url(#a-lan)"/>
    <path d="M1150 590 V404" stroke="${c.pub}" stroke-width="3" stroke-dasharray="7 6" fill="none" marker-end="url(#a-pub)"/>
    <path d="M714 650 H842" stroke="${c.lan}" stroke-width="2.5" stroke-dasharray="5 5" fill="none" marker-end="url(#a-lan)"/>
  </svg>

  ${pill(1412, 200, 310, t.aNet, c.pub, true)}
  ${pill(1236, 286, 84, t.aProxy, c.pub)}
  ${pill(782, 622, 96, t.link, c.lan, true).replace('class="pill mono" style="', 'class="pill mono" style="font-size:12px;')}
  <div class="lbl" style="left:734px;top:662px;width:96px;text-align:center;font-size:13px">${t.noCopy}</div>
  <div class="lbl" style="left:534px;top:444px">${t.aRW}</div>
  <div class="lbl" style="left:880px;top:444px;width:256px;text-align:right;color:${c.pub}">${t.aRO}</div>
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
