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
//
// Dictation is not read speech, though: people hesitate mid-sentence, and the
// room clicks and breathes between thoughts. Cutting at every one of those
// pauses hands the model fragments — half a word, one word, a keyboard tap —
// with no context, and it decodes them to wrong words, stray capitals and
// invented ones ("So what Ever is it", "A You you you uh A"). Two options turn
// that back into stretches the model can read ("Dictation: hesitations and
// noise" in docs/long-recordings.md):
//
//   minSoundSec      sound shorter than this, with quiet around it, is noise
//                    (a click, a tap) and is part of the pause it sits in —
//                    it never becomes a piece of its own.
//   minUtteranceSec  a stretch with less speech than this is a fragment and
//                    joins its nearest neighbour; the decoder then sees the
//                    pause between them shortened to `keepPauseSec` (see
//                    squeezePauses), so the merged piece stays under the cap.
//
// Both default to off here, so the bare splitter keeps cutting at every pause;
// main/chunked-decode.js turns them on for the app.

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
// Shortest pause that is a cut: long enough not to split sentences at a
// breath, short enough to catch tight sentence gaps ("How short a pause
// counts" in docs/long-recordings.md).
const MIN_PAUSE_SEC = 0.2;
// Quiet a short sound needs on each side before it can count as noise. A
// plosive inside a word sits between closures shorter than this, so the
// consonant is never mistaken for a click.
const NOISE_FLANK_SEC = 0.1;

// The buffer as alternating quiet and loud runs of the sliding window, in
// order. A quiet run spans the windows it is made of; a loud run spans its
// windows too, and `sec` is its sound measured in hops — what a click lights
// is about one window plus the click, while a word lights its whole length.
function scanRuns(samples, sampleRate, quietRms) {
  const win = Math.max(1, Math.round(WINDOW_SEC * sampleRate));
  const hop = Math.max(1, Math.round(HOP_SEC * sampleRate));
  const quietSum = quietRms * quietRms * win; // compare sums, not roots
  const runs = [];
  let sum = 0;
  for (let i = 0; i < Math.min(win, samples.length); i++) sum += samples[i] * samples[i];
  for (let start = 0; start + win <= samples.length; start += hop) {
    if (start > 0) {
      // Slide the window by one hop: drop what left, add what arrived.
      for (let i = start - hop; i < start; i++) sum -= samples[i] * samples[i];
      for (let i = start + win - hop; i < start + win; i++) sum += samples[i] * samples[i];
    }
    const quiet = sum < quietSum;
    const last = runs.at(-1);
    if (last && last.quiet === quiet) {
      last.to = start + win;
      last.windows++;
    } else {
      runs.push({ quiet, from: start, to: start + win, windows: 1 });
    }
  }
  for (const r of runs) r.sec = (r.windows * hop) / sampleRate;
  return { runs, hop };
}

// Fold every loud run shorter than minSoundSec that has NOISE_FLANK_SEC of
// quiet on both sides (or the buffer's edge) into the quiet around it. Mutates
// nothing: returns a new run list.
function absorbNoise(runs, sampleRate, minSoundSec) {
  if (!(minSoundSec > 0)) return runs;
  const flank = NOISE_FLANK_SEC * sampleRate;
  const quietEnough = (r) => !r || (r.quiet && r.to - r.from >= flank);
  const out = [];
  runs.forEach((r, i) => {
    const noise = !r.quiet && r.sec < minSoundSec && quietEnough(runs[i - 1]) && quietEnough(runs[i + 1]);
    const run = { ...r, quiet: r.quiet || noise };
    const last = out.at(-1);
    if (last && last.quiet && run.quiet) {
      last.to = run.to;
      last.windows += run.windows;
      last.sec += run.sec;
    } else {
      out.push(run);
    }
  });
  return out;
}

