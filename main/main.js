// Earheart entry point: app lifecycle, single-instance handling, and wiring
// between the hotkey, tray, windows and the dictation pipeline.

const path = require("node:path");
const { app, session, Notification, powerMonitor, ipcMain, dialog, clipboard, safeStorage } = require("electron");
const settings = require("./settings");
const history = require("./history");
const recordings = require("./recordings");
const windows = require("./windows");
const wake = require("./wake");
const appearance = require("./appearance");
const i18n = require("./i18n");
const pipeline = require("./pipeline");
const commands = require("./commands");
const usage = require("./usage");
const hotkeys = require("./hotkeys");
const tray = require("./tray");
const ipc = require("./ipc");
const engines = require("./engines");
const autostart = require("./autostart");
const updates = require("./updates");
const ducking = require("./ducking");
const tools = require("./tools");
const micProbe = require("./mic-probe");
const logger = require("./util/logger");
const deliver = require("./output/deliver");
const { createHost, LOADCHECK_TIMEOUT_MS } = require("./engines/host");
const { bindCustomModels } = require("./engines/catalog");
const { createNotifier, announceStartup, announcePromptOffer } = require("./setup-notices");
const { installPermissionHandler } = require("./window-guard");
const { createAgentApi } = require("./agent-api");
const { createTaskStore } = require("./agent-tasks");
const agents = require("./agents");
const agentCommon = require("./agents/common");

const isSmokeTest = process.argv.includes("--smoke-test");
let palette = null;
const startHidden = process.argv.includes("--hidden");
const startPalette = process.argv.includes("--palette");

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
    } else if (argv.includes("--palette")) {
      palette?.open();
    } else if (argv.includes("--command")) {
      // A voice command (#344) for desktops where global hotkeys are blocked.
      commands.begin();
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
let toolsStopped = false;

function openLastCorrection() {
  // A focusable editor must never steal the pending dictation's paste target.
  if (pipeline.isPaletteIdle()) tray.correctLast();
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
    palette: cfg.paletteHotkey,
    onPalette: () => palette?.open(),
    onCorrect: openLastCorrection,
    onRecord: () => pipeline.toggle(),
    onPause: () => pipeline.pauseToggle(),
    onDiscard: () => pipeline.discard(),
  });
  lastHotkeyStatus = hotkeys.toHotkeyResults(slots, cfg);
  return lastHotkeyStatus;
}

// Enter-to-stop (#338): Enter is held only while the preference is on, the
// state is recording and the microphone is really capturing (so never before
// it is ready, and released while paused). The grab releases itself before
// the stop fires.
let capturing = false;
let enterSpent = false; // this take's Enter was used; stays released until capture ends
function syncEnterToStop() {
  const recording = capturing && pipeline.getState() === "recording";
  if (!recording) enterSpent = false;
  const want = !!settings.get().enterToStop && recording && !enterSpent;
  hotkeys.armEnter(want, () => {
    enterSpent = true;
    pipeline.stopFromEnter();
  });
}

// Startup notices; clicking one opens Settings (see setup-notices.js).
const notifier = createNotifier({
  Notification,
  openSettings: () => windows.openSettings(),
  logger,
});

// Commands guidance must never bring a focusable window forward, including
// when the notification service is unavailable or a stale notice is clicked.
const commandsNotifier = createNotifier({
  Notification,
  openSettings: () => {},
  logger,
  settingsWhenUnsupported: false,
});

// The new-default-prompt notice opens Settings at the offer. Not news worth a
// Settings window on its own when notifications are unavailable: the offer
// waits in Settings → Cleanup either way.
const promptNotifier = createNotifier({
  Notification,
  openSettings: () => windows.openSettings({ section: "cleanup" }),
  logger,
  settingsWhenUnsupported: false,
});

