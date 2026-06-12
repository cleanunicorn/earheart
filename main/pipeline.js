// The dictation pipeline: record -> transcribe -> clean up -> deliver.
//
// State machine:
//   idle ──hotkey──▶ recording ──hotkey──▶ processing ──▶ idle
//                        │                     │
//                        └──cancel──▶ idle ◀───┘ (error/cancel)
//
// Recording happens in the overlay renderer (it owns the microphone); the
// captured WAV arrives here over IPC and the rest runs in the main process.
//
// Every dictation gets a session id that is echoed back in overlay IPC
// messages. Events from a torn-down session (late cancels, slow renderers)
// are ignored instead of corrupting the current one.

const { ipcMain, Notification } = require("electron");
const windows = require("./windows");
const settings = require("./settings");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
const { deliver } = require("./output/deliver");
const history = require("./history");

let state = "idle"; // idle | recording | processing
let session = 0; // current dictation session id
let abortController = null;
const stateListeners = new Set();

function setState(next) {
  state = next;
  for (const listener of stateListeners) listener(state);
}

function onStateChange(listener) {
  stateListeners.add(listener);
}

function getState() {
  return state;
}

function overlayStatus(status, detail) {
  windows.sendToOverlay("pipeline:status", { status, detail });
}

function hideOverlaySoon(sid, ms) {
  setTimeout(() => {
    // Only hide if no new session started in the meantime.
    if (session === sid && state === "idle") windows.hideOverlay();
  }, ms);
}

function toggle() {
  if (state === "idle") {
    startRecording();
  } else if (state === "recording") {
    stopRecording();
  }
  // While processing, the hotkey is ignored; cancel is available on the
  // overlay and in the tray menu.
}

function startRecording() {
  const cfg = settings.get();
  const sid = ++session;
  setState("recording");
  const win = windows.createOverlay();
  const begin = () => {
    if (session !== sid) return; // cancelled before the overlay was ready
    windows.showOverlay();
    windows.sendToOverlay("record:start", {
      sid,
      deviceId: cfg.audio.deviceId,
      maxSeconds: cfg.audio.maxRecordingSeconds,
    });
  };
  // The overlay may still be loading right after launch (or after a renderer
  // crash); sending into a loading page would silently drop the message.
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", begin);
  } else {
    begin();
  }
}

function stopRecording() {
  // The overlay answers with `audio:captured` (or `record:error`).
  windows.sendToOverlay("record:stop");
}

function cancel() {
  session++; // invalidate in-flight session events
  if (state === "recording") {
    windows.sendToOverlay("record:cancel");
  } else if (state === "processing" && abortController) {
    abortController.abort();
  }
  setState("idle");
  windows.hideOverlay();
}

async function process(sid, wavArrayBuffer) {
  const cfg = settings.get();
  setState("processing");
  const controller = new AbortController();
  abortController = controller;
  const { signal } = controller;
  const wav = Buffer.from(wavArrayBuffer);
  const stale = () => session !== sid || signal.aborted;

  try {
    overlayStatus("transcribing");
    const raw = await stt.transcribe(wav, cfg.stt, signal);
    if (stale()) return;

    if (!raw) {
      overlayStatus("empty");
      hideOverlaySoon(sid, 1800);
      return;
    }

    let text = raw;
    let cleaned = false;
    if (cfg.cleanup.enabled) {
      overlayStatus("cleaning");
      try {
        text = await cleanup.clean(raw, cfg.cleanup, signal);
        cleaned = true;
      } catch (err) {
        if (stale()) return;
        // Cleanup is an enhancement: fall back to the raw transcript and
        // surface what happened instead of dropping the dictation.
        console.error("[earheart] cleanup failed:", err.message);
        new Notification({
          title: "Earheart: cleanup failed, used raw transcript",
          body: String(err.message).slice(0, 180),
        }).show();
      }
      if (stale()) return;
    }

    overlayStatus("delivering");
    const result = await deliver(text, cfg.output, signal);
    if (stale()) return;
    if (cfg.history.enabled) {
      history.add({ raw, text, cleaned, delivered: result.method }, cfg.history);
      windows.sendToSettings("history:changed");
    }

    overlayStatus("done", {
      preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      method: result.method,
      note: result.note,
    });
    hideOverlaySoon(sid, result.note ? 4000 : 1600);
  } catch (err) {
    if (stale()) return;
    console.error("[earheart] pipeline failed:", err);
    overlayStatus("error", { message: String(err.message).slice(0, 200) });
    hideOverlaySoon(sid, 5000);
  } finally {
    if (abortController === controller) abortController = null;
    if (session === sid) setState("idle");
  }
}

function init() {
  ipcMain.on("audio:captured", (event, { sid, wav }) => {
    if (sid !== session || state !== "recording") return;
    process(sid, wav);
  });

  ipcMain.on("record:cancelled", (event, { sid } = {}) => {
    if (sid !== session) return;
    if (state === "recording") setState("idle");
    windows.hideOverlay();
  });

  ipcMain.on("record:error", (event, { sid, message } = {}) => {
    if (sid !== session) return;
    if (state === "recording") setState("idle");
    overlayStatus("error", { message });
    hideOverlaySoon(sid, 5000);
  });

  ipcMain.on("pipeline:cancel", () => cancel());
}

module.exports = { init, toggle, cancel, getState, onStateChange };
