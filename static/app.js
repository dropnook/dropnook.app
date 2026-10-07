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

function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel)); });
}

// ------------------------------------------------------------------ Small helpers
const $  = (s) => document.querySelector(s);
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
    id, card, textarea: ta, name, count, badge, links, share, remove,
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
    confirmDialog(t('ui.clear_field_title'), t('ui.clear_field_text', { field: fieldName(f) }),
      t('ui.clear'), () => { ta.value = ''; updateCount(f); saveDraft(f); save(f); });
  };
  remove.onclick = () => {
    if (!ta.value) { removeField(f); return; }
    confirmDialog(t('ui.remove_field_title'), t('ui.remove_field_text', { field: fieldName(f) }),
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
  const draft = readDraft(f.id);
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
  const draft = readDraft(f.id);
  deleteDraft(f.id);
  if (draft && draft.text && draft.text.trim()) offerRescue(draft.text);
}

async function addField(text) {
  try {
    const r = await fetch('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: text || '' }),
    });
    if (r.status === 409) { toast(t('ui.field_limit', { n: fieldMax }), true); return null; }
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
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
  deleteDraft(f.id);
  f.gone = true;                // no more saving from here on
  try {
    const r = await fetch(`/api/text/${f.id}`, { method: 'DELETE' });
    if (r.status === 409) { f.gone = false; toast(t('ui.last_field')); return; }
    if (!r.ok) throw new Error(r.status);
    syncFields((await r.json()).texts);
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

function draftKey(id) { return DRAFT_KEY + id; }

function saveDraft(f) {
  try {
    localStorage.setItem(draftKey(f.id), JSON.stringify({
      text: f.textarea.value, base: f.version, ts: Date.now(),
    }));
  } catch (e) { /* private mode or full — no reason to stop */ }
}

function readDraft(id) {
  try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); }
  catch (e) { return null; }
}

function deleteDraft(id) {
  try { localStorage.removeItem(draftKey(id)); } catch (e) {}
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
      if (old && localStorage.getItem(draftKey(id)) === null) {
        localStorage.setItem(draftKey(id), JSON.stringify({ text: old.text, base: old.basis, ts: old.ts }));
      }
      localStorage.removeItem(key);
    }
  } catch (e) {}
}

/* Drafts for fields that no longer exist at load time — removed while this
   tab was closed. As with removal while running: offer the rescue. */
