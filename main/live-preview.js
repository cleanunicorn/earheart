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
// Beyond the on-screen preview, the committed chunk decodes double as the
// FINAL transcript's prefix: snapshotFinal() hands the pipeline the committed
// text plus how many samples it covers, so the final pass only decodes the
// audio tail instead of re-decoding the whole recording. That works even with
// the preview display off (the overlay still commits chunks; nothing is
// painted). Integrity is tracked per commit — each final chunk must start
// exactly where decoded coverage ends (`fromSample === decodedSamples`) and
// decode successfully, else the snapshot is marked broken and the final pass
// falls back to the full decode. Never lose the user's words.
//
// Dependencies are injected so the module stays free of the pipeline's private
// session/state and is unit-testable:
//   runTranscribe(wav, cfg.stt, signal) -> Promise<string>
//   runCleanup(raw, cfg.cleanup, signal) -> Promise<string>
//   sendToOverlay(channel, payload)
//   getSettings() -> settings object
//   isCurrent(sid) -> true iff sid is the active, still-recording session

const { wavSampleFrames } = require("./util/wav");

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

function createLivePreview({ runTranscribe, runCleanup, sendToOverlay, getSettings, isCurrent, onError }) {
  const reportError = onError || (() => {});
  // Count rather than a flag: a committed-chunk decode may legitimately overlap
  // an in-progress one (finals skip drop-if-busy — see handleAudio), and two
  // finishing out of order must not free the busy state early.
  let sttInFlight = 0;
  let cleanupBusy = false;
  let abortController = null; // aborts in-flight partial work when recording ends
  // The last partial-error message we surfaced. A persistent failure (e.g. the
  // model isn't downloaded) recurs every tick; dedupe so it's logged once, and
  // reset on any successful decode so a later, different failure still surfaces.
  let lastErrorLogged = "";

  // Decode accumulators — append-only; only the in-progress chunk is re-decoded,
  // so decode cost stays flat however long the dictation runs.
  let committedRaw = ""; // text from finalized chunks (never re-decoded)
  let liveRaw = ""; // decode of the current in-progress chunk (replaced each tick)
  let lastSeq = -1; // highest chunk seq we've committed
  // Final-assembly bookkeeping: committedRaw covers exactly the recording's
  // first `decodedSamples` samples — unless `broken`, which flags any hole in
  // that coverage (a final chunk dropped, failed, or arriving out of order).
  let decodedSamples = 0;
  let broken = false;
  // Cleanup change marker — the trimmed committedRaw snapshot the last cleanup
  // pass consumed. The cleaned text isn't stored (it's sent straight to the
  // overlay); this is all the cleanup side keeps. Always a trimmed value, so the
  // skip and re-arm guards both compare cleanTarget() against it in lock-step.
  let lastCleanedRaw = "";
  let pauseTimer = null; // fires a cleanup pass once a chunk has committed + settled

  function reset() {
    committedRaw = "";
    liveRaw = "";
    lastSeq = -1;
    lastCleanedRaw = "";
    decodedSamples = 0;
    broken = false;
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
    // Don't force-clear cleanupBusy: an in-flight cleanup clears it in its own
    // finally (and its aborted signal makes it drop its result). Clearing it here
    // would let a new session start a second concurrent cleanup on the engine
    // worker before the old one returns. sttInFlight is cleared so the next
    // session's raw preview isn't gated on a slow in-flight transcribe.
    sttInFlight = 0;
    reset();
  }

  // The committed transcript and the exact sample coverage it stands for, for
  // the pipeline's final assembly. Read BEFORE cancel() (which resets it).
  function snapshotFinal() {
    return { committedRaw: committedRaw.trim(), decodedSamples, broken };
  }

  // A partial is stale the moment its session ends, recording stops, or its work
  // is aborted — any of which means the result must be dropped, not shown.
  function stale(sid, signal) {
    return !isCurrent(sid) || signal.aborted;
  }

  function pushRaw() {
    sendToOverlay("pipeline:partial", { kind: "raw", text: joinText(committedRaw, liveRaw) });
  }

  // The committed transcript a cleanup pass would clean. Trimmed so it compares
  // cleanly against lastCleanedRaw; the skip guard and the re-arm guard both read
  // it, keeping "nothing new to clean" defined in exactly one place.
  function cleanTarget() {
    return committedRaw.trim();
  }

  // Handle one chunk's audio. `seq` identifies the chunk; `final` means this is
  // the last send of that chunk (commit it). A growing in-progress chunk arrives
  // as repeated non-final sends with the same seq. `fromSample` is the absolute
  // sample offset the chunk starts at — final assembly's contiguity check.
  async function handleAudio(sid, { seq, final, fromSample, wav: wavArrayBuffer } = {}) {
    if (!isCurrent(sid)) return;
    const cfg = getSettings();
    if (cfg.stt.engine !== "builtin") return;
    // Drop-if-busy applies to in-progress ticks only (cosmetic, replaceable).
    // A final chunk is sent exactly once — dropping it would punch a hole in
    // the committed transcript and force the final pass back to a full decode
    // — so it always decodes (the worker serializes; at most one extra queues,
    // since commits are many seconds apart).
    if (sttInFlight > 0 && !final) return;
    // The preview display is optional; the chunk decodes feeding the final
    // assembly are not. With the display off only finals arrive (the overlay
    // sends no in-progress ticks), and nothing is painted.
    const display = !!cfg.stt.livePreview?.enabled;
    if (!abortController) abortController = new AbortController();
    const { signal } = abortController;
    sttInFlight++;
    try {
      const wav = Buffer.from(wavArrayBuffer);
      const raw = await runTranscribe(wav, cfg.stt, signal);
      if (stale(sid, signal)) return;
      lastErrorLogged = ""; // a decode succeeded; let the next failure surface
      const text = (raw || "").trim();

      if (final && seq > lastSeq) {
        // Freeze this chunk into the committed transcript and start fresh.
        lastSeq = seq;
        committedRaw = joinText(committedRaw, text);
        liveRaw = "";
        // Contiguous coverage only: the chunk must start exactly where decoded
        // coverage ends. Anything else (an earlier final dropped or failed, an
        // out-of-order commit, an unparseable buffer) breaks the snapshot for
        // final assembly — the preview display above is unaffected.
        const frames = wavSampleFrames(wav);
        if (!broken && fromSample === decodedSamples && frames > 0) {
          decodedSamples = fromSample + frames;
        } else {
          broken = true;
        }
        if (display) {
          pushRaw();
          scheduleCleanup(sid, cfg, signal);
        }
      } else if (!final) {
        // In-progress chunk: replace the live tail. A stale in-progress result
        // for an already-committed seq must not resurrect its text.
        if (seq <= lastSeq) return;
        if (text === liveRaw) return;
        liveRaw = text;
        if (display) pushRaw();
      }
    } catch (err) {
      // A failed partial is cosmetic for the preview — but a failed FINAL chunk
      // means the committed transcript is missing words, so final assembly must
      // fall back to the full decode.
      if (final) broken = true;
      // Report (deduped) instead of eating it silently: a persistently blank
      // preview is almost always a surfaced-here error (model loading, not
      // downloaded, or a decode failure).
      const msg = err?.message || String(err);
      if (msg !== lastErrorLogged) {
        lastErrorLogged = msg;
        reportError(err);
      }
    } finally {
      sttInFlight = Math.max(0, sttInFlight - 1);
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
    const toClean = cleanTarget();
    if (!toClean || toClean === lastCleanedRaw) return; // nothing new committed to clean
    cleanupBusy = true;
    try {
      const cleaned = await runCleanup(toClean, cfg.cleanup, signal);
      if (stale(sid, signal)) return; // lastCleanedRaw unchanged; a later pass retries
      const text = (cleaned || "").trim();
      // Send first, then mark this snapshot cleaned. Advancing the marker only
      // AFTER the send means a thrown send (e.g. the overlay was torn down at
      // end-of-recording) falls through to catch with lastCleanedRaw un-advanced,
      // so the next pause retries instead of silently dropping the cleaned line.
      // An empty result is still a successful pass — it skips the send but still
      // advances the marker, so a filler-only chunk that cleans to nothing isn't
      // re-cleaned forever. Only the catch (failure) and stale paths leave the
      // marker behind to retry.
      if (text) {
        sendToOverlay("pipeline:partial", { kind: "cleaned", text });
      }
      lastCleanedRaw = toClean;
    } catch {
      // Cosmetic: a failed pass just leaves the raw tail showing. lastCleanedRaw
      // is unchanged, so the next pause re-cleans the whole transcript and retries.
    } finally {
      cleanupBusy = false;
      // More may have committed while we were cleaning; if so, re-clean after the
      // next pause. Bail if stale (cancelled/ended) so a dead pass can't re-arm.
      if (!stale(sid, signal) && cleanTarget() !== lastCleanedRaw) {
        scheduleCleanup(sid, cfg, signal);
      }
    }
  }

  return { handleAudio, cancel, snapshotFinal };
}

module.exports = { createLivePreview };
