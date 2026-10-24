// System tray icon and menu. The icon doubles as a recording indicator.

const { Tray, Menu, Notification, nativeImage } = require("electron");
const path = require("node:path");
const windows = require("./windows");
const settings = require("./settings");
const updates = require("./updates");
const history = require("./history");
const { deliver } = require("./output/deliver");
const { deliverText } = require("./output/single-line");
const logger = require("./util/logger");

let tray = null;
let pipeline = null;
let appRef = null;

const ASSETS = path.join(__dirname, "..", "assets");

const OUTPUT_MODES = [
  { label: "Paste into active app", mode: "paste" },
  { label: "Paste and keep on clipboard", mode: "paste-copy" },
  { label: "Copy to clipboard only", mode: "clipboard" },
];

function icon(name) {
  // Pass the ICO path directly so Windows selects the native size for its DPI.
  if (process.platform === "win32") return path.join(ASSETS, name.replace(/\.png$/, ".ico"));
  const img = nativeImage.createFromPath(path.join(ASSETS, name));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

// The most recent transcript: History's newest entry, or a delivery held back
// because the clipboard changed (#291) if that came later — with History off,
// the held-back one is the only copy there is.
function lastTranscript() {
  const held = pipeline.getUndelivered();
  const entry = history.list()[0];
  if (held && (!entry || !(entry.at > held.at))) return held.text;
  return entry?.text;
}

function buildMenu(app) {
  const cfg = settings.get();
  // Check the radio for what delivery does, legacy encoding included.
  const shownMode = settings.effectiveOutputMode(cfg.output);
  const state = pipeline.getState();
  const failedTake = pipeline.getFailedTake();
  const lastEntry = history.list()[0];
  const lastText = lastTranscript();
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
    // A failed transcription's recording, held for a retry (#293).
    {
      label: "Retry failed transcription",
      visible: !!failedTake,
      enabled: state === "idle",
      click: () => pipeline.retryFailedTake(),
    },
    {
      label: "Discard failed recording",
      visible: !!failedTake,
      enabled: state === "idle",
      click: () => pipeline.discardFailedTake(),
    },
    { type: "separator" },
    ...OUTPUT_MODES.map(({ label, mode }) => ({
      label,
      type: "radio",
      checked: shownMode === mode,
      click: () => setOutputMode(mode),
    })),
    { type: "separator" },
    {
      label: "Copy last transcription",
      enabled: !!lastText && state !== "processing",
      // Re-read at click time so we copy the freshest entry even if the menu
      // was built a moment before the dictation landed.
      click: async () => {
        if (pipeline.getState() === "processing") return;
        const text = lastTranscript();
        if (!text) return;
        try { await deliver(deliverText(text, settings.get().output), { mode: "clipboard" }); }
        catch (err) {
          logger.warn(`could not copy transcript: ${err.message}`);
          try {
            new Notification({ title: "Could not copy transcript", body: "Your transcript is still in History. Try copying it again." }).show();
          } catch (notifyErr) { logger.warn(`copy notification failed: ${notifyErr.message}`); }
        }
      },
    },
    { type: "separator" },
    {
      label: "Correct last transcription…",
      enabled: !!lastEntry && state === "idle",
      click: () => { if (pipeline.getState() === "idle") windows.openCorrection(history.list()[0]); },
    },
    ...updateItems(),
    { label: "Settings…", click: () => windows.openSettings() },
    { type: "separator" },
    { label: "Quit Earheart", click: () => app.quit() },
  ]);
}

// Read the settings at click time, never the snapshot the menu was built
// from: other writers (overlay drag, custom models, the updater) save without
// rebuilding the tray, and saving the old snapshot would roll them back. A
// successful save rebuilds the menu through the settings change listener
// (main/ipc.js); a failed one rebuilds it here so the radio goes back to the
// mode that is actually saved.
function setOutputMode(mode) {
  const cur = settings.get();
  try {
    // restoreClipboard: true retires the legacy encoding, as the Settings
    // form does: "paste" must restore, "paste-copy" is the keep-it mode.
    settings.save({ ...cur, output: { ...cur.output, mode, restoreClipboard: true } });
  } catch (err) {
    logger.warn(`could not save the output mode: ${err.message}`);
    refresh();
    // The menu has closed by now, so say so: otherwise the user walks away
    // believing the mode changed. Best-effort, like every notification here.
    try {
      new Notification({
        title: "Could not change the output mode",
        body: `Earheart couldn't save the setting (${err.message}). It is unchanged.`,
      }).show();
    } catch (notifyErr) {
      logger.warn(`output-mode notification failed: ${notifyErr.message}`);
    }
  }
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
  pipeline.onFailedTakeChange(() => refresh(app));
  refresh(app);
  return tray;
}

module.exports = { init, refresh };
