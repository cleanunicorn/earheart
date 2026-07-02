// System tray icon and menu. The icon doubles as a recording indicator.

const { Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const windows = require("./windows");
const settings = require("./settings");
const updates = require("./updates");

let tray = null;
let pipeline = null;
let appRef = null;

const ASSETS = path.join(__dirname, "..", "assets");

function icon(name) {
  const img = nativeImage.createFromPath(path.join(ASSETS, name));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildMenu(app) {
  const cfg = settings.get();
  const state = pipeline.getState();
  return Menu.buildFromTemplate([
    {
      label:
        state === "recording"
          ? "Stop & transcribe"
          : state === "processing"
            ? "Processing…"
            : "Start dictation",
      enabled: state !== "processing",
      click: () => pipeline.toggle(),
    },
    {
      label: "Cancel",
      visible: state !== "idle",
      click: () => pipeline.cancel(),
    },
    { type: "separator" },
    {
      label: "Paste into active app",
      type: "radio",
      checked: cfg.output.mode === "paste",
      click: () => {
        cfg.output.mode = "paste";
        settings.save(cfg);
      },
    },
    {
      label: "Paste and keep on clipboard",
      type: "radio",
      checked: cfg.output.mode === "paste-copy",
      click: () => {
        cfg.output.mode = "paste-copy";
        settings.save(cfg);
      },
    },
    {
      label: "Copy to clipboard only",
      type: "radio",
      checked: cfg.output.mode === "clipboard",
      click: () => {
        cfg.output.mode = "clipboard";
        settings.save(cfg);
      },
    },
    { type: "separator" },
    ...updateItems(),
    { label: "Settings…", click: () => windows.openSettings() },
    { type: "separator" },
    { label: "Quit Earheart", click: () => app.quit() },
  ]);
}

// Update entries appear only while there is something to act on; the menu is
// rebuilt on every updates state change (main.js wires updates.init's
// onStateChange to refresh), so the label tracks download progress.
function updateItems() {
  const u = updates.getState();
  if (u.status === "available" && u.method === "install") {
    return [
      { label: `Update to v${u.latest}…`, click: () => updates.startUpdate() },
      { type: "separator" },
    ];
  }
  if (u.status === "downloading") {
    const pct = u.progress ? ` ${Math.round((u.progress.fraction || 0) * 100)}%` : "";
    return [
      { label: `Downloading update…${pct}`, enabled: false },
      { type: "separator" },
    ];
  }
  if (u.status === "ready") {
    return [
      { label: `Restart to update to v${u.latest}`, click: () => updates.installNow() },
      { type: "separator" },
    ];
  }
  return [];
}

function refresh(app = appRef) {
  if (!tray || !app) return;
  const state = pipeline.getState();
  tray.setImage(icon(state === "recording" ? "tray-recording.png" : "tray.png"));
  tray.setToolTip(
    state === "recording"
      ? "Earheart — recording"
      : state === "processing"
        ? "Earheart — processing"
        : "Earheart — ready"
  );
  tray.setContextMenu(buildMenu(app));
}

function init(app, pipelineModule) {
  appRef = app;
  pipeline = pipelineModule;
  tray = new Tray(icon("tray.png"));
  // Click-to-toggle only works on Windows; Linux trays are menu-only and
  // macOS opens the context menu on click once one is set.
  if (process.platform === "win32") {
    tray.on("click", () => pipeline.toggle());
  }
  pipeline.onStateChange(() => refresh(app));
  refresh(app);
  return tray;
}

module.exports = { init, refresh };
