// Tests for the final-decode splitter: where a long recording is cut so no
// single STT decode receives more than the cap, and that the cuts land in the
// quietest available moment rather than through a word.

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

test("splitPoints: a buffer at or under the cap is not cut", () => {
  assert.deepStrictEqual(splitPoints(speech(59), SR, { maxSec: 60 }), []);
  assert.deepStrictEqual(splitPoints(speech(60), SR, { maxSec: 60 }), []);
  assert.deepStrictEqual(splitPoints(new Float32Array(0), SR, { maxSec: 60 }), []);
});

test("splitPoints: pieces cover the buffer contiguously and none exceeds the cap", () => {
  for (const seconds of [60.01, 61, 119, 120, 121, 183, 311, 600]) {
    const samples = speech(seconds);
    const cuts = splitPoints(samples, SR, { maxSec: 60 });
    const ps = pieces(cuts, samples.length);
    assert.strictEqual(ps[0][0], 0, `${seconds}s starts at 0`);
    assert.strictEqual(ps[ps.length - 1][1], samples.length, `${seconds}s ends at the end`);
    for (const [from, to] of ps) {
      assert.ok(to > from, `${seconds}s: empty piece`);
      assert.ok(to - from <= 60 * SR, `${seconds}s: piece of ${(to - from) / SR}s`);
    }
  }
});

test("splitPoints: a cut lands in the pause before the ceiling, not through speech", () => {
  // A half-second pause at 55.0-55.5 s: the cut goes to the end of the quiet
  // window inside it (the latest all-silent window), never at the 60 s ceiling.
  const cuts = splitPoints(speech(100, [[55, 55.5]]), SR, { maxSec: 60 });
  assert.strictEqual(cuts.length, 1);
  const at = cuts[0] / SR;
  assert.ok(at > 55.25 && at <= 55.5, `cut at ${at}s`);
});

test("splitPoints: a pause further back than the live 3 s window is still found", () => {
  // Final decoding has no latency budget, so it looks back 10 s by default:
  // a sentence gap 8 s before the ceiling beats cutting mid-word at 60 s.
  const cuts = splitPoints(speech(100, [[51.7, 52.1]]), SR, { maxSec: 60 });
  const at = cuts[0] / SR;
  assert.ok(at > 51.9 && at <= 52.1, `cut at ${at}s`);
  // With the live preview's 3 s window it would not be.
  const narrow = splitPoints(speech(100, [[51.7, 52.1]]), SR, { maxSec: 60, lookbackSec: 3 });
  assert.ok(narrow[0] / SR >= 57, `narrow cut at ${narrow[0] / SR}s`);
});

test("splitPoints: uninterrupted sound still cuts, as late as possible", () => {
  // Equal energy everywhere: ties go to the latest window, i.e. the ceiling.
  const cuts = splitPoints(speech(150), SR, { maxSec: 60 });
  assert.deepStrictEqual(cuts, [60 * SR, 120 * SR]);
});

test("splitPoints: a lookback longer than the cap still makes progress", () => {
  const samples = speech(30);
  const cuts = splitPoints(samples, SR, { maxSec: 5, lookbackSec: 20 });
  const ps = pieces(cuts, samples.length);
  for (const [from, to] of ps) assert.ok(to > from && to - from <= 5 * SR);
});

test("splitPoints: rejects a non-positive cap", () => {
  assert.throws(() => splitPoints(speech(1), SR, { maxSec: 0 }), /maxSec/);
});
