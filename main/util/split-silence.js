// Where to cut a long recording so no single STT decode sees more than a
// capped span of audio (see main/final-decode.js).
//
// The shipped Parakeet model silently drops a growing share of words once one
// decode covers more than about a minute, and under Electron's utilityProcess
// the STT worker exits outright on a single buffer of ~3 minutes (#168, #169).
// So the final transcription decodes a long recording as a sequence of pieces,
// each at most `maxSec` long.
//
// A piece boundary through a word costs that word (see
// renderer/chunk-boundary.js), so each cut goes to the end of the quietest
// window in the `lookbackSec` before the ceiling — the renderer's own
// forced-boundary search, reused rather than copied. The live preview looks
// back only 3 s because it cuts while the user is still talking; the final
// decode has no such budget, so the default reaches back far enough to find
// the pause between two sentences.

// The renderer loads this file as a plain <script>; its CommonJS export guard
// is what lets the main process share the one implementation.
const { quietestOffset } = require("../../renderer/chunk-boundary");

/**
 * Frame offsets at which to cut `samples` so every piece is at most `maxSec`.
 * Ascending, each strictly past the previous; empty when no cut is needed.
 * @param {Float32Array|Int16Array} samples mono
 * @param {number} sampleRate
 * @param {{maxSec: number, lookbackSec?: number, windowSec?: number, hopSec?: number}} opts
 * @returns {number[]}
 */
function splitPoints(samples, sampleRate, { maxSec, lookbackSec = 10, windowSec = 0.3, hopSec = 0.05 }) {
  const max = Math.floor(maxSec * sampleRate);
  if (!(max > 0)) throw new Error(`splitPoints: maxSec must be positive (got ${maxSec})`);
  const lookback = Math.floor(lookbackSec * sampleRate);
  const windowSamples = Math.max(1, Math.floor(windowSec * sampleRate));
  const hopSamples = Math.max(1, Math.floor(hopSec * sampleRate));
  const cuts = [];
  let from = 0;
  while (samples.length - from > max) {
    const ceiling = from + max;
    // Never search back past the piece's own start: the cut must move forward.
    const searchFrom = Math.max(from, ceiling - lookback);
    const region = samples.subarray(searchFrom, ceiling);
    let cut = searchFrom + quietestOffset(region, windowSamples, hopSamples);
    // A search region shorter than one window (tiny caps) returns its end.
    if (cut <= from) cut = ceiling;
    cuts.push(cut);
    from = cut;
  }
  return cuts;
}

module.exports = { splitPoints };
