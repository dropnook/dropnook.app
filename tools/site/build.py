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
WHY = 9      # rows w1..w9 in "Why Dropnook?"
FEATURES = 9  # cards f1..f9
FAQ = 6       # q1..q6
SHOTS = ["1-overview", "2-share", "3-shares", "4-public", "5-phone", "6-languages", "7-theme",
         "8-colours", "9-users"]

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
            "featureList": [plain(t[f"f{i}.title"]) + " — " + plain(t[f"f{i}.text"]) for i in range(1, FEATURES + 1)],
        },
        {
            "@type": "FAQPage",
            "@id": url + "#faq",
            "inLanguage": lang,
            "mainEntity": [
                {"@type": "Question", "name": plain(t[f"q{i}"]),
                 "acceptedAnswer": {"@type": "Answer", "text": plain(t[f"a{i}"])}}
                for i in range(1, FAQ + 1)
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


BRAND = '<span class="dn">Drop<span>nook</span></span>'


def branded(page_html: str) -> str:
    """"Dropnook" in the visible text of <body> in its two colours, as in the logo.
    Titles, descriptions, alt texts and data stay plain; so do buttons, where the
    accent colour would vanish on the accent background."""
    head, mark, body = page_html.partition("<body>")
    out, in_button = [], False
    for part in re.split(r"(<[^>]+>)", body):
        if part.startswith("<"):
            if part.startswith("<a ") and 'class="btn' in part:
                in_button = True
            elif part == "</a>":
                in_button = False
            out.append(part)
        else:
            out.append(part if in_button else part.replace("Dropnook", BRAND))
    return head + mark + "".join(out)


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
    why = "\n".join(
        f'        <li><p class="no"><span class="vh">{t["why.without"]}: </span>{t[f"w{i}.no"]}</p>'
        f'<p class="yes"><span class="vh">{t["why.with"]}: </span>{t[f"w{i}.yes"]}</p></li>'
        for i in range(1, WHY + 1))
    faq = "\n".join(
        f'    <details><summary>{t[f"q{i}"]}</summary><p>{t[f"a{i}"]}</p></details>' for i in range(1, FAQ + 1))
    values = dict(t)
    values.update({
        "lang": lang, "root": root, "url": url, "home": url, "gallery": gallery, "shots": shots,
        "readme": REPO + ("/blob/main/README.de.md" if de else ""),
        "cur.en": "" if de else 'aria-current="page"', "cur.de": 'aria-current="page"' if de else "",
        "thumbs": thumbs, "why_rows": why, "faq": faq, "jsonld": jsonld(lang, t, url),
    })

    def fill(m):
        key = m.group(1)
        if key not in values:
            raise KeyError(f"{lang}: no text for {{{{{key}}}}}")
        return values[key]
    out = re.sub(r"\{\{([\w.]+)\}\}", fill, TEMPLATE)
    if "{{" in out:
        raise ValueError("unfilled placeholder")
    return branded(out)


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
