// Light and dark appearance in the framed windows (#348), driven from
// settings-smoke on its throwaway profile. Proves, against the real renderer:
//
// - each framed window (Settings, wizard, correction) is created in the
//   palette's ink — native background and the page's --ink alike;
// - saving a new Appearance re-themes the open Settings window without a
//   reload: the scroll position, the lit index entry, an expanded History
//   entry and a later, unsaved edit all survive, and the page never starts
//   loading again;
// - a theme flip while edits are unsaved (an OS change in "system" mode)
//   keeps them, and the native background follows via nativeTheme 'updated';
// - focus, error and disabled states keep their palette's colours.
//
// themeSource is always set explicitly: under xvfb "system" resolves to
// whatever the runner's GTK says, so nothing here depends on it.

const { nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const windows = require("../main/windows");
const settings = require("../main/settings");
const appearance = require("../main/appearance");
const { readPalettes, parseColor } = require("./theme-contrast");
const { waitForLoad } = require("./wait-for-load");

const palettes = readPalettes();
const INK = { dark: palettes.dark.get("--ink"), light: palettes.light.get("--ink") };
// Computed colours come back as rgb(r, g, b); compare as such.
const asRgb = (value) => {
  const { r, g, b } = parseColor(value);
  return `rgb(${r}, ${g}, ${b})`;
};
const bgHex = (win) => `#${win.getBackgroundColor().replace("#", "").slice(-6).toLowerCase()}`;
const pageInk = (win) =>
  win.webContents.executeJavaScript(
    `getComputedStyle(document.documentElement).getPropertyValue("--ink").trim().toLowerCase()`,
    true
  );

function savedAppearance() {
  const file = path.join(app.getPath("userData"), "settings.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).appearance;
}

// Wizard and correction: opened in each palette, painted in its ink from the
// first frame (the native background is set at creation).
async function checkFramedInk({ waitFor, check }) {
  for (const scheme of ["dark", "light"]) {
    nativeTheme.themeSource = scheme;
    const wizard = windows.openWizard();
    const wizardBg = bgHex(wizard); // before the page has painted anything
    await waitForLoad(wizard.webContents);
    check(`wizard opens in the ${scheme} ink`, wizardBg === INK[scheme] && (await pageInk(wizard)) === INK[scheme],
      `native=${wizardBg} page=${await pageInk(wizard)} want=${INK[scheme]}`);
    windows.closeWizard();
    await waitFor(() => wizard.isDestroyed(), "wizard did not close");

    const correction = windows.openCorrection({ text: "a themed draft" });
    const correctionBg = bgHex(correction);
    await waitForLoad(correction.webContents);
    check(`correction opens in the ${scheme} ink`,
      correctionBg === INK[scheme] && (await pageInk(correction)) === INK[scheme],
      `native=${correctionBg} page=${await pageInk(correction)} want=${INK[scheme]}`);
    correction.close();
    await waitFor(() => correction.isDestroyed(), "correction did not close");
  }
}

async function checkSettingsTheme({ waitFor, check, savedThenClose }) {
  // As main.js does: the saved appearance drives themeSource from here on.
  settings.save({ ...settings.get(), appearance: "dark" });
  nativeTheme.themeSource = "dark";
  appearance.init();

  const win = windows.openSettings();
  await waitForLoad(win.webContents);
  const run = (code) => win.webContents.executeJavaScript(code, true);
  await waitFor(() => run(`document.getElementById("appearance").value === "dark"`), "Settings did not show the saved appearance");
  check("Settings opens in the dark ink", bgHex(win) === INK.dark && (await pageInk(win)) === INK.dark,
    `native=${bgHex(win)} page=${await pageInk(win)}`);

  let loads = 0;
  win.webContents.on("did-start-loading", () => loads++);

  // The state a reload or a re-populate would lose: a scroll position deep in
  // the page, the index entry it lit, an expanded History entry, and a JS
  // global standing in for everything else the page holds in memory.
  await run(`(() => {
    document.getElementById("tab-history").scrollIntoView({ block: "start", behavior: "instant" });
    document.querySelector("#history-list li")?.classList.add("expanded");
    window.__themeProbe = "kept";
    return true;
  })()`);
  await waitFor(() => run(`document.querySelector(".tab[aria-current]")?.dataset.tab === "history"`), "scrolling did not light History");
  const snapshot = () => run(`JSON.stringify({
    scrollTop: Math.round(document.querySelector("main").scrollTop),
    active: document.querySelector(".tab[aria-current]")?.dataset.tab,
    expanded: !!document.querySelector("#history-list li.expanded"),
    probe: window.__themeProbe,
    maxSeconds: document.getElementById("max-seconds").value,
  })`).then(JSON.parse);
  // A plain Save first: Save itself settles the layout (it shifts this
  // scroll position by a few dozen px with no theme involved), so the
  // baseline is taken after one, and the checks below isolate the re-theme.
  await run(`document.getElementById("save").click(); true`);
  await waitFor(() => run(`document.getElementById("save-status").className === "status ok"`), "the settling Save never reported Saved", 500);
  const before = await snapshot();

  // Save Light. Hold the reply, edit a field meanwhile: the edit made after
  // the click is unsaved and must survive the re-theme the Save causes.
  await run(`(() => {
    const select = document.getElementById("appearance");
    select.value = "light";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("save").click();
    return true;
  })()`);
  // The status still says Saved from the settling Save: wait on the store.
  await waitFor(async () => settings.get().appearance === "light" &&
    (await run(`document.getElementById("save-status").className === "status ok" && !document.getElementById("save").disabled`)),
  "Save never stored Light", 500);
  await waitFor(async () => (await pageInk(win)) === INK.light, "Settings did not re-theme to light after Save", 300);
  const afterSave = await snapshot();
  check("Save stores the appearance", savedAppearance() === "light" && settings.get().appearance === "light",
    `file=${savedAppearance()}`);
  check("Save re-themes Settings: page and native ink are light", (await pageInk(win)) === INK.light && bgHex(win) === INK.light,
    `page=${await pageInk(win)} native=${bgHex(win)} themeSource=${nativeTheme.themeSource}`);
  check("the re-theme does not reload Settings: scroll, lit section, expanded entry and page state survive",
    loads === 0 && JSON.stringify(afterSave) === JSON.stringify(before),
    JSON.stringify({ loads, before, afterSave }));

  // An unsaved edit, then a flip that is not a Save — the OS changing under
  // "system" mode takes the same path (prefers-color-scheme + 'updated').
  const edited = String(Number(before.maxSeconds) + 10);
  await run(`(() => {
    const input = document.getElementById("max-seconds");
    input.value = ${JSON.stringify(edited)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  nativeTheme.themeSource = "dark";
  await waitFor(async () => (await pageInk(win)) === INK.dark, "Settings did not follow a theme flip", 300);
  await waitFor(() => bgHex(win) === INK.dark, "the native background did not follow the flip", 300);
  const afterFlip = await snapshot();
  check("a theme flip keeps unsaved edits and the page as it was",
    loads === 0 && afterFlip.maxSeconds === edited && afterFlip.scrollTop === before.scrollTop &&
      afterFlip.active === before.active && afterFlip.expanded && afterFlip.probe === "kept",
    JSON.stringify({ loads, afterFlip, edited }));

  // States in both palettes: focus outline, error status, disabled key.
  for (const scheme of ["dark", "light"]) {
    nativeTheme.themeSource = scheme;
    await waitFor(async () => (await pageInk(win)) === INK[scheme], `Settings did not turn ${scheme}`, 300);
    const tokens = palettes[scheme];
    const states = JSON.parse(await run(`(() => {
      const probe = document.createElement("span");
      probe.className = "status err";
      probe.textContent = "x";
      document.body.append(probe);
      const err = getComputedStyle(probe).color;
      probe.remove();
      const button = document.getElementById("close");
      button.focus({ focusVisible: true });
      const focus = getComputedStyle(button).outlineColor;
      const visible = button.matches(":focus-visible");
      button.blur();
      return JSON.stringify({ err, focus, visible });
    })()`));
    check(`${scheme}: error text and focus outline wear the palette`,
      states.err === asRgb(tokens.get("--err")) && (!states.visible || states.focus === asRgb(tokens.get("--text"))),
      JSON.stringify(states));
  }

  // Back to the starting point, the edit undone so Close needs no answer.
  nativeTheme.themeSource = "dark";
  await run(`(() => {
    const input = document.getElementById("max-seconds");
    input.value = ${JSON.stringify(before.maxSeconds)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const select = document.getElementById("appearance");
    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("save").click();
    return true;
  })()`);
  await savedThenClose(win, "restoring the dark appearance never reported Saved");
  check("Saving Dark sets themeSource back", nativeTheme.themeSource === "dark" && savedAppearance() === "dark",
    `themeSource=${nativeTheme.themeSource}`);
}

async function checkTheme(helpers) {
  await checkSettingsTheme(helpers);
  await checkFramedInk(helpers);
  nativeTheme.themeSource = "dark";
}

module.exports = { checkTheme, INK };
