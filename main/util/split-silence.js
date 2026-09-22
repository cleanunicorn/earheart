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
// A pause is at least `minPauseSec` below the overlay's own silence level
// (renderer/overlay.js QUIET_RMS), scored with a sliding 50 ms window, and the
// cut goes to its middle. Speech that runs past `maxSec` without a pause is cut at
// the end of the quietest window in the `lookbackSec` before the ceiling — the
// renderer's own forced-boundary search (renderer/chunk-boundary.js), reused
// rather than copied, so the cut is as unlikely as possible to split a word.

// The overlay loads renderer/chunk-boundary.js as a plain <script>
// (renderer/overlay.html); its CommonJS export guard is what lets the main
// process reuse that one dependency-free implementation.
const { quietestOffset } = require("../../renderer/chunk-boundary");

// Same silence level as the overlay's pause detector (renderer/overlay.js
// QUIET_RMS): audio reaches both after the same auto gain control. The two
// copies are pinned equal by test/overlay-contract.test.js.
const QUIET_RMS = 0.012;
// Pauses are scored with a WINDOW_SEC RMS window sliding by HOP_SEC, so a
// pause is measured to within one hop wherever it falls (a fixed 50 ms grid
// found a 150 ms pause only when it started on a frame boundary).
const WINDOW_SEC = 0.05;
const HOP_SEC = 0.005;
// Shortest pause that is a cut. Measured through this detector
// (docs/long-recordings.md): 200 ms held word ratio and WER at 150-400 ms
// sentence gaps, 250 ms missed 150 ms gaps (WER 9.1 %), and 150 ms cut often
// enough inside sentences to leave fragments the model decodes to nothing.
const MIN_PAUSE_SEC = 0.2;

// Middles of the pauses between stretches of speech. A pause is a run of quiet
// windows; the span they cover sits within one hop of the true silence on each
// side, so it counts when that span reaches minPauseSec less one hop. A quiet
// run touching the start or end of the buffer separates nothing: not a cut.
function pauseCuts(samples, sampleRate, minPauseSec, quietRms) {
  const win = Math.max(1, Math.round(WINDOW_SEC * sampleRate));
  const hop = Math.max(1, Math.round(HOP_SEC * sampleRate));
  const minSpan = minPauseSec * sampleRate - hop;
  const quietSum = quietRms * quietRms * win; // compare sums, not roots
  const cuts = [];
  let runFrom = -1; // start of the first quiet window in the current run
  let runTo = -1; // end of the last one
  let heardSpeech = false;
  let sum = 0;
  for (let i = 0; i < Math.min(win, samples.length); i++) sum += samples[i] * samples[i];
  for (let start = 0; start + win <= samples.length; start += hop) {
    if (start > 0) {
      // Slide the window by one hop: drop what left, add what arrived.
      for (let i = start - hop; i < start; i++) sum -= samples[i] * samples[i];
      for (let i = start + win - hop; i < start + win; i++) sum += samples[i] * samples[i];
    }
    if (sum < quietSum) {
      if (runFrom < 0) runFrom = start;
      runTo = start + win;
    } else {
      if (runFrom >= 0 && heardSpeech && runTo - runFrom >= minSpan) {
        cuts.push(Math.round((runFrom + runTo) / 2));
      }
      runFrom = -1;
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
  { maxSec, minPauseSec = MIN_PAUSE_SEC, quietRms = QUIET_RMS, lookbackSec = 10, windowSec = 0.3, hopSec = 0.05 }
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

module.exports = { splitPoints, QUIET_RMS };
