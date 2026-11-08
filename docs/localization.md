# Localization

Earheart's interface language is a setting of its own (**Settings → General →
Language**, stored as top-level `uiLanguage`: `"system"` or a locale tag). It is
independent of the dictation language (`stt.language`): changing it never
touches speech recognition, cleanup prompts, vocabulary, aliases or stored
transcripts.

## How the locale is chosen

`renderer/i18n.js` (shared by main and every window) resolves it:

1. A saved, supported `uiLanguage` wins (`ro-MD` matches a shipped `ro`).
2. Otherwise the OS language list, in preference order: the exact tag, then its
   language parent. Unsupported entries are skipped.
3. Otherwise English.

An unsupported or malformed saved value behaves as `"system"` and is stored as
such on the next save. The OS list is read at startup and on each settings save;
an OS language change while the app runs applies on restart or the next save.

`main/i18n.js` holds the effective locale. On every *successful* settings save
whose resolved locale changed, main pushes `{ locale, rev }` on `i18n:changed`
to every window (Settings, wizard, overlay, correction), retitles the open
windows and rebuilds the tray. Windows ask `i18n:get` at start; `rev` makes them
ignore a stale reply that lost a race with a newer change. No window reloads, so
unsaved edits, correction drafts and an active capture are untouched.

## Catalogs

One file per language in `renderer/locales/<tag>.js`; **English (`en.js`) is
canonical**. Keys are stable and semantic (`tray.copyLast`,
`notice.sttMissing.body`), never the English text.

```js
"tray.updateTo": "Update to v{version}…",            // named placeholders
"files.count": { one: "{count} file", other: "{count} files" },  // plurals
```

- Placeholders are `{name}`; a translation must use exactly English's set. A
  missing parameter renders as nothing — never a raw `{token}` and never a throw.
- Plural entries are chosen by `Intl.PluralRules` for the catalog's own locale
  from the `count` parameter. `other` is mandatory; add `one`, `few`, `many`…
  as the language needs. An entry that is invalid falls back to the English one
  (with English plural rules).
- Every catalog has `meta.name`: the language's own name for the picker. It is
  never translated.
- Values are inserted as text only (`textContent`, `setAttribute`, native menu
  labels). Never put a translated or user-supplied value into `innerHTML`.
- Never translate: transcripts and live previews, vocabulary and aliases,
  prompts and the cleanup directives, model, service and microphone names, file
  paths, URLs, API keys, keyboard shortcuts and accelerator values.
- Errors: show a stable, translated message. Do not interpolate raw service
  response bodies, credentials, exception strings or stacks.

A missing key never breaks the UI: it falls back to English, and an unknown key
shows a generic readable message. In development a one-time
`[i18n] missing "key" for xx` is logged.

## Using it

- **Main process** (`main/*.js`): `const { t } = require("./i18n"); t("key", { name })`.
  Call `t` when the text is shown (menu build, notification), not at module load.
- **Windows**: `data-i18n="key"` sets an element's text,
  `data-i18n-attr="aria-label:key; title:key"` sets attributes. In script, use
  `i18n.t("key", params)` and `i18n.onChange(() => rerender())` for text you
  render yourself. Keep the English text in the HTML as the pre-initialization
  default.
- Every page loads `i18n.js`, every `locales/*.js` and `i18n-client.js` before
  its own scripts (`test/i18n.test.js` enforces this).

## Adding a language

1. Copy `renderer/locales/en.js` to `<tag>.js`; keep every key and placeholder.
2. Translate the values; set `meta.name` to the language's own name.
3. Register it in `renderer/locales/index.js` and add its `<script>` to the four
   pages (`settings`, `wizard`, `overlay`, `correction`).
4. `node --test test/i18n.test.js` checks missing and extra keys, placeholders,
   plural shape, and that every key used in code exists in English.
5. Have a fluent reviewer read the complete catalog **and** the rendered screens
   (long strings, plurals, error states) before it ships. Do not commit machine
   translations as if reviewed.

## Status

English is complete for the surfaces already routed through the catalog (tray,
startup and setup notifications, window titles, the correction-close dialog,
the correction window heading, and Settings → General → Language/Appearance).
The remaining Settings, wizard and overlay copy is extracted incrementally; see
the tracking issue (#349).
