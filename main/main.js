// Earheart entry point: app lifecycle, single-instance handling, and wiring
// between the hotkey, tray, windows and the dictation pipeline.

const { app, session } = require("electron");
const settings = require("./settings");
const windows = require("./windows");
const pipeline = require("./pipeline");
const hotkeys = require("./hotkeys");
const tray = require("./tray");
const ipc = require("./ipc");
const engines = require("./engines");
const autostart = require("./autostart");

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
    // Check before anything can write the settings file: no file yet means
    // this is a fresh install and the user gets the setup wizard.
    const firstRun = settings.isFirstRun();
    const cfg = settings.get();

    // Reconcile the OS login item with the saved setting on every launch, so a
    // moved AppImage or an externally-cleared registration self-heals.
    try {
      autostart.apply(cfg.startOnBoot);
    } catch (err) {
      console.warn(`[earheart] could not apply start-on-boot: ${err.message}`);
    }

    // The renderer asks for microphone and clipboard access; grant those.
    // Everything the renderer can reach is our own local files (no remote
    // content), so nothing else needs permissions.
    const GRANTED = new Set(["media", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        callback(GRANTED.has(permission));
      }
    );

    pipeline.init();
    ipc.init({
      applyHotkey,
      onSettingsChanged: () => {
        tray.refresh();
        pipeline.onSettingsChanged();
      },
    });
    windows.createOverlay();
    tray.init(app, pipeline);

    const hotkeyResult = applyHotkey(cfg.hotkey);
    if (!hotkeyResult.ok) {
      console.warn(`[earheart] ${hotkeyResult.error}`);
    }

    if (!startHidden && !isSmokeTest) {
      if (firstRun) {
        windows.openWizard();
      } else {
        windows.openSettings();
      }
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

  // The overlay is closable: false, which blocks app.quit() (it waits for
  // every window to close and the overlay refuses; electron#5891). Destroy
  // it first so quitting from the tray actually exits.
  app.on("before-quit", () => {
    windows.destroyOverlay();
  });

  app.on("will-quit", () => {
    hotkeys.unregisterAll();
    engines.stop();
  });
}
