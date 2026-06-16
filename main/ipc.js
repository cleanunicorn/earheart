// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app } = require("electron");
const settings = require("./settings");
const history = require("./history");
const windows = require("./windows");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
const engines = require("./engines");
const { listRemoteModels } = require("./services/models-remote");
const { encodeSilenceWav } = require("./util/wav");

// In-flight model downloads, so the UI can cancel them. Keyed by kind:modelId.
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

  // Round-trip a short silent WAV through the configured STT service (or the
  // in-process engine) to verify it actually works.
  ipcMain.handle("stt:test", async (event, cfg) => {
    try {
      const wav = encodeSilenceWav(0.5);
      if (cfg.engine === "builtin") await engines.transcribe(wav, cfg);
      else await stt.transcribe(wav, cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // List the models an external OpenAI-compatible service offers, so the
  // settings UI can present them as a pick-list instead of a free-text field.
  ipcMain.handle("models:list-remote", async (event, cfg) => {
    try {
      const models = await listRemoteModels(cfg || {});
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cleanup:test", async (event, cfg) => {
    try {
      const sample = "um so this is uh a test of the cleanup service";
      const result =
        cfg.engine === "builtin"
          ? await engines.clean(sample, cfg)
          : await cleanup.clean(sample, cfg);
      return { ok: true, sample: result.slice(0, 200) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- in-process model management (wizard download step + Settings) ----

  // Which built-in models are downloaded and how big they are. Used to decide
  // whether the wizard needs to show its download step.
  ipcMain.handle("models:status", () => {
    const describe = (kind) =>
      engines.registry.listModels(kind).map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        note: m.note,
        default: !!m.default,
        bytes: engines.registry.totalBytes(m),
        installed: engines.isInstalled(kind, m.id),
      }));
    return { stt: describe("stt"), cleanup: describe("cleanup") };
  });

  // Stream a model download to disk, posting progress to the requesting window.
  ipcMain.handle("models:download", async (event, { kind, modelId }) => {
    const key = `${kind}:${modelId}`;
    if (downloads.has(key)) return { ok: false, error: "Already downloading" };
    if (engines.isInstalled(kind, modelId)) return { ok: true };
    const controller = new AbortController();
    downloads.set(key, controller);
    try {
      await engines.download(kind, modelId, {
        signal: controller.signal,
        // Broadcast so whichever window is open (wizard and/or Settings) tracks
        // the same download, not just the one that started it.
        onProgress: (p) => {
          windows.broadcast("models:progress", { kind, modelId, ...p });
        },
      });
      return { ok: true };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return { ok: false, cancelled: aborted, error: err.message };
    } finally {
      downloads.delete(key);
    }
  });

  ipcMain.handle("models:cancel", (event, { kind, modelId }) => {
    const controller = downloads.get(`${kind}:${modelId}`);
    if (controller) controller.abort();
    return { ok: true };
  });

  ipcMain.handle("models:remove", async (event, { kind, modelId }) => {
    try {
      await engines.remove(kind, modelId);
      return { ok: true };
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
