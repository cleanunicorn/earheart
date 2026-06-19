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
const engines = require("./engines");
const { deliver } = require("./output/deliver");
const history = require("./history");
const { createLivePreview } = require("./live-preview");

// Route a stage to the in-process engine or the HTTP client based on settings.
// Both backends take the same (payload, cfg, signal) shape, so the only
// difference here is which implementation runs.
function runTranscribe(wav, cfg, signal) {
  const impl = cfg.engine === "builtin" ? engines.transcribe : stt.transcribe;
  return impl(wav, cfg, signal);
}

function runCleanup(raw, cfg, signal) {
  const impl = cfg.engine === "builtin" ? engines.clean : cleanup.clean;
  return impl(raw, cfg, signal);
}

let state = "idle"; // idle | recording | processing
let session = 0; // current dictation session id
let abortController = null;
const stateListeners = new Set();

// Live preview (the streaming partial transcript shown while recording) lives in
// its own module; the pipeline just feeds it audio and cancels it at the right
// lifecycle points. Dependencies are injected so it stays free of our private
// session/state — `isCurrent(sid)` is the single source of truth for "this sid
// is still the active recording".
const livePreview = createLivePreview({
  runTranscribe,
  runCleanup,
  sendToOverlay: windows.sendToOverlay,
  getSettings: settings.get,
  isCurrent: (sid) => sid === session && state === "recording",
});

// Idle eviction: after a dictation finishes, wait the configured idle window
// and then unload the built-in models to reclaim memory. Any new dictation
// cancels the pending timer (and re-arms it when done), so the models stay
// resident during active use. 0 minutes means never unload.
let idleUnloadTimer = null;

function cancelIdleUnload() {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function armIdleUnload() {
  cancelIdleUnload();
  const minutes = settings.get().engines?.idleUnloadMinutes ?? 0;
  if (!minutes || minutes <= 0) return; // 0 = keep models resident
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    // Only unload if still idle — a dictation in flight will re-arm on finish.
    if (state === "idle") engines.unloadIdle();
  }, minutes * 60 * 1000);
}

function setState(next) {
  state = next;
  // Models should stay resident while a dictation is active; only count idle
  // time once we're back to idle. Re-arming on each return to idle resets the
  // window after every dictation.
  if (next === "idle") armIdleUnload();
  else cancelIdleUnload();
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
      // Live preview only runs on the builtin engine (the HTTP path would be
      // hammered with repeated full-file uploads). The overlay gates on
      // `enabled`; we also gate on the engine here.
      livePreview:
        cfg.stt.engine === "builtin" && cfg.stt.livePreview?.enabled
          ? cfg.stt.livePreview
          : { enabled: false },
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
  livePreview.cancel();
  if (state === "recording") {
    windows.sendToOverlay("record:cancel");
  } else if (state === "processing" && abortController) {
    abortController.abort();
  }
  setState("idle");
  windows.hideOverlay();
}

async function process(sid, wavArrayBuffer) {
  // The final pass is authoritative; stop any partial work so it doesn't
  // contend with the real transcribe/clean on the engine workers.
  livePreview.cancel();

  const cfg = settings.get();
  setState("processing");
  const controller = new AbortController();
  abortController = controller;
  const { signal } = controller;
  const wav = Buffer.from(wavArrayBuffer);
  const stale = () => session !== sid || signal.aborted;

  try {
    overlayStatus("transcribing");
    const raw = await runTranscribe(wav, cfg.stt, signal);
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
        text = await runCleanup(raw, cfg.cleanup, signal);
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

  ipcMain.on("audio:partial", (event, { sid, seq, final, wav } = {}) => {
    livePreview.handleAudio(sid, { seq, final, wav });
  });

  ipcMain.on("record:cancelled", (event, { sid } = {}) => {
    if (sid !== session) return;
    livePreview.cancel();
    if (state === "recording") setState("idle");
    windows.hideOverlay();
  });

  ipcMain.on("record:error", (event, { sid, message } = {}) => {
    if (sid !== session) return;
    livePreview.cancel();
    if (state === "recording") setState("idle");
    overlayStatus("error", { message });
    hideOverlaySoon(sid, 5000);
  });

  ipcMain.on("pipeline:cancel", () => cancel());
}

// Re-arm the idle-unload timer with the latest setting (e.g. the user changed
// the idle window in Settings). Only matters while idle; an active dictation
// re-arms from the new value when it finishes.
function onSettingsChanged() {
  if (state === "idle") armIdleUnload();
}

module.exports = { init, toggle, cancel, getState, onStateChange, onSettingsChanged };
