// Tests for the committed-chunk speech probe. Pure arithmetic over a sample
// buffer (no DOM), so the renderer's "were there words in here" verdict — the
// one that decides whether an empty decode is believed — can be exercised
// directly.
//
// Every signal below alternates sign at full rate, so a buffer filled with
// amplitude `a` has RMS exactly `a` and the thresholds can be reasoned about
// as numbers rather than approximated.

const { test } = require("node:test");
const assert = require("node:assert");

const { containsSpeech, chunkSpeechVerdict } = require("../renderer/speech-probe");

const SAMPLE_RATE = 16000;

// A `seconds`-long buffer at a constant RMS.
function level(seconds, amplitude) {
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? amplitude : -amplitude;
  return samples;
}

// Overwrite [fromSec, toSec) with a constant RMS — a sentence dropped into a
// room, loud or quiet.
function speakInto(samples, fromSec, toSec, amplitude) {
  const a = Math.floor(fromSec * SAMPLE_RATE);
  const b = Math.floor(toSec * SAMPLE_RATE);
  for (let i = a; i < b; i++) samples[i] = i % 2 ? amplitude : -amplitude;
  return samples;
}

test("digital silence carries no speech", () => {
  assert.strictEqual(containsSpeech(level(12, 0), SAMPLE_RATE), false);
});

test("steady room tone carries no speech", () => {
  // 0.007 RMS of air conditioning for the whole chunk: under the absolute bar,
  // and it IS the floor, so it never stands above itself.
  assert.strictEqual(containsSpeech(level(12, 0.007), SAMPLE_RATE), false);
});

test("a sentence at the end of a long silence carries speech", () => {
  // The shape that broke: 11 s of thinking, then the tail nobody wants to lose.
  const chunk = speakInto(level(12, 0.0002), 11, 12, 0.05);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true);
});

test("a whole chunk of uninterrupted speech carries speech", () => {
  // No pause anywhere, so the chunk's own floor sits at speech level and only
  // the absolute bar can answer.
  assert.strictEqual(containsSpeech(level(12, 0.05), SAMPLE_RATE), true);
});

test("a low-gain mic's speech carries speech", () => {
  // 0.008 RMS never reaches the absolute bar — the old probe called this
  // silence and let the empty decode cover it, losing the words.
  const chunk = speakInto(level(12, 0.0008), 4, 6, 0.008);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true);
});

test("a quiet voice over audible room tone carries speech", () => {
  const chunk = speakInto(level(12, 0.002), 4, 6, 0.008);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true);
});

test("a single loud transient does not carry speech", () => {
  // 6 ms of keyboard at 0.5, well inside one window. Loud, but not a word —
  // and calling it one would force a full re-decode of the whole recording.
  const chunk = level(12, 0);
  speakInto(chunk, 5.1, 5.106, 0.5);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), false);
});

// The two cases below pin decision boundaries rather than comfortable
// middles. Both were checked by mutation: without them, tightening the
// threshold comparison to `>` or raising the window minimum to 3 leaves the
// whole suite green.

test("a window landing exactly on the threshold counts as speech", () => {
  // 0.001953125 is 2^-9, so every RMS below is computed exactly: a window of
  // constant magnitude f has RMS exactly f, and one at 3f has RMS exactly 3f.
  // The room is f throughout, so the relative bar sits at exactly 3f — the
  // loud windows land ON the threshold, not above it.
  const floorAmp = 0.001953125;
  const chunk = level(12, floorAmp);
  speakInto(chunk, 0, 0.6, 3 * floorAmp);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true);
});

test("two loud windows are speech, one is not", () => {
  // 0.3 s windows: [0, 0.6) is exactly two, [0, 0.3) exactly one. The bar is
  // 0.6 s of audio, so two clears it and one must not — in both directions.
  const two = level(12, 0);
  speakInto(two, 0, 0.6, 0.05);
  assert.strictEqual(containsSpeech(two, SAMPLE_RATE), true);

  const one = level(12, 0);
  speakInto(one, 0, 0.3, 0.05);
  assert.strictEqual(containsSpeech(one, SAMPLE_RATE), false);
});

test("a chunk too short to hold a window is still measured", () => {
  // Never answer "no speech" because there was no room to look.
  assert.strictEqual(containsSpeech(level(0.2, 0.05), SAMPLE_RATE), true);
  assert.strictEqual(containsSpeech(level(0.2, 0), SAMPLE_RATE), false);
});

// The send site ships this verdict on `audio:partial`; only the committed
// chunk is assembled into the final transcript, so only it is probed.
test("only a committed chunk is probed", () => {
  const speech = level(12, 0.05);
  const silence = level(12, 0);
  assert.strictEqual(chunkSpeechVerdict(true, speech, SAMPLE_RATE), true);
  assert.strictEqual(chunkSpeechVerdict(true, silence, SAMPLE_RATE), false);
  // An in-progress tick answers false without looking — probing the growing
  // live buffer every interval would burn the scan for an answer nobody reads.
  assert.strictEqual(chunkSpeechVerdict(false, speech, SAMPLE_RATE), false);
});
