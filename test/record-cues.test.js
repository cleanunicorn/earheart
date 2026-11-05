// Tests for the record cues (#341): the cue lifecycle reducer, the start-cue
// guard that keeps the tone out of the take, and cue scheduling against a fake
// AudioContext. All pure — no audio hardware needed.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  CUES,
  GUARD_MIN_MS,
  GUARD_MAX_MS,
  cueLengthMs,
  cueGuardSamples,
  trimGuard,
  initialCueState,
  cueStep,
  playCue,
} = require("../renderer/record-cues");

const RATE = 16000;

// Run events from the initial state; returns the cues played and the end state.
function run(events, state = initialCueState()) {
  const cues = [];
  for (const event of events) {
    const out = cueStep(state, event);
    state = out.state;
    if (out.cue) cues.push(`${out.cue}:${event.sid}`);
  }
  return { cues, state };
}

const ev = (type, sid = 1) => ({ type, sid });

test("cueStep: every transition in the lifecycle table", () => {
  const rows = [
    // [from phase, event, to phase, cue]
    ["opening", "samples", "cueing", "start"],
    ["opening", "stop", "ended", null],
    ["opening", "cancel", "ended", null],
    ["opening", "error", "ended", "error"],
    ["opening", "trackEnded", "opening", null],
    ["opening", "guardDone", "opening", null],
    ["cueing", "guardDone", "live", null],
    ["cueing", "stop", "ended", "stop"],
    ["cueing", "cancel", "ended", null],
    ["cueing", "trackEnded", "ended", "error"],
    ["cueing", "error", "ended", "error"],
    ["cueing", "samples", "cueing", null],
    ["live", "stop", "ended", "stop"],
    ["live", "cancel", "ended", null],
    ["live", "trackEnded", "ended", "error"],
    ["live", "error", "ended", "error"],
    ["live", "samples", "live", null],
    ["live", "guardDone", "live", null],
    ["ended", "samples", "ended", null],
    ["ended", "stop", "ended", null],
    ["ended", "error", "ended", null],
    ["ended", "trackEnded", "ended", null],
    ["ended", "cancel", "ended", null],
  ];
  for (const [from, type, to, cue] of rows) {
    const out = cueStep({ sid: 7, phase: from }, ev(type, 7));
    assert.deepStrictEqual(out, { state: { sid: 7, phase: to }, cue }, `${from} --${type}-->`);
  }
  for (const from of ["opening", "cueing", "live", "ended"]) {
    const out = cueStep({ sid: 7, phase: from }, ev("start", 8));
    assert.deepStrictEqual(out, { state: { sid: 8, phase: "opening" }, cue: null }, `${from} --start-->`);
  }
});

test("cueStep: a stale session's events change nothing", () => {
  for (const phase of ["opening", "cueing", "live"]) {
    for (const type of ["samples", "stop", "error", "trackEnded", "guardDone", "cancel"]) {
      const state = { sid: 2, phase };
      const out = cueStep(state, ev(type, 1));
      assert.strictEqual(out.state, state);
      assert.strictEqual(out.cue, null);
    }
  }
  // Garbage in: no throw, no cue.
  assert.deepStrictEqual(cueStep(undefined, undefined), { state: initialCueState(), cue: null });
  assert.strictEqual(cueStep(null, { type: 5 }).cue, null);
});

test("cueStep sequences: rapid start → stop before samples plays nothing", () => {
  assert.deepStrictEqual(run([ev("start"), ev("stop"), ev("samples")]).cues, []);
});

test("cueStep sequences: a normal take plays one start and one stop, a second stop is silent", () => {
  const { cues, state } = run([ev("start"), ev("samples"), ev("samples"), ev("guardDone"), ev("samples"), ev("stop"), ev("stop")]);
  assert.deepStrictEqual(cues, ["start:1", "stop:1"]);
  assert.strictEqual(state.phase, "ended");
});

test("cueStep sequences: a superseding start before samples cues only the new session", () => {
  const { cues } = run([
    ev("start", 1),
    ev("start", 2),
    ev("samples", 1), // stale message from the first session's stream
    ev("samples", 2),
    ev("guardDone", 2),
    ev("stop", 1),
    ev("stop", 2),
  ]);
  assert.deepStrictEqual(cues, ["start:2", "stop:2"]);
});

test("cueStep sequences: a failed start plays only the error cue, never a start", () => {
  assert.deepStrictEqual(run([ev("start"), ev("error"), ev("samples"), ev("stop")]).cues, ["error:1"]);
});

test("cueStep sequences: a track that ends mid-take errors once, and the later stop is silent", () => {
  const { cues } = run([ev("start"), ev("samples"), ev("guardDone"), ev("trackEnded"), ev("stop"), ev("error")]);
  assert.deepStrictEqual(cues, ["start:1", "error:1"]);
});

