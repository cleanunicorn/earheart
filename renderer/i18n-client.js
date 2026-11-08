// Window side of UI localization (#349). Loaded after i18n.js and
// locales/*.js in every window. Exposes `i18n` ({ t, locale, onChange }),
// re-applies data-i18n markup and <html lang> whenever main reports the
// effective locale, and never reloads the page: unsaved edits, drafts and an
// active capture are left alone.
//
// Order matters: subscribe before the first lookup, and ignore any state whose
// `rev` is not newer than the last applied one, so a slow initial reply cannot
// overwrite a change that already arrived.

(function (root) {
  const core = root.EarheartI18n;
  const listeners = new Set();
  let rev = -1;
  let current = core.createTranslator({ locale: core.DEFAULT_LOCALE });

  const i18n = {
    t: (key, params) => current.t(key, params),
    get locale() { return current.locale; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Exposed for tests and for pages that add DOM later.
    apply(state) {
      if (!state || typeof state.rev !== "number" || state.rev <= rev) return false;
      rev = state.rev;
      current = core.createTranslator({ locale: String(state.locale), catalogs: root.EarheartLocales });
      if (root.document) {
        root.document.documentElement.lang = current.locale;
        core.applyDom(root.document, current.t);
        const title = root.document.querySelector("title[data-i18n]");
        if (title) root.document.title = current.t(title.dataset.i18n);
      }
      for (const fn of [...listeners]) {
        try { fn(current.locale); } catch (err) { console.error(err); }
      }
      return true;
    },
    // Re-run data-i18n for DOM a page rendered after the last apply.
    refresh() {
      if (root.document) core.applyDom(root.document, current.t);
    },
  };
  root.i18n = i18n;

  if (root.earheart) {
    root.earheart.on("i18n:changed", (state) => i18n.apply(state));
    root.earheart.invoke("i18n:get").then((state) => i18n.apply(state), () => {});
  }
})(globalThis);