// [from, to) of every pause: a quiet run with sound on both sides whose span
// reaches minPauseSec less one hop (it sits within one hop of the true
// silence on each side). A quiet run touching the start or end of the buffer
// separates nothing: not a pause.
function pauseSpans(
  samples,
  sampleRate,
  { minPauseSec = MIN_PAUSE_SEC, quietRms = QUIET_RMS, minSoundSec = 0 } = {}
) {
  const { runs, hop } = scanRuns(samples, sampleRate, quietRms);
  const merged = absorbNoise(runs, sampleRate, minSoundSec);
  const minSpan = minPauseSec * sampleRate - hop;
  const spans = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const r = merged[i];
    if (r.quiet && r.to - r.from >= minSpan) spans.push([r.from, r.to]);
  }
  return spans;
}

// Seconds of sound in the buffer — loud runs only, noise excluded the same
// way pauseSpans excludes it. What chunked-decode.js weighs before sending a
// piece to the decoder at all.
function soundSeconds(samples, sampleRate, { quietRms = QUIET_RMS, minSoundSec = 0 } = {}) {
  const { runs } = scanRuns(samples, sampleRate, quietRms);
  return absorbNoise(runs, sampleRate, minSoundSec)
    .filter((r) => !r.quiet)
    .reduce((s, r) => s + r.sec, 0);
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

// Group the stretches between pauses so none holds less than `minUtterance`
// samples of speech, while it can still join a neighbour. The smallest
// fragment goes first, to the neighbour across the shorter pause, and a merge
// is refused when the decoded piece — the raw range less what squeezePauses
// takes out of each long pause inside it — would exceed `max`. Returns the
// groups in order, each spanning stretches `first`..`last`; the pause after a
// group's `last` stretch stays a cut.
function utteranceGroups(samples, pauses, { minUtterance, max, keep }) {
  const edges = [0, ...pauses.map(([a, b]) => Math.round((a + b) / 2)), samples.length];
  const groups = edges.slice(1).map((to, i) => {
    // Speech in a stretch: from where its first pause ends to where its next
    // begins, or the buffer's edge (whose leading/trailing quiet the splitter
    // leaves on it anyway).
    const speechFrom = i === 0 ? 0 : pauses[i - 1][1];
    const speechTo = i === pauses.length ? samples.length : pauses[i][0];
    return { first: i, last: i, from: edges[i], to, speech: Math.max(0, speechTo - speechFrom), squeezed: 0 };
  });
  const excess = (p) => Math.max(0, p[1] - p[0] - keep);
  const done = new Set();
  for (;;) {
    let gi = -1;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.speech < minUtterance && !done.has(g) && (gi < 0 || g.speech < groups[gi].speech)) gi = i;
    }
    if (gi < 0) break;
    const g = groups[gi];
    const options = [];
    if (gi > 0) options.push({ j: gi - 1, pause: pauses[g.first - 1] });
    if (gi < groups.length - 1) options.push({ j: gi + 1, pause: pauses[g.last] });
    options.sort((a, b) => a.pause[1] - a.pause[0] - (b.pause[1] - b.pause[0]));
    const fits = options.find(({ j, pause }) => {
      const n = groups[j];
      const decoded = Math.max(g.to, n.to) - Math.min(g.from, n.from) - g.squeezed - n.squeezed - excess(pause);
      return decoded <= max;
    });
    if (!fits) {
      done.add(g);
      continue;
    }
    const n = groups[fits.j];
    const [a, b] = fits.j < gi ? [n, g] : [g, n];
    const merged = {
      first: a.first,
      last: b.last,
      from: a.from,
      to: b.to,
      speech: a.speech + b.speech,
      squeezed: a.squeezed + b.squeezed + excess(fits.pause),
    };
    groups.splice(Math.min(gi, fits.j), 2, merged);
  }
  return groups;
}

