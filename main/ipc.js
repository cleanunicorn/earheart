// IPC handlers backing the settings window and the setup wizard.

const { ipcMain, app } = require("electron");
const settings = require("./settings");
const history = require("./history");
const windows = require("./windows");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
const serverManager = require("./services/server-manager");
const { encodeSilenceWav } = require("./util/wav");

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

  // Round-trip a short silent WAV through the configured STT service to
  // verify URL/key/model without needing the microphone.
  ipcMain.handle("stt:test", async (event, cfg) => {
    try {
      const wav = encodeSilenceWav(0.5);
      await stt.transcribe(wav, cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("cleanup:test", async (event, cfg) => {
    try {
      const result = await cleanup.clean(
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
