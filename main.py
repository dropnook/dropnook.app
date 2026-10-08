#!/usr/bin/env python3
"""
Drop — a shared drop box for your LAN
=====================================
Shared text fields and a flat file store, no login, kept in sync live over
Server-Sent Events. Single texts and files can be shared to the internet
through their own time-limited link.

Principles:
  * The file system is the single source of truth. No database.
  * UTF-8 throughout, file names normalised to NFC, downloads per RFC 6266.
  * Uploads arrive in chunks, stream straight to disk and can be resumed.
  * One uvicorn worker: the broadcast state lives in the process.
  * Two containers from the same code: MODE=lan is the drop box itself,
    MODE=public serves nothing but share links and only ever sees the shares/
    directory, read-only. Whatever is not shared does not exist for it.
"""

import asyncio
import hashlib
import hmac
import html
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import ssl
import shutil
import stat
import tempfile
import threading
import time
import unicodedata
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Optional, Set
from urllib.parse import parse_qs, quote, urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (HTMLResponse, JSONResponse, PlainTextResponse,
                               Response, StreamingResponse)
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

# ---------------------------------------------------------------- Settings

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
LANG_DIR = APP_DIR / "lang"         # one <code>.json per language, see lang/README.md
HELP_DIR = APP_DIR / "help"         # one <code>.html per language
# Optional folder with lang/ and help/ of your own — added languages or changed
# wording without building an image. A lang/<code>.json there is laid over the
# built-in one key by key; a help/<code>.html there replaces the built-in one.
# compose.yaml mounts the appdata folder here.
CUSTOM_DIR = Path(os.environ.get("CUSTOM_DIR", "/config"))
# Before Drop came as an image, its code lived in appdata. Such a leftover copy
# would silently pin every translation to its old state — so it is ignored.
if (CUSTOM_DIR / "main.py").is_file():
    print(f"{CUSTOM_DIR} holds an old copy of Drop's code — ignored. Delete it from the "
          "appdata folder; only translations of your own (lang/, help/) belong there.",
          flush=True)
    CUSTOM_DIR = Path("/nonexistent")
DEFAULT_LANGUAGE = "en"             # complete reference; every other language falls back to it

FILES_DIR = Path(os.environ.get("FILES_DIR", "/data/files"))
TEXTS_DIR = Path(os.environ.get("TEXTS_DIR", "/data/texts"))
SHARES_DIR = Path(os.environ.get("SHARES_DIR", "/data/shares"))
# Small previews of the pictures in FILES_DIR; next to it, never inside it.
THUMBS_DIR = Path(os.environ.get("THUMBS_DIR", str(FILES_DIR.parent / ".thumbs")))
# Temporary files (pictures shared from Android while they arrive) — on the data
# disk, not in the container: on Unraid that would fill up docker.img.
TMP_DIR = FILES_DIR.parent / ".tmp"
SHARED_PREFIX = ".shared-"           # a file from the share sheet while it is copied

# Number of text fields after the first start and after "Clear text fields";
# "+" adds more, up to TEXT_FIELDS_MAX.
FIELDS_START = max(1, int(os.environ.get("TEXT_FIELDS", "3")))
FIELDS_MAX = max(FIELDS_START, int(os.environ.get("TEXT_FIELDS_MAX", "12")))

CHUNK_SIZE = int(os.environ.get("CHUNK_MB", "64")) * 1024 * 1024
WRITE_BUFFER = 4 * 1024 * 1024      # collect this much before handing a write to the thread pool
MAX_NAME_BYTES = 200                # file systems allow 255; leaves room for " (12)"

PUID = int(os.environ.get("PUID", "99"))
PGID = int(os.environ.get("PGID", "100"))

# HTTPS is optional. Without TLS_CERT/TLS_KEY everything runs on port 80.
# TLS_CERT=auto looks for a fitting certificate in CERTS_DIR on its own (see
# find_certificates); TLS_CERT=<domain> (e.g. example.com) does the same for
# that one domain only. TLS_KEY is not needed for either.
TLS_CERT = os.environ.get("TLS_CERT", "").strip()
TLS_KEY = os.environ.get("TLS_KEY", "").strip()
TLS_AUTO = TLS_CERT.lower() == "auto"
TLS_DOMAIN = (TLS_CERT.lower().strip(".") if TLS_CERT and "/" not in TLS_CERT and not TLS_AUTO
              else "")
CERTS_DIR = Path(os.environ.get("CERTS_DIR", "/certs"))
# The box is opened as <TLS_AUTO_NAME>.<domain>; a certificate for exactly that
# name or for *.<domain> fits.
TLS_AUTO_NAME = os.environ.get("TLS_AUTO_NAME", "drop").strip().lower() or "drop"
# Only a fallback for the port-80 redirect when a client sends no Host header.
# Otherwise it redirects to whatever name the client used.
HTTPS_HOST = os.environ.get("HTTPS_HOST", "").strip()
HTTP_PORT = int(os.environ.get("HTTP_REDIRECT_PORT", "80"))

# Display name. {server} is replaced with the Unraid server name from
# /boot/config/ident.cfg (mounted read-only). Read on every page load, so a
# renamed server needs no restart.
APP_NAME_TEMPLATE = os.environ.get("APP_NAME", "{server} Drop").strip() or "{server} Drop"
UNRAID_IDENT = Path(os.environ.get("UNRAID_IDENT", "/unraid/ident.cfg"))

# Short note shown next to the status in the header, {server} works here too.
# Empty hides it.
APP_NOTICE_TEMPLATE = os.environ.get("APP_NOTICE", "").strip()

# lan: the drop box (default). public: share links only — for the second
# container, the one the reverse proxy points to.
MODE = os.environ.get("MODE", "lan").strip().lower()
PUBLIC = MODE == "public"

# Optional PIN or password for Drop in the home network: every new browser is
# asked for it once and then remembers it for ACCESS_DAYS. Empty: no question.
# Changing it signs every browser out. Not used by drop-share.
LAN_PIN = "" if PUBLIC else os.environ.get("PIN", "").strip()
ACCESS_DAYS = 90

# Optional users, at most one per colour: USER_GOLD: "Tom:1357" (name, then the
# PIN; without ":PIN" the name alone signs in). Each gets an area of their own
# next to the shared one, and the page in their colour. Without any, Drop has
# no users and every browser picks a colour for itself. Not used by drop-share.
PALETTES = ("teal", "gold", "blue", "violet", "coral")
USERS_DIR = Path(os.environ.get("USERS_DIR", str(FILES_DIR.parent / "users")))
USER_NAME_MAX = 40

# Sharing to the internet. No domain name appears anywhere: whatever arrives
# through the reverse proxy is outside traffic and only sees share links. The
# browser in the LAN derives the link address from its own host name
# (drop.example.org → drop-share.example.org); SHARE_BASE_URL overrides that.
SHARING_ENABLED = os.environ.get("SHARING", "on").strip().lower() in ("on", "yes", "1", "true")
SHARE_SUBDOMAIN = os.environ.get("SHARE_SUBDOMAIN", "drop-share").strip().strip(".") or "drop-share"
SHARE_BASE_URL = os.environ.get("SHARE_BASE_URL", "").strip().rstrip("/")
SHARE_MAX_DAYS = max(1, int(os.environ.get("SHARE_MAX_DAYS", "30")))
MAX_SHARE_TEXT = 2 * 1024 * 1024     # characters; a text field, not an archive
MAX_TEXT = MAX_SHARE_TEXT            # the same for a text field in Drop
JSON_MAX = 16 * 1024 * 1024          # bytes of a request; MAX_TEXT fits even escaped
MAX_PASSWORD = 200

# The names Drop answers to (see known_host): IP addresses, names without a
# domain or with a local one, the names of its certificates — and these: the
# host of WEBUI (what "WebUI" in Unraid's Docker tab opens, from the .env) and
# HOSTS, comma-separated, "*.example.org" for every name under example.org.
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".home.arpa", ".internal", ".intranet", ".private",
                  ".corp", ".localdomain", ".fritz.box", ".ts.net")


def configured_hosts() -> list:
    names = re.split(r"[\s,]+", os.environ.get("HOSTS", ""))
    webui = os.environ.get("WEBUI", "").strip()
    if webui and "[" not in webui:                   # http://[IP]/ is Unraid's placeholder
        try:
            names.append(urlsplit(webui if "://" in webui else "//" + webui).hostname or "")
        except ValueError:
            pass
    return [n.strip().lower().strip(".") for n in names if n.strip().strip(".")]


KNOWN_HOSTS = configured_hosts()


def server_name() -> str:
    """NAME from Unraid's ident.cfg, e.g. NAME="Tower". Without the file,
    SERVER_NAME from the environment, otherwise nothing."""
    try:
        for line in UNRAID_IDENT.read_text(encoding="utf-8", errors="replace").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "NAME":
                value = value.strip().strip('"').strip("'").strip()
                if value:
                    return value
    except OSError:
        pass
    return os.environ.get("SERVER_NAME", "").strip()


class Area:
    """Where text fields and files live: the shared area that everyone sees,
    or the area of one user. key is "" for the shared one, otherwise the
    user's name — which is also the folder name, under USERS_DIR."""

    __slots__ = ("key", "files", "texts")

    def __init__(self, key: str, files: Path, texts: Path):
        self.key, self.files, self.texts = key, files, texts


SHARED = Area("", FILES_DIR, TEXTS_DIR)


class User:
    def __init__(self, palette: str, name: str, pin: str):
        self.palette, self.name = palette, name
        # Without a PIN of their own, PIN (if set) is theirs: whoever set one
        # does not want anybody in by a click.
        self.pin = pin or LAN_PIN
        self.area = Area(name, USERS_DIR / name / "files", USERS_DIR / name / "texts")


def read_users() -> tuple:
    """USER_<COLOUR> from the environment: ({palette: User}, [problems])."""
    users, problems, seen = {}, [], set()
    for palette in PALETTES:
        variable = f"USER_{palette.upper()}"
        raw = os.environ.get(variable, "").strip()
        if not raw:
            continue
        name, _, pin = raw.partition(":")
        name = " ".join(unicodedata.normalize("NFC", name).split())
        if not name or len(name) > USER_NAME_MAX or name.startswith(".") \
                or any(ord(ch) < 32 or ch in "/\\" for ch in name):
            problems.append(f"{variable}: \"{name}\" cannot be a name (1–{USER_NAME_MAX} "
                            "characters, no / or \\, not starting with a dot)")
        elif name.casefold() in seen:
            problems.append(f"{variable}: the name \"{name}\" is taken twice")
        else:
            seen.add(name.casefold())
            users[palette] = User(palette, name, pin.strip())
    return users, problems


USERS, USER_PROBLEMS = ({}, []) if PUBLIC else read_users()


def areas() -> list:
    return [SHARED] + [u.area for u in USERS.values()]


def area_by_key(key: str) -> Optional[Area]:
    return next((a for a in areas() if a.key == key), None)


def with_server(template: str) -> str:
    return " ".join(template.replace("{server}", server_name()).split())


def app_name() -> str:
    return with_server(APP_NAME_TEMPLATE) or "Drop"


def app_notice() -> str:
    return with_server(APP_NOTICE_TEMPLATE)


def find_certificates(only: str = "") -> list:
    """TLS_CERT=auto: every certificate in CERTS_DIR that covers drop.<domain>,
    by that name or as *.<domain> — one per domain; with `only`, for that domain
    alone. Laid out the way Let's Encrypt clients keep them — Nginx Proxy
    Manager's live/npm-<N>/, certbot's live/<name>/ — as fullchain.pem next to
    privkey.pem. Per domain the exact drop.<domain> wins over the wildcard, then
    the one that lives longest. With several domains, the browser gets the
    certificate for the name it asked for (SNI); see tls_context_factory."""
    now = time.time()
    found = {}                                   # domain -> [(exact, expires, cert, key)]
    folders = list(CERTS_DIR.glob("live/*")) + list(CERTS_DIR.glob("*"))
    for folder in folders:
        cert, key = folder / "fullchain.pem", folder / "privkey.pem"
        try:
            if not (cert.is_file() and key.is_file()):
                continue
            info = ssl._ssl._test_decode_cert(str(cert))
            expires = ssl.cert_time_to_seconds(info["notAfter"])
        except (OSError, ValueError, KeyError, AttributeError, ssl.SSLError):
            continue
        if expires < now:
            continue
        for kind, name in info.get("subjectAltName", ()):
            name = name.lower()
            if kind != "DNS" or "." not in name:
                continue
            label, domain = name.split(".", 1)
            if label in (TLS_AUTO_NAME, "*"):
                found.setdefault(domain, []).append((label != "*", expires, str(cert), str(key)))
    if only:
        only = only[len(TLS_AUTO_NAME) + 1:] if only.startswith(TLS_AUTO_NAME + ".") else only
        found = {only: found[only]} if only in found else {}
    chosen = []
    for domain, options in found.items():
        exact, expires, cert, key = max(options)  # the exact name first, then the longest-lived
        chosen.append((domain, cert, key, expires))
    chosen.sort(key=lambda c: c[3], reverse=True)  # the first one also answers by IP
    if not chosen:
        wanted = only or "<domain>"
        print(f"No certificate for {TLS_AUTO_NAME}.{wanted} or *.{wanted} in {CERTS_DIR} — "
              "running without TLS.", flush=True)
    for domain, cert, _, _ in chosen:
        print(f"Certificate found for {TLS_AUTO_NAME}.{domain}: {cert}", flush=True)
    if len(chosen) > 1:
        print(f"Each name gets its own certificate; opened by IP address: {TLS_AUTO_NAME}.{chosen[0][0]}",
              flush=True)
    return chosen


_tls_choice: Optional[list] = None              # [(domain, cert, key, expires)], first = default


def tls_certificates() -> list:
    global _tls_choice
    if _tls_choice is None:
        if TLS_AUTO or TLS_DOMAIN:
            _tls_choice = find_certificates(TLS_DOMAIN)
        elif TLS_CERT and TLS_KEY and Path(TLS_CERT).is_file() and Path(TLS_KEY).is_file():
            _tls_choice = [("", TLS_CERT, TLS_KEY, 0)]
        else:
            _tls_choice = []
    return _tls_choice


