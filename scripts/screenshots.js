// Regenerate the README screenshots in docs/screenshots/ from the real
// windows, staged headlessly. Run with:
//
//   make screenshots
//
// (or: xvfb-run -a npx electron scripts/screenshots.js --no-sandbox)

const { app, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const windows = require(path.join(ROOT, "main", "windows.js"));
const ipc = require(path.join(ROOT, "main", "ipc.js"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  console.log(`captured ${name}.png`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(true)
  );
  ipc.init({ applyHotkey: () => ({ ok: true }), onSettingsChanged: () => {} });

  // Setup wizard, welcome step (the demo animation needs a beat to settle).
  const wizard = windows.openWizard();
  await new Promise((r) => wizard.webContents.once("did-finish-load", r));
  await sleep(1800);
  await shot(wizard, "wizard");
  windows.closeWizard();

  // Settings window, General tab.
  const settings = windows.openSettings();
  await new Promise((r) => settings.webContents.once("did-finish-load", r));
  await sleep(1200);
  await shot(settings, "settings");
  settings.close();

  // Overlay pill: staged recording and done states. setStatus/levels/
  // drawMeter/timerEl are top-level bindings in overlay.js, reachable from
  // executeJavaScript.
  const overlay = windows.createOverlay();
  await new Promise((r) => overlay.webContents.once("did-finish-load", r));
  windows.showOverlay();
  await sleep(800);

  await overlay.webContents.executeJavaScript(`
    levels = levels.map((_, i) =>
      0.02 + 0.13 * Math.abs(Math.sin(i * 0.7 + 1)) * (0.4 + ((i * 7919) % 13) / 13)
    );
    drawMeter();
    timerEl.textContent = "0:07";
    setStatus("recording", "Listening…");
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-recording");

  // Processing state with the determinate progress bar mid-fill (the README's
  // middle hero shot).
  await overlay.webContents.executeJavaScript(`
    setStatus("cleaning", "Cleaning up…");
    progressEl.hidden = false;
    progressFill.style.width = "62%";
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-processing");

  await overlay.webContents.executeJavaScript(`
    setStatus("done", "Pasted", "Let's meet tomorrow at ten to review the draft.");
    "";
  `);
  await sleep(400);
  await shot(overlay, "overlay-done");

  app.exit(0);
});
