// The dictation pipeline: record -> transcribe -> clean up -> deliver.
//
// State machine:
//   idle ──hotkey──▶ recording ──hotkey──▶ processing ──▶ idle
//                        │                     │  ▲
//                        │              (gate) ▼  │ (send/copy)
//                        │                  reviewing
//                        │                     │
//                        └──cancel──▶ idle ◀───┘ (error/cancel/discard)
//
// The reviewing state is the opt-in review-before-send stop: the cleaned
// transcript parks on the overlay for a keyboard edit pass, then a send/copy
// re-enters processing to deliver, or a discard drops back to idle.
//
// Recording happens in the overlay renderer (it owns the microphone); the
// captured WAV arrives here over IPC and the rest runs in the main process.
//
// Every dictation gets a session id that is echoed back in overlay IPC
// messages. Events from a torn-down session (late cancels, slow renderers)
// are ignored instead of corrupting the current one.

const { app, clipboard, ipcMain, Notification } = require("electron");
const path = require("node:path");
const windows = require("./windows");
const settings = require("./settings");
const route = require("./services/route");
const engines = require("./engines");
const { deliver } = require("./output/deliver");
const { captureTarget, restoreTarget } = require("./output/focus");
const { needsReview } = require("./util/review");
const history = require("./history");
const { createLivePreview } = require("./live-preview");
const { createPersistedRtfEstimator } = require("./util/rtf");
const { wavDurationSec, wavSliceFromFrame } = require("./util/wav");
const logger = require("./util/logger");

let state = "idle"; // idle | recording | processing | reviewing
let session = 0; // current dictation session id
let abortController = null;
// The dictation parked on the overlay for review. `target` is the focus
// token of the window the user dictated into (see main/output/focus.js);
// `text` is the cleaned transcript as it was offered, so history can record
// whether the user edited it before sending.
let pendingReview = null; // { sid, raw, text, cleaned, target }
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
  } else if (state === "reviewing") {
    // The hotkey's grammar is "advance the pipeline", and during review the
    // next step is sending. It is also the only key that still works after
    // the user clicked away to another app mid-review. The renderer owns the
    // edited text, so ask it to send rather than sending main's stale copy.
    windows.sendToOverlay("review:request-send", { sid: session });
  }
  // While processing, the hotkey is ignored; cancel is available on the
  // overlay and in the tray menu.
}

// Pause/resume the dictation in progress (pause hotkey / `earheart --pause`).
// Only meaningful while recording; the overlay owns the actual pause state
// and additionally no-ops while the mic is still warming, so a stray press
// anywhere else does nothing.
function pauseToggle() {
  if (state === "recording") windows.sendToOverlay("record:pause-toggle");
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
  } else if (state === "reviewing") {
    // Tray/CLI cancel can't see the renderer's edits, so the parked (main-
    // side) text is what history keeps; the focus borrow is repaid so the
    // user lands back where they were dictating.
    flushReview();
    windows.leaveReviewFocus();
    if (pendingReviewTarget) restoreTarget(pendingReviewTarget);
    pendingReviewTarget = null;
  }
  setState("idle");
  windows.hideOverlay();
}

// Write a parked review to history as discarded and clear it. Called from
// cancel() and from before-quit — a two-minute dictation must survive both.
// Remembers the focus token aside so cancel() can still repay the borrow.
let pendingReviewTarget = null;
function flushReview() {
  if (!pendingReview) return;
  const review = pendingReview;
  pendingReview = null;
  pendingReviewTarget = review.target;
  windows.setReviewPinned(false);
  const cfg = settings.get();
  if (cfg.history.enabled) {
    history.add(
      {
        raw: review.raw,
        text: review.text,
        cleaned: review.cleaned,
        reviewed: true,
        edited: false,
        delivered: "discarded",
      },
      cfg.history
    );
    windows.sendToSettings("history:changed");
  }
}

