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

const { app, ipcMain, Notification } = require("electron");
const path = require("node:path");
const windows = require("./windows");
const settings = require("./settings");
const route = require("./services/route");
const engines = require("./engines");
const { deliver } = require("./output/deliver");
const history = require("./history");
const { createLivePreview } = require("./live-preview");
const { createPersistedRtfEstimator } = require("./util/rtf");
const { wavDurationSec } = require("./util/wav");
const logger = require("./util/logger");

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
  runTranscribe: route.transcribe,
  runCleanup: route.clean,
  sendToOverlay: windows.sendToOverlay,
  getSettings: settings.get,
  isCurrent: (sid) => sid === session && state === "recording",
  // Partials are best-effort and must never disturb the dictation, but silently
  // swallowing their errors hid real breakage (STT model still loading or not
  // downloaded) — so surface them here for diagnosis without interrupting.
  onError: (err) => logger.warn("live preview partial failed:", err.message),
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

// Determinate progress within a processing phase. A separate event from
// pipeline:status: status means "the phase changed" (and resets the overlay's
// transcript/layout), progress just advances the bar for the current phase.
// The 0..1 field is named `fraction` to match the models:progress vocabulary.
function sendProgress(phase, fraction) {
  windows.sendToOverlay("pipeline:progress", { phase, fraction });
}

// The final STT decode exposes no progress, so the transcribing bar runs on an
// estimate calibrated by the measured realtime factor of previous decodes,
// persisted in userData so calibration survives app restarts. The singleton is
// created lazily because app.getPath needs the app ready; the first use is
// inside process(). (Same deferred-getPath shape as history.js/settings.js.)
let sttRtf = null;

// Cadence of the estimated transcribing bar. Faster than the worker's own
// 100ms progress throttle so the two bars feel equally alive, well below the
// bar's 150ms CSS width transition so motion stays continuous.
const STT_PROGRESS_TICK_MS = 120;

function getSttRtf() {
  if (!sttRtf) {
    sttRtf = createPersistedRtfEstimator(
      path.join(app.getPath("userData"), "stt-rtf.json")
    );
  }
  return sttRtf;
}

// Run the final transcription with the estimated transcribing bar. The builtin
// decoder is one opaque blocking call, so the bar is elapsed time against the
// audio duration times the learned decode speed; this helper owns that plumbing
// (model preload, ticker lifecycle, RTF sample) so process() stays a readable
// phase list. Remote STT (network-bound, no meaningful local estimate) skips
// the estimate and keeps the indeterminate pulse. `stale` mutes sends from a
// cancelled/superseded session; the ticker itself dies in `finally` regardless.
async function transcribeWithEstimate(wav, sttCfg, signal, stale) {
  const rtf = sttCfg.engine === "builtin" ? getSttRtf() : null;
  if (rtf) {
    // Load the model BEFORE starting the clock: a cold load (first dictation,
    // post-idle-unload, worker restart) takes seconds and would both freeze
    // the bar at its cap and poison the persisted RTF sample with load time
    // that isn't decode speed. Idempotent — route.transcribe re-runs it as a
    // no-op; errors land in the caller's catch either way.
    await engines.ensureStt(sttCfg.builtin.model);
    if (stale()) return "";
  }
  const durationSec = wavDurationSec(wav);
  const startedAt = Date.now();
  const elapsedSec = () => (Date.now() - startedAt) / 1000;
  const tick = rtf
    ? setInterval(() => {
        if (stale()) return;
        sendProgress("transcribing", rtf.progressAt(elapsedSec(), durationSec));
      }, STT_PROGRESS_TICK_MS)
    : null;
  try {
    // The RTF sample comes from the worker's own decode timing, not wall
    // clock: elapsed here also contains queueing behind an in-flight
    // live-preview decode on the single STT worker, which would drag the
    // estimate high on exactly the common case (live preview is on by
    // default). The bar's ticker above still runs on wall clock — that IS
    // what the user is waiting through.
    let decodeMs = null;
    const raw = await route.transcribe(wav, sttCfg, signal, {
      onDecodeMs: (ms) => {
        decodeMs = ms;
      },
    });
    if (rtf && !stale()) {
      if (decodeMs !== null) rtf.record(durationSec, decodeMs / 1000);
      // The estimate never reaches 1 on its own (capped); on success, let the
      // bar visibly complete instead of always vanishing short of the end.
      sendProgress("transcribing", 1);
    }
    return raw;
  } finally {
    if (tick) clearInterval(tick);
  }
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
  const liveOn = cfg.stt.engine === "builtin" && cfg.stt.livePreview?.enabled;
  // Warm the built-in STT model as recording begins so the first live-preview
  // partials aren't all dropped while it loads. The drop-if-busy guard discards
  // every partial tick until a decode is free, so a cold multi-second first load
  // would starve the whole preview on short dictations (no text ever appears).
  // Best effort — the authoritative final pass calls ensureStt again regardless.
  if (liveOn) engines.ensureStt(cfg.stt.builtin.model).catch(() => {});
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
      // `enabled`; we also gate on the engine here (see `liveOn` above).
      livePreview: liveOn ? cfg.stt.livePreview : { enabled: false },
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
    const raw = await transcribeWithEstimate(wav, cfg.stt, signal, stale);
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
        // The builtin worker streams token progress (generated vs transcript
        // length); the HTTP client ignores onProgress. stale() mutes late
        // events from a cancelled/superseded session.
        text = await route.clean(raw, cfg.cleanup, signal, {
          onProgress: (fraction) => {
            if (!stale()) sendProgress("cleaning", fraction);
          },
        });
        cleaned = true;
        // Streamed progress is capped below 1 (only the reply says done) —
        // this is the "done". Builtin only: the remote path never showed a
        // bar, so a completion flash there would be noise.
        if (cfg.cleanup.engine === "builtin" && !stale()) {
          sendProgress("cleaning", 1);
        }
      } catch (err) {
        if (stale()) return;
        // Cleanup is an enhancement: fall back to the raw transcript and
        // surface what happened instead of dropping the dictation.
        logger.error("cleanup failed:", err.message);
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
    logger.error("pipeline failed:", err);
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
