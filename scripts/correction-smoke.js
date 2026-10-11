// Runs inside settings-smoke's real Electron app and throwaway profile.
const assert = require("node:assert/strict");
const { clipboard } = require("electron");
const windows = require("../main/windows");
const settings = require("../main/settings");
const history = require("../main/history");
const { waitForLoad } = require("./wait-for-load");

async function checkCorrection({ waitFor, check }) {
  const original = "Run cube cuddle, then check cube cuddle.\nKeep src/Foo.ts and 🚀 unchanged.";
  history.add({ text: original, raw: original, cleaned: false }, { enabled: true, limit: 100 });
  const form = windows.openSettings();
  await waitForLoad(form.webContents);
  const formRun = (code) => form.webContents.executeJavaScript(code, true);
  await waitFor(() => formRun('!!document.getElementById("cleanup-dictionary").value || document.getElementById("version").textContent.startsWith("v")'), "Settings did not initialize");
  await formRun(`document.querySelector('[data-tab="history"]').click()`);
  await waitFor(() => formRun(`Array.from(document.querySelectorAll('#history-list button')).some(b => b.textContent === 'Correct…')`), "history correction action missing");
  await formRun('document.getElementById("cleanup-dictionary").value = "localDraft"');
  await formRun(`Array.from(document.querySelectorAll('#history-list button')).find(b => b.textContent === 'Correct…').click()`);
  // The real history action has already created it; a repeated open must keep it.
  const win = windows.openCorrection(history.list()[0]);
  if (win.webContents.isLoadingMainFrame()) await waitForLoad(win.webContents);
  const run = (code) => win.webContents.executeJavaScript(code, true);
  await waitFor(() => run('!document.getElementById("copy").disabled'), "correction did not initialize");
  check("correction shows the full original transcript", await run('document.getElementById("transcript").value') === original);
  // Select with real keyboard input, then tab into the replacement field.
  await run('document.getElementById("transcript").focus(); document.getElementById("transcript").setSelectionRange(4, 4)');
  for (let i = 0; i < "cube cuddle".length; i++) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right", modifiers: ["shift"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right", modifiers: ["shift"] });
  }
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await waitFor(() => run('document.activeElement.id === "spelling"'), "Tab did not reach spelling");
  await run('document.getElementById("spelling").select()');
  await win.webContents.insertText("kubectl");
  clipboard.writeText("untouched clipboard");
  await run('document.getElementById("copy").click()');
  check("copy refuses an unapplied spelling without changing the clipboard", !win.isDestroyed() && clipboard.readText() === "untouched clipboard" && await run('document.getElementById("status").textContent.includes("Apply your spelling")'));
  await run('document.getElementById("remember").click()');
  await waitFor(() => run('document.getElementById("status").textContent.includes("remembered")'), "remember did not finish");
  const corrected = original.replace("cube cuddle", "kubectl");
  check("keyboard selection replaces exactly one occurrence and preserves Unicode", await run('document.getElementById("transcript").value') === corrected);
  check("remember saves the exact spelling", settings.get().cleanup.dictionary.includes("kubectl"));
  check("correction preserves original history", history.list()[0].text === original && history.list()[0].raw === original);
  await waitFor(() => formRun('document.getElementById("cleanup-dictionary").value.includes("kubectl")'), "Settings did not receive remembered word");
  check("remember preserves unsaved dictionary edits in Settings", await formRun('document.getElementById("cleanup-dictionary").value.includes("localDraft")'));
  windows.openCorrection({ text: "a newer dictation" });
  check("reopening does not replace an active correction draft", await run('document.getElementById("transcript").value') === corrected);

  // Capture the actual new UI when explicitly requested, never user data.
  if (process.env.EARHEART_CORRECTION_SCREENSHOT) {
    const image = await win.webContents.capturePage();
    require("node:fs").writeFileSync(process.env.EARHEART_CORRECTION_SCREENSHOT, image.toPNG());
  }

  // A persistence error must be visible and leave selection/draft usable.
  await run(`(() => { const t = document.getElementById("transcript"); t.focus(); t.setSelectionRange(4, 11); t.dispatchEvent(new Event("select")); document.getElementById("spelling").value = "other"; document.getElementById("spelling").dispatchEvent(new Event("input")); })()`);
  const save = settings.save;
  settings.save = () => { throw new Error("simulated disk failure"); };
  try {
    await run('document.getElementById("remember").click()');
    await waitFor(() => run('document.getElementById("status").textContent.includes("simulated disk failure")'), "save failure missing");
    check("save failure retains draft and does not learn a spelling", await run('document.getElementById("transcript").value') === corrected && !settings.get().cleanup.dictionary.includes("other"));
  } finally { settings.save = save; }
  await run('document.getElementById("transcript").focus(); document.getElementById("transcript").setSelectionRange(0, 0); document.getElementById("transcript").dispatchEvent(new Event("select"))');
  const write = clipboard.writeText;
  clipboard.writeText = () => { throw new Error("simulated clipboard failure"); };
  try {
    await run('document.getElementById("copy").click()');
    await waitFor(() => run('document.getElementById("status").textContent.includes("Could not copy")'), "copy failure missing");
    check("clipboard failure keeps the editor and draft", !win.isDestroyed() && await run('document.getElementById("transcript").value') === corrected);
  } finally { clipboard.writeText = write; }
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
  await waitFor(() => win.isDestroyed(), "copy shortcut did not close editor");
  check("copy shortcut writes the entire corrected prompt", clipboard.readText() === corrected);
  await formRun('document.getElementById("save").click()');
  await waitFor(() => form.isDestroyed(), "Settings save did not close");
  check("Settings save retains both remembered words and unsaved edits", settings.get().cleanup.dictionary.includes("kubectl") && settings.get().cleanup.dictionary.includes("localDraft"));
  const cfg = settings.get();
  settings.save({ ...cfg, cleanup: { ...cfg.cleanup, enabled: false } });
  const empty = windows.openCorrection();
  await waitForLoad(empty.webContents);
  await waitFor(() => empty.webContents.executeJavaScript('document.getElementById("status").textContent.includes("No saved transcript")'), "empty state missing");
  check("empty history disables copying and explains cleanup off", await empty.webContents.executeJavaScript('document.getElementById("copy").disabled && document.getElementById("dictionary-note").textContent.includes("Cleanup is off")'));
  empty.close();
  assert.equal(history.list()[0].text, original);
}
module.exports = { checkCorrection };
