// IPC handlers backing the settings window.

const { ipcMain, shell, app } = require("electron");
const settings = require("./settings");
const history = require("./history");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
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

  ipcMain.on("open-external", (event, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

module.exports = { init };
