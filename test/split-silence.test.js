// Tests for the decode splitter: where a recording is cut so each STT decode
// gets one stretch of speech between pauses, and no decode exceeds the cap.
// The shipped Parakeet int8 model drops whole sentences when two utterances
// share one decode (docs/long-recordings.md), so pauses are the primary cut.

const { test } = require("node:test");
const assert = require("node:assert");

const { splitPoints, fitCap, pauseSpans, soundSeconds, squeezePauses } = require("../main/util/split-silence");

const SR = 16000;

// Loud "speech" everywhere except the given [startSec, endSec] gaps.
function speech(seconds, gaps = []) {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 0.25 : -0.25;
  for (const [from, to] of gaps) samples.fill(0, Math.floor(from * SR), Math.floor(to * SR));
  return samples;
}

// The pieces the cut points describe, as [from, to) frame pairs.
function pieces(cuts, total) {
  const edges = [0, ...cuts, total];
  return edges.slice(1).map((to, i) => [edges[i], to]);
}

const NO_PAUSES = { minPauseSec: Infinity };

test("splitPoints: uninterrupted speech at or under the cap is not cut", () => {
  assert.deepStrictEqual(splitPoints(speech(19), SR, { maxSec: 20 }), []);
  assert.deepStrictEqual(splitPoints(speech(20), SR, { maxSec: 20 }), []);
  assert.deepStrictEqual(splitPoints(new Float32Array(0), SR, { maxSec: 20 }), []);
});

test("splitPoints: every pause between words is a cut, at its middle", () => {
  // Pauses of 0.5 s at 3 s and 0.2 s at 7 s: two utterance boundaries.
  const cuts = splitPoints(speech(10, [[3, 3.5], [7, 7.2]]), SR, { maxSec: 20 });
  assert.strictEqual(cuts.length, 2);
  assert.ok(Math.abs(cuts[0] / SR - 3.25) <= 0.05, `first cut at ${cuts[0] / SR}s`);
  assert.ok(Math.abs(cuts[1] / SR - 7.1) <= 0.05, `second cut at ${cuts[1] / SR}s`);
});

test("splitPoints: a pause shorter than minPauseSec is not a cut", () => {
  assert.deepStrictEqual(splitPoints(speech(10, [[3, 3.15]]), SR, { maxSec: 20 }), []);
  assert.strictEqual(splitPoints(speech(10, [[3, 3.15]]), SR, { maxSec: 20, minPauseSec: 0.15 }).length, 1);
});

test("splitPoints: a pause's length, not its alignment, decides whether it is a cut", () => {
  // Scored on a fixed 50 ms grid, a threshold-length pause was found only
  // when it started on a frame boundary (review A:correctness-3).
  for (const offsetMs of [0, 1, 10, 25, 37, 49]) {
    const at = 3 + offsetMs / 1000;
    const long = splitPoints(speech(10, [[at, at + 0.2]]), SR, { maxSec: 20 });
    assert.strictEqual(long.length, 1, `200 ms pause at +${offsetMs} ms is a cut`);
    assert.ok(Math.abs(long[0] / SR - (at + 0.1)) <= 0.01, `cut in the middle, got ${long[0] / SR}s`);
    const short = splitPoints(speech(10, [[at, at + 0.18]]), SR, { maxSec: 20 });
    assert.deepStrictEqual(short, [], `180 ms pause at +${offsetMs} ms is not`);
  }
});

test("splitPoints: leading and trailing silence are not boundaries", () => {
  // Quiet at both ends of the buffer separates nothing from nothing.
  assert.deepStrictEqual(splitPoints(speech(10, [[0, 1], [9, 10]]), SR, { maxSec: 20 }), []);
});

test("splitPoints: quiet but not silent audio counts as a pause below quietRms", () => {
  const s = speech(10);
  for (let i = 3 * SR; i < 3.5 * SR; i++) s[i] = i % 2 ? 0.005 : -0.005; // RMS 0.005 < 0.012
  assert.strictEqual(splitPoints(s, SR, { maxSec: 20 }).length, 1);
  for (let i = 3 * SR; i < 3.5 * SR; i++) s[i] = i % 2 ? 0.05 : -0.05; // RMS 0.05: still speech
  assert.strictEqual(splitPoints(s, SR, { maxSec: 20 }).length, 0);
});

test("splitPoints: pieces tile the buffer and none exceeds the cap", () => {
  const cases = [
    speech(61),
    speech(183),
    speech(311, [[5, 5.3], [100, 101], [250, 250.2]]),
    speech(600, Array.from({ length: 40 }, (_, i) => [i * 13 + 6, i * 13 + 6.4])),
  ];
  for (const samples of cases) {
    const ps = pieces(splitPoints(samples, SR, { maxSec: 20 }), samples.length);
    assert.strictEqual(ps[0][0], 0);
    assert.strictEqual(ps.at(-1)[1], samples.length);
    for (let i = 1; i < ps.length; i++) assert.strictEqual(ps[i][0], ps[i - 1][1]);
    for (const [from, to] of ps) {
      assert.ok(to > from, "empty piece");
      assert.ok(to - from <= 20 * SR, `piece of ${(to - from) / SR}s`);
    }
  }
});

