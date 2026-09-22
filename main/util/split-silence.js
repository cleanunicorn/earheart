// Where to cut a recording so each STT decode gets one stretch of speech
// (see main/chunked-decode.js).
//
// The shipped Parakeet int8 model drops whole utterances when two of them
// share one decode: two sentences that each transcribe perfectly alone came
// back as just one of them — or as nothing — when joined in a 10.5 s buffer.
// The longer the buffer, the more sentence boundaries it holds, which is why a
// single decode over minutes loses a growing share of the words (#168). Every
// pause in the speech is therefore a cut; measured on 2-5 minute recordings
// this brings the word ratio back to the short-clip level
// (docs/long-recordings.md).
//
// A pause is a run of 50 ms frames below the overlay's own silence level
// (renderer/overlay.js QUIET_RMS) lasting at least `minPauseSec`, and the cut
// goes to its middle. Speech that runs past `maxSec` without a pause is cut at
// the end of the quietest window in the `lookbackSec` before the ceiling — the
// renderer's own forced-boundary search (renderer/chunk-boundary.js), reused
// rather than copied, so the cut is as unlikely as possible to split a word.

// The renderer loads this file as a plain <script>; its CommonJS export guard
// is what lets the main process share the one implementation.
const { quietestOffset } = require("../../renderer/chunk-boundary");

// Same silence level as the overlay's pause detector (renderer/overlay.js
// QUIET_RMS): audio reaches both after the same auto gain control.
const QUIET_RMS = 0.012;
const FRAME_SEC = 0.05;

// Middles of the pauses between stretches of speech. A quiet run touching the
// start or end of the buffer separates nothing, so it is not a cut.
function pauseCuts(samples, sampleRate, minPauseSec, quietRms) {
  const frame = Math.max(1, Math.round(FRAME_SEC * sampleRate));
  const minFrames = Math.ceil(minPauseSec / FRAME_SEC - 1e-9);
  const cuts = [];
  let runStart = -1; // first frame of the current quiet run
  let heardSpeech = false;
  for (let f = 0; f * frame < samples.length; f++) {
    const from = f * frame;
    const to = Math.min(samples.length, from + frame);
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    const quiet = Math.sqrt(sum / (to - from)) < quietRms;
    if (quiet) {
      if (runStart < 0) runStart = f;
    } else {
      if (runStart >= 0 && heardSpeech && f - runStart >= minFrames) {
        cuts.push(Math.round(((runStart + f) / 2) * frame));
      }
      runStart = -1;
      heardSpeech = true;
    }
  }
  return cuts;
}

// Cut points inside one stretch [from, to) so no piece exceeds `max` samples.
function capCuts(samples, from, to, max, lookback, windowSamples, hopSamples) {
  const cuts = [];
  while (to - from > max) {
    const ceiling = from + max;
    // Never search back past the piece's own start: the cut must move forward.
    const searchFrom = Math.max(from, ceiling - lookback);
    let cut = searchFrom + quietestOffset(samples.subarray(searchFrom, ceiling), windowSamples, hopSamples);
    // A search region shorter than one window (tiny caps) returns its end.
    if (cut <= from) cut = ceiling;
    cuts.push(cut);
    from = cut;
  }
  return cuts;
}

/**
 * Frame offsets at which to cut `samples`: the middle of every pause of at
 * least `minPauseSec`, plus whatever cuts keep each piece at most `maxSec`.
 * Ascending, each strictly past the previous; empty when no cut is needed.
 * @param {Float32Array} samples mono, in [-1, 1]
 * @param {number} sampleRate
 * @param {{maxSec: number, minPauseSec?: number, quietRms?: number, lookbackSec?: number, windowSec?: number, hopSec?: number}} opts
 * @returns {number[]}
 */
function splitPoints(
  samples,
  sampleRate,
  { maxSec, minPauseSec = 0.15, quietRms = QUIET_RMS, lookbackSec = 10, windowSec = 0.3, hopSec = 0.05 }
) {
  const max = Math.floor(maxSec * sampleRate);
  if (!(max > 0)) throw new Error(`splitPoints: maxSec must be positive (got ${maxSec})`);
  const lookback = Math.floor(lookbackSec * sampleRate);
  const windowSamples = Math.max(1, Math.floor(windowSec * sampleRate));
  const hopSamples = Math.max(1, Math.floor(hopSec * sampleRate));
  const pauses = Number.isFinite(minPauseSec) ? pauseCuts(samples, sampleRate, minPauseSec, quietRms) : [];
  const edges = [0, ...pauses, samples.length];
  const cuts = [];
  for (let i = 1; i < edges.length; i++) {
    if (i > 1) cuts.push(edges[i - 1]);
    cuts.push(...capCuts(samples, edges[i - 1], edges[i], max, lookback, windowSamples, hopSamples));
  }
  return cuts;
}

module.exports = { splitPoints };
