# Dropnook — for developers and power users

The [README](../README.md) covers installing and using Drop with Unraid's
Compose Manager Plus. This page has the rest.

## All settings

Set as environment variables in `compose.yaml`; the ones you normally change
come from its SETTINGS block.

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `lan` | `lan` = Drop itself, `public` = share links only (`drop-share`) |
| `APP_NAME` | `{server} Drop` | Page title; `{server}` is the Unraid server name |
| `APP_NOTICE` | empty | A short line shown in the header; empty hides it |
| `PIN` | empty | PIN or password every new browser is asked for once (signed in for 90 days); changing it signs everyone out. Not used with users. `lan` only |
| `USER_TEAL`, `USER_GOLD`, `USER_BLUE`, `USER_VIOLET`, `USER_CORAL` | empty | Up to five users, one per colour: `name:PIN`, or `name` alone to sign in without a PIN. Each gets an area of their own in `USERS_DIR/<name>/` next to the shared one. Names: 1–40 characters, no `/` or `\`, not starting with a dot, each once — otherwise Drop does not start. `lan` only |
| `TEXT_FIELDS` | `3` | Fields after the first start and after "Clear text fields" |
| `TEXT_FIELDS_MAX` | `12` | Maximum number of fields |
| `CHUNK_MB` | `64` | Upload chunk size |
| `SHARING` | `on` | `off` hides sharing to the internet |
| `SHARE_MAX_DAYS` | `30` | Longest lifetime of a share link |
| `SHARE_SUBDOMAIN` | `drop-share` | First part of the share links' name, derived from the name Drop is opened under |
| `SHARE_BASE_URL` | empty | Fixed link address instead, e.g. `https://drop-share.yourdomain.com` |
| `TLS_CERT` | empty | `auto`, a domain, or the path of the certificate chain — see the README, "HTTPS in your network" |
| `TLS_KEY` | empty | Path of the private key, only with a path in `TLS_CERT` |
| `CERTS_DIR` | `/certs` | Where `auto` and a domain look for certificates (`live/*/` and `*/` with `fullchain.pem` + `privkey.pem`) |
| `TLS_AUTO_NAME` | `drop` | Host name the certificate search looks for: `<name>.<domain>` or `*.<domain>`. One certificate per domain; with several, the one matching the requested name is served (SNI), the longest-lived answers requests by IP |
| `HTTPS_HOST` | empty | Target name for the HTTP → HTTPS redirect when a client sends no Host header |
| `HTTP_REDIRECT_PORT` | `80` | Port of that redirect |
| `PORT` | `80` / `443` / `8080` | Listening port: `lan` without / with TLS, `public` (compose sets 80) |
| `PUID`, `PGID` | `99`, `100` | Owner of new files |
| `SERVER_NAME` | empty | Server name, if it is not read from Unraid |
| `UNRAID_IDENT` | `/unraid/ident.cfg` | Where the Unraid server name is read from |
| `FILES_DIR`, `TEXTS_DIR`, `SHARES_DIR` | `/data/files`, `/data/texts`, `/data/shares` | Data folders inside the container; files and texts of the shared area |
| `USERS_DIR` | `/data/users` | The users' areas, `<name>/files` and `<name>/texts` each — in the same mount as `shares/`, for the hard links |
| `THUMBS_DIR` | `/data/.thumbs` | Cache of the picture previews, next to `files/` |
| `CUSTOM_DIR` | `/config` | Folder with `lang/` and `help/` files of your own (the appdata folder) |
| `TZ` | UTC | Only the time stamps in the container log |

## Without Unraid

Unraid with Compose Manager Plus is the recommended way, and what the README
describes. But `compose-projects-drop/compose.yaml` is a plain Compose file and
runs on any Linux host with Docker. Put it in a folder of its own, fill in the
SETTINGS with paths of that host, and change three things:

