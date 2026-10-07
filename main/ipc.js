// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const settings = require("./settings");
const logger = require("./util/logger");
const deliver = require("./output/deliver");
const history = require("./history");
const windows = require("./windows");
const route = require("./services/route");
const engines = require("./engines");
const autostart = require("./autostart");
const updates = require("./updates");
const tray = require("./tray");
const { listRemoteModels } = require("./services/models-remote");
const {
  parseRepoInput,
  listGgufQuants,
  listSttVariants,
  buildCleanupModel,
  buildSttModel,
  searchUrl,
} = require("./services/hf-models");
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

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A form save (Settings window or wizard) sends `{ settings, baseline }`: the
// settings it spread from the snapshot it opened with, and the values of the
// shared fields below as it last saw them from main.
function parseCommitRequest(request) {
  if (!isPlainObject(request) || !isPlainObject(request.settings)) {
    throw new Error("invalid settings request");
  }
  return {
    next: request.settings,
    baseline: isPlainObject(request.baseline) ? request.baseline : {},
  };
}

// Fields both a form and main write: the output mode (tray radios) and update
// reminders ("Don't remind me" on the update prompt). Main changed one while
// the form was open when the live value differs from the form's baseline;
// that change wins, otherwise the form's value (edited or not) is saved. Once
// the form has applied the settings:changed broadcast its baseline moves on,
// so the user can change the field again.
const SHARED_FIELDS = [
  {
    name: "outputMode",
    type: "string",
    // Compared as the mode delivery performs, so retiring the legacy
    // { mode: "paste", restoreClipboard: false } encoding counts as a change.
    read: (cfg) => (cfg.output ? settings.effectiveOutputMode(cfg.output) : undefined),
    // Keep main's restoreClipboard with its mode: the pair is what decides
    // whether "paste" restores the clipboard (main/output/deliver.js).
    write: (cfg, live) => ({
      ...cfg,
      output: { ...cfg.output, mode: live.output.mode, restoreClipboard: live.output.restoreClipboard },
    }),
  },
  {
    name: "remind",
    type: "boolean",
    read: (cfg) => cfg.updates?.remind !== false,
    write: (cfg, live) => ({ ...cfg, updates: { ...cfg.updates, remind: live.updates.remind } }),
  },
];

// Settings only main writes, which no form edits: the dragged overlay position
// (main/windows.js), custom model definitions (models:add/remove-custom) and
// the updater's bookkeeping. A form's copy of them can only be stale, so the
// live value always wins.
function withMainOwned(next, live, baseline) {
  let out = { ...next, overlay: live.overlay, customModels: live.customModels };
  if (live.updates) {
    out.updates = {
      ...next.updates,
      skippedVersion: live.updates.skippedVersion,
      lastSeenVersion: live.updates.lastSeenVersion,
    };
  }
  for (const field of SHARED_FIELDS) {
    const seen = baseline[field.name];
    if (typeof seen !== field.type) continue;
    if (field.read(live) !== seen) out = field.write(out, live);
  }
  return out;
}

// The sections an open form takes from a settings:changed event (see
// applySettingsChange in renderer/settings.js and renderer/wizard.js). Only
// these are sent, so API keys never ride the event; the forms already hold
// them from settings:get.
const FORM_SYNC_KEYS = ["output", "updates", "overlay", "customModels"];

function formSyncFields(cfg) {
  return Object.fromEntries(FORM_SYNC_KEYS.map((key) => [key, cfg[key]]));
}

function withFields(base, source, fields) {
  const result = { ...base };
  for (const field of fields) {
    result[field] = source[field];
  }
  return result;
}

