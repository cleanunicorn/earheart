// Live preview: the streaming partial transcript shown while recording — a
// side-channel state machine separate from the pipeline's authoritative
// record→transcribe→clean→deliver flow, which just wires it.
//
// Append-only chunking is what keeps DECODE cost flat: the overlay ships audio
// in chunks and we re-decode only the current in-progress chunk, so decode cost
// is bounded by one chunk — not the whole growing buffer, which was O(n²) and
// stalled the app after ~30s. The accumulator comments below describe the
// resulting state.
//
// Cleanup, by contrast, re-cleans the WHOLE committed transcript on each pause
// rather than appending per-chunk: `clean(a) + clean(b)` reads very differently
// from `clean(a + b)` (filler removal, sentence merging and punctuation all need
// surrounding context), so cleaning the whole thing is what makes the live
// cleaned line track the authoritative final whole-text clean. It's O(n) but
// gated to pauses and drop-if-busy, so it stays cheap in practice.
//
// All best-effort and silent: a dropped or failed partial is cosmetic and must
// never disturb the dictation.
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
  let abortController = null; // aborts in-flight partial work when recording ends

  // Append-only accumulators.
  let committedRaw = ""; // text from finalized chunks (never re-decoded)
  let committedClean = ""; // whole committed raw, cleaned in one pass (mirrors the final clean)
  let liveRaw = ""; // decode of the current in-progress chunk (replaced each tick)
  let lastCleanedRaw = ""; // the committedRaw value committedClean was produced from
  let lastSeq = -1; // highest chunk seq we've committed
  let pauseTimer = null; // fires a cleanup pass once a chunk has committed + settled

  function reset() {
    committedRaw = "";
    committedClean = "";
    liveRaw = "";
    lastCleanedRaw = "";
    lastSeq = -1;
  }

  function cancel() {
    if (abortController) {
      abortController.abort();
      abortController = null;
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
    if (!abortController) abortController = new AbortController();
    const { signal } = abortController;
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

  // After a chunk commits and the dictation settles for the pause window,
  // re-clean the WHOLE committed transcript and replace the cleaned line with the
  // result. Cleaning the whole thing (rather than appending per-chunk) is what
  // makes the live cleaned line read like the authoritative final clean.
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
    const toClean = committedRaw.trim();
    if (!toClean || toClean === lastCleanedRaw) return; // nothing new committed to clean
    cleanupBusy = true;
    try {
      const cleaned = await runCleanup(toClean, cfg.cleanup, signal);
      if (stale(sid, signal)) return; // lastCleanedRaw unchanged; a later pass retries
      const text = (cleaned || "").trim();
      if (text) {
        committedClean = text;
        lastCleanedRaw = toClean;
        sendToOverlay("pipeline:partial", { kind: "cleaned", text: committedClean });
      }
    } catch {
      // Cosmetic: a failed pass just leaves the raw tail showing. lastCleanedRaw
      // is unchanged, so the next pause re-cleans the whole transcript and retries.
    } finally {
      cleanupBusy = false;
      // More may have committed while we were cleaning; if so, re-clean after the
      // next pause. Bail if stale (cancelled/ended) so a dead pass can't re-arm.
      if (!stale(sid, signal) && committedRaw.trim() !== lastCleanedRaw) {
        scheduleCleanup(sid, cfg, signal);
      }
    }
  }

  return { handleAudio, cancel };
}

module.exports = { createLivePreview };
