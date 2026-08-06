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
const updates = require("./updates");
const logger = require("./util/logger");

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
    } else if (argv.includes("--pause")) {
      pipeline.pauseToggle();
    } else {
      windows.openSettings();
    }
  });
  main();
}

// Register both global hotkeys from settings. The record hotkey is required
// (empty is a misconfiguration); the pause hotkey is optional (empty simply
// leaves it unbound). Record registers first so a pause combo colliding with
// it is the one that loses.
function applyHotkeys(cfg) {
  const record = hotkeys.register("record", cfg.hotkey, () => pipeline.toggle());
  const pause = hotkeys.register("pause", cfg.pauseHotkey, () =>
    pipeline.pauseToggle()
  );
  return {
    hotkey: record.empty ? { ok: false, error: "No hotkey configured" } : record,
    pauseHotkey: pause,
  };
}

function main() {
  app.whenReady().then(() => {
    // Open the log file and start capturing uncaught errors before anything
    // else can fail.
    logger.init();

    // Check before anything can write the settings file: no file yet means
    // this is a fresh install and the user gets the setup wizard.
    const firstRun = settings.isFirstRun();
    const cfg = settings.get();

    // Reconcile the OS login item with the saved setting on every launch, so a
    // moved AppImage or an externally-cleared registration self-heals.
    try {
      autostart.apply(cfg.startOnBoot);
    } catch (err) {
      logger.warn(`could not apply start-on-boot: ${err.message}`);
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
      applyHotkeys,
      onSettingsChanged: () => {
        tray.refresh();
        pipeline.onSettingsChanged();
        updates.onSettingsChanged();
      },
    });
    windows.createOverlay();
    tray.init(app, pipeline);
    if (!isSmokeTest) {
      updates.init({ onStateChange: () => tray.refresh() });
    }

    const hotkeyResults = applyHotkeys(cfg);
    if (!hotkeyResults.hotkey.ok) {
      logger.warn(hotkeyResults.hotkey.error);
    }
    if (!hotkeyResults.pauseHotkey.ok) {
      logger.warn(hotkeyResults.pauseHotkey.error);
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
    // Quitting mid-review must not lose the words: park them in history.
    pipeline.flushReview();
    windows.destroyOverlay();
  });

  app.on("will-quit", () => {
    hotkeys.unregisterAll();
    engines.stop();
    updates.dispose();
  });
}
