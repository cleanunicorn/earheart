// Real renderer, controllable main-process transfers: no network or model files.
const windows = require("../main/windows");
const engines = require("../main/engines");
const settings = require("../main/settings");
const { waitForLoad } = require("./wait-for-load");

async function checkWizard({ waitFor, check }) {
  const original = { download: engines.download, isInstalled: engines.isInstalled };
  const installed = new Set();
  const active = new Map();
  const starts = [];
  const aborts = [];
  let holdAbort = false;
  const pendingAborts = [];
  const speech = settings.get().stt.builtin.model;
  const cleanup = settings.get().cleanup.builtin.model;
  let win;
  let externalSettings;
  engines.isInstalled = (kind, id) => installed.has(kind + ":" + id);
  engines.download = (kind, id, { signal, onProgress }) => new Promise((resolve, reject) => {
    const key = kind + ":" + id;
    starts.push(key);
    active.set(key, {
      progress: onProgress,
      finish: () => { installed.add(key); active.delete(key); resolve(); },
      fail: () => { active.delete(key); reject(new Error("offline fixture")); },
    });
    signal.addEventListener("abort", () => {
      const settle = () => { aborts.push(key); active.delete(key); reject(new Error("aborted")); };
      if (holdAbort) pendingAborts.push(settle); else settle();
    }, { once: true });
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const open = async () => {
    win = windows.openWizard(); await waitForLoad(win.webContents);
    await waitFor(() => js('!!modelStatus && !!current'), "wizard failed to initialize");
  };
  const close = async () => { windows.closeWizard(); await waitFor(() => win.isDestroyed(), "wizard did not close"); };
  const shot = async (name, target = win) => {
    const dir = process.env.EARHEART_WIZARD_SCREENSHOTS;
    if (!dir) return;
    await waitFor(() => target.webContents.executeJavaScript('Array.from(document.querySelectorAll(".dl-fill")).every(f => Math.abs(f.getBoundingClientRect().width - f.parentElement.clientWidth * (parseFloat(f.style.width) || 0) / 100) < 1)'), "download bar did not settle for capture");
    await target.webContents.executeJavaScript("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
    require("node:fs").writeFileSync(require("node:path").join(dir, name + ".png"), (await target.webContents.capturePage()).toPNG());
  };
  const click = (id) => js('document.getElementById(' + JSON.stringify(id) + ').click(); undefined');
  const until = (expression, message) => waitFor(() => js(expression), message);
  const key = "stt:" + speech;
  const cleanupKey = "cleanup:" + cleanup;
  try {
    await open();
    await click("next"); await click("next"); await click("next");
    check("wizard does not download before explicit speech consent", starts.length === 0);
    win.setSize(560, 560);
    await until("innerWidth <= 560", "minimum wizard width did not apply");
    check("speech consent fits the minimum window width", await js('document.getElementById("next").getBoundingClientRect().right <= innerWidth && document.body.scrollWidth <= innerWidth'));
    await shot("wizard-speech-consent-min");
    win.setSize(620, 680);
    await until("innerWidth >= 600", "normal wizard width did not apply");
    await shot("wizard-speech-consent");
    check("speech consent shows catalog size", await js('document.getElementById("next").textContent.includes("GB")'));
    await click("next");
    await waitFor(() => active.get(key), "speech did not start after consent");
    await shot("wizard-customize");
    check("Customize starts collapsed", await js('!document.getElementById("cleanup-customize").open'));
    await js('document.querySelector("#cleanup-customize summary").focus(); undefined');
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    check("Customize opens from the keyboard", await until('document.getElementById("cleanup-customize").open', "Customize did not open"));
    await js('document.getElementById("cleanup-customize").open = false; undefined');
    active.get(key).progress({ received: 1e9, total: engines.registry.totalBytes(engines.registry.getModel("stt", speech)), fraction: 0.4 });
    await click("next"); await click("next");
    check("cleanup waits behind speech", starts.length === 1);
    check("early speech bytes reach combined total", await until('document.getElementById("download-total").textContent.startsWith("1.0 GB of")', "early progress lost"));
    await shot("wizard-downloading");
    check("Finish waits for speech", await js('document.getElementById("next").disabled'));
    await click("back"); await click("back"); await click("next"); await click("next");
    check("Back and Next retain the speech transfer", starts.length === 1 && aborts.length === 0);
    active.get(key).finish();
    await waitFor(() => active.get(cleanupKey), "cleanup did not start after speech");
    check("Finish enables while optional cleanup downloads", await until('!document.getElementById("next").disabled', "Finish blocked by cleanup"));
    check("Finish teaches actual hotkey", await js('document.getElementById("finish-hint").textContent.includes(displayHotkey(current.hotkey))'));
    const cleanupBytes = engines.registry.totalBytes(engines.registry.getModel("cleanup", cleanup));
    active.get(cleanupKey).progress({ received: cleanupBytes / 4, total: cleanupBytes, fraction: 0.25 });
    await shot("wizard-speech-ready");
    await click("next");
    await waitFor(() => win.isDestroyed(), "Finish did not close wizard");
    check("closing wizard retains optional transfer", active.has(cleanupKey));
    const handoff = externalSettings = windows.openSettings();
    const form = (code) => handoff.webContents.executeJavaScript(code, true);
    await waitFor(() => form('typeof formReady !== "undefined" && formReady && !document.getElementById("wizard-banner").hidden'), "saved banner did not initialize");
    check("saved banner teaches committed hotkey without asking to save again", await form('document.getElementById("wizard-saved-message").textContent.includes(displayHotkey(savedSetup.hotkey)) && document.getElementById("wizard-saved-message").textContent.includes("saved")'));
    check("saved banner hydrates background progress before another tick", await form('document.getElementById("wizard-cleanup-progress").textContent.includes("25%")'));
    if (process.env.EARHEART_WIZARD_SCREENSHOTS) await form('renderHotkeyStatus({ hotkey: { ok: true }, pauseHotkey: { ok: true }, discardHotkey: { ok: true } }); undefined');
    await shot("settings-saved-setup", handoff);
    await form('document.getElementById("cleanup-prompt").value = "unsaved draft"');
    settings.save({ ...settings.get(), hotkey: "F8" });
    windows.openSettings({ fromWizard: true, section: "stt", model: true });
    await waitFor(() => form('document.getElementById("wizard-saved-message").textContent.includes("F8")'), "existing Settings did not receive handoff");
    check("existing Settings updates saved hotkey and preserves draft on navigation", await form('document.getElementById("cleanup-prompt").value === "unsaved draft" && document.getElementById("hotkey").value === "F8"'));
    active.get(cleanupKey).finish();

    installed.clear(); starts.length = 0; aborts.length = 0;
    await open();
    await click("next"); await click("next"); await click("next"); await click("next");
    await waitFor(() => active.get(key), "second speech did not start");
    active.get(key).fail();
    await until('transfer("stt", current.stt.builtin.model).phase === "failed"', "early failure lost");
    await click("next"); await click("next");
    check("early failure renders Retry on final step", await js('!![...document.querySelectorAll("#download-list button")].find(b => !b.hidden && b.textContent === "Retry")'));
    await js('document.querySelector("#download-list button").click(); undefined');
    await waitFor(() => active.get(key), "Retry did not restart speech");
    check("Retry explicitly starts one new attempt", starts.length === 2);
    holdAbort = true;
    await click("download-later");
    await until('transfer("stt", current.stt.builtin.model).phase === "skipped"', "skip not retained");
    await js('document.querySelector("#download-list button").click(); undefined');
    await click("download-later");
    holdAbort = false;
    pendingAborts.splice(0).forEach((settle) => settle());
    await until('!transfer("stt", current.stt.builtin.model).starting', "pending Retry did not settle");
    check("Download later invalidates Retry waiting for old cancellation", starts.length === 2);
    check("Download later preserves unavailable speech and optional cleanup explanations after cancellation", await js('document.getElementById("download-list").textContent.includes("dictation won\'t work") && document.getElementById("download-list").textContent.includes("optional") && !document.getElementById("download-list").textContent.includes("Cancelled")'));
    await shot("wizard-download-later");
    check("Download later disarms queued cleanup", !active.has(cleanupKey) && starts.every((s) => s === key));
    await click("next");
    await waitFor(() => win.isDestroyed(), "Finish after Download later did not close wizard");
    const missingForm = externalSettings = windows.openSettings();
    await waitFor(() => missingForm.webContents.executeJavaScript('typeof formReady !== "undefined" && formReady && document.getElementById("wizard-banner-title").textContent === "Setup saved."', true), "missing speech banner promised readiness");
    check("saved setup with missing speech explains required download", await missingForm.webContents.executeJavaScript('document.getElementById("wizard-saved-message").textContent.includes("Download speech")', true));

    installed.add(key);
    await open();
    await click("next"); await click("next"); await click("next"); await click("next");
    const alternative = engines.registry.listModels("cleanup").find((m) => m.id !== cleanup).id;
    const chooseCleanup = (id) => js('document.getElementById("cleanup-builtin-model").value = ' + JSON.stringify(id) + '; document.getElementById("cleanup-builtin-model").dispatchEvent(new Event("change")); undefined');
    await chooseCleanup(alternative);
    await click("next");
    check("cleanup consent cost follows the selected catalog model", await js('document.getElementById("next").textContent.includes(ModelProgress.bytes(infoFor("cleanup", document.getElementById("cleanup-builtin-model").value).bytes))'));
    await click("next");
    await waitFor(() => active.get("cleanup:" + alternative), "alternative cleanup did not start");
    await click("back"); await click("back");
    await chooseCleanup(cleanup);
    await click("next"); await click("next");
    await waitFor(() => active.get(cleanupKey), "changed cleanup did not start");
    await click("back"); await click("back");
    await chooseCleanup(alternative);
    await click("next"); await click("next");
    await waitFor(() => active.get("cleanup:" + alternative), "reselected cancelled cleanup did not restart");
    check("renewed consent restarts reselected cleanup without restarting speech", starts.filter((s) => s === "cleanup:" + alternative).length === 2 && starts.filter((s) => s === key).length === 2);
    active.get("cleanup:" + alternative).finish();
    await close();

    // Finish setup retries a failed optional cleanup download in the
    // background (no separate Retry click) and commits once, however often
    // it is clicked.
    await open();
    for (let i = 0; i < 6; i++) await click("next");
    await waitFor(() => active.get(cleanupKey), "cleanup did not start on the final step");
    active.get(cleanupKey).fail();
    await until('transfer("cleanup", document.getElementById("cleanup-builtin-model").value).phase === "failed"', "cleanup failure lost");
    check("a failed optional cleanup says Finish setup retries it", await js('document.getElementById("finish-hint").textContent.includes("Finish setup retries it")'));
    const startsBeforeFinish = starts.length;
    let commits = 0;
    const save = settings.save;
    settings.save = (next) => { commits++; return save(next); };
    try {
      await js('document.getElementById("next").click(); document.getElementById("next").click(); undefined');
      await waitFor(() => win.isDestroyed(), "Finish after a failed cleanup did not close wizard");
    } finally {
      settings.save = save;
    }
    check("Finish setup restarts a failed optional cleanup and saves once",
      starts.slice(startsBeforeFinish).join() === cleanupKey && active.has(cleanupKey) && commits === 1);
    active.get(cleanupKey).finish();
    installed.clear();

    // A transfer begun by Settings is adopted, never cancelled by wizard Skip.
    // Use a real Settings renderer because contextBridge is immutable.
    windows.closeSettings();
    await new Promise((resolve) => setImmediate(resolve));
    const sw = externalSettings = windows.openSettings(); await waitForLoad(sw.webContents);
    await sw.webContents.executeJavaScript('earheart.invoke("models:download", { kind: "stt", modelId: ' + JSON.stringify(speech) + ' }); undefined', true);
    await waitFor(() => active.get(key), "external speech did not start");
    await open();
    await click("skip");
    await waitFor(() => win.isDestroyed(), "Skip did not close wizard");
    check("Skip preserves independently started transfer", active.has(key));
    await waitFor(() => sw.webContents.executeJavaScript('document.activeElement?.closest("#stt-model-manage") !== null', true), "Skip did not focus speech Download");
    check("Skip opens missing speech Download without starting cleanup", !active.has(cleanupKey));
    active.get(key).finish();
  } finally {
    windows.closeSettings();
    if (externalSettings) await waitFor(() => externalSettings.isDestroyed(), "Settings did not close");
    if (win && !win.isDestroyed()) windows.closeWizard();
    pendingAborts.splice(0).forEach((settle) => settle());
    for (const item of active.values()) item.fail();
    await new Promise((resolve) => setImmediate(resolve));
    engines.download = original.download; engines.isInstalled = original.isInstalled;
  }
}
module.exports = { checkWizard };