// Send to agents (#345). Nothing here runs until the setting is on and the
// user uses it: the store, the detection and every process are created lazily.
const agentApi = createAgentApi({
  getSettings: () => settings.get(),
  detectAll: (binaries) => agents.detectAll(binaries),
  validateProject: agentCommon.validateProject,
  copyText: (text) => clipboard.writeText(text),
  pickFolder: async () => {
    const result = await dialog.showOpenDialog({ title: "Choose the project folder", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  },
  createStore: ({ getConfig }) =>
    createTaskStore({
      file: path.join(app.getPath("userData"), "agent-tasks.json"),
      adapters: agents.ADAPTERS,
      resolveBinary: (adapter) => agentCommon.resolveBinary(adapter.binary, getConfig().binaries[adapter.id] || ""),
      getPermission: () => getConfig().permission,
      logger,
      onChange: () => windows.sendToSettings("agent:changed"),
      onFinished: (task) => {
        windows.sendToSettings("agent:changed");
        if (task.status === "cancelled" || !Notification.isSupported()) return;
        // Names the agent and project only: the brief and its output stay in the app.
        const note = new Notification({
          title: `${task.agentLabel} ${task.status === "completed" ? "finished" : "stopped"}`,
          body: `${path.basename(task.project)} — open Earheart to see the result.`,
        });
        note.on("click", () => windows.openSettings({ section: "history" }));
        note.show();
      },
    }),
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

    // The palette before the first window, so nothing paints in the wrong one.
    appearance.init();
    // The UI language, resolved from the saved choice and the OS language
    // list, before anything app-authored (tray, titles, notices) is shown.
    i18n.bind({
      settings,
      systemLanguages: () => i18n.systemLanguagesOf(app),
    });
    windows.init();
    pipeline.init({ isDownloading: ipc.isDownloading });
    commands.init({ pipeline });
    usage.init();
    // The discard hotkey is held only while there is a dictation to discard
    // (recording or processing); idle, the combination is the user's again.
    pipeline.onStateChange((state) => {
      hotkeys.armDiscard(state !== "idle");
      syncEnterToStop();
    });
    // Lower other apps' playback while the microphone is capturing (opt-in);
    // settles a lowering a crash left behind first.
    ducking.init();
    // Which inputs are Bluetooth/virtual (#339), cached; never blocks a take.
    micProbe.init(ipcMain);
    pipeline.onCaptureChange((live) => {
      ducking.setCapturing("dictation", live);
      capturing = live;
      syncEnterToStop();
    });
    // Optional local MCP tool servers (#346). Nothing is started here: servers
    // run only on an explicit Discover or a call, and no part of the app calls
    // tools from voice until command mode (#344) uses tools.host.
    tools.init({
      ipcMain,
      app,
      safeStorage,
      secretStorageSecure: () => settings.keyStorage().secure,
      windows,
      logger,
    });
    ipc.init({
      onCleanupDownloaded: pipeline.onCleanupDownloaded,
      onHistoryCleared: () => pipeline.clearUndelivered(),
      onHistoryEntryDeleted: (id) => pipeline.clearUndelivered(id),
      retranscribe: (id) => pipeline.retranscribe(id),
      agentApi,
      applyHotkeys,
      canCorrect: () => pipeline.getState() === "idle",
      canCopy: () => pipeline.getState() !== "processing",
      // A binding another app took during capture is re-applied from the
      // saved settings, so the status Settings shows names the failure.
      suspendHotkeys: (on) => {
        if (hotkeys.suspend(on).length) applyHotkeys(settings.get());
        commands.suspend(on);
      },
      getCommandCapabilities: commands.capabilities,
      // The tray rebuilds itself on every settings save (main/ipc.js).
      getHotkeyStatus: () => (lastHotkeyStatus ? { ...lastHotkeyStatus, commandsHotkey: commands.getHotkeyStatus() } : lastHotkeyStatus),
      onSettingsChanged: () => {
        pipeline.onSettingsChanged();
        updates.onSettingsChanged();
        // New limits apply at once (#343), and History redraws so a
        // recording they removed (even one playing) leaves the page.
        if (recordings.prune(settings.get()).length) windows.sendToSettings("history:changed", { updated: true });
        ducking.refresh();
        syncEnterToStop();
        return { commandsHotkey: commands.applyHotkey(settings.get().commands?.hotkey) };
      },
    });
    // Kept recordings (#343) past their limits, or whose History entry is
    // gone, are deleted now and hourly — whether or not keeping is still on.
    recordings.startPruning(settings.get, () => windows.sendToSettings("history:changed", { updated: true }));
    windows.createOverlay({ onOverlayRendererGone: pipeline.onOverlayRendererGone });
    // macOS: after sleep or unlock, re-join the hidden overlay to every Space so
    // the next dictation shows on the Space the user is on (#353). Deferred to
    // the next show while a dictation is in progress; no-op elsewhere.
    wake.init({
      powerMonitor,
      isBusy: () => pipeline.getState() !== "idle",
      rejoin: windows.rejoinOverlayAfterWake,
    });
    tray.init(app, pipeline);
    palette = require("./palette").createPalette({ windows, pipeline, history, settings,
      actions: { notice: body => commandsNotifier.show({ title: "Commands unavailable", body }), lastTranscript: tray.lastTranscript, copyLast: tray.copyLast,
        correctLast: openLastCorrection, checkUpdates: () => updates.check({ manual: true }), openLog: ipc.openLog } });
    palette.install(ipcMain);
    pipeline.setPaletteGuard(palette.dismissForDictation);
    tray.setOpenCommands(palette.open);
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

    if (hotkeyResults.paletteHotkey && !hotkeyResults.paletteHotkey.ok) logger.warn(hotkeyResults.paletteHotkey.error);

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
    if (!isSmokeTest && !firstRun && startPalette) palette.open();
    // A new default cleanup prompt is announced once (setup-notices.js).
    if (!isSmokeTest && !firstRun) {
      announcePromptOffer({
        cfg,
        offer: settings.cleanupPromptOffer(cfg),
        notify: promptNotifier.show,
        record: (id) => {
          try {
            const now = settings.get();
            settings.save({ ...now, cleanup: { ...now.cleanup, promptOfferNotified: id } });
          } catch (err) {
            logger.warn(`could not record the prompt notice: ${err.message}`);
          }
        },
      });
    }

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
    palette?.close();
    windows.destroyOverlay();
    // Stop owned tool servers (bounded) and deny pending approvals first.
    if (!toolsStopped && tools.running() > 0) {
      event.preventDefault();
      toolsStopped = true;
      tools.shutdown(2500).finally(() => app.quit());
      return;
    }
    // Put lowered output back before exiting (bounded, best effort; a marker
    // covers the rest on the next launch), then quit again.
    if (ducking.holding()) {
      event.preventDefault();
      ducking.shutdown(2000).finally(() => app.quit());
    }
  });

  app.on("will-quit", () => {
    agentApi.shutdown();
    hotkeys.unregisterAll();
    engines.stop();
    updates.dispose();
    ducking.close();
    tools.shutdown(0);
  });
}