* **Network.** `br0` is Unraid's network for containers with their own LAN
  address. Elsewhere, create one like it once (macvlan on your network card,
  with your LAN's subnet and gateway) and keep the name, or rename it in the
  file:

  ```sh
  docker network create -d macvlan --subnet 192.168.1.0/24 --gateway 192.168.1.1 \
    -o parent=eth0 br0
  ```

  The host itself cannot reach macvlan addresses — a reverse proxy on the same
  host needs its own address in that network, or reaches `drop-share` from
  another machine.
* **Server name.** Remove the `/boot/config/ident.cfg` line and set
  `SERVER_NAME: <name>` (or `APP_NAME`) under `environment` of `drop`.
* **Data folder.** `data` must exist before the first start (Drop does not
  create it); `drop` creates `files/`, `texts/` and `shares/` in it, owned by
  `99:100` (`PUID`/`PGID` to change that).

Start with `docker compose up -d` next to the file; `docker compose pull &&
docker compose up -d` updates. The `net.unraid.*` labels do nothing outside
Unraid and can stay.

## How the pieces work

* **One image, two modes.** `MODE=lan` serves Drop itself (FastAPI, live
  updates over Server-Sent Events, chunked resumable uploads). `MODE=public`
  serves `/<token>`, `/<token>/download` and `/robots.txt`, nothing else, and
  aborts if it can see `/data/files` or `/data/texts`.
* **Picture previews** (`/api/thumb/<name>`) are made by Pillow on first
  request — PNG, JPEG, GIF, WebP, BMP, AVIF only (`Image.open(formats=…)`, so
  no other Pillow plugin reads the file); at most 80 MB and 60 megapixels,
  two at a time — and kept as small WebP files in `THUMBS_DIR`, named after
  the file's name, size and mtime. Previews of deleted files are removed. SVG
  is shown by the browser and never decoded on the server; the public
  container never loads Pillow.
* **Shares** live in `shares/`: one record `<hash of token>.json` each, files as
  hard links in `shares/files/<id>`, view counters written by `drop-share` to
  `shares/counters/`, the cookie secret for password-protected links in
  `shares/.key`. `drop-share` uses a record only if its `id` is the hash it
  was looked up by and its fields have the shape `drop` writes.
* **Password attempts** are counted before the (deliberately slow, PBKDF2)
  check, so parallel guesses cannot exceed 10 per link and 15 minutes.
* **The share sheet** (`POST /share-target`, from the manifest's
  `share_target`) is the one write a plain HTML form on another site could
  send. It is taken only with `Sec-Fetch-Site: none` (the share sheet) or
  `same-origin`. Files are copied under a hidden `.shared-*` name and renamed
  when complete; large parts wait in `/data/.tmp` (`tempfile.tempdir`), never
  in the container. The app icons come from `static/icon.svg`
  (`tools/screenshots/icons.mjs`).
* **The optional PIN** (`PIN`): without the cookie, `drop` answers only the
  sign-in page (`/`, `POST /login`) and `/api/help` (Docker's health check);
  everything else is 401, and the page reloads on it. The cookie holds the
  time of the sign-in, signed with HMAC over that time and a hash of the PIN,
  keyed by `/data/.access-key` — which `drop-share` never sees. HttpOnly,
  SameSite=Strict, Secure with HTTPS, 90 days. Wrong PINs: 10 per address and
  50 in all per 15 minutes, counted before the check.
* **Users** (`USER_<COLOUR>`): the sign-in page lists them by name and
  colour; a user without PIN signs in with a click. The cookie is
  `<time>.<colour>.<signature>`, the signature (HMAC, same key as with `PIN`)
  covers colour, name and PIN — another colour in the cookie, a renamed user or
  a changed PIN, and it no longer fits. Every request names its area
  (`?area=own`, otherwise the shared one); `own` is always the area of the
  signed-in user, never one named by the browser. Uploads, downloads, previews,
  text fields and share links are checked against that. Live updates of an own
  area go only to that user's pages. A share record remembers its area
  (`"area": "<name>"`; none = shared): only that user sees and ends it in the
  LAN, and it ends by itself once the user is no longer in `compose.yaml`.
  Without users nothing of this applies, and nothing changes for 1.x data.
* **Colour layouts**: `data-palette` on `<html>` (`gold`, `blue`, `violet`,
  `coral`; none = teal) switches the colour tokens in `static/style.css`, each
  in light and dark. With users the server sets the user's colour before the
  page is drawn; without, `static/theme.js` takes the browser's choice from
  `localStorage`.
* **Tokens** are ten characters from `23456789abcdefghjkmnpqrstuvwxyz`, as
  `xxxxx-xxxxx` (about 50 bits); the longer links of the first versions
  (22 URL-safe characters) still work.
* **Drop refuses proxied requests.** The `lan` app answers 404 to anything with
  proxy headers or from a public address, so a misrouted proxy cannot reach it.
* **Rights.** `drop` runs as root to own the data folders (files it creates
  belong to `PUID:PGID`), with only `CHOWN`, `DAC_OVERRIDE`, `FOWNER` (hard
  links to files it does not own) and `NET_BIND_SERVICE`, `no-new-privileges`
  and memory/process limits. `drop-share` runs as `99:100` without any
  capability on a read-only file system.
* **Health check** (`healthcheck.py`): `public` asks for `/robots.txt`; `lan`
  tries HTTPS, then HTTP, on `/api/help`.

## Building the image yourself

```sh
docker build -t drop:local .
```

Then set `image` in the SETTINGS to `drop:local`. To try changes without
building, mount your copy of the repository over `/app`: the web page files are
read on every reload, `main.py` needs a restart of the container.

## Releases

GitHub Actions (`.github/workflows/image.yml`) builds the image for amd64 and
arm64 and publishes it to the GitHub Container Registry:

* every push to `main` as `:edge`;
* a release as `:<version>`, `:<major>.<minor>`, `:<major>` and `:latest`;
* every Monday the latest release again, built on a fresh base image for its
  security updates, as `:<major>.<minor>`, `:<major>` and `:latest` —
  `:<version>` stays as released. Skipped when the base image has not changed
  since the last build (its digest is kept in the label
  `org.opencontainers.image.base.digest`). To do it at once, e.g. for an
  urgent fix in Debian or Python: *Run workflow* with *rebuild* ticked.

Before anything is published, `.github/smoke-test.sh` starts both containers
the way `compose.yaml` does (with the same capabilities and limits) and checks
uploads, text and file shares, passwords, picture previews, the proxy guard,
and that `drop-share` runs without root and refuses to start when it can see
the files. It also runs the attacks found in a security review:
parallel password guessing, forged share records, control characters in file
names, picture formats in disguise, slash redirects. Locally: `.github/smoke-test.sh <image>`.

To release: *Actions* → *Image* → *Run workflow* on `main`, enter the version
(e.g. `1.2.3`). The workflow builds and publishes the images, then creates the
tag `v1.2.3` and its GitHub release. Release notes, if any, go into
`.github/release-notes/v1.2.3.md` beforehand; they are put above the generated
changelog. Releases cannot be changed once published (release immutability is
on). A release published by hand on the *Releases* page builds the same images.

The image is `ghcr.io/dropnook/dropnook`, in a fork
`ghcr.io/<your account>/dropnook`. The very first image is
private on GitHub: set it to public once under *Packages → dropnook →
Package settings → Change visibility*.

## License and name

The code is under the [GNU Affero General Public License v3.0](../LICENSE).
Anyone who runs a **changed** version for other people over a network has to
offer them its source code (AGPL section 13) — the help dialog links to the
source; point that link to your own repository in a fork. The name Dropnook™
is not part of the license: see [TRADEMARKS.md](../TRADEMARKS.md).

## Translations

One JSON file per language in `lang/`, one help page per language in `help/` —
see [`lang/README.md`](../lang/README.md). New languages are welcome as pull
requests.

## Website, screenshots and gallery

The product site [dropnook.app](https://dropnook.app/) is the `docs/` folder,
served as it is by Cloudflare: Workers Builds runs `npx wrangler deploy` on
every push to `main`, and [`wrangler.jsonc`](../wrangler.jsonc) says to publish
`docs/` as static files — no build command. Cloudflare builds on pushes only:
after connecting the repository or changing the build settings, the next push
to `main` deploys. What is in there:

- `index.html` (English) and `de/index.html` (German) are made by
  `python3 tools/site/build.py` from [`tools/site/page.html`](../tools/site/page.html)
  and [`tools/site/text.json`](../tools/site/text.json) — change those and run
  the script again, never the HTML itself. It also writes `sitemap.xml` and
  refuses to run if a text is missing in one language.
- Both pages are complete static HTML with a description, `hreflang` links
  between the languages and structured data (schema.org
  `SoftwareApplication`, `FAQPage`), so search engines and AI crawlers read
  everything without running JavaScript. `robots.txt` allows every crawler,
  `llms.txt` points language models to the README, the compose file and the
  source.
- `_headers` sets a strict Content Security Policy — scripts only as files
  from the site itself, so no inline `<script>`. The site loads no fonts and
  nothing from third parties and sets no cookies.
- `compare.js` runs the light/dark slider (mouse, finger, arrow keys); without
  JavaScript it simply shows half and half.
- `gallery/` is the picture gallery, plain HTML without a build step.

The pictures in the README, on the site and in the gallery are taken from a
demo server with sample data and framed afterwards — the scripts and how to
run them are in [`tools/screenshots/`](../tools/screenshots/README.md).