def tls_ready() -> tuple:
    """The default certificate and key — or (None, None) for plain HTTP."""
    chosen = tls_certificates()
    return (chosen[0][1], chosen[0][2]) if chosen else (None, None)


_certificate_names: Optional[list] = None


def certificate_names() -> list:
    """The names the certificates in use are for, e.g. drop.example.org or
    *.example.org. A renewal restarts Drop, so they are read once."""
    global _certificate_names
    if _certificate_names is None:
        names = []
        for _, cert, _, _ in tls_certificates():
            try:
                info = ssl._ssl._test_decode_cert(cert)
            except (OSError, ValueError, AttributeError, ssl.SSLError):
                continue
            names += [n.lower() for kind, n in info.get("subjectAltName", ()) if kind == "DNS"]
        _certificate_names = names
    return _certificate_names


def tls_context_factory(config, default_factory) -> ssl.SSLContext:
    """uvicorn's TLS context, plus one per further domain: during the handshake
    the browser names the host it wants (SNI), and gets that domain's
    certificate. Without a name (opened by IP) the default one answers."""
    import uvicorn.config
    context = default_factory()
    by_domain = {}
    for domain, cert, key, _ in tls_certificates():
        by_domain[domain] = uvicorn.config.create_ssl_context(
            certfile=cert, keyfile=key, password=None, ssl_version=config.ssl_version,
            cert_reqs=config.ssl_cert_reqs, ca_certs=None, ciphers=config.ssl_ciphers)

    def pick(sock, server_name, _context):
        name = (server_name or "").lower().rstrip(".")
        domain = name.split(".", 1)[1] if "." in name else ""
        if domain in by_domain:
            sock.context = by_domain[domain]

    context.sni_callback = pick
    return context


PART_PREFIX = ".upload-"


# ---------------------------------------------------------------- Languages
#
# Every text people read lives in lang/<code>.json — the web page ("ui.*") and
# the public share page ("public.*"). Adding a language means adding that file
# (and help/<code>.html), here or in CUSTOM_DIR; it is picked up without a
# restart. Keys a language does not have fall back to English.

LANG_CODE_PATTERN = re.compile(r"^[a-z]{2,3}$")
_lang_cache: Dict[str, tuple] = {}


def available_languages() -> list:
    codes = set()
    for folder in (CUSTOM_DIR / "lang", LANG_DIR):
        try:
            codes |= {p.stem for p in folder.glob("*.json") if LANG_CODE_PATTERN.match(p.stem)}
        except OSError:
            pass
    return sorted(codes | {DEFAULT_LANGUAGE})


def load_language(code: str) -> dict:
    """The strings of one language: the built-in file with the custom one laid
    over it key by key — a custom file only needs the keys it changes. Cached
    until one of the files changes."""
    paths = [base / f"{code}.json" for base in (LANG_DIR, CUSTOM_DIR / "lang")]
    stamp = []
    for path in paths:
        try:
            stamp.append(path.stat().st_mtime)
        except OSError:
            stamp.append(None)
    stamp = tuple(stamp)
    cached = _lang_cache.get(code)
    if cached and cached[0] == stamp:
        return cached[1]
    strings = {}
    for path, mtime in zip(paths, stamp):
        if mtime is not None:
            data = read_json(path) or {}
            strings.update({k: v for k, v in data.items()
                            if isinstance(k, str) and isinstance(v, str)})
    _lang_cache[code] = (stamp, strings)
    return strings


PLURAL_SUFFIX = re.compile(r"_(zero|one|two|few|many|other)$")


def language_strings(code: str) -> dict:
    """The language's strings with English filling the gaps. Plural forms are
    taken as a set: if a language has any form of a key (words_other), none of
    the English forms of it are mixed in — otherwise a missing words_one would
    turn into English in the middle of the page."""
    english = load_language(DEFAULT_LANGUAGE)
    if code == DEFAULT_LANGUAGE:
        return dict(english)
    own_strings = load_language(code)
    own_plurals = {PLURAL_SUFFIX.sub("", k) for k in own_strings if PLURAL_SUFFIX.search(k)}
    merged = {k: v for k, v in english.items()
              if not (PLURAL_SUFFIX.search(k) and PLURAL_SUFFIX.sub("", k) in own_plurals)}
    merged.update(own_strings)
    return merged


def language_aliases() -> dict:
    """Other codes browsers use for a language, from "meta.aliases" in its file
    — e.g. Norwegian: nb has the aliases no and nn."""
    aliases = {}
    for code in available_languages():
        for alias in load_language(code).get("meta.aliases", "").split(","):
            alias = alias.strip().lower()
            if alias:
                aliases[alias] = code
    return aliases


def pick_language(preferences: str) -> str:
    """The first language the visitor prefers that Drop has, English otherwise.
    Takes an Accept-Language header ("de-CH,de;q=0.9,en;q=0.8") — the browser
    sends the same list as navigator.languages."""
    available = available_languages()
    aliases = language_aliases()
    ranked = []
    for position, item in enumerate((preferences or "").split(",")):
        tag, _, params = item.strip().partition(";")
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.strip().partition("=")
            if key == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        if tag.strip() and quality > 0:
            ranked.append((-quality, position, tag.strip().lower()))
    for _, _, tag in sorted(ranked):
        primary = tag.split("-", 1)[0]
        if primary in available:
            return primary
        if primary in aliases:
            return aliases[primary]
    return DEFAULT_LANGUAGE


def fill(template: str, **values) -> str:
    """{name} placeholders without str.format — a stray brace in a translation
    must not break the page."""
    for key, value in values.items():
        template = template.replace("{" + key + "}", str(value))
    return template


def api_error(status: int, code: str, message: str) -> HTTPException:
    """Errors the web page may show to people carry a code; the page translates
    it. The English message is for logs, curl and anything unknown."""
    return HTTPException(status, {"code": code, "message": message})


def no_constant(name: str):
    raise ValueError(f"{name} is not a number here")


async def json_body(request: Request, empty: Optional[dict] = None):
    """The JSON a request carries, read only up to JSON_MAX — and only as
    application/json: a form from another web site cannot be sent with that
    type without the browser asking Drop first. No body: `empty`, if given."""
    raw = bytearray()
    async for piece in request.stream():
        raw += piece
        if len(raw) > JSON_MAX:
            raise HTTPException(413, "Request too large")
    if not raw and empty is not None:
        return empty
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Expected application/json")
    try:
        return json.loads(raw, parse_constant=no_constant)
    except (ValueError, RecursionError):
        raise HTTPException(400, "Invalid JSON")


# ---------------------------------------------------------------- Helpers

def own(path: Path) -> None:
    """New files belong to nobody:users (99:100 on Unraid), not to root."""
    try:
        os.chown(path, PUID, PGID)
    except (PermissionError, OSError):
        pass


def clean_name(raw: str) -> str:
    """
    Turns any name into one that can live flat in files/.

    Normalised to NFC so that 'Grüsse.pdf' from a Mac (NFD) and from Windows
    (NFC) are the same file. Characters Windows forbids are kept — they are
    legal on a Mac, and Chrome replaces them on download by itself.
    """
    name = unicodedata.normalize("NFC", raw)
    name = name.replace("\\", "/").rsplit("/", 1)[-1]        # base name only
    name = "".join(ch for ch in name if ord(ch) >= 32)        # no control characters
    name = name.strip().lstrip(".")                           # no hidden files
    if not name:
        name = "unnamed"
    return truncate_bytes(name, MAX_NAME_BYTES)


def truncate_bytes(name: str, limit: int) -> str:
    """Shortens by bytes, not characters — an emoji takes four bytes."""
    if len(name.encode("utf-8")) <= limit:
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    ext_bytes = len(("." + ext).encode("utf-8")) if ext else 0
    if ext_bytes > 32:                   # "Dr. Müller …" — a dot, but no extension
        stem, ext, ext_bytes = name, "", 0
    room = max(limit - ext_bytes, 16)
    out = stem
    while len(out.encode("utf-8")) > room:
        out = out[:-1]
    return out + (("." + ext) if ext else "")


def numbered(name: str, n: int) -> str:
    """'file.txt', 2 → 'file (2).txt'."""
    stem, dot, ext = name.rpartition(".")
    if not dot or len(ext.encode("utf-8")) > 31:
        stem, ext = name, ""
    suffix = ("." + ext) if ext else ""
    return truncate_bytes(f"{stem} ({n})", MAX_NAME_BYTES - len(suffix.encode())) + suffix


def unique_name(area: Area, name: str) -> str:
    """Never overwrite: 'file.txt' → 'file (2).txt'."""
    candidate, n = name, 2
    while (area.files / candidate).exists():
        candidate, n = numbered(name, n), n + 1
    return candidate


def place(area: Area, source: Path, wanted: str) -> str:
    """Moves a finished file in under its name, or 'name (2)' if that is taken
    — never over another file, even when two with the same name finish at the
    same moment: a hard link fails if the name exists, a rename would not."""
    candidate, n = wanted, 2
    while True:
        target = area.files / candidate
        try:
            os.link(source, target)
        except FileExistsError:
            candidate, n = numbered(wanted, n), n + 1
            continue
        except OSError:                  # no hard links here: the old way
            target = area.files / unique_name(area, wanted)
            os.replace(source, target)
            return target.name
        source.unlink()
        return candidate


def content_disposition(name: str) -> str:
    """
    RFC 6266. Safari reads a bare filename="…" as Latin-1 and turns Grüsse.pdf
    into GrÃ¼sse.pdf — hence always both forms side by side.
    """
    fallback = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    # Printable ASCII only: a name made over SMB may hold control characters,
    # which a header must never carry.
    fallback = "".join(ch for ch in fallback if 32 <= ord(ch) < 127 and ch not in '"\\')
    fallback = fallback.strip() or "download"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


def safe_target(area: Area, name: str) -> Path:
    """Resolves a name to a file directly inside the area's files — nowhere
    else. The name exactly as listed first: one made over SMB may be NFD (from a
    Mac) or hold a backslash. Then as Drop stores names, NFC."""
    if "\x00" in name:
        raise HTTPException(400, "Invalid name")
    folder = area.files.resolve()
    if "/" not in name and name not in ("", ".", ".."):
        exact = area.files / name
        if not name.startswith(".") and os.path.lexists(exact) and exact.resolve().parent == folder:
            return exact.resolve()
    cleaned = unicodedata.normalize("NFC", name).replace("\\", "/").rsplit("/", 1)[-1]
    target = (area.files / cleaned).resolve()
    if target.parent != folder:
        raise HTTPException(400, "Invalid name")
    if target.name.startswith("."):      # uploads in progress, things of the system
        raise HTTPException(404, "File not found")
    return target


# ---------------------------------------------------------------- Text fields
#
# A field is a file text<N>.txt; N is its fixed id and the order follows N.
# The number the page shows ("Field 2") is the position instead — when a field
# is removed, the ones below move up.

FIELD_PATTERN = re.compile(r"^text(\d{1,6})\.txt$")
FIELDS_MARKER = ".fields"


def text_path(area: Area, fid: int) -> Path:
    return area.texts / f"text{fid}.txt"


def field_ids(area: Area) -> list:
    """Which fields exist is defined by the directory alone: text<N>.txt, sorted by N."""
    ids = []
    for entry in os.scandir(area.texts):
        match = FIELD_PATTERN.match(entry.name)
        if match and entry.is_file():
            ids.append(int(match.group(1)))
    return sorted(ids)


def setup_fields(area: Area) -> None:
    """
    Creates the starting fields once and remembers that with a marker file.
    After that a removed field stays removed, across restarts too. Without the
    marker — or with no field left at all — the starting fields come back.
    """
    marker = area.texts / FIELDS_MARKER
    if marker.exists() and field_ids(area):
        return
    for fid in range(1, FIELDS_START + 1):
        if not text_path(area, fid).exists():
            write_text(area, fid, "")
    marker.touch()
    own(marker)


def reset_fields(area: Area) -> None:
    for fid in field_ids(area):
        try:
            text_path(area, fid).unlink()
        except FileNotFoundError:
            pass
    for fid in range(1, FIELDS_START + 1):
        write_text(area, fid, "")


def fields_state(area: Area) -> list:
    state = []
    for fid in field_ids(area):
        content = read_text(area, fid)
        state.append({"id": fid, "text": content, "version": version_of(content)})
    return state


