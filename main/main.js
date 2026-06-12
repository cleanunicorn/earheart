// Earheart entry point: app lifecycle, single-instance handling, and wiring
// between the hotkey, tray, windows and the dictation pipeline.

const { app, session } = require("electron");
const settings = require("./settings");
const windows = require("./windows");
const pipeline = require("./pipeline");
const hotkeys = require("./hotkeys");
const tray = require("./tray");
const ipc = require("./ipc");
const serverManager = require("./services/server-manager");

const isSmokeTest = process.argv.includes("--smoke-test");
const startHidden = process.argv.includes("--hidden");

// Single instance: a second `earheart --toggle` invocation forwards the
// toggle to the running app and exits. This is the recommended way to bind a
// dictation key on Wayland desktops where global shortcuts are blocked: add a
// system keyboard shortcut that runs `earheart --toggle`.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
} else {
  app.on("second-instance", (event, argv) => {
    if (argv.includes("--toggle")) {
      pipeline.toggle();
    } else {
      windows.openSettings();
    }
  });
  main();
}

function applyHotkey(accelerator) {
  return hotkeys.register(accelerator, () => pipeline.toggle());
}

function main() {
  app.whenReady().then(() => {
    const cfg = settings.get();

    // The renderer asks for microphone access; grant it. Everything the
    // renderer can reach is our own local files (no remote content).
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(permission === "media");
      }
    );

    pipeline.init();
    ipc.init({ applyHotkey, onSettingsChanged: () => tray.refresh() });
    windows.createOverlay();
    tray.init(app, pipeline);
    serverManager.start(cfg.sttServer);

    const hotkeyResult = applyHotkey(cfg.hotkey);
    if (!hotkeyResult.ok) {
      console.warn(`[earheart] ${hotkeyResult.error}`);
    }

    if (!startHidden && !isSmokeTest) {
      windows.openSettings();
    }

    if (isSmokeTest) {
      // CI/dev sanity check: boot everything, then exit cleanly.
      setTimeout(() => {
        console.log("[earheart] smoke test OK");
        app.quit();
      }, 1500);
    }
  });

  // Tray app: stay alive when all windows are closed.
  app.on("window-all-closed", () => {});

  app.on("will-quit", () => {
    hotkeys.unregisterAll();
    serverManager.stop();
  });
}
