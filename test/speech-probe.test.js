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

const { containsSpeech } = require("../renderer/speech-probe");

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

test("a chunk too short to hold a window is still measured", () => {
  // Never answer "no speech" because there was no room to look.
  assert.strictEqual(containsSpeech(level(0.2, 0.05), SAMPLE_RATE), true);
  assert.strictEqual(containsSpeech(level(0.2, 0), SAMPLE_RATE), false);
});