test("splitPoints: past the cap with no pause, the cut goes to the quietest moment before the ceiling", () => {
  // A dip too short to be a pause (0.1 s) 6 s before the 20 s ceiling: the
  // backstop cut lands there rather than through the loudest part.
  const s = speech(30, [[13.9, 14.0]]);
  const cuts = splitPoints(s, SR, { maxSec: 20 });
  assert.strictEqual(cuts.length, 1);
  assert.ok(cuts[0] / SR > 13.9 && cuts[0] / SR <= 14.2, `cut at ${cuts[0] / SR}s`);
});

test("splitPoints: uninterrupted sound past the cap still cuts, as late as possible", () => {
  // Equal energy everywhere: ties go to the latest window, i.e. the ceiling.
  assert.deepStrictEqual(splitPoints(speech(50), SR, { maxSec: 20, ...NO_PAUSES }), [20 * SR, 40 * SR]);
});

test("splitPoints: a lookback longer than the cap still makes progress", () => {
  const samples = speech(30);
  const ps = pieces(splitPoints(samples, SR, { maxSec: 5, lookbackSec: 20 }), samples.length);
  for (const [from, to] of ps) assert.ok(to > from && to - from <= 5 * SR);
});

test("splitPoints: rejects a non-positive cap", () => {
  assert.throws(() => splitPoints(speech(1), SR, { maxSec: 0 }), /maxSec/);
});

/* ---------------- dictation: noise and fragments ---------------- */

// Silence with loud stretches at the given [startSec, endSec] ranges — the
// shape of a dictation: sound only where something is said (or clicked).
function sounds(seconds, loud) {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (const [from, to] of loud) {
    for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) samples[i] = i % 2 ? 0.25 : -0.25;
  }
  return samples;
}

const DICTATION = { minSoundSec: 0.15, minUtteranceSec: 2, keepPauseSec: 0.5 };

test("pauseSpans: a click with quiet around it is part of the pause, not a piece", () => {
  // Speech, a 1 s pause with a 20 ms click in its middle, speech.
  const samples = sounds(10, [[0, 4], [4.99, 5.01], [6, 10]]);
  assert.strictEqual(pauseSpans(samples, SR).length, 2, "off: the click splits the pause in two");
  const spans = pauseSpans(samples, SR, { minSoundSec: 0.15 });
  assert.strictEqual(spans.length, 1);
  assert.ok(Math.abs(spans[0][0] / SR - 4) < 0.06 && Math.abs(spans[0][1] / SR - 6) < 0.06, `one pause ${spans[0].map((x) => x / SR)}`);
});

test("pauseSpans: the hotkey's click at the start is not an utterance", () => {
  const samples = sounds(6, [[0, 0.02], [1, 6]]);
  assert.strictEqual(pauseSpans(samples, SR).length, 1, "off: click, pause, speech");
  assert.deepStrictEqual(pauseSpans(samples, SR, { minSoundSec: 0.15 }), []);
});

test("pauseSpans: a short word is sound, not noise", () => {
  // A 0.3 s "yes" between two 1 s pauses keeps both pauses.
  const samples = sounds(8, [[0, 3], [4, 4.3], [5.3, 8]]);
  assert.strictEqual(pauseSpans(samples, SR, { minSoundSec: 0.15 }).length, 2);
});

test("pauseSpans: a consonant burst inside a word is not taken for a click", () => {
  // Closures shorter than the noise flank on either side of a 30 ms burst.
  const samples = sounds(4, [[0, 1.5], [1.56, 1.59], [1.65, 4]]);
  assert.deepStrictEqual(pauseSpans(samples, SR, { minSoundSec: 0.15 }), []);
});

test("soundSeconds: counts words, not clicks", () => {
  assert.ok(soundSeconds(sounds(3, [[1, 1.02]]), SR, { minSoundSec: 0.15 }) === 0);
  assert.ok(soundSeconds(sounds(3, [[1, 1.3]]), SR, { minSoundSec: 0.15 }) >= 0.3);
  assert.ok(soundSeconds(sounds(3, [[1, 1.02]]), SR) > 0, "off: the click is sound");
});

test("splitPoints: a fragment after a hesitation joins the neighbour across the shorter pause", () => {
  // "Five seconds of speech… ever… five more": 0.8 s, then 3 s, around 0.6 s.
  const samples = sounds(15.4, [[0, 5], [5.8, 6.4], [9.4, 15.4]]);
  assert.strictEqual(splitPoints(samples, SR, { maxSec: 20 }).length, 2, "off: the fragment is its own piece");
  const cuts = splitPoints(samples, SR, { maxSec: 20, ...DICTATION });
  assert.strictEqual(cuts.length, 1);
  assert.ok(Math.abs(cuts[0] / SR - 7.9) < 0.06, `the 3 s pause stays the cut: ${cuts[0] / SR}s`);
});

