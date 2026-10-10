// Earheart entry point: app lifecycle, single-instance handling, and wiring
// between the hotkey, tray, windows and the dictation pipeline.

const { app, session, Notification } = require("electron");
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
const deliver = require("./output/deliver");
const { createHost, LOADCHECK_TIMEOUT_MS } = require("./engines/host");
const { createNotifier, announceStartup } = require("./setup-notices");

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

// The result of the last applyHotkeys() call — launch, save, or a save's
// rollback — kept so Settings can show it when it opens (settings:get).
let lastHotkeyStatus = null;

// Register both global hotkeys from settings as one transaction. The record
// hotkey is required (empty is a misconfiguration); the pause hotkey is
// optional (empty simply leaves it unbound).
function applyHotkeys(cfg) {
  const pair = hotkeys.applyPair({
    record: cfg.hotkey,
    pause: cfg.pauseHotkey,
    onRecord: () => pipeline.toggle(),
    onPause: () => pipeline.pauseToggle(),
  });
  lastHotkeyStatus = hotkeys.toHotkeyResults(pair, cfg);
  return lastHotkeyStatus;
}

// Startup notices; clicking one opens Settings (see setup-notices.js).
const notifier = createNotifier({
  Notification,
  openSettings: () => windows.openSettings(),
  logger,
});

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
      // The tray rebuilds itself on every settings save (main/ipc.js).
      getHotkeyStatus: () => lastHotkeyStatus,
      onSettingsChanged: () => {
        pipeline.onSettingsChanged();
        updates.onSettingsChanged();
      },
    });
    windows.createOverlay({ onOverlayRendererGone: pipeline.onOverlayRendererGone });
    tray.init(app, pipeline);
    // macOS: an update leaves auto-paste's permission grants stale; repair
    // them before the first dictation rather than during it.
    if (
      deliver.shouldRepairAtStartup({
        smokeTest: isSmokeTest,
        firstRun,
        hidden: startHidden,
        mode: cfg.output.mode,
      })
    ) {
      deliver.repairPastePermissions().catch((err) => logger.warn("permission repair failed:", err));
    }
    if (!isSmokeTest) {
      // Updates are optional; the hotkeys below are not. A throw here must
      // never leave the app running with no way to dictate.
      try {
        updates.init({ onStateChange: () => tray.refresh() });
      } catch (err) {
        logger.warn(`update check setup failed: ${err.message}`);
      }
    }

    const hotkeyResults = applyHotkeys(cfg);
    if (!hotkeyResults.hotkey.ok) {
      logger.warn(hotkeyResults.hotkey.error);
    }
    if (!hotkeyResults.pauseHotkey.ok) {
      logger.warn(hotkeyResults.pauseHotkey.error);
    }

    // A returning user lands straight in the tray with a "ready" notice — or,
    // when the record hotkey didn't register or the speech model isn't
    // downloaded, a notice (or Settings) saying what to fix, so they find out
    // before they speak. --hidden (autostart at login) stays silent when
    // healthy. See announceStartup for the full order.
    announceStartup({
      cfg,
      hidden: startHidden,
      smokeTest: isSmokeTest,
      firstRun,
      hotkeyStatus: hotkeyResults,
      sttReadiness: engines.getSttReadiness(cfg.stt),
      openWizard: () => windows.openWizard(),
      openSettings: () => windows.openSettings(),
      notify: notifier.show,
    });

    if (isSmokeTest) {
      // CI/dev sanity check: boot everything, then exit cleanly.
      setTimeout(async () => {
        // --engine-check: also load both native addons in an engine worker of
        // *this* process. Release CI runs it on the signed bundle, where the
        // hardened runtime's library validation decides whether they load —
        // something scripts/engine-smoke.js under the dev Electron can't see.
        if (process.argv.includes("--engine-check")) {
          const host = createHost({ serviceName: "earheart-engine-check" });
          try {
            const engines = await host.request("loadcheck", {}, { timeoutMs: LOADCHECK_TIMEOUT_MS });
            if (engines?.stt !== true || engines?.cleanup !== true) {
              throw new Error(`native addon load failed: ${JSON.stringify(engines)}`);
            }
            console.log("[earheart] engine check OK (stt + cleanup)");
          } catch (err) {
            console.error("[earheart] engine check failed:", err?.message ?? err);
            host.stop();
            app.exit(1);
            return;
          }
          host.stop();
        }
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
    updates.dispose();
  });
}
