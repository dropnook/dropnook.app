"""Two real pictures for the demo: a "screenshot" (the architecture diagram)
and a "photo" (a drawn sunset).  python3 sample-images.py <folder> <en|de>"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

out, lang = Path(sys.argv[1]), sys.argv[2]
repo = Path(__file__).resolve().parents[2]

shot = Image.open(repo / f"docs/diagram/architecture-{lang}-light.webp").convert("RGB")
shot.save(out / "screenshot.png")

w, h = 2400, 1600
photo = Image.new("RGB", (w, h))
px = ImageDraw.Draw(photo)
for y in range(h):                     # evening sky: deep blue to orange
    t = y / h
    px.line([(0, y), (w, y)], fill=(int(40 + 215 * t), int(60 + 110 * t ** 1.5), int(120 - 60 * t)))
px.ellipse([w * .58, h * .52, w * .72, h * .73], fill=(255, 214, 140))           # sun
px.rectangle([0, h * .68, w, h], fill=(32, 58, 86))                               # sea
for i in range(40):                                                              # glitter
    y = h * .69 + i * 11
    px.line([(w * .6 - i * 3, y), (w * .7 + i * 3, y)], fill=(250, 190, 120), width=3)
px.polygon([(0, h * .72), (w * .18, h * .55), (w * .34, h * .70), (w * .5, h * .62),
            (w * .62, h * .72)], fill=(24, 36, 52))                               # coast
photo.filter(ImageFilter.GaussianBlur(1.2)).save(out / "photo.jpg", quality=88)
