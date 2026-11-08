// Real Chromium keyboard/DOM coverage, run by settings-smoke on every CI OS.
const assert = require("node:assert/strict");
const { ipcMain, nativeTheme } = require("electron");
const windows = require("../main/windows");
const settings = require("../main/settings");
const history = require("../main/history");
const { createPalette } = require("../main/palette");
const { waitForLoad } = require("./wait-for-load");
async function checkPalette({ waitFor, check, invokeHandlers }) {
  let busy = false, win, creates = 0, copies = 0, restores = 0;
  let checkUpdates = async () => {};
  const palette = createPalette({
    windows: { ...windows, restorePaletteCaller: caller => { restores++; windows.restorePaletteCaller(caller); }, createPaletteWindow: () => { creates++; win = windows.createPaletteWindow(); return win; } },
    pipeline: { isPaletteIdle: () => !busy }, history, settings,
    actions: { lastTranscript: () => "recoverable", copyLast: async () => { copies++; }, correctLast: () => windows.openCorrection(history.list()[0]), checkUpdates: () => checkUpdates(), openLog: async () => ({ ok: true }) },
  });
  palette.install(ipcMain);
  const form = windows.openSettings();
  if (form.webContents.isLoadingMainFrame()) await waitForLoad(form.webContents);
  const formRun = code => form.webContents.executeJavaScript(code, true);
  const run = code => win.webContents.executeJavaScript(code, true);
  function key(target, keyCode, modifiers = []) {
    target.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    target.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }
  async function opened() {
    await waitFor(() => Promise.resolve(win && !win.isDestroyed() && win.isVisible()), "Commands did not become visible");
    await waitFor(() => run('document.querySelectorAll("[role=option]").length > 0'), "Commands results missing");
  }
  async function search(value) {
    await run(`document.getElementById("search").value = ${JSON.stringify(value)}; document.getElementById("search").dispatchEvent(new Event("input"));`);
    await waitFor(() => run(`!document.getElementById("status").textContent.includes("Loading") && search.value === ${JSON.stringify(value)}`), "query not set");
  }
  try {
    await waitFor(() => formRun('typeof formReady !== "undefined" && formReady'), "Settings not ready for Commands");
    await formRun('document.getElementById("cleanup-dictionary").value = "unsaved palette draft"; document.getElementById("commands").focus()');
    form.focus();
    key(form, "K", [process.platform === "darwin" ? "meta" : "control"]);
    await opened();
    check("Commands shortcut focuses its named combobox", await run('document.activeElement.id === "search" && !!document.querySelector("label[for=search]")'));
    palette.open(); check("repeated Commands opens use a singleton", creates === 1);
    key(win, "End");
    await waitFor(() => run('search.getAttribute("aria-activedescendant") === document.querySelector("[role=option]:last-child").id'), "End did not select last result");
    key(win, "Home");
    await waitFor(() => run('search.getAttribute("aria-activedescendant") === "option-0"'), "Home did not select first result");
    key(win, "Down");
    await waitFor(() => run('search.getAttribute("aria-activedescendant") === "option-1"'), "Down did not select next result");
    key(win, "Up"); key(win, "Tab");
    await waitFor(() => run('document.activeElement.id === "close"'), "Tab did not reach Close");
    key(win, "Escape");
    await waitFor(() => Promise.resolve(!palette.isOpen()), "Escape did not close Commands");
    check("Escape retains the Settings control and unsaved draft", await formRun('document.activeElement.id === "commands" && document.getElementById("cleanup-dictionary").value === "unsaved palette draft"'));

    // Eight matches straddle Settings' five-row page boundary. A raw-only
    // match must land on the selected card, not just the History heading.
    const text = '<img src=x onerror="window.injected=true"> dictation';
    for (let i = 0; i < 8; i++) history.add({ text: `${text} ${i}`, raw: "raw needle", cleaned: false }, { enabled: true, limit: 100 });
    palette.open(); await opened(); await search("needle");
    await waitFor(() => run('document.querySelectorAll("[role=option]").length === 9'), "bounded History results missing");
    check("Commands renders transcript markup as safe text", await run('!document.querySelector("img") && !window.injected && results.textContent.includes("<img")'));
    const selectedId = history.search({ query: "needle", limit: 8 }).entries[6].id;
    for (let i = 0; i < 6; i++) key(win, "Down");
    key(win, "Enter");
    await waitFor(() => Promise.resolve(!palette.isOpen()), "History result did not dispatch");
    await waitFor(() => formRun(`document.activeElement.dataset.id === ${JSON.stringify(selectedId)}`), "selected History card was not focused");
    check("History navigation preserves query, selected card and unsaved settings", await formRun('document.getElementById("history-search").value === "needle" && document.getElementById("cleanup-dictionary").value === "unsaved palette draft"'));

    palette.open(); await opened(); await search("Copy last");
    await waitFor(() => run('document.querySelector("[role=option]").textContent === "Copy last transcription"'), "copy result missing");
    key(win, "Enter"); key(win, "Enter");
    await waitFor(() => Promise.resolve(!palette.isOpen()), "copy did not close Commands");
    check("repeated Enter executes one copy", copies === 1);

    // Switch to another real Electron window while an action is pending.
    // Completion must not restore Settings over that newly chosen window.
    let finishUpdate;
    checkUpdates = () => new Promise(resolve => { finishUpdate = resolve; });
    form.focus();
    palette.open(); await opened(); await search("Check for updates");
    await waitFor(() => run('document.querySelector("[role=option]").textContent === "Check for updates"'), "update command missing");
    key(win, "Enter");
    await waitFor(() => Promise.resolve(!!finishUpdate), "update command did not start");
    const restoresBeforeBlur = restores;
    const other = windows.openCorrection({ text: "Keep focus in this other window." });
    if (other.webContents.isLoadingMainFrame()) await waitForLoad(other.webContents);
    other.focus();
    await waitFor(() => Promise.resolve(other.isFocused() && !win.isFocused()), "pending Commands did not lose focus");
    finishUpdate();
    await waitFor(() => Promise.resolve(!palette.isOpen()), "completed update did not close Commands");
    check("a delayed command preserves the newly focused window", restores === restoresBeforeBlur && other.isFocused());
    windows.closeCorrection();
    await waitFor(() => Promise.resolve(other.isDestroyed()), "other window did not close");
    form.focus();

    // A late old reply cannot overwrite a newly typed query.
    const originalQuery = invokeHandlers.get("palette:query");
    let release;
    ipcMain.removeHandler("palette:query");
    ipcMain.handle("palette:query", async (event, value) => {
      const answer = await originalQuery(event, value);
      if (value === "old query") await new Promise(resolve => { release = resolve; });
      return answer;
    });
    palette.open(); await opened(); await search("old query");
    await waitFor(() => Promise.resolve(!!release), "old query was not held");
    await search("General");
    await waitFor(() => run('results.textContent.includes("General")'), "new query missing");
    release();
    await run('Promise.resolve()');
    check("a delayed old query cannot replace current results", await run('results.textContent.includes("General") && search.value === "General"'));
    ipcMain.removeHandler("palette:query"); ipcMain.handle("palette:query", originalQuery);
    palette.close();

    busy = true;
    check("busy Commands opening never creates a window", palette.open() === false && !palette.isOpen());
    busy = false;
    for (const scheme of ["dark", "light"]) {
      nativeTheme.themeSource = scheme;
      palette.open(); await opened();
      const expectedInk = scheme === "dark" ? "#18181b" : "#fafafa";
      await waitFor(() => run(`getComputedStyle(document.documentElement).getPropertyValue("--ink").trim().toLowerCase() === "${expectedInk}"`), `Commands did not adopt ${scheme}`);
      const nativeInk = `#${win.getBackgroundColor().replace("#", "").slice(-6).toLowerCase()}`;
      check(`Commands uses the ${scheme} theme`, nativeInk === expectedInk, `native=${nativeInk} expected=${expectedInk}`);
      palette.close();
    }
    // Queue navigation before the first Settings document is ready. Its empty
    // query is intentional and must not trigger a second render after focus.
    windows.closeSettings();
    await waitFor(() => Promise.resolve(form.isDestroyed()), "previous Settings did not finish closing");
    const cold = windows.openSettings();
    const coldLoaded = waitForLoad(cold.webContents);
    windows.openSettings({ section: "history", query: "", entryId: selectedId });
    await coldLoaded;
    await waitFor(() => cold.webContents.executeJavaScript(`document.activeElement.dataset.id === ${JSON.stringify(selectedId)}`, true), "History destination was lost during Settings load");
    check("loading Settings retains an empty History query and selected-card focus", await cold.webContents.executeJavaScript('document.getElementById("history-search").value === ""', true));

    // Main-side sender rejection remains necessary even with a narrow bridge.
    const spoof = await invokeHandlers.get("palette:query")({ sender: cold.webContents }, "");
    assert.equal(spoof.ok, false);
    check("Settings cannot impersonate the palette query sender", /window/.test(spoof.error));
  } finally {
    palette.close(); windows.closeCorrection(); windows.closeSettings();
    for (const channel of ["palette:open", "palette:query", "palette:execute", "palette:close"]) ipcMain.removeHandler(channel);
  }
}
module.exports = { checkPalette };
