// Electron wiring for "lower other audio while recording" (#340): picks this
// platform's backends, keeps the restore marker in userData, reads the two
// audio settings, and answers Settings' `ducking:status`. The lifecycle
// itself lives in ./controller.js; main/main.js feeds it the pipeline's
// capture signal and awaits its restore on quit.

const path = require("node:path");
const { app, ipcMain } = require("electron");
const settings = require("../settings");
const logger = require("../util/logger");
const { execFileAsync } = require("../util/exec-file");
const { candidates } = require("./backends");
const { createDucker, createFileStore } = require("./controller");

// Per call. PowerShell compiles the Core Audio shim on every call (~1–2 s);
// system_profiler can take a second or two; the Linux tools answer at once.
const TIMEOUT_MS = { win32: 15000, darwin: 10000 };
const MARKER_FILE = "audio-duck.json";

let ducker = null;

function init() {
  const timeout = TIMEOUT_MS[process.platform] ?? 3000;
  const run = (cmd, args, opts = {}) => execFileAsync(cmd, args, { timeout, ...opts });
  ducker = createDucker({
    backends: candidates(process.platform, run),
    store: createFileStore(path.join(app.getPath("userData"), MARKER_FILE)),
    getConfig: () => {
      const audio = settings.get().audio || {};
      return { enabled: audio.duckOtherAudio, levelPercent: audio.duckLevelPercent };
    },
    logger,
  });
  ipcMain.handle("ducking:status", () => ducker.getStatus());
  ducker.recover();
  return ducker;
}

const live = () => ducker;

module.exports = {
  init,
  setCapturing: (owner, on) => live()?.setCapturing(owner, on),
  refresh: () => live()?.refresh(),
  holding: () => !!live()?.holding(),
  shutdown: (ms) => live()?.shutdown(ms) ?? Promise.resolve(),
};
