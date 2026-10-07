// Dropnook screenshot gallery: arrows, keys, swipe, click to zoom, EN/DE.
(() => {
  const NAMES = ['1-overview', '2-share', '3-shares', '4-public', '5-phone', '6-languages', '7-theme'];
  const TEXT = {
    en: {
      slides: [
        ['Text, files and screenshots, live on every device', 'No app, no login — everyone in your network sees the same.'],
        ['Share to the internet', 'From your network to the internet: a link that expires, optionally with a password.'],
        ['Always clear what is public', 'Everything reachable from the internet is marked, views and downloads counted.'],
        ['What the recipient sees', 'Anyone with the link, anywhere — but only that one item.'],
        ['Made for the phone, too', 'On your home Wi-Fi or VPN, from the phone to the computer and back.'],
        ['Speaks 17 languages', 'Picked from the browser automatically.'],
        ['Light or dark', 'Follows the system — or one click switches.'],
      ],
      repo: 'View on GitHub →', prev: 'Previous screenshot', next: 'Next screenshot', all: 'All screenshots',
      keys: 'Click the picture to zoom in, move the mouse to look around · ← → to browse.',
      touch: 'Tap the picture to zoom in, swipe to browse.',
      back: '← Home', home: '../',
      title: 'Dropnook — screenshots', dir: '../screenshots/', readme: 'https://github.com/dropnook/dropnook.app',
    },
    de: {
      slides: [
        ['Text, Dateien und Screenshots, live auf jedem Gerät', 'Ohne App und Login — alle im Heimnetz sehen dasselbe.'],
        ['Ins Internet teilen', 'Aus dem Heimnetz ins Internet: ein Link mit Ablaufzeit, auf Wunsch mit Passwort.'],
        ['Immer klar, was öffentlich ist', 'Alles im Internet Abrufbare ist markiert, Aufrufe und Downloads werden gezählt.'],
        ['Was der Empfänger sieht', 'Wer den Link hat, von überall — aber nur dieser eine Inhalt.'],
        ['Auch fürs Handy gemacht', 'Im WLAN zu Hause oder per VPN, vom Handy zum Computer und zurück.'],
        ['Spricht 17 Sprachen', 'Automatisch nach dem Browser.'],
        ['Hell oder dunkel', 'Folgt dem System — oder ein Klick schaltet um.'],
      ],
      repo: 'Auf GitHub ansehen →', prev: 'Vorheriges Bild', next: 'Nächstes Bild', all: 'Alle Bilder',
      keys: 'Klick aufs Bild vergrössert, mit der Maus umsehen · ← → zum Blättern.',
      touch: 'Tippen vergrössert, wischen blättert.',
      back: '← Startseite', home: '../de/',
      title: 'Dropnook — Bilder', dir: '../screenshots/de/', readme: 'https://github.com/dropnook/dropnook.app/blob/main/README.de.md',
    },
  };
  const params = new URLSearchParams(location.search);
  let lang = params.get('lang') || ((navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en');
  if (!TEXT[lang]) lang = 'en';
  const SLIDES = NAMES.map((n, i) => [n, ...TEXT[lang].slides[i]]);
  const dark = matchMedia('(prefers-color-scheme: dark)');
  // The ☀/☾ choice made on the site wins over the system (theme.js).
  const scheme = () => document.documentElement.dataset.theme || (dark.matches ? 'dark' : 'light');
  const src = (i, thumb) => `${TEXT[lang].dir}${SLIDES[i][0]}-${scheme()}${thumb ? '-thumb' : ''}.webp`;

  function applyLanguage() {
    const t = TEXT[lang];
    document.documentElement.lang = lang;
    document.title = t.title;
    document.getElementById('repo').textContent = t.repo;
    document.getElementById('repo').href = t.readme;
    document.getElementById('back').textContent = t.back;
    document.getElementById('back').href = t.home;
    document.getElementById('home').href = t.home;
    document.getElementById('prev').setAttribute('aria-label', t.prev);
    document.getElementById('next').setAttribute('aria-label', t.next);
    document.getElementById('thumbs').setAttribute('aria-label', t.all);
    document.getElementById('hint-keys').textContent = t.keys;
    document.getElementById('hint-touch').textContent = t.touch;
    document.querySelectorAll('.langs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    t.slides.forEach((s, i) => { SLIDES[i][1] = s[0]; SLIDES[i][2] = s[1]; });
  }
  document.querySelectorAll('.langs button').forEach((b) => {
    b.onclick = () => {
      lang = b.dataset.lang;
      const url = new URL(location.href);
      url.searchParams.set('lang', lang);
      history.replaceState(null, '', url);
      applyLanguage();
      [...document.getElementById('thumbs').children].forEach((t, i) => t.setAttribute('aria-label', SLIDES[i][1]));
      show(index, true);
    };
  });
  applyLanguage();

  const stage = document.getElementById('stage');
  const shot = document.getElementById('shot');
  const caption = document.getElementById('caption');
  const thumbs = document.getElementById('thumbs');
  let index = 0;

  SLIDES.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', s[1]);
    b.innerHTML = `<img alt="" loading="lazy">`;
    b.onclick = () => show(i);
    thumbs.appendChild(b);
  });

  function paintThumbs() {
    [...thumbs.children].forEach((b, i) => {
      b.firstChild.src = src(i, true);
      b.setAttribute('aria-current', String(i === index));
    });
  }

  function show(i, fromHash) {
    index = (i + SLIDES.length) % SLIDES.length;
    unzoom();
    shot.src = src(index);
    shot.alt = SLIDES[index][1];
    caption.innerHTML = `<b>${SLIDES[index][1]}</b> — ${SLIDES[index][2]}`;
    paintThumbs();
    if (!fromHash) history.replaceState(null, '', location.pathname + location.search + '#' + (index + 1));
    [index + 1, index - 1].forEach((n) => { const im = new Image(); im.src = src((n + SLIDES.length) % SLIDES.length); });
  }

  // Zoom: click to enlarge at that spot, the picture follows the mouse.
  function aim(x, y) {
    const r = stage.getBoundingClientRect();
    shot.style.transformOrigin = `${((x - r.left) / r.width) * 100}% ${((y - r.top) / r.height) * 100}%`;
  }
  function unzoom() { stage.classList.remove('zoomed'); }
  shot.addEventListener('click', (e) => {
    if (stage.classList.contains('zoomed')) { unzoom(); return; }
    aim(e.clientX, e.clientY);
    stage.classList.add('zoomed');
  });
  stage.addEventListener('mousemove', (e) => { if (stage.classList.contains('zoomed')) aim(e.clientX, e.clientY); });
  stage.addEventListener('mouseleave', unzoom);

  document.getElementById('prev').onclick = () => show(index - 1);
  document.getElementById('next').onclick = () => show(index + 1);
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === 'Escape') unzoom();
  });

  // Swipe on touch screens.
  let startX = null;
  stage.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (startX === null || stage.classList.contains('zoomed')) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) show(index + (dx < 0 ? 1 : -1));
    startX = null;
  });

  const fromHash = () => {
    const n = parseInt(location.hash.slice(1), 10);
    return n >= 1 && n <= SLIDES.length ? n - 1 : 0;
  };
  addEventListener('hashchange', () => show(fromHash(), true));
  dark.addEventListener('change', () => show(index, true));
  document.addEventListener('dropnook-theme', () => show(index, true));
  show(fromHash(), true);
})();
