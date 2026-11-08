// UI localization (#349): locale resolution, the message formatter, catalog
// hygiene and the main-side controller. Synthetic catalogs stand in for a
// second language so the fallback paths are tested independently of shipped
// translations.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../renderer/i18n");
const catalogs = require("../renderer/locales");

const RENDERER = path.join(__dirname, "..", "renderer");
const SYNTH = ["en", "ro", "pt-BR"];

test("resolveLocale: override, exact, parent and fallback", () => {
  const r = (o) => core.resolveLocale({ supported: SYNTH, ...o });
  assert.equal(r({ override: "ro", system: ["en-US"] }), "ro");
  assert.equal(r({ override: "system", system: ["ro-RO", "en"] }), "ro");
  assert.equal(r({ system: ["pt-BR"] }), "pt-BR");
  assert.equal(r({ system: ["pt-PT", "en"] }), "en", "pt-PT has no exact/parent among [pt-BR]");
  assert.equal(r({ system: ["de-DE", "ro_MD"] }), "ro", "skips unsupported, canonicalizes ro_MD, parent match");
  assert.equal(r({ system: ["de", "fr"] }), "en");
  assert.equal(r({ override: "xx", system: ["ro"] }), "ro", "unsupported override behaves as system");
  assert.equal(r({ override: "!!bad!!", system: [] }), "en");
  assert.equal(r({ system: "ro" }), "en", "non-array system list is ignored");
  assert.equal(r({ system: [null, 5, "", "RO"] }), "ro");
});

test("normalizePreference keeps only system or a shipped tag", () => {
  assert.equal(core.normalizePreference("system", SYNTH), "system");
  assert.equal(core.normalizePreference("ro", SYNTH), "ro");
  assert.equal(core.normalizePreference("klingon", SYNTH), "system");
  assert.equal(core.normalizePreference(undefined, SYNTH), "system");
  assert.equal(core.normalizePreference({}, SYNTH), "system");
});

const cat = {
  en: {
    hi: "Hello {name}",
    files: { one: "{count} file", other: "{count} files" },
    only: "English only",
    twice: "{a}-{a}",
  },
  ro: {
    hi: "Salut {name}",
    files: { one: "{count} fișier", few: "{count} fișiere", other: "{count} de fișiere" },
    broken: { one: "x" }, // no `other`: invalid
  },
};

test("translator: interpolation, plurals per locale, fallback to English", () => {
  const ro = core.createTranslator({ locale: "ro", catalogs: cat });
  assert.equal(ro.t("hi", { name: "Ana" }), "Salut Ana");
  assert.equal(ro.t("files", { count: 1 }), "1 fișier");
  assert.equal(ro.t("files", { count: 3 }), "3 fișiere");
  assert.equal(ro.t("files", { count: 20 }), "20 de fișiere");
  assert.equal(ro.t("only"), "English only", "missing entry falls back to English");
  const en = core.createTranslator({ locale: "en", catalogs: cat });
  assert.equal(en.t("files", { count: 1 }), "1 file");
  assert.equal(en.t("files", { count: 0 }), "0 files");
  assert.equal(en.t("files", { count: 1234 }), "1,234 files");
});

test("translator: fallback entries use English plural rules", () => {
  const missingFew = { en: cat.en, ro: { files: { other: "{count} de fișiere" } } };
  const ro = core.createTranslator({ locale: "ro", catalogs: missingFew });
  assert.equal(ro.t("files", { count: 3 }), "3 de fișiere", "`other` covers a missing category");
  const broken = core.createTranslator({ locale: "ro", catalogs: { en: { b: { one: "{count} item", other: "{count} items" } }, ro: { b: { one: "x" } } } });
  assert.equal(broken.t("b", { count: 1 }), "1 item");
  assert.equal(broken.t("b", { count: 2 }), "2 items");
});

test("translator: unknown key is readable and reported; unsupported locale is English", () => {
  const seen = [];
  const t = core.createTranslator({ locale: "ro", catalogs: cat, onMissing: (k, l) => seen.push([k, l]) });
  assert.equal(t.t("nope.key"), core.GENERIC_MISSING);
  assert.ok(seen.some(([k]) => k === "nope.key"));
  assert.equal(core.createTranslator({ locale: "zz", catalogs: cat }).locale, "en");
});

test("translator: missing, null and hostile parameters", () => {
  const { t } = core.createTranslator({ locale: "en", catalogs: cat });
  assert.equal(t("hi"), "Hello ");
  assert.equal(t("hi", { name: null }), "Hello ");
  assert.equal(t("hi", null), "Hello ");
  assert.equal(t("hi", { name: "{name}" }), "Hello {name}", "values are not re-expanded");
  assert.equal(t("twice", { a: "{a}" }), "{a}-{a}");
  assert.equal(t("hi", { name: "<img src=x onerror=alert(1)>" }), "Hello <img src=x onerror=alert(1)>", "inserted as plain text");
  assert.equal(t("hi", { name: "$&$1" }), "Hello $&$1", "no replacement-pattern expansion");
  assert.equal(t("hi", { constructor: "x", name: "ok" }), "Hello ok");
});

