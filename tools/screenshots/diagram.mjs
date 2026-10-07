// Architecture diagram for the README and the site — who reaches what, how the
// two containers are walled off, and how a share is a hard link — light/dark, en/de:
//   node diagram.mjs   → $WORK/diagram/architecture-<lang>-<scheme>.png
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
const pw = createRequire(import.meta.url)(process.env.PWPATH || 'playwright');
const WORK = process.env.WORK || '/srv/demo';
const OUT = `${WORK}/diagram`;
mkdirSync(OUT, { recursive: true });
const ICONS = fileURLToPath(new URL('../../.github/icons', import.meta.url));
const W = 1600, H = 984;

const T = {
  en: {
    lan: 'Your network', host: 'Unraid · Docker', net: 'Internet',
    devices: 'Computers and phones', devicesSub: 'at home or via VPN',
    dns: 'DNS — at your domain hoster', dnsLan: 'LAN address of drop', dnsPub: 'your public IP',
    dnsNote: 'A private address in public DNS is harmless. Router blocks it? Allow the name in its DNS rebind protection.',
    br0: '<b>br0</b> · macvlan', br0Sub: 'every container its own LAN address',
    c1: 'container 1', c2: 'container 2 · optional',
    dropSub: 'MODE=lan · &lt;drop-IP&gt; · :443 TLS (:80 → 301)',
    dropSpec: [['user', 'root — owns /data, new files 99:100'], ['caps', 'CHOWN · DAC_OVERRIDE · FOWNER · NET_BIND_SERVICE'],
               ['limits', 'no-new-privileges · 2 GB · 200 pids'], ['guard', 'proxy headers or public IP → 404'],
               ['sign-in', 'PIN or USER_&lt;colour&gt; · HMAC cookie'], ['mounts', '/data rw · /certs ro · /config ro']],
    shareSub: 'MODE=public · &lt;share-IP&gt; · :80',
    shareSpec: [['user', '99:100 — no root'], ['caps', 'none (cap_drop: ALL)'], ['rootfs', 'read-only · tmpfs /tmp 16 MB'],
                ['limits', 'no-new-privileges · 256 MB · 64 pids'], ['mounts', '/data/shares ro · counters/ rw'],
                ['check', 'sees files/ or texts/ → refuses to start']],
    shareOff: 'SHARING=off — and it is not needed at all',
    wall: 'nothing in common but shares/',
    certs: 'certificates · read-only · found by itself (auto)',
    store: 'Unraid share <b>drop</b> → /data', storeSub: 'one mount — hard links only work within it',
    files: 'shared area', texts: 'text fields', users: 'own areas (users)', thumbs: 'previews · WebP',
    record: 'record — named by the hash, never by the link', blob: 'hard link of the shared file', counters: 'views — written by drop-share',
    inode: 'same inode', inodeSub: 'no copy · no extra space · deleted in Drop → link gone',
    who: 'Anyone with a link', whoSub: 'anywhere on the internet',
    proxy: 'Your reverse proxy', proxySub: 'HTTPS 443 · your certificate', blackbox: 'yours to run',
    token: 'The link', tokenSpec: ['k7m3x-9pq2r · 31¹⁰ ≈ 50 bit', 'sha256 → record name', '15 min – 30 days, then gone', 'password: PBKDF2, 10 tries / 15 min'],
    aLan: 'https://drop.yourdomain.com', aNet: 'drop-share.yourdomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80',
    aRW: 'reads &amp; writes everything', aRO: 'reads shares/ only',
    refused: 'refused — nothing reaches drop through the proxy',
  },
  de: {
    lan: 'Dein Netzwerk', host: 'Unraid · Docker', net: 'Internet',
    devices: 'Computer und Handys', devicesSub: 'zu Hause oder per VPN',
    dns: 'DNS — beim Domain-Hoster', dnsLan: 'LAN-Adresse von drop', dnsPub: 'deine öffentliche IP',
    dnsNote: 'Eine private Adresse im öffentlichen DNS schadet nicht. Blockt der Router? Den Namen beim DNS-Rebind-Schutz erlauben.',
    br0: '<b>br0</b> · macvlan', br0Sub: 'jeder Container mit eigener LAN-Adresse',
    c1: 'Container 1', c2: 'Container 2 · optional',
    dropSub: 'MODE=lan · &lt;drop-IP&gt; · :443 TLS (:80 → 301)',
    dropSpec: [['user', 'root — besitzt /data, neue Dateien 99:100'], ['caps', 'CHOWN · DAC_OVERRIDE · FOWNER · NET_BIND_SERVICE'],
               ['limits', 'no-new-privileges · 2 GB · 200 pids'], ['guard', 'Proxy-Header oder öffentliche IP → 404'],
               ['login', 'PIN oder USER_&lt;Farbe&gt; · HMAC-Cookie'], ['mounts', '/data rw · /certs ro · /config ro']],
    shareSub: 'MODE=public · &lt;share-IP&gt; · :80',
    shareSpec: [['user', '99:100 — kein root'], ['caps', 'keine (cap_drop: ALL)'], ['rootfs', 'nur lesend · tmpfs /tmp 16 MB'],
                ['limits', 'no-new-privileges · 256 MB · 64 pids'], ['mounts', '/data/shares ro · counters/ rw'],
                ['check', 'sieht files/ oder texts/ → startet nicht']],
    shareOff: 'SHARING=off — dann braucht es ihn gar nicht',
    wall: 'nichts gemeinsam ausser shares/',
    certs: 'Zertifikate · nur lesend · selbst gefunden (auto)',
    store: 'Unraid-Share <b>drop</b> → /data', storeSub: 'ein Mount — Hardlinks gehen nur innerhalb',
    files: 'gemeinsamer Bereich', texts: 'Textfelder', users: 'eigene Bereiche (Benutzer)', thumbs: 'Vorschaubilder · WebP',
    record: 'Datensatz — benannt nach dem Hash, nie nach dem Link', blob: 'Hardlink der geteilten Datei', counters: 'Aufrufe — schreibt drop-share',
    inode: 'dieselbe Inode', inodeSub: 'keine Kopie · kein Zusatzplatz · in Drop gelöscht → Link weg',
    who: 'Alle mit einem Link', whoSub: 'irgendwo im Internet',
    proxy: 'Dein Reverse Proxy', proxySub: 'HTTPS 443 · dein Zertifikat', blackbox: 'betreibst du',
    token: 'Der Link', tokenSpec: ['k7m3x-9pq2r · 31¹⁰ ≈ 50 bit', 'sha256 → Name des Datensatzes', '15 Min. – 30 Tage, dann weg', 'Passwort: PBKDF2, 10 Versuche / 15 Min.'],
    aLan: 'https://drop.deinedomain.com', aNet: 'drop-share.deinedomain.com/k7m3x-9pq2r', aProxy: 'HTTP :80',
    aRW: 'liest &amp; schreibt alles', aRO: 'liest nur shares/',
    refused: 'abgewiesen — über den Proxy kommt nichts an drop',
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
  const chip = (x, y, w, name, sub, color = '') => `<div class="chip" style="left:${x}px;top:${y}px;width:${w}px${color ? `;border-color:${color}` : ''}"><code>${name}</code><span>${sub}</span></div>`;
  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box} html,body{margin:0}
  body{width:${W}px;height:${H}px;background:${c.bg};color:${c.ink};position:relative;overflow:hidden;font-family:Inter,"Noto Sans",sans-serif}
  .zone{position:absolute;border-radius:22px;padding:14px 22px}
  .zone > .label{font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
  .card{position:absolute;background:${c.card};border:1.5px solid ${c.cardLine};border-radius:16px;box-shadow:${c.shadow};padding:14px 16px}
  .card h3{margin:0;font-size:24px;font-weight:750;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}
  .card h3 img{width:34px;height:34px;border-radius:9px}
  .card h4{margin:0;font-size:16px;font-weight:700}
  .sandbox{position:absolute;border-radius:20px;border:2px dashed;padding:30px 14px 14px}
  .sandbox > .tag{position:absolute;top:-12px;left:18px;font:600 13px/1 "DejaVu Sans Mono",monospace;letter-spacing:.06em;
         text-transform:uppercase;background:${c.bg};padding:4px 8px;border-radius:6px}
  .sub{font-size:14.5px;color:${c.muted};margin-top:4px}
  .mono{font-family:"DejaVu Sans Mono",monospace}
  .spec{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:14px 0 0;font-size:14px;line-height:1.3}
  .spec dt{font:600 13px/1.4 "DejaVu Sans Mono",monospace;color:${c.muted};text-align:right}
  .spec dd{margin:0;font-family:"DejaVu Sans Mono",monospace;font-size:13px;line-height:1.4;color:${c.code}}
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
        font:600 12px/22px "DejaVu Sans Mono",monospace;letter-spacing:.04em;border-left:2px dotted ${c.line}}
  svg.wires{position:absolute;inset:0;z-index:2;pointer-events:none}
  </style>
  <div class="zone" style="left:24px;top:24px;width:296px;height:${H - 48}px;background:${c.lanSoft};border:1.5px solid ${c.lan}55"><div class="label" style="color:${c.lan}">${t.lan}</div></div>
  <div class="zone" style="left:344px;top:24px;width:880px;height:${H - 48}px;background:${c.box};border:1.5px solid ${c.line}"><div class="label" style="color:${c.muted}">${t.host}</div></div>
  <div class="zone" style="left:1248px;top:24px;width:328px;height:${H - 48}px;background:${c.pubSoft};border:1.5px solid ${c.pub}55"><div class="label" style="color:${c.pub}">${t.net}</div></div>

  <div class="card" style="left:46px;top:170px;width:252px;height:178px;text-align:center;padding:16px 10px">
    <div style="display:flex;justify-content:center;align-items:flex-end;gap:12px">${laptop(c.lan)}${phoneIcon(c.lan)}</div>
    <div style="font-weight:700;font-size:17px;margin-top:10px">${t.devices}</div><div class="sub">${t.devicesSub}</div>
    <div class="mono" style="font-size:12.5px;color:${c.lan};margin-top:8px">${t.aLan}</div></div>
  <div class="card" style="left:46px;top:500px;width:252px;height:262px">
    <h4>${t.dns}</h4>
    <div class="dns"><b>drop</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;A 192.168.1.20<br><span style="color:${c.lan}">↳ ${t.dnsLan}</span><br>
      <b>drop-share</b> A 203.0.113.7<br><span style="color:${c.pub}">↳ ${t.dnsPub}</span></div>
    <div class="note">${t.dnsNote}</div></div>
  <div class="card" style="left:46px;top:784px;width:252px;height:88px">
    <div style="font-size:16px">${t.br0}</div><div class="sub">${t.br0Sub}</div></div>

  <div class="chip" style="left:376px;top:66px;width:404px;text-align:center"><span style="margin:0;font-size:14px">🔒 ${t.certs}</span></div>
  <div class="sandbox" style="left:372px;top:150px;width:412px;height:300px;border-color:${c.lan}99;background:${c.lanSoft}">
    <span class="tag" style="color:${c.lan}">${t.c1}</span>
    <h3 style="margin:0;font-size:24px;font-weight:750;display:flex;align-items:center;gap:10px"><img src="file://${ICONS}/drop.png" style="width:34px;height:34px;border-radius:9px">drop</h3>
    <div class="sub mono" style="font-size:13px">${t.dropSub}</div>
    ${spec(t.dropSpec)}</div>
  <div class="sandbox" style="left:806px;top:150px;width:396px;height:300px;border-color:${c.pub}99;background:${c.pubSoft}">
    <span class="tag" style="color:${c.pub}">${t.c2}</span>
    <h3 style="margin:0;font-size:24px;font-weight:750;display:flex;align-items:center;gap:10px"><img src="file://${ICONS}/drop-share.png" style="width:34px;height:34px;border-radius:9px">drop-share</h3>
    <div class="sub mono" style="font-size:13px">${t.shareSub}</div>
    ${spec(t.shareSpec)}
    <div class="note" style="margin-top:12px;font-style:italic">${t.shareOff}</div></div>
  <div class="wall" style="left:784px;top:166px;height:270px;color:${c.muted}">${t.wall}</div>

  <div class="card" style="left:372px;top:530px;width:830px;height:410px">
    <div style="font-size:19px">${t.store}</div><div class="sub" style="margin-top:2px">${t.storeSub}</div></div>
  ${chip(394, 600, 176, 'files/', t.files)}
  ${chip(582, 600, 140, 'texts/', t.texts)}
  ${chip(734, 600, 226, 'users/&lt;name&gt;/', t.users)}
  ${chip(972, 600, 166, '.thumbs/', t.thumbs)}
  <div class="chip" style="left:394px;top:690px;width:790px;height:234px;border-color:${c.pub};background:transparent">
    <code>shares/</code></div>
  ${chip(674, 730, 250, '3f9c…e1.json', t.record)}
  ${chip(936, 730, 228, 'counters/…', t.counters)}
  <div class="chip" style="left:414px;top:830px;width:240px;border-style:dashed;border-color:${c.lan}">
    <code style="color:${c.lan}">⛓ inode 4711</code><span>${t.inode} · ${t.inodeSub}</span></div>
  ${chip(674, 830, 490, 'files/3f9c…e1', t.blob, c.pub)}

  <div class="card" style="left:1270px;top:80px;width:284px;height:100px;text-align:center;padding:10px">
    ${globe(c.pub)}<div style="font-weight:700;font-size:16px;margin-top:2px">${t.who}</div><div class="sub" style="margin-top:0">${t.whoSub}</div></div>
  <div class="card" style="left:1270px;top:270px;width:284px;height:126px;text-align:center;border-style:dashed;border-color:${c.line};background:${c.bg};box-shadow:none;padding:10px">
    ${shield(c.muted)}<div style="font-weight:700;font-size:16px;margin-top:2px">${t.proxy}</div><div class="sub" style="margin-top:1px">${t.proxySub}</div>
    <div class="sub" style="font-style:italic;font-size:13px;margin-top:1px">${t.blackbox}</div></div>
  <div class="card" style="left:1270px;top:500px;width:284px;height:170px">
    <h4>${t.token}</h4>
    <div class="dns">${t.tokenSpec.join('<br>')}</div></div>

  <svg class="wires" width="${W}" height="${H}">
    <defs>${['lan', 'pub', 'muted', 'red'].map(marker).join('')}</defs>
    <path d="M298 262 H364" stroke="${c.lan}" stroke-width="3" fill="none" marker-end="url(#a-lan)"/>
    <path d="M172 492 V356" stroke="${c.muted}" stroke-width="2" stroke-dasharray="3 5" fill="none" marker-end="url(#a-muted)"/>
    <path d="M578 104 V142" stroke="${c.muted}" stroke-width="2.5" stroke-dasharray="6 5" fill="none" marker-end="url(#a-muted)"/>
    <path d="M1412 180 V262" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M1270 330 H1210" stroke="${c.pub}" stroke-width="3" fill="none" marker-end="url(#a-pub)"/>
    <path d="M520 450 V522" stroke="${c.lan}" stroke-width="3" fill="none" marker-start="url(#a-lan)" marker-end="url(#a-lan)"/>
    <path d="M1162 682 V458" stroke="${c.pub}" stroke-width="3" stroke-dasharray="7 6" fill="none" marker-end="url(#a-pub)"/>
    <path d="M520 657 V822" stroke="${c.lan}" stroke-width="2.5" stroke-dasharray="5 5" fill="none" marker-end="url(#a-lan)"/>
    <path d="M674 870 H662" stroke="${c.pub}" stroke-width="2.5" fill="none" marker-end="url(#a-pub)"/>
    <path d="M1270 286 H1236 V126 H700 V142" stroke="${c.red}" stroke-width="2.5" stroke-dasharray="4 6" fill="none" marker-end="url(#a-red)"/>
    <g transform="translate(1236 200)"><circle r="14" fill="${c.bg}" stroke="${c.red}" stroke-width="2.5"/><path d="M-5.5 -5.5L5.5 5.5M5.5 -5.5L-5.5 5.5" stroke="${c.red}" stroke-width="3" stroke-linecap="round"/></g>
  </svg>

  ${pill(1412, 206, 310, t.aNet, c.pub, true)}
  ${pill(1240, 300, 84, t.aProxy, c.pub)}
  ${pill(520, 742, 120, 'report.pdf', c.lan, true)}
  <div class="lbl" style="left:534px;top:478px">${t.aRW}</div>
  <div class="lbl" style="left:900px;top:478px;width:250px;text-align:right;color:${c.pub}">${t.aRO}</div>
  <div class="lbl" style="left:800px;top:96px;width:418px;text-align:right;color:${c.red};font-size:13.5px">${t.refused}</div>
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
