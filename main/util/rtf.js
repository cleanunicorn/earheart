// Realtime-factor estimator for the final STT pass. The offline decoder gives
// no progress callbacks, so the transcribing bar runs on an estimate: we know
// the audio's duration, and we learn how fast the machine decodes (RTF =
// decode seconds per audio second) from each completed run via an exponential
// moving average. `progressAt` is capped below 1 so the bar never claims to be
// done — completion is signalled by the pipeline moving to the next phase.
//
// In-memory only: the first dictation of an app session runs on the initial
// guess and calibrates the rest. Pure and injectable, so it's unit-testable.

const DEFAULTS = {
  initial: 0.25, // conservative guess: Parakeet is faster than realtime on CPU
  alpha: 0.3, // EMA weight of the newest observation
  min: 0.02,
  max: 2,
  cap: 0.9, // estimated progress never exceeds this
};

function createRtfEstimator(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let rtf = Math.min(cfg.max, Math.max(cfg.min, cfg.initial));

  function estimate() {
    return rtf;
  }

  // Fold one completed decode into the average. Non-positive or non-finite
  // inputs are ignored — a garbage sample must not poison the estimate.
  function record(audioDurationSec, elapsedSec) {
    if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return;
    if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return;
    const observed = elapsedSec / audioDurationSec;
    const next = rtf + cfg.alpha * (observed - rtf);
    rtf = Math.min(cfg.max, Math.max(cfg.min, next));
  }

  // Estimated completion ratio after `elapsedSec` of decoding `audioDurationSec`
  // of audio, capped so a too-optimistic estimate stalls visibly instead of
  // lying about being finished.
  function progressAt(elapsedSec, audioDurationSec) {
    if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return 0;
    if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return 0;
    const expected = audioDurationSec * rtf;
    if (expected <= 0) return 0;
    return Math.min(cfg.cap, elapsedSec / expected);
  }

  return { estimate, record, progressAt };
}

module.exports = { createRtfEstimator };
