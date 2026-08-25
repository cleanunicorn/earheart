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

// RMS per fixed-size window, in order. A chunk too short to hold one full
// window is measured whole rather than skipped: reporting "no speech" because
// there was no room to look is the one answer that loses words.
function windowRmsSeries(samples, sampleRate) {
  const size = Math.max(1, Math.floor(SPEECH_WINDOW_SEC * sampleRate));
  const out = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += samples[i] * samples[i];
    out.push(Math.sqrt(sum / size));
  }
  if (!out.length && samples.length) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    out.push(Math.sqrt(sum / samples.length));
  }
  return out;
}

// The room, as this chunk shows it: the 10th-percentile window rather than the
// minimum, so one freak-quiet window can't drag the floor down and turn steady
// noise into "speech". In a chunk holding any pause at all this lands on the
// pause; in one that is wall-to-wall speech it lands on speech, and the
// absolute bar is what carries the verdict there.
function noiseFloor(rmsSeries) {
  const sorted = [...rmsSeries].sort((a, b) => a - b);
  return sorted[Math.floor(0.1 * (sorted.length - 1))];
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
  for (const rms of series) {
    if (rms >= threshold && ++loud >= needed) return true;
  }
  return false;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    containsSpeech,
    SPEECH_WINDOW_SEC,
    SPEECH_RMS,
    SPEECH_OVER_FLOOR,
    SILENCE_RMS,
    SPEECH_MIN_SEC,
  };
}