function orphanedDrafts() {
  const present = new Set(fields.map((f) => String(f.id)));
  const finds = [];
  try {
    for (let k = localStorage.length - 1; k >= 0; k--) {
      const key = localStorage.key(k);
      if (!key || !key.startsWith(DRAFT_KEY)) continue;
      const id = key.slice(DRAFT_KEY.length);
      if (present.has(id)) continue;
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
    const response = await fetch(`/api/text/${f.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, base: f.version }),
    });
    if (response.status === 404) {
      // The field was removed on the server. Syncing takes it down and offers
      // to rescue the draft.
      loadState();
      return;
    }
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
    if (f.textarea.value === text) deleteDraft(f.id);
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
          updateCount(f); deleteDraft(f.id);
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
    const response = await fetch('/api/state');
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
    deleteDraft(f.id);
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
  deleteDraft(f.id);
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
    const r = await fetch('/api/shares', {
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
    const field = rec.kind === 'text' && fieldById(rec.field);
    head.append(el('span', 'tag', t(rec.kind === 'text' ? 'ui.kind_text' : 'ui.kind_file')),
      el('span', '', field ? fieldName(field) : rec.name));
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
const sharesForFile  = (name) => shares.filter((r) => r.kind === 'file' && r.name === name);
const sharesForField = (id) => shares.filter((r) => r.kind === 'text' && r.field === id);
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
  ownUploads.forEach((u) => running.push({ ...u, own: true }));
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
const fileUrl  = (name) => '/files/' + encodeURIComponent(name);
const thumbUrl = (d) => (extOf(d.name) === 'svg'      // drawn by the browser, never by the server
  ? fileUrl(d.name)
  : `/api/thumb/${encodeURIComponent(d.name)}?v=${d.size}-${d.mtime}`);
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
    const b = el('button', e.kind === 'danger' ? 'danger' : '', e.text);
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
    img.src = '/files/' + encodeURIComponent(d.name);
    img.alt = d.name;
    box.appendChild(img);
  } else if (texts.includes(ext) && d.size < 2 * 1024 * 1024) {
    try {
      const r = await fetch('/api/preview/' + encodeURIComponent(d.name));
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
  names.forEach((name, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = '/files/' + encodeURIComponent(name);
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
    ? t('ui.delete_single', { name: names[0] })
    : t('ui.delete_many', { n: names.length, size: formatSize(total) });
  confirmDialog(t('ui.delete_title'), what, t('ui.delete'), async () => {
    await fetch('/api/files', {
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
function cancelUpload(id) {
  const own = ownUploads.get(id);
  if (own) own.cancelled = true;
  ownUploads.delete(id);
  fetch('/api/upload/' + id, { method: 'DELETE' }).catch(() => {});
  drawList();
}

async function uploadFiles(list) {
  for (const file of list) {
    try {
      await uploadFile(file);
    } catch (e) {
      toast(t('ui.upload_failed', { name: file.name, reason: e.message }), true);
    }
  }
}

async function uploadFile(file) {
  const start = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name: file.name, size: file.size }),
  }).catch(() => null);
  if (!start || !start.ok) throw new Error(t('ui.upload_refused'));
  const init = await start.json();
  chunkSize = init.chunk_size;

  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const done = new Set(init.chunks || []);
  const entry = {
    id: init.id, name: file.name, size: file.size,
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
  source = new EventSource('/api/events');

  source.onopen = () => {
    setConnected(true);
    loadState();          // catches up on what happened while offline
    resendDrafts();
  };
  source.onerror = () => setConnected(false);

  source.addEventListener('text', (e) => {
    const d = JSON.parse(e.data);
    // Unknown id: the field was just created, "fields" follows.
    fromServer(fieldById(d.id), d.text, d.version);
  });

  source.addEventListener('fields', (e) => {
    syncFields(JSON.parse(e.data).texts || []);
  });

  source.addEventListener('shares', (e) => {
    shares = JSON.parse(e.data).shares || [];
    updateShares();
  });

  source.addEventListener('files', (e) => {
    const d = JSON.parse(e.data);
    const before = new Set(files.map((x) => x.name));
    files = d.files || [];
    if (filesLoaded) files.forEach((x) => { if (!before.has(x.name)) markFresh(x.name); });
    serverUploads = new Map((d.uploads || []).map((u) => [u.id, u]));
    if (d.space) showSpace(d.space);
    drawList();
  });

  source.addEventListener('upload', (e) => {
    const u = JSON.parse(e.data);
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
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
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
    setConnected(true);
  } catch (e) {
    setConnected(false);
  }
}

function resendDrafts() {
  fields.forEach((f) => {
    const draft = readDraft(f.id);
    if (draft && f.textarea.value === draft.text) scheduleSave(f);
  });
}

function stopAllSaves() {
  fields.forEach((f) => {
    clearTimeout(f.timer); f.timer = null;
    clearTimeout(f.maxTimer); f.maxTimer = null;
    deleteDraft(f.id);
  });
}

// ------------------------------------------------------------------ Start
function wireButtons() {
  $('#btn-help').onclick = showHelp;
  document.querySelectorAll('#theme-switch button').forEach((b) => { b.onclick = () => chooseTheme(b.dataset.mode); });
  systemDark.addEventListener('change', () => applyTheme(currentTheme()));
  // Switched in another tab: follow along.
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme(e.newValue || 'auto');
  });
  $('#btn-shares').onclick = showShares;

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
    confirmDialog(t('ui.clear_texts_title'), t('ui.clear_texts_text', { n: fieldStart }),
      t('ui.clear_texts'), async () => {
        stopAllSaves();
        await fetch('/api/text', { method: 'DELETE' }).catch(() => {});
        await loadState();
      });
  };

  $('#btn-delete-files').onclick = () => {
    const total = files.reduce((s, d) => s + d.size, 0);
    if (!files.length) { toast(t('ui.no_files')); return; }
    confirmDialog(t('ui.delete_files_title'),
      t('ui.delete_files_text', { files: t('ui.files_count', { n: files.length }), size: formatSize(total) }),
      t('ui.delete_files'), async () => {
        await fetch('/api/files', {
          method: 'DELETE', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        }).catch(() => {});
        selection.clear(); ownUploads.clear();
        await loadState();
      });
  };

  $('#btn-delete-all').onclick = () => {
    const total = files.reduce((s, d) => s + d.size, 0);
    const parts = [t('ui.delete_all_text', { files: t('ui.files_count', { n: files.length }), size: formatSize(total) })];
    if (shares.length) parts.push(t('ui.delete_all_shares', { n: shares.length }));
    confirmDialog(t('ui.delete_all_title'), parts.join(' '), t('ui.delete_all'), async () => {
      stopAllSaves();
      if (shares.length) await fetch('/api/shares', { method: 'DELETE' }).catch(() => {});
      await fetch('/api/text', { method: 'DELETE' }).catch(() => {});
      await fetch('/api/files', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
      selection.clear(); ownUploads.clear();
      await loadState();
    });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadState();
      if (!source || source.readyState === 2) connectEvents();
    }
  });

  window.addEventListener('online', () => connectEvents());
  window.addEventListener('offline', () => setConnected(false));

  window.addEventListener('beforeunload', (e) => {
    if (ownUploads.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function start() {
  await loadLanguage();
  translatePage();
  applyTheme(currentTheme());
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