test("cueStep sequences: a cancel in any phase plays no end cue", () => {
  assert.deepStrictEqual(run([ev("start"), ev("cancel")]).cues, []);
  assert.deepStrictEqual(run([ev("start"), ev("samples"), ev("cancel"), ev("stop")]).cues, ["start:1"]);
  assert.deepStrictEqual(run([ev("start"), ev("samples"), ev("guardDone"), ev("cancel"), ev("stop")]).cues, ["start:1"]);
});

test("cueStep sequences: stopping during the cue window pairs the start with a stop", () => {
  assert.deepStrictEqual(run([ev("start"), ev("samples"), ev("stop"), ev("guardDone")]).cues, ["start:1", "stop:1"]);
});

test("cueStep sequences: a saved-device fallback is the same path as a normal start", () => {
  // The overlay retries getUserMedia with the default device inside the same
  // session; the reducer never sees the retry, only the first samples.
  const normal = run([ev("start"), ev("samples"), ev("guardDone"), ev("stop")]).cues;
  assert.deepStrictEqual(normal, ["start:1", "stop:1"]);
});

test("cueStep invariants: at most one start and one end cue per session, end only after start", () => {
  const types = ["samples", "guardDone", "stop", "cancel", "error", "trackEnded"];
  // Every sequence of 5 events after a start.
  const total = types.length ** 5;
  for (let n = 0; n < total; n++) {
    const seq = [ev("start")];
    let k = n;
    for (let i = 0; i < 5; i++) {
      seq.push(ev(types[k % types.length]));
      k = Math.floor(k / types.length);
    }
    const { cues } = run(seq);
    const starts = cues.filter((c) => c.startsWith("start")).length;
    const ends = cues.filter((c) => !c.startsWith("start")).length;
    assert.ok(starts <= 1 && ends <= 1, `${seq.map((e) => e.type)} → ${cues}`);
    const stopAt = cues.findIndex((c) => c.startsWith("stop"));
    if (stopAt !== -1) assert.strictEqual(cues[stopAt - 1], "start:1", `${seq.map((e) => e.type)}`);
    if (stopAt !== -1) assert.ok(!cues.slice(stopAt).some((c) => c.startsWith("error")));
  }
});

test("cueLengthMs: the start cue is short, error is distinct, unknown is 0", () => {
  assert.ok(cueLengthMs("start") > 0 && cueLengthMs("start") <= 150, String(cueLengthMs("start")));
  assert.ok(cueLengthMs("stop") > 0);
  assert.ok(cueLengthMs("error") > cueLengthMs("start"));
  assert.strictEqual(cueLengthMs("nope"), 0);
  // The error cue never reuses the start/stop pitches.
  const pitches = (name) => CUES[name].map((n) => n.freq);
  for (const f of pitches("error")) {
    assert.ok(!pitches("start").includes(f) && !pitches("stop").includes(f));
  }
});

test("cueGuardSamples: covers cue + latency + tail, clamped, and 0 when no cue played", () => {
  const cueMs = cueLengthMs("start");
  // No latency known: the floor applies or cue + tail, whichever is larger.
  const base = cueGuardSamples({ cueMs, outputLatency: 0, baseLatency: 0, sampleRate: RATE });
  assert.strictEqual(base, Math.round((Math.max(GUARD_MIN_MS, cueMs + 80) * RATE) / 1000));
  // Tiny cue still gets the floor.
  assert.strictEqual(cueGuardSamples({ cueMs: 1, sampleRate: RATE }), (GUARD_MIN_MS * RATE) / 1000);
  // Latency adds in, in seconds.
  assert.strictEqual(
    cueGuardSamples({ cueMs: 100, outputLatency: 0.1, baseLatency: 0.02, sampleRate: RATE }),
    Math.round(((100 + 120 + 80) * RATE) / 1000)
  );
  // Bluetooth-scale latency is capped.
  assert.strictEqual(cueGuardSamples({ cueMs, outputLatency: 2, sampleRate: RATE }), (GUARD_MAX_MS * RATE) / 1000);
  // Unknown or garbage latency counts as 0.
  for (const bad of [NaN, undefined, -1, Infinity, "0.2"]) {
    assert.strictEqual(cueGuardSamples({ cueMs, outputLatency: bad, baseLatency: bad, sampleRate: RATE }), base, String(bad));
  }
  // A cue that did not play guards nothing.
  assert.strictEqual(cueGuardSamples({ cueMs: 0, outputLatency: 0.2, sampleRate: RATE }), 0);
  assert.strictEqual(cueGuardSamples({ cueMs: NaN, sampleRate: RATE }), 0);
  assert.strictEqual(cueGuardSamples({ cueMs, sampleRate: 0 }), 0);
});

