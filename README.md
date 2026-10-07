<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/title-dark.svg">
    <img src="docs/title-light.svg" alt="Dropnook" height="44">
  </picture>
</h1>

**English** · [Deutsch](README.de.md) · [dropnook.app](https://dropnook.app/)

**Instant sharing for your home network — like AirDrop, but for every
device.** Get a text or a file from your phone to your PC, from Windows to a
Mac, from Android to an iPhone: open one web page, drop it in, and it is on
every other device at once. No app, no login, no cloud — everything stays on
your own server.

Something has to leave the house? Share a single file or text through a link
that expires by itself, optionally with a password. It is served by a second,
locked-down container — Drop itself is never reachable from the internet.

*Dropnook™* is the project's name; on your devices it is simply *Drop* — the
page calls itself "Tower Drop", after your server.

<p align="center">
  <a href="https://dropnook.app/gallery/"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/slideshow-dark.webp"><img src="docs/screenshots/slideshow-light.webp" alt="Drop in pictures: text fields and files, sharing to the internet, what is public, the recipient's page, the phone layout, other languages, light and dark" width="100%"></picture></a>
</p>

<p align="center">
  <a href="https://dropnook.app/gallery/#1" title="Text and files"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/1-overview-dark-thumb.webp"><img src="docs/screenshots/1-overview-light-thumb.webp" alt="Text and files" width="32%"></picture></a>
  <a href="https://dropnook.app/gallery/#2" title="Sharing"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/2-share-dark-thumb.webp"><img src="docs/screenshots/2-share-light-thumb.webp" alt="Sharing" width="32%"></picture></a>
  <a href="https://dropnook.app/gallery/#3" title="What is public"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/3-shares-dark-thumb.webp"><img src="docs/screenshots/3-shares-light-thumb.webp" alt="What is public" width="32%"></picture></a>
  <a href="https://dropnook.app/gallery/#4" title="Recipient's view"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/4-public-dark-thumb.webp"><img src="docs/screenshots/4-public-light-thumb.webp" alt="Recipient's view" width="32%"></picture></a>
  <a href="https://dropnook.app/gallery/#5" title="Phone"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/5-phone-dark-thumb.webp"><img src="docs/screenshots/5-phone-light-thumb.webp" alt="Phone" width="32%"></picture></a>
  <a href="https://dropnook.app/gallery/#6" title="17 languages"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/6-languages-dark-thumb.webp"><img src="docs/screenshots/6-languages-light-thumb.webp" alt="17 languages" width="32%"></picture></a>
</p>

<p align="center"><sub><a href="https://dropnook.app/gallery/">Open the gallery</a> — browse with arrows, zoom in with a click.</sub></p>

* Text fields with word, character and link counts; unsaved text survives
  reloads and lost connections.
* Uploads of any size — resumable, with progress visible to everyone.
* The page is called "`<server name>` Drop", with the name read live from Unraid.
* Screenshots straight from the clipboard with Ctrl+V; pictures with a preview,
  a large view and *Copy* into the clipboard of another computer.
* 17 languages, picked from the browser.

| | |
|---|---|
| Containers | `drop` (Drop itself, your network only) and `drop-share` (share links, internet) |
| Image | `ghcr.io/dropnook/dropnook:1` |
| Data | the Unraid share `drop` → `files/`, `texts/`, `shares/` |
| Drop | `https://drop.yourdomain.com` — in your network |
| Share links | `https://drop-share.yourdomain.com/k7m3x-9pq2r` — from anywhere |

`yourdomain.com` stands for your own domain throughout.

Made for Unraid, and this guide is for Unraid — but Drop runs on any Linux
host with Docker Compose, too: see [Without Unraid](docs/DEVELOPMENT.md#without-unraid).

## How it fits together

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagram/architecture-en-dark.webp">
    <img src="docs/diagram/architecture-en-light.webp" alt="Devices in your network reach drop directly. From the internet, requests go through your reverse proxy (HTTPS on 443) to drop-share on port 80. drop-share reads only the shares folder; drop refuses anything that comes through a proxy." width="100%">
  </picture>
</p>

Your reverse proxy and your certificates stay yours — Drop only expects what is
listed under [What Drop expects from your reverse proxy](#what-drop-expects-from-your-reverse-proxy).

## What you need

* **A server with Docker.** Recommended, and what this guide shows: **Unraid**
  with the plugin **Compose Manager Plus** (*Apps* → search for it →
  *Install*). Any other Linux host with Docker Compose works, too — see
  [Without Unraid](docs/DEVELOPMENT.md#without-unraid).
* **Two free addresses** in your LAN, one for `drop`, one for `drop-share`.
* **Your own domain** with two names — without one, Drop works by IP address,
  just without sharing to the internet and without HTTPS:
  * `drop.yourdomain.com` → the address of `drop`, as a local DNS entry in your
    router or DNS server (or as a public DNS record — a private address there
    is harmless).
  * `drop-share.yourdomain.com` → your public IP address (with a changing IP:
    dynamic DNS).
* **A reverse proxy** reachable from the internet, for sharing.
* Recommended: **a certificate** for `drop.yourdomain.com` (a wildcard
  `*.yourdomain.com` works) — then Drop uses HTTPS in your network, too.

## Installation

### 1. Create a new share "drop" on Unraid

A share of its own for Drop's files and texts. In the Unraid web interface,
*Shares* → *Add Share*:

* Name **`drop`**, on the pool you want.
* *Secondary storage*: **none** (if the share uses Exclusive Access).
* *Minimum free space*: generous — a large upload must not fill the pool to the
  brim.

Drop never creates this share itself. Inside it, it creates `files/`, `texts/`
and `shares/` on its own.

### 2. Check Unraid's Docker network

In the Unraid web interface, *Settings* → *Docker* (switch on *Advanced View*
at the top right):

* Under the custom networks, **`br0`** must show your LAN's subnet and gateway —
  the network both addresses from above are in.
* If your reverse proxy runs on this Unraid in *bridge* or *host* mode, set
  **Host access to custom networks** to *Enabled* — otherwise it cannot reach
  `drop-share`. (Docker has to be stopped to change it.)

### 3. Add Drop as a stack in Compose Manager Plus

In the Unraid web interface, tab *Docker* → section *Compose* further down →
**Add New Stack** → name **`drop`**.

On the new stack, **Edit Stack** → tab **Compose**: paste the content of
[`compose-projects-drop/compose.yaml`](compose-projects-drop/compose.yaml)
([raw](https://raw.githubusercontent.com/dropnook/dropnook.app/main/compose-projects-drop/compose.yaml)).

Everything you normally change is in the **SETTINGS** block at the top:

| Setting | Preset | What to do |
|---|---|---|
| `drop-ip`, `share-ip` | `<drop-IP>`, `<share-IP>` | **Fill in** the two free addresses |
| `data`, `shares`, `counters` | `/mnt/user/drop/…` | Only if your share has another name or path |
| `appdata` | `/mnt/user/appdata/drop` | Translations of your own; may stay empty |
| `certs` | `…/Nginx-Proxy-Manager-Official/letsencrypt` | The folder holding your certificates |
| `tls-cert`, `tls-key` | `auto`, empty | Leave it — Drop finds the certificate itself (see [HTTPS](#https-in-your-network)) |
| `share-subdomain` | `drop-share` | First part of the share links' name |
| `image` | `ghcr.io/dropnook/dropnook:1` | Leave it — follows every 1.x release |

One line outside SETTINGS: at `drop`, the label `net.unraid.docker.webui` —
put in your name instead of `https://drop.yourdomain.com`. It is what *WebUI* in the
Docker tab opens. Only if you have no domain and do not share to the internet:
`http://[IP]/` works too — Unraid fills in the address.

**Save**. While in *Edit Stack*, tab **Settings** → **Icon URL** gives the stack
its icon:

```
https://raw.githubusercontent.com/dropnook/dropnook.app/main/.github/icons/drop.png
```

Or paste this into the Unraid terminal (**>_** at the top right of the web
interface), then reload the page:

```sh
d=/boot/config/plugins/compose.manager/projects/drop; [ -d "$d" ] && printf '%s' https://raw.githubusercontent.com/dropnook/dropnook.app/main/.github/icons/drop.png > "$d/icon_url" && echo "Icon set" || echo "No stack 'drop' found"
```

### 4. Start the stack

In the *Compose* section, on the stack `drop`: **Compose Up**. `drop` starts
first; as soon as it answers, `drop-share` follows. Both show as *healthy*, each with its own icon.

On the stack, **Logs** — `drop` should say:

```
Certificate found for drop.yourdomain.com: …
Starting on port 443 with TLS
Tower Drop ready — files in /data/files, texts in /data/texts
```

and `drop-share`:

```
Drop — public part on port 80, shares only, from /data/shares
```

### 5. Try Drop out

* Open **`https://drop.yourdomain.com`** — the dot at the top left turns green,
  with "live" next to it. *WebUI* on `drop` in the Docker tab opens it too.
* Share a text field (*Share*), copy the link and open it on your phone **with
  Wi-Fi off**.
* `https://drop-share.yourdomain.com/` on its own must show nothing but an error
  page: from outside, only the individual links exist.

## What Drop expects from your reverse proxy

How you run your reverse proxy and where your certificates come from is up to
you. Drop only needs this:

| | |
|---|---|
| Name | `drop-share.yourdomain.com` |
| Forward to | `http://<share-IP>`, port **80** |
| Recommended | HTTPS on **443** with a valid certificate, `http://` redirected to `https://` |
| **Never** | forward anything to `<drop-IP>` |

`drop-share` itself speaks plain HTTP inside your network and never sees a
certificate. As a second line of defence, `drop` refuses every request that
comes through a proxy or from the internet — even a misconfigured proxy does
not reach Drop itself.

## HTTPS in your network

Over plain `http://`, browsers block some downloads ("insecure download"),
copying text works only in a roundabout way and pictures cannot be copied at
all. A certificate for `drop.yourdomain.com` fixes that — usually the one your
reverse proxy already has, if it covers that name (a wildcard
`*.yourdomain.com` does).

Drop reads it from the folder `certs`, read-only. `tls-cert` decides how:

| `tls-cert` | |
|---|---|
| `auto` (preset) | Drop picks the certificates for `drop.yourdomain.com` or `*.yourdomain.com` by itself — one per domain, `drop.yourdomain.com` before `*.yourdomain.com`. With several domains, each name you open Drop under gets its own. The log says which. |
| `yourdomain.com` | The same, for this domain only. |
| `""` | No HTTPS, no search. |
| a file path | Exactly this certificate; `tls-key` then names the key file. |

`certs` is preset to Nginx Proxy Manager's folder; with something else, put in
the folder your certificates live in. Never put certificates into Drop's
`appdata` folder — `drop-share` can read that one.

**Rather not let Drop see all your certificates?** `certs` is mounted
read-only, but `drop` could read every certificate in it — that is how `auto`
finds the right one, and a file path in `tls-cert` only turns off the search,
not the access. To give it just one: copy the certificate chain and its key
into a folder of their own (e.g. `/mnt/user/appdata/drop-certs/`), set `certs`
to that folder and `tls-cert`/`tls-key` to the two files. Drop then sees
nothing else — but renewals are up to you: copy the new files there after
each one (e.g. with the *User Scripts* plugin); Drop picks them up by itself.
With Nginx Proxy Manager, mounting only `live/npm-<N>` does not work — the
files there are links into `archive/`. Without HTTPS in your network at all:
`tls-cert: ""`, and remove the `certs` entry under `volumes` of `drop`.

**If `auto` does not get a certificate** — on the stack `drop` in the
*Compose* section, open **Logs** of the container `drop`. Right after the start
it says what it found, and the fix goes into the SETTINGS of the `compose.yaml`
(*Edit Stack* → *Compose*, then **Compose Up**):

| The log says | What to change |
|---|---|
| `No certificate for drop.<domain> … in <folder>` and the folder is not where your certificates are | `certs` → the folder holding them, e.g. `/mnt/user/appdata/<your proxy>/letsencrypt` |
| `No certificate …` although the folder is right | None of the certificates covers `drop.yourdomain.com` — get one for `*.yourdomain.com` (or `drop.yourdomain.com`) in your proxy |
| `Certificate found for …` lists a domain you do not want | `tls-cert: yourdomain.com` — only your domain is used |
| You want one specific certificate | both files by path, e.g. for Nginx Proxy Manager:<br>`tls-cert: /mnt/user/appdata/Nginx-Proxy-Manager-Official/letsencrypt/live/npm-<N>/fullchain.pem`<br>`tls-key: /mnt/user/appdata/Nginx-Proxy-Manager-Official/letsencrypt/live/npm-<N>/privkey.pem` |

Renewed certificates are picked up by themselves: Drop restarts for a moment,
once nothing is being uploaded. Old `http://` bookmarks are redirected.

## Updating

In the Unraid web interface, tab *Docker* → section *Compose* → **Check for
Updates**, then **Update** on the stack `drop`.
Your files, texts and shares stay where they are.

`:1` follows every 1.x release — fixes and new languages, never a breaking
change. An update never touches your `compose.yaml`; if a release changes it,
its release notes say what to take over.

Security updates reach the image on their own: every Monday the current release is
rebuilt on a fresh base image (Debian, Python, OpenSSL) whenever that base has
changed. *Check for Updates* then shows an update for the same version — take
it like any other. Every image is tested before it is published.

## Using Drop

**Text fields** — three to start with, more with "+ Text field"; `×` removes one
for everyone. If someone removes a field while you still have unsaved text in
it, you are offered to keep it as a new field. If two people save the same
field at once, the second one is asked which version to keep.

**Screenshots and pictures** — take a screenshot into the clipboard and press
Ctrl+V on the page (⌘V on a Mac): it is uploaded at once and shows up on every
other device, briefly highlighted. Pictures get a small preview in the file
list; a click shows them large (arrows or swiping for the next one). *Copy*
puts the picture itself into the clipboard — ready to paste into a chat, a mail
or a document. That needs [HTTPS](#https-in-your-network); without it,
right-click the large picture and use the browser's *Copy image*. iPhone photos
(HEIC) are kept like any file, but get no preview.

**Sharing** — *Share* on a text field, or *Share on the internet…* in a file's
menu: choose how long the link lives (15 minutes to 30 days) and optionally a
password. **What is public is always visible:** an orange "Public" badge on the
field or file, an orange *Shares* button with the count; *Shares* lists every
open link with its views and downloads and ends any of them at once.

Links look like `drop-share.yourdomain.com/k7m3x-9pq2r` — easy to read out and
type (no 0/o or 1/l/i, case and dash don't matter), and still impossible to
guess. Drop shares only when it is opened by its name: opened by IP address it
cannot know the link's address, and says so.

**Languages** — the page follows the browser: Arabic, Chinese, Dutch, English,
French, German, Hindi, Icelandic, Italian, Japanese, Korean, Norwegian, Polish,
Portuguese, Russian, Spanish and Turkish. To change wording or add a language
for yourself, put a file into `lang/` in the appdata folder — see
[`lang/README.md`](lang/README.md).

**Light and dark** follow the system. ☀ and ☾ next to *Help* pick one by hand;
a second click on the chosen one goes back to automatic. Each browser remembers
its choice.

<p align="center"><a href="https://dropnook.app/gallery/#7"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/7-theme-dark.webp"><img src="docs/screenshots/7-theme-light.webp" alt="The same page in light and in dark, side by side" width="80%"></picture></a></p>

**Times** are shown in each viewer's own time zone; nothing to set.

## How it is protected

| Container | sees | reachable |
|---|---|---|
| `drop` | everything: files, texts, shares, certificate | in your network |
| `drop-share` | only `shares/`, read-only (except the view counters) | through your reverse proxy |

`drop-share` runs without root, with a read-only file system, no Linux
capabilities and limited memory. Even a serious bug in it could at most expose
what is shared anyway — your files, the text fields and the certificate do
not exist in that container. It also checks every share record it reads and
ignores any that drop did not write that way.

`drop` needs root to own the data folders, but keeps only the four Linux
capabilities it uses (file ownership, hard links, ports 80/443), cannot gain
more, and has a memory limit. Picture previews are made only from PNG, JPEG,
GIF, WebP, BMP and AVIF, within size and pixel limits — no other decoder ever
sees the file.

Every image is tested before it is published — including these attacks:
path traversal, forged share records, password guessing in parallel, header
injection through file names, disguised picture formats.

* A shared file is a hard link, not a copy — no extra space. Delete the file in
  Drop and its link stops working.
* A shared text is a copy; later edits to the field are not shared.
* Passwords are stored as hashes only; after 10 wrong tries in 15 minutes a link
  is locked for that time.
* Downloads are always attachments — a shared HTML file never runs in the
  browser. Expired links disappear by themselves.

## Troubleshooting

**Compose Up: "bind source path does not exist: /mnt/user/drop"** — the share
is missing or named differently (step 1, or `data` in SETTINGS).

**Compose Up: "no configured subnet contains IP address …"** — `br0` does not
carry your LAN's subnet (step 2). In *Settings* → *Docker*: stop Docker, set
*Preserve user defined networks* to *No*, start Docker again — Unraid then
rebuilds `br0` from your network settings.

**A share link gives "502 Bad Gateway"** — the reverse proxy does not reach
`drop-share`: does it forward to `<share-IP>` on port 80, and is *Host access to
custom networks* on (step 2)?

**"Sharing only works through the name"** — the page is open by IP address.
Open `https://drop.yourdomain.com` instead.

**Still `http://` although there is a certificate** — the log of `drop` says
why: *No certificate for drop.… in …* — see [If `auto` does not get a
certificate](#https-in-your-network).

**"Copying pictures needs HTTPS"** — the page is open over `http://` or by IP
address. Open `https://drop.yourdomain.com` (see [HTTPS](#https-in-your-network)).

**A picture has no preview** — HEIC (iPhone photos) gets none; neither does a
picture larger than 80 MB or 60 megapixels, nor a file whose content is not
what its extension says.

**The dot at the top left stays red** — the browser does not reach `drop`: is
the stack running, does `drop.yourdomain.com` point to `<drop-IP>`? You can keep
typing; unsaved text is sent once the connection is back.

## What Drop deliberately does not do

* No folders — zip them first. An uploaded ZIP is stored, not extracted.
* No users, no permissions: whoever is in your network may do everything,
  including sharing to the internet.
* No recycle bin. Deleted is deleted.
* Nothing in Drop expires by itself — only share links do. Keep an eye
  on the free space shown at the top right.
* No uploads from outside. Sharing works in one direction only: out.

## Support Dropnook

Dropnook is free and stays free. If it is useful to you, you can say thanks
with a donation: **[paypal.me/vipermark2](https://www.paypal.com/paypalme/vipermark2)**. Ideally 5 € (or $5, 5 CHF)
or more — PayPal keeps a fixed fee plus a few percent of every payment, so of a
single euro hardly anything arrives.

---

<sub>All settings, building the image yourself and releasing:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Dropnook is free software under the
[GNU Affero General Public License v3.0](LICENSE); the name Dropnook™ is not
part of that license — see [TRADEMARKS.md](TRADEMARKS.md).</sub>
