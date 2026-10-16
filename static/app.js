/* Drop — web page
   No framework, no build step. To try changes, mount your copy of the code over /app and reload. */
(() => {
'use strict';

// ------------------------------------------------------------------ Constants
const SAVE_DELAY          = 400;    // ms after the last key press
const SAVE_AT_LATEST      = 1500;   // ms, even while typing on
const PARALLEL_CHUNKS     = 2;      // more collides with the browser's 6-connection limit
const CHUNK_ATTEMPTS      = 4;
const DOWNLOAD_GAP        = 400;    // ms between two triggered downloads
const DOWNLOAD_CONFIRM_AT = 25;     // ask first from this many files on
const DRAFT_KEY           = 'drop.draft.';   // + field id
const OLD_DRAFT_KEY       = 'drop.feld.';    // earlier builds; moved once
const THEME_KEY           = 'drop.theme';    // light | dark; missing = automatic (theme.js)
const PALETTE_KEY         = 'drop.palette';  // colour layout without users; missing = teal (theme.js)
const AREA_KEY            = 'drop.area';     // with users: the area shown last
const PALETTES            = ['teal', 'gold', 'blue', 'violet', 'coral'];
const MAX_LINKS           = 12;

// Choices when sharing. Anything beyond SHARE_MAX_DAYS is left out.
const SHARE_DURATIONS = [15 * 60, 3600, 4 * 3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400];
const SHARE_DEFAULT   = 86400;

// ------------------------------------------------------------------ State
let chunkSize        = 64 * 1024 * 1024;
let files            = [];
let serverUploads    = new Map();   // from other devices, via SSE
let ownUploads       = new Map();   // in this tab, with finer progress
let selection        = new Set();
let source           = null;        // EventSource
let appName          = 'Drop';
const fields         = [];          // in display order: { id, textarea, version, timer, maxTimer, changed, … }
let fieldMax         = 12;
let fieldStart       = 3;
let firstLoad        = true;
let sharingEnabled   = false;
let shareMaxDays     = 30;
let shareBaseFixed   = null;        // SHARE_BASE_URL, if set
let shareSubdomain   = 'drop-share';
let shares           = [];
let sharesList       = null;        // the <ul> in the open shares dialog
let filesLoaded      = false;       // after the first full state: new files get highlighted
const fresh          = new Map();   // name → when it arrived, for a short highlight

// Users (set in the .env): the server marks <html> with data-user and the user's
// colour. Each user has an area of their own next to the shared one; the page
// shows one of the two, and every request says which.
const usersOn        = 'user' in document.documentElement.dataset;
// Whom this page was opened for. Someone else signing in in another tab
// replaces the cookie; the server then answers 401 and this page reloads,
// instead of saving into the other person's area.
const openedAs       = usersOn ? document.documentElement.dataset.palette || '' : '';
let user             = null;        // { name, palette }
let area             = 'shared';    // 'own' | 'shared'

// ------------------------------------------------------------------ Language
/* All texts come from lang/<code>.json on the server. The browser sends its
   preferred languages, the server picks the first one Drop has (English
   otherwise) and returns its strings, gaps filled in from English. A new
   language is a new file there — nothing to change in here. */
let lang = 'en';
let locale = 'en';
let strings = {};
let pluralRules = new Intl.PluralRules('en');

async function loadLanguage() {
  const preferred = (navigator.languages && navigator.languages.length)
    ? navigator.languages : [navigator.language || 'en'];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('/api/lang?prefer=' + encodeURIComponent(preferred.join(',')));
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      lang = data.lang || 'en';
      strings = data.strings || {};
      // Dates and numbers in the regional flavour of the chosen language:
      // de-CH and de-DE both get German, each with its own formats.
      // Some browsers report tags like "en-US@posix" that Intl rejects; then
      // the plain language has to do, or every date and number would throw.
      locale = preferred.find((l) => l.toLowerCase().split('-')[0] === lang) || lang;
      try { Intl.getCanonicalLocales(locale); } catch (e) { locale = lang; }
      try { pluralRules = new Intl.PluralRules(locale); } catch (e) { locale = 'en'; pluralRules = new Intl.PluralRules('en'); }
      document.documentElement.lang = lang;
      document.documentElement.dir = strings['meta.dir'] === 'rtl' ? 'rtl' : 'ltr';
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

const num = (n) => Number(n).toLocaleString(locale);

/* t('ui.key', { name: 'x', n: 3 }). With n, key_one / key_other / … are
   chosen by the plural rules of the language. Unknown keys show as the key,
   so a missing translation is easy to spot. */
function t(key, values) {
  let s = strings[key];
  if (s === undefined && values && typeof values.n === 'number') {
    s = strings[`${key}_${pluralRules.select(values.n)}`];
    if (s === undefined) s = strings[`${key}_other`];
  }
  if (s === undefined) return key;
  if (!values) return s;
  return s.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in values)) return match;
    const v = values[name];
    return typeof v === 'number' ? num(v) : String(v);
  });
}

/* In the user's own area, "deleted for everyone" would not be true: there the
   key_own variant of a text is used, where the language has one. */
function tArea(key, values) {
  if (area === 'own') {
    const own = key + '_own';
    if (strings[own] !== undefined || strings[own + '_other'] !== undefined) return t(own, values);
  }
  return t(key, values);
}

function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel)); });
}

// ------------------------------------------------------------------ Small helpers
const $  = (s) => document.querySelector(s);

// Which area a request is about — only with users; without, there is just one.
function withArea(url, which = area) {
  if (!usersOn) return url;
  return url + (url.includes('?') ? '&' : '?') + 'area=' + which;
}

