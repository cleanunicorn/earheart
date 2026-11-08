// Voice commands (#344), composed: the session (session.js) wired to the
// dictation pipeline's recorder and STT, the transform router, the command
// card window, the global hotkey and delivery's paste.
//
// A command is a separate, explicit operation. The pipeline hands a command
// take's transcript here instead of cleaning and delivering it, so ordinary
// dictation never reaches this module and a command never reaches cleanup.
// See docs/commands.md.

const { clipboard, globalShortcut, ipcMain } = require("electron");
const settings = require("../settings");
const windows = require("../windows");
const route = require("../services/route");
const engines = require("../engines");
const deliver = require("../output/deliver");
const logger = require("../util/logger");
const { prettyHotkey, registrationHint } = require("../util/hotkey-label");
const { createPlatform } = require("./platform");
const { createSelectionCapture } = require("./selection");
const { createCommandSession } = require("./session");
const { registerCommandIpc } = require("./ipc");

let session = null;
let platform = null;
let pipeline = null;
let initialized = false;
// The registered accelerator, its status for Settings, and suspension while a
// hotkey field captures a new combination.
let hotkey = { accelerator: "", status: { ok: true, empty: true } };
let suspended = false;

// The command settings as the session reads them: an unknown engine value runs
// locally, and Apply is off wherever the platform can't vouch for the target.
function commandConfig() {
  const cfg = settings.get().commands;
  return { ...cfg, engine: cfg.engine === "remote" ? "remote" : "builtin" };
}

async function transform(request, signal) {
  const all = settings.get();
  const cfg = commandConfig();
  if (cfg.engine === "builtin") {
    // The in-process engine borrows the cleanup model. Not downloaded is a
    // plain answer, not a worker error naming "cleanup".
    const readiness = engines.getCleanupReadiness({ enabled: true, engine: "builtin", builtin: all.cleanup.builtin });
    if (!readiness.ok) {
      throw new Error("The local text model isn't downloaded yet. Download it in Settings → Cleanup, or set up a remote service in Settings → Commands.");
    }
  }
  return route.transform(request, cfg, signal, {
    cleanupModelId: all.cleanup.builtin.model,
    maxRecordingSeconds: all.audio?.maxRecordingSeconds,
  });
}

// Replace the selection: the ordinary paste, restoring the user's clipboard.
// Never "clipboard" mode — that would not paste at all.
function paste(text, signal) {
  const output = settings.get().output;
  return deliver.deliver(text, { mode: "paste", restoreClipboard: true, pasteDelayMs: output.pasteDelayMs }, signal);
}

function init({ pipeline: pipelineModule }) {
  if (initialized) return;
  initialized = true;
  pipeline = pipelineModule;
  platform = createPlatform();
  const selection = createSelectionCapture({
    clipboard,
    snapshot: deliver.snapshotClipboard,
    restore: deliver.restoreSnapshot,
    platform,
  });
  session = createCommandSession({
    getConfig: commandConfig,
    selection,
    platform,
    transform,
    startRecording: (handlers) => pipeline.startCommandRecording(handlers),
    stopRecording: () => pipeline.stopRecording(),
    cancelRecording: () => pipeline.cancel(),
    writeClipboard: (text) => clipboard.writeText(text),
    paste,
    onView: (view) => {
      // A null view means the command ended without the card's own Cancel
      // (the overlay's cancel, the discard hotkey): close the card, or it
      // would keep showing a dead command.
      if (view) windows.sendToCommand("command:state", view);
      else windows.closeCommand();
    },
    logger,
  });
  registerCommandIpc({
    ipcMain,
    session,
    isCommandSender: windows.isCommandSender,
    closeWindow: () => windows.closeCommand(),
  });
  // The recording ends by the dictation hotkey or the overlay: follow it.
  pipeline.onStateChange((state) => {
    if (state === "processing") session.markTranscribing();
  });
  applyHotkey(settings.get().commands.hotkey);
}

// Start (or, while recording, finish) a command. The tray item, the hotkey and
// `earheart --command` all come here.
async function begin() {
  if (!session) return { ok: false };
  if (session.isRecording()) return session.begin();
  if (pipeline.getState() !== "idle") return { ok: false, busy: true };
  // The card first, so the user sees "Reading the selection…" at once; it is
  // inactive and never takes the keyboard from the app holding the selection.
  windows.openCommand({ onClosed: () => session?.dispose() });
  return session.begin();
}

function cancel() {
  const view = session?.peek();
  if (view) session.cancel(view.id);
  windows.closeCommand();
}

/* ---- hotkey ---- */

function register(accelerator) {
  try {
    return globalShortcut.register(accelerator, () => { begin().catch((err) => logger.warn(`voice command failed to start: ${err.message}`)); })
      ? { ok: true }
      : { ok: false, error: `Could not register "${prettyHotkey(accelerator)}" (${registrationHint()}).` };
  } catch (err) {
    return { ok: false, error: `Invalid hotkey "${prettyHotkey(accelerator)}": ${err.message}` };
  }
}

// Bind the command hotkey ("" = none). The old binding is released only after
// the new one registers; a failure keeps the old one and reports why.
function applyHotkey(accelerator) {
  const next = typeof accelerator === "string" ? accelerator.trim() : "";
  if (next === hotkey.accelerator) return hotkey.status;
  if (!next) {
    if (hotkey.accelerator && !suspended) globalShortcut.unregister(hotkey.accelerator);
    hotkey = { accelerator: "", status: { ok: true, empty: true } };
    return hotkey.status;
  }
  const result = suspended ? { ok: true } : register(next);
  if (!result.ok) {
    logger.warn(`command hotkey: ${result.error}`);
    hotkey = { ...hotkey, status: { ...result, accelerator: next } };
    return hotkey.status;
  }
  if (hotkey.accelerator && !suspended) globalShortcut.unregister(hotkey.accelerator);
  hotkey = { accelerator: next, status: { ok: true, accelerator: next } };
  return hotkey.status;
}

// While a Settings field captures a combination the OS must not swallow it.
function suspend(on) {
  if (on === suspended) return;
  suspended = on;
  if (!hotkey.accelerator) return;
  if (on) globalShortcut.unregister(hotkey.accelerator);
  else {
    const result = register(hotkey.accelerator);
    if (!result.ok) {
      logger.warn(`command hotkey: ${result.error}`);
      hotkey = { ...hotkey, status: { ...result, accelerator: hotkey.accelerator } };
    }
  }
}

function getHotkeyStatus() {
  return hotkey.status;
}

// What this OS can do, for Settings: capture the selection, and apply a result.
function capabilities() {
  if (!platform) return { capture: { ok: false }, apply: { ok: false } };
  return { capture: platform.captureSupport(), apply: platform.fingerprintSupport() };
}

module.exports = { init, transform, paste, isRecording: () => session?.isRecording() ?? false, begin, cancel, applyHotkey, suspend, getHotkeyStatus, capabilities, commandConfig };
