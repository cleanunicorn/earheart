// Earheart entry point: app lifecycle, single-instance handling, and wiring
// between the hotkey, tray, windows and the dictation pipeline.

const { app, session, Notification } = require("electron");
const settings = require("./settings");
const history = require("./history");
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
const { bindCustomModels } = require("./engines/catalog");
const { createNotifier, announceStartup } = require("./setup-notices");
const { installPermissionHandler } = require("./window-guard");

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
    } else if (argv.includes("--discard")) {
      pipeline.discard();
    } else if (argv.includes("--retry")) {
      pipeline.retryFailedTake();
    } else if (argv.includes("--correct-last")) {
      openLastCorrection();
    } else {
      windows.openSettings();
    }
  });
  main();
}

// The result of the last applyHotkeys() call — launch, save, or a save's
// rollback — kept so Settings can show it when it opens (settings:get).
let lastHotkeyStatus = null;

function openLastCorrection() {
  // A focusable editor must never steal the pending dictation's paste target.
  if (pipeline.getState() === "idle") windows.openCorrection(history.list()[0]);
}

// Register the global hotkeys from settings. The record hotkey is required
// (empty is a misconfiguration); the pause and discard hotkeys are optional
// (empty simply leaves them unbound). Discard is only held while a dictation
// is live — see the armDiscard wiring in main().
function applyHotkeys(cfg) {
  const slots = hotkeys.applyAll({
    record: cfg.hotkey,
    pause: cfg.pauseHotkey,
    discard: cfg.discardHotkey,
    correct: cfg.correctHotkey,
    onCorrect: openLastCorrection,
    onRecord: () => pipeline.toggle(),
    onPause: () => pipeline.pauseToggle(),
    onDiscard: () => pipeline.discard(),
  });
  lastHotkeyStatus = hotkeys.toHotkeyResults(slots, cfg);
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
    // Custom models resolve from here on, for every caller, and follow every
    // later save (engines/catalog.js).
    bindCustomModels(settings);

    // Reconcile the OS login item with the saved setting on every launch, so a
    // moved AppImage or an externally-cleared registration self-heals.
    try {
      autostart.apply(cfg.startOnBoot);
    } catch (err) {
      logger.warn(`could not apply start-on-boot: ${err.message}`);
    }

    // The renderer asks for microphone and clipboard access; grant those to
    // the app's own pages and nothing else (main/window-guard.js).
    installPermissionHandler(session.defaultSession);

    windows.init();
    pipeline.init({ isDownloading: ipc.isDownloading });
    // The discard hotkey is held only while there is a dictation to discard
    // (recording or processing); idle, the combination is the user's again.
    pipeline.onStateChange((state) => hotkeys.armDiscard(state !== "idle"));
    ipc.init({
      onCleanupDownloaded: pipeline.onCleanupDownloaded,
      onHistoryCleared: pipeline.clearUndelivered,
      applyHotkeys,
      canCorrect: () => pipeline.getState() === "idle",
      canCopy: () => pipeline.getState() !== "processing",
      // A binding another app took during capture is re-applied from the
      // saved settings, so the status Settings shows names the failure.
      suspendHotkeys: (on) => {
        if (hotkeys.suspend(on).length) applyHotkeys(settings.get());
      },
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
        updates.init({
          onStateChange: () => tray.refresh(),
          // Ask about an uncopied correction before the installer starts, not
          // in before-quit, which could only cancel after it is running. A
          // confirmed editor closes at once, so quitting cannot ask again.
          confirmInstall: () => {
            if (!windows.confirmCorrectionClose()) return false;
            windows.closeCorrection();
            return true;
          },
        });
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
    if (!hotkeyResults.discardHotkey.ok) {
      logger.warn(hotkeyResults.discardHotkey.error);
    }

    if (hotkeyResults.correctHotkey && !hotkeyResults.correctHotkey.ok) {
      logger.warn(hotkeyResults.correctHotkey.error);
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
  app.on("before-quit", (event) => {
    if (!windows.confirmCorrectionClose()) {
      event.preventDefault();
      return;
    }
    windows.destroyOverlay();
  });

  app.on("will-quit", () => {
    hotkeys.unregisterAll();
    engines.stop();
    updates.dispose();
  });
}