// With a PIN (set in the .env): once the sign-in has run out or the PIN was
// changed, every request answers 401 — reload, and the PIN page comes up.
const plainFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  if (openedAs) options = { ...options, headers: { ...(options.headers || {}), 'x-drop-as': openedAs } };
  const response = await plainFetch(url, options);
  if (response.status === 401) location.reload();
  return response;
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toLocaleString(locale, { maximumFractionDigits: i === 0 || value >= 10 ? 0 : 1 })} ${units[i]}`;
}

function formatDate(seconds) {
  const d = new Date(seconds * 1000);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return t('ui.today_at', { time });
  const date = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
  return `${date} ${time}`;
}

function toast(text, warn) {
  const n = el('div', 'toast' + (warn ? ' warn' : ''), text);
  $('#toasts').appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 250); }, warn ? 5200 : 2800);
}

/* Server errors meant for people carry a code (see api_error in main.py);
   the text for it comes from the language file. */
async function errorText(response) {
  try {
    const detail = (await response.json()).detail;
    if (detail && detail.code) {
      const key = 'ui.error_' + detail.code;
      return strings[key] !== undefined ? t(key) : (detail.message || String(response.status));
    }
    if (typeof detail === 'string') return detail;
  } catch (e) { /* no JSON */ }
  return String(response.status);
}

// ------------------------------------------------------------------ Links in text
/* Derived from the text field only: the textarea stays a textarea, nothing is
   rewritten or stored in addition. The list below the field is recomputed on
   every change. */

// Without this list "file.txt" would pass as an address. Adding one is one word.
const TLDS = new Set(('ch li de at fr it com net org io dev app cloud ai eu info biz ' +
  'tv me co us uk nl be es pt se no dk fi pl cz sk hu ro gr tr ru jp cn in au nz ca br mx ' +
  'za shop blog xyz online site tech email link page wiki news media studio agency systems ' +
  'tools solutions gmbh swiss').split(' '));

function looksLikeAddress(raw) {
  const host = raw.split(/[\/?#]/)[0].replace(/:\d{1,5}$/, '');
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255) ? 'ip' : null;
  }
  const parts = host.toLowerCase().split('.');
  if (parts.length < 2) return null;
  if (!TLDS.has(parts[parts.length - 1])) return null;
  return parts.every((p) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(p)) ? 'name' : null;
}

function asUrl(piece) {
  let candidate = piece;
  // https:/host with a single slash is a common typo — let it through.
  const scheme = candidate.match(/^(https?):\/{1,2}(.+)$/i);
  if (scheme) {
    candidate = scheme[1].toLowerCase() + '://' + scheme[2];
  } else if (/^www\./i.test(candidate)) {
    candidate = 'https://' + candidate;
  } else {
    const kind = looksLikeAddress(candidate);
    if (!kind) return null;
    candidate = (kind === 'ip' ? 'http://' : 'https://') + candidate;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

function addressesIn(text) {
  const found = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\s+/)) {
    const piece = raw.replace(/^[<(\[«„"']+/, '').replace(/[>)\]»"'.,;:!?]+$/, '');
    if (!piece || piece.includes('@')) continue;
    const target = asUrl(piece);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    found.push({ text: piece, target });
    if (found.length > 200) break;
  }
  return found;
}

function updateLinks(f) {
  if (!f || !f.links) return;
  const hits = addressesIn(f.textarea.value);
  f.links.innerHTML = '';
  if (!hits.length) { f.links.hidden = true; return; }
  f.links.hidden = false;
  f.links.appendChild(el('span', 'links-count', t('ui.links', { n: hits.length })));
  hits.slice(0, MAX_LINKS).forEach((h) => {
    const a = document.createElement('a');
    a.className = 'link-btn';
    a.href = h.target;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = h.text;      // never innerHTML — the text comes from outside
    a.title = h.target;
    f.links.appendChild(a);
  });
  if (hits.length > MAX_LINKS) {
    f.links.appendChild(el('span', 'links-count', t('ui.links_more', { n: hits.length - MAX_LINKS })));
  }
}

// ------------------------------------------------------------------ Clipboard
/* navigator.clipboard only exists in a secure context. Over http:// the object
   is simply not there — execCommand is not a stopgap there but the only way
   browsers offer. */
function toClipboard(text) {
  if (window.isSecureContext && navigator.clipboard) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  /* Important: NO contentEditable on a textarea and no selectNodeContents. A
     textarea's value is not a child node, so a range over it selects nothing —
     execCommand then copies an empty selection and still reports success.
     Right is focus and select(); iOS needs setSelectionRange on top. */
  const previous = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');       // keeps the iOS keyboard down
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;' +
    'outline:none;box-shadow:none;background:transparent;opacity:0;font-size:16px;';
  document.body.appendChild(ta);

  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy') && true;
  } catch (e) {
    ok = false;
  }
  ta.remove();
  if (previous && typeof previous.focus === 'function') {
    try { previous.focus({ preventScroll: true }); } catch (e) { /* never mind */ }
  }
  return ok;
}

/* Last resort when the browser refuses copying altogether: select the text in
   the visible field, so ⌘C or Ctrl+C by hand is enough. */
function selectForManualCopy(f) {
  const ta = f.textarea;
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
}

function copyWithToast(text, done) {
  toClipboard(text).then((ok) => toast(ok ? done : t('ui.copy_failed'), !ok));
}

// ------------------------------------------------------------------ Dialog
/* content is a DOM node, or an array of paragraphs as plain text. Never HTML
   built from strings: file names and texts come from other people. */
function dialog({ title, content, buttons }) {
  const backdrop = $('#dialog-backdrop');
  $('#dialog-title').textContent = title;
  const body = $('#dialog-body');
  body.innerHTML = '';
  if (Array.isArray(content)) content.forEach((p) => body.appendChild(el('p', '', p)));
  else if (content) body.appendChild(content);

  const foot = $('#dialog-foot');
  foot.innerHTML = '';
  (buttons || [{ text: t('ui.close') }]).forEach((b) => {
    const button = el('button', 'btn' + (b.kind ? ' ' + b.kind : ' plain'), b.text);
    button.type = 'button';
    button.onclick = () => { close(); if (b.action) b.action(); };
    foot.appendChild(button);
  });

  backdrop.hidden = false;
  const first = foot.querySelector('button');
  if (first) first.focus();

  function close() {
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
}

function confirmDialog(title, text, buttonText, action) {
  dialog({
    title,
    content: [text],
    buttons: [
      { text: t('ui.cancel') },
      { text: buttonText, kind: 'danger', action },
    ],
  });
}

// ------------------------------------------------------------------ Text fields
/* Every field has a fixed id (text<id>.txt on the server). What is shown is
   the position, though: "Field 2" is the second field from the top, even if
   one above it was removed. The server decides number and order; this only
   reconciles, without rebuilding a field under someone's fingers. */

const fieldById   = (id) => fields.find((f) => f.id === id);
const fieldNumber = (f) => fields.indexOf(f) + 1;
const fieldName   = (f) => t('ui.field_name', { number: fieldNumber(f) });

function smallButton(text) {
  const b = el('button', 'btn plain small', text);
  b.type = 'button';
  return b;
}

function buildField(id) {
  const card = el('div', 'field');

  const head = el('div', 'field-head');
  const title = el('div', 'field-title');
  const name = el('span', 'field-name', '');
  const count = el('span', 'field-count', '');
  const badge = el('button', 'public-badge', '');
  badge.type = 'button';
  badge.hidden = true;
  badge.onclick = () => showShares();
  title.append(name, badge, count);
  const right = el('div', 'field-buttons');
  const copy = smallButton(t('ui.copy'));
  const share = smallButton(t('ui.share'));
  share.title = t('ui.share_text_hint');
  share.hidden = !sharingEnabled;
  const clear = smallButton(t('ui.clear'));
  const remove = el('button', 'field-remove', '×');
  remove.type = 'button';
  remove.title = t('ui.remove_field');
  remove.setAttribute('aria-label', t('ui.remove_field'));
  right.append(copy, share, clear, remove);
  head.append(title, right);

  const ta = document.createElement('textarea');
  ta.spellcheck = false;
  ta.dir = 'auto';                 // each field follows its own text, not the page direction

  const links = el('div', 'field-links');
  links.hidden = true;

  const changedNote = el('div', 'field-changed');
  changedNote.appendChild(el('span', '', t('ui.changed_elsewhere')));
  const takeServer = smallButton(t('ui.take_server_version'));
  takeServer.title = t('ui.take_server_version_hint');
  changedNote.appendChild(takeServer);

  card.append(head, ta, links, changedNote);

  const f = {
    id, area, card, textarea: ta, name, count, badge, links, share, remove,
    version: null, timer: null, maxTimer: null, sending: false, changed: false, conflicts: 0, gone: false,
  };

  takeServer.onclick = () => takeServerVersion(f);
  ta.addEventListener('input', () => {
    updateCount(f);
    saveDraft(f);
    scheduleSave(f);
  });
  copy.onclick = () => {
    const content = ta.value;
    if (!content) { toast(t('ui.field_empty')); return; }
    toClipboard(content).then((ok) => {
      if (ok) { toast(t('ui.field_copied', { field: fieldName(f) })); return; }
      selectForManualCopy(f);
      toast(t('ui.copy_refused'), true);
    });
  };
  share.onclick = () => {
    if (!ta.value.trim()) { toast(t('ui.field_empty_share')); return; }
    createShareDialog({ kind: 'text', text: ta.value, title: fieldName(f), field: f.id });
  };
  clear.onclick = () => {
    if (!ta.value) return;
    confirmDialog(t('ui.clear_field_title'), tArea('ui.clear_field_text', { field: fieldName(f) }),
      t('ui.clear'), () => { ta.value = ''; updateCount(f); saveDraft(f); save(f); });
  };
  remove.onclick = () => {
    if (!ta.value) { removeField(f); return; }
    confirmDialog(t('ui.remove_field_title'), tArea('ui.remove_field_text', { field: fieldName(f) }),
      t('ui.remove'), () => removeField(f));
  };
  return f;
}

/* Brings the fields in line with the server: build missing ones, take down
   removed ones, restore the order. A node is only moved if it really is in
   the wrong place — moving takes the focus away from a field. */
function syncFields(texts) {
  const root = $('#fields');
  const ids = new Set(texts.map((x) => x.id));

  fields.slice().forEach((f) => { if (!ids.has(f.id)) takeDownField(f); });

  const added = [];
  const ordered = texts.map((x) => {
    let f = fieldById(x.id);
    if (!f) { f = buildField(x.id); added.push(f); }
    return f;
  });
  fields.length = 0;
  fields.push(...ordered);

  fields.forEach((f, pos) => {
    const there = root.children[pos];
    if (there !== f.card) root.insertBefore(f.card, there || null);
  });
  labelFields();

  texts.forEach((x) => {
    const f = fieldById(x.id);
    if (added.includes(f)) fillNewField(f, x);
    else fromServer(f, x.text, x.version);
  });
}

function labelFields() {
  fields.forEach((f) => {
    f.name.textContent = fieldName(f);
    f.textarea.setAttribute('aria-label', t('ui.field_aria', { number: fieldNumber(f) }));
    f.remove.hidden = fields.length <= 1;
    f.share.hidden = !sharingEnabled;
  });
  const add = $('#btn-add-field');
  add.disabled = fields.length >= fieldMax;
  add.title = add.disabled ? t('ui.field_limit', { n: fieldMax }) : '';
  markFields();
}

function fillNewField(f, x) {
  // A draft left over from an earlier session wins — if it builds on exactly
  // this version. Otherwise a person decides.
  const draft = readDraft(f);
  f.version = x.version;
  f.textarea.value = x.text;
  if (draft && draft.text !== x.text) {
    if (draft.base === x.version) {
      f.textarea.value = draft.text;
      scheduleSave(f);
      toast(t('ui.draft_restored', { field: fieldName(f) }));
    } else {
      resolveConflict(f, draft.text, x);
      f.textarea.value = draft.text;
    }
  } else if (draft) {
    deleteDraft(f);                    // arrived after all
  }
  updateCount(f);
}

function takeDownField(f) {
  clearTimeout(f.timer); f.timer = null;
  clearTimeout(f.maxTimer); f.maxTimer = null;
  f.gone = true;
  f.card.remove();
  const i = fields.indexOf(f);
  if (i >= 0) fields.splice(i, 1);

  // A draft only exists while something is unsaved. Whoever removes a field
  // themselves deleted it before — then there is nothing to rescue.
  const draft = readDraft(f);
  deleteDraft(f);
  if (draft && draft.text && draft.text.trim()) offerRescue(draft.text);
}

/* Another area is shown: the field leaves the page, but it was not removed —
   its draft stays for when the area comes back. */
function unmountField(f) {
  f.gone = true;
  f.card.remove();
  const i = fields.indexOf(f);
  if (i >= 0) fields.splice(i, 1);
}

async function addField(text) {
  const asked = area;
  try {
    const r = await fetch(withArea('/api/text', asked), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: text || '' }),
    });
    if (r.status === 409) { toast(t('ui.field_limit', { n: fieldMax }), true); return null; }
    if (r.status === 413) { toast(t('ui.field_too_long'), true); return null; }
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (asked !== area) return null;      // another area is shown now
    syncFields(d.texts);
    return fieldById(d.id) || null;
  } catch (e) {
    toast(t('ui.field_add_failed'), true);
    return null;
  }
}

async function removeField(f) {
  clearTimeout(f.timer); f.timer = null;
  clearTimeout(f.maxTimer); f.maxTimer = null;
  deleteDraft(f);
  f.gone = true;                // no more saving from here on
  try {
    const r = await fetch(withArea(`/api/text/${f.id}`, f.area), { method: 'DELETE' });
    if (r.status === 409) { f.gone = false; toast(t('ui.last_field')); return; }
    if (!r.ok) throw new Error(r.status);
    const texts = (await r.json()).texts;
    if (f.area === area) syncFields(texts);
  } catch (e) {
    f.gone = false;
    toast(t('ui.field_remove_failed'), true);
  }
}

/* Someone removed a field that still had unsaved text here. Do not drop it
   silently: offer to keep it as a new field. Several in a row if needed. */
const toRescue = [];

function offerRescue(text) {
  toRescue.push(text);
  if (toRescue.length === 1) nextRescue();
}

function nextRescue() {
  if (!toRescue.length) return;
  const text = toRescue[0];
  const next = () => { toRescue.shift(); setTimeout(nextRescue, 0); };
  const box = el('div');
  box.appendChild(el('p', '', t('ui.rescue_text')));
  box.appendChild(el('pre', 'preview', text.length > 600 ? text.slice(0, 600) + ' …' : text));
  dialog({
    title: t('ui.rescue_title'),
    content: box,
    buttons: [
      { text: t('ui.discard'), action: next },
      { text: t('ui.keep_as_new_field'), kind: '', action: async () => {
          const f = await addField(text);
          if (f) toast(t('ui.kept_as', { field: fieldName(f) }));
          next();
        } },
    ],
  });
}

function countText(text) {
  // Characters by code point, not UTF-16 unit: an emoji is one.
  let chars = 0;
  for (const _ of text) chars++;      // eslint-disable-line no-unused-vars
  // Words: whatever stands between whitespace and contains a letter or digit.
  // A lone dash does not count, "e.g." and "e-mail" count once each.
  let words = 0;
  for (const piece of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) words++;
  return { chars, words };
}

function updateCount(f) {
  const { chars, words } = countText(f.textarea.value);
  f.count.textContent = chars === 0
    ? t('ui.empty_field')
    : `${t('ui.words', { n: words })} · ${t('ui.characters', { n: chars })}`;
  // Called from everywhere the content changes — typing, SSE, clearing,
  // taking the server version, first load. One hook is enough.
  updateLinks(f);
}

/* Drafts of the shared area keep the key of the versions without users; those
   of a user's own area carry the name, so two people on one browser never get
   each other's text. */
function draftPrefix(which) {
  return which === 'own' && user ? `${DRAFT_KEY}@${encodeURIComponent(user.name)}.` : DRAFT_KEY;
}
function draftKey(f) { return draftPrefix(f.area) + f.id; }

function saveDraft(f) {
  try {
    localStorage.setItem(draftKey(f), JSON.stringify({
      text: f.textarea.value, base: f.version, ts: Date.now(),
    }));
  } catch (e) { /* private mode or full — no reason to stop */ }
}

function readDraft(f) {
  try { return JSON.parse(localStorage.getItem(draftKey(f)) || 'null'); }
  catch (e) { return null; }
}

function deleteDraft(f) {
  try { localStorage.removeItem(draftKey(f)); } catch (e) {}
}

/* Earlier builds stored drafts under another key with other field names.
   Move them once so nothing unsaved is lost. */
function moveOldDrafts() {
  try {
    for (let k = localStorage.length - 1; k >= 0; k--) {
      const key = localStorage.key(k);
      if (!key || !key.startsWith(OLD_DRAFT_KEY)) continue;
      const id = key.slice(OLD_DRAFT_KEY.length);
      let old = null;
      try { old = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      if (old && localStorage.getItem(DRAFT_KEY + id) === null) {
        localStorage.setItem(DRAFT_KEY + id, JSON.stringify({ text: old.text, base: old.basis, ts: old.ts }));
      }
      localStorage.removeItem(key);
    }
  } catch (e) {}
}

/* Drafts for fields of this area that no longer exist at load time — removed
   while this tab was closed. As with removal while running: offer the rescue. */
function orphanedDrafts() {
  const present = new Set(fields.map((f) => String(f.id)));
  const prefix = draftPrefix(area);
  const finds = [];
  try {
    for (let k = localStorage.length - 1; k >= 0; k--) {
      const key = localStorage.key(k);
      if (!key || !key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!/^\d+$/.test(id) || present.has(id)) continue;
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
      localStorage.removeItem(key);
      if (draft && draft.text && draft.text.trim()) finds.push(draft.text);
    }
  } catch (e) {}
  finds.forEach(offerRescue);
}

function scheduleSave(f) {
  clearTimeout(f.timer);
  f.timer = setTimeout(() => save(f), SAVE_DELAY);
  if (!f.maxTimer) f.maxTimer = setTimeout(() => save(f), SAVE_AT_LATEST);
}

async function save(f) {
  clearTimeout(f.timer); f.timer = null;
  clearTimeout(f.maxTimer); f.maxTimer = null;
  if (f.gone) return;

  const text = f.textarea.value;
  f.sending = true;
  try {
    const response = await fetch(withArea(`/api/text/${f.id}`, f.area), {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, base: f.version }),
    });
    if (f.gone) {                // another area is shown now: only tidy up behind it
      if (response.ok && f.textarea.value === text) deleteDraft(f);
      return;
    }
    if (response.status === 404) {
      // The field was removed on the server. Syncing takes it down and offers
      // to rescue the draft.
      loadState();
      return;
    }
    if (response.status === 413) {
      // Too long for the server: it stays here (draft) — said once, not on every key.
      if (!f.tooLong) toast(t('ui.field_too_long'), true);
      f.tooLong = true;
      return;
    }
    f.tooLong = false;
    if (response.status === 409) {
      const data = await response.json();
      const active = document.activeElement === f.textarea;
      if (active && f.conflicts < 5) {
        /* I am typing right now. Then no modal dialog in my face: show the
           note, build on the new version and save again straight away.
           Whoever types wins — visibly, not secretly. */
        f.conflicts++;
        f.changed = true;
        f.card.classList.add('changed');
        f.version = data.version;
        setTimeout(() => save(f), 300);
        return;
      }
      f.conflicts = 0;
      resolveConflict(f, text, data);
      return;
    }
    if (!response.ok) throw new Error(response.status);
    const data = await response.json();
    f.version = data.version;
    f.conflicts = 0;
    f.changed = false;
    f.card.classList.remove('changed');
    // Only delete if nobody typed on since sending — otherwise the newer
    // draft would be lost if the connection dropped now.
    if (f.textarea.value === text) deleteDraft(f);
  } catch (e) {
    // Did not arrive. The draft is in localStorage and goes out by itself on
    // reconnect.
  } finally {
    f.sending = false;
  }
}

function resolveConflict(f, myText, server) {
  dialog({
    title: t('ui.conflict_title', { field: fieldName(f) }),
    content: [
      t('ui.conflict_text', { mine: countText(myText).chars, theirs: countText(server.text).chars }),
      t('ui.conflict_safe'),
    ],
    buttons: [
      { text: t('ui.take_server_version'), action: () => {
          f.version = server.version;
          f.textarea.value = server.text;
          updateCount(f); deleteDraft(f);
        } },
      { text: t('ui.keep_mine'), kind: '', action: () => {
          f.version = server.version;   // build on the current version now
          save(f);
        } },
    ],
  });
}

async function takeServerVersion(f) {
  try {
    const response = await fetch(withArea('/api/state', f.area));
    if (!response.ok) throw new Error(response.status);
    const current = (await response.json()).texts.find((x) => x.id === f.id);
    if (!current) { toast(t('ui.field_gone'), true); return; }

    // First clear any planned saves, otherwise the timer pushes my own text
    // right back.
    clearTimeout(f.timer); f.timer = null;
    clearTimeout(f.maxTimer); f.maxTimer = null;

    f.textarea.value = current.text;
    f.version = current.version;
    f.conflicts = 0;
    f.changed = false;
    f.card.classList.remove('changed');
    deleteDraft(f);
    updateCount(f);
    toast(t('ui.server_version_taken', { field: fieldName(f) }));
  } catch (e) {
    toast(t('ui.server_version_failed'), true);
  }
}

function fromServer(f, text, version) {
  if (!f) return;
  const differs = f.textarea.value !== text;
  if (differs && version === f.version) {
    // Nothing happened to this field on the server — what is different here
    // is simply newer and still on its way. Happens e.g. when someone adds a
    // field while this one is being typed in.
    return;
  }
  const active = document.activeElement === f.textarea;
  const pending = f.timer || f.maxTimer || f.sending;
  if (differs && (active || pending)) {
    // Never pull it away under someone's fingers — nor anything not yet
    // saved. Saving notices the conflict and asks.
    f.changed = true; f.card.classList.add('changed');
    return;
  }
  f.version = version;
  if (differs) { f.textarea.value = text; updateCount(f); }
  deleteDraft(f);
}

// ------------------------------------------------------------------ Shares
/* Single texts and files, shared to the internet for a limited time. The link
   points to a name of its own, behind which only that one share is reachable —
   never the drop box itself. */

/* The public address is not configured anywhere. Whoever has the drop box
   open as drop.example.org shares through drop-share.example.org — the reverse
   proxy does the rest. Opened by IP address there is nothing to derive. */
function shareBase() {
  if (shareBaseFixed) return shareBaseFixed.replace(/\/+$/, '');
  const host = location.hostname.toLowerCase();
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  const rest = parts.length >= 3 ? parts.slice(1) : parts;
  return `https://${shareSubdomain}.${rest.join('.')}`;
}

function shareUrl(rec) {
  const base = shareBase();
  return base ? `${base}/${rec.token}` : `/${rec.token}`;
}

