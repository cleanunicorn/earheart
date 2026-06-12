// The dictation pipeline: record -> transcribe -> clean up -> deliver.
//
// State machine:
//   idle ──hotkey──▶ recording ──hotkey──▶ processing ──▶ idle
//                        │                     │
//                        └──cancel──▶ idle ◀───┘ (error/cancel)
//
// Recording happens in the overlay renderer (it owns the microphone); the
// captured WAV arrives here over IPC and the rest runs in the main process.

const { ipcMain, Notification } = require("electron");
const windows = require("./windows");
const settings = require("./settings");
const stt = require("./services/stt");
const cleanup = require("./services/cleanup");
const { deliver } = require("./output/deliver");
const history = require("./history");

let state = "idle"; // idle | recording | processing
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

function hideOverlaySoon(ms) {
  setTimeout(() => {
    // Only hide if nothing new started in the meantime.
    if (state === "idle") windows.hideOverlay();
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
  setState("recording");
  windows.showOverlay();
  windows.sendToOverlay("record:start", {
    deviceId: cfg.audio.deviceId,
    maxSeconds: cfg.audio.maxRecordingSeconds,
  });
}

function stopRecording() {
  // The overlay answers with `audio:captured` (or `record:error`).
  windows.sendToOverlay("record:stop");
}

function cancel() {
  if (state === "recording") {
    windows.sendToOverlay("record:cancel");
  } else if (state === "processing" && abortController) {
    abortController.abort();
  }
  setState("idle");
  windows.hideOverlay();
}

async function process(wavArrayBuffer) {
  const cfg = settings.get();
  setState("processing");
  abortController = new AbortController();
  const { signal } = abortController;
  const wav = Buffer.from(wavArrayBuffer);

  try {
    overlayStatus("transcribing");
    const raw = await stt.transcribe(wav, cfg.stt, signal);

    if (!raw) {
      overlayStatus("empty");
      hideOverlaySoon(1800);
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
        if (signal.aborted) throw err;
        // Cleanup is an enhancement: fall back to the raw transcript and
        // surface what happened instead of dropping the dictation.
        console.error("[earheart] cleanup failed:", err.message);
        new Notification({
          title: "Earheart: cleanup failed, used raw transcript",
          body: String(err.message).slice(0, 180),
        }).show();
      }
    }

    overlayStatus("delivering");
    const result = await deliver(text, cfg.output);
    history.add({ raw, text, cleaned, delivered: result.method }, cfg.history);
    windows.sendToSettings("history:changed");

    overlayStatus("done", {
      preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      method: result.method,
      note: result.note,
    });
    hideOverlaySoon(result.note ? 4000 : 1600);
  } catch (err) {
    if (signal.aborted) {
      windows.hideOverlay();
      return;
    }
    console.error("[earheart] pipeline failed:", err);
    overlayStatus("error", { message: String(err.message).slice(0, 200) });
    hideOverlaySoon(5000);
  } finally {
    abortController = null;
    setState("idle");
  }
}

function init() {
  ipcMain.on("audio:captured", (event, wavArrayBuffer) => {
    if (state !== "recording") return;
    process(wavArrayBuffer);
  });

  ipcMain.on("record:cancelled", () => {
    if (state === "recording") setState("idle");
    windows.hideOverlay();
  });

  ipcMain.on("record:error", (event, message) => {
    if (state === "recording") setState("idle");
    overlayStatus("error", { message });
    hideOverlaySoon(5000);
  });

  ipcMain.on("pipeline:toggle", () => toggle());
  ipcMain.on("pipeline:cancel", () => cancel());
}

module.exports = { init, toggle, cancel, getState, onStateChange };
