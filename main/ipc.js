// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app } = require("electron");
const settings = require("./settings");
const history = require("./history");
const windows = require("./windows");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
const localStt = require("./services/local-stt");
const localCleanup = require("./services/local-cleanup");
const serverManager = require("./services/server-manager");
const models = require("./services/model-manager");
const catalog = require("./services/model-catalog");
const { encodeSilenceWav } = require("./util/wav");

// In-flight model downloads, keyed by target ("stt" | "cleanup"), so a second
// request or a cancel can abort the first.
const downloads = new Map();

function init({ applyHotkey, onSettingsChanged }) {
  ipcMain.handle("settings:get", () => ({
    settings: settings.get(),
    defaults: settings.DEFAULTS,
    platform: process.platform,
    version: app.getVersion(),
  }));

  ipcMain.handle("settings:save", (event, next) => {
    const saved = settings.save(next);
    const hotkeyResult = applyHotkey(saved.hotkey);
    onSettingsChanged?.();
    return { settings: saved, hotkey: hotkeyResult };
  });

  // The setup wizard saves its choices, then hands over to the settings
  // window so the user can review what was pre-configured. If the chosen
  // hotkey can't be registered, the wizard stays open to let them fix it.
  ipcMain.handle("wizard:complete", (event, next) => {
    const saved = settings.save(next);
    const hotkeyResult = applyHotkey(saved.hotkey);
    onSettingsChanged?.();
    serverManager.start(saved.sttServer);
    if (hotkeyResult.ok) {
      windows.openSettings({ fromWizard: true });
      windows.closeWizard();
    }
    return { settings: saved, hotkey: hotkeyResult };
  });

  // Settings → Advanced: re-run the setup wizard on demand. The wizard
  // itself doesn't change anything until it is completed.
  ipcMain.handle("wizard:open", () => {
    windows.openWizard();
  });

  // Skipping still persists the defaults so the wizard only ever runs once.
  ipcMain.handle("wizard:skip", () => {
    const saved = settings.save(settings.get());
    windows.openSettings();
    windows.closeWizard();
    return { settings: saved };
  });

  // Report which in-app models are downloaded, plus the catalog so the wizard
  // and settings can render choices and progress.
  ipcMain.handle("models:status", (event, cfg = settings.get()) => {
    const stt = cfg.stt || {};
    const clean = cfg.cleanup || {};
    return {
      stt: {
        engine: stt.engine,
        model: stt.localModel || catalog.DEFAULT_STT_MODEL,
        installed: models.isSttInstalled(stt.localModel),
      },
      cleanup: {
        engine: clean.engine,
        model: clean.localModel || catalog.DEFAULT_CLEANUP_MODEL,
        installed: models.isCleanupInstalled(clean.localModel, clean.localModelUri),
      },
      catalog: {
        stt: catalog.sttModelList(),
        cleanup: catalog.cleanupModelList(),
      },
    };
  });

  // Download an in-app model, streaming progress back to the requesting window
  // as `models:progress`. Resolves when the download finishes (or fails).
  ipcMain.handle("models:download", async (event, { target, modelId, customUri } = {}) => {
    if (downloads.has(target)) downloads.get(target).abort();
    const controller = new AbortController();
    downloads.set(target, controller);
    const send = (payload) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("models:progress", { target, ...payload });
      }
    };
    const onProgress = ({ received, total }) =>
      send({ phase: "downloading", received, total });
    try {
      send({ phase: "start", received: 0, total: 0 });
      if (target === "stt") {
        await models.downloadStt(modelId, { signal: controller.signal, onProgress });
      } else if (target === "cleanup") {
        await models.downloadCleanup(modelId, customUri, {
          signal: controller.signal,
          onProgress,
        });
      } else {
        throw new Error(`Unknown download target: ${target}`);
      }
      send({ phase: "done" });
      return { ok: true };
    } catch (err) {
      send({ phase: "error", error: err.message });
      return { ok: false, error: err.message };
    } finally {
      if (downloads.get(target) === controller) downloads.delete(target);
    }
  });

  ipcMain.handle("models:cancel", (event, { target } = {}) => {
    downloads.get(target)?.abort();
    return { ok: true };
  });

  // Round-trip a short silent WAV through the configured STT engine to verify
  // it works without needing the microphone. Builtin needs the model present.
  ipcMain.handle("stt:test", async (event, cfg) => {
    try {
      const wav = encodeSilenceWav(0.5);
      if (cfg.engine === "builtin") {
        if (!models.isSttInstalled(cfg.localModel)) {
          return { ok: false, error: "Model not downloaded yet" };
        }
        await localStt.transcribe(wav, cfg);
      } else {
        await stt.transcribe(wav, cfg);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cleanup:test", async (event, cfg) => {
    try {
      if (cfg.engine === "builtin") {
        if (!models.isCleanupInstalled(cfg.localModel, cfg.localModelUri)) {
          return { ok: false, error: "Model not downloaded yet" };
        }
      }
      const engine = cfg.engine === "builtin" ? localCleanup : cleanup;
      const result = await engine.clean(
        "um so this is uh a test of the cleanup service",
        cfg
      );
      return { ok: true, sample: result.slice(0, 200) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("history:list", () => history.list());
  ipcMain.handle("history:clear", () => {
    history.clear();
    return [];
  });
}

module.exports = { init };