function randomPassword() {
  // Read out and typed by hand: lower case only, no look-alikes (0/o, 1/l/i),
  // in groups like the links — e.g. k7m3-x9pq-2rtw, about 59 bits.
  const chars = '23456789abcdefghjkmnpqrstuvwxyz';
  const random = new Uint32Array(12);
  crypto.getRandomValues(random);
  const s = Array.from(random, (r) => chars[r % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function remaining(expires) {
  const s = expires - Date.now() / 1000;
  if (s <= 0) return t('ui.expired');
  const minutes = Math.max(1, Math.round(s / 60));
  if (minutes < 60) return t('ui.remaining_minutes', { n: minutes });
  if (s < 2 * 86400) return t('ui.remaining_hours', { n: Math.round(s / 3600) });
  return t('ui.remaining_days', { n: Math.round(s / 86400) });
}

function durationLabel(seconds) {
  if (seconds < 3600) return t('ui.duration_minutes', { n: Math.round(seconds / 60) });
  if (seconds < 86400) return t('ui.duration_hours', { n: Math.round(seconds / 3600) });
  return t('ui.duration_days', { n: Math.round(seconds / 86400) });
}

function durationSelect() {
  const select = document.createElement('select');
  select.id = 'share-duration';
  const limit = shareMaxDays * 86400;
  const options = SHARE_DURATIONS.filter((s) => s <= limit);
  if (!options.includes(limit)) options.push(limit);
  options.forEach((s) => {
    const o = el('option', '', durationLabel(s));
    o.value = String(s);
    if (s === SHARE_DEFAULT) o.selected = true;
    select.appendChild(o);
  });
  return select;
}

/* Opened by IP address, a link would point nowhere — so sharing is not even
   offered then. The server refuses it as well. */
function needsNameDialog() {
  dialog({
    title: t('ui.share_needs_name_title'),
    content: [t('ui.opened_by_ip', { app: appName })],
    buttons: [{ text: t('ui.close'), kind: '' }],
  });
}

function createShareDialog(what) {
  if (!shareBase()) { needsNameDialog(); return; }
  const box = el('div');
  if (what.kind === 'text') {
    const { words, chars } = countText(what.text);
    box.appendChild(el('p', '', t('ui.share_text_intro', {
      field: what.title, words: t('ui.words', { n: words }), chars: t('ui.characters', { n: chars }) })));
  } else {
    box.appendChild(el('p', '', t('ui.share_file_intro', { name: what.name, size: formatSize(what.size) })));
  }
  box.appendChild(el('p', '', t('ui.share_who')));

  const row = el('label', 'share-option');
  const select = durationSelect();
  row.append(el('span', '', t('ui.valid_for')), select);
  box.appendChild(row);

  const pwRow = el('div', 'share-option');
  const pw = document.createElement('input');
  pw.type = 'text';                 // visible: it is meant to be passed on
  pw.id = 'share-password';
  pw.placeholder = t('ui.optional');
  pw.autocomplete = 'off';
  pw.spellcheck = false;
  pw.maxLength = 200;
  const pwLabel = el('label', '', t('ui.password'));
  pwLabel.htmlFor = pw.id;
  const suggest = smallButton(t('ui.random'));
  suggest.onclick = () => { pw.value = randomPassword(); pw.focus(); pw.select(); };
  pwRow.append(pwLabel, pw, suggest);
  box.appendChild(pwRow);
  box.appendChild(el('p', 'small', t('ui.password_hint')));

  dialog({
    title: t('ui.share_title'),
    content: box,
    buttons: [
      { text: t('ui.cancel') },
      { text: t('ui.create_link'), kind: '', action: () => createShare(what, Number(select.value), pw.value) },
    ],
  });
}

async function createShare(what, duration, password) {
  const body = what.kind === 'text'
    ? { kind: 'text', text: what.text, title: what.title, field: what.field, duration, password }
    : { kind: 'file', name: what.name, duration, password };
  try {
    const r = await fetch(withArea('/api/shares'), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (r.status === 400 && (await r.clone().json().catch(() => ({}))).detail?.code === 'share_needs_name') {
        needsNameDialog();
      } else {
        toast(t('ui.share_failed', { reason: await errorText(r) }), true);
      }
      return;
    }
    const rec = await r.json();
    shares = shares.filter((x) => x.id !== rec.id).concat(rec);
    updateShares();
    showLink(rec, password);
  } catch (e) {
    toast(t('ui.share_failed', { reason: t('ui.no_connection') }), true);
  }
}

function readonlyField(value) {
  const input = document.createElement('input');
  input.className = 'share-url';
  input.readOnly = true;
  input.value = value;
  input.onfocus = () => input.select();
  return input;
}

function showLink(rec, password) {
  const url = shareUrl(rec);
  const box = el('div');
  box.appendChild(el('p', '', t(rec.password ? 'ui.link_valid_until_pw' : 'ui.link_valid_until',
    { date: formatDate(rec.expires), remaining: remaining(rec.expires) })));
  box.appendChild(readonlyField(url));
  if (password) {
    box.appendChild(el('p', 'small', t('ui.password_shown_once')));
    box.appendChild(readonlyField(password));
  }
  box.appendChild(el('p', 'small', t('ui.link_manage_hint')));
  const buttons = [{ text: t('ui.close') }];
  if (password) buttons.push({ text: t('ui.copy_password'), action: () => copyWithToast(password, t('ui.password_copied')) });
  buttons.push({ text: t('ui.copy_link'), kind: '', action: () => copyWithToast(url, t('ui.link_copied')) });
  dialog({ title: t('ui.link_created'), content: box, buttons });
}

async function endShare(id) {
  try {
    const r = await fetch('/api/shares/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error(r.status);
    shares = shares.filter((x) => x.id !== id);
    updateShares();
    toast(t('ui.share_ended'));
  } catch (e) {
    toast(t('ui.share_end_failed'), true);
  }
}

function updateShares() {
  const button = $('#btn-shares');
  button.hidden = !sharingEnabled;
  button.classList.toggle('is-public', shares.length > 0);
  button.title = shares.length ? t('ui.shares_reachable', { n: shares.length }) : t('ui.shares_none_reachable');
  $('#shares-count').textContent = shares.length ? num(shares.length) : '';
  drawShares();
  markFields();
  drawList();          // "public" marks in the file list
}

function drawShares() {
  const list = sharesList;
  if (!list || !document.contains(list)) return;
  list.innerHTML = '';
  if (!shares.length) {
    list.appendChild(el('li', 'empty', t('ui.nothing_shared')));
    return;
  }
  shares.slice().sort((a, b) => a.expires - b.expires).forEach((rec) => {
    const li = el('li', 'share');
    const main = el('div', 'share-main');
    const head = el('div', 'share-name');
    // A shared field is named in the viewer's language, by its current position.
    const field = rec.kind === 'text' && inArea(rec) && fieldById(rec.field);
    head.append(el('span', 'tag', t(rec.kind === 'text' ? 'ui.kind_text' : 'ui.kind_file')));
    if (user) head.appendChild(el('span', 'tag', rec.area === 'own' ? user.name : t('ui.area_shared')));
    head.appendChild(el('span', '', field ? fieldName(field) : rec.name));
    if (rec.password) head.appendChild(el('span', 'tag', t('ui.password')));
    main.appendChild(head);
    if (rec.preview) main.appendChild(el('div', 'share-preview', rec.preview));
    const counts = rec.kind === 'text'
      ? t('ui.views', { n: rec.views || 0 })
      : `${t('ui.views', { n: rec.views || 0 })} · ${t('ui.downloads', { n: rec.downloads || 0 })}`;
    main.appendChild(el('div', 'share-meta',
      `${remaining(rec.expires)} (${t('ui.until', { date: formatDate(rec.expires) })}) · ${counts}`));
    li.appendChild(main);

    const buttons = el('div', 'share-buttons');
    const copy = smallButton(t('ui.copy_link'));
    copy.onclick = () => (shareBase() ? copyWithToast(shareUrl(rec), t('ui.link_copied')) : needsNameDialog());
    const end = smallButton(t('ui.end'));
    end.classList.add('danger');
    end.onclick = () => endShare(rec.id);
    buttons.append(copy, end);
    li.appendChild(buttons);
    list.appendChild(li);
  });
}

function showShares() {
  const box = el('div');
  box.appendChild(el('p', '', t('ui.shares_intro')));
  sharesList = el('ul', 'shares-list');
  box.appendChild(sharesList);
  dialog({
    title: t('ui.shares'),
    content: box,
    buttons: [
      { text: t('ui.close') },
      { text: t('ui.end_all'), kind: 'danger', action: () => {
          if (!shares.length) return;
          confirmDialog(t('ui.end_all_title'), t('ui.end_all_text', { n: shares.length }),
            t('ui.end_all'), async () => {
              await fetch('/api/shares', { method: 'DELETE' }).catch(() => {});
              shares = [];
              updateShares();
            });
        } },
    ],
  });
  drawShares();
}

/* What is public must always be visible: field and file row get the same
   "Public" badge and a coloured edge, the shares button at the top changes
   colour. A click on the badge opens the list. */
const inArea         = (r) => (r.area || 'shared') === area;
const sharesForFile  = (name) => shares.filter((r) => inArea(r) && r.kind === 'file' && r.name === name);
const sharesForField = (id) => shares.filter((r) => inArea(r) && r.kind === 'text' && r.field === id);
const latest = (list) => Math.max(...list.map((r) => r.expires));

function badgeText(n) {
  return n > 1 ? t('ui.public_links', { n }) : t('ui.public');
}

function markFields() {
  fields.forEach((f) => {
    const list = sharesForField(f.id);
    const on = list.length > 0;
    f.card.classList.toggle('is-public', on);
    f.badge.hidden = !on;
    if (on) {
      f.badge.textContent = badgeText(list.length);
      f.badge.title = t('ui.field_public_hint', { date: formatDate(latest(list)) });
    }
  });
}

// ------------------------------------------------------------------ File list
function allEntries() {
  const running = [];
  ownUploads.forEach((u) => { if (u.area === area) running.push({ ...u, own: true }); });
  serverUploads.forEach((u) => { if (!ownUploads.has(u.id)) running.push({ ...u, own: false }); });

  const search = ($('#filter').value || '').trim().toLowerCase();
  let list = files.slice();
  if (search) list = list.filter((d) => d.name.toLowerCase().includes(search));

  const order = $('#sort').value;
  list.sort((a, b) => {
    if (order === 'name') return a.name.localeCompare(b.name, locale);
    if (order === 'size') return b.size - a.size;
    if (order === 'old') return a.mtime - b.mtime;
    return b.mtime - a.mtime;
  });
  return { running, list };
}

function drawList() {
  const root = $('#list');
  const { running, list } = allEntries();
  root.innerHTML = '';

  running.forEach((u) => root.appendChild(uploadRow(u)));
  list.forEach((d) => root.appendChild(fileRow(d)));
  const wanted = new Set(files.filter(isImage).map(thumbUrl));
  thumbs.forEach((img, url) => { if (!wanted.has(url)) thumbs.delete(url); });

  $('#empty').hidden = (running.length + list.length) > 0;
  updateSelection();
}

function uploadRow(u) {
  const li = el('li', 'row running');
  li.appendChild(el('span'));                       // placeholder for the checkbox column
  const main = el('div', 'row-main');
  main.appendChild(el('div', 'row-name', u.name));
  const percent = u.size ? Math.min(100, Math.round((u.received / u.size) * 100)) : 0;
  main.appendChild(el('div', 'row-meta', t(u.own ? 'ui.uploading' : 'ui.uploading_elsewhere',
    { percent, done: formatSize(u.received), total: formatSize(u.size) })));
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = percent + '%';
  bar.appendChild(fill);
  main.appendChild(bar);
  li.appendChild(main);
  li.appendChild(el('span', 'row-size', ''));

  const entries = () => [{ text: t('ui.cancel_upload'), kind: 'danger', action: () => cancelUpload(u.id) }];
  const more = el('button', 'more', '⋮');
  more.type = 'button';
  more.setAttribute('aria-label', t('ui.menu'));
  more.onclick = (e) => { e.stopPropagation(); showMenu(e, entries()); };
  li.appendChild(more);
  li.oncontextmenu = (e) => { e.preventDefault(); showMenu(e, entries()); };
  return li;
}

// ------------------------------------------------------------------ Pictures
/* Pictures get a small preview in their row (made by the server, see
   /api/thumb), a large view, and a button that copies the picture itself. */
const THUMB_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const extOf    = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const isImage  = (d) => THUMB_TYPES.includes(extOf(d.name)) || extOf(d.name) === 'svg';
// Loaded by <img> and <a download>, which send no x-drop-as: say it in the address.
const asOpened = (url) => (openedAs ? url + (url.includes('?') ? '&' : '?') + 'as=' + openedAs : url);
const fileUrl  = (name) => asOpened(withArea('/files/' + encodeURIComponent(name)));
const thumbUrl = (d) => (extOf(d.name) === 'svg'      // drawn by the browser, never by the server
  ? fileUrl(d.name)
  : asOpened(withArea(`/api/thumb/${encodeURIComponent(d.name)}?v=${d.size}-${d.mtime}`)));
const thumbs   = new Map();   // url → <img>, reused across redraws so nothing flickers

function thumbFor(d) {
  const url = thumbUrl(d);
  let img = thumbs.get(url);
  if (!img) {
    img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.dataset.failed = '1'; if (img.parentElement) img.parentElement.hidden = true; };
    img.src = url;
    thumbs.set(url, img);
  }
  return img;
}

function fileRow(d) {
  const li = el('li', 'row');
  if (selection.has(d.name)) li.classList.add('selected');
  if (fresh.has(d.name)) {
    li.classList.add('fresh');
    // Rows are redrawn often; continue the fade instead of starting over.
    li.style.animationDelay = -(Date.now() - fresh.get(d.name)) + 'ms';
  }
  const shared = sharesForFile(d.name);
  if (shared.length) li.classList.add('is-public');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = selection.has(d.name);
  check.setAttribute('aria-label', t('ui.select_file', { name: d.name }));
  check.onchange = () => {
    if (check.checked) selection.add(d.name); else selection.delete(d.name);
    li.classList.toggle('selected', check.checked);
    updateSelection();
  };
  li.appendChild(check);

  const body = el('div', 'row-body');
  const image = isImage(d);
  if (image) {
    const img = thumbFor(d);
    if (!img.dataset.failed) {
      const thumb = el('button', 'thumb');
      thumb.type = 'button';
      thumb.title = t('ui.show_image');
      thumb.setAttribute('aria-label', t('ui.show_image') + ': ' + d.name);
      thumb.onclick = () => showImage(d);
      thumb.appendChild(img);
      body.appendChild(thumb);
    }
  }

  const main = el('div', 'row-main');
  const name = el('div', 'row-name', d.name);
  name.tabIndex = 0;
  name.onclick = () => showProperties(d);
  name.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showProperties(d); } };
  main.appendChild(name);
  const meta = el('div', 'row-meta', formatDate(d.mtime));
  if (shared.length) {
    const badge = el('button', 'public-badge', badgeText(shared.length));
    badge.type = 'button';
    badge.title = t('ui.file_public_hint');
    badge.onclick = (e) => { e.stopPropagation(); showShares(); };
    meta.append(' · ', badge, ' ' + t('ui.until', { date: formatDate(latest(shared)) }));
  }
  main.appendChild(meta);
  body.appendChild(main);
  if (image) {
    const copy = smallButton(t('ui.copy'));
    copy.classList.add('copy-image');
    copy.title = t('ui.copy_image');
    copy.onclick = (e) => { e.stopPropagation(); copyImage(d); };
    body.appendChild(copy);
  }
  li.appendChild(body);

  li.appendChild(el('span', 'row-size', formatSize(d.size)));

  const entries = () => ([
    ...(image ? [
      { text: t('ui.show_image'), action: () => showImage(d) },
      { text: t('ui.copy_image'), action: () => copyImage(d) },
    ] : []),
    { text: t('ui.download'), action: () => startDownload([d.name]) },
    { text: t('ui.copy_name'), action: () => copyWithToast(d.name, t('ui.name_copied')) },
    ...(sharingEnabled ? [{ text: t('ui.share_file'), action: () => createShareDialog({ kind: 'file', name: d.name, size: d.size }) }] : []),
    { separator: true },
    { text: t('ui.delete'), kind: 'danger', action: () => deleteFiles([d.name]) },
  ]);

  const more = el('button', 'more', '⋮');
  more.type = 'button';
  more.setAttribute('aria-label', t('ui.menu'));
  more.onclick = (e) => { e.stopPropagation(); showMenu(e, entries()); };
  li.appendChild(more);

  li.oncontextmenu = (e) => { e.preventDefault(); showMenu(e, entries()); };
  return li;
}

function updateSelection() {
  const visible = allEntries().list.map((d) => d.name);
  const present = new Set(files.map((d) => d.name));
  selection.forEach((n) => { if (!present.has(n)) selection.delete(n); });

  const n = selection.size;
  $('#btn-download').disabled = n === 0;
  $('#selection-info').textContent = n === 0 ? t('ui.all') : t('ui.selected', { n });
  const all = $('#select-all');
  all.checked = visible.length > 0 && visible.every((x) => selection.has(x));
  all.indeterminate = !all.checked && n > 0;
}

// ------------------------------------------------------------------ Context menu
function showMenu(event, entries) {
  const menu = $('#menu');
  menu.innerHTML = '';
  entries.forEach((e) => {
    if (e.separator) { menu.appendChild(document.createElement('hr')); return; }
    const b = el('button', e.kind === 'danger' ? 'danger' : '', e.swatch ? undefined : e.text);
    if (e.swatch) {
      const swatch = el('span', 'swatch');
      swatch.dataset.p = e.swatch;
      b.className = 'pick';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(!!e.checked));
      b.append(swatch, el('span', '', e.text));
    }
    b.type = 'button';
    b.onclick = () => { hideMenu(); e.action(); };
    menu.appendChild(b);
  });
  menu.hidden = false;

  const point = event.touches ? event.touches[0] : event;
  let x = point.clientX, y = point.clientY;
  if (!x && !y && event.currentTarget) {
    const r = event.currentTarget.getBoundingClientRect();
    x = r.left; y = r.bottom;
  }
  const box = menu.getBoundingClientRect();
  x = Math.min(x, window.innerWidth - box.width - 8);
  y = Math.min(y, window.innerHeight - box.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';

  setTimeout(() => {
    document.addEventListener('click', hideMenu, { once: true });
    document.addEventListener('scroll', hideMenu, { once: true, capture: true });
  }, 0);
}

function hideMenu() { $('#menu').hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

// ------------------------------------------------------------------ Properties
async function showProperties(d) {
  const box = el('div');
  const dl = el('dl', 'props');
  const row = (k, v) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); return dl.lastChild; };
  row(t('ui.prop_name'), d.name);
  row(t('ui.prop_size'), t('ui.size_bytes', { size: formatSize(d.size), bytes: d.size }));
  row(t('ui.prop_type'), d.name.includes('.') ? d.name.split('.').pop().toUpperCase() : t('ui.no_extension'));
  row(t('ui.prop_added'), formatDate(d.mtime));
  if (sharingEnabled) {
    const shared = sharesForFile(d.name);
    const dd = row(t('ui.prop_internet'), shared.length
      ? t('ui.public_until', { links: t('ui.links_count', { n: shared.length }), date: formatDate(latest(shared)) })
      : t('ui.not_shared'));
    if (shared.length) dd.classList.add('public-text');
  }
  box.appendChild(dl);

  const ext = d.name.split('.').pop().toLowerCase();
  const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'];
  const texts = ['txt', 'md', 'csv', 'log', 'json', 'yaml', 'yml', 'xml', 'ini', 'conf', 'py', 'js', 'sh'];

  if (images.includes(ext) && d.size < 40 * 1024 * 1024) {
    const img = document.createElement('img');
    img.className = 'preview';
    img.src = fileUrl(d.name);
    img.alt = d.name;
    box.appendChild(img);
  } else if (texts.includes(ext) && d.size < 2 * 1024 * 1024) {
    try {
      const r = await fetch(withArea('/api/preview/' + encodeURIComponent(d.name)));
      if (r.ok) box.appendChild(el('pre', 'preview', (await r.json()).text));
    } catch (e) { /* no preview, no drama */ }
  }

  dialog({
    title: t('ui.properties'),
    content: box,
    buttons: [
      { text: t('ui.close') },
      { text: t('ui.delete'), kind: 'danger', action: () => deleteFiles([d.name]) },
      ...(sharingEnabled ? [{ text: t('ui.share'), action: () => createShareDialog({ kind: 'file', name: d.name, size: d.size }) }] : []),
      { text: t('ui.download'), kind: '', action: () => startDownload([d.name]) },
    ],
  });
}