test("trimGuard: drops exactly the guard across chunks", () => {
  const chunk = (n, offset = 0) => Float32Array.from({ length: n }, (_, i) => offset + i);
  // Chunk smaller than the guard: all dropped.
  let out = trimGuard(chunk(4), 10);
  assert.strictEqual(out.kept.length, 0);
  assert.strictEqual(out.remaining, 6);
  // Chunk equal to the remainder: all dropped, guard spent.
  out = trimGuard(chunk(6), 6);
  assert.strictEqual(out.kept.length, 0);
  assert.strictEqual(out.remaining, 0);
  // Chunk larger: the tail is kept, starting right after the guard.
  out = trimGuard(chunk(8), 3);
  assert.deepStrictEqual([...out.kept], [3, 4, 5, 6, 7]);
  assert.strictEqual(out.remaining, 0);
  // No guard: the same chunk passes through untouched.
  const c = chunk(5);
  for (const none of [0, -3, NaN]) {
    out = trimGuard(c, none);
    assert.strictEqual(out.kept, c);
    assert.strictEqual(out.remaining, 0);
  }
  // Across a stream of 512-sample chunks, kept + dropped = captured and
  // exactly `guard` samples are dropped.
  const guard = cueGuardSamples({ cueMs: cueLengthMs("start"), sampleRate: RATE });
  let remaining = guard;
  let kept = 0;
  for (let i = 0; i < 20; i++) {
    out = trimGuard(chunk(512), remaining);
    remaining = out.remaining;
    kept += out.kept.length;
  }
  assert.strictEqual(kept, 20 * 512 - guard);
});

// A fake AudioContext recording what was scheduled.
function fakeContext({ throwOn } = {}) {
  const log = { oscillators: [], gains: [] };
  const param = () => {
    const events = [];
    return {
      events,
      value: 0,
      setValueAtTime: (v, t) => events.push(["set", v, t]),
      exponentialRampToValueAtTime: (v, t) => events.push(["ramp", v, t]),
    };
  };
  const ctx = {
    currentTime: 3,
    destination: { node: "destination" },
    createOscillator() {
      if (throwOn === "oscillator") throw new Error("no audio");
      const osc = {
        type: "",
        frequency: param(),
        connect: () => {},
        start: (t) => (osc.startAt = t),
        stop: (t) => (osc.stopAt = t),
      };
      log.oscillators.push(osc);
      return osc;
    },
    createGain() {
      if (throwOn === "gain" && log.gains.length === 1) throw new Error("no gain");
      const g = { gain: param(), connect: (to) => (g.to = to) };
      log.gains.push(g);
      return g;
    },
  };
  return { ctx, log };
}

test("playCue: schedules each note, scaled by volume, within a second", () => {
  for (const name of Object.keys(CUES)) {
    const { ctx, log } = fakeContext();
    const ms = playCue(ctx, name, 0.5);
    assert.strictEqual(ms, cueLengthMs(name));
    assert.strictEqual(log.oscillators.length, CUES[name].length);
    for (const [i, osc] of log.oscillators.entries()) {
      assert.strictEqual(osc.type, "sine");
      assert.strictEqual(osc.frequency.value, CUES[name][i].freq);
      assert.ok(osc.startAt >= ctx.currentTime && osc.stopAt <= ctx.currentTime + 1);
      assert.ok(osc.stopAt > osc.startAt);
    }
    for (const g of log.gains) {
      assert.strictEqual(g.to, ctx.destination);
      const peak = Math.max(...g.gain.events.map((e) => e[1]));
      assert.ok(Math.abs(peak - 0.15) < 1e-9, `peak ${peak} = 0.3 × 0.5`);
    }
  }
  // Volume above 1 is capped at full.
  const { ctx, log } = fakeContext();
  playCue(ctx, "start", 5);
  assert.ok(Math.max(...log.gains[0].gain.events.map((e) => e[1])) <= 0.3);
});

test("playCue: off, silent or broken plays nothing and never throws", () => {
  for (const volume of [0, -1, NaN, undefined, null]) {
    const { ctx, log } = fakeContext();
    assert.strictEqual(playCue(ctx, "start", volume), 0, String(volume));
    assert.strictEqual(log.oscillators.length, 0);
  }
  assert.strictEqual(playCue(null, "start", 1), 0);
  assert.strictEqual(playCue(fakeContext().ctx, "nope", 1), 0);
  // A context whose nodes throw: 0, and nothing was started.
  const broken = fakeContext({ throwOn: "oscillator" });
  assert.strictEqual(playCue(broken.ctx, "start", 1), 0);
  const halfway = fakeContext({ throwOn: "gain" });
  assert.strictEqual(playCue(halfway.ctx, "start", 1), 0);
  assert.ok(halfway.log.oscillators.every((o) => o.startAt === undefined), "no half-cue started");
});