/**
 * Frame offsets at which to cut `samples`: the middle of every pause of at
 * least `minPauseSec`, plus whatever cuts keep each piece at most `maxSec`.
 * Ascending, each strictly past the previous; empty when no cut is needed.
 *
 * With `minUtteranceSec`, a stretch holding less speech than that is not cut
 * off from its nearest neighbour (see utteranceGroups): the merged piece's decoded
 * length — once squeezePauses shortens its inner pauses to `keepPauseSec` —
 * still never exceeds `maxSec`.
 * @param {Float32Array} samples mono, in [-1, 1]
 * @param {number} sampleRate
 * @param {{maxSec: number, minPauseSec?: number, quietRms?: number, minSoundSec?: number, minUtteranceSec?: number, keepPauseSec?: number, lookbackSec?: number, windowSec?: number, hopSec?: number}} opts
 * @returns {number[]}
 */
function splitPoints(
  samples,
  sampleRate,
  {
    maxSec,
    minPauseSec = MIN_PAUSE_SEC,
    quietRms = QUIET_RMS,
    minSoundSec = 0,
    minUtteranceSec = 0,
    keepPauseSec = Infinity,
    lookbackSec = 10,
    windowSec = 0.3,
    hopSec = 0.05,
  }
) {
  const max = Math.floor(maxSec * sampleRate);
  if (!(max > 0)) throw new Error(`splitPoints: maxSec must be positive (got ${maxSec})`);
  const lookback = Math.floor(lookbackSec * sampleRate);
  const windowSamples = Math.max(1, Math.floor(windowSec * sampleRate));
  const hopSamples = Math.max(1, Math.floor(hopSec * sampleRate));
  let pauses = Number.isFinite(minPauseSec) ? pauseSpans(samples, sampleRate, { minPauseSec, quietRms, minSoundSec }) : [];
  // Which pieces are merged groups: those are within the cap once squeezed,
  // so only a single stretch (no pause inside it) can need cap cuts.
  let merged = pauses.map(() => false).concat(false);
  if (minUtteranceSec > 0 && pauses.length) {
    const groups = utteranceGroups(samples, pauses, {
      minUtterance: minUtteranceSec * sampleRate,
      max,
      keep: Number.isFinite(keepPauseSec) ? keepPauseSec * sampleRate : Infinity,
    });
    merged = groups.map((g) => g.first !== g.last);
    pauses = groups.slice(0, -1).map((g) => pauses[g.last]);
  }
  const edges = [0, ...pauses.map(([a, b]) => Math.round((a + b) / 2)), samples.length];
  const cuts = [];
  for (let i = 1; i < edges.length; i++) {
    if (i > 1) cuts.push(edges[i - 1]);
    if (merged[i - 1]) continue;
    cuts.push(...capCuts(samples, edges[i - 1], edges[i], max, lookback, windowSamples, hopSamples));
  }
  return cuts;
}

/**
 * The decoder's view of one piece: every pause inside it longer than
 * `keepPauseSec` shortened to that, by dropping its middle. A piece with no
 * such pause comes back as the same array. Noise absorbed into a pause goes
 * with it when it sits in the dropped middle.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{keepPauseSec: number, minPauseSec?: number, quietRms?: number, minSoundSec?: number}} opts
 * @returns {Float32Array}
 */
function squeezePauses(samples, sampleRate, { keepPauseSec, minPauseSec = MIN_PAUSE_SEC, quietRms = QUIET_RMS, minSoundSec = 0 }) {
  if (!Number.isFinite(keepPauseSec)) return samples;
  const keep = Math.round(keepPauseSec * sampleRate);
  const drops = pauseSpans(samples, sampleRate, { minPauseSec, quietRms, minSoundSec })
    .filter(([a, b]) => b - a > keep)
    .map(([a, b]) => {
      const head = a + Math.floor(keep / 2);
      return [head, b - (keep - Math.floor(keep / 2))];
    });
  if (!drops.length) return samples;
  const dropped = drops.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Float32Array(samples.length - dropped);
  let at = 0;
  let from = 0;
  for (const [a, b] of drops) {
    out.set(samples.subarray(from, a), at);
    at += a - from;
    from = b;
  }
  out.set(samples.subarray(from), at);
  return out;
}

module.exports = { splitPoints, pauseSpans, soundSeconds, squeezePauses, QUIET_RMS };