// ------------------------------------------------------------------ Download
function startDownload(names) {
  if (!names.length) return;
  if (names.length >= DOWNLOAD_CONFIRM_AT) {
    confirmDialog(t('ui.many_downloads_title'), t('ui.many_downloads_text', { n: names.length }),
      t('ui.download_anyway'), () => triggerDownloads(names));
    return;
  }
  triggerDownloads(names);
}

/* Several downloads are triggered one after another with a gap. The browser
   does not report when one has finished — true one-by-one is not possible. */
function triggerDownloads(names) {
  const urls = names.map(fileUrl);      // the area shown now, even if it changes meanwhile
  names.forEach((name, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = urls[i];
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    }, i * DOWNLOAD_GAP);
  });
  if (names.length > 1) toast(t('ui.downloads_started', { n: names.length }));
}

// ------------------------------------------------------------------ Deleting
async function deleteFiles(names) {
  const total = files.filter((d) => names.includes(d.name)).reduce((s, d) => s + d.size, 0);
  const what = names.length === 1
    ? tArea('ui.delete_single', { name: names[0] })
    : tArea('ui.delete_many', { n: names.length, size: formatSize(total) });
  confirmDialog(t('ui.delete_title'), what, t('ui.delete'), async () => {
    await fetch(withArea('/api/files'), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names }),
    }).catch(() => {});
    names.forEach((n) => selection.delete(n));
    await loadState();
  });
}

// ------------------------------------------------------------------ Large view
function showImage(d) {
  closeViewer();
  const images = allEntries().list.filter(isImage);
  let index = Math.max(0, images.findIndex((x) => x.name === d.name));

  const viewer = el('div', 'viewer');
  viewer.id = 'viewer';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  const bar = el('div', 'viewer-bar');
  const title = el('div', 'viewer-name');
  const stage = el('div', 'viewer-stage');
  const img = document.createElement('img');
  stage.appendChild(img);

  const button = (text, kind, action) => {
    const b = el('button', 'btn ' + (kind || 'plain'), text);
    b.type = 'button';
    b.onclick = (e) => { e.stopPropagation(); action(); };
    return b;
  };
  const current = () => images[index];
  bar.append(title,
    button(t('ui.copy'), 'primary', () => copyImage(current())),
    button(t('ui.download'), '', () => startDownload([current().name])),
    ...(sharingEnabled ? [button(t('ui.share'), '', () => {
      const x = current(); closeViewer(); createShareDialog({ kind: 'file', name: x.name, size: x.size });
    })] : []),
    button(t('ui.delete'), 'danger plain', () => { const x = current(); closeViewer(); deleteFiles([x.name]); }),
    button('×', 'close', closeViewer));
  bar.lastChild.setAttribute('aria-label', t('ui.close'));

  const nav = (step, label, cls) => {
    const b = el('button', 'viewer-nav ' + cls, step < 0 ? '‹' : '›');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.onclick = (e) => { e.stopPropagation(); go(step); };
    return b;
  };
  if (images.length > 1) stage.append(nav(-1, t('ui.previous_image'), 'prev'), nav(1, t('ui.next_image'), 'next'));

  function show() {
    const x = current();
    title.textContent = `${x.name} · ${formatSize(x.size)}`;
    img.alt = x.name;
    img.src = fileUrl(x.name);
  }
  function go(step) {
    index = (index + step + images.length) % images.length;
    show();
  }
  viewer.onclick = (e) => { if (e.target === stage || e.target === viewer) closeViewer(); };
  let touchX = null;      // swipe to the next or previous picture
  stage.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX === null || images.length < 2) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) go((dx < 0) !== (document.dir === 'rtl') ? 1 : -1);
  });
  viewer.onkey = (e) => {
    if (!$('#dialog-backdrop').hidden) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft' && images.length > 1) go(document.dir === 'rtl' ? 1 : -1);
    else if (e.key === 'ArrowRight' && images.length > 1) go(document.dir === 'rtl' ? -1 : 1);
  };
  document.addEventListener('keydown', viewer.onkey);

  viewer.append(bar, stage);
  document.body.appendChild(viewer);
  show();
  bar.querySelector('button').focus();
}

function closeViewer() {
  const viewer = $('#viewer');
  if (!viewer) return;
  document.removeEventListener('keydown', viewer.onkey);
  viewer.remove();
}

/* Copying a picture needs the Clipboard API, which browsers only offer over
   HTTPS, and reliably only for PNG — anything else is turned into PNG here. */
const COPY_MAX = 50 * 1024 * 1024;

function copyImage(d) {
  if (!window.isSecureContext || !navigator.clipboard || !window.ClipboardItem) {
    toast(t('ui.image_copy_needs_https'), true);
    return;
  }
  if (d.size > COPY_MAX) { toast(t('ui.image_too_large'), true); return; }
  // The promise goes into ClipboardItem at once: Safari only allows the write
  // while the click is still "fresh".
  const png = fetch(fileUrl(d.name))
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
    .then(asPng);
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    .then(() => toast(t('ui.image_copied')))
    .catch(async () => {
      try {   // some browsers want the finished picture instead of a promise
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
        toast(t('ui.image_copied'));
      } catch (e) {
        toast(t('ui.image_copy_failed'), true);
      }
    });
}

async function asPng(blob) {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 1600, h = img.naturalHeight || 1200;
    const scale = Math.min(1, 8192 / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ Paste
/* Ctrl+V / Cmd+V with a picture (or files) in the clipboard uploads it. In a
   text field, text wins: a picture is only taken when there is no text. */
function setupPaste() {
  document.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data || !$('#dialog-backdrop').hidden || $('#viewer')) return;
    let list = Array.from(data.files || []);
    if (!list.length) {
      list = Array.from(data.items || []).filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile()).filter(Boolean);
    }
    if (!list.length) return;
    const typing = e.target.closest && e.target.closest('textarea, input, [contenteditable]');
    if (typing && (data.getData('text/plain') || '').trim()) return;
    e.preventDefault();
    const named = list.map(pastedName);
    toast(named.length === 1 ? t('ui.pasted', { name: named[0].name }) : t('ui.pasted_many', { n: named.length }));
    uploadFiles(named);
  });
}

/* Screenshots arrive as "image.png" or without a name: give them one. */
function pastedName(file, i) {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return new File([file], `${t('ui.screenshot')} ${stamp}${i ? ' ' + (i + 1) : ''}.${ext}`,
    { type: file.type || 'image/png' });
}

// ------------------------------------------------------------------ Upload
// "Delete all files" ends the uploads of the area shown, not those of the other.
function dropOwnUploads() {
  ownUploads.forEach((u, id) => { if (u.area === area) { u.cancelled = true; ownUploads.delete(id); } });
}

function cancelUpload(id) {
  const own = ownUploads.get(id);
  if (own) own.cancelled = true;
  ownUploads.delete(id);
  fetch('/api/upload/' + id, { method: 'DELETE' }).catch(() => {});
  drawList();
}

async function uploadFiles(list) {
  const into = area;      // all of them go where they were dropped, even if another area is shown meanwhile
  for (const file of list) {
    try {
      await uploadFile(file, into);
    } catch (e) {
      toast(t('ui.upload_failed', { name: file.name, reason: e.message }), true);
    }
  }
}

