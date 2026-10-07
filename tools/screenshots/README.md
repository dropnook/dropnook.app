# Screenshots and diagram

How the pictures in `docs/` (README, gallery, dropnook.app) are made. Needs Docker, root,
Node with Playwright (Chromium) and Python with Pillow; the fonts Inter and
Noto (incl. CJK and Arabic).

```sh
export WORK=/srv/demo PWPATH=$(npm root -g)/playwright
sh tools/screenshots/setup-demo.sh en      # demo server with sample data
sh tools/screenshots/setup-demo.sh de
SET=en node tools/screenshots/capture.mjs  # raw screenshots
SET=de node tools/screenshots/capture.mjs
SET=en node tools/screenshots/slides.mjs   # framed slides with captions
SET=de node tools/screenshots/slides.mjs
node tools/screenshots/diagram.mjs         # architecture diagram
node tools/screenshots/social.mjs          # docs/social-preview.png, dark (SCHEME=light: light)
python3 tools/screenshots/export.py        # WebP into docs/
```

`setup-demo.sh` puts two real pictures into the demo (`sample-images.py`:
the architecture diagram as a screenshot and a drawn sunset) and uses `IMAGE` (default: the published image); set it to a local
build to show unreleased changes. The demo answers as `drop.yourdomain.com` on
127.0.0.2–5, only inside the browser of `capture.mjs`. Afterwards:
`docker rm -f demo-en demo-en-share demo-de demo-de-share; umount $WORK`.
