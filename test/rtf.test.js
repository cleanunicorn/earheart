// Tests for the STT realtime-factor estimator that drives the overlay's
// estimated transcribing progress bar.

const { test } = require("node:test");
const assert = require("node:assert");

const { createRtfEstimator } = require("../main/util/rtf");

test("rtf: starts from the initial guess, clamped to bounds", () => {
  assert.strictEqual(createRtfEstimator().estimate(), 0.25);
  assert.strictEqual(createRtfEstimator({ initial: 10, max: 2 }).estimate(), 2);
  assert.strictEqual(
    createRtfEstimator({ initial: 0.001, min: 0.02 }).estimate(),
    0.02
  );
});

test("rtf: record converges the EMA toward observed speed", () => {
  const rtf = createRtfEstimator({ initial: 0.25, alpha: 0.3 });
  // Machine consistently decodes 10s of audio in 1s → observed RTF 0.1.
  for (let i = 0; i < 20; i++) rtf.record(10, 1);
  assert.ok(Math.abs(rtf.estimate() - 0.1) < 0.005);
});

test("rtf: record clamps and rejects garbage inputs", () => {
  const rtf = createRtfEstimator({ initial: 0.25, min: 0.02, max: 2 });
  // Absurdly slow observation clamps at max rather than running away.
  for (let i = 0; i < 50; i++) rtf.record(1, 100);
  assert.strictEqual(rtf.estimate(), 2);

  const fresh = createRtfEstimator();
  const before = fresh.estimate();
  fresh.record(0, 1);
  fresh.record(-5, 1);
  fresh.record(10, 0);
  fresh.record(NaN, 1);
  fresh.record(10, Infinity);
  assert.strictEqual(fresh.estimate(), before);
});

test("rtf: progressAt scales with elapsed time and caps below done", () => {
  const rtf = createRtfEstimator({ initial: 0.25, cap: 0.9 });
  // 10s of audio at RTF 0.25 → expected decode 2.5s; halfway at 1.25s.
  assert.ok(Math.abs(rtf.progressAt(1.25, 10) - 0.5) < 1e-9);
  // Long past the estimate: pinned at the cap, never claims completion.
  assert.strictEqual(rtf.progressAt(60, 10), 0.9);
});

test("rtf: progressAt guards zero/invalid inputs", () => {
  const rtf = createRtfEstimator();
  assert.strictEqual(rtf.progressAt(0, 10), 0);
  assert.strictEqual(rtf.progressAt(-1, 10), 0);
  assert.strictEqual(rtf.progressAt(1, 0), 0);
  assert.strictEqual(rtf.progressAt(1, NaN), 0);
  assert.strictEqual(rtf.progressAt(NaN, 10), 0);
});
