// Realtime-factor estimator for the final STT pass. The offline decoder gives
// no progress callbacks, so the transcribing bar runs on an estimate: we know
// the audio's duration, and we learn how fast the machine decodes (RTF =
// decode seconds per audio second) from each completed run via an exponential
// moving average. `progressAt` is capped below 1 so the bar never claims to be
// done — completion is signalled by the pipeline moving to the next phase.
//
// The EMA is what keeps the estimate tracking "the last few transcriptions":
// each observation pulls the value `alpha` of the way toward itself, so a run
// from ten dictations ago contributes (1-alpha)^10 ≈ under 3% — old history
// decays away by construction, no window bookkeeping needed.
//
// `createPersistedRtfEstimator` wraps the pure estimator with a small JSON
// state file (history.js pattern) so calibration survives app restarts. All
// file I/O is best-effort: a missing/corrupt file just falls back to the
// initial guess, and a failed save must never disturb a dictation.

const fs = require("node:fs");

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

// Estimator seeded from — and saved back to — a JSON state file, so the
// learned decode speed carries across app restarts. The file holds the current
// EMA value ({ "rtf": 0.08 }), which already encodes the recency weighting;
// persisting it is equivalent to replaying the recent runs on the next launch.
function createPersistedRtfEstimator(filePath, options = {}) {
  let initial;
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Number.isFinite(stored?.rtf) && stored.rtf > 0) initial = stored.rtf;
  } catch {
    // Missing or corrupt state: start from the default guess.
  }
  const inner = createRtfEstimator(
    initial !== undefined ? { ...options, initial } : options
  );

  function record(audioDurationSec, elapsedSec) {
    const before = inner.estimate();
    inner.record(audioDurationSec, elapsedSec);
    if (inner.estimate() === before) return; // rejected sample: nothing new
    try {
      fs.writeFileSync(filePath, JSON.stringify({ rtf: inner.estimate() }));
    } catch {
      // Best effort — this session still benefits from the in-memory value.
    }
  }

  return { estimate: inner.estimate, record, progressAt: inner.progressAt };
}

module.exports = { createRtfEstimator, createPersistedRtfEstimator };