// Send or copy the reviewed text: leave the borrowed focus, give the captured
// target window its focus back, and only then deliver — in that order, so the
// simulated paste keystroke cannot land in our own (now unfocusable) window.
async function finishReview(sid, finalText, mode) {
  if (sid !== session || state !== "reviewing" || !pendingReview) return;
  const review = pendingReview;
  pendingReview = null;
  windows.setReviewPinned(false);
  setState("processing");
  const cfg = settings.get();
  const text = finalText || review.text;
  const edited = text !== review.text;
  try {
    await windows.leaveReviewFocus();
    let result;
    if (mode === "send") {
      await restoreTarget(review.target);
      overlayStatus("delivering");
      // Wayland can't re-activate the target explicitly; give the compositor
      // a longer beat to return focus on its own before the keystroke fires.
      const output =
        review.target?.kind === "wayland"
          ? { ...cfg.output, pasteDelayMs: Math.max(cfg.output.pasteDelayMs ?? 150, 300) }
          : cfg.output;
      result = await deliver(text, output);
    } else {
      // Copy: the user keeps the text and pastes it themselves; still hand
      // focus back so they land where they were working.
      clipboard.writeText(text);
      restoreTarget(review.target);
      result = { method: "clipboard" };
    }
    if (sid !== session) return;
    if (cfg.history.enabled) {
      history.add(
        {
          raw: review.raw,
          text,
          cleaned: review.cleaned,
          reviewed: true,
          edited,
          delivered: result.method,
        },
        cfg.history
      );
      windows.sendToSettings("history:changed");
    }
    overlayStatus("done", {
      preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      method: result.method,
      note: result.note,
    });
    hideOverlaySoon(sid, result.note ? 4000 : 1600);
  } catch (err) {
    if (sid !== session) return;
    logger.error("review delivery failed:", err);
    overlayStatus("error", { message: String(err.message).slice(0, 200) });
    hideOverlaySoon(sid, 5000);
  } finally {
    if (session === sid) setState("idle");
  }
}

// Esc from the review panel: nothing is pasted, but the words are kept
// (history's whole purpose is that a transcript is never lost) — with the
// renderer's edits, which travel with the discard message.
async function discardReview(sid, editedText) {
  if (sid !== session || state !== "reviewing" || !pendingReview) return;
  const review = pendingReview;
  pendingReview = null;
  windows.setReviewPinned(false);
  const cfg = settings.get();
  const text = editedText || review.text;
  if (cfg.history.enabled) {
    history.add(
      {
        raw: review.raw,
        text,
        cleaned: review.cleaned,
        reviewed: true,
        edited: text !== review.text,
        delivered: "discarded",
      },
      cfg.history
    );
    windows.sendToSettings("history:changed");
  }
  await windows.leaveReviewFocus();
  // Esc means "back to work": return focus to where the user was dictating.
  restoreTarget(review.target);
  if (session === sid) setState("idle");
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
  // Set when this dictation parks on the review panel: the finally below must
  // then leave the reviewing state alone instead of clobbering it to idle.
  let enteredReview = false;

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

    if (needsReview(cfg.review, text)) {
      // Remember the window the user dictated into BEFORE the overlay borrows
      // focus — from here on, "the focused app" would be us.
      const target = await captureTarget();
      if (stale()) return;
      pendingReview = { sid, raw, text, cleaned, target };
      enteredReview = true;
      setState("reviewing");
      windows.setReviewPinned(true); // auto-hide must not take the panel down
      windows.enterReviewFocus();
      overlayStatus("review", { sid, text, raw });
      return; // review:send / review:discard IPC picks the session back up
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
    if (session === sid && !enteredReview) setState("idle");
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

  // Review panel exits. The renderer sends its (possibly edited) textarea
  // content with each one; the sid guards inside drop stale sessions.
  ipcMain.on("review:send", (event, { sid, text } = {}) => {
    finishReview(sid, String(text ?? ""), "send");
  });
  ipcMain.on("review:copy", (event, { sid, text } = {}) => {
    finishReview(sid, String(text ?? ""), "copy");
  });
  ipcMain.on("review:discard", (event, { sid, text } = {}) => {
    discardReview(sid, String(text ?? ""));
  });
}

// Re-arm the idle-unload timer with the latest setting (e.g. the user changed
// the idle window in Settings). Only matters while idle; an active dictation
// re-arms from the new value when it finishes.
function onSettingsChanged() {
  if (state === "idle") armIdleUnload();
}

module.exports = {
  init,
  toggle,
  pauseToggle,
  cancel,
  getState,
  onStateChange,
  onSettingsChanged,
  flushReview,
};
