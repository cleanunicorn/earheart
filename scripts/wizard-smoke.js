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
    signal.addEventListener("abort", () => { aborts.push(key); active.delete(key); reject(new Error("aborted")); }, { once: true });
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const open = async () => {
    win = windows.openWizard(); await waitForLoad(win.webContents);
    await waitFor(() => js('!!modelStatus && !!current'), "wizard failed to initialize");
  };
  const close = async () => { windows.closeWizard(); await waitFor(() => win.isDestroyed(), "wizard did not close"); };
  const click = (id) => js('document.getElementById(' + JSON.stringify(id) + ').click(); undefined');
  const until = (expression, message) => waitFor(() => js(expression), message);
  const key = "stt:" + speech;
  const cleanupKey = "cleanup:" + cleanup;
  try {
    await open();
    await click("next"); await click("next"); await click("next");
    check("wizard does not download before explicit speech consent", starts.length === 0);
    check("speech consent shows catalog size", await js('document.getElementById("next").textContent.includes("GB")'));
    await click("next");
    await waitFor(() => active.get(key), "speech did not start after consent");
    check("Customize starts collapsed", await js('!document.getElementById("cleanup-customize").open'));
    active.get(key).progress({ received: 1e9, total: engines.registry.totalBytes(engines.registry.getModel("stt", speech)), fraction: 0.4 });
    await click("next"); await click("next");
    check("cleanup waits behind speech", starts.length === 1);
    check("early speech bytes reach combined total", await until('document.getElementById("download-total").textContent.startsWith("1.0 GB of")', "early progress lost"));
    check("Finish waits for speech", await js('document.getElementById("next").disabled'));
    await click("back"); await click("back"); await click("next"); await click("next");
    check("Back and Next retain the speech transfer", starts.length === 1 && aborts.length === 0);
    active.get(key).finish();
    await waitFor(() => active.get(cleanupKey), "cleanup did not start after speech");
    check("Finish enables while optional cleanup downloads", await until('!document.getElementById("next").disabled', "Finish blocked by cleanup"));
    check("Finish teaches actual hotkey", await js('document.getElementById("finish-hint").textContent.includes(current.hotkey)'));
    const cleanupBytes = engines.registry.totalBytes(engines.registry.getModel("cleanup", cleanup));
    active.get(cleanupKey).progress({ received: cleanupBytes / 4, total: cleanupBytes, fraction: 0.25 });
    await click("next");
    await waitFor(() => win.isDestroyed(), "Finish did not close wizard");
    check("closing wizard retains optional transfer", active.has(cleanupKey));
    const handoff = externalSettings = windows.openSettings();
    const form = (code) => handoff.webContents.executeJavaScript(code, true);
    await waitFor(() => form('typeof formReady !== "undefined" && formReady && !document.getElementById("wizard-banner").hidden'), "saved banner did not initialize");
    check("saved banner teaches committed hotkey without asking to save again", await form('document.getElementById("wizard-saved-message").textContent.includes(savedSetup.hotkey) && document.getElementById("wizard-saved-message").textContent.includes("saved")'));
    check("saved banner hydrates background progress before another tick", await form('document.getElementById("wizard-cleanup-progress").textContent.includes("25%")'));
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
    await click("download-later");
    await until('transfer("stt", current.stt.builtin.model).phase === "skipped"', "skip not retained");
    check("Download later preserves unavailable speech and optional cleanup explanations after cancellation", await js('document.getElementById("download-list").textContent.includes("dictation won\'t work") && document.getElementById("download-list").textContent.includes("optional") && !document.getElementById("download-list").textContent.includes("Cancelled")'));
    check("Download later disarms queued cleanup", !active.has(cleanupKey) && starts.every((s) => s === key));
    await close();

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
    for (const item of active.values()) item.fail();
    await new Promise((resolve) => setImmediate(resolve));
    engines.download = original.download; engines.isInstalled = original.isInstalled;
  }
}
module.exports = { checkWizard };
