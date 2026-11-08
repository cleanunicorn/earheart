// UI language across the real windows (#349), driven from settings-smoke on
// its throwaway profile. The draft Romanian catalog is used, and this proves,
// against the real renderer:
//
// - Settings, the wizard and the correction window all start in the same
//   effective locale and report it on <html lang>;
// - saving a UI language retexts every open window — page text, native title —
//   without a reload, and an unsaved draft in the correction window survives;
// - the choice persists in settings.json and is independent of stt.language;
// - an unsupported saved value falls back to English, readably.

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const windows = require("../main/windows");
const settings = require("../main/settings");
const i18n = require("../main/i18n");
const { waitForLoad } = require("./wait-for-load");

const read = (win, expr) =>
  Promise.race([
    win.webContents.executeJavaScript(expr, true),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`read timed out: ${expr.slice(0, 60)}`)), 8000)),
  ]);
const saved = () => JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));

async function checkI18n({ waitFor, check }) {
  i18n.bind({ settings, systemLanguages: () => ["de-DE"] });
  const before = settings.get();
  let correctionWin = null;
  try {
    const settingsWin = windows.openSettings();
    const wizard = windows.openWizard();
    const correction = windows.openCorrection({ text: "a draft" });
    correctionWin = correction;
    const wins = { settings: settingsWin, wizard, correction };
    await Promise.all(Object.values(wins).map((w) => waitForLoad(w.webContents)));
    for (const w of Object.values(wins)) {
      await waitFor(() => read(w, `typeof i18n === "object" && i18n.locale`), "i18n client did not start");
      await read(w, `window.__marker = "same page"; true`);
    }
    const langs = await Promise.all(Object.values(wins).map((w) => read(w, `document.documentElement.lang`)));
    check("every window starts in the same effective locale", langs.every((l) => l === "en"), JSON.stringify(langs));

    const select = await read(settingsWin, `[...document.querySelectorAll("#ui-language option")].map((o) => o.value + ":" + o.textContent)`);
    check("Settings lists System default and each shipped language by its own name",
      select[0].startsWith("system:") && select.some((o) => o === "en:English"), JSON.stringify(select));

    await read(correction, `(() => { const t = document.getElementById("transcript"); t.value = "unsaved draft"; t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const sttBefore = JSON.stringify(settings.get().stt);
    settings.save({ ...settings.get(), uiLanguage: "ro" });

    await waitFor(async () => (await Promise.all(Object.values(wins).map((w) => read(w, `document.documentElement.lang`)))).every((l) => l === "ro"),
      "open windows did not follow the language change");
    const heading = await read(correction, `document.querySelector("h1").textContent`);
    const draft = await read(correction, `document.getElementById("transcript").value`);
    const marker = await Promise.all(Object.values(wins).map((w) => read(w, `window.__marker`)));
    check("saving a language retexts an open window", heading === "Corectează transcrierea", heading);
    check("native window titles follow", wizard.getTitle() === "Bine ai venit la Earheart" && correction.getTitle() === "Corectează transcrierea · Earheart",
      `${wizard.getTitle()} / ${correction.getTitle()}`);
    check("no window reloaded and the unsaved draft survived", marker.every((m) => m === "same page") && draft === "unsaved draft",
      JSON.stringify({ marker, draft }));
    check("the language persists and dictation settings are untouched",
      saved().uiLanguage === "ro" && JSON.stringify(settings.get().stt) === sttBefore, JSON.stringify(saved().uiLanguage));

    // A later window starts in the effective locale, not English.
    windows.closeWizard();
    await waitFor(() => wizard.isDestroyed(), "wizard did not close");
    const again = windows.openWizard();
    await waitForLoad(again.webContents);
    // The page only knows the shipped catalogs, so ask main what it tells a new
    // window: the saved locale, not English.
    const told = await read(again, `earheart.invoke("i18n:get")`);
    check("a window opened later is told the saved locale", told.locale === "ro", JSON.stringify(told));

    // An unsupported stored value reads as the system choice.
    settings.save({ ...settings.get(), uiLanguage: "klingon" });
    check("an unsupported saved language falls back readably", settings.get().uiLanguage === "system" && i18n.getLocale() === "en",
      `${settings.get().uiLanguage} / ${i18n.getLocale()}`);
  } finally {
    settings.save({ ...settings.get(), uiLanguage: before.uiLanguage });
    // The draft above marked the correction dirty; closing it would ask.
    windows.setCorrectionDirty(correctionWin?.webContents, false);
    windows.closeWizard();
    windows.closeCorrection();
    windows.closeSettings();
  }
}

module.exports = { checkI18n };
