// Live preview: while recording, transcribe the audio captured so far and push
// the partial transcript to the overlay, with cleanup running over the *full*
// raw text on speech pauses. This is the second, side-channel state machine of a
// dictation — separate from the pipeline's authoritative record→transcribe→clean
// →deliver flow — so it lives in its own module and the pipeline just wires it.
//
// STT and cleanup live in separate engine workers, so partial STT and partial
// cleanup run in parallel with each other. Within each worker, requests are
// serialized (one model, one inference at a time), so we use a drop-if-busy flag
// per stage to keep partials from queueing up behind real time.
//
// One thing the worker split does NOT buy us: partial STT and the pipeline's
// *final* transcribe share the same STT worker, and a worker request already
// dispatched isn't cancellable mid-inference. So if the user stops while a
// partial decode is in flight, the final transcribe waits for that partial to
// finish (a brief delay, bounded by one partial decode). cancel() prevents *new*
// partial work from starting but can't reclaim a decode already running.
//
// All of this is best-effort and silent: a dropped or failed partial is cosmetic
// and must never disturb the dictation.
//
// Dependencies are injected so the module stays free of the pipeline's private
// session/state and is unit-testable:
//   runTranscribe(wav, cfg.stt, signal) -> Promise<string>
//   runCleanup(raw, cfg.cleanup, signal) -> Promise<string>
//   sendToOverlay(channel, payload)
//   getSettings() -> settings object
//   isCurrent(sid) -> true iff sid is the active, still-recording session
function createLivePreview({ runTranscribe, runCleanup, sendToOverlay, getSettings, isCurrent }) {
  let sttBusy = false;
  let cleanupBusy = false;
  let abort = null; // aborts in-flight partial work when recording ends
  let lastRaw = ""; // most recent raw transcript shown
  let lastCleanedRaw = ""; // raw text the last cleanup pass ran on
  let pauseTimer = null; // fires a cleanup pass once the raw text goes quiet

  function cancel() {
    if (abort) {
      abort.abort();
      abort = null;
    }
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    sttBusy = false;
    cleanupBusy = false;
    lastRaw = "";
    lastCleanedRaw = "";
  }

  // A partial is stale the moment its session ends, recording stops, or its work
  // is aborted — any of which means the result must be dropped, not shown.
  function stale(sid, signal) {
    return !isCurrent(sid) || signal.aborted;
  }

  async function handleAudio(sid, wavArrayBuffer) {
    // Only the active recording session may produce partials, and only when the
    // STT engine is in-process — re-checked here (not just at record:start)
    // because settings are live: switching to the HTTP engine mid-dictation must
    // not start POSTing partial WAVs to a remote endpoint.
    if (!isCurrent(sid)) return;
    if (sttBusy) return; // drop-if-busy: keep up with the latest audio only
    const cfg = getSettings();
    if (cfg.stt.engine !== "builtin") return;
    if (!abort) abort = new AbortController();
    const { signal } = abort;
    sttBusy = true;
    try {
      const wav = Buffer.from(wavArrayBuffer);
      const raw = await runTranscribe(wav, cfg.stt, signal);
      // The session may have ended (stop/cancel) while we were decoding.
      if (stale(sid, signal)) return;
      const text = (raw || "").trim();
      if (!text || text === lastRaw) return;
      lastRaw = text;
      sendToOverlay("pipeline:partial", { kind: "raw", text });
      scheduleCleanup(sid, cfg, signal);
    } catch {
      // Cosmetic: ignore failed partials entirely.
    } finally {
      sttBusy = false;
    }
  }

  // Run cleanup once the raw text has been stable for the configured pause. We
  // clean the *whole* raw transcript (not the new segment): a long pause is not a
  // sentence boundary, so segmenting would corrupt punctuation across pauses, and
  // re-cleaning a stable prefix is idempotent enough to keep the cleaned line calm.
  function scheduleCleanup(sid, cfg, signal) {
    // Only clean live when both cleanup is on and it runs in-process: a remote
    // cleanup endpoint shouldn't be hit repeatedly mid-dictation. The final pass
    // still cleans on stop regardless of engine.
    if (!cfg.cleanup.enabled || cfg.cleanup.engine !== "builtin") return;
    if (pauseTimer) clearTimeout(pauseTimer);
    const pauseMs = cfg.stt.livePreview?.cleanupPauseMs || 1000;
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      runCleanupPass(sid, cfg, signal);
    }, pauseMs);
  }

  async function runCleanupPass(sid, cfg, signal) {
    if (stale(sid, signal)) return;
    if (cleanupBusy) return; // drop-if-busy
    const raw = lastRaw;
    if (!raw || raw === lastCleanedRaw) return; // nothing new to clean
    cleanupBusy = true;
    lastCleanedRaw = raw;
    try {
      const cleaned = await runCleanup(raw, cfg.cleanup, signal);
      if (stale(sid, signal)) return;
      const text = (cleaned || "").trim();
      if (text) sendToOverlay("pipeline:partial", { kind: "cleaned", text });
    } catch {
      // Cosmetic: a failed partial cleanup just leaves the raw tail showing.
    } finally {
      cleanupBusy = false;
      // The raw text may have grown while we were cleaning; if so, clean again
      // after the next pause. Bail if the work was aborted (cancel ran during the
      // await) so a cancelled cleanup can't re-arm pauseTimer.
      if (!signal.aborted && lastRaw !== lastCleanedRaw && isCurrent(sid)) {
        scheduleCleanup(sid, cfg, signal);
      }
    }
  }

  return { handleAudio, cancel };
}

module.exports = { createLivePreview };
