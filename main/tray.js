// System tray icon and menu. The icon doubles as a recording indicator.

const { Tray, Menu, Notification, nativeImage } = require("electron");
const path = require("node:path");
const windows = require("./windows");
const commands = require("./commands");
const settings = require("./settings");
const updates = require("./updates");
const history = require("./history");
const { deliver } = require("./output/deliver");
const { deliverText } = require("./output/single-line");
const logger = require("./util/logger");
const { t } = require("./i18n");

let tray = null;
let pipeline = null;
let appRef = null;

const ASSETS = path.join(__dirname, "..", "assets");

const OUTPUT_MODES = [
  { labelKey: "tray.output.paste", mode: "paste" },
  { labelKey: "tray.output.pasteCopy", mode: "paste-copy" },
  { labelKey: "tray.output.clipboard", mode: "clipboard" },
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

async function copyLast() {
  if (pipeline.getState() === "processing") return { ok: false, error: "Wait for processing to finish." };
  const text = lastTranscript();
  if (!text) return { ok: false, error: "No transcription to copy." };
  try { await deliver(deliverText(text, settings.get().output), { mode: "clipboard" }); return { ok: true }; }
  catch (err) {
    logger.warn(`could not copy transcript: ${err.message}`);
    try {
      new Notification({ title: t("tray.copyFailed.title"), body: t("tray.copyFailed.body") }).show();
    } catch (notifyErr) { logger.warn(`copy notification failed: ${notifyErr.message}`); }
    return { ok: false, error: err.message };
  }
}
function correctLast() {
  if (pipeline.getState() === "idle") windows.openCorrection(history.list()[0]);
}
let openCommands = () => {};
function setOpenCommands(open) { openCommands = open; }

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
          ? t("tray.stop")
          : state === "processing"
            ? t("tray.processing")
            : t("tray.start"),
      enabled: state !== "processing",
      click: () => pipeline.toggle(),
    },
    {
      // Voice command (#344): an explicit rewrite/draft by voice, separate
      // from dictation. While a command records, the same item finishes it.
      label: commands.isRecording() ? "Finish voice command" : "Voice command…",
      enabled: state === "idle" || commands.isRecording(),
      click: () => commands.begin(),
    },
    {
      label: t("tray.cancel"),
      visible: state !== "idle",
      click: () => pipeline.cancel(),
    },
    // A failed transcription's recording, held for a retry (#293).
    {
      label: t("tray.retryFailed"),
      visible: !!failedTake,
      enabled: state === "idle",
      click: () => pipeline.retryFailedTake(),
    },
    {
      label: t("tray.discardFailed"),
      visible: !!failedTake,
      enabled: state === "idle",
      click: () => pipeline.discardFailedTake(),
    },
    { type: "separator" },
    ...OUTPUT_MODES.map(({ labelKey, mode }) => ({
      label: t(labelKey),
      type: "radio",
      checked: shownMode === mode,
      click: () => setOutputMode(mode),
    })),
    { type: "separator" },
    {
      label: t("tray.copyLast"),
      enabled: !!lastText && state !== "processing",
      // Re-read at click time so we copy the freshest entry even if the menu
      // was built a moment before the dictation landed.
      click: copyLast,
    },
    { type: "separator" },
    {
      label: t("tray.correctLast"),
      enabled: !!lastEntry && state === "idle",
      click: correctLast,
    },
    ...updateItems(),
    { label: "Commands…", accelerator: cfg.paletteHotkey || undefined, click: () => openCommands() },
    { label: t("tray.settings"), click: () => windows.openSettings() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
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
        title: t("tray.outputModeFailed.title"),
        body: t("tray.outputModeFailed.body"),
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
      { label: t("tray.updateTo", { version: u.latest }), click: () => updates.startUpdate() },
      { type: "separator" },
    ];
  }
  if (u.status === "downloading") {
    const label = u.progress
      ? t("tray.downloadingUpdatePct", { percent: Math.round((u.progress.fraction || 0) * 100) })
      : t("tray.downloadingUpdate");
    return [
      { label, enabled: false },
      { type: "separator" },
    ];
  }
  if (u.status === "ready") {
    return [
      { label: t("tray.restartToUpdate", { version: u.latest }), click: () => updates.installNow() },
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
      ? t("tray.tooltip.recording")
      : state === "processing"
        ? t("tray.tooltip.processing")
        : t("tray.tooltip.ready")
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

module.exports = { init, refresh, lastTranscript, copyLast, correctLast, setOpenCommands };
