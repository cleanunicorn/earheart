// Live preview: while recording, transcribe the audio and push a partial
// transcript to the overlay. This is the second, side-channel state machine of a
// dictation — separate from the pipeline's authoritative record→transcribe→clean
// →deliver flow — so it lives in its own module and the pipeline just wires it.
//
// Append-only chunking (the key to flat cost): the overlay ships audio in
// chunks. Each tick it sends the CURRENT in-progress chunk (the audio recorded
// since the last committed boundary); when that chunk reaches its length it's
// sent once more marked `final`. We re-decode only the in-progress chunk, so
// decode cost is bounded by the chunk length (~5s) no matter how long the
// dictation runs — instead of re-decoding the whole growing buffer every tick
// (which was O(n²) and ground the app to a halt after ~30s). On `final` we append
// the chunk's text to the committed transcript and never touch that audio again.
//
// Raw shown = committedRaw + the live (in-progress) chunk's text.
// Cleanup is likewise incremental: when a chunk commits, only its new text is
// cleaned and appended to the committed cleaned line — never the whole transcript.
//
// STT and cleanup live in separate engine workers, so partial STT and partial
// cleanup run in parallel. Within each worker requests are serialized, so a
// drop-if-busy flag per stage keeps partials from queueing up behind real time.
//
// One thing the worker split does NOT buy us: partial STT and the pipeline's
// *final* transcribe share the same STT worker, and a dispatched worker request
// isn't cancellable mid-inference. So if the user stops while a partial decode is
// in flight, the final transcribe waits for it to finish (bounded by one chunk's
// decode — now small). cancel() prevents *new* partial work from starting.
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
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

function createLivePreview({ runTranscribe, runCleanup, sendToOverlay, getSettings, isCurrent }) {
  let sttBusy = false;
  let cleanupBusy = false;
  let abort = null; // aborts in-flight partial work when recording ends

  // Append-only accumulators.
  let committedRaw = ""; // text from finalized chunks (never re-decoded)
  let committedClean = ""; // cleaned text from finalized chunks
  let liveRaw = ""; // decode of the current in-progress chunk (replaced each tick)
  let pendingClean = ""; // committed raw not yet reflected in committedClean
  let lastSeq = -1; // highest chunk seq we've committed
  let pauseTimer = null; // fires a cleanup pass once a chunk has committed + settled

  function reset() {
    committedRaw = "";
    committedClean = "";
    liveRaw = "";
    pendingClean = "";
    lastSeq = -1;
  }

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
    reset();
  }

  // A partial is stale the moment its session ends, recording stops, or its work
  // is aborted — any of which means the result must be dropped, not shown.
  function stale(sid, signal) {
    return !isCurrent(sid) || signal.aborted;
  }

  function pushRaw() {
    sendToOverlay("pipeline:partial", { kind: "raw", text: joinText(committedRaw, liveRaw) });
  }

  // Handle one chunk's audio. `seq` identifies the chunk; `final` means this is
  // the last send of that chunk (commit it). A growing in-progress chunk arrives
  // as repeated non-final sends with the same seq.
  async function handleAudio(sid, { seq, final, wav: wavArrayBuffer } = {}) {
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
      if (stale(sid, signal)) return;
      const text = (raw || "").trim();

      if (final && seq > lastSeq) {
        // Freeze this chunk into the committed transcript and start fresh.
        lastSeq = seq;
        committedRaw = joinText(committedRaw, text);
        liveRaw = "";
        pendingClean = joinText(pendingClean, text);
        pushRaw();
        scheduleCleanup(sid, cfg, signal);
      } else {
        // In-progress chunk: replace the live tail.
        if (text === liveRaw) return;
        liveRaw = text;
        pushRaw();
      }
    } catch {
      // Cosmetic: ignore failed partials entirely; the final pass is authoritative.
    } finally {
      sttBusy = false;
    }
  }

  // After a chunk commits and the dictation settles for the pause window, clean
  // ONLY the newly committed text (pendingClean) and append it to the cleaned
  // line. Flat cost — we never re-clean the whole transcript.
  function scheduleCleanup(sid, cfg, signal) {
    // Only clean live when cleanup is on and runs in-process: a remote cleanup
    // endpoint shouldn't be hit repeatedly mid-dictation. The final pass on stop
    // still cleans the whole authoritative transcript regardless of engine.
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
    const toClean = pendingClean.trim();
    if (!toClean) return; // nothing new committed to clean
    cleanupBusy = true;
    pendingClean = "";
    try {
      const cleaned = await runCleanup(toClean, cfg.cleanup, signal);
      if (stale(sid, signal)) {
        // Put the text back so a later (non-stale) pass still cleans it.
        pendingClean = joinText(toClean, pendingClean);
        return;
      }
      const text = (cleaned || "").trim();
      if (text) {
        committedClean = joinText(committedClean, text);
        sendToOverlay("pipeline:partial", { kind: "cleaned", text: committedClean });
      }
    } catch {
      // Cosmetic: a failed partial cleanup just leaves the raw tail showing.
      // Restore the pending text so the next pass retries it.
      pendingClean = joinText(toClean, pendingClean);
    } finally {
      cleanupBusy = false;
      // More may have committed while we were cleaning; if so, clean it after the
      // next pause. Bail if aborted so a cancelled cleanup can't re-arm pauseTimer.
      if (!signal.aborted && pendingClean.trim() && isCurrent(sid)) {
        scheduleCleanup(sid, cfg, signal);
      }
    }
  }

  return { handleAudio, cancel };
}

module.exports = { createLivePreview };