test("splitPoints: stretches of real speech still cut at every pause", () => {
  // Utterances long enough to stand alone keep the #168 behaviour.
  const samples = sounds(13, [[0, 4], [4.3, 8.3], [8.6, 13]]);
  assert.strictEqual(splitPoints(samples, SR, { maxSec: 20, ...DICTATION }).length, 2);
});

test("splitPoints: a fragment merges across a long pause when squeezing keeps it under the cap", () => {
  // 0.5 s alone between two 5 s pauses; merged and squeezed it is 6 s.
  const samples = sounds(26, [[0, 5], [10, 10.5], [15.5, 26]]);
  const cuts = splitPoints(samples, SR, { maxSec: 20, ...DICTATION });
  assert.strictEqual(cuts.length, 1, `one cut: ${cuts.map((c) => c / SR)}`);
  // Raw, the merged piece is longer than its decode; squeezed it fits.
  const ps = pieces(cuts, samples.length);
  for (const [from, to] of ps) {
    assert.ok(squeezePauses(samples.subarray(from, to), SR, { keepPauseSec: 0.5 }).length <= 20 * SR);
  }
});

test("splitPoints: a fragment that cannot join without passing the cap stays alone", () => {
  // Either merge would make a 20.6 s piece.
  const samples = sounds(40.3, [[0, 19.5], [19.9, 20.4], [20.8, 40.3]]);
  const cuts = splitPoints(samples, SR, { maxSec: 20, ...DICTATION });
  assert.strictEqual(cuts.length, 2);
  for (const [from, to] of pieces(cuts, samples.length)) assert.ok(to - from <= 20 * SR);
});

test("splitPoints: fragments merge with each other when no utterance is near", () => {
  // Four 0.4 s words, 0.6 s apart: one piece, not four.
  const samples = sounds(5, [[0, 0.4], [1, 1.4], [2, 2.4], [3, 3.4]]);
  assert.deepStrictEqual(splitPoints(samples, SR, { maxSec: 20, ...DICTATION }), []);
});

test("squeezePauses: long inner pauses shrink to keepPauseSec, the speech is untouched", () => {
  const samples = sounds(9, [[0, 3], [6, 9]]);
  const out = squeezePauses(samples, SR, { keepPauseSec: 0.5 });
  assert.ok(Math.abs(out.length / SR - 6.5) < 0.02, `${out.length / SR}s`);
  const loud = (a) => a.reduce((n, x) => n + (x !== 0 ? 1 : 0), 0);
  assert.strictEqual(loud(out), loud(samples));
  assert.strictEqual(squeezePauses(sounds(3, [[0, 3]]), SR, { keepPauseSec: 0.5 }).length, 3 * SR);
  const noPause = sounds(3, [[0, 3]]);
  assert.strictEqual(squeezePauses(noPause, SR, { keepPauseSec: 0.5 }), noPause, "nothing to squeeze: same array");
  assert.strictEqual(squeezePauses(samples, SR, { keepPauseSec: Infinity }), samples);
});

test("splitPoints: a pause that absorbed noise is cut in its quiet, never through the noise", () => {
  // A 0.08 s sound at 3.2 s, flanked by 0.2 s of quiet: one pause, cut in
  // the middle of its longer quiet part rather than its own middle (3.24 s).
  const samples = sounds(6.48, [[0, 3], [3.2, 3.28], [3.38, 6.48]]);
  const cuts = splitPoints(samples, SR, { maxSec: 20, minSoundSec: 0.15 });
  assert.strictEqual(cuts.length, 1);
  assert.ok(cuts[0] < 3.2 * SR || cuts[0] > 3.28 * SR, `cut at ${cuts[0] / SR}s`);
});

test("squeezePauses: sound absorbed as noise is kept, only quiet is dropped", () => {
  // 3 s, 1 s quiet, a 20 ms click, 1 s quiet, 3 s: each quiet side shrinks
  // to 0.5 s, the click survives.
  const samples = sounds(7.02, [[0, 3], [4, 4.02], [5.02, 7.02]]);
  const out = squeezePauses(samples, SR, { keepPauseSec: 0.5, minSoundSec: 0.15 });
  const loud = (a) => a.reduce((n, x) => n + (x !== 0 ? 1 : 0), 0);
  assert.strictEqual(loud(out), loud(samples), "every sound sample kept");
  assert.ok(Math.abs(out.length / SR - 6.02) < 0.06, `${out.length / SR}s`);
});

test("fitCap: a range is only cut when its squeezed decode would pass the cap", () => {
  const samples = sounds(32, [[0, 1], [31, 32]]);
  const opts = { maxSec: 20, minSoundSec: 0.15, keepPauseSec: 0.5 };
  assert.deepStrictEqual(fitCap(samples, SR, 0, samples.length, opts), [], "squeezed it is 2.5 s");
  // From 0 to 22.5 s the quiet runs to the range's edge: nothing to squeeze.
  const cuts = fitCap(samples, SR, 0, 22.5 * SR, opts);
  assert.ok(cuts.length >= 1 && cuts.every((c) => c > 0 && c < 22.5 * SR));
  assert.ok(cuts[0] <= 20 * SR);
});
