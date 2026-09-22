// Tests for the decode splitter: where a recording is cut so each STT decode
// gets one stretch of speech between pauses, and no decode exceeds the cap.
// The shipped Parakeet int8 model drops whole sentences when two utterances
// share one decode (docs/long-recordings.md), so pauses are the primary cut.

const { test } = require("node:test");
const assert = require("node:assert");

const { splitPoints } = require("../main/util/split-silence");

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
  assert.deepStrictEqual(splitPoints(speech(10, [[3, 3.1]]), SR, { maxSec: 20 }), []);
  assert.strictEqual(splitPoints(speech(10, [[3, 3.1]]), SR, { maxSec: 20, minPauseSec: 0.1 }).length, 1);
});

test("splitPoints: a pause's length, not its alignment, decides whether it is a cut", () => {
  // Scored on a fixed 50 ms grid, a 150 ms pause was found only when it
  // happened to start on a frame boundary (review A:correctness-3).
  for (const offsetMs of [0, 1, 10, 25, 37, 49]) {
    const at = 3 + offsetMs / 1000;
    const long = splitPoints(speech(10, [[at, at + 0.15]]), SR, { maxSec: 20 });
    assert.strictEqual(long.length, 1, `150 ms pause at +${offsetMs} ms is a cut`);
    assert.ok(Math.abs(long[0] / SR - (at + 0.075)) <= 0.01, `cut in the middle, got ${long[0] / SR}s`);
    const short = splitPoints(speech(10, [[at, at + 0.13]]), SR, { maxSec: 20 });
    assert.deepStrictEqual(short, [], `130 ms pause at +${offsetMs} ms is not`);
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
