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
const { wavDurationSec, wavSliceFromFrame } = require("./util/wav");
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
//
// `assembly` (builtin only) is the live-preview snapshot when its committed
// chunk decodes cover the recording's first `decodedSamples` samples intact:
// then only the tail past that coverage is decoded and joined onto the
// committed text, so stop→transcript stays near-constant however long the
// dictation ran. Without a usable snapshot (preview machinery broken, remote
// STT, no chunk committed yet) the whole recording decodes as before.
async function transcribeWithEstimate(wav, sttCfg, signal, stale, assembly) {
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
  let decodeWav = wav;
  let committedText = "";
  if (rtf && assembly && !assembly.broken && assembly.decodedSamples > 0) {
    decodeWav = wavSliceFromFrame(wav, assembly.decodedSamples);
    committedText = assembly.committedRaw;
    // An effectively empty tail (stop landed right on a chunk boundary):
    // the committed text IS the transcript, no decode needed.
    if (wavDurationSec(decodeWav) < 0.05) {
      if (!stale()) sendProgress("transcribing", 1);
      return committedText;
    }
  }
  const durationSec = wavDurationSec(decodeWav);
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
    const raw = await route.transcribe(decodeWav, sttCfg, signal, {
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
    return joinRaw(committedText, raw);
  } finally {
    if (tick) clearInterval(tick);
  }
}

// Join the committed live-preview text with the decoded tail. Mirrors the
// live preview's own joinText: a space, and either side may be empty.
function joinRaw(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return `${a} ${b}`;
}

// Sibling of transcribeWithEstimate: run cleanup with its streamed progress.
// The builtin worker reports real token progress (generated vs transcript
// length, capped below 1 — only the reply says done), so on success this sends
// the explicit final 1; the remote path never showed a bar, so a completion
// flash there would be noise. The raw-transcript fallback stays with the
// caller — that's dictation policy, not progress plumbing.
async function cleanWithProgress(raw, cleanupCfg, signal, stale) {
  const text = await route.clean(raw, cleanupCfg, signal, {
    onProgress: (fraction) => {
      if (!stale()) sendProgress("cleaning", fraction);
    },
  });
  if (cleanupCfg.engine === "builtin" && !stale()) {
    sendProgress("cleaning", 1);
  }
  return text;
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
  // Warm the built-in models as recording begins, so their load time is hidden
  // under the time the user spends speaking instead of being paid after stop.
  // STT: with live preview on this also keeps the first partials from all being
  // dropped while the model loads (the drop-if-busy guard discards every tick
  // until a decode is free). Cleanup: loading Gemma takes seconds cold and used
  // to start only after transcription finished; priming additionally prefills
  // the static prompt prefix so even the first clean of the session skips it.
  // Both are best effort — the final pass re-runs ensureStt/ensureCleanup
  // (idempotent) and surfaces real errors there; a failed warm-up here must
  // never block the recording.
  if (cfg.stt.engine === "builtin") {
    engines.ensureStt(cfg.stt.builtin.model).catch(() => {});
  }
  if (cfg.cleanup.enabled && cfg.cleanup.engine === "builtin") {
    engines.primeCleanup(cfg.cleanup).catch(() => {});
  }
  const win = windows.createOverlay();
  const begin = () => {
    if (session !== sid) return; // cancelled before the overlay was ready
    windows.showOverlay();
    windows.sendToOverlay("record:start", {
      sid,
      deviceId: cfg.audio.deviceId,
      maxSeconds: cfg.audio.maxRecordingSeconds,
      // Chunked partial decoding runs whenever STT is builtin (the committed
      // chunk decodes become the final transcript's prefix — see
      // live-preview.js); `display` additionally paints the live transcript
      // and is the user's toggle. Remote STT gets neither (the HTTP path
      // would be hammered with repeated uploads).
      livePreview:
        cfg.stt.engine === "builtin"
          ? { ...cfg.stt.livePreview, enabled: true, display: !!liveOn }
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
  // The overlay answers with `audio:captured` — or `record:cancelled` when
  // the mic never went live (nothing captured, nothing to transcribe), or
  // `record:error`.
  windows.sendToOverlay("record:stop");
}

function cancel() {
  session++; // invalidate in-flight session events
  livePreview.cancel();
  if (state === "recording") {
    windows.sendToOverlay("record:cancel");
  } else if (state === "processing" && abortController) {
    abortController.abort();
    // The abort only mutes the reply; the cleanup worker would keep generating
    // for nothing (and delay the next dictation's clean). Stop it too.
    engines.cancelClean();
  }
  setState("idle");
  windows.hideOverlay();
}

async function process(sid, wavArrayBuffer) {
  const cfg = settings.get();
  // Snapshot the committed chunk decodes BEFORE cancelling the live preview
  // (cancel resets them): they are the final transcript's prefix, so the
  // final pass only decodes the audio tail.
  const assembly =
    cfg.stt.engine === "builtin" ? livePreview.snapshotFinal() : null;
  // The final pass is authoritative; stop any partial work so it doesn't
  // contend with the real transcribe/clean on the engine workers.
  livePreview.cancel();

  setState("processing");
  const controller = new AbortController();
  abortController = controller;
  const { signal } = controller;
  const wav = Buffer.from(wavArrayBuffer);
  const stale = () => session !== sid || signal.aborted;

  const builtinCleanup = cfg.cleanup.enabled && cfg.cleanup.engine === "builtin";
  if (builtinCleanup) {
    // Free the cleanup worker NOW: an in-flight live-preview clean would
    // otherwise keep generating and the final clean would queue behind it.
    engines.cancelClean();
    // Prefill-ahead: the committed text is a known prefix of the final
    // transcript, so its prompt prefix can be evaluated on the cleanup worker
    // WHILE the tail decodes on the STT worker. The final clean then only
    // prefills the tail's words before generating. Best effort.
    if (assembly && !assembly.broken && assembly.committedRaw) {
      engines.primeCleanup(cfg.cleanup, assembly.committedRaw).catch(() => {});
    }
  }

  try {
    overlayStatus("transcribing");
    const raw = await transcribeWithEstimate(wav, cfg.stt, signal, stale, assembly);
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
        text = await cleanWithProgress(raw, cfg.cleanup, signal, stale);
        cleaned = true;
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
