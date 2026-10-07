# Languages

Every text people read in Drop comes from a file in this folder: one
`<code>.json` per language, named after its two- or three-letter ISO 639 code
(`en.json`, `de.json`, `ja.json` …). The help dialog has a matching
`help/<code>.html`.

Drop picks the language on its own: the web page uses the browser's preferred
languages, the public share page the `Accept-Language` header the browser
sends. The first one Drop has a file for wins; English is the fallback.

## Adding a language

1. Copy `en.json` to `<code>.json` and translate the values. Keep the keys and
   the `{placeholders}` exactly as they are.
2. Copy `help/en.html` to `help/<code>.html` and translate it.
3. Put both files where Drop finds them:
   * **for everyone:** into `lang/` and `help/` of this repository, as a pull
     request — the next image contains them;
   * **just for you, right away:** into Drop's appdata folder
     (`/mnt/user/appdata/drop` by default), which the `compose.yaml` mounts
     at `/config` — `<appdata>/lang/<code>.json` and
     `<appdata>/help/<code>.html`.
4. Reload the page. No restart, no code change.

Keys you leave out fall back to English, so a partial translation works too.

The appdata folder also changes the wording of a built-in language: a
`<appdata>/lang/de.json` with just the keys you want different is laid over the
built-in `de.json`, everything else stays. A `<appdata>/help/<code>.html`
replaces the built-in help page of that language.

## The `meta.*` keys

| Key | Meaning |
|---|---|
| `meta.name` | The language's name in itself, e.g. `Deutsch` |
| `meta.dir` | `ltr` or `rtl` (Arabic, Hebrew, Persian …) |
| `meta.aliases` | Other codes browsers send for it, comma-separated — e.g. Norwegian `nb` lists `no,nn` |

## Plurals

Keys that depend on a number come in forms with a suffix: `ui.words_one`,
`ui.words_other`. The web page picks the form with the browser's plural rules
(`Intl.PluralRules`), so languages with more forms can add `_zero`, `_two`,
`_few` or `_many` as needed — Russian, for example, uses `_one`, `_few`,
`_many` and `_other`. Languages without plural forms (Chinese, Japanese …)
only need `_other`.

If a language defines any form of a key, English forms of that key are never
mixed in.

The public share page (`public.*`) is rendered by the server, which only
tells `_one` (exactly 1) from `_other`. For languages with more forms, phrase
the `public.*` counts so they read correctly either way — e.g. `"Слов: {n}"`.

`public.thousands_separator` is the digit-group separator used on that page.

## Own area (`_own`)

With users, a confirmation in someone's own area must not say "for everyone":
nobody else is affected there. Keys such as `ui.delete_single` therefore have a
variant with `_own` (`ui.delete_single_own`, for plurals
`ui.delete_many_own_other`) — the same sentence without "for everyone". A
language without them uses the normal text.