def version_of(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def read_text(area: Area, fid: int) -> str:
    path = text_path(area, fid)
    if not path.exists():
        return ""
    # Explicit encoding: without it Python uses the container locale, and
    # python:slim has none — the result would be ASCII.
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        content = f.read()
    return content.lstrip("﻿")     # BOM from Windows Notepad


def write_text(area: Area, fid: int, content: str) -> None:
    content = content.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    path = text_path(area, fid)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    own(tmp)
    os.replace(tmp, path)               # atomic, no half-written field after a crash


def list_files(area: Area) -> list:
    out = []
    for entry in os.scandir(area.files):
        if entry.name.startswith("."):
            continue
        try:
            entry.name.encode("utf-8")
        except UnicodeEncodeError:       # not UTF-8 (made over SMB): cannot be named on a page
            continue
        if not entry.is_file():
            continue
        st = entry.stat()
        out.append({
            "name": entry.name,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
        })
    out.sort(key=lambda f: f["mtime"], reverse=True)
    return out


def disk_space(area: Area = SHARED) -> dict:
    try:
        usage = shutil.disk_usage(area.files)
        return {"free": usage.free, "total": usage.total}
    except OSError:
        return {"free": 0, "total": 0}


# ---------------------------------------------------------------- Shares
#
# Both containers use SHARES_DIR, with split roles:
#
#   <id>.json          record               written by the LAN container only
#   files/<id>         hard link of a file  written by the LAN container only
#   counters/<id>.json views, downloads     written by the public container only
#   .key               cookie secret        created by the LAN container
#
# The public container gets SHARES_DIR read-only (except counters/) and nothing
# else: no drop box, no text fields, no certificate. It sees exactly what is
# currently shared.
#
# A record's file name is a hash of the token, not the token itself — whoever
# sees the directory does not have a link yet.
#
# Text is copied into the record when shared. A file is hard-linked to
# files/<id>: no extra space, even for 50 GB, and the public container never
# needs the drop box. If the original is deleted or replaced by a file of the
# same name, the inode no longer matches — the LAN container then removes the
# share together with its hard link.

# Links are meant to be read out and typed: ten characters in two groups,
# k7m3x-9pq2r, from an alphabet without look-alikes (no 0/o, 1/l/i). 31^10 is
# about 50 bits — far beyond guessing over the network. Typed in upper case or
# without the dash, a link still works.
TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
TOKEN_LENGTH = 10
TOKEN_PATTERN = re.compile(rf"^[{TOKEN_ALPHABET}]{{5}}-[{TOKEN_ALPHABET}]{{5}}$")
# The longer links of the first versions: 22 URL-safe characters. Still accepted.
LEGACY_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{22}$")
SHARE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
BLOB_DIR = SHARES_DIR / "files"
COUNTERS_DIR = SHARES_DIR / "counters"
share_lock = threading.Lock()


def share_id(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()[:32]


def new_token() -> str:
    chars = "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))
    return f"{chars[:5]}-{chars[5:]}"


def normal_token(raw: str) -> Optional[str]:
    """The token as stored, from a link as typed — or None if it cannot be one."""
    if LEGACY_TOKEN_PATTERN.match(raw):
        return raw
    chars = "".join(raw.lower().split()).replace("-", "")
    token = f"{chars[:5]}-{chars[5:]}"
    return token if TOKEN_PATTERN.match(token) else None


def share_path(sid: str) -> Path:
    return SHARES_DIR / f"{sid}.json"


def share_blob(sid: str) -> Path:
    return BLOB_DIR / sid


def counter_path(sid: str) -> Path:
    return COUNTERS_DIR / f"{sid}.json"


PW_ITERATIONS = 600_000              # PBKDF2-SHA256, as OWASP advises; records keep theirs
PW_ITERATIONS_KNOWN = (200_000, 600_000)   # before 2.0.1: 200 000


def password_hash(password: str, salt: bytes, iterations: int = PW_ITERATIONS) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


_secret: Optional[bytes] = None


def cookie_secret() -> bytes:
    """Secret for the unlock cookies. The LAN container creates it, the public
    one only reads it — so an unlocked link survives a restart."""
    global _secret
    if _secret is None:
        path = SHARES_DIR / ".key"
        try:
            _secret = bytes.fromhex(path.read_text().strip())
        except (OSError, ValueError):
            _secret = secrets.token_bytes(32)
            if PUBLIC:
                print("No readable .key — unlocked password links only last until "
                      "the next restart.", flush=True)
                return _secret
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(_secret.hex())
                own(path)
            except OSError:
                pass
    return _secret


def unlock_value(rec: dict) -> str:
    return hmac.new(cookie_secret(), f"{rec['id']}:{rec.get('pw_salt', '')}".encode(),
                    "sha256").hexdigest()


def read_json(path: Path) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    own(tmp)
    os.replace(tmp, path)


def read_share(sid: str) -> Optional[dict]:
    return read_json(share_path(sid))


def write_share(rec: dict) -> None:
    write_json(share_path(rec["id"]), rec)


def remove_share(sid: str) -> None:
    for path in (share_path(sid), share_blob(sid), counter_path(sid)):
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def shared_file(rec: dict) -> Optional[Path]:
    """The hard link behind a file share, if it is (still) there."""
    blob = share_blob(rec["id"])
    try:                                 # the hard link itself, never a symlink planted there
        return blob if stat.S_ISREG(blob.lstat().st_mode) else None
    except OSError:
        return None


def original_present(rec: dict) -> bool:
    """LAN container only: is the original still in the drop box? Hard link and
    original share an inode — if it differs, the file was deleted or replaced
    by one of the same name."""
    area = area_by_key(rec.get("area", ""))
    try:
        a = share_blob(rec["id"]).stat()
        b = safe_target(area, rec["name"]).stat()
    except (HTTPException, OSError, KeyError, AttributeError):
        return False
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def share_valid(rec: dict, now: float) -> bool:
    if not isinstance(rec.get("expires"), (int, float)) or rec["expires"] <= now:
        return False
    # The area of a user who is no longer configured: nobody could see or
    # end the link any more, so it ends here.
    if not PUBLIC and area_by_key(rec.get("area", "")) is None:
        return False
    if rec.get("kind") == "file":
        if PUBLIC:
            return shared_file(rec) is not None
        return original_present(rec)
    return rec.get("kind") == "text"


def tidy_shares() -> tuple:
    """LAN container only. Reads every share and removes expired and orphaned
    ones together with hard link and counters. Returns (valid, number removed)."""
    valid, removed, now = [], 0, time.time()
    if not SHARES_DIR.is_dir():
        return valid, removed
    for entry in os.scandir(SHARES_DIR):
        if entry.name.endswith(".tmp"):
            try:                                 # leftover of an interrupted write
                if now - entry.stat().st_mtime > 600:
                    os.unlink(entry.path)
            except OSError:
                pass
            continue
        if not entry.name.endswith(".json"):
            continue
        rec = read_share(entry.name[:-5])
        if rec and rec.get("id") == entry.name[:-5] and share_valid(rec, now):
            valid.append(rec)
        else:
            remove_share(entry.name[:-5])
            removed += 1

    # Hard links and counters without a record (crash halfway through creating
    # one). One minute of grace: the hard link is made before the record. A hard
    # link keeps the file's old mtime — its ctime is when it was made.
    known = {r["id"] for r in valid}
    for folder in (BLOB_DIR, COUNTERS_DIR):
        if not folder.is_dir():
            continue
        for entry in os.scandir(folder):
            sid = entry.name.split(".", 1)[0]
            try:
                st = entry.stat(follow_symlinks=False)
                if sid not in known and now - max(st.st_mtime, st.st_ctime) > 60:
                    os.unlink(entry.path)
            except OSError:
                pass

    valid.sort(key=lambda r: r["expires"])
    return valid, removed


def count_words(text: str) -> int:
    """Same as in the browser: everything between whitespace that contains a
    letter or digit. A lone dash is no word, "e.g." is one."""
    return sum(1 for piece in text.split() if any(ch.isalnum() for ch in piece))


def share_for_lan(rec: dict) -> dict:
    """What the LAN page learns about a share. It does not need the whole text,
    a preview is enough. The counters come from the public container."""
    out = {k: rec.get(k) for k in ("id", "kind", "name", "created", "expires", "size", "field")}
    out["area"] = rec.get("area", "")
    out.update(read_counters(rec["id"]))
    out["token"] = rec["token"]
    out["password"] = bool(rec.get("pw_hash"))
    if rec.get("kind") == "text":
        out["preview"] = " ".join(rec.get("text", "")[:160].split())[:100]
    return out


def shares_list() -> list:
    return [share_for_lan(r) for r in tidy_shares()[0]]


def visible_shares(shares: list, user: Optional["User"]) -> list:
    """The shares of the areas this user sees, each marked "own" or "shared"
    from their point of view. Without users everything is shared."""
    out = []
    for rec in shares:
        if rec["area"] == "":
            out.append({**rec, "area": "shared"})
        elif user and rec["area"] == user.area.key:
            out.append({**rec, "area": "own"})
    return out


def read_counters(sid: str) -> dict:
    """Views and downloads. Written by drop-share, the container facing the
    internet — so taken with care: a regular file, small, whole numbers only.
    Anything else counts as 0 and cannot hold up or break the LAN page."""
    counts = {"views": 0, "downloads": 0}
    try:
        fd = os.open(counter_path(sid), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError:
        return counts
    try:
        info = os.fstat(fd)
        data = json.loads(os.read(fd, 4096)) \
            if stat.S_ISREG(info.st_mode) and info.st_size <= 4096 else {}
    except (OSError, ValueError, RecursionError):
        data = {}
    finally:
        os.close(fd)
    for key in counts:
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10 ** 12:
            counts[key] = value
    return counts


def count_access(sid: str, what: str) -> None:
    """Public container only — counters/ is the one place it may write to."""
    with share_lock:
        data = read_counters(sid)
        data[what] += 1
        try:
            write_json(counter_path(sid), data)
        except OSError:
            pass                 # counters/ not writable: then without numbers


def hardlink_probe(folder: Path = FILES_DIR) -> Optional[str]:
    """Can files be hard-linked from the drop box into shares/files? Only if
    both are on the same file system AND in the same mount — separate bind
    mounts fail with EXDEV, even on the same disk."""
    source = folder / f".linkprobe-{uuid.uuid4().hex[:8]}"
    target = BLOB_DIR / source.name
    try:
        source.write_bytes(b"")
        os.link(source, target)
        return None
    except OSError as error:
        return str(error)
    finally:
        for p in (target, source):
            try:
                p.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------- Upload state

class Upload:
    """An upload in progress. Its state is also kept in a sidecar file, so a
    container restart in the middle of an upload costs nothing."""

    def __init__(self, area: Area, uid: str, name: str, size: int, modified: Optional[int] = None):
        self.area = area
        self.id = uid
        self.name = name                    # cleaned, wanted name
        self.size = size
        # When the browser says the file was last changed: a file of the same
        # name and size, but changed since, starts over instead of resuming.
        self.modified = modified
        self.chunks: Set[int] = set()
        self.total = max(1, -(-size // CHUNK_SIZE)) if size else 1
        self.started = time.time()
        self.active = self.started          # the last time a chunk came in
        self.last_broadcast = 0.0
        self.finishing = False
        # Two chunks run in parallel and report completion from two thread-pool
        # threads. Without a lock both write the same .tmp file and one of them
        # no longer finds it when renaming.
        self.lock = threading.Lock()

    @property
    def part(self) -> Path:
        return self.area.files / f"{PART_PREFIX}{self.id}.part"

    @property
    def meta(self) -> Path:
        return self.area.files / f"{PART_PREFIX}{self.id}.json"

    @property
    def received_bytes(self) -> int:
        done = len(self.chunks)
        if done >= self.total:
            return self.size
        return min(self.size, done * CHUNK_SIZE)

    def chunk_length(self, index: int) -> int:
        return max(0, min(CHUNK_SIZE, self.size - index * CHUNK_SIZE))

    def contiguous(self) -> int:
        n = 0
        while n in self.chunks:
            n += 1
        return n

    def save_meta(self) -> None:
        with self.lock:
            payload = {"id": self.id, "name": self.name, "size": self.size,
                       "modified": self.modified, "chunks": sorted(self.chunks),
                       "started": self.started, "active": self.active}
            tmp = self.meta.with_name(f"{self.meta.name}.{uuid.uuid4().hex[:8]}.tmp")
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False)
                own(tmp)
                os.replace(tmp, self.meta)
                own(self.meta)
            except FileNotFoundError:
                # The upload was cancelled or everything deleted in the
                # meantime — nothing left to keep track of.
                try:
                    tmp.unlink()
                except FileNotFoundError:
                    pass

    def discard(self) -> None:
        for p in (self.part, self.meta, *self.meta.parent.glob(f"{self.meta.name}.*.tmp")):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

    def as_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "size": self.size,
                "received": self.received_bytes, "chunks": len(self.chunks),
                "total": self.total}


uploads: Dict[str, Upload] = {}


def area_uploads(area: Area) -> list:
    return [u.as_dict() for u in uploads.values() if u.area is area]


def restore_uploads(area: Area) -> None:
    """Reads the sidecars after a restart — e.g. when a backup job stopped the
    container in the middle of a 500 GB upload."""
    for meta in area.files.glob(f"{PART_PREFIX}*.json"):
        try:
            data = json.loads(meta.read_text(encoding="utf-8"))
            if not re.fullmatch(r"[0-9a-f]{12}", str(data["id"])):
                continue
            modified = data.get("modified")
            up = Upload(area, data["id"], clean_name(str(data["name"])), int(data["size"]),
                        int(modified) if isinstance(modified, int) else None)
            up.chunks = set(int(c) for c in data.get("chunks", []) if 0 <= int(c) < up.total)
            up.started = float(data.get("started", time.time()))
            up.active = float(data.get("active", up.started))
            if up.part.exists():
                uploads[up.id] = up
            else:
                meta.unlink()
        except Exception:
            continue


UPLOAD_IDLE_DAYS = 7                 # an upload nobody continued for so long is given up
UPLOAD_QUIET = 10 * 60               # no chunk for so long: no longer "running"


def running_uploads() -> bool:
    now = time.time()
    return any(now - up.active < UPLOAD_QUIET for up in uploads.values())


def expire_uploads() -> list:
    """Gives up uploads nobody continued for UPLOAD_IDLE_DAYS — a phone that
    went to sleep, a tab that was closed. Their space comes back."""
    now = time.time()
    gone = [up for up in list(uploads.values())
            if now - up.active > UPLOAD_IDLE_DAYS * 86400 and not up.finishing]
    for up in gone:
        uploads.pop(up.id, None)
        up.discard()
    return gone


# ---------------------------------------------------------------- SSE hub

class Hub:
    """Live updates. Every page is told about the shared area; about a user's
    own area only that user's pages are. Each event says which of the two it
    is about, from the receiver's point of view: "shared" or "own"."""

    def __init__(self) -> None:
        self.clients: Dict[asyncio.Queue, Optional[User]] = {}

    def send(self, queue: asyncio.Queue, event: str, data) -> None:
        try:
            queue.put_nowait((event, data))
        except asyncio.QueueFull:
            pass

    def publish(self, event: str, data: dict, area: Area = SHARED) -> None:
        for queue, user in list(self.clients.items()):
            if area is SHARED:
                self.send(queue, event, {**data, "area": "shared"})
            elif user and user.area is area:
                self.send(queue, event, {**data, "area": "own"})

    def publish_shares(self, shares: list) -> None:
        for queue, user in list(self.clients.items()):
            self.send(queue, "shares", {"shares": visible_shares(shares, user)})


hub = Hub()


def announce_files(area: Area) -> None:
    hub.publish("files", {"files": list_files(area), "uploads": area_uploads(area),
                          "space": disk_space(area)}, area)


async def announce_shares() -> None:
    if SHARING_ENABLED:
        hub.publish_shares(await run_in_threadpool(shares_list))


async def watch_shares(interval: int = 15) -> None:
    """Removes what expired or lost its file, and keeps the LAN list current.
    The public container writes the counters but cannot tell anyone, so the LAN
    container looks regularly and only announces actual changes. Expired links
    are never served either way — every request checks for itself."""
    last = None
    while True:
        await asyncio.sleep(interval)
        try:
            current = await run_in_threadpool(shares_list)
            snapshot = json.dumps(current, sort_keys=True)
            if snapshot != last:
                if last is not None:
                    hub.publish_shares(current)
                last = snapshot
        except Exception as error:
            print(f"Tidying shares: {error}", flush=True)


# ---------------------------------------------------------------- App

HOSTNAME_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")


def host_without_port(value: str) -> str:
    value = (value or "").strip().lower()
    if value.startswith("["):                       # [::1]:443
        return value[1:].split("]", 1)[0]
    return value.split(":", 1)[0].rstrip(".")


async def http_redirect(fallback: str, port: int = 80):
    """Tiny listener on port 80 that redirects to HTTPS under the same name, so
    old bookmarks keep working whatever name they use. The fallback
    (HTTPS_HOST) only applies when a client sends no Host header."""

    async def handle(reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            parts = line.decode("latin-1", "replace").split()
            path = parts[1] if len(parts) >= 2 and parts[1].startswith("/") else "/"
            target = fallback
            for _ in range(64):                  # headers up to the empty line
                header = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if header in (b"\r\n", b"\n", b""):
                    break
                name, _, value = header.decode("latin-1", "replace").partition(":")
                if name.strip().lower() == "host" and HOSTNAME_PATTERN.match(host_without_port(value)):
                    target = host_without_port(value)
            if not target:
                return
            reply = ("HTTP/1.1 301 Moved Permanently\r\n"
                     f"Location: https://{target}{path}\r\n"
                     "Content-Length: 0\r\nConnection: close\r\n\r\n")
            writer.write(reply.encode("latin-1"))
            await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(handle, "0.0.0.0", port)
    print(f"HTTP :{port} redirects to HTTPS", flush=True)
    return server


async def watch_certificate(paths: list, interval: int = 300) -> None:
    """Let's Encrypt renews every 60 days; uvicorn only reads certificates at
    start-up. So: notice the change and exit — `restart: unless-stopped` brings
    the container straight back. Only while no upload is running — one that
    has not moved for UPLOAD_QUIET does not count, or a single abandoned upload
    would keep the old certificate until it expires."""
    def stamps() -> list:
        out = []
        for path in paths:
            try:
                out.append(Path(path).stat().st_mtime)
            except OSError:
                out.append(None)
        return out
    last = stamps()
    while True:
        await asyncio.sleep(interval)
        now = stamps()
        if now != last and None not in now and not running_uploads():
            print("Certificate renewed — restarting so it takes effect.", flush=True)
            os._exit(0)


REQUIRED_FILES = ("index.html", "app.js", "style.css")


def missing_files() -> list:
    return [n for n in REQUIRED_FILES if not (STATIC_DIR / n).is_file()]


def banner(*lines: str) -> None:
    print("=" * 64, flush=True)
    for line in lines:
        print(f"  {line}", flush=True)
    print("=" * 64, flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start-up. Lifespan rather than @app.on_event — the latter is deprecated
    and logs a warning on every start."""
    folders = [SHARED.files, SHARED.texts, THUMBS_DIR] + ([USERS_DIR] if USERS else [])
    for user in USERS.values():
        folders += [user.area.files.parent, user.area.files, user.area.texts]
    if SHARING_ENABLED:
        folders += [SHARES_DIR, BLOB_DIR, COUNTERS_DIR]
    for d in folders:
        d.mkdir(parents=True, exist_ok=True)
        own(d)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    own(TMP_DIR)
    tempfile.tempdir = str(TMP_DIR)
    for area in areas():
        setup_fields(area)
        restore_uploads(area)
        for left in area.files.glob(SHARED_PREFIX + "*"):  # copying cut off by a restart
            left.unlink(missing_ok=True)
    if USERS:
        for user in USERS.values():
            print(f"User {user.name} ({user.palette}): {'with' if user.pin else 'WITHOUT'} PIN, "
                  f"files in {user.area.files}", flush=True)
            if user.pin and len(user.pin) < 4:
                print(f"  The PIN of {user.name} is shorter than 4 characters — easy to guess.",
                      flush=True)
        if LAN_PIN:
            print("PIN is the PIN of every user without one of their own.", flush=True)
    elif LAN_PIN:
        print("PIN is set: every new browser is asked for it once.", flush=True)
        if len(LAN_PIN) < 4:
            print("The PIN is shorter than 4 characters — easy to guess.", flush=True)

    missing = missing_files()
    if missing:
        banner(f"{app_name().upper()} IS NOT FULLY INSTALLED",
               f"Missing: {', '.join('static/' + n for n in missing)}",
               f"Expected inside the container at: {STATIC_DIR}",
               "If you mount code of your own over /app, the static/",
               "subfolder with these three files has to be there.")
    else:
        print(f"{app_name()} ready — files in {FILES_DIR}, texts in {TEXTS_DIR}", flush=True)
        if not server_name():
            print(f"  No server name found ({UNRAID_IDENT}) — shown without.", flush=True)

    cert, _ = tls_ready()
    if cert:
        try:
            app.state.redirect = await http_redirect(HTTPS_HOST, HTTP_PORT)
        except OSError as error:
            print(f"Port {HTTP_PORT} is busy, no redirect: {error}", flush=True)
        app.state.cert_watch = asyncio.create_task(
            watch_certificate([c[1] for c in tls_certificates()]))
    elif (TLS_CERT or TLS_KEY) and not (TLS_AUTO or TLS_DOMAIN):
        banner("TLS_CERT/TLS_KEY are set but not readable:",
               f"  {TLS_CERT or '(empty)'}",
               f"  {TLS_KEY or '(empty)'}",
               f"{app_name()} therefore keeps running unencrypted.")

    if SHARING_ENABLED:
        where = SHARE_BASE_URL or f"{SHARE_SUBDOMAIN}.<domain Drop is opened under>"
        print(f"Sharing on: {where}, at most {SHARE_MAX_DAYS} days, records in {SHARES_DIR}",
              flush=True)
        cookie_secret()                    # create it before the public container needs it
        for area in areas():
            error = await run_in_threadpool(hardlink_probe, area.files)
            if error:
                banner("FILES CANNOT BE SHARED (texts can):",
                       f"Hard link {area.files} → {BLOB_DIR} fails: {error}",
                       "Both have to be in the same mount — in compose.yaml, mount",
                       "the drop share as ONE volume at /data.")
                break
        app.state.share_watch = asyncio.create_task(watch_shares())
    app.state.thumb_watch = asyncio.create_task(watch_thumbs())

    yield


app = FastAPI(title="Drop", docs_url=None, redoc_url=None, openapi_url=None,
              lifespan=lifespan)


# Headers set by a reverse proxy or CDN. In the LAN the browser talks to the
# container directly — a request carrying one of these came from outside.
CGNAT = ipaddress.ip_network("100.64.0.0/10")
# IPv6 in IPv4 tunnels: Python calls them private, but they come from anywhere.
TUNNELS = (ipaddress.ip_network("2001::/32"), ipaddress.ip_network("2002::/16"))
PROXY_HEADERS = (b"x-forwarded-for", b"x-real-ip", b"forwarded", b"cf-connecting-ip",
                 b"true-client-ip", b"x-forwarded-host", b"x-forwarded-proto",
                 b"x-forwarded-scheme", b"x-forwarded-port", b"x-forwarded-server",
                 b"x-client-ip", b"via", b"cf-ray")


def from_outside(scope) -> bool:
    """
    How the LAN container tells that a request comes from the internet —
    without knowing a single domain name:

      * It carries a proxy header. Reverse proxies set X-Forwarded-For or
        X-Real-IP (the common ones on their own); in the LAN there is no proxy
        in between.
      * Or it comes from an address that is not private (port forwarding
        straight to the container).

    The Host header deliberately plays no part: any client can set it freely.
    """
    for name, _ in scope.get("headers", []):
        if name in PROXY_HEADERS:
            return True
    client = scope.get("client")
    try:
        address = ipaddress.ip_address(client[0] if client else "")
    except ValueError:
        return True
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    if address.version == 6 and any(address in net for net in TUNNELS):
        return True
    # 100.64/10 (CGNAT) is not "private" to Python, but not routable from the
    # internet either — Tailscale and similar VPNs live there.
    return not (address.is_private or address in CGNAT)


def known_host(value: str) -> bool:
    """Is this a name Drop may be opened under? Against DNS rebinding: a web
    site that points its own name at Drop's address is, to the browser, the
    same site as Drop — it could read and change whatever needs no PIN. Such a
    name is always a public domain of someone else; Drop's own names are IP
    addresses, names without a domain or with a local one, the names of its
    certificates and those in WEBUI and HOSTS."""
    host = host_without_port(value)
    if "." not in host:                  # no Host header at all, localhost, tower
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host.endswith(LOCAL_SUFFIXES):
        return True
    for name in KNOWN_HOSTS + certificate_names():
        if name.startswith(("*.", ".")):
            if host.endswith(name[name.index("."):]):
                return True
        elif host == name:
            return True
    return False


def share_host(value: str) -> bool:
    """drop-share.<domain> belongs to the public container. Arriving here under
    that name means the reverse proxy points at the wrong address."""
    return host_without_port(value).startswith(SHARE_SUBDOMAIN + ".")


# ---- Signing in --------------------------------------------------------------
# Optional, set in the .env: one PIN for everyone (PIN), or up to five
# users (USER_<COLOUR>), each with a name, a PIN and an area of their own. A
# browser without the cookie sees only the sign-in page. The cookie holds when
# it signed in, and as whom, signed with a key in /data that only drop can read
# (drop-share never sees /data). Name and PIN are part of the signature: a
# changed PIN signs those browsers out.

ACCESS_COOKIE = "drop_access"
ACCESS_OPEN = {"/login", "/logout", "/api/help",  # signing in and out, Docker's health check
               "/manifest.webmanifest",       # fetched by the browser without the cookie
               "/static/icon.svg", "/static/icon-192.png", "/static/icon-512.png",
               "/static/icon-maskable-512.png", "/static/apple-touch-icon.png"}
SIGN_IN = bool(USERS or LAN_PIN)
PIN_FAILURES_EACH = 10                     # wrong PINs per address and quarter hour, for one PIN
PIN_FAILURES_ONE = 30                      # for one PIN from all addresses together
PIN_FAILURES_ALL = 50                      # all together, against guessing from many addresses
_access_key: Optional[bytes] = None


def access_key() -> bytes:
    global _access_key
    if _access_key is None:
        path = FILES_DIR.parent / ".access-key"
        try:
            _access_key = bytes.fromhex(path.read_text().strip())
            if len(_access_key) < 32:
                raise ValueError("too short")
        except (OSError, ValueError):
            _access_key = secrets.token_bytes(32)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(_access_key.hex())
                own(path)
            except OSError:
                print("Could not keep the sign-in key — browsers are asked for the PIN "
                      "again after a restart.", flush=True)
    return _access_key


def pin_digest(pin: str) -> str:
    return hashlib.sha256(pin.encode("utf-8")).hexdigest()


def access_signature(issued: int, user: Optional[User] = None) -> str:
    if user:
        message = f"user:{issued}:{user.palette}:{user.name}:{pin_digest(user.pin)}"
    else:
        message = f"access:{issued}:{pin_digest(LAN_PIN)}"
    return hmac.new(access_key(), message.encode("utf-8"), "sha256").hexdigest()


def session(request: Request) -> tuple:
    """(signed in, as which user). Without users the user is always None.
    Cookie: <issued>.<signature>, with users <issued>.<colour>.<signature>."""
    value = request.cookies.get(ACCESS_COOKIE, "")
    if not value.isascii():
        return False, None
    parts = value.split(".")
    user = None
    if USERS:
        if len(parts) != 3 or parts[1] not in USERS:
            return False, None
        issued, user, signature = parts[0], USERS[parts[1]], parts[2]
    elif len(parts) == 2:
        issued, signature = parts
    else:
        return False, None
    if not re.fullmatch(r"[0-9]{1,12}", issued) or not signature:
        return False, None
    age = time.time() - int(issued)
    if -300 < age < ACCESS_DAYS * 86400 and \
            hmac.compare_digest(signature, access_signature(int(issued), user)):
        return True, user
    return False, None


def current_user(request: Request) -> Optional[User]:
    """Who this request comes from — set by pin_gate; None without users."""
    return getattr(request.state, "user", None)


def area_of(request: Request) -> Area:
    """The area a request is about: ?area=own is the user's own, anything
    else the shared one."""
    if request.query_params.get("area") == "own":
        user = current_user(request)
        if not user:
            raise HTTPException(404, "No area of your own")
        return user.area
    return SHARED


def may_see(request: Request, area: Area) -> bool:
    user = current_user(request)
    return area is SHARED or (user is not None and user.area is area)


# The users' colours on the sign-in page, light and dark (the app has its own,
# in style.css).
USER_STYLE = """
.u-teal{--accent:#0B6E75;--accent-soft:#DFEFF0;--on-fill:#FFF}
.u-gold{--accent:#F0A31A;--accent-soft:#FFF3D6;--on-fill:#17130A}
.u-blue{--accent:#2A62C9;--accent-soft:#E4ECFA;--on-fill:#FFF}
.u-violet{--accent:#6D4FC2;--accent-soft:#EEE9FA;--on-fill:#FFF}
.u-coral{--accent:#C9475F;--accent-soft:#FBE6EA;--on-fill:#FFF}
@media (prefers-color-scheme:dark){
.u-teal{--accent:#54C0C4;--accent-soft:#13302F;--on-fill:#08161A}
.u-gold{--accent:#FFB229;--accent-soft:#2A2008;--on-fill:#000}
.u-blue{--accent:#74A8FF;--accent-soft:#15233D;--on-fill:#07121F}
.u-violet{--accent:#B39BFF;--accent-soft:#251C40;--on-fill:#140D24}
.u-coral{--accent:#FF8FA0;--accent-soft:#3A1820;--on-fill:#240A10}}
.users{display:grid;gap:10px;max-width:28rem;margin:0}
.users form{margin:0}
.user{display:flex;align-items:center;gap:12px;width:100%;font:inherit;font-size:16px;font-weight:600;
 text-align:start;padding:11px 14px;border-radius:6px;border:1px solid var(--line2);background:var(--surface);
 color:var(--ink);text-decoration:none;cursor:pointer}
.user:hover,.user:focus-visible{border-color:var(--accent);background:var(--accent-soft);outline:none}
.initial{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;flex:none;
 background:var(--accent);color:var(--on-fill);font-size:16px;font-weight:700}
.lock{margin-inline-start:auto;width:18px;height:18px;fill:none;stroke:var(--muted);stroke-width:1.8;
 stroke-linecap:round;stroke-linejoin:round;flex:none}
.who{display:flex;align-items:center;gap:12px;margin:0 0 4px}
.who h1{margin:0}
.back{display:inline-block;margin-top:20px;color:var(--muted);font-size:13.5px}
"""
LOCK_ICON = ('<svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" '
             'height="9.5" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>')


def sign_in_page(lang: str, t: dict, user: Optional[User] = None, message: str = "",
                 status: int = 200) -> HTMLResponse:
    """With users and nobody chosen yet: who is it? Otherwise the PIN — the one
    of Drop, or that user's."""
    e = html.escape
    notice = f'<p class="error">{e(message)}</p>' if message else ""
    if USERS and user is None:
        tiles = []
        for u in USERS.values():
            face = f'<span class="initial">{e(u.name[:1].upper())}</span><span>{e(u.name)}</span>'
            if u.pin:
                tiles.append(f'<a class="user u-{u.palette}" href="/login?user={u.palette}">'
                             f'{face}{LOCK_ICON}</a>')
            else:
                tiles.append(f'<form method="post" action="/login"><input type="hidden" name="user" '
                             f'value="{u.palette}"><button class="user u-{u.palette}" type="submit">'
                             f'{face}</button></form>')
        content = f"""
<h1>{e(t.get("who_title", ""))}</h1>
<p class="meta">{e(t.get("who_body", ""))}</p>
{notice}
<div class="users">{"".join(tiles)}</div>"""
        return public_page(lang, t, t.get("who_title", ""), content, status=status,
                           style=USER_STYLE)

    if user:
        title = fill(t.get("user_pin_title", ""), name=user.name)
        heading = (f'<div class="who"><span class="initial">{e(user.name[:1].upper())}</span>'
                   f'<h1>{e(title)}</h1></div>')
        body, chosen = t.get("user_pin_body", ""), f'<input type="hidden" name="user" value="{user.palette}">'
        back = f'<a class="back" href="/">{e(t.get("other_user", ""))}</a>'
    else:
        title = t.get("pin_title", "")
        heading, body, chosen, back = f"<h1>{e(title)}</h1>", t.get("pin_body", ""), "", ""
    content = f"""
{heading}
<p class="meta">{e(body)}</p>
{notice}
<form method="post" action="/login" class="password">{chosen}
  <input type="password" name="pin" autocomplete="current-password" autofocus required
         aria-label="{e(t.get("pin", ""))}" placeholder="{e(t.get("pin", ""))}">
  <button class="button" type="submit">{e(t.get("open", ""))}</button>
</form>{back}"""
    return public_page(lang, t, title, content, status=status,
                       style=USER_STYLE if user else "", body_class=f"u-{user.palette}" if user else "")


@app.middleware("http")
async def pin_gate(request: Request, call_next):
    if not SIGN_IN or request.url.path in ACCESS_OPEN:
        return await call_next(request)
    ok, user = session(request)
    # A page opened for one user, while another one has signed in in this
    # browser since: it must not go on in the other person's area — 401, and
    # it reloads as the one signed in now.
    opened_as = request.headers.get("x-drop-as") or request.query_params.get("as")
    if ok and user and opened_as and opened_as != user.palette:
        ok = False
    if ok:
        request.state.user = user
        return await call_next(request)
    if request.url.path == "/" and request.method == "GET":
        lang, t = language_of(request)
        return sign_in_page(lang, t)
    if request.url.path == "/share-target":       # shared while signed out: sign in first
        return Response(status_code=303, headers={"location": "/"})
    # The page reloads on 401 and lands on the sign-in page.
    return JSONResponse({"error": "pin"}, status_code=401)


def from_elsewhere(request: Request) -> bool:
    """A form sent from another web site? Browsers say so in Sec-Fetch-Site;
    old ones send nothing, and that is let through."""
    return request.headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none")


@app.get("/login")
async def login_page(request: Request, user: str = "") -> Response:
    """The PIN of one user, picked on the sign-in page."""
    chosen = USERS.get(user)
    if chosen and chosen.pin:
        lang, t = language_of(request)
        return sign_in_page(lang, t, chosen)
    return Response(status_code=303, headers={"location": "/"})


@app.post("/login")
async def login(request: Request) -> Response:
    if not SIGN_IN:
        return Response(status_code=303, headers={"location": "/"})
    if from_elsewhere(request):
        raise HTTPException(403, "Sign in on Drop's own page")
    raw = b""
    async for piece in request.stream():
        raw += piece
        if len(raw) > 4096:
            raise HTTPException(413)
    form = parse_qs(raw.decode("utf-8", "replace"))
    user = None
    if USERS:
        user = USERS.get((form.get("user") or [""])[0])
        if not user:
            return Response(status_code=303, headers={"location": "/"})
    expected = user.pin if user else LAN_PIN

    if expected:
        lang, t = language_of(request)
        # Counted per PIN asked for: knowing one's own PIN does not reset the
        # count for someone else's.
        target = user.palette if user else ""
        who = f"pin:{request.client.host if request.client else '?'}:{target}"
        everyone = f"pin:*:{target}"
        if locked(who, PIN_FAILURES_EACH) or locked(everyone, PIN_FAILURES_ONE) \
                or locked("pin:*", PIN_FAILURES_ALL):
            return sign_in_page(lang, t, user, t.get("locked", ""), status=429)
        # Counted before the check, as with share passwords — and nothing is
        # awaited in between, so parallel guesses cannot slip past the limit.
        now = time.time()
        for key in (who, everyone, "pin:*"):
            failures.setdefault(key, []).append(now)
        given = (form.get("pin") or [""])[0].strip()
        if not hmac.compare_digest(hashlib.sha256(given.encode("utf-8")).digest(),
                                   hashlib.sha256(expected.encode("utf-8")).digest()):
            return sign_in_page(lang, t, user, t.get("pin_wrong", ""), status=403)
        failures.pop(who, None)
        for key in (everyone, "pin:*"):        # a right PIN does not count against the others
            try:
                failures[key].remove(now)
            except (KeyError, ValueError):
                pass

    issued = int(time.time())
    value = f"{issued}.{user.palette}.{access_signature(issued, user)}" if user \
        else f"{issued}.{access_signature(issued)}"
    reply = Response(status_code=303, headers={"location": "/"})
    reply.set_cookie(ACCESS_COOKIE, value, max_age=ACCESS_DAYS * 86400, path="/", httponly=True,
                     samesite="strict", secure=request.url.scheme == "https")
    return reply


@app.post("/logout")
async def logout(request: Request) -> Response:
    if from_elsewhere(request):
        raise HTTPException(403, "Sign out on Drop's own page")
    reply = Response(status_code=303, headers={"location": "/"})
    reply.delete_cookie(ACCESS_COOKIE, path="/", httponly=True, samesite="strict",
                        secure=request.url.scheme == "https")
    return reply


@app.middleware("http")
async def own_page_only(request: Request, call_next):
    """Changes come from Drop's own page. Browsers say where a request comes
    from; another site — even one on a neighbouring subdomain, which the
    SameSite cookie does not stop — gets nothing changed here."""
    if request.method not in ("GET", "HEAD", "OPTIONS") and from_elsewhere(request):
        return PlainTextResponse("Only from Drop's own page", status_code=403)
    return await call_next(request)


refused_hosts: Set[str] = set()


@app.middleware("http")
async def known_hosts_only(request: Request, call_next):
    host = request.headers.get("host", "")
    if known_host(host):
        return await call_next(request)
    name = host_without_port(host)
    if name not in refused_hosts and len(refused_hosts) < 100:
        refused_hosts.add(name)
        print(f"Refused the name {name}: not one of Drop's. If you open Drop under it, "
              "put it into WEBUI in the .env (or HOSTS), then Compose Up.", flush=True)
    lang, t = language_of(request)
    e = html.escape
    return public_page(lang, t, t.get("unknown_host_title", ""), f"""
<h1>{e(t.get("unknown_host_title", ""))}</h1>
<p class="meta">{e(fill(t.get("unknown_host_body", ""), name=name))}</p>""", status=421)


@app.middleware("http")
async def lan_only(request: Request, call_next):
    """Second line of defence: the drop box is never meant as the proxy's
    target (that is the public container). If something from outside lands here
    anyway — wrong IP in the reverse proxy, port forwarding — it gets a 404."""
    if from_outside(request.scope) or share_host(request.headers.get("host", "")):
        return PlainTextResponse("Not found", status_code=404)
    return await call_next(request)


@app.middleware("http")
async def no_store(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/static", "/api")) or request.url.path == "/":
        response.headers.setdefault("cache-control", "no-cache, must-revalidate")
    return response


# Drop's own page loads nothing from elsewhere and has no inline script or
# style; no other site may frame it, embed its files or read them as scripts.
LAN_CSP = ("default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; "
           "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    headers = response.headers
    headers.setdefault("content-security-policy", LAN_CSP)    # the sign-in page sets its own
    headers.setdefault("x-frame-options", "DENY")
    headers["x-content-type-options"] = "nosniff"
    headers.setdefault("referrer-policy", "same-origin")
    headers.setdefault("cross-origin-resource-policy", "same-origin")
    return response


# ---- Page and assets --------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    missing = missing_files()
    if missing:
        name = html.escape(app_name())
        items = "".join(f"<li><code>static/{n}</code></li>" for n in missing)
        return HTMLResponse(status_code=503, content=f"""
<!doctype html><html lang="en"><meta charset="utf-8">
<title>{name} — incomplete installation</title>
<style>
 body{{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      max-width:44rem;margin:12vh auto;padding:0 1.5rem;color:#111A20;background:#F2F5F6}}
 @media (prefers-color-scheme:dark){{body{{color:#E3EBEF;background:#0C1216}}}}
 h1{{font-size:1.45rem;margin:0 0 .6rem}}
 code{{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;
       background:rgba(128,128,128,.16);padding:.1em .35em;border-radius:3px}}
 li{{margin:.3rem 0}} p{{margin:.7rem 0}}
</style>
<h1>{name} is not fully installed</h1>
<p>The server is running, but the web page is missing. These files are not there:</p>
<ul>{items}</ul>
<p>They are expected inside the container at <code>{STATIC_DIR}</code>. If you mount
code of your own over <code>/app</code>, it needs the subfolder <code>static/</code> with
<code>index.html</code>, <code>app.js</code> and <code>style.css</code> in it.</p>
<p>Afterwards, reloading this page is enough; no container restart needed.</p>
</html>""")
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    user = current_user(request)
    if user:
        # The user's colour from the first frame on, not after the first request.
        page = page.replace("<html ", f'<html data-palette="{user.palette}" data-user ', 1)
    return HTMLResponse(page)


@app.get("/static/{name}")
async def static_file(name: str) -> Response:
    path = (STATIC_DIR / name).resolve()
    if path.parent != STATIC_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "Not found")
    media = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    if media.startswith("text/") or media in ("application/javascript",):
        media += "; charset=utf-8"
    return Response(path.read_bytes(), media_type=media)


# ---- Home screen and share sheet --------------------------------------------
# With the manifest, Drop can be put on the home screen like an app (iPhone:
# Safari → Share → Add to Home Screen; Android: Install). On Android it then
# also appears in the share sheet: pictures, files and links go to /share-target.

@app.get("/manifest.webmanifest")
async def manifest() -> Response:
    data = {
        "id": "/", "start_url": "/", "scope": "/",
        "name": app_name(), "short_name": "Drop",
        "display": "standalone",
        "background_color": "#F2F5F6", "theme_color": "#0B6E75",
        "icons": [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/static/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
        "share_target": {
            "action": "/share-target", "method": "POST", "enctype": "multipart/form-data",
            "params": {"title": "title", "text": "text", "url": "url",
                       "files": [{"name": "files", "accept": ["*/*"]}]},
        },
    }
    return Response(json.dumps(data, ensure_ascii=False), media_type="application/manifest+json")


SHARE_SHEET_FILES = 100


@app.post("/share-target")
async def share_target(request: Request) -> Response:
    """What Android's share sheet sends: files go to the file list, text and
    links into a new text field — with users, in the user's own area. Then on
    to the page."""
    # This is the one write a plain HTML form on any web site could send. The
    # browser says where a request comes from: the share sheet sends "none",
    # Drop's own page "same-origin" — everything else is refused.
    if request.headers.get("sec-fetch-site") not in ("none", "same-origin"):
        raise HTTPException(403, "Only from the share sheet")
    try:
        form = await request.form(max_files=SHARE_SHEET_FILES, max_fields=10)
    except Exception:            # malformed, too many parts: nothing taken
        raise HTTPException(400, "Unreadable form")
    user = current_user(request)
    area = user.area if user else SHARED
    try:
        # A share of text only may still carry an empty file part.
        files = [f for f in form.getlist("files") if getattr(f, "filename", None)]

        def store(upload) -> None:
            # Copied under a hidden name, shown under its own name once complete.
            part = area.files / f"{SHARED_PREFIX}{uuid.uuid4().hex[:12]}"
            with open(part, "xb") as out:
                shutil.copyfileobj(upload.file, out, 4 * 1024 * 1024)
            own(part)
            place(area, part, clean_name(upload.filename))

        for upload in files:
            await run_in_threadpool(store, upload)
        if files:
            announce_files(area)

        parts = []
        for key in ("title", "text", "url"):
            value = form.get(key)
            value = value.strip() if isinstance(value, str) else ""
            if value and not any(value in p for p in parts):
                parts.append(value)
        if parts:
            content = "\n".join(parts)[:MAX_SHARE_TEXT]
            async with text_lock:
                ids = await run_in_threadpool(field_ids, area)
                if len(ids) < FIELDS_MAX:
                    await run_in_threadpool(write_text, area, (ids[-1] + 1) if ids else 1, content)
                else:            # all fields there: below the text of the last one
                    old = await run_in_threadpool(read_text, area, ids[-1])
                    joined = (old.rstrip("\n") + "\n\n" + content).lstrip("\n")
                    await run_in_threadpool(write_text, area, ids[-1], joined[:MAX_TEXT])
                state = await run_in_threadpool(fields_state, area)
            announce_fields(area, state)
    finally:
        await form.close()
    # The page opens on the area the shared things went to.
    return Response(status_code=303, headers={"location": "/?area=own" if user else "/"})


@app.get("/api/lang")
async def language(prefer: str = "") -> JSONResponse:
    """The page sends navigator.languages, gets back the best match and its
    strings (English filled in where the language has gaps)."""
    code = pick_language(prefer)
    return JSONResponse({"lang": code, "available": available_languages(),
                         "strings": language_strings(code)})


@app.get("/api/help", response_class=HTMLResponse)
async def help_text(lang: str = DEFAULT_LANGUAGE) -> HTMLResponse:
    """help/<lang>.html, read fresh on every request — edit it, press F5, done."""
    lang = lang if LANG_CODE_PATTERN.match(lang) else DEFAULT_LANGUAGE
    for name in (f"{lang}.html", f"{DEFAULT_LANGUAGE}.html"):
        for candidate in (CUSTOM_DIR / "help" / name, HELP_DIR / name):
            try:
                return HTMLResponse(candidate.read_text(encoding="utf-8"))
            except OSError:
                pass
    return HTMLResponse("<p>No help file found.</p>")


# ---- State and events -------------------------------------------------------

@app.get("/api/state")
async def state(request: Request) -> JSONResponse:
    """Everything the page shows, for one area (?area=own|shared). The shares
    cover both areas the user sees."""
    area, user = area_of(request), current_user(request)
    shares = await run_in_threadpool(shares_list) if SHARING_ENABLED else []
    return JSONResponse({
        "name": app_name(),
        "notice": app_notice(),
        "user": {"name": user.name, "palette": user.palette} if user else None,
        "sign_in": SIGN_IN,
        "area": "own" if area is not SHARED else "shared",
        "texts": await run_in_threadpool(fields_state, area),
        "field_start": FIELDS_START,
        "field_max": FIELDS_MAX,
        "files": await run_in_threadpool(list_files, area),
        "uploads": area_uploads(area),
        "space": await run_in_threadpool(disk_space, area),
        "chunk_size": CHUNK_SIZE,
        "sharing": {"enabled": SHARING_ENABLED, "max_days": SHARE_MAX_DAYS,
                    "base_url": SHARE_BASE_URL or None, "subdomain": SHARE_SUBDOMAIN},
        "shares": visible_shares(shares, user),
    })


@app.get("/api/events")
async def events(request: Request) -> StreamingResponse:
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    hub.clients[queue] = current_user(request)

    async def stream():
        try:
            yield b": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event, data = await asyncio.wait_for(queue.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield b": ping\n\n"      # keeps proxies and NAT in between awake
                    continue
                payload = json.dumps(data, ensure_ascii=False)
                yield f"event: {event}\ndata: {payload}\n\n".encode("utf-8")
        finally:
            hub.clients.pop(queue, None)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
    })


# ---- Text fields ------------------------------------------------------------
#
# Saving, adding and removing run under one lock: otherwise a save that is just
# hitting the disk could bring a field back to life that was removed a moment ago.

text_lock = asyncio.Lock()


def check_field(fid: int) -> None:
    if not 1 <= fid <= 999999:
        raise HTTPException(404, "No such field")


def announce_fields(area: Area, state: list) -> None:
    hub.publish("fields", {"texts": state}, area)


@app.put("/api/text/{fid}")
async def put_text(fid: int, request: Request) -> JSONResponse:
    check_field(fid)
    area = area_of(request)
    body = await json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected an object")
    new = str(body.get("text", ""))
    if len(new) > MAX_TEXT:
        raise api_error(413, "field_too_long", "Text too long for a field")
    base = body.get("base")

    async with text_lock:
        if not await run_in_threadpool(text_path(area, fid).is_file):
            # Someone removed the field while it was being typed in. Do not
            # recreate it — the page offers to rescue the text instead.
            raise HTTPException(404, "This field no longer exists")

        current = await run_in_threadpool(read_text, area, fid)
        current_version = version_of(current)

        if base is not None and base != current_version:
            # Someone else was faster. Never overwrite silently.
            return JSONResponse(status_code=409, content={
                "conflict": True, "text": current, "version": current_version,
            })

        await run_in_threadpool(write_text, area, fid, new)
        saved = await run_in_threadpool(read_text, area, fid)

    version = version_of(saved)
    hub.publish("text", {"id": fid, "text": saved, "version": version}, area)
    return JSONResponse({"version": version})


@app.post("/api/text")
async def add_text(request: Request) -> JSONResponse:
    """Appends a new field, optionally with content — that is how the page
    rescues text from a field someone removed under its fingers."""
    area = area_of(request)
    body = await json_body(request, empty={})
    content = str(body.get("text", "")) if isinstance(body, dict) else ""
    if len(content) > MAX_TEXT:
        raise api_error(413, "field_too_long", "Text too long for a field")

    async with text_lock:
        ids = await run_in_threadpool(field_ids, area)
        if len(ids) >= FIELDS_MAX:
            raise api_error(409, "field_limit", f"No more than {FIELDS_MAX} fields")
        new = (ids[-1] + 1) if ids else 1
        await run_in_threadpool(write_text, area, new, content)
        state = await run_in_threadpool(fields_state, area)

    announce_fields(area, state)
    return JSONResponse({"id": new, "texts": state})


@app.delete("/api/text/{fid}")
async def remove_text(fid: int, request: Request) -> JSONResponse:
    check_field(fid)
    area = area_of(request)
    async with text_lock:
        ids = await run_in_threadpool(field_ids, area)
        if fid in ids:
            if len(ids) <= 1:
                raise api_error(409, "last_field", "The last field stays")
            await run_in_threadpool(text_path(area, fid).unlink)
        state = await run_in_threadpool(fields_state, area)

    announce_fields(area, state)
    return JSONResponse({"texts": state})


@app.delete("/api/text")
async def delete_text(request: Request) -> JSONResponse:
    """Empties all fields and goes back to the starting number."""
    area = area_of(request)
    async with text_lock:
        await run_in_threadpool(reset_fields, area)
        state = await run_in_threadpool(fields_state, area)
    announce_fields(area, state)
    return JSONResponse({"texts": state})


# ---- Upload -----------------------------------------------------------------

def upload_for(uid: str, request: Request) -> Upload:
    """A running upload — only for whoever may see its area."""
    up = uploads.get(uid)
    if not up or not may_see(request, up.area):
        raise HTTPException(404, "Unknown upload")
    return up


@app.post("/api/upload/init")
async def upload_init(request: Request) -> JSONResponse:
    area = area_of(request)
    body = await json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected an object")
    name = clean_name(str(body.get("name", "")))
    try:
        size = int(body.get("size", 0))
        modified = body.get("modified")
        modified = int(modified) if modified is not None else None
    except (TypeError, ValueError, OverflowError):
        raise HTTPException(400, "Invalid size")
    if size < 0:
        raise HTTPException(400, "Invalid size")

    # Same file, still open? Then resume instead of starting over. Same means
    # name, size and — when both times are known — when it was last changed.
    for up in uploads.values():
        if up.area is area and up.name == name and up.size == size \
                and (up.modified is None or modified is None or up.modified == modified) \
                and not up.finishing and up.part.exists():
            up.active = time.time()
            return JSONResponse({"id": up.id, "chunk_size": CHUNK_SIZE,
                                 "received": up.contiguous(), "chunks": sorted(up.chunks),
                                 "resumed": True})

    # It has to fit. The files of uploads still running do not take their
    # space yet (sparse), so that is only checked here, against what is free.
    if size > disk_space(area)["free"]:
        raise api_error(507, "no_space", "Not enough space")

    up = Upload(area, uuid.uuid4().hex[:12], name, size, modified)

    def prepare():
        try:
            with open(up.part, "wb") as f:
                f.truncate(size)     # sparse, so chunks may land at any offset
            own(up.part)
            up.save_meta()
        except OSError:
            up.discard()
            raise

    try:
        await run_in_threadpool(prepare)
    except OSError:
        raise api_error(507, "no_space", "Not enough space")
    uploads[up.id] = up
    announce_files(area)
    return JSONResponse({"id": up.id, "chunk_size": CHUNK_SIZE,
                         "received": 0, "chunks": [], "resumed": False})


@app.get("/api/upload/{uid}")
async def upload_status(uid: str, request: Request) -> JSONResponse:
    up = upload_for(uid, request)
    return JSONResponse({"id": up.id, "received": up.contiguous(),
                         "chunks": sorted(up.chunks), "total": up.total})


@app.put("/api/upload/{uid}/{index}")
async def upload_chunk(uid: str, index: int, request: Request) -> JSONResponse:
    up = upload_for(uid, request)
    if up.finishing:
        raise HTTPException(404, "Unknown upload")
    if index < 0 or index >= up.total:
        raise HTTPException(400, "Chunk outside the file")

    expected = up.chunk_length(index)
    offset = index * CHUNK_SIZE
    up.active = time.time()
    try:
        handle = await run_in_threadpool(open, up.part, "r+b")
    except FileNotFoundError:
        # Cancelled or deleted in the meantime ("Delete all files").
        uploads.pop(uid, None)
        raise HTTPException(404, "Unknown upload")

    written = 0
    try:
        await run_in_threadpool(handle.seek, offset)
        buffer = bytearray()
        async for piece in request.stream():
            if not piece:
                continue
            if written + len(buffer) + len(piece) > expected:
                # Never write past this chunk — that would overwrite the next one.
                raise HTTPException(400, "Chunk larger than expected")
            buffer.extend(piece)
            if len(buffer) >= WRITE_BUFFER:
                data = bytes(buffer)
                buffer.clear()
                await run_in_threadpool(handle.write, data)
                written += len(data)
        if buffer:
            await run_in_threadpool(handle.write, bytes(buffer))
            written += len(buffer)
        await run_in_threadpool(handle.flush)
    finally:
        await run_in_threadpool(handle.close)

    if written != expected:
        # Cut off on the way (proxy, flaky Wi-Fi): not done, the browser retries.
        raise HTTPException(400, f"Chunk incomplete: {written} of {expected} bytes")

    up.chunks.add(index)
    up.active = time.time()
    await run_in_threadpool(up.save_meta)

    now = time.time()
    if now - up.last_broadcast > 2.0 or len(up.chunks) == up.total:
        up.last_broadcast = now
        hub.publish("upload", up.as_dict(), up.area)

    return JSONResponse({"received": up.contiguous()})


@app.post("/api/upload/{uid}/done")
async def upload_done(uid: str, request: Request) -> JSONResponse:
    up = upload_for(uid, request)
    if up.finishing:
        raise HTTPException(404, "Unknown upload")
    if len(up.chunks) < up.total:
        raise HTTPException(409, f"{up.total - len(up.chunks)} chunks still missing")
    up.finishing = True                  # a second "done" must not move the file again

    def finish() -> str:
        final = place(up.area, up.part, up.name)   # same directory: no copying
        try:
            up.meta.unlink()
        except FileNotFoundError:
            pass
        return final

    try:
        name = await run_in_threadpool(finish)
    except FileNotFoundError:
        uploads.pop(uid, None)
        raise HTTPException(404, "Unknown upload")
    except OSError:
        up.finishing = False             # it can be tried again
        raise HTTPException(500, "Could not finish the upload")
    uploads.pop(uid, None)
    announce_files(up.area)
    return JSONResponse({"name": name})


@app.delete("/api/upload/{uid}")
async def upload_cancel(uid: str, request: Request) -> JSONResponse:
    up = uploads.get(uid)
    if up and may_see(request, up.area):
        uploads.pop(uid, None)
        await run_in_threadpool(up.discard)
        announce_files(up.area)
    return JSONResponse({"ok": True})


# ---- Download ---------------------------------------------------------------

@app.get("/files/{name:path}")
async def download(name: str, request: Request):
    path = safe_target(area_of(request), name)
    if not path.is_file():
        raise HTTPException(404, "File not found")
    # Always a download; should a browser show it anyway, nothing in it runs.
    return file_response(path, request, extra={"content-security-policy": "sandbox"})


def file_response(path: Path, request: Request, extra: Optional[dict] = None,
                  download_name: Optional[str] = None) -> Response:
    """Delivery with range support — for the drop box and for shares alike, so
    interrupted downloads can continue."""
    size = path.stat().st_size
    start, end, status = 0, max(size - 1, 0), 200

    wanted = request.headers.get("range", "")
    if wanted.startswith("bytes=") and size:
        try:
            raw = wanted[6:].split(",")[0].strip()
            first, _, last = raw.partition("-")
            if first:
                start = int(first)
                end = int(last) if last else size - 1
            else:                                   # bytes=-500 → the last 500
                start = max(size - int(last), 0)
                end = size - 1
            if start >= size or start > end:
                return Response(status_code=416, headers={"content-range": f"bytes */{size}"})
            end = min(end, size - 1)
            status = 206
        except ValueError:
            start, end, status = 0, size - 1, 200

    length = (end - start + 1) if size else 0
    name = download_name or path.name
    headers = {
        "accept-ranges": "bytes",
        "content-length": str(length),
        "content-disposition": content_disposition(name),
    }
    if status == 206:
        headers["content-range"] = f"bytes {start}-{end}/{size}"
    if extra:
        headers.update(extra)

    def reader():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                block = f.read(min(1024 * 1024, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block

    # From the extension alone — the rest of a name is the uploader's.
    media = mimetypes.guess_type("file" + Path(name).suffix)[0] or "application/octet-stream"
    return StreamingResponse(reader(), status_code=status, headers=headers, media_type=media)


# ---- Thumbnails -------------------------------------------------------------
# Small previews of pictures for the file list, made on first request and kept
# in THUMBS_DIR. Decoding someone's picture is the riskiest thing Drop does, so
# Pillow only sees the formats meant for it, within size and pixel limits, two
# at a time — and only in this container: the public one never imports it.

THUMB_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"}
THUMB_OPENERS = ("PNG", "JPEG", "GIF", "WEBP", "BMP", "AVIF")    # the only decoders Pillow may try
THUMB_FORMATS = {"PNG", "JPEG", "MPO", "GIF", "WEBP", "BMP", "AVIF"}  # MPO comes through JPEG
THUMB_MAX_BYTES = 80 * 1024 * 1024
THUMB_MAX_PIXELS = 60_000_000
THUMB_EDGE = 192                     # px; shown at 48, so sharp up to 4x
thumb_slots = asyncio.Semaphore(2)


def thumb_key(area: Area, name: str) -> str:
    # The shared area keeps the keys of the versions without users.
    named = f"{area.key}/{name}" if area.key else name
    return hashlib.sha256(named.encode("utf-8")).hexdigest()[:24]


def thumb_path(area: Area, path: Path, st: os.stat_result) -> Path:
    # Size and mtime in the name: a replaced file gets a new preview.
    return THUMBS_DIR / f"{thumb_key(area, path.name)}-{st.st_size}-{st.st_mtime_ns}.webp"


def make_thumb(area: Area, path: Path, target: Path) -> None:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = THUMB_MAX_PIXELS
    # formats=: no other of Pillow's ~40 plugins ever reads a byte of the file.
    with Image.open(path, formats=THUMB_OPENERS) as im:     # reads the header only
        if im.format not in THUMB_FORMATS:
            raise ValueError(f"not for previews: {im.format}")
        im.draft("RGB", (THUMB_EDGE * 2, THUMB_EDGE * 2))   # JPEG: decode at 1/2…1/8
        if im.width * im.height > THUMB_MAX_PIXELS:         # what is really decoded
            raise ValueError("too many pixels")
        mode = "RGBA" if im.mode in ("RGBA", "LA", "PA", "P") or "transparency" in im.info else "RGB"
        if im.mode not in ("RGB", "RGBA", "L", "LA", "CMYK"):
            im = im.convert(mode)            # palette, 16 bit: scaled as colours, not indices
        # Small first, then turned and converted — so the picture exists in
        # full size only once, not three times.
        im.thumbnail((THUMB_EDGE, THUMB_EDGE))
        im = ImageOps.exif_transpose(im).convert(mode)
        for old in THUMBS_DIR.glob(thumb_key(area, path.name) + "-*"):
            old.unlink(missing_ok=True)
        part = target.with_suffix(".part")
        im.save(part, "WEBP", quality=78, method=4)
    os.replace(part, target)
    own(target)


def tidy_thumbs() -> None:
    """Removes previews whose file is gone (also when deleted over SMB)."""
    if not THUMBS_DIR.is_dir():
        return
    keep = set()
    for area in areas():
        try:
            keep |= {thumb_key(area, e.name) for e in os.scandir(area.files) if not e.name.startswith(".")}
        except OSError:          # a user's folder removed by hand: its previews go too
            pass
    for entry in os.scandir(THUMBS_DIR):
        if entry.name.split("-", 1)[0] not in keep:
            try:
                os.unlink(entry.path)
            except OSError:
                pass


async def watch_thumbs(interval: int = 900) -> None:
    """Every quarter hour: previews of files that are gone, uploads given up."""
    while True:
        try:
            await run_in_threadpool(tidy_thumbs)
            for up in await run_in_threadpool(expire_uploads):
                print(f"Upload of {up.name} given up after {UPLOAD_IDLE_DAYS} days without "
                      "progress.", flush=True)
                announce_files(up.area)
        except Exception as error:
            print(f"Tidying previews and uploads: {error}", flush=True)
        await asyncio.sleep(interval)


@app.get("/api/thumb/{name:path}")
async def thumbnail(name: str, request: Request) -> Response:
    area = area_of(request)
    path = safe_target(area, name)
    try:
        st = path.stat()
    except OSError:
        raise HTTPException(404, "File not found")
    if (not path.is_file() or path.suffix.lower() not in THUMB_TYPES
            or st.st_size > THUMB_MAX_BYTES):
        raise HTTPException(404, "No preview")
    target = thumb_path(area, path, st)
    if not target.is_file():
        async with thumb_slots:
            if not target.is_file():
                try:
                    await run_in_threadpool(make_thumb, area, path, target)
                except Exception as error:   # whatever the picture does: no preview
                    print(f"No preview for {path.name}: {error}", flush=True)
                    raise HTTPException(404, "No preview")
    # The page asks with ?v=<size>-<mtime>, so the answer never goes stale.
    return Response(await run_in_threadpool(target.read_bytes), media_type="image/webp",
                    headers={"cache-control": "private, max-age=31536000, immutable"})


@app.get("/api/preview/{name:path}")
async def preview(name: str, request: Request) -> JSONResponse:
    """The beginning of a text file. errors=replace, so a Windows-1252 file
    shows a few replacement characters instead of an error."""
    path = safe_target(area_of(request), name)
    if not path.is_file():
        raise HTTPException(404, "File not found")

    def read() -> str:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(20000)

    return JSONResponse({"text": await run_in_threadpool(read)})


# ---- Deleting ---------------------------------------------------------------

@app.delete("/api/files")
async def delete_files(request: Request) -> JSONResponse:
    area = area_of(request)
    body = await json_body(request, empty={})
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected an object")
    everything = bool(body.get("all"))
    names = body.get("names") or []
    if not isinstance(names, list):
        raise HTTPException(400, "names must be a list")

    def delete() -> int:
        count = 0
        if everything:
            for entry in os.scandir(area.files):
                try:
                    if not entry.is_file():
                        continue
                    os.unlink(entry.path)
                    if not entry.name.startswith("."):
                        count += 1          # .part files and sidecars do not count
                except OSError:
                    pass
            for uid in [u.id for u in uploads.values() if u.area is area]:
                uploads.pop(uid, None)
        else:
            for n in names:
                try:
                    target = safe_target(area, str(n))
                    if target.is_file():
                        os.unlink(target)
                        count += 1
                except (OSError, HTTPException):
                    pass
        return count

    count = await run_in_threadpool(delete)
    announce_files(area)
    await announce_shares()          # shares of deleted files are dead now
    await run_in_threadpool(tidy_thumbs)
    return JSONResponse({"deleted": count})


# ---- Managing shares (LAN only) ---------------------------------------------

def require_sharing() -> None:
    if not SHARING_ENABLED:
        raise api_error(404, "sharing_off", "Sharing is turned off")


def opened_by_name(request: Request) -> bool:
    """Was the page opened as drop.example.org rather than 192.168.1.10? Only
    then can the browser derive the public address of a share link."""
    host = (request.headers.get("host") or "").strip().lower()
    if host.startswith("["):                       # [fd00::1]:80 — IPv6
        return False
    host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    if not host or ":" in host or re.fullmatch(r"[\d.]+", host):
        return False
    return "." in host


@app.post("/api/shares")
async def create_share(request: Request) -> JSONResponse:
    require_sharing()
    if not SHARE_BASE_URL and not opened_by_name(request):
        # A link created now would point nowhere: its address is derived from
        # the name the drop box is open under (see shareBase() in app.js).
        raise api_error(400, "share_needs_name",
                        "Open Drop by its name, not its IP address, to share")
    area = area_of(request)
    body = await json_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected an object")
    kind = body.get("kind")
    try:
        duration = int(body.get("duration", 86400))
    except (TypeError, ValueError, OverflowError):
        raise api_error(400, "bad_duration", "Invalid duration")
    duration = min(max(duration, 15 * 60), SHARE_MAX_DAYS * 86400)

    password = str(body.get("password") or "")
    if len(password) > MAX_PASSWORD:
        raise api_error(400, "password_too_long", "Password too long")

    token = new_token()
    now = time.time()
    rec = {"id": share_id(token), "token": token, "kind": kind,
           "created": int(now), "expires": int(now + duration)}
    if area.key:
        rec["area"] = area.key           # only its user sees it in the LAN
    if password:
        # Before the hard link, not after: hashing takes a moment, and a hard
        # link without its record is tidied away.
        salt = secrets.token_bytes(16)
        rec["pw_salt"] = salt.hex()
        rec["pw_hash"] = await run_in_threadpool(password_hash, password, salt)
        rec["pw_iter"] = PW_ITERATIONS

    if kind == "text":
        text = str(body.get("text", ""))
        if not text.strip():
            raise api_error(400, "empty_text", "Empty text")
        if len(text) > MAX_SHARE_TEXT:
            raise api_error(413, "text_too_long", "Text too long to share")
        rec["text"] = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
        rec["name"] = str(body.get("title") or "Text")[:80]
        rec["size"] = len(rec["text"].encode("utf-8"))
        try:
            rec["field"] = int(body["field"])     # so the field is marked as shared
        except (KeyError, TypeError, ValueError):
            pass
    elif kind == "file":
        path = safe_target(area, str(body.get("name", "")))
        if not path.is_file():
            raise api_error(404, "file_not_found", "File not found")

        def link() -> int:
            os.link(path, share_blob(rec["id"]))
            return path.stat().st_size

        try:
            size = await run_in_threadpool(link)
        except OSError as error:
            raise api_error(500, "hardlink_failed",
                            f"Cannot provide the file (hard link: {error.strerror}). "
                            "See the start-up log.")
        rec.update({"name": path.name, "size": size})
    else:
        raise HTTPException(400, "Unknown kind")

    try:
        await run_in_threadpool(write_share, rec)
    except OSError:
        await run_in_threadpool(remove_share, rec["id"])
        raise
    await announce_shares()
    return JSONResponse(visible_shares([share_for_lan(rec)], current_user(request))[0])


def share_area(rec: dict) -> Optional[Area]:
    return area_by_key(rec.get("area", ""))


@app.delete("/api/shares/{sid}")
async def end_share(sid: str, request: Request) -> JSONResponse:
    require_sharing()
    if not SHARE_ID_PATTERN.match(sid):
        raise HTTPException(404, "Unknown share")
    rec = await run_in_threadpool(read_share, sid)
    if rec:
        area = share_area(rec)
        if area is not None and not may_see(request, area):
            raise HTTPException(404, "Unknown share")
    await run_in_threadpool(remove_share, sid)
    await announce_shares()
    return JSONResponse({"ok": True})


@app.delete("/api/shares")
async def end_all_shares(request: Request) -> JSONResponse:
    """Ends every link this user sees — or, with ?area=, those of one area."""
    require_sharing()
    only = area_of(request) if "area" in request.query_params else None

    def end_all() -> int:
        count = 0
        for rec in tidy_shares()[0]:
            area = share_area(rec)
            if area is None or not may_see(request, area) or (only and area is not only):
                continue
            remove_share(rec["id"])
            count += 1
        return count

    count = await run_in_threadpool(end_all)
    await announce_shares()
    return JSONResponse({"ended": count})


# ================================================================ Public
#
# The app of the public container (MODE=public). It knows exactly three paths:
# /robots.txt, /<token> and /<token>/download. No API, no SSE, no file list.
# And even if there were a bug in here: the container only has shares/
# mounted, read-only — there is nothing beyond what is shared.

public = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)

def language_of(request: Request) -> tuple:
    """Language code and its public-page strings, keyed without the "public."
    prefix, plus the writing direction as "dir"."""
    code = pick_language(request.headers.get("accept-language", ""))
    strings = language_strings(code)
    t = {k[7:]: v for k, v in strings.items() if k.startswith("public.")}
    t["dir"] = "rtl" if strings.get("meta.dir") == "rtl" else "ltr"
    return code, t


@public.middleware("http")
async def public_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["cache-control"] = "no-store"          # nothing expired from a cache
    response.headers["x-robots-tag"] = "noindex, nofollow, noarchive"
    response.headers["referrer-policy"] = "no-referrer"     # never pass the token on
    response.headers["x-content-type-options"] = "nosniff"
    response.headers["x-frame-options"] = "DENY"
    response.headers["vary"] = "Accept-Language, Cookie"
    response.headers.setdefault("content-security-policy",
                                "default-src 'none'; frame-ancestors 'none'")
    return response


def find_share(raw: str) -> Optional[dict]:
    token = normal_token(raw)
    if token is None:
        return None
    sid = share_id(token)
    rec = read_share(sid)
    if not isinstance(rec, dict) or not record_sound(rec, sid):
        return None
    if not hmac.compare_digest(rec["token"], token):
        return None
    return rec if share_valid(rec, time.time()) else None


def record_sound(rec: dict, sid: str) -> bool:
    """The public container takes nothing from a record on trust: the id must
    be the one its file name was derived from (it becomes a path), the rest
    must have the shape drop writes. A record put into shares/ by other means
    is simply not there."""
    now = time.time()
    expires = rec.get("expires")
    if rec.get("id") != sid or rec.get("kind") not in ("text", "file"):
        return False
    if not (isinstance(rec.get("token"), str) and rec["token"].isascii()):
        return False
    if isinstance(expires, bool) or not isinstance(expires, (int, float)) \
            or not 0 < expires < now + 10 * 365 * 86400:
        return False
    if not isinstance(rec.get("name"), str) or not isinstance(rec.get("text", ""), str):
        return False
    if rec.get("pw_hash") is not None and not (
            isinstance(rec.get("pw_hash"), str) and re.fullmatch(r"[0-9a-f]{64}", rec["pw_hash"])
            and isinstance(rec.get("pw_salt"), str) and re.fullmatch(r"[0-9a-f]{32}", rec["pw_salt"])
            and rec.get("pw_iter", PW_ITERATIONS_KNOWN[0]) in PW_ITERATIONS_KNOWN):
        return False
    if rec["kind"] == "file" and (isinstance(rec.get("size"), bool)
                                  or not isinstance(rec.get("size"), int) or rec["size"] < 0):
        return False
    return True


def js(value) -> str:
    """JSON for a value inside an inline <script>: "<" escaped, so a string can
    never close the element."""
    return json.dumps(value).replace("<", "\\u003c")


def size_text(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    value, unit = float(n), "B"
    for unit in ("KB", "MB", "GB", "TB"):
        value /= 1024
        if value < 1024:
            break
    return f"{value:.1f} {unit}" if value < 10 else f"{value:.0f} {unit}"


def plural(t: dict, key: str, n: int) -> str:
    """Picks key_one or key_other. Languages with more forms can still say it
    in key_other; the web page itself uses the browser's full plural rules."""
    return fill(t.get(f"{key}_{'one' if n == 1 else 'other'}", t.get(f"{key}_other", "")),
                n=number_text(n, t))


def remaining_text(seconds: float, t: dict) -> str:
    """Relative rather than a clock time: the server does not know the
    visitor's time zone. The page adds the exact time in the browser."""
    m = max(1, round(seconds / 60))
    if m < 60:
        return plural(t, "minutes", m)
    if seconds < 2 * 86400:
        return plural(t, "hours", round(seconds / 3600))
    return plural(t, "days", round(seconds / 86400))


def number_text(n: int, t: dict) -> str:
    return f"{n:,}".replace(",", t.get("thousands_separator", ","))


PUBLIC_STYLE = """
:root{--bg:#F2F5F6;--surface:#FFF;--surface2:#E9EEF0;--ink:#121B21;--muted:#5E6E78;
 --line:#D6DFE3;--line2:#B9C7CE;--accent:#0B6E75;--accent-soft:#DFEFF0;--on-fill:#FFF}
@media (prefers-color-scheme:dark){:root{--bg:#0C1216;--surface:#141C21;--surface2:#1B252B;
 --ink:#E3EBEF;--muted:#8697A1;--line:#233037;--line2:#33454F;--accent:#54C0C4;
 --accent-soft:#13302F;--on-fill:#08161A}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
 -webkit-text-size-adjust:100%}
main{max-width:52rem;margin:0 auto;padding:7vh 16px 48px}
.brand{font-size:12.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:22px;margin:0 0 4px;font-weight:650;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13.5px;margin:0 0 18px;font-variant-numeric:tabular-nums}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px}
.button{font:inherit;font-size:14px;font-weight:550;padding:9px 16px;border-radius:4px;cursor:pointer;
 border:1px solid var(--accent);background:var(--accent);color:var(--on-fill);text-decoration:none;display:inline-block}
.button.plain{background:transparent;color:var(--accent);border-color:var(--line2)}
.button:hover{filter:brightness(1.08)}
.button.plain:hover{background:var(--accent-soft);filter:none}
pre{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:14px 16px;
 font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
 white-space:pre-wrap;overflow-wrap:anywhere}
.password{display:flex;gap:8px;flex-wrap:wrap;max-width:28rem}
.password input{flex:1;min-width:12rem;font:inherit;font-size:16px;padding:9px 11px;border-radius:4px;
 border:1px solid var(--line2);background:var(--surface);color:var(--ink)}
.error{color:#B3261E;font-weight:600;margin:0 0 12px}
@media (prefers-color-scheme:dark){.error{color:#E38073}}
"""


def public_page(lang: str, t: dict, title: str, content: str, status: int = 200,
                script: str = "", style: str = "", body_class: str = "") -> HTMLResponse:
    nonce = secrets.token_urlsafe(12)
    script_tag = f'<script nonce="{nonce}">{script}</script>' if script else ""
    body = f'<body class="{body_class}">' if body_class else "<body>"
    page = f"""<!doctype html>
<html lang="{lang}" dir="{t.get("dir", "ltr")}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>{html.escape(title)}</title>
<style>{PUBLIC_STYLE}{style}</style></head>
{body}<main>
<p class="brand">{html.escape(app_name())}</p>
{content}
</main>{script_tag}</body></html>"""
    csp = (f"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{nonce}'; "
           "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    return HTMLResponse(page, status_code=status, headers={
        "content-security-policy": csp, "content-language": lang})


def expiry_script(lang: str, t: dict) -> str:
    return """
document.querySelectorAll('time[datetime]').forEach(function (el) {
  var d = new Date(el.getAttribute('datetime'));
  if (isNaN(d)) return;
  el.textContent = %s + ' ' + d.toLocaleString(%s, { weekday: 'short', day: 'numeric',
    month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
});
""" % (js(t.get("until", "")), js(lang))


def copy_script(t: dict) -> str:
    return """
var button = document.getElementById('copy');
if (button) button.addEventListener('click', function () {
  var text = document.getElementById('text').textContent;
  function done(ok) {
    button.textContent = ok ? %s : %s;
    setTimeout(function () { button.textContent = %s; }, 2200);
  }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove(); return ok;
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
  } else { done(fallback()); }
});
""" % (js(t.get("copied", "")), js(t.get("copy_failed", "")),
       js(t.get("copy", "")))


def expiry_html(rec: dict, t: dict) -> str:
    rest = rec["expires"] - time.time()
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(rec["expires"]))
    valid = html.escape(fill(t.get("valid_for", ""), rest=remaining_text(rest, t)))
    return f'{valid} <time datetime="{iso}"></time>'


@public.exception_handler(StarletteHTTPException)
async def public_error(request: Request, error: StarletteHTTPException):
    # Expired, ended or never there — from outside it all looks the same.
    lang, t = language_of(request)
    e = html.escape
    return public_page(lang, t, t.get("unavailable_title", ""), f"""
<h1>{e(t.get("unavailable_heading", ""))}</h1>
<p class="meta">{e(t.get("unavailable_body", ""))}</p>""",
                       status=405 if error.status_code == 405 else 404)


@public.get("/robots.txt")
async def public_robots() -> PlainTextResponse:
    return PlainTextResponse("User-agent: *\nDisallow: /\n")


# ---- Password ---------------------------------------------------------------
#
# Optional per share. Only a PBKDF2 hash is stored. Whoever enters the password
# correctly once gets a cookie for this one share — so range downloads and
# reloads work without asking again. The cookie is an HMAC over share and salt
# and expires with the share.

MAX_FAILURES = 10
FAILURE_WINDOW = 15 * 60
failures: Dict[str, list] = {}


def cookie_name(rec: dict) -> str:
    return f"drop_{rec['id'][:16]}"


def unlocked(request: Request, rec: dict) -> bool:
    if not rec.get("pw_hash"):
        return True
    value = request.cookies.get(cookie_name(rec), "")
    return bool(value) and value.isascii() and hmac.compare_digest(value, unlock_value(rec))


def locked(sid: str, limit: int = MAX_FAILURES) -> bool:
    now = time.time()
    recent = [t for t in failures.get(sid, []) if now - t < FAILURE_WINDOW]
    if recent:
        failures[sid] = recent
    else:
        failures.pop(sid, None)
    return len(recent) >= limit


def password_page(lang: str, t: dict, token: str, rec: dict, message: str = "",
                  status: int = 200) -> HTMLResponse:
    e = html.escape
    body = t.get("password_body_text" if rec["kind"] == "text" else "password_body_file", "")
    notice = f'<p class="error">{e(message)}</p>' if message else ""
    content = f"""
<h1>{e(t.get("password_title", ""))}</h1>
<p class="meta">{e(body)}</p>
{notice}
<form method="post" action="{quote(token)}" class="password">
  <input type="password" name="password" autocomplete="off" autofocus required
         aria-label="{e(t.get("password", ""))}" placeholder="{e(t.get("password", ""))}">
  <button class="button" type="submit">{e(t.get("open", ""))}</button>
</form>"""
    return public_page(lang, t, t.get("password_title", ""), content, status=status)


@public.post("/{token}")
async def public_password(token: str, request: Request) -> Response:
    rec = await run_in_threadpool(find_share, token)
    if not rec or not rec.get("pw_hash"):
        raise HTTPException(404)
    lang, t = language_of(request)
    if locked(rec["id"]):
        return password_page(lang, t, token, rec, t.get("locked", ""), status=429)
    # Counted now, before the hashing: attempts sent in parallel would all see
    # "fewer than 10" while the earlier ones are still being checked.
    failures.setdefault(rec["id"], []).append(time.time())

    raw = b""
    async for piece in request.stream():
        raw += piece
        if len(raw) > 4096:
            raise HTTPException(413)
    fields = parse_qs(raw.decode("utf-8", "replace"))
    password = (fields.get("password") or [""])[0]

    salt = bytes.fromhex(rec.get("pw_salt", ""))
    attempt = await run_in_threadpool(password_hash, password[:MAX_PASSWORD], salt,
                                      rec.get("pw_iter", PW_ITERATIONS_KNOWN[0]))
    if not hmac.compare_digest(attempt, rec["pw_hash"]):
        return password_page(lang, t, token, rec, t.get("wrong_password", ""), status=403)

    failures.pop(rec["id"], None)
    secure = request.url.scheme == "https" or \
        request.headers.get("x-forwarded-proto", "").lower() == "https"
    # 303: the browser then fetches the page with GET — a reload does not send
    # the password again.
    reply = Response(status_code=303, headers={"location": quote(token)})
    reply.set_cookie(cookie_name(rec), unlock_value(rec),
                     max_age=max(60, int(rec["expires"] - time.time())),
                     httponly=True, samesite="lax", secure=secure)
    return reply


@public.get("/{token}")
async def public_share(token: str, request: Request) -> HTMLResponse:
    rec = await run_in_threadpool(find_share, token)
    if not rec:
        raise HTTPException(404)
    lang, t = language_of(request)
    e = html.escape
    if not unlocked(request, rec):
        return password_page(lang, t, token, rec)
    await run_in_threadpool(count_access, rec["id"], "views")

    # Relative to the page, so it also works behind a path prefix of the proxy.
    download = f"{quote(token)}/download"
    if rec["kind"] == "text":
        text = rec.get("text", "")
        words, chars = count_words(text), len(text)
        content = f"""
<h1>{e(t.get("shared_text", ""))}</h1>
<p class="meta">{e(plural(t, "words", words))} · {e(plural(t, "characters", chars))} ·
{expiry_html(rec, t)}</p>
<div class="actions">
  <button class="button" id="copy" type="button">{e(t.get("copy", ""))}</button>
  <a class="button plain" href="{download}">{e(t.get("download_text", ""))}</a>
</div>
<pre id="text" dir="auto">{e(text)}</pre>"""
        return public_page(lang, t, t.get("shared_text", ""), content,
                           script=copy_script(t) + expiry_script(lang, t))

    content = f"""
<h1>{html.escape(rec["name"])}</h1>
<p class="meta">{size_text(int(rec.get("size", 0)))} · {expiry_html(rec, t)}</p>
<div class="actions"><a class="button" href="{download}">{e(t.get("download", ""))}</a></div>"""
    return public_page(lang, t, rec["name"], content, script=expiry_script(lang, t))


@public.get("/{token}/download")
async def public_download(token: str, request: Request) -> Response:
    rec = await run_in_threadpool(find_share, token)
    if not rec:
        raise HTTPException(404)
    if not unlocked(request, rec):
        # Back to the page with the password field (/<token>/download → /<token>).
        return Response(status_code=303, headers={"location": f"../{quote(token)}"})

    # Only the start counts — a resumed download is not a second one.
    wanted = request.headers.get("range", "")
    if not wanted.startswith("bytes=") or wanted.startswith("bytes=0-"):
        await run_in_threadpool(count_access, rec["id"], "downloads")

    # Never render in the browser, always save: an uploaded HTML file must not
    # be able to run a script on the share host name.
    safe = {"content-security-policy": "sandbox; default-src 'none'"}
    if rec["kind"] == "text":
        return Response(rec.get("text", "").encode("utf-8"),
                        media_type="text/plain; charset=utf-8",
                        headers={"content-disposition": content_disposition("text.txt"), **safe})

    path = await run_in_threadpool(shared_file, rec)
    if not path:
        raise HTTPException(404)
    return file_response(path, request, extra=safe, download_name=rec["name"])


# ---------------------------------------------------------------- Start

def check_public() -> None:
    """The public container must not see anything of the drop box. If it is
    mounted anyway, better not start at all than silently show too much."""
    too_much = [str(p) for p in (FILES_DIR, TEXTS_DIR, USERS_DIR) if os.path.exists(p)]
    if too_much:
        banner("MODE=public, but the files and texts are mounted:",
               *[f"  {p}" for p in too_much],
               "This container may only see shares/. Start aborted.")
        raise SystemExit(1)
    if not SHARES_DIR.is_dir():
        print(f"Shares directory {SHARES_DIR} is missing — start aborted.", flush=True)
        raise SystemExit(1)
    if os.access(SHARES_DIR, os.W_OK):
        print(f"Warning: {SHARES_DIR} is writable — it is meant to be mounted :ro.", flush=True)
    if os.geteuid() == 0:
        print("Warning: running as root — it is meant to run as user \"99:100\".", flush=True)


if __name__ == "__main__":
    import uvicorn

    if PUBLIC:
        check_public()
        port = int(os.environ.get("PORT", "8080"))
        print(f"{app_name()} — public part on port {port}, shares only, from {SHARES_DIR}",
              flush=True)
        # No TLS: the reverse proxy in front does that, and this container never
        # even sees the private key.
        uvicorn.run(public, host="0.0.0.0", port=port, workers=1,
                    timeout_keep_alive=75, proxy_headers=False, server_header=False)
        raise SystemExit(0)

    if USER_PROBLEMS:
        # Better not to start than to run without the sign-in someone set up.
        banner("USERS (USER_…) CANNOT BE USED:", *[f"  {p}" for p in USER_PROBLEMS],
               "Start aborted — fix them and start again.")
        raise SystemExit(1)
    cert, key = tls_ready()
    port = int(os.environ.get("PORT", "443" if cert else "80"))
    print(f"Starting on port {port} {'with' if cert else 'without'} TLS", flush=True)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        workers=1,
        timeout_keep_alive=75,
        proxy_headers=False,          # it refuses proxied requests anyway (lan_only)
        server_header=False,
        ssl_certfile=cert,
        ssl_keyfile=key,
        ssl_context_factory=tls_context_factory if len(tls_certificates()) > 1 else None,
    )
