// Did this committed chunk carry words the decoder should have found?
//
// The main process pairs the answer with the chunk's decode: audible speech
// that decodes to nothing is a hole in the committed transcript, and those
// samples must not be marked decoded or the words in them are lost for good
// (see main/live-preview.js). So the probe is deliberately asymmetric —
// a false "speech" costs one full re-decode at stop, a false "silence" costs
// the user a sentence. When in doubt, say speech.
//
// Two bars, either of which counts, checked window by window across the chunk:
//
//   absolute — a window at or above SPEECH_RMS is loud enough to be a voice on
//     its own terms. This is what catches a normal mic.
//   relative — a window standing SPEECH_OVER_FLOOR above the chunk's OWN noise
//     floor is a voice rising out of whatever the room is doing. This is what
//     catches a low-gain mic whose speech never reaches SPEECH_RMS at all;
//     without it the probe fails exactly where the decoder is likeliest to
//     return nothing.
//
// The relative bar only works if the floor is measured somewhere the speaker
// ISN'T talking, so what it really costs is pauses: the chunk has to hold at
// least FLOOR_QUIET_WINDOWS quiet windows before the floor stops sitting on
// speech. A chunk with no pause at all is, at this level of detail, the same
// signal as steady room tone — same RMS in every window — and no threshold can
// separate the two. That case stays a known limit rather than a guess: it needs
// evidence this module doesn't have (spectral shape, or a floor carried across
// chunks), and guessing "speech" there would force a full re-decode on every
// noisy-room dictation.
//
// Both bars need SPEECH_MIN_SEC of audio to clear them before the chunk counts
// as speech. A single click, a chair creak or one clipped sample is not a
// sentence, and used to be enough to force a full re-decode of the recording.
// Steady room tone clears neither bar: it is below SPEECH_RMS and it IS the
// floor, so it never stands above itself.
//
// Kept in its own file (like transcript.js) so the arithmetic is unit-testable
// without a DOM; overlay.html loads it as a plain script.

// 0.3 s matches the pause detector's window — long enough to average out a
// single glottal pulse, short enough that one word fills it.
const SPEECH_WINDOW_SEC = 0.3;
// Same value as the overlay's QUIET_RMS, kept separately on purpose: the pause
// detector answers "may I cut here", this answers "were there words here", and
// the two are free to move apart.
const SPEECH_RMS = 0.012;
// A voice sits about 10 dB over the room it is spoken in.
const SPEECH_OVER_FLOOR = 3;
// Below this everything is dither and dead air, whatever the floor computes to
// — without it, digital silence would make every window "3x the floor".
const SILENCE_RMS = 0.0015;
// The shortest thing worth calling speech. A word, not a transient.
const SPEECH_MIN_SEC = 0.6;
// How many of the quietest windows the floor has to look past. One would let a
// single dropout in otherwise steady noise drag the floor down and call the
// noise a voice; the 10th percentile this replaced needed SEVEN quiet windows
// on a 20 s chunk, so a low-gain speaker pausing six times still measured their
// floor against their own voice and came back "no speech". Three is enough
// pauses to mean the speaker really stopped, and few enough that ordinary
// speech clears it.
const FLOOR_QUIET_WINDOWS = 3;

// Root mean square of samples in [from, to).
function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

// RMS per fixed-size window, in order. A chunk too short to hold one full
// window is measured whole rather than skipped: reporting "no speech" because
// there was no room to look is the one answer that loses words.
function windowRmsSeries(samples, sampleRate) {
  const size = Math.max(1, Math.floor(SPEECH_WINDOW_SEC * sampleRate));
  const out = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    out.push(rms(samples, start, start + size));
  }
  if (!out.length && samples.length) out.push(rms(samples, 0, samples.length));
  return out;
}

// The room, as this chunk shows it: the FLOOR_QUIET_WINDOWS'th quietest window
// rather than the minimum, so one freak-quiet window can't drag the floor down
// and turn steady noise into "speech". In a chunk holding a few pauses this
// lands on a pause; in one that is wall-to-wall speech it lands on speech, and
// the absolute bar is what carries the verdict there.
//
// Counting windows rather than taking a percentile is deliberate: a percentile
// scales the evidence demanded with the LENGTH of the chunk, so the 20 s chunks
// the hard cap produces — the ones most likely to reach this probe — were the
// ones asked for the most pauses, which is backwards.
function noiseFloor(rmsSeries) {
  const sorted = [...rmsSeries].sort((a, b) => a - b);
  return sorted[Math.min(FLOOR_QUIET_WINDOWS - 1, sorted.length - 1)];
}

function containsSpeech(samples, sampleRate) {
  const series = windowRmsSeries(samples, sampleRate);
  if (!series.length) return false;
  // Whichever bar is easier to clear — min() is how "either one counts" is
  // spelled once the two bars are numbers.
  const threshold = Math.min(
    SPEECH_RMS,
    Math.max(SILENCE_RMS, noiseFloor(series) * SPEECH_OVER_FLOOR)
  );
  // Never ask for more windows than the chunk has: a chunk shorter than
  // SPEECH_MIN_SEC would otherwise be unable to report speech by arithmetic.
  const needed = Math.max(
    1,
    Math.min(series.length, Math.round(SPEECH_MIN_SEC / SPEECH_WINDOW_SEC))
  );
  let loud = 0;
  for (const windowRms of series) {
    if (windowRms >= threshold && ++loud >= needed) return true;
  }
  return false;
}

// The verdict that ships with a chunk on `audio:partial`. Only a committed
// chunk is assembled into the final transcript, so only it is worth probing —
// an in-progress tick is replaceable cosmetics, and probing one would run this
// scan over the growing live buffer on every interval for an answer nobody
// reads. Kept here rather than inline at the send site so the "committed only"
// rule is testable.
function chunkSpeechVerdict(final, samples, sampleRate) {
  return final ? containsSpeech(samples, sampleRate) : false;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { containsSpeech, chunkSpeechVerdict };
}
