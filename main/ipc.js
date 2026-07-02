// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app, shell } = require("electron");
const settings = require("./settings");
const logger = require("./util/logger");
const deliver = require("./output/deliver");
const history = require("./history");
const windows = require("./windows");
const route = require("./services/route");
const engines = require("./engines");
const autostart = require("./autostart");
const updates = require("./updates");
const { listRemoteModels } = require("./services/models-remote");
const { parseRepoUrl, listGgufQuants, buildCleanupModel } = require("./services/hf-gguf");
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
    logger.warn(`could not apply start-on-boot: ${err.message}`);
  }
}

function init({ applyHotkey, onSettingsChanged }) {
  // Register any models the user added from a custom Hugging Face URL so they
  // resolve for download and for loading into the cleanup worker after a
  // restart, exactly like the built-ins.
  engines.registry.setCustomModels(settings.get().customModels || []);

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

  // The overlay position (settings.overlay) is owned by the main process: it
  // changes when the user drags the card, not through any form. The settings
  // and wizard windows save a payload spread from the snapshot they opened
  // with, so their `overlay` can be stale — dragging the card while a form is
  // open, then saving the form, would roll the position back. Re-inject the
  // live value on every form save.
  const keepLiveOverlay = (next) => ({ ...next, overlay: settings.get().overlay });

  ipcMain.handle("settings:save", (event, next) => {
    const saved = settings.save(keepLiveOverlay(next));
    const hotkeyResult = applyHotkey(saved.hotkey);
    applyAutostart(saved);
    onSettingsChanged?.();
    return { settings: saved, hotkey: hotkeyResult };
  });

  // The setup wizard saves its choices, then hands over to the settings
  // window so the user can review what was pre-configured. If the chosen
  // hotkey can't be registered, the wizard stays open to let them fix it.
  ipcMain.handle("wizard:complete", (event, next) => {
    const saved = settings.save(keepLiveOverlay(next));
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

  // Settings → About: open the error log in the OS default handler so the user
  // can read or attach it when something goes wrong. Returns the path (or an
  // error) so the UI can show where it lives even if opening fails.
  ipcMain.handle("logs:open", async () => {
    const logPath = logger.getLogPath();
    if (!logPath) return { ok: false, error: "No log file yet." };
    const error = await shell.openPath(logPath); // "" on success
    return error ? { ok: false, error, path: logPath } : { ok: true, path: logPath };
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

  // List the GGUF quantizations in a Hugging Face repo, so the settings UI can
  // offer them as a pick-list (defaulting to the best Q4). Read-only.
  ipcMain.handle("models:hf-quants", async (event, { url } = {}) => {
    try {
      const { owner, repo, ref } = parseRepoUrl(url);
      const result = await listGgufQuants({ owner, repo, ref }, fetch);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Add a custom cleanup model from a Hugging Face URL + chosen quant: build a
  // registry-shaped entry, persist it, and register it so it behaves like a
  // built-in (status/download/remove). Re-lists server-side rather than
  // trusting a file list from the renderer.
  ipcMain.handle("models:add-custom", async (event, { url, quant } = {}) => {
    try {
      const { owner, repo, ref } = parseRepoUrl(url);
      const listing = await listGgufQuants({ owner, repo, ref }, fetch);
      const chosen =
        listing.quants.find((q) => q.label === quant) ||
        listing.quants.find((q) => q.label === listing.recommended);
      if (!chosen) return { ok: false, error: "That version is no longer available" };
      const model = buildCleanupModel(listing.repo, chosen);
      const cfg = settings.get();
      // Dedupe by id so re-adding the same repo+quant just refreshes the entry.
      const customModels = [
        ...(cfg.customModels || []).filter((m) => m.id !== model.id),
        model,
      ];
      settings.save({ ...cfg, customModels });
      engines.registry.setCustomModels(customModels);
      return { ok: true, modelId: model.id, customModels };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Remove a custom model entirely: delete any downloaded files and drop its
  // definition from settings + the registry.
  ipcMain.handle("models:remove-custom", async (event, { modelId } = {}) => {
    try {
      try {
        await engines.remove("cleanup", modelId);
      } catch {
        // Not downloaded (or already gone) — still drop the definition below.
      }
      const cfg = settings.get();
      const customModels = (cfg.customModels || []).filter((m) => m.id !== modelId);
      // If the removed model was the configured cleanup model, fall back to the
      // default so cleanup doesn't later fail to resolve a model that's gone.
      const cleanup =
        cfg.cleanup.builtin.model === modelId
          ? { ...cfg.cleanup, builtin: { ...cfg.cleanup.builtin, model: engines.registry.DEFAULT_CLEANUP_MODEL } }
          : cfg.cleanup;
      settings.save({ ...cfg, cleanup, customModels });
      engines.registry.setCustomModels(customModels);
      return { ok: true, customModels };
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
        custom: !!m.custom,
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

  ipcMain.handle("updates:get", () => updates.getState());
  ipcMain.handle("updates:check", async () => {
    await updates.check({ manual: true });
    return updates.getState();
  });
  // Fire-and-forget: progress and outcome arrive via the updates:state
  // broadcast, mirroring how model downloads report through models:progress.
  ipcMain.handle("updates:apply", () => {
    updates.startUpdate();
    return { ok: true };
  });
  ipcMain.handle("updates:install", () => {
    updates.installNow();
    return { ok: true };
  });
  ipcMain.handle("updates:cancel", () => {
    updates.cancel();
    return { ok: true };
  });
  ipcMain.handle("updates:skip", () => {
    updates.skipVersion();
    return { ok: true };
  });
}

module.exports = { init };
