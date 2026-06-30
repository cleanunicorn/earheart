// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app } = require("electron");
const settings = require("./settings");
const deliver = require("./output/deliver");
const history = require("./history");
const windows = require("./windows");
const route = require("./services/route");
const engines = require("./engines");
const autostart = require("./autostart");
const { listRemoteModels } = require("./services/models-remote");
const { STYLES: CLEANUP_STYLES } = require("./cleanup-styles");
const { encodeSilenceWav } = require("./util/wav");

// In-flight model downloads, so the UI can cancel them. Keyed by kind:modelId.
const downloads = new Map();

// Push the start-on-boot choice to the OS, swallowing failures (e.g. a
// read-only autostart dir) so a save never fails over a login-item glitch.
function applyAutostart(cfg) {
  try {
    autostart.apply(cfg.startOnBoot);
  } catch (err) {
    console.warn(`[earheart] could not apply start-on-boot: ${err.message}`);
  }
}

function init({ applyHotkey, onSettingsChanged }) {
  ipcMain.handle("settings:get", () => {
    // Shallow copy so reporting the live OS state doesn't mutate the cache.
    const cfg = { ...settings.get() };
    // Report the real OS login-item state so the toggle reflects reality even
    // if it was changed outside the app (e.g. the autostart file was removed).
    try {
      cfg.startOnBoot = autostart.isEnabled();
    } catch {
      // Fall back to the stored value if the OS query fails.
    }
    return {
      settings: cfg,
      defaults: settings.DEFAULTS,
      platform: process.platform,
      version: app.getVersion(),
      // Drives the cleanup style slider (id/label/hint per stop), so the UI
      // copy stays in lockstep with the presets the engines actually use.
      cleanupStyles: CLEANUP_STYLES.map(({ id, label, hint }) => ({ id, label, hint })),
    };
  });

  ipcMain.handle("settings:save", (event, next) => {
    const saved = settings.save(next);
    const hotkeyResult = applyHotkey(saved.hotkey);
    applyAutostart(saved);
    onSettingsChanged?.();
    return { settings: saved, hotkey: hotkeyResult };
  });

  // The setup wizard saves its choices, then hands over to the settings
  // window so the user can review what was pre-configured. If the chosen
  // hotkey can't be registered, the wizard stays open to let them fix it.
  ipcMain.handle("wizard:complete", (event, next) => {
    const saved = settings.save(next);
    const hotkeyResult = applyHotkey(saved.hotkey);
    applyAutostart(saved);
    onSettingsChanged?.();
    if (hotkeyResult.ok) {
      windows.openSettings({ fromWizard: true });
      windows.closeWizard();
    }
    return { settings: saved, hotkey: hotkeyResult };
  });

  // Close the settings window. The renderer calls this only after a clean save
  // (settings saved *and* the hotkey registered) so the user doesn't have to
  // dismiss it manually; on a hotkey-registration failure the renderer keeps the
  // window open instead, so the error stays visible.
  ipcMain.handle("settings:close", () => {
    windows.closeSettings();
  });

  // Settings → Advanced: re-run the setup wizard on demand. The wizard
  // itself doesn't change anything until it is completed.
  ipcMain.handle("wizard:open", () => {
    windows.openWizard();
  });

  // Settings → Advanced: report whether auto-paste is allowed, so the UI can
  // re-check silently (e.g. when the window regains focus after the user
  // toggled the permission) without re-opening System Settings.
  ipcMain.handle("permissions:accessibility-check", () => ({
    granted: deliver.accessibilityTrusted(),
  }));

  // Get the user back into a working auto-paste state on macOS. Auto-paste
  // drives keystrokes through System Events, which needs Accessibility
  // permission. macOS only shows its prompt once per app, so after the first
  // allow/deny there is nothing to re-trigger — we fire the native prompt
  // (covers a never-decided app) and open the Accessibility pane (the reliable
  // path once a decision has been recorded). On other platforms there is no
  // such permission, so accessibilityTrusted always reports granted.
  ipcMain.handle("permissions:accessibility-fix", async () => {
    if (deliver.accessibilityTrusted(true)) return { granted: true };
    try {
      await deliver.openAccessibilitySettings();
      return { granted: false, opened: true };
    } catch {
      return { granted: false, opened: false };
    }
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
      await route.transcribe(wav, cfg);
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
      const result = await route.clean(sample, cfg);
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
