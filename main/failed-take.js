// The most recent take whose transcription failed, kept so it can be
// transcribed again without dictating it again (#293).
//
// A transient STT failure (a remote timeout, a model that failed to load) used
// to lose the recording outright: the WAV lived only as long as the pipeline
// call that failed. This holds the one most recent failed take, in memory
// only, for a short and stated time. Nothing is written to disk, so quitting
// releases it, and nothing is sent anywhere: a retry runs through whatever
// engine the user has configured at that moment.
//
// Only one take is held. A newer, longer failure replaces it (the pipeline
// keeps the longer of the two), and a new dictation that produces words
// supersedes it (the user spoke again, and it worked). Retry takes it out before
// running, so two retries can't run on the same audio; a retry that fails at
// transcription keeps it again, with a fresh lifetime. The memory bound is one
// recording: at most the max dictation length of 16 kHz 16-bit mono WAV
// (32 KB a second, about 19 MB for the default ten minutes).

const { wavDurationSec } = require("./util/wav");

// Long enough to restore a service or switch the engine in Settings; short
// enough that a recording doesn't sit in memory long after anyone cares.
const FAILED_TAKE_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{
 *   ttlMs?: number,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   onChange?: (info: object|null) => void,
 * }} [options]
 */
function createFailedTake({
  ttlMs = FAILED_TAKE_TTL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
} = {}) {
  let held = null; // { wav, expiresAt, timer }

  function info() {
    if (!held) return null;
    return {
      bytes: held.wav.length,
      seconds: wavDurationSec(held.wav),
      expiresAt: held.expiresAt,
      expiresInSec: Math.max(0, Math.ceil((held.expiresAt - now()) / 1000)),
    };
  }

  // Drop the held take; true when there was one.
  function drop() {
    if (!held) return false;
    clearTimer(held.timer);
    held = null;
    return true;
  }

  function changed() {
    try {
      onChange(info());
    } catch {
      // A listener (the tray) must never cost the user the recording.
    }
  }

  return {
    /** Hold `wav` (replacing any held take) and return its info. */
    keep(wav) {
      drop();
      const timer = setTimer(() => {
        if (held?.timer === timer && drop()) changed();
      }, ttlMs);
      // A held recording is no reason to keep the process alive.
      timer?.unref?.();
      held = { wav, expiresAt: now() + ttlMs, timer };
      changed();
      return info();
    },
    /** Take the held recording out for a retry; null when there is none. */
    take() {
      if (!held) return null;
      const { wav } = held;
      drop();
      changed();
      return wav;
    },
    /** Release the held recording; true when there was one. */
    discard() {
      const had = drop();
      if (had) changed();
      return had;
    },
    info,
  };
}

module.exports = { createFailedTake, FAILED_TAKE_TTL_MS };
