// The UI-language controller (#349): the one place that knows the effective
// locale. main.js binds it to the saved `uiLanguage` preference and the OS
// language list; the tray, notices, window titles and dialogs call t(); ipc.js
// pushes changes to every window. Electron-free so it is testable on its own.
//
// Unbound (tests, early startup) it speaks English.

const core = require("../renderer/i18n");

let locale = core.DEFAULT_LOCALE;
let translator = core.createTranslator({ locale });
// Bumped on every locale change; windows ignore a reply older than one they
// have already seen, so a slow initial lookup cannot undo a later change.
let rev = 0;
const listeners = new Set();
const reported = new Set();

function diagnostic(key, loc) {
  const id = `${loc}:${key}`;
  if (reported.has(id)) return;
  reported.add(id);
  // Development aid only; the user already got readable English.
  if (!process.env.NODE_TEST_CONTEXT) console.warn(`[i18n] missing "${key}" for ${loc}`);
}

function rebuild() {
  translator = core.createTranslator({ locale, onMissing: diagnostic });
}

function setLocale(next) {
  const resolved = core.createTranslator({ locale: next }).locale;
  if (resolved === locale) return false;
  locale = resolved;
  rev += 1;
  rebuild();
  for (const fn of [...listeners]) {
    try { fn(snapshot()); } catch { /* a listener must not block the others */ }
  }
  return true;
}

// Resolve from the saved preference and the OS language list.
function apply(preference, systemLanguages) {
  return setLocale(core.resolveLocale({ override: preference, system: systemLanguages }));
}

// Follow the settings: resolve now and again after every successful save.
function bind({ settings, systemLanguages = () => [] }) {
  const resolve = (cfg) => apply(cfg?.uiLanguage, systemLanguages());
  resolve(settings.get());
  settings.onChanged(({ current }) => resolve(current));
}

// The OS language list in preference order, from Electron's `app`. Falls back
// to the single UI locale, then to nothing (English) if neither is available.
function systemLanguagesOf(app) {
  try {
    const list = app.getPreferredSystemLanguages();
    if (Array.isArray(list) && list.length) return list;
  } catch { /* older Electron or a stub */ }
  try { return [app.getLocale()]; } catch { return []; }
}

const t = (key, params) => translator.t(key, params);
const getLocale = () => locale;
const snapshot = () => ({ locale, rev });
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

rebuild();

module.exports = { t, getLocale, snapshot, onChange, bind, apply, setLocale, systemLanguagesOf };
