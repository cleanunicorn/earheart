// Optional record cues (#341): a short rising tone when the microphone is
// really capturing, a falling one when a live take stops, and a low one when
// capture fails. Everything here is pure or takes its AudioContext injected,
// so the lifecycle and the guard are unit-tested without audio hardware; the
// overlay (renderer/overlay.js) owns the contexts and the microphone.
//
// The tones are synthesized with Web Audio — no asset files, no fetch, no
// decode latency — so each cue's length is an exact constant. The overlay
// relies on that: the start cue plays while the microphone is already open, so
// the samples captured during it (plus output latency and room tail) are
// dropped before the take begins (cueGuardSamples / trimGuard), keeping the
// tone out of the transcript and the saved recording.

// Each cue: sine notes, `at`/`dur` in seconds from the cue's start.
const CUES = {
  start: [
    { freq: 660, at: 0, dur: 0.055 },
    { freq: 880, at: 0.06, dur: 0.06 },
  ],
  stop: [
    { freq: 880, at: 0, dur: 0.055 },
    { freq: 660, at: 0.06, dur: 0.06 },
  ],
  // Lower and longer than the other two, so a failure never sounds like either.
  error: [
    { freq: 330, at: 0, dur: 0.09 },
    { freq: 247, at: 0.1, dur: 0.12 },
  ],
};

const CUE_ATTACK_S = 0.01;
// Full volume (1.0) peaks here, well under clipping: two notes never overlap,
// and a cue should be noticed, not startle.
const CUE_PEAK_GAIN = 0.3;
// Scheduled this far ahead of currentTime, so the first note's attack is never
// clipped by a render quantum already in progress.
const CUE_LEAD_S = 0.005;
// Exponential ramps cannot reach 0; this is inaudible.
const CUE_FLOOR_GAIN = 0.0001;

// Extra room after the cue for reverb and the echo canceller to settle, and
// the bounds of the whole guard: at least long enough to cover the tone on a
// fast output, never so long that a word started over the cue loses more than
// a syllable's onset.
const GUARD_TAIL_MS = 80;
const GUARD_MIN_MS = 150;
const GUARD_MAX_MS = 450;

// A cue's length in milliseconds, from its last note's end (0 for an unknown cue).
function cueLengthMs(name) {
  const notes = CUES[name];
  if (!notes) return 0;
  return Math.round(Math.max(...notes.map((n) => n.at + n.dur)) * 1000 + CUE_LEAD_S * 1000);
}

// How many captured samples to drop after the start cue begins: the cue, the
// output path's latency (Bluetooth adds 100–300 ms), and a tail, clamped to
// [GUARD_MIN_MS, GUARD_MAX_MS]. A cue that did not play (cueMs 0) guards
// nothing, so a failed sound never costs the user any audio.
function cueGuardSamples({ cueMs, outputLatency, baseLatency, sampleRate }) {
  if (!(cueMs > 0) || !(sampleRate > 0)) return 0;
  const seconds = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  const ms = cueMs + (seconds(outputLatency) + seconds(baseLatency)) * 1000 + GUARD_TAIL_MS;
  const clamped = Math.min(GUARD_MAX_MS, Math.max(GUARD_MIN_MS, ms));
  return Math.round((clamped * sampleRate) / 1000);
}

// Drop up to `remaining` samples from the front of a captured chunk. `kept` is
// what joins the take (possibly empty); `remaining` is what is still to drop.
function trimGuard(samples, remaining) {
  const drop = Math.max(0, Math.floor(remaining) || 0);
  if (drop === 0) return { kept: samples, remaining: 0 };
  if (samples.length <= drop) {
    return { kept: samples.subarray(0, 0), remaining: drop - samples.length };
  }
  return { kept: samples.subarray(drop), remaining: 0 };
}

// The cue lifecycle, one session (sid) at a time. Phases:
//   opening — record:start received, no samples yet
//   cueing  — first samples arrived (start cue), guard window being dropped
//   live    — guard spent, the take is capturing
//   ended   — stopped, cancelled or failed; nothing more plays for this sid
// Returns the next state and the cue to play (null for none). Pure: the caller
// plays the cue only when sounds are on, but always runs the reducer.
function initialCueState() {
  return { sid: null, phase: "ended" };
}

function cueStep(state, event) {
  const s = state || initialCueState();
  const same = { state: s, cue: null };
  if (!event || typeof event.type !== "string") return same;
  // A new session supersedes the old one silently (no stop/error for it).
  if (event.type === "start") return { state: { sid: event.sid, phase: "opening" }, cue: null };
  // Late events from a session that is no longer current change nothing.
  if (event.sid !== s.sid) return same;
  const to = (phase, cue = null) => ({ state: { sid: s.sid, phase }, cue });
  switch (s.phase) {
    case "opening":
      if (event.type === "samples") return to("cueing", "start");
      if (event.type === "stop" || event.type === "cancel") return to("ended");
      if (event.type === "error") return to("ended", "error");
      return same;
    case "cueing":
      if (event.type === "guardDone") return to("live");
      // Stopped during the cue: nothing was kept, but the user heard a start,
      // so they hear the matching stop.
      if (event.type === "stop") return to("ended", "stop");
      if (event.type === "cancel") return to("ended");
      if (event.type === "trackEnded" || event.type === "error") return to("ended", "error");
      return same;
    case "live":
      if (event.type === "stop") return to("ended", "stop");
      if (event.type === "cancel") return to("ended");
      if (event.type === "trackEnded" || event.type === "error") return to("ended", "error");
      return same;
    default:
      return same;
  }
}

// Schedule a cue on `ctx` at `volume` (0–1). Returns the cue's length in ms,
// or 0 when nothing was scheduled (sounds off, volume 0, no context, or the
// audio stack threw). Never throws: a cue is a courtesy, and a failure here
// must not reach the capture code that called it.
function playCue(ctx, name, volume) {
  const notes = CUES[name];
  const level = Number(volume);
  if (!ctx || !notes || !Number.isFinite(level) || level <= 0) return 0;
  try {
    const peak = Math.min(1, level) * CUE_PEAK_GAIN;
    // Build every node before starting any, so a throw part-way never leaves
    // half a cue playing while the caller treats it as silent.
    const voices = notes.map((note) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      osc.connect(env);
      env.connect(ctx.destination);
      return { note, osc, env };
    });
    const t0 = ctx.currentTime + CUE_LEAD_S;
    for (const { note, osc, env } of voices) {
      const begin = t0 + note.at;
      const end = begin + note.dur;
      env.gain.setValueAtTime(CUE_FLOOR_GAIN, begin);
      env.gain.exponentialRampToValueAtTime(peak, begin + CUE_ATTACK_S);
      env.gain.exponentialRampToValueAtTime(CUE_FLOOR_GAIN, end);
      osc.start(begin);
      osc.stop(end + 0.01);
    }
    return cueLengthMs(name);
  } catch {
    return 0;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CUES,
    GUARD_MIN_MS,
    GUARD_MAX_MS,
    cueLengthMs,
    cueGuardSamples,
    trimGuard,
    initialCueState,
    cueStep,
    playCue,
  };
}
