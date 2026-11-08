// UI localization core (#349): locale resolution, a message formatter and a
// small DOM applier. Shared by main (CommonJS) and every window (classic
// script global `EarheartI18n`), like aliases.js. No dependencies.
//
// The UI language is independent of dictation: nothing here reads or writes
// stt.language, cleanup prompts or transcripts. English is canonical; every
// other catalog may be incomplete and falls back to it entry by entry.
//
// Catalog entries (renderer/locales/<tag>.js):
//   "key": "Text with {name} placeholders"
//   "key": { one: "{count} file", other: "{count} files" }   // `other` required
// Values are inserted as text only — never parsed as HTML, never re-scanned
// for placeholders — so a hostile value cannot inject markup or tokens.

(function (root) {
  const DEFAULT_LOCALE = "en";
  const GENERIC_MISSING = "Something went wrong.";
  const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

  const registry = () => {
    if (typeof module !== "undefined" && module.exports) return require("./locales/index.js");
    return root.EarheartLocales || {};
  };

  // "ro_RO" / "RO-ro" → "ro-RO"; null for anything that is not a language tag.
  function canonicalizeTag(tag) {
    if (typeof tag !== "string" || !tag.trim()) return null;
    try {
      return Intl.getCanonicalLocales(tag.trim().replace(/_/g, "-"))[0] || null;
    } catch {
      return null;
    }
  }

  // The supported tag for one requested tag: exact match, then its language
  // parent (ro-MD → ro). Null when neither is supported.
  function matchSupported(tag, supported) {
    const wanted = canonicalizeTag(tag);
    if (!wanted) return null;
    const lower = new Map(supported.map((s) => [s.toLowerCase(), s]));
    const exact = lower.get(wanted.toLowerCase());
    if (exact) return exact;
    const parent = wanted.split("-")[0].toLowerCase();
    return lower.get(parent) || null;
  }

  // The effective UI locale. `override` is the stored preference ("system" or
  // a supported tag); an unsupported or malformed one behaves as "system".
  // `system` is the OS language list in preference order. Falls back to English.
  function resolveLocale({ override = "system", system = [], supported } = {}) {
    const tags = supported || Object.keys(registry());
    if (override !== "system") {
      const chosen = matchSupported(override, tags);
      if (chosen) return chosen;
    }
    for (const tag of Array.isArray(system) ? system : []) {
      const found = matchSupported(tag, tags);
      if (found) return found;
    }
    return DEFAULT_LOCALE;
  }

  // A stored preference as it should persist: "system" or a supported tag.
  function normalizePreference(value, supported) {
    if (value === "system") return "system";
    const tags = supported || Object.keys(registry());
    return tags.includes(value) ? value : "system";
  }

  const validEntry = (entry) =>
    typeof entry === "string" ||
    (entry !== null && typeof entry === "object" && typeof entry.other === "string");

  function interpolate(text, params, locale) {
    return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (!Object.hasOwn(params, name)) return "";
      const value = params[name];
      if (typeof value === "number" && Number.isFinite(value)) {
        return new Intl.NumberFormat(locale).format(value);
      }
      return value === null || value === undefined ? "" : String(value);
    });
  }

  // `catalogs` maps tag → { key: entry }. `onMissing(key, locale)` is a
  // development diagnostic hook; the user still gets readable English.
  function createTranslator({ locale = DEFAULT_LOCALE, catalogs = registry(), onMissing } = {}) {
    const active = catalogs[locale] ? locale : DEFAULT_LOCALE;
    function t(key, params = {}) {
      const safe = params && typeof params === "object" ? params : {};
      let entry = catalogs[active]?.[key];
      let from = active;
      if (!validEntry(entry)) {
        entry = catalogs[DEFAULT_LOCALE]?.[key];
        from = DEFAULT_LOCALE;
        if (onMissing) onMissing(key, active);
      }
      if (!validEntry(entry)) {
        if (onMissing && from === DEFAULT_LOCALE) onMissing(key, DEFAULT_LOCALE);
        return GENERIC_MISSING;
      }
      let text = entry;
      if (typeof entry === "object") {
        const count = Number(safe.count);
        const category = Number.isFinite(count) ? new Intl.PluralRules(from).select(count) : "other";
        text = typeof entry[category] === "string" ? entry[category] : entry.other;
      }
      return interpolate(text, safe, from);
    }
    return { t, locale: active };
  }

  // Apply data-i18n (text) and data-i18n-attr ("aria-label:key; title:key")
  // below `rootEl`. Text goes in through textContent/setAttribute only.
  function applyDom(rootEl, t) {
    for (const el of rootEl.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of rootEl.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of el.dataset.i18nAttr.split(";")) {
        const [attr, key] = pair.split(":").map((s) => s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      }
    }
  }

  // Every {placeholder} an entry uses, across its plural variants.
  function placeholdersOf(entry) {
    const texts = typeof entry === "string" ? [entry] : Object.values(entry || {});
    const names = new Set();
    for (const text of texts) {
      for (const m of String(text).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(m[1]);
    }
    return names;
  }

  const api = {
    DEFAULT_LOCALE,
    GENERIC_MISSING,
    PLURAL_CATEGORIES,
    canonicalizeTag,
    matchSupported,
    resolveLocale,
    normalizePreference,
    createTranslator,
    applyDom,
    placeholdersOf,
    validEntry,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EarheartI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
