"""Turns the PNGs from slides.mjs and diagram.mjs into the WebP files in docs/,
plus the bare page light and dark for the slider on dropnook.app (app-*.webp),
in each colour layout (app-<colour>-*.webp; teal is app-*.webp).

    python3 tools/screenshots/export.py     (WORK as for the other scripts)
"""
import os
from pathlib import Path

from PIL import Image

WORK = Path(os.environ.get("WORK", "/srv/demo"))
DOCS = Path(__file__).resolve().parents[2] / "docs"
SLIDES = ["1-overview", "2-share", "3-shares", "4-public", "5-phone", "6-languages", "7-theme",
          "8-colours", "9-users"]
PALETTES = ["gold", "blue", "violet", "coral"]


def resized(image, width):
    return image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)


for lang, out in (("en", DOCS / "screenshots"), ("de", DOCS / "screenshots" / "de")):
    src = WORK / f"slides-{lang}"
    if not src.is_dir():
        print("skipped, not there:", src)
        continue
    out.mkdir(parents=True, exist_ok=True)
    for scheme in ("light", "dark"):
        frames = []
        for name in SLIDES:
            image = Image.open(src / f"{name}-{scheme}.png").convert("RGB")
            resized(image, 2400).save(out / f"{name}-{scheme}.webp", quality=86, method=6)
            resized(image, 720).save(out / f"{name}-{scheme}-thumb.webp", quality=82, method=6)
            frames.append(resized(image, 1600))
        frames[0].save(out / f"slideshow-{scheme}.webp", save_all=True, append_images=frames[1:],
                       duration=4200, loop=0, quality=84, method=6)
        page = Image.open(WORK / f"raw-{lang}" / f"overview-{scheme}.png").convert("RGB")
        resized(page, 2000).save(out / f"app-{scheme}.webp", quality=84, method=6)
        for palette in PALETTES:
            page = Image.open(WORK / f"raw-{lang}" / f"overview-{palette}-{scheme}.png").convert("RGB")
            resized(page, 2000).save(out / f"app-{palette}-{scheme}.webp", quality=84, method=6)
    print("slides →", out)

diagrams = sorted((WORK / "diagram").glob("*.png"))
for png in diagrams:
    (DOCS / "diagram").mkdir(exist_ok=True)
    resized(Image.open(png).convert("RGB"), 2000).save(
        DOCS / "diagram" / (png.stem + ".webp"), quality=90, method=6)
print(len(diagrams), "diagrams →", DOCS / "diagram")
