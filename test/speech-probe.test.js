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
// Mirrors the window length the probe measures in. Kept local rather than
// imported: the sweeps below need to step across exactly one window, and the
// module deliberately exports only the two functions its callers use.
const WINDOW_SEC = 0.3;

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

// A speaker pausing N times and a steady noise dropping out N times are the
// SAME signal at this level of detail, so the floor's window count is really
// one question: how many pauses before a quiet, unbroken level is believed to
// be a voice? The three tests below pin both sides of that answer.

test("a low-gain speaker who pauses is heard, without needing to pause constantly", () => {
  // 20 s at 0.008 RMS — never reaches the absolute bar, so only the relative
  // bar can answer, and it can only answer if the floor is measured in a pause.
  // The 10th percentile this replaced needed SEVEN quiet windows on a chunk
  // this long, so a speaker pausing three times measured their floor against
  // their own voice and came back "no speech" — and an empty decode was then
  // believed, losing the words.
  const chunk = level(20, 0.008);
  for (const at of [5, 10, 15]) speakInto(chunk, at, at + 0.7, 0.0008);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true);
});

test("one dropout in steady noise is not a voice", () => {
  // The reason the floor looks past more than one window: a single freak-quiet
  // window must not drag it down and turn a fan into a sentence, which would
  // cost a full re-decode of the recording on every noisy-room dictation.
  const chunk = level(20, 0.006);
  speakInto(chunk, 5, 5.7, 0.0002);
  assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), false);
});

test("steady room tone carries no speech however loud the room is", () => {
  // Every level under the absolute bar, unbroken: the floor sits on the tone
  // itself, so nothing stands above it. Pinned across the range because the
  // floor change only lowers thresholds — this is the property it must not cost.
  for (const rms of [0.002, 0.006, 0.01]) {
    assert.strictEqual(containsSpeech(level(20, rms), SAMPLE_RATE), false, `rms=${rms}`);
  }
});

// KNOWN LIMIT, pinned so a future change to it is deliberate rather than
// accidental. A chunk with no pause anywhere is, by RMS alone, identical to
// steady room tone: the same value in every window. The probe answers "no
// speech", which keeps a noisy room from forcing a full re-decode but means a
// low-gain speaker who never once pauses in 20 s is not covered. Separating
// the two needs evidence this module doesn't have — spectral shape, or a floor
// carried across chunks. See #109.
test("a gapless low-gain chunk is indistinguishable from room tone", () => {
  assert.strictEqual(containsSpeech(level(20, 0.008), SAMPLE_RATE), false);
});

// The window grid decides how a sound of a given length is counted, so the
// contract worth pinning is where the answer stops depending on WHERE the sound
// landed. Both tests sweep the offset across a full window.

test("a quiet 0.5s word is heard at every window alignment", () => {
  // The property a caller can rely on: past this length the verdict is a
  // function of the audio, not of where the recording happened to start.
  // Deliberately quiet — 0.004 against a 0.0006 room clears the relative bar
  // by about 2x, so this fails if the bar moves, if the window changes size, or
  // if the grid stops catching a word that straddles it. A loud burst would
  // sail over every such regression and pin nothing.
  //
  // 0.5 s is where the grid stops mattering, measured, and it is longer than
  // the 0.6/0.3 = 2 windows the constants suggest because a word lying across a
  // boundary lights both. Shorter words are still usually heard — 0.4 s at this
  // level answers "speech" at all but a sliver of alignments — but 0.5 s is the
  // point where "usually" becomes "always", so it is what can be promised.
  for (let offset = 0; offset < WINDOW_SEC; offset += 0.03) {
    const chunk = speakInto(level(10, 0.0006), 4 + offset, 4 + offset + 0.5, 0.004);
    assert.strictEqual(containsSpeech(chunk, SAMPLE_RATE), true, `offset=${offset.toFixed(2)}`);
  }
});

test("a lone click is rejected wherever it lands inside a window", () => {
  // Transient rejection is why SPEECH_MIN_SEC exists: a keyboard tap must not
  // buy a full re-decode of the recording. It survives the sweep everywhere the
  // click sits inside a single window — which is every alignment except the
  // narrow band that splits it across two. That residue is tolerated on
  // purpose (see SPEECH_MIN_SEC): erring toward "speech" costs one re-decode,
  // erring the other way costs words.
  let heard = 0;
  const offsets = [];
  for (let offset = 0; offset < WINDOW_SEC; offset += 0.005) offsets.push(offset);
  for (const offset of offsets) {
    const chunk = speakInto(level(10, 0.0006), 4 + offset, 4 + offset + 0.006, 0.5);
    if (containsSpeech(chunk, SAMPLE_RATE)) heard++;
  }
  assert.ok(heard <= offsets.length * 0.05, `click heard at ${heard}/${offsets.length} offsets`);
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
