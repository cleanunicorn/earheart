// Regenerate the README screenshots in docs/screenshots/ from the real
// windows, staged headlessly. Run with:
//
//   make screenshots
//
// (or: xvfb-run -a npx electron scripts/screenshots.js --no-sandbox)

const { app, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { isolateProfile, assertIsolated } = require("./demo-profile");

// A throwaway demo profile, set before anything below can read userData or
// logs (settings, history, models and the logger all resolve them from the
// app), so the shots never show — or migrate — the contributor's own profile
// (#295). Removed after the process exits, whichever way it exits: Chromium
// writes into it while shutting down.
const profile = isolateProfile(app);

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const windows = require(path.join(ROOT, "main", "windows.js"));
const ipc = require(path.join(ROOT, "main", "ipc.js"));
const { waitForLoad } = require("./wait-for-load");
const { installPermissionHandler } = require(path.join(ROOT, "main", "window-guard.js"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log(`captured ${name}.png`);
}

async function main() {
  assertIsolated(app, profile);
  fs.mkdirSync(OUT, { recursive: true });
  // The shipped permission policy, so the microphone grant below is proven
  // through the same handler the app installs (main/window-guard.js).
  installPermissionHandler(session.defaultSession);
  // Start on boot reads and writes the OS login item, not the profile: show
  // the demo's value, and never touch the real entry.
  const autostart = require(path.join(ROOT, "main", "autostart.js"));
  autostart.isEnabled = () => false;
  autostart.apply = () => {};
  // As main.js wires them: the overlay's resize (the update card grows the
  // window) and custom models from the settings.
  windows.init();
  require(path.join(ROOT, "main", "engines", "catalog.js")).bindCustomModels(require(path.join(ROOT, "main", "settings.js")));
  ipc.init({
    applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
    onSettingsChanged: () => {},
  });

  // Setup wizard, welcome step (the demo animation needs a beat to settle).
  const wizard = windows.openWizard();
  await waitForLoad(wizard.webContents);
  await sleep(1800);
  await shot(wizard, "wizard");
  windows.closeWizard();

  // Settings window, General section (the default view).
  const settings = windows.openSettings();
  await waitForLoad(settings.webContents);
  await sleep(1200);
  await shot(settings, "settings");
  settings.close();

  // Correction: synthetic transcript, no dictionary/history writes.
  const correction = windows.openCorrection({ text: "Run cube cuddle against staging, then check the logs.\nKeep src/Foo.ts unchanged and add a test for the error path." });
  await waitForLoad(correction.webContents);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await correction.webContents.executeJavaScript('!document.getElementById("copy").disabled')) break;
    if (attempt === 99) throw new Error("correction editor did not initialize");
    await sleep(50);
  }
  await correction.webContents.executeJavaScript(`
    document.getElementById("transcript").focus();
    document.getElementById("transcript").setSelectionRange(4, 15);
    document.getElementById("transcript").dispatchEvent(new Event("select"));
    document.getElementById("spelling").value = "kubectl";
    document.getElementById("spelling").dispatchEvent(new Event("input"));
    document.getElementById("spelling").focus();
    "";
  `);
  await correction.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  await shot(correction, "correction");
  windows.setCorrectionDirty(correction.webContents, false); // discard this synthetic staged draft
  correction.close();

  // Overlay: staged recording and done states. setStatus/waveHistory/
  // drawMeter/timerEl are top-level bindings in overlay.js, reachable from
  // executeJavaScript.
  const overlay = windows.createOverlay();
  await waitForLoad(overlay.webContents);
  windows.showOverlay();
  await sleep(800);

  await overlay.webContents.executeJavaScript(`
    // Stage a written waveform: a speech-like burst pattern, newest at the
    // right edge. 120 columns × 2.5px overruns the area, so it shows the
    // filled-edge-to-edge state a take reaches after ~7s.
    waveHistory = Array.from({ length: 120 }, (_, i) =>
      0.02 + 0.13 * Math.abs(Math.sin(i * 0.7 + 1)) * (0.4 + ((i * 7919) % 13) / 13)
    );
    drawMeter();
    timerEl.textContent = "0:07";
    setStatus("recording", "Listening…");
    // The live transcript mid-dictation: settled cleaned text plus the dimmed
    // still-streaming raw tail (the README's hero moment).
    partialClean = "In the auth middleware, don't retry on a 401.";
    partialRaw =
      "in the auth middleware don't retry on a 401 just surface the error and add a test";
    renderTranscript();
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-recording");

  await overlay.webContents.executeJavaScript(`
    clearTranscript();
    setStatus(
      "recording",
      "Listening…",
      "Saved mic missing — using system default"
    );
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-microphone-fallback");

  // Paused mid-take: everything holds — held pause key showing the resume
  // glyph, steady hollow status ring, frozen waveform.
  await overlay.webContents.executeJavaScript(`
    setStatus("paused", "Paused", "Press play to resume");
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-paused");

  await overlay.webContents.executeJavaScript(`
    setStatus("recording", "Listening…");
    "";
  `);

  // Processing state with the dictation progress fill mid-run (the README's
  // middle hero shot). The transcript retires when processing starts, like the real
  // pipeline does.
  await overlay.webContents.executeJavaScript(`
    clearTranscript();
    setStatus("cleaning", "Cleaning up…");
    progressEl.hidden = false;
    progressFill.style.width = "62%";
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-processing");

  await overlay.webContents.executeJavaScript(`
    setStatus("done", "Pasted", "In the auth middleware, don't retry on a 401. Surface the error and add a test.");
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-done");

  // The update prompt, in both the shapes the user meets it in: attached under
  // a dictation that has just finished (main only ever raises it there, never
  // mid-sentence), and on its own shortly after launch.
  const update = {
    version: "0.19.0",
    current: "0.18.1",
    method: "install",
    status: "available",
    progress: null,
    error: null,
  };
  overlay.webContents.send("updates:prompt", { ...update, solo: false });
  await sleep(400);
  await shot(overlay, "overlay-update");

  overlay.webContents.send("updates:prompt", { ...update, solo: true });
  await sleep(400);
  await shot(overlay, "overlay-update-solo");

  app.exit(0);
}

// Any failure exits non-zero with the error; without this an unhandled
// rejection left Electron running and `make screenshots` hung instead of
// failing.
app.whenReady().then(main).catch((err) => {
  console.error("[screenshots] failed:", (err && err.stack) || err);
  app.exit(1);
});
