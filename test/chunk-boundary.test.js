// Tests for the forced chunk boundary chooser. Pure arithmetic over a sample
// buffer (no DOM), so the renderer's decision about where to cut through
// uninterrupted speech can be exercised directly.

const { test } = require("node:test");
const assert = require("node:assert");

const { quietestOffset } = require("../renderer/chunk-boundary");

const SAMPLE_RATE = 16000;
const WINDOW = Math.floor(0.3 * SAMPLE_RATE);
const HOP = Math.floor(0.05 * SAMPLE_RATE);

// A speech-ish region: loud everywhere except the gaps, which are near silent.
// `gaps` are [startSec, endSec] pairs inside a `seconds`-long buffer.
function region(seconds, gaps = []) {
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 0.25 : -0.25;
  for (const [from, to] of gaps) {
    const a = Math.floor(from * SAMPLE_RATE);
    const b = Math.floor(to * SAMPLE_RATE);
    for (let i = a; i < b; i++) samples[i] = 0;
  }
  return samples;
}

const atSec = (offset) => offset / SAMPLE_RATE;

test("a forced boundary lands in the gap between words, not on the last sample", () => {
  // Three seconds of speech with a half-second breath at 1.5s.
  const offset = quietestOffset(region(3, [[1.5, 2.0]]), WINDOW, HOP);
  assert.ok(
    atSec(offset) > 1.5 && atSec(offset) <= 2.0,
    `expected a cut inside the 1.5-2.0s gap, got ${atSec(offset)}s`
  );
});

test("the latest of several equally quiet gaps wins", () => {
  // Cutting as late as possible keeps the audio handed to the next chunk small.
  const offset = quietestOffset(region(3, [[0.5, 1.0], [2.2, 2.7]]), WINDOW, HOP);
  assert.ok(
    atSec(offset) > 2.2 && atSec(offset) <= 2.7,
    `expected the later gap, got ${atSec(offset)}s`
  );
});

test("unbroken speech cuts where the caller already was", () => {
  const samples = region(3);
  assert.strictEqual(quietestOffset(samples, WINDOW, HOP), samples.length);
});

test("a quieter passage wins even when nothing in range is silent", () => {
  // No gap crosses the silence threshold; the chooser still finds the calmest
  // stretch, which is the whole point on a noisy mic.
  const samples = region(3);
  for (let i = Math.floor(1.0 * SAMPLE_RATE); i < Math.floor(1.4 * SAMPLE_RATE); i++) {
    samples[i] = samples[i] > 0 ? 0.05 : -0.05;
  }
  const offset = quietestOffset(samples, WINDOW, HOP);
  assert.ok(
    atSec(offset) > 1.0 && atSec(offset) <= 1.4,
    `expected the calmest stretch, got ${atSec(offset)}s`
  );
});

test("a region too short to hold a window is left alone", () => {
  const samples = region(0.2);
  assert.strictEqual(quietestOffset(samples, WINDOW, HOP), samples.length);
});

test("a degenerate window or hop is left alone rather than dividing by zero", () => {
  const samples = region(3, [[1.0, 1.5]]);
  assert.strictEqual(quietestOffset(samples, 0, HOP), samples.length);
  assert.strictEqual(quietestOffset(samples, WINDOW, 0), samples.length);
});
