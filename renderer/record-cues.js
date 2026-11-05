// Optional record cues (#341): a short rising tone when the microphone is
// really capturing, a falling one when a live take stops, and a low one when
// capture fails. Everything here is pure or takes its AudioContext injected,
// so the lifecycle and the guard are unit-tested without audio hardware; the
// overlay (renderer/overlay.js) owns the contexts and the microphone.
//
// The tones are synthesized with Web Audio — no asset files, no fetch, no
// decode latency — so each cue's length is an exact constant. The overlay
// relies on that: the start cue plays while the microphone is already open, on
// the recording context's own clock, so the capture frames it can reach (cue
// end + output and input latency + a short tail) are known exactly and dropped
// before the take begins (guardEndFrame / admitChunk), keeping the tone out of
// the transcript and the saved recording.

// Each cue: sine notes, `at`/`dur` in seconds from the cue's start. Start and
// stop stay at or under ~100 ms: the start cue's span is dropped from the
// take, so every millisecond of it is onset a hurried speaker could lose.
const CUES = {
  start: [
    { freq: 660, at: 0, dur: 0.045 },
    { freq: 880, at: 0.05, dur: 0.045 },
  ],
  stop: [
    { freq: 880, at: 0, dur: 0.045 },
    { freq: 660, at: 0.05, dur: 0.045 },
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

// After the cue's last sample leaves the speaker and reaches the capture
// timeline, this much more is dropped for room reverb and the echo canceller.
const GUARD_TAIL_S = 0.05;
// Used when the platform does not report a latency (a non-finite or negative
// value). Deliberately generous: an unknown output path may be Bluetooth
// (100–300 ms), and an unknown latency must never let the cue into the take.
const FALLBACK_OUTPUT_LATENCY_S = 0.3;
const FALLBACK_INPUT_LATENCY_S = 0.05;

// A cue's length in milliseconds, from its last note's end (0 for an unknown cue).
function cueLengthMs(name) {
  const notes = CUES[name];
  if (!notes) return 0;
  return Math.round((Math.max(...notes.map((n) => n.at + n.dur)) + CUE_LEAD_S) * 1000);
}

const knownLatency = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

// The first capture frame that may join the take after a start cue whose last
// note ends at `cueEnd` (seconds on the RECORDING context's clock — the cue is
// scheduled there, so the worklet's frames and the cue share one timeline).
// The cue leaves the speaker `outputLatency + baseLatency` after it is
// rendered and reaches the capture timeline `inputLatency` after that; then a
// short tail. No upper clamp: a long output path lengthens the guard rather
// than letting the cue's tail into the recording.
function guardEndFrame({ cueEnd, outputLatency, baseLatency, inputLatency, sampleRate }) {
  if (!Number.isFinite(cueEnd) || !(sampleRate > 0)) return 0;
  const seconds =
    cueEnd +
    knownLatency(outputLatency, FALLBACK_OUTPUT_LATENCY_S) +
    knownLatency(baseLatency, 0) +
    knownLatency(inputLatency, FALLBACK_INPUT_LATENCY_S) +
    GUARD_TAIL_S;
  return Math.ceil(seconds * sampleRate);
}

// Admit one worklet post against a guard ending at frame `until` (0 = none).
// `frame` is the capture frame of samples[0]. Returns what joins the take and
// whether the guard is spent — decided by capture position alone, so posts
// delayed or bunched by a busy renderer are cut exactly where the cue ends.
// A post without a usable frame passes whole and ends the guard: a missing
// position must never swallow the user's words.
function admitChunk(samples, frame, until) {
  if (!(until > 0) || !Number.isFinite(frame)) return { kept: samples, guardDone: true };
  const drop = Math.min(samples.length, Math.max(0, until - frame));
  return {
    kept: drop === 0 ? samples : samples.subarray(drop),
    guardDone: frame + samples.length >= until,
  };
}

// The overlay's ingestion step for one worklet post (live or in the stop
// flush), shared so both paths drop exactly the same frames. `take` holds
// `guardUntil` (null until the first post, then the guard's end frame, 0 for
// none) and `guardSpent`. On the first post `armGuard()` is called — it plays
// the start cue and returns the guard end frame (0 when no cue sounded).
// Returns the samples that join the take (possibly empty), whether this was
// the first post, and whether this post spent the guard.
function ingestPost(take, data, armGuard) {
  const first = take.guardUntil === null;
  if (first) {
    let until = 0;
    try {
      until = Number(armGuard?.()) || 0;
    } catch {}
    take.guardUntil = until;
  }
  if (take.guardSpent) return { kept: data.samples, first, guardDone: false };
  const { kept, guardDone } = admitChunk(data.samples, data.frame, take.guardUntil);
  if (guardDone) take.guardSpent = true;
  return { kept, first, guardDone };
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

// Schedule a cue on `ctx` at `volume` (0–1). Transactional: every node is
// built before any starts, and if starting fails part-way the notes already
// started are stopped and disconnected. Returns null only when nothing
// started (volume 0, no context, unknown cue, or the audio stack threw before
// any note began) — the caller then guards nothing — else a handle:
//   { name, ms, rolledBack, startTime, endTime, stop() }
// endTime bounds, on ctx's clock, everything the cue may have emitted — for a
// rolled-back cue, the started notes' own scheduled stops — so the guard still
// covers it; stop() silences the cue now.
// Never throws: a cue is a courtesy and must not break the capture code.
function playCue(ctx, name, volume) {
  const notes = CUES[name];
  const level = Number(volume);
  if (!ctx || !notes || !Number.isFinite(level) || level <= 0) return null;
  let voices;
  try {
    const peak = Math.min(1, level) * CUE_PEAK_GAIN;
    voices = notes.map((note) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      return { note, osc, env, started: false };
    });
    const t0 = ctx.currentTime + CUE_LEAD_S;
    for (const v of voices) {
      v.begin = t0 + v.note.at;
      v.end = v.begin + v.note.dur;
      v.env.gain.setValueAtTime(CUE_FLOOR_GAIN, v.begin);
      v.env.gain.exponentialRampToValueAtTime(peak, v.begin + CUE_ATTACK_S);
      v.env.gain.exponentialRampToValueAtTime(CUE_FLOOR_GAIN, v.end);
      v.osc.connect(v.env);
      v.env.connect(ctx.destination);
    }
    for (const v of voices) {
      v.osc.start(v.begin);
      v.started = true;
      v.osc.stop(v.end + 0.01);
    }
  } catch {
    if (!voices) return null;
    silenceVoices(ctx, voices);
    // Nothing started: nothing could have sounded, so nothing to guard.
    const started = voices.filter((v) => v.started);
    if (started.length === 0) return null;
    // A note started before the failure may already be audible (the clock
    // can be past its start). Keep a guard over everything it could have
    // emitted: up to its own scheduled stop, the latest bound there is.
    return cueHandle(ctx, name, started, (v) => v.end + 0.01, true);
  }
  return cueHandle(ctx, name, voices, (v) => v.end, false);
}

function cueHandle(ctx, name, voices, endOf, rolledBack) {
  let stopped = rolledBack;
  return {
    name,
    ms: cueLengthMs(name),
    rolledBack,
    startTime: Math.min(...voices.map((v) => v.begin)),
    endTime: Math.max(...voices.map(endOf)),
    stop() {
      if (stopped) return;
      stopped = true;
      silenceVoices(ctx, voices);
    },
  };
}

// Cut voices immediately: started oscillators stop now, every node is
// disconnected. Each step is guarded on its own so one failure can't keep
// another note sounding.
function silenceVoices(ctx, voices) {
  let now = 0;
  try {
    now = ctx.currentTime;
  } catch {}
  for (const v of voices) {
    if (v.started) {
      try {
        v.osc.stop(now);
      } catch {}
    }
    try {
      v.osc.disconnect();
    } catch {}
    try {
      v.env.disconnect();
    } catch {}
  }
}

// One owner for cue playback across sessions. Only one cue sounds at a time:
// a new cue, a cancel or a superseding session (begin) cuts whatever is still
// playing. park() suspends the cue context once its last cue has finished,
// and a park armed by an older session or cue is void the moment anything
// newer happens, so it can never suspend a context a newer session is using.
function createCuePlayer({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = null;
  let token = 0;
  let parkTimer = null;
  const cancelPark = () => {
    if (parkTimer !== null) clearTimer(parkTimer);
    parkTimer = null;
  };
  const silence = () => {
    token++;
    cancelPark();
    if (active) active.stop();
    active = null;
  };
  return {
    // A new session: cut any cue from the previous one, void its park.
    begin: silence,
    // Cancel/discard: the user wants quiet now.
    silence,
    play(ctx, name, volume) {
      silence();
      active = playCue(ctx, name, volume);
      return active;
    },
    // Suspend `ctx` `afterMs` from now, unless anything else happens first.
    park(ctx, afterMs) {
      cancelPark();
      const mine = ++token;
      parkTimer = setTimer(() => {
        parkTimer = null;
        if (mine !== token) return;
        active = null;
        try {
          Promise.resolve(ctx?.suspend?.()).catch(() => {});
        } catch {}
      }, afterMs);
    },
    get active() {
      return active;
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CUES,
    GUARD_TAIL_S,
    FALLBACK_OUTPUT_LATENCY_S,
    FALLBACK_INPUT_LATENCY_S,
    cueLengthMs,
    guardEndFrame,
    admitChunk,
    ingestPost,
    initialCueState,
    cueStep,
    playCue,
    createCuePlayer,
  };
}