async function uploadFile(file, into) {
  const start = await fetch(withArea('/api/upload/init', into), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    // With the time it was last changed: a changed file of the same name and
    // size starts over instead of being resumed into the old one. Some phones
    // know no such time and say "now" — that is no time to compare.
    body: JSON.stringify({
      name: file.name, size: file.size,
      modified: Math.abs(Date.now() - file.lastModified) > 10000 ? file.lastModified : null,
    }),
  }).catch(() => null);
  if (!start || !start.ok) {
    throw new Error(t(start && start.status === 507 ? 'ui.error_no_space' : 'ui.upload_refused'));
  }
  const init = await start.json();
  chunkSize = init.chunk_size;

  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const done = new Set(init.chunks || []);
  const entry = {
    id: init.id, area: into, name: file.name, size: file.size,
    received: Math.min(file.size, done.size * chunkSize),
    cancelled: false,
  };
  ownUploads.set(init.id, entry);
  drawList();
  if (init.resumed) toast(t('ui.upload_resumed', { name: file.name }));

  const open = [];
  for (let i = 0; i < totalChunks; i++) if (!done.has(i)) open.push(i);

  let next = 0;
  let failure = null;

  async function worker() {
    while (true) {
      if (failure || entry.cancelled) return;
      const pos = next++;
      if (pos >= open.length) return;
      const index = open[pos];
      const from = index * chunkSize;
      const to = Math.min(file.size, from + chunkSize);

      let attempt = 0;
      while (true) {
        if (entry.cancelled) return;
        try {
          const response = await fetch(`/api/upload/${init.id}/${index}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: file.slice(from, to),
          });
          if (response.status === 404) {
            // The upload no longer exists — someone deleted everything in the
            // meantime. Retrying does not help.
            entry.cancelled = true;
            return;
          }
          if (!response.ok) throw new Error('HTTP ' + response.status);
          break;
        } catch (e) {
          attempt++;
          if (attempt >= CHUNK_ATTEMPTS) { failure = e; return; }
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }

      entry.received = Math.min(file.size, entry.received + (to - from));
      drawList();
    }
  }

  await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));

  if (entry.cancelled) { ownUploads.delete(init.id); drawList(); return; }
  if (failure) {
    ownUploads.delete(init.id);
    drawList();
    throw new Error(t('ui.upload_interrupted'));
  }

  const end = await fetch(`/api/upload/${init.id}/done`, { method: 'POST' }).catch(() => null);
  ownUploads.delete(init.id);
  if (!end || !end.ok) { drawList(); throw new Error(t('ui.upload_finish_failed')); }
  const data = await end.json();
  if (data.name !== file.name) toast(t('ui.upload_renamed', { name: data.name }));
  await loadState();
}

// ------------------------------------------------------------------ Drag and drop
function folderHint() {
  dialog({
    title: t('ui.folders_title'),
    content: [t('ui.folders_text', { app: appName }), t('ui.folders_mac'), t('ui.folders_windows')],
    buttons: [{ text: t('ui.got_it') }, { text: t('ui.open_help'), kind: '', action: showHelp }],
  });
}

function setupDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++; overlay.classList.add('on');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('on'); });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0; overlay.classList.remove('on');
    if (!e.dataTransfer) return;

    // Read the entries synchronously — after an await they are gone.
    const items = e.dataTransfer.items ? Array.from(e.dataTransfer.items) : [];
    let hadFolder = false;
    const pending = [];

    let usedEntries = false;
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (entry) {
        usedEntries = true;
        if (entry.isDirectory) { hadFolder = true; continue; }
        pending.push(new Promise((resolve) => entry.file(resolve, () => resolve(null))));
      }
    }

    let list;
    if (usedEntries) {
      list = (await Promise.all(pending)).filter(Boolean);
    } else {
      list = Array.from(e.dataTransfer.files || []);
    }

    if (hadFolder && !list.length) { folderHint(); return; }
    if (hadFolder) toast(t('ui.folders_skipped'), true);
    if (list.length) uploadFiles(list);
  });
}

// ------------------------------------------------------------------ Light and dark
/* Automatic follows the system; light and dark are kept per browser. The
   button shows the current choice and moves on to the next one. */
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'auto';
}

// ☀ and ☾: the one the page shows is marked; one chosen by hand is filled,
// and a second click on it goes back to automatic.
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const chosen = currentTheme();
  const shown = chosen === 'auto' ? (systemDark.matches ? 'dark' : 'light') : chosen;
  const group = $('#theme-switch');
  group.setAttribute('aria-label', t(`ui.theme_${chosen}`));
  group.querySelectorAll('button').forEach((b) => {
    const mode = b.dataset.mode;
    const label = mode === chosen ? `${t(`ui.theme_${mode}`)} — ${t('ui.theme_again')}` : t(`ui.theme_${mode}`);
    b.setAttribute('aria-pressed', String(mode === chosen));
    b.classList.toggle('shown', mode === shown);
    b.title = label;
    b.setAttribute('aria-label', label);
  });
}

function chooseTheme(mode) {
  const theme = mode === currentTheme() ? 'auto' : mode;
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch (e) { /* not kept, but still switched for now */ }
  applyTheme(theme);
}

// ------------------------------------------------------------------ Colour layouts
/* Without users each browser picks one of five; with users it is the user's,
   set by the server. Light and dark work as before in every one of them. */
function currentPalette() {
  return document.documentElement.dataset.palette || 'teal';
}

function applyPalette(palette) {
  const root = document.documentElement;
  if (PALETTES.includes(palette) && palette !== 'teal') root.dataset.palette = palette;
  else delete root.dataset.palette;
  const button = $('#btn-palette');
  $('#palette-swatch').dataset.p = currentPalette();
  const label = `${t('ui.palette')}: ${t('ui.palette_' + currentPalette())}`;
  button.title = label;
  button.setAttribute('aria-label', label);
}

function choosePalette(palette) {
  try {
    if (palette === 'teal') localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch (e) { /* not kept, but switched for now */ }
  applyPalette(palette);
}

function showPalettes(event) {
  showMenu(event, PALETTES.map((p) => ({
    text: t('ui.palette_' + p), swatch: p, checked: p === currentPalette(), action: () => choosePalette(p),
  })));
}

// ------------------------------------------------------------------ Areas
/* With users: the own area (only this user sees it) and the shared one. The
   tabs at the top switch; whatever is typed goes out to the area it was typed
   in, uploads keep running in theirs. */
function showAreas() {
  $('#areas').hidden = !user;
  if (!user) return;
  $('#user-name').textContent = user.name;
  $('#user-initial').textContent = (Array.from(user.name)[0] || '').toUpperCase();
  ['own', 'shared'].forEach((which) => {
    const tab = $('#tab-' + which);
    tab.setAttribute('aria-selected', String(which === area));
    if (which === area) { tab.classList.remove('has-news'); tab.title = ''; }
  });
  $('#area-hint').textContent = t(area === 'own' ? 'ui.area_own_hint' : 'ui.area_shared_hint');
}

function markNews(which) {
  const tab = $('#tab-' + which);
  if (!tab || which === area) return;
  tab.classList.add('has-news');
  tab.title = t('ui.area_news');
}

async function switchArea(next) {
  if (!user || next === area || (next !== 'own' && next !== 'shared')) return;
  fields.forEach((f) => { if (f.timer || f.maxTimer) save(f); });
  fields.slice().forEach(unmountField);
  closeViewer();
  hideMenu();
  area = next;
  try { localStorage.setItem(AREA_KEY, area); } catch (e) {}
  files = [];
  filesLoaded = false;
  serverUploads = new Map();
  selection.clear();
  fresh.clear();
  thumbs.clear();
  $('#filter').value = '';
  firstLoad = true;          // drafts of fields removed meanwhile, in this area
  showAreas();
  updateShares();            // marks and the file list, for this area
  updateCallButton();
  sendPresence();            // the room only in the shared area
  await loadState();
}

// ------------------------------------------------------------------ QR code
// The address of this page as a QR code, for the phone's camera. Only Drop in
// the home network has it; drop-share serves nothing of this page.
function showQr() {
  const url = location.origin + '/';
  const box = el('div', 'qr');
  const code = el('div', 'qr-code');
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    code.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  } catch (e) { code.hidden = true; }
  box.append(code, el('div', 'qr-url', url), el('p', 'qr-hint', t('ui.qr_hint')));
  dialog({ title: t('ui.qr_open'), content: box, buttons: [{ text: t('ui.close') }] });
}

// ------------------------------------------------------------------ Help
async function showHelp() {
  let html = '';
  try {
    const r = await fetch('/api/help?lang=' + encodeURIComponent(lang));
    if (r.ok) html = await r.text();
  } catch (e) { /* the fallback text then */ }
  // The help file is part of the installation, not user content — HTML is fine.
  const box = el('div');
  if (html) box.innerHTML = html; else box.appendChild(el('p', '', t('ui.help_missing')));
  dialog({ title: t('ui.help'), content: box, buttons: [{ text: t('ui.close') }] });
}

// ------------------------------------------------------------------ Live room
/* Video and voice in the home network, as one room per Drop. Someone goes
   live; everyone else sees a tile above the text fields and joins with a
   click. Picture and sound go straight from browser to browser (WebRTC, every
   member connected to every other one); Drop only passes on the messages that
   set the connections up (see Live room in main.py). No server outside the
   network is asked for anything: in a LAN the browsers find each other by
   their own addresses. Browsers give camera and microphone only to pages
   opened over HTTPS — over plain HTTP the tile explains that instead. With
   users, the room belongs to the shared area. */
const CALL_NAME_KEY  = 'drop.device';           // this device's name, as the others see it
const CALL_DROPOUT   = 12000;                   // ms a broken connection may take to come back
const CALL_SETUP     = 25000;                   // ms until picture and sound flow to a member
const CALL_TRIES     = 3;                       // connections to one member before giving up
const ALONE_ASK      = 5 * 60 * 1000;           // ms alone in the room until "Still there?"
const ALONE_WAIT     = 2 * 60 * 1000;           // … and without an answer, until the page leaves
const callable       = window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
                       && 'RTCPeerConnection' in window;
// Who this page is in the room: a secret of its own, the others only see a hash of it.
const callSecret     = (() => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
})();
let peers            = [];                      // the other pages that can take part now
let peersList        = null;                    // the <ul> in an open dialog, see drawPeers
let peersAction      = null;                    // … and what its buttons do
let room             = null;                    // the room as the server sees it; null: nobody is live
let live             = null;                    // this page in the room, see joinRoom
let preview          = null;                    // outside the room: its small picture, see updatePreview
let audioContext     = null;

const callShown      = () => !usersOn || area === 'shared';

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'Chromebook'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ') || 'Browser';
}

function deviceName() {
  try { return (localStorage.getItem(CALL_NAME_KEY) || '').trim(); } catch (e) { return ''; }
}

// With users: the person first, then which of their devices.
const peerTitle = (p) => p.user || p.name || p.device;
function peerSubtitle(p) {
  return (p.user ? [p.name, p.device] : [p.name ? p.device : '']).filter(Boolean).join(' · ');
}
function peerInitial(p) {
  return (Array.from(p.user || peerTitle(p))[0] || '?').toUpperCase();
}
function avatarOf(p, cls) {
  const avatar = el('span', 'initial' + (cls ? ' ' + cls : ''), peerInitial(p));
  if (p.palette) avatar.dataset.p = p.palette;
  return avatar;
}

const roomMembers = () => (room ? room.members : []);
const memberOf    = (id) => roomMembers().find((m) => m.id === id) || null;
const memberName  = (id) => { const m = memberOf(id); return m ? peerTitle(m) : '?'; };
const roomFull    = () => !!room && room.members.length >= room.max;

async function callPost(path, body) {
  const r = await fetch('/api/call/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peer: callSecret, ...body }),
  });
  if (!r.ok) {
    // Coded errors have a text in the language file. Anything else (a page
    // gone, the room ended meanwhile) means: no longer reachable.
    let code = '';
    try { code = ((await r.json()).detail || {}).code || ''; } catch (e) { /* no JSON */ }
    const error = new Error(t(strings['ui.error_' + code] !== undefined ? 'ui.error_' + code : 'ui.error_call_gone'));
    error.status = r.status;
    throw error;
  }
  return r.json();
}

// Can take part right now: over HTTPS, in the shared area, live updates on.
// It also says whether this page is in the room — the server takes out one
// whose leaving got lost, and tells this page if it was taken out meanwhile.
// While joining it says nothing about that: the join is on its way.
function sendPresence() {
  if (!callable || !source || source.readyState !== 1) return;
  const l = live;
  callPost('presence', {
    name: deviceName(), device: deviceLabel(), available: callShown(),
    live: l ? (l.joined ? true : undefined) : false,
  }).then((d) => {
    if (l && live === l && l.joined && !d.live) leaveLocally(t('ui.live_ended'));
  }).catch(() => {});
}

function updateCallButton() {
  const button = $('#btn-call');
  button.hidden = !callShown();
  // No number on the button: it read like something unanswered. Who is there
  // is in the dialog; tests and the curious find the count here.
  button.dataset.peers = callable ? peers.length : 0;
  button.title = t('ui.call_title');
  updatePreview();
  drawLiveTile();
}

// ---- The tile above the text fields: someone is live, join with a click.
function drawLiveTile() {
  const tile = $('#live');
  if (!tile) return;
  const r = room;
  tile.hidden = !r || !callShown();
  tile.innerHTML = '';
  if (tile.hidden) return;
  const inside = !!(live && live.joined);
  tile.classList.toggle('inside', inside);
  tile.dataset.members = r.members.length;

  const faces = el('div', 'live-faces');
  r.members.slice(0, 4).forEach((m) => faces.appendChild(avatarOf(m)));
  if (r.members.length > 4) faces.appendChild(el('span', 'initial plus', '+' + (r.members.length - 4)));

  const text = el('div', 'live-text');
  const head = el('div', 'live-head');
  head.append(el('span', 'live-badge', t('ui.live_badge')),
    el('span', 'live-count', t('ui.live_people', { n: r.members.length })));
  if (r.locked) head.appendChild(el('span', 'live-flag', t('ui.live_locked')));
  text.append(head, el('div', 'live-names', inside ? t('ui.live_you_in')
    : r.members.map(peerTitle).join(', ')));

  const actions = el('div', 'live-actions');
  if (inside) {
    if (live.mini) {
      const back = smallButton(t('ui.call_larger'));
      back.onclick = () => setMini(false);
      actions.appendChild(back);
    }
  } else if (r.locked || roomFull()) {
    if (!r.locked) actions.appendChild(el('span', 'live-note', t('ui.error_call_full')));
  } else {
    const voice = smallButton(t('ui.call_voice'));
    const video = smallButton(t('ui.call_video'));
    video.classList.remove('plain');
    voice.onclick = () => joinRoom(false);
    video.onclick = () => joinRoom(true);
    voice.disabled = video.disabled = !!live;
    actions.append(voice, video);
  }
  const picture = preview && !inside && preview.stream.getVideoTracks().some((x) => !x.muted);
  if (picture) {
    if (previewVideo.srcObject !== preview.stream) previewVideo.srcObject = preview.stream;
    previewVideo.play().catch(() => {});
  }
  tile.classList.toggle('with-picture', !!picture);
  tile.append(picture ? previewVideo : faces, text, actions);
}

// ---- The header button: go live, or join; who is there; this device's name.
function showLive() {
  if (live) { setMini(false); return; }
  if (!callable) { showHttpsNote(); return; }
  unlockSound();
  const box = el('div', 'calls');
  box.appendChild(el('p', '', t('ui.live_intro')));
  box.appendChild(el('div', 'peers-head', t('ui.live_here')));
  peersList = el('ul', 'peers');
  peersAction = null;
  box.appendChild(peersList);
  box.appendChild(nameField());
  const open = !room || !(room.locked || roomFull());
  const buttons = [{ text: t('ui.close') }];
  if (open) {
    buttons.push({ text: t('ui.call_voice'), action: () => joinRoom(false) },
      { text: t('ui.call_video'), kind: 'go', action: () => joinRoom(true) });
  } else {
    box.appendChild(el('p', 'live-note', t(room.locked ? 'ui.error_call_locked' : 'ui.error_call_full')));
  }
  dialog({ title: t(room ? 'ui.live_join_title' : 'ui.live_go'), content: box, buttons });
  drawPeers();
}

function showHttpsNote() {
  dialog({ title: t('ui.call_https_title'), content: [t('ui.call_https_text')] });
}

function nameField() {
  const own = el('label', 'call-own');
  own.appendChild(el('span', '', t('ui.call_my_name')));
  const input = el('input');
  input.type = 'text';
  input.maxLength = 40;
  input.placeholder = deviceLabel();
  input.value = deviceName();
  input.autocomplete = 'off';
  input.onchange = () => {
    try { localStorage.setItem(CALL_NAME_KEY, input.value.trim()); } catch (e) {}
    sendPresence();
  };
  own.appendChild(input);
  return own;
}

// From inside the room: nudge someone who has Drop open — a short ring there.
function showInvite() {
  const box = el('div', 'calls');
  box.appendChild(el('p', '', t('ui.live_invite_intro')));
  peersList = el('ul', 'peers');
  peersAction = { text: t('ui.live_nudge'), run: nudge };
  box.appendChild(peersList);
  if (room && room.owner === live.you) {
    const lock = el('label', 'live-lock');
    const box2 = el('input');
    box2.type = 'checkbox';
    box2.checked = room.locked;
    box2.onchange = () => {
      callPost('lock', { locked: box2.checked }).catch((e) => { box2.checked = !box2.checked; toast(e.message, true); });
    };
    lock.append(box2, el('span', '', t('ui.live_lock')));
    box.appendChild(lock);
  }
  dialog({ title: t('ui.live_invite'), content: box, buttons: [{ text: t('ui.close') }] });
  drawPeers();
}

async function nudge(p, button) {
  button.disabled = true;
  try {
    await callPost('nudge', { to: p.id });
    toast(t('ui.live_nudged', { name: peerTitle(p) }));
  } catch (e) {
    button.disabled = false;
    toast(e.message, true);
  }
}

function drawPeers() {
  const list = peersList;
  if (!list || !document.contains(list)) return;
  list.innerHTML = '';
  const shown = peersAction ? peers.filter((p) => !p.live) : peers;
  if (!shown.length) {
    list.appendChild(el('li', 'empty', t('ui.call_none') + (usersOn ? ' ' + t('ui.call_none_users') : '')));
    return;
  }
  shown.slice().sort((a, b) => peerTitle(a).localeCompare(peerTitle(b), locale)).forEach((p) => {
    const li = el('li', 'peer');
    const main = el('div', 'peer-main');
    main.appendChild(el('div', 'peer-name', peerTitle(p)));
    const sub = peerSubtitle(p);
    if (sub) main.appendChild(el('div', 'peer-meta', sub));
    li.append(avatarOf(p), main);
    if (p.live) li.appendChild(el('span', 'live-badge', t('ui.live_badge')));
    if (peersAction) {
      const b = smallButton(peersAction.text);
      b.onclick = () => peersAction.run(p, b);
      li.appendChild(b);
    }
    list.appendChild(li);
  });
}

function hideDialog() {
  const backdrop = $('#dialog-backdrop');
  if (!backdrop.hidden) backdrop.click();
  backdrop.hidden = true;
}

// The room as the server sends it: the tile, and in the room the screen.
function setRoom(next, quiet) {
  const before = room;
  room = next || null;
  if (!before && room && !live && callShown() && !quiet) {
    beep([660, 880], 0.22);
    toast(t('ui.live_started', { name: peerTitle(room.members[0]) }));
  }
  const l = live;
  if (l && l.joined) {
    if (!room || !memberOf(l.you)) { leaveLocally(t('ui.live_ended')); return; }
    // Someone gone whose leaving did not reach this page: let go of them too.
    l.links.forEach((k, id) => { if (!memberOf(id)) { closeLink(k); l.links.delete(id); } });
    tuneSenders();
    drawCallScreen();
  }
  updateCallButton();
  drawPeers();
}

/* ---- The preview: outside the room, the tile shows the picture of the first
   member with a camera on — small, without sound, at most PREVIEW_FPS. The
   room sees how many watch (the eye at the top); a locked room shows none.
   Only while this page is visible: a tab in the background costs the member
   a connection for nothing. */
const PREVIEW_HEIGHT = 240;
const PREVIEW_FPS    = 10;
const previewVideo   = (() => {
  const v = document.createElement('video');
  v.className = 'live-preview';
  v.muted = true;
  v.autoplay = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  return v;
})();
let previewQueue     = Promise.resolve();       // one change after the other
let previewPause     = 0;                       // after a failure: not again before this

function previewWanted() {
  if (!room || live || !callable || !callShown() || room.locked || document.visibilityState !== 'visible'
      || !source || source.readyState !== 1 || Date.now() < previewPause) return null;
  const m = room.members.find((x) => x.video);
  return m ? m.id : null;
}

function updatePreview() {
  previewQueue = previewQueue.then(async () => {
    const want = previewWanted();
    if (preview && preview.source === want) return;
    if (preview) await stopPreview(true);
    if (want) await startPreview(want);
  }).catch(() => {});
}

async function startPreview(id) {
  const p = preview = { source: id, pc: null, stream: new MediaStream(), pendingIce: [] };
  try {
    await callPost('watch', { on: true });
    if (preview !== p) return;
    const pc = p.pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      p.stream.addTrack(e.track);
      e.track.onunmute = () => drawLiveTile();
      e.track.onmute = () => drawLiveTile();
      drawLiveTile();
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) callPost('signal', { to: id, type: 'ice', preview: true, data: e.candidate.toJSON() }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (preview === p && pc.connectionState === 'failed') previewFailed();
    };
    await pc.setLocalDescription(await pc.createOffer());
    await callPost('signal', { to: id, type: 'offer', preview: true, data: pc.localDescription.toJSON() });
  } catch (e) {
    if (preview !== p) return;
    // Locked or full meanwhile: the room's next card decides, no pause for that.
    if (e.status === 423 || e.status === 409) { preview = null; drawLiveTile(); } else previewFailed();
  }
}

async function stopPreview(tell) {
  const p = preview;
  if (!p) return;
  preview = null;
  try { if (p.pc) p.pc.close(); } catch (e) {}
  previewVideo.srcObject = null;
  drawLiveTile();
  if (tell) await callPost('watch', { on: false }).catch(() => {});
}

// No preview then — the tile still says who is live. Another try later.
function previewFailed() {
  previewPause = Date.now() + 20000;
  stopPreview(true);
  setTimeout(updatePreview, 20500);
}

function onPreviewEvent(d) {
  const p = preview;
  if (d.type === 'unwatch' || (d.type === 'left' && d.from === p.source)) {
    stopPreview(false);                // the room's next card says what to show instead
    return;
  }
  if (!d.preview || d.from !== p.source || !p.pc) return;
  if (d.type === 'answer') {
    p.pc.setRemoteDescription(d.data).then(() => {
      p.pendingIce.splice(0).forEach((x) => p.pc.addIceCandidate(x).catch(() => {}));
    }).catch(() => previewFailed());
  } else if (d.type === 'ice') {
    if (p.pc.remoteDescription) p.pc.addIceCandidate(d.data).catch(() => {});
    else p.pendingIce.push(d.data);
  }
}

// In the room: a page outside wants the preview — only the picture, small.
async function onWatcherEvent(d) {
  const l = live;
  const old = l.watchers.get(d.from);
  if (d.type === 'unwatch') {
    if (old) { try { old.close(); } catch (e) {} l.watchers.delete(d.from); }
    return;
  }
  if (d.type === 'ice') {
    if (old) old.addIceCandidate(d.data).catch(() => {});
    return;
  }
  if (d.type !== 'offer') return;
  if (old) { try { old.close(); } catch (e) {} }
  const pc = new RTCPeerConnection({ iceServers: [] });
  l.watchers.set(d.from, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) callPost('signal', { to: d.from, type: 'ice', preview: true, data: e.candidate.toJSON() }).catch(() => {});
  };
  try {
    await pc.setRemoteDescription(d.data);
    const tr = pc.getTransceivers()[0];
    tr.direction = 'sendonly';
    await tr.sender.replaceTrack(l.stream.getVideoTracks()[0] || null);
    await pc.setLocalDescription(await pc.createAnswer());
    await callPost('signal', { to: d.from, type: 'answer', preview: true, data: pc.localDescription.toJSON() });
    const params = tr.sender.getParameters();
    if (params.encodings && params.encodings.length) {
      const track = l.stream.getVideoTracks()[0];
      const height = (track && track.getSettings && track.getSettings().height) || 720;
      Object.assign(params.encodings[0], { scaleResolutionDownBy: Math.max(1, height / PREVIEW_HEIGHT),
        maxFramerate: PREVIEW_FPS, maxBitrate: 150000 });
      tr.sender.setParameters(params).catch(() => {});
    }
  } catch (e) {
    try { pc.close(); } catch (x) {}
    l.watchers.delete(d.from);
  }
}

/* ---- After an update: a page loaded before it still runs the old code. It
   notices by the build in /api/state and loads itself again — but not in
   the middle of the room or of an upload; then once those are over. */
let pageBuild        = null;
let reloadPending    = false;

function checkBuild(build) {
  if (!build) return;
  if (!pageBuild) { pageBuild = build; return; }
  if (build !== pageBuild && !reloadPending) {
    reloadPending = true;
    setInterval(reloadWhenIdle, 3000);   // uploads end in many places; just look again
    reloadWhenIdle();
  }
}

function reloadWhenIdle() {
  if (!reloadPending || live || ownUploads.size) return;
  fields.forEach((f) => { if (f.timer || f.maxTimer) save(f); });   // drafts stay in the browser anyway
  setTimeout(() => location.reload(), 300);
}

// ---- Sound: browsers only play after a touch or click on the page, so the
// first one anywhere unlocks it.
function unlockSound() {
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
  } catch (e) { audioContext = null; }
}

function beep(frequencies, seconds) {
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
  gain.gain.setValueAtTime(0.18, now + seconds - 0.05);
  gain.gain.linearRampToValueAtTime(0, now + seconds);
  gain.connect(audioContext.destination);
  frequencies.forEach((f) => {
    const osc = audioContext.createOscillator();
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + seconds);
  });
}

// Nudged from inside the room: a short ring, and the way in.
function nudged(from) {
  if (live) return;
  beep([660, 880], 0.35);
  setTimeout(() => beep([660, 880], 0.35), 450);
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  const name = peerTitle(from);
  dialog({
    title: t('ui.live_nudge_title', { name }),
    content: [t('ui.live_nudge_text', { name })],
    buttons: [{ text: t('ui.live_later') },
      { text: t('ui.call_voice'), action: () => joinRoom(false) },
      { text: t('ui.call_video'), kind: 'go', action: () => joinRoom(true) }],
  });
}

// ---- Camera and microphone
async function getMedia(video, facing = 'user') {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const camera = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: video ? camera : false });
  } catch (e) {
    // No camera, or not allowed: then at least with sound.
    if (video) return navigator.mediaDevices.getUserMedia({ audio, video: false });
    throw e;
  }
}

// What this page shows of its own camera, and how many there are to switch between.
async function cameraChanged(l) {
  l.cameraOn = l.stream.getVideoTracks().length > 0;
  l.preview = l.cameraOn ? new MediaStream(l.stream.getVideoTracks()) : null;
  try {
    l.cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
  } catch (e) { l.cameras = 0; }
  if (live === l) { tuneSenders(); drawCallScreen(); }
}

// ---- Joining and leaving
async function joinRoom(video) {
  if (live) { setMini(false); return; }
  if (!callable) { showHttpsNote(); return; }
  hideDialog();
  unlockSound();
  stopPreview(false);                  // the server ends it with the join
  const l = live = {
    you: null, joined: false, ended: false, stream: null, preview: null, links: new Map(),
    micOn: true, cameraOn: false, facing: 'user', cameras: 0, cameraBusy: false,
    mini: false, focus: null, since: 0, clock: null, levels: null, wakeLock: null, quality: null,
    tiles: new Map(), tries: new Map(), toldFailed: false, aloneSince: 0, askedAt: 0, askBox: null,
    watchers: new Map(),
  };
  showCallScreen();
  try {
    l.stream = await getMedia(video);
  } catch (e) {
    leaveLocally(t('ui.call_no_media'), true);
    return;
  }
  if (live !== l) { l.stream.getTracks().forEach((x) => x.stop()); return; }
  await cameraChanged(l);
  try {
    const d = await callPost('join', { video: l.cameraOn, audio: true });
    if (live !== l) { callPost('leave', {}).catch(() => {}); return; }
    l.you = d.you;
    l.joined = true;
    l.since = Date.now();
    l.clock = setInterval(() => { drawCallClock(); checkAlone(); }, 1000);
    l.levels = setInterval(drawSpeaking, 400);
    keepAwake();
    setRoom(d.room, true);
    // The newcomer connects to everyone already there; they wait for it.
    d.connect.forEach((id) => connectTo(id, true));
    drawCallScreen();
  } catch (e) {
    leaveLocally(e.message, true);
  }
}

function leaveRoom() {
  const l = live;
  if (!l) return;
  if (l.joined) callPost('leave', {}).catch(() => {});
  leaveLocally('');
}

function leaveLocally(message, warn) {
  const l = live;
  if (!l || l.ended) return;
  l.ended = true;
  l.links.forEach(closeLink);
  l.links.clear();
  l.watchers.forEach((pc) => { try { pc.close(); } catch (e) {} });
  l.watchers.clear();
  clearInterval(l.clock);
  clearInterval(l.levels);
  if (l.stream) l.stream.getTracks().forEach((x) => x.stop());
  if (l.wakeLock) l.wakeLock.release().catch(() => {});
  const screen = $('#call');
  if (screen) screen.remove();
  live = null;
  if (message) toast(message, warn);
  updateCallButton();
  drawPeers();
  sendPresence();
  reloadWhenIdle();
}

// What the server passes on from the others.
function onCallEvent(d) {
  if (d.type === 'nudge') { nudged(d.from); return; }
  if (!live && preview) { onPreviewEvent(d); return; }
  if (live && live.joined && (d.preview || d.type === 'unwatch')) { onWatcherEvent(d); return; }
  const l = live;
  // Messages can come before this page's own join has its answer — only the
  // camera has to be ready, the connections are set up with it.
  if (!l || !l.stream || l.ended) return;
  let k = l.links.get(d.from);
  switch (d.type) {
    case 'joined':
      beep([880], 0.12);
      toast(t('ui.live_joined', { name: peerTitle(d.from) }));
      break;
    case 'left':
      if (k) { closeLink(k); l.links.delete(d.from); }
      toast(t('ui.live_left', { name: memberName(d.from) }));
      tuneSenders();
      drawCallScreen();
      break;
    case 'offer':
      // Another offer: the other side starts over (see linkFailed) — so do we.
      if (k && (k.pc.remoteDescription || k.pc.signalingState === 'closed')) { closeLink(k); l.links.delete(d.from); k = null; }
      takeOffer(k || connectTo(d.from, false), d.data);
      break;
    case 'answer':
      if (k) k.pc.setRemoteDescription(d.data).then(() => flushIce(k)).catch(() => linkFailed(k));
      break;
    case 'ice':
      if (!k) break;
      if (k.pc.remoteDescription) k.pc.addIceCandidate(d.data).catch(() => {});
      else k.pendingIce.push(d.data);
      break;
    case 'photo': toast(t('ui.call_photo_by', { name: memberName(d.from) })); break;
    default: break;
  }
}

// ---- One connection per other member
function connectTo(id, offerer) {
  const l = live;
  const existing = l.links.get(id);
  if (existing) return existing;
  // No STUN or TURN server: in the home network the devices reach each other
  // by their own addresses, and nothing goes outside.
  const pc = new RTCPeerConnection({ iceServers: [] });
  const k = {
    id, pc, offerer, senders: {}, remote: new MediaStream(), pendingIce: [], state: 'connecting',
    setup: null, dropout: null, wasLive: false, audio: null, speaking: false,
  };
  l.links.set(id, k);
  pc.onicecandidate = (e) => {
    if (e.candidate) callPost('signal', { to: id, type: 'ice', data: e.candidate.toJSON() }).catch(() => {});
  };
  pc.ontrack = (e) => {
    k.remote.addTrack(e.track);
    e.track.onunmute = () => drawCallScreen();
    e.track.onmute = () => drawCallScreen();
    drawCallScreen();
  };
  pc.onconnectionstatechange = () => {
    if (live !== l || l.links.get(id) !== k) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      clearTimeout(k.dropout); clearTimeout(k.setup);
      k.state = 'live';
      k.wasLive = true;
      live.tries.delete(id);
      tuneSenders();
    } else if (s === 'disconnected') {
      k.state = 'dropout';
      clearTimeout(k.dropout);
      k.dropout = setTimeout(() => { if (k.state === 'dropout') linkFailed(k); }, CALL_DROPOUT);
    } else if (s === 'failed') {
      linkFailed(k);
    }
    drawCallScreen();
  };
  k.setup = setTimeout(() => { if (live === l && k.state === 'connecting') linkFailed(k); }, CALL_SETUP);
  if (offerer) makeOffer(k);
  drawCallScreen();
  return k;
}

function closeLink(k) {
  clearTimeout(k.setup);
  clearTimeout(k.dropout);
  try { k.pc.close(); } catch (e) {}
  if (k.audio) { k.audio.srcObject = null; k.audio.remove(); }
}

// Lost, or never there: the one who set the connection up starts over with a
// new one, CALL_TRIES times in all; then the tile says there is no connection
// — the others in the room are not affected.
function linkFailed(k) {
  const l = live;
  if (!l || l.links.get(k.id) !== k || k.state === 'failed') return;
  clearTimeout(k.setup);
  clearTimeout(k.dropout);
  const tries = (l.tries.get(k.id) || 1);
  k.state = 'failed';
  try { k.pc.close(); } catch (e) {}
  if (k.offerer && tries < CALL_TRIES) {
    l.tries.set(k.id, tries + 1);
    k.state = 'dropout';
    setTimeout(() => {
      if (live !== l || l.links.get(k.id) !== k || !memberOf(k.id)) return;
      closeLink(k);
      l.links.delete(k.id);
      connectTo(k.id, true);
    }, 1500);
  } else if (k.offerer && !k.wasLive && !l.toldFailed) {
    // Never connected: say why that may be — once, not for every member.
    l.toldFailed = true;
    toast(t('ui.call_failed'), true);
  }
  drawCallScreen();
}

function addLocalTracks(k, transceivers) {
  const audio = live.stream.getAudioTracks()[0] || null;
  const video = live.stream.getVideoTracks()[0] || null;
  transceivers.forEach((tr) => {
    const kind = tr.receiver.track.kind;
    tr.direction = 'sendrecv';
    k.senders[kind] = tr.sender;
    tr.sender.replaceTrack(kind === 'audio' ? audio : video).catch(() => {});
  });
}

// Always one audio and one video channel, even without a camera: switching the
// camera on later, or to the other one, then needs no new negotiation.
async function makeOffer(k) {
  try {
    addLocalTracks(k, [k.pc.addTransceiver('audio'), k.pc.addTransceiver('video')]);
    await k.pc.setLocalDescription(await k.pc.createOffer());
    await callPost('signal', { to: k.id, type: 'offer', data: k.pc.localDescription.toJSON() });
  } catch (e) { linkFailed(k); }
}

async function takeOffer(k, offer) {
  try {
    const first = !k.pc.remoteDescription;
    await k.pc.setRemoteDescription(offer);
    if (first) addLocalTracks(k, k.pc.getTransceivers());
    await k.pc.setLocalDescription(await k.pc.createAnswer());
    await callPost('signal', { to: k.id, type: 'answer', data: k.pc.localDescription.toJSON() });
    flushIce(k);
    tuneSenders();
  } catch (e) { linkFailed(k); }
}

function flushIce(k) {
  k.pendingIce.splice(0).forEach((x) => k.pc.addIceCandidate(x).catch(() => {}));
}

/* The more people, the smaller this page's picture to each of them: every
   connection encodes its own copy, and that is what a phone feels — not the
   network. In a grid of ten the pictures are small anyway. */
function qualityFor(connections) {
  if (connections <= 3) return null;
  if (connections <= 5) return { height: 480, fps: 24, bitrate: 900000 };
  if (connections <= 9) return { height: 360, fps: 15, bitrate: 450000 };
  return { height: 240, fps: 12, bitrate: 250000 };
}

async function tuneSenders() {
  const l = live;
  if (!l || !l.stream) return;
  const track = l.stream.getVideoTracks()[0];
  const q = qualityFor(l.links.size);
  // The camera itself takes smaller pictures then: less to scale down for each.
  if (track && track.applyConstraints && (q ? q.height : 0) !== l.quality) {
    l.quality = q ? q.height : 0;
    await track.applyConstraints(q ? { width: { ideal: Math.round(q.height * 16 / 9) }, height: { ideal: q.height }, frameRate: { ideal: q.fps } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } }).catch(() => {});
    if (live !== l) return;
  }
  l.quality = q ? q.height : 0;
  const height = (track && track.getSettings && track.getSettings().height) || 720;
  const screen = $('#call');
  if (screen) screen.dataset.quality = l.quality;
  l.links.forEach((k) => {
    const sender = k.senders.video;
    if (!sender || !sender.getParameters) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) return;   // not negotiated yet: again once connected
    const e = params.encodings[0];
    if (q) {
      e.scaleResolutionDownBy = Math.max(1, height / q.height);
      e.maxFramerate = q.fps;
      e.maxBitrate = q.bitrate;
    } else {
      e.scaleResolutionDownBy = 1;
      delete e.maxFramerate;
      delete e.maxBitrate;
    }
    sender.setParameters(params).catch(() => {});
  });
}

function sendState() {
  const l = live;
  if (!l || !l.joined) return;
  callPost('signal', { type: 'state', data: { video: l.cameraOn, audio: l.micOn } }).catch(() => {});
}

async function keepAwake() {
  try { if (navigator.wakeLock && live) live.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}

// Who is speaking: their tile gets a frame. The browser measures it anyway.
function drawSpeaking() {
  const l = live;
  if (!l) return;
  l.links.forEach((k) => {
    let level = 0;
    try {
      const receiver = k.pc.getReceivers().find((r) => r.track && r.track.kind === 'audio');
      const source = receiver && receiver.getSynchronizationSources ? receiver.getSynchronizationSources()[0] : null;
      level = source && typeof source.audioLevel === 'number' ? source.audioLevel : 0;
    } catch (e) { /* closed meanwhile */ }
    const speaking = level > 0.04;
    if (speaking !== k.speaking) {
      k.speaking = speaking;
      const tile = l.tiles.get(k.id);
      if (tile) tile.classList.toggle('speaking', speaking);
    }
  });
}

// ---- Buttons in the room
function toggleMic() {
  const l = live;
  l.micOn = !l.micOn;
  l.stream.getAudioTracks().forEach((x) => { x.enabled = l.micOn; });
  sendState();
  drawCallScreen();
}

const videoSenders = (l) => [...l.links.values()].map((k) => k.senders.video)
  .concat([...l.watchers.values()].map((pc) => pc.getSenders()[0])).filter(Boolean);

// Off means off: the camera is let go of (its light goes out), not just hidden.
async function toggleCamera() {
  const l = live;
  if (l.cameraBusy) return;           // one change at a time, or a second camera stays on
  l.cameraBusy = true;
  try { await cameraToggle(l); } finally { l.cameraBusy = false; }
}

async function cameraToggle(l) {
  if (l.cameraOn) {
    l.stream.getVideoTracks().forEach((x) => { x.stop(); l.stream.removeTrack(x); });
    await Promise.all(videoSenders(l).map((s) => s.replaceTrack(null).catch(() => {})));
    await cameraChanged(l);
  } else {
    await useCamera({ facingMode: l.facing });
  }
  sendState();
  drawCallScreen();
}

async function useCamera(constraints, quiet) {
  const l = live;
  // Let go of the current one first — phones open only one camera at a time.
  l.stream.getVideoTracks().forEach((x) => { x.stop(); l.stream.removeTrack(x); });
  let fresh;
  try {
    fresh = await navigator.mediaDevices.getUserMedia({ video: { ...constraints, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    if (!quiet) toast(t('ui.call_no_media'), true);
    await cameraChanged(l);
    return false;
  }
  if (live !== l) { fresh.getTracks().forEach((x) => x.stop()); return false; }
  const track = fresh.getVideoTracks()[0];
  l.stream.addTrack(track);
  await Promise.all(videoSenders(l).map((s) => s.replaceTrack(track).catch(() => {})));
  l.quality = -1;                      // a new camera starts at full size: size it again
  await cameraChanged(l);
  const facing = (track.getSettings && track.getSettings().facingMode) || '';
  if (facing) l.facing = facing === 'environment' ? 'environment' : 'user';
  return true;
}

// Front and back on phones; on a computer with several cameras, the next one.
async function switchCamera() {
  const l = live;
  if (!l.cameraOn || l.cameraBusy) return;
  l.cameraBusy = true;
  try { await cameraSwitch(l); } finally { l.cameraBusy = false; }
}

async function cameraSwitch(l) {
  const current = l.stream.getVideoTracks()[0];
  const settings = current && current.getSettings ? current.getSettings() : {};
  if (settings.facingMode) {
    const next = l.facing === 'user' ? 'environment' : 'user';
    if (await useCamera({ facingMode: { exact: next } }, true)) { l.facing = next; drawCallScreen(); return; }
  }
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const at = cameras.findIndex((d) => d.deviceId === settings.deviceId);
  const next = cameras[(at + 1) % cameras.length];
  if (next) await useCamera({ deviceId: { exact: next.deviceId } });
  drawCallScreen();
}

// A photo of the large picture (or the first one with a picture), into the
// shared files — like any other file.
function takePhoto() {
  const l = live;
  const videos = [...document.querySelectorAll('#call .call-tile.big video, #call .call-tile:not(.me) video, #call .call-tile.me video')];
  const video = videos.find((v) => !v.hidden && v.videoWidth && v.closest('.call-tile') && !v.closest('.call-tile').hidden);
  if (!video) { toast(t('ui.call_photo_none'), true); return; }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);     // as the camera sees it, not mirrored
  const screen = $('#call');
  if (screen) { screen.classList.remove('flash'); void screen.offsetWidth; screen.classList.add('flash'); }
  canvas.toBlob(async (blob) => {
    if (!blob) { toast(t('ui.call_photo_none'), true); return; }
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    const file = new File([blob], `${t('ui.call_photo')} ${stamp}.jpg`, { type: 'image/jpeg' });
    try {
      await uploadFile(file, 'shared');
      toast(t('ui.call_photo_saved'));
      if (live === l) callPost('signal', { type: 'photo' }).catch(() => {});
    } catch (e) {
      toast(t('ui.upload_failed', { name: file.name, reason: e.message }), true);
    }
  }, 'image/jpeg', 0.92);
}

// ---- The room screen
const ICONS = {
  mic: '<path d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3z"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>',
  micOff: '<path d="M15 10.5v-4a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 4.7 2.5M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11c0 .7-.1 1.4-.3 2M12 17.5v3M4 4l16 16"/>',
  cam: '<rect x="3" y="6.5" width="12.5" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3z"/>',
  camOff: '<path d="M8 6.5h5.5a2 2 0 0 1 2 2v3M15.5 15.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 1.5-1.9M15.5 10.5l5-3v9l-3-1.8M3 3l18 18"/>',
  flip: '<path d="M4 8.5h11.5a4 4 0 0 1 4 4v0M16.5 5.5l3 3-3 3M20 15.5H8.5a4 4 0 0 1-4-4v0M7.5 18.5l-3-3 3-3"/>',
  shrink: '<path d="M14.5 4.5v5h5M9.5 19.5v-5h-5M14.5 9.5l6-6M9.5 14.5l-6 6"/>',
  grow: '<path d="M15 3.5h5.5V9M9 20.5H3.5V15M20.5 3.5l-6.5 6.5M3.5 20.5l6.5-6.5"/>',
  photo: '<path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  invite: '<circle cx="10" cy="8.5" r="3.5"/><path d="M3.5 19.5c.7-3.5 3.3-5.5 6.5-5.5s5.8 2 6.5 5.5M18.5 8v6M15.5 11h6"/>',
  leave: '<path d="M3.5 14.5c4.7-4.3 12.3-4.3 17 0l-2 2.5-3.3-1.3.3-2.5a10 10 0 0 0-7 0l.3 2.5L5.5 17z"/>',
};

function iconButton(icon, label, cls, action) {
  const b = el('button', 'call-btn' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  b.appendChild(el('span', '', label));
  b.setAttribute('aria-label', label);
  b.title = label;
  b.onclick = (e) => { e.stopPropagation(); action(); };
  return b;
}

function showCallScreen() {
  closeViewer();
  hideMenu();
  const screen = el('div', 'call');
  screen.id = 'call';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  screen.append(el('div', 'call-grid'), el('div', 'call-top'), el('div', 'call-bar'));
  document.body.appendChild(screen);
  drawCallScreen();
}

// Smaller: the room goes into a corner and Drop is usable below it — texts,
// files, uploads. Larger again with its button, a tap on it, or the tile.
function setMini(on) {
  if (!live) return;
  live.mini = on;
  drawCallScreen();
  drawLiveTile();
}

function drawCallClock() {
  const node = $('#call .call-status');
  if (!node || !live || !live.since) return;
  const s = Math.floor((Date.now() - live.since) / 1000);
  const p = (n) => String(n).padStart(2, '0');
  const clock = s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
  node.textContent = `${t('ui.live_people', { n: roomMembers().length })} · ${clock}`;
}

/* Alone in the room for ALONE_ASK: a short sound and "Still there?". Without
   an answer the page leaves ALONE_WAIT later — the room ends with it, rather
   than stay live all night on a forgotten tab. Someone coming in ends the
   question; closing it counts as staying. */
function checkAlone() {
  const l = live;
  if (!l || !l.joined) return;
  const alone = !roomMembers().some((m) => m.id !== l.you);
  const now = Date.now();
  if (!alone) {
    l.aloneSince = 0;
    if (l.askedAt) { l.askedAt = 0; if (l.askBox && document.contains(l.askBox)) hideDialog(); }
    return;
  }
  if (!l.aloneSince) l.aloneSince = now;
  if (l.askedAt) {
    if (!l.askBox || !document.contains(l.askBox)) { l.askedAt = 0; l.aloneSince = now; return; }   // closed: stays
    const left = Math.max(0, Math.ceil((l.askedAt + ALONE_WAIT - now) / 1000));
    l.askBox.querySelector('.still-time').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left) { hideDialog(); leaveRoom(); toast(t('ui.live_closed_alone')); }
    return;
  }
  if (now - l.aloneSince < ALONE_ASK) return;
  l.askedAt = now;
  beep([660, 880], 0.25);
  if (navigator.vibrate) navigator.vibrate(200);
  const box = el('div', 'still');
  const text = el('p', '', t('ui.live_still_text', { minutes: Math.round(ALONE_ASK / 60000) }));
  const time = el('p', 'still-line');
  time.append(el('span', '', t('ui.live_still_closes') + ' '), el('strong', 'still-time', ''));
  box.append(text, time);
  l.askBox = box;
  const stay = () => { if (live === l) { l.askedAt = 0; l.aloneSince = Date.now(); } };
  dialog({ title: t('ui.live_still_title'), content: box,
    buttons: [{ text: t('ui.live_leave'), action: leaveRoom }, { text: t('ui.live_stay'), kind: 'go', action: stay }] });
  checkAlone();
}

// One tile per person, kept from one drawing to the next: a <video> that is
// built anew flickers. Sound plays from an <audio> of its own per person.
function tileFor(l, key) {
  let tile = l.tiles.get(key);
  if (tile) return tile;
  tile = el('div', 'call-tile' + (key === 'me' ? ' me' : ''));
  tile.dataset.id = key;
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  tile.append(video, el('div', 'call-face'), el('div', 'call-label'), el('div', 'call-note'));
  tile.onclick = () => {
    if (live !== l) return;
    if (l.mini) { setMini(false); return; }
    l.focus = l.focus === key ? null : key;
    drawCallScreen();
  };
  l.tiles.set(key, tile);
  return tile;
}

function drawTile(tile, { person, stream, mirror, micOn, note, you }) {
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
  video.hidden = !stream;
  video.classList.toggle('mirror', !!stream && mirror);
  if (stream) video.play().catch(() => {});
  const face = tile.querySelector('.call-face');
  face.hidden = !!stream;
  face.innerHTML = '';
  if (!stream && person) face.appendChild(avatarOf(person));
  const label = tile.querySelector('.call-label');
  label.innerHTML = '';
  if (!micOn) label.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS.micOff}</svg>`);
  label.appendChild(el('span', '', you ? t('ui.live_you') : person ? peerTitle(person) : ''));
  const noteNode = tile.querySelector('.call-note');
  noteNode.textContent = note || '';
  noteNode.hidden = !note;
}

function gridColumns(n, width, height) {
  let best = 1;
  let size = 0;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const s = Math.min(width / cols, (height / rows) * 4 / 3);
    if (s > size + 1) { size = s; best = cols; }
  }
  return best;
}

function drawCallScreen() {
  const l = live;
  const screen = $('#call');
  if (!l || !screen) return;
  const grid = screen.querySelector('.call-grid');
  screen.classList.toggle('mini', l.mini);
  screen.setAttribute('aria-modal', String(!l.mini));
  const mine = l.cameraOn ? l.preview : null;
  const me = memberOf(l.you) || { name: deviceName(), device: deviceLabel() };

  // Everyone in the room, in the order they came in, then this page.
  const others = roomMembers().filter((m) => m.id !== l.you).map((m) => ({ m, k: l.links.get(m.id) }));
  l.tiles.forEach((tile, key) => { if (key !== 'me' && !memberOf(key)) { tile.remove(); l.tiles.delete(key); } });
  const tiles = [];
  others.forEach(({ m, k }) => {
    const tile = tileFor(l, m.id);
    const video = k && m.video && k.remote.getVideoTracks().some((x) => !x.muted) ? k.remote : null;
    const note = !k || k.state === 'connecting' ? t('ui.call_connecting')
      : k.state === 'dropout' ? t('ui.call_reconnecting') : k.state === 'failed' ? t('ui.live_no_link') : '';
    drawTile(tile, { person: m, stream: video, mirror: false, micOn: m.audio, note });
    tile.classList.toggle('failed', !!k && k.state === 'failed');
    if (k && !k.audio) {
      k.audio = document.createElement('audio');
      k.audio.autoplay = true;
      screen.appendChild(k.audio);
    }
    if (k && k.audio.srcObject !== k.remote) { k.audio.srcObject = k.remote; k.audio.play().catch(() => {}); }
    tiles.push({ key: m.id, tile });
  });
  const meTile = tileFor(l, 'me');
  drawTile(meTile, { person: me, stream: mine, mirror: l.facing === 'user', micOn: l.micOn, you: true,
    note: !l.cameraOn && l.stream ? t('ui.call_camera_is_off') : '' });
  tiles.push({ key: 'me', tile: meTile });

  // How they are laid out: alone, one other (large, this page small in the
  // corner), one picked by a tap (large), or a grid of all.
  if (l.focus && !tiles.some((x) => x.key === l.focus)) l.focus = null;
  let big = null;
  let pip = null;
  if (l.mini) {
    big = l.focus || (others.find(({ m, k }) => k && k.speaking && m.video) || others.find(({ m }) => m.video) || others[0] || {}).m?.id || 'me';
  } else if (l.focus) {
    big = l.focus;
    pip = l.focus === 'me' ? (others.length === 1 ? others[0].m.id : null) : 'me';
  } else if (others.length === 0) {
    big = 'me';
  } else if (others.length === 1) {
    big = others[0].m.id;
    pip = 'me';
  }
  const gridMode = !big;
  grid.classList.toggle('grid', gridMode);
  tiles.forEach(({ key, tile }) => {
    tile.classList.toggle('big', key === big);
    tile.classList.toggle('pip', key === pip);
    tile.hidden = !gridMode && key !== big && key !== pip;
  });
  // In order: the others as they came, this page last. Only moved when out of place.
  tiles.forEach(({ tile }, i) => {
    if (grid.children[i] === tile) return;
    grid.insertBefore(tile, grid.children[i] || null);
    const video = tile.querySelector('video');
    if (video.srcObject) video.play().catch(() => {});      // moving it paused it
  });
  if (gridMode) {
    const cols = gridColumns(tiles.length, grid.clientWidth || window.innerWidth, grid.clientHeight || window.innerHeight);
    grid.style.setProperty('--cols', cols);
    grid.style.setProperty('--rows', Math.ceil(tiles.length / cols));
  }
  screen.dataset.members = roomMembers().length;
  screen.dataset.connected = others.filter(({ k }) => k && k.state === 'live').length;

  const top = screen.querySelector('.call-top');
  top.innerHTML = '';
  top.append(el('span', 'live-badge', t('ui.live_badge')), el('span', 'call-status', ''));
  if (room && room.locked) top.appendChild(el('span', 'call-flag', t('ui.live_locked')));
  if (room && room.watchers) {
    const watching = el('span', 'call-flag watching', '👁 ' + room.watchers);
    watching.title = t('ui.live_watchers', { n: room.watchers });
    top.appendChild(watching);
  }
  if (others.length === 0 && l.joined) top.appendChild(el('div', 'call-alone', t('ui.live_alone')));
  drawCallClock();

  const bar = screen.querySelector('.call-bar');
  bar.innerHTML = '';
  const ready = !!l.stream;
  const mic = iconButton(l.micOn ? 'mic' : 'micOff', t(l.micOn ? 'ui.call_mic_off' : 'ui.call_mic_on'),
    l.micOn ? '' : 'off', toggleMic);
  mic.disabled = !ready;
  if (l.mini) {
    bar.append(iconButton('grow', t('ui.call_larger'), '', () => setMini(false)), mic,
      iconButton('leave', t('ui.live_leave'), 'end', leaveRoom));
    return;
  }
  const cam = iconButton(l.cameraOn ? 'cam' : 'camOff', t(l.cameraOn ? 'ui.call_camera_off' : 'ui.call_camera_on'),
    l.cameraOn ? '' : 'off', toggleCamera);
  cam.disabled = !ready;
  bar.append(mic, cam);
  if (l.cameraOn && l.cameras > 1) bar.appendChild(iconButton('flip', t('ui.call_switch'), '', switchCamera));
  const invite = iconButton('invite', t('ui.live_invite'), '', showInvite);
  invite.disabled = !l.joined;
  bar.append(iconButton('photo', t('ui.call_photo'), '', takePhoto), invite,
    iconButton('shrink', t('ui.call_smaller'), '', () => setMini(true)),
    iconButton('leave', t('ui.live_leave'), 'end', leaveRoom));
}

// ------------------------------------------------------------------ Connection
function setConnected(on) {
  const dot = $('#connection');
  dot.classList.toggle('on', on);
  dot.classList.toggle('off', !on);
  dot.title = t(on ? 'ui.connected' : 'ui.disconnected');
  $('#connection-text').textContent = t(on ? 'ui.connected' : 'ui.disconnected');
}

function connectEvents() {
  if (source) source.close();
  const query = [openedAs ? 'as=' + openedAs : '', callable ? 'peer=' + callSecret : ''].filter(Boolean).join('&');
  source = new EventSource('/api/events' + (query ? '?' + query : ''));

  source.onopen = () => {
    setConnected(true);
    loadState();          // catches up on what happened while offline
    resendDrafts();
    sendPresence();
  };
  source.onerror = () => {
    setConnected(false);
    fetch('/api/state').catch(() => {});   // signed out? then the reload above
    // On an HTTP error the browser gives up for good (CLOSED) — try again later.
    const gaveUp = source;
    if (gaveUp.readyState === 2) {
      setTimeout(() => { if (source === gaveUp && navigator.onLine) connectEvents(); }, 5000);
    }
  };

  // With users, each event says which area it is about. The other one only
  // gets a dot on its tab.
  // Before the first state arrived the user is not known yet — nor where drafts belong.
  const here = (d) => (!usersOn || user) && (!d.area || d.area === area);

  source.addEventListener('text', (e) => {
    const d = JSON.parse(e.data);
    if (!here(d)) { markNews(d.area); return; }
    // Unknown id: the field was just created, "fields" follows.
    fromServer(fieldById(d.id), d.text, d.version);
  });

  source.addEventListener('fields', (e) => {
    const d = JSON.parse(e.data);
    if (!here(d)) { markNews(d.area); return; }
    syncFields(d.texts || []);
  });

  source.addEventListener('shares', (e) => {
    shares = JSON.parse(e.data).shares || [];
    updateShares();
  });

  source.addEventListener('files', (e) => {
    const d = JSON.parse(e.data);
    if (!here(d)) { if (d.files && d.files.length) markNews(d.area); return; }
    const before = new Set(files.map((x) => x.name));
    files = d.files || [];
    if (filesLoaded) files.forEach((x) => { if (!before.has(x.name)) markFresh(x.name); });
    serverUploads = new Map((d.uploads || []).map((u) => [u.id, u]));
    if (d.space) showSpace(d.space);
    drawList();
  });

  source.addEventListener('peers', (e) => {
    peers = JSON.parse(e.data).peers || [];
    updateCallButton();
    drawPeers();
  });

  source.addEventListener('call', (e) => onCallEvent(JSON.parse(e.data)));
  source.addEventListener('room', (e) => setRoom(JSON.parse(e.data).room));

  source.addEventListener('upload', (e) => {
    const u = JSON.parse(e.data);
    if (!here(u)) return;
    serverUploads.set(u.id, u);
    if (!ownUploads.has(u.id)) drawList();
  });
}

function markFresh(name) {
  fresh.set(name, Date.now());
  setTimeout(() => { fresh.delete(name); }, 4000);
}

function showSpace(space) {
  const node = $('#space');
  if (!space || !space.total) { node.textContent = ''; return; }
  node.textContent = t('ui.space_free', { size: formatSize(space.free) });
  node.classList.toggle('low', space.free / space.total < 0.1);
}

async function loadState() {
  const asked = area;
  try {
    const r = await fetch(withArea('/api/state'));
    // No own area any more: the users were taken out of the .env.
    if (r.status === 404 && asked === 'own') { location.reload(); return; }
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (asked !== area) return;        // switched meanwhile; that load is on its way
    user = d.user || null;
    if (user) applyPalette(user.palette);
    showAreas();
    setRoom(d.room, true);
    checkBuild(d.build);
    if (d.name) {
      appName = d.name;
      document.title = d.name;
      const heading = $('.brand h1');
      if (heading.textContent !== d.name) heading.textContent = d.name;
    }
    const notice = $('#notice');
    const sentence = (d.notice || '').trim();
    notice.textContent = sentence;
    notice.hidden = !sentence;

    chunkSize = d.chunk_size || chunkSize;
    files = d.files || [];
    filesLoaded = true;
    serverUploads = new Map((d.uploads || []).map((u) => [u.id, u]));
    showSpace(d.space);
    fieldStart = d.field_start || fieldStart;
    fieldMax = d.field_max || fieldMax;
    const sharing = d.sharing || {};
    sharingEnabled = !!sharing.enabled;
    shareMaxDays = sharing.max_days || shareMaxDays;
    shareBaseFixed = sharing.base_url || null;
    shareSubdomain = sharing.subdomain || shareSubdomain;
    shares = d.shares || [];

    syncFields(d.texts || []);
    if (firstLoad) { firstLoad = false; orphanedDrafts(); }

    updateShares();     // also draws the file list
    // Green only while live updates come in, not just because this request worked.
    setConnected(!!source && source.readyState === 1);
  } catch (e) {
    setConnected(false);
  }
}

function resendDrafts() {
  fields.forEach((f) => {
    const draft = readDraft(f);
    if (draft && f.textarea.value === draft.text) scheduleSave(f);
  });
}

function stopAllSaves() {
  fields.forEach((f) => {
    clearTimeout(f.timer); f.timer = null;
    clearTimeout(f.maxTimer); f.maxTimer = null;
    deleteDraft(f);
  });
}

// ------------------------------------------------------------------ Start
function wireButtons() {
  $('#btn-help').onclick = showHelp;
  $('#btn-call').onclick = showLive;
  // Nudges need sound, and browsers allow it only after a touch or click.
  document.addEventListener('pointerdown', unlockSound, { passive: true });
  document.addEventListener('keydown', unlockSound);
  // Closed or reloaded in the room: the others hear of it at once.
  window.addEventListener('pagehide', () => {
    if (live && live.joined) {
      fetch('/api/call/leave', {
        method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peer: callSecret }),
      }).catch(() => {});
    }
    leaveLocally('');    // a page restored from the back/forward cache shows no dead room
  });
  window.addEventListener('resize', () => { if (live) drawCallScreen(); });
  $('#btn-qr').onclick = showQr;
  $('#btn-qr').title = t('ui.qr_open');
  document.querySelectorAll('#theme-switch button').forEach((b) => { b.onclick = () => chooseTheme(b.dataset.mode); });
  systemDark.addEventListener('change', () => applyTheme(currentTheme()));
  // Switched in another tab: follow along.
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme(e.newValue || 'auto');
  });
  $('#btn-shares').onclick = showShares;
  $('#btn-palette').hidden = usersOn;
  $('#btn-palette').onclick = (e) => { e.stopPropagation(); showPalettes(e); };
  window.addEventListener('storage', (e) => {
    if (!usersOn && (e.key === PALETTE_KEY || e.key === null)) applyPalette(e.newValue || 'teal');
  });
  document.querySelectorAll('#areas [role=tab]').forEach((b) => { b.onclick = () => switchArea(b.dataset.area); });
  // Signed out here: the other tabs of this browser follow at once.
  if ('BroadcastChannel' in window) {
    const tabs = new BroadcastChannel('drop');
    tabs.onmessage = (e) => { if (e.data === 'signed-out') location.reload(); };
    $('#areas form').addEventListener('submit', () => tabs.postMessage('signed-out'));
  }

  $('#btn-add-field').onclick = async () => {
    const f = await addField('');
    if (f) f.textarea.focus();
  };

  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#btn-upload').title = t('ui.paste_hint');
  $('#file-input').onchange = (e) => {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (list.length) uploadFiles(list);
  };

  $('#btn-download').onclick = () => startDownload(Array.from(selection));

  $('#select-all').onchange = (e) => {
    const visible = allEntries().list.map((d) => d.name);
    if (e.target.checked) visible.forEach((n) => selection.add(n));
    else visible.forEach((n) => selection.delete(n));
    drawList();
  };

  $('#filter').oninput = drawList;
  $('#sort').onchange = drawList;

  $('#btn-clear-texts').onclick = () => {
    confirmDialog(t('ui.clear_texts_title'), tArea('ui.clear_texts_text', { n: fieldStart }),
      t('ui.clear_texts'), async () => {
        stopAllSaves();
        await fetch(withArea('/api/text'), { method: 'DELETE' }).catch(() => {});
        await loadState();
      });
  };

  $('#btn-delete-files').onclick = () => {
    const total = files.reduce((s, d) => s + d.size, 0);
    if (!files.length) { toast(t('ui.no_files')); return; }
    confirmDialog(t('ui.delete_files_title'),
      tArea('ui.delete_files_text', { files: t('ui.files_count', { n: files.length }), size: formatSize(total) }),
      t('ui.delete_files'), async () => {
        await fetch(withArea('/api/files'), {
          method: 'DELETE', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        }).catch(() => {});
        selection.clear(); dropOwnUploads();
        await loadState();
      });
  };

  $('#btn-delete-all').onclick = () => {
    const total = files.reduce((s, d) => s + d.size, 0);
    const here = shares.filter(inArea);
    const parts = [tArea('ui.delete_all_text', { files: t('ui.files_count', { n: files.length }), size: formatSize(total) })];
    if (here.length) parts.push(t('ui.delete_all_shares', { n: here.length }));
    confirmDialog(t('ui.delete_all_title'), parts.join(' '), t('ui.delete_all'), async () => {
      stopAllSaves();
      if (here.length) await fetch(withArea('/api/shares'), { method: 'DELETE' }).catch(() => {});
      await fetch(withArea('/api/text'), { method: 'DELETE' }).catch(() => {});
      await fetch(withArea('/api/files'), {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
      selection.clear(); dropOwnUploads();
      await loadState();
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (live && live.joined) keepAwake();      // the browser let go of it while hidden
      loadState();
      if (!source || source.readyState === 2) connectEvents();
    }
    updatePreview();
  });

  window.addEventListener('online', () => connectEvents());
  window.addEventListener('offline', () => setConnected(false));

  window.addEventListener('beforeunload', (e) => {
    if (ownUploads.size || (live && live.joined)) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function start() {
  if (usersOn) {
    // ?area= from the share sheet, otherwise the one shown last; first time: my own.
    const wanted = new URLSearchParams(location.search).get('area');
    let last = null;
    try { last = localStorage.getItem(AREA_KEY); } catch (e) {}
    area = wanted === 'own' || wanted === 'shared' ? wanted : (last === 'shared' ? 'shared' : 'own');
    if (wanted) history.replaceState(null, '', location.pathname);
  }
  await loadLanguage();
  translatePage();
  applyTheme(currentTheme());
  applyPalette(currentPalette());
  moveOldDrafts();
  wireButtons();
  setupDrop();
  setupPaste();
  await loadState();
  connectEvents();
  setInterval(drawShares, 30000);     // keeps the remaining time in the open dialog current
}

start();

})();