function init({ applyHotkeys, onSettingsChanged }) {
  // Register any models the user added from a custom Hugging Face URL so they
  // resolve for download and for loading into the cleanup worker after a
  // restart, exactly like the built-ins.
  engines.registry.setCustomModels(settings.get().customModels || []);

  // Every successful save, from any writer, reaches the open forms (so they
  // show a tray or updater change) and rebuilds the tray menu (so its radios
  // show a form change).
  settings.onChanged(({ previous, current }) => {
    windows.sendToForms("settings:changed", {
      previous: formSyncFields(previous),
      current: formSyncFields(current),
    });
    tray.refresh();
  });

  ipcMain.handle("settings:get", () => {
    const cfg = settings.get();
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
      // Drives the cleanup style slider (id/label/hint per stop) and the
      // "Start from preset" seed values, so the UI copy and numbers stay in
      // lockstep with the presets the engines actually use.
      cleanupStyles: CLEANUP_STYLES.map(({ id, label, hint, sampling }) => ({
        id,
        label,
        hint,
        sampling,
      })),
    };
  });

  // The one commit path for both forms. Main-side writers save while a form
  // is open, so the form's payload is merged with the live settings first
  // (withMainOwned), then hotkeys are applied before persisting so a rejected
  // shortcut never reaches disk.
  const commitSettings = (request) => {
    const { next, baseline } = parseCommitRequest(request);
    const previous = settings.get();
    const candidate = withMainOwned(next, previous, baseline);
    const hotkeyResults = applyHotkeys(candidate);
    const rejectedFields = ["hotkey", "pauseHotkey"].filter((field) => {
      const result = hotkeyResults[field];
      return !result.ok && !result.empty;
    });
    const persistedCandidate = withFields(candidate, previous, rejectedFields);

    let saved;
    try {
      saved = settings.save(persistedCandidate);
    } catch (err) {
      // The disk still contains `previous`, so put the live shortcuts back in
      // the same state before surfacing the write failure to the renderer.
      try {
        const rollback = applyHotkeys(previous);
        const failures = [rollback.hotkey, rollback.pauseHotkey]
          .filter((result) => !result.ok)
          .map((result) => result.error);
        if (failures.length) {
          logger.warn(`could not restore hotkeys after settings save failed: ${failures.join("; ")}`);
        }
      } catch (rollbackError) {
        logger.warn(`could not restore hotkeys after settings save failed: ${rollbackError.message}`);
      }
      throw err;
    }

    // Disk keeps only working values; the form keeps the attempted values so
    // the user can see each error and correct the field without re-entering it.
    const responseSettings = withFields(saved, candidate, rejectedFields);
    applyAutostart(saved);
    onSettingsChanged?.();
    return {
      hotkeyResults,
      response: {
        settings: responseSettings,
        hotkey: hotkeyResults.hotkey,
        pauseHotkey: hotkeyResults.pauseHotkey,
      },
    };
  };

  ipcMain.handle("settings:save", (event, request) => commitSettings(request).response);

  // The setup wizard saves its choices, then hands over to the settings
  // window so the user can review what was pre-configured. If the chosen
  // hotkey can't be registered, the wizard stays open to let them fix it.
  ipcMain.handle("wizard:complete", (event, request) => {
    const { response, hotkeyResults } = commitSettings(request);
    if (hotkeyResults.hotkey.ok) {
      windows.openSettings({ fromWizard: true });
      windows.closeWizard();
    }
    return response;
  });

  // Close the settings window. The renderer calls this only after a clean save
  // (settings saved *and* the hotkey registered) so the user doesn't have to
  // dismiss it manually; on a hotkey-registration failure the renderer keeps the
  // window open instead, so the error stays visible.
  ipcMain.handle("settings:close", () => {
    windows.closeSettings();
  });

  // Settings → About: open the error log in the OS default handler so the user
  // can read or attach it when something goes wrong. `action` names which of
  // the three outcomes happened so the UI can describe it; the path comes back
  // either way, so even total failure still tells the user where to look.
  ipcMain.handle("logs:open", async () => {
    const logPath = logger.getLogPath();
    if (!logPath) return { ok: false, error: "No log file yet." };
    // The logger resolves the path at startup but only creates the file on the
    // first write, so a clean install that has never faulted has no file to
    // open or reveal — open the logs folder instead.
    if (!fs.existsSync(logPath)) {
      const error = await shell.openPath(path.dirname(logPath)); // "" on success
      return error
        ? { ok: false, error, path: logPath }
        : { ok: true, path: logPath, action: "folder" };
    }
    const error = await shell.openPath(logPath);
    if (!error) return { ok: true, path: logPath, action: "opened" };
    // Opening fails when .log has no default app (common on Windows); reveal
    // the file in the OS file manager instead, which needs no association.
    try {
      shell.showItemInFolder(logPath);
      return { ok: true, path: logPath, action: "revealed" };
    } catch {
      return { ok: false, error, path: logPath };
    }
  });

  // Settings → Advanced: re-run the setup wizard on demand. The wizard
  // itself doesn't change anything until it is completed.
  ipcMain.handle("wizard:open", () => {
    windows.openWizard();
  });

  // Settings → Advanced: report whether auto-paste is allowed, and which
  // permission blocks it, so the UI can re-check silently (e.g. when the window
  // regains focus after the user toggled a permission) without resetting
  // anything or re-opening System Settings.
  ipcMain.handle("permissions:accessibility-check", () => deliver.checkPastePermissions());

  // Get the user back into a working auto-paste state on macOS: auto-paste
  // needs Accessibility and Automation, and an update leaves stale grants for
  // both that macOS will not re-prompt over. fixPastePermissions clears them,
  // re-asks, and says which pane to point the user at.
  ipcMain.handle("permissions:accessibility-fix", () => deliver.fixPastePermissions());

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

  // Per-kind discovery + entry builders for custom Hugging Face models.
  const hfDiscover = { cleanup: listGgufQuants, stt: listSttVariants };
  const hfBuild = { cleanup: buildCleanupModel, stt: buildSttModel };

  // List the downloadable variants (GGUF quantizations for cleanup, transducer
  // precisions for STT) in a Hugging Face repo — pasted as a URL or a bare
  // owner/model — so the settings UI can offer them as a pick-list. Read-only.
  ipcMain.handle("models:hf-variants", async (event, { kind, url } = {}) => {
    try {
      if (!hfDiscover[kind]) return { ok: false, error: `Unknown model kind: ${kind}` };
      const result = await hfDiscover[kind](parseRepoInput(url), fetch);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Open the Hugging Face hub in the browser, filtered to models Earheart can
  // run as this kind. The URL is built here from the kind, never taken from
  // the renderer, so the bridge can't be used to open arbitrary links.
  ipcMain.handle("models:browse-hf", async (event, { kind } = {}) => {
    try {
      await shell.openExternal(searchUrl(kind));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Add a custom model from a Hugging Face repo + chosen variant: build a
  // registry-shaped entry, persist it, and register it so it behaves like a
  // built-in (status/download/remove). Re-lists server-side rather than
  // trusting a file list from the renderer.
  ipcMain.handle("models:add-custom", async (event, { kind, url, variant } = {}) => {
    try {
      if (!hfDiscover[kind]) return { ok: false, error: `Unknown model kind: ${kind}` };
      const listing = await hfDiscover[kind](parseRepoInput(url), fetch);
      const chosen =
        listing.variants.find((v) => v.label === variant) ||
        listing.variants.find((v) => v.label === listing.recommended);
      if (!chosen) return { ok: false, error: "That version is no longer available" };
      const model = hfBuild[kind](listing.repo, chosen);
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
      // The stored definition knows which kind it is; a definition that's
      // already gone still gets the cleanup-side fallbacks below.
      const entry = (settings.get().customModels || []).find((m) => m.id === modelId);
      const kind = entry && entry.kind === "stt" ? "stt" : "cleanup";
      try {
        await engines.remove(kind, modelId);
      } catch {
        // Not downloaded (or already gone) — still drop the definition below.
      }
      // Re-read after the await: other writers may have saved meanwhile, and
      // saving the pre-await copy would roll them back.
      const cfg = settings.get();
      const customModels = (cfg.customModels || []).filter((m) => m.id !== modelId);
      // If the removed model was the configured one for its kind, fall back to
      // the default so the engine doesn't later fail to resolve a model that's
      // gone.
      const defaults = {
        stt: engines.registry.DEFAULT_STT_MODEL,
        cleanup: engines.registry.DEFAULT_CLEANUP_MODEL,
      };
      const kindCfg =
        cfg[kind].builtin.model === modelId
          ? { ...cfg[kind], builtin: { ...cfg[kind].builtin, model: defaults[kind] } }
          : cfg[kind];
      settings.save({ ...cfg, [kind]: kindCfg, customModels });
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
    if (engines.isInstalled(kind, modelId)) {
      const result = { ok: true };
      windows.broadcast("models:done", { kind, modelId, ...result });
      return result;
    }
    const controller = new AbortController();
    downloads.set(key, controller);
    let result;
    try {
      await engines.download(kind, modelId, {
        signal: controller.signal,
        // Broadcast so whichever window is open (wizard and/or Settings) tracks
        // the same download, not just the one that started it.
        onProgress: (p) => {
          windows.broadcast("models:progress", { kind, modelId, ...p });
        },
      });
      result = { ok: true };
    } catch (err) {
      const aborted = controller.signal.aborted;
      result = { ok: false, cancelled: aborted, error: err.message };
    } finally {
      downloads.delete(key);
    }
    windows.broadcast("models:done", { kind, modelId, ...result });
    return result;
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
    // "Copy last transcription" must go disabled with nothing left to copy.
    tray.refresh();
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
  // The overlay prompt's two other exits: "Later" (this run only) and
  // "Don't remind me" (never again — see settings.updates.remind).
  ipcMain.handle("updates:dismiss", () => {
    updates.dismissPrompt();
    return { ok: true };
  });
  ipcMain.handle("updates:remind-off", () => {
    updates.stopReminding();
    return { ok: true };
  });
}

module.exports = { init };
