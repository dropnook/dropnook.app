"""Builds the product site dropnook.app from page.html and text.json:

    python3 tools/site/build.py

writes docs/index.html (English), docs/de/index.html (German) and
docs/sitemap.xml. Every language is a complete, static page, so search engines
and AI crawlers read it without running any JavaScript. Cloudflare
serves the docs/ folder as it is (wrangler.jsonc).
"""
import datetime
import html
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCS = HERE.parents[1] / "docs"
SITE = "https://dropnook.app/"
REPO = "https://github.com/dropnook/dropnook.app"
SHOTS = ["1-overview", "2-share", "3-shares", "4-public", "5-phone", "6-languages"]

TEXT = json.loads((HERE / "text.json").read_text(encoding="utf-8"))
TEMPLATE = (HERE / "page.html").read_text(encoding="utf-8")


def plain(fragment: str) -> str:
    """Text without tags or entities — for JSON-LD."""
    return html.unescape(re.sub(r"<[^>]+>", "", fragment))


def jsonld(lang: str, t: dict, url: str) -> str:
    graph = [
        {
            "@type": "SoftwareApplication",
            "@id": SITE + "#software",
            "name": "Dropnook",
            "description": plain(t["meta.description"]),
            "url": url,
            "inLanguage": lang,
            "applicationCategory": "UtilitiesApplication",
            "applicationSubCategory": "File sharing",
            "operatingSystem": "Linux (Docker), Unraid",
            "softwareRequirements": "Docker with Compose; a web browser on each device",
            "isAccessibleForFree": True,
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
            "license": "https://www.gnu.org/licenses/agpl-3.0.html",
            "codeRepository": REPO,
            "downloadUrl": REPO,
            "installUrl": REPO + "#installation",
            "image": SITE + "social-preview.png",
            "screenshot": [SITE + f"screenshots/{n}-light.webp" for n in SHOTS],
            "featureList": [plain(t[f"f{i}.title"]) + " — " + plain(t[f"f{i}.text"]) for i in range(1, 7)],
        },
        {
            "@type": "FAQPage",
            "@id": url + "#faq",
            "inLanguage": lang,
            "mainEntity": [
                {"@type": "Question", "name": plain(t[f"q{i}"]),
                 "acceptedAnswer": {"@type": "Answer", "text": plain(t[f"a{i}"])}}
                for i in range(1, 6)
            ],
        },
        {
            "@type": "WebSite",
            "@id": SITE + "#site",
            "name": "Dropnook",
            "url": SITE,
            "inLanguage": ["en", "de"],
        },
    ]
    # "<" escaped: the JSON sits inside a <script> element.
    return json.dumps({"@context": "https://schema.org", "@graph": graph},
                      ensure_ascii=False, indent=1).replace("<", "\\u003c")


def page(lang: str) -> str:
    t = TEXT[lang]
    de = lang == "de"
    root = "../" if de else ""
    url = SITE + ("de/" if de else "")
    gallery = f"{root}gallery/" + ("?lang=de" if de else "")
    shots = f"{root}screenshots/" + ("de/" if de else "")
    thumbs = "\n".join(
        f'      <a href="{gallery}#{i}"><picture>'
        f'<source media="(prefers-color-scheme: dark)" srcset="{shots}{n}-dark-thumb.webp">'
        f'<img src="{shots}{n}-light-thumb.webp" width="720" height="450" loading="lazy" alt="{html.escape(plain(t[f"s{i}"]))}">'
        f'</picture><span>{t[f"s{i}"]}</span></a>'
        for i, n in enumerate(SHOTS, 1))
    faq = "\n".join(
        f'    <details><summary>{t[f"q{i}"]}</summary><p>{t[f"a{i}"]}</p></details>' for i in range(1, 6))
    values = dict(t)
    values.update({
        "lang": lang, "root": root, "url": url, "home": url, "gallery": gallery, "shots": shots,
        "readme": REPO + ("/blob/main/README.de.md" if de else ""),
        "cur.en": "" if de else 'aria-current="page"', "cur.de": 'aria-current="page"' if de else "",
        "thumbs": thumbs, "faq": faq, "jsonld": jsonld(lang, t, url),
    })

    def fill(m):
        key = m.group(1)
        if key not in values:
            raise KeyError(f"{lang}: no text for {{{{{key}}}}}")
        return values[key]
    out = re.sub(r"\{\{([\w.]+)\}\}", fill, TEMPLATE)
    if "{{" in out:
        raise ValueError("unfilled placeholder")
    return out


def main() -> None:
    missing = set(TEXT["en"]) ^ set(TEXT["de"])
    if missing:
        raise SystemExit(f"text.json: keys only in one language: {sorted(missing)}")
    (DOCS / "index.html").write_text(page("en"), encoding="utf-8")
    (DOCS / "de").mkdir(exist_ok=True)
    (DOCS / "de" / "index.html").write_text(page("de"), encoding="utf-8")

    today = datetime.date.today().isoformat()
    alternates = (f'    <xhtml:link rel="alternate" hreflang="en" href="{SITE}"/>\n'
                  f'    <xhtml:link rel="alternate" hreflang="de" href="{SITE}de/"/>\n')
    urls = [(SITE, alternates), (SITE + "de/", alternates), (SITE + "gallery/", "")]
    body = "".join(f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{today}</lastmod>\n{alt}  </url>\n"
                   for u, alt in urls)
    (DOCS / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + body + "</urlset>\n", encoding="utf-8")
    print("docs/index.html, docs/de/index.html, docs/sitemap.xml")


if __name__ == "__main__":
    main()