test("applyDom writes text and attributes without parsing HTML", () => {
  const attrs = {};
  const el = (dataset) => ({
    dataset,
    textContent: "",
    setAttribute: (k, v) => { attrs[k] = v; },
  });
  const a = el({ i18n: "k" });
  const b = el({ i18nAttr: "aria-label:k; title:k" });
  const rootEl = {
    querySelectorAll: (sel) => (sel === "[data-i18n]" ? [a] : [b]),
  };
  core.applyDom(rootEl, (key) => `<b>${key}</b>`);
  assert.equal(a.textContent, "<b>k</b>");
  assert.equal(attrs["aria-label"], "<b>k</b>");
  assert.equal(attrs.title, "<b>k</b>");
});

// ---- shipped catalogs ----

test("every locale file is registered in index.js and loaded by each page", () => {
  const files = fs.readdirSync(path.join(RENDERER, "locales")).filter((f) => f.endsWith(".js") && f !== "index.js");
  assert.deepEqual(files.map((f) => f.slice(0, -3)).sort(), Object.keys(catalogs).sort());
  for (const page of ["settings", "wizard", "overlay", "correction"]) {
    const html = fs.readFileSync(path.join(RENDERER, `${page}.html`), "utf8");
    for (const f of files) assert.ok(html.includes(`src="locales/${f}"`), `${page}.html loads locales/${f}`);
    assert.ok(html.indexOf("i18n.js") < html.indexOf("i18n-client.js"));
  }
});

test("catalogs match English: keys, placeholders and plural shape", () => {
  const en = catalogs.en;
  for (const [tag, catalog] of Object.entries(catalogs)) {
    assert.equal(typeof catalog["meta.name"], "string", `${tag} names itself`);
    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(core.validEntry(entry), `${tag}:${key} is a string or has \`other\``);
      assert.ok(Object.hasOwn(en, key), `${tag}:${key} is not in English (extra key)`);
      if (typeof entry === "object") {
        for (const c of Object.keys(entry)) assert.ok(core.PLURAL_CATEGORIES.includes(c), `${tag}:${key} category ${c}`);
      }
      if (tag === "en") continue;
      assert.deepEqual(
        [...core.placeholdersOf(entry)].sort(),
        [...core.placeholdersOf(en[key])].sort(),
        `${tag}:${key} uses the same placeholders as English`
      );
    }
    if (tag === "en") continue;
    for (const key of Object.keys(en)) assert.ok(Object.hasOwn(catalog, key), `${tag} is missing ${key}`);
  }
});

test("English plural entries cover the categories English uses", () => {
  for (const [key, entry] of Object.entries(catalogs.en)) {
    if (typeof entry !== "object") continue;
    assert.ok(entry.one && entry.other, `en:${key} needs one and other`);
  }
});

test("every key used by the code exists in English", () => {
  const used = new Set();
  const scan = (file) => {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/labelKey: "([\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n(?:-attr)?="(?:[a-z-]+:)?([\w.]+)"/g)) used.add(m[1]);
  };
  for (const dir of ["main", "renderer"]) {
    for (const f of fs.readdirSync(path.join(__dirname, "..", dir))) {
      if (/\.(js|html)$/.test(f)) scan(path.join(__dirname, "..", dir, f));
    }
  }
  for (const key of used) assert.ok(Object.hasOwn(catalogs.en, key), `used key ${key} missing from en`);
});

// ---- main controller ----

test("main controller: binds to settings, bumps rev, notifies only on change", () => {
  const i18n = require("../main/i18n");
  const listeners = [];
  const settings = {
    cfg: { uiLanguage: "system" },
    get() { return this.cfg; },
    onChanged(fn) { listeners.push(fn); },
  };
  i18n.bind({ settings, systemLanguages: () => ["de", "en"] });
  assert.equal(i18n.getLocale(), "en");
  const events = [];
  const off = i18n.onChange((s) => events.push(s));
  const before = i18n.snapshot().rev;
  listeners[0]({ current: { uiLanguage: "system" } });
  listeners[0]({ current: { uiLanguage: "klingon" } });
  assert.equal(events.length, 0, "no change, no event");
  assert.equal(i18n.snapshot().rev, before);
  assert.equal(i18n.t("tray.start"), "Start dictation");
  off();
});

test("a locale change reaches notices and listeners; missing entries fall back to English (#349)", (t) => {
  const locales = require("../renderer/locales");
  const i18n = require("../main/i18n");
  const notices = require("../main/setup-notices");
  // A synthetic catalog, not a shipped translation: one entry translated.
  locales.xx = { "meta.name": "Test", "notice.ready.title": "[xx] Ready" };
  t.after(() => { i18n.setLocale("en"); delete locales.xx; });

  const events = [];
  const off = i18n.onChange((s) => events.push(s));
  t.after(off);
  const rev = i18n.snapshot().rev;
  assert.equal(i18n.setLocale("xx"), true);
  assert.equal(i18n.getLocale(), "xx");
  assert.equal(events.length, 1);
  assert.ok(events[0].rev > rev);
  assert.equal(i18n.setLocale("xx"), false, "same locale: no event");

  const ready = notices.readyNotice("CommandOrControl+Shift+Space");
  assert.equal(ready.title, "[xx] Ready");
  assert.match(ready.body, /^Press .* to dictate\.$/, "untranslated body falls back to English with its parameter");
  assert.equal(notices.sttNotReadyNotice({ reason: "missing", label: "Parakeet" }).body.includes("Parakeet"), true);

  i18n.setLocale("zz-unsupported");
  assert.equal(i18n.getLocale(), "en", "an unknown locale resolves to English");
});
