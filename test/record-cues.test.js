// Tests for the record cues (#341): the cue lifecycle reducer, the start-cue
// guard that keeps the tone out of the take, and cue scheduling against a fake
// AudioContext. All pure — no audio hardware needed.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  CUES,
  GUARD_TAIL_S,
  FALLBACK_OUTPUT_LATENCY_S,
  FALLBACK_INPUT_LATENCY_S,
  cueLengthMs,
  guardEndFrame,
  admitChunk,
  initialCueState,
  cueStep,
  playCue,
  createCuePlayer,
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
  // The start cue's span is dropped from the take, so it stays short.
  assert.ok(cueLengthMs("start") > 0 && cueLengthMs("start") <= 100, String(cueLengthMs("start")));
  assert.ok(cueLengthMs("stop") > 0);
  assert.ok(cueLengthMs("error") > cueLengthMs("start"));
  assert.strictEqual(cueLengthMs("nope"), 0);
  // The error cue never reuses the start/stop pitches.
  const pitches = (name) => CUES[name].map((n) => n.freq);
  for (const f of pitches("error")) {
    assert.ok(!pitches("start").includes(f) && !pitches("stop").includes(f));
  }
});

test("guard budget: the post-cue tail stays at or under 50 ms (amendment A2)", () => {
  // An independent bound, not derived from the constant: a longer tail is
  // more of every hurried first word lost.
  assert.ok(GUARD_TAIL_S > 0 && GUARD_TAIL_S <= 0.05, String(GUARD_TAIL_S));
  assert.ok(cueLengthMs("start") <= 100 && cueLengthMs("stop") <= 100);
});

test("guardEndFrame: cue end + output + input latency + tail, with no upper clamp", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) <= 1, `${a} ≈ ${b}`);
  near(
    guardEndFrame({ cueEnd: 2, outputLatency: 0.02, baseLatency: 0.01, inputLatency: 0.01, sampleRate: RATE }),
    (2 + 0.02 + 0.01 + 0.01 + GUARD_TAIL_S) * RATE
  );
  // Bluetooth-scale output latency lengthens the guard; nothing caps it.
  near(
    guardEndFrame({ cueEnd: 2, outputLatency: 0.6, baseLatency: 0, inputLatency: 0, sampleRate: RATE }),
    (2 + 0.6 + GUARD_TAIL_S) * RATE
  );
  // Unknown latencies take the conservative fallbacks, never 0.
  for (const bad of [undefined, NaN, -1, Infinity, "0.01"]) {
    near(
      guardEndFrame({ cueEnd: 2, outputLatency: bad, baseLatency: bad, inputLatency: bad, sampleRate: RATE }),
      (2 + FALLBACK_OUTPUT_LATENCY_S + FALLBACK_INPUT_LATENCY_S + GUARD_TAIL_S) * RATE
    );
  }
  // No cue end or no rate: no guard.
  assert.strictEqual(guardEndFrame({ cueEnd: NaN, sampleRate: RATE }), 0);
  assert.strictEqual(guardEndFrame({ cueEnd: 1, sampleRate: 0 }), 0);
});

test("admitChunk: cuts each post at the guard frame by capture position", () => {
  const chunk = (n, frame) => Float32Array.from({ length: n }, (_, i) => frame + i);
  // Entirely before the guard end: dropped, guard continues.
  let out = admitChunk(chunk(4, 0), 0, 10);
  assert.deepStrictEqual([...out.kept], []);
  assert.strictEqual(out.guardDone, false);
  // Straddling: kept from the guard frame on, guard spent.
  out = admitChunk(chunk(8, 6), 6, 10);
  assert.deepStrictEqual([...out.kept], [10, 11, 12, 13]);
  assert.strictEqual(out.guardDone, true);
  // Ends exactly at the guard: nothing kept, guard spent.
  out = admitChunk(chunk(4, 6), 6, 10);
  assert.deepStrictEqual([...out.kept], []);
  assert.strictEqual(out.guardDone, true);
  // After the guard / no guard / no frame: passes whole.
  const c = chunk(5, 20);
  for (const [frame, until] of [[20, 10], [20, 0], [NaN, 10], [undefined, 10]]) {
    out = admitChunk(c, frame, until);
    assert.strictEqual(out.kept, c, `${frame} ${until}`);
    assert.strictEqual(out.guardDone, true);
  }
});

// The overlay's gate, replayed: every sample's value is its own capture frame
// (an identifiable marker), the cue sounds over a known frame range, and the
// posts arrive however a busy renderer delivers them. Nothing captured before
// the guard end may reach the take, and nothing after it may be lost.
function replayCapture({ batches, cueAtFrame, ctxLatency }) {
  const batch = 512;
  let until = null;
  const kept = [];
  let cueEndFrame = null;
  for (const group of batches) {
    // `group` posts arrive in one burst after a stall; the main thread only
    // learns of them now, and its currentTime is the frame it last saw.
    for (const index of group) {
      const frame = index * batch;
      const samples = Float32Array.from({ length: batch }, (_, i) => frame + i);
      if (until === null) {
        // First post: the cue is scheduled now, on the recording clock.
        const { ctx } = fakeContext({ currentTime: cueAtFrame / RATE });
        const cue = playCue(ctx, "start", 1);
        cueEndFrame = cue.endTime * RATE;
        until = guardEndFrame({ cueEnd: cue.endTime, ...ctxLatency, sampleRate: RATE });
      }
      const out = admitChunk(samples, frame, until);
      kept.push(...out.kept);
    }
  }
  return { kept, until, cueEndFrame };
}

test("start-cue guard: the cue window never reaches the take, however posts arrive", () => {
  const latency = { outputLatency: 0.04, baseLatency: 0.01, inputLatency: 0.02 };
  const scenarios = {
    steady: { batches: Array.from({ length: 40 }, (_, i) => [i]), cueAtFrame: 0 },
    // A renderer stall: the first eight posts arrive together, late. The main
    // thread's clock has run ahead by then, so the cue is scheduled later.
    bunched: { batches: [[0, 1, 2, 3, 4, 5, 6, 7], ...Array.from({ length: 32 }, (_, i) => [i + 8])], cueAtFrame: 8 * 512 },
    // The first post is delivered a full second after capture began.
    late: { batches: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], ...Array.from({ length: 40 }, (_, i) => [i + 32])], cueAtFrame: RATE },
  };
  for (const [name, { batches, cueAtFrame }] of Object.entries(scenarios)) {
    const { kept, until, cueEndFrame } = replayCapture({ batches, cueAtFrame, ctxLatency: latency });
    const total = batches.flat().length * 512;
    assert.ok(until > cueEndFrame, name);
    // Every kept sample was captured after the cue (plus latency and tail).
    assert.ok(kept.length > 0 && kept[0] === until, `${name}: first kept frame ${kept[0]} = guard end ${until}`);
    // And nothing after the guard was lost: kept is contiguous to the end.
    assert.strictEqual(kept.length, total - until, name);
    assert.strictEqual(kept[kept.length - 1], total - 1, name);
  }
});

// A fake AudioContext recording what was scheduled. `throwOn` names a step
// that throws: "oscillator", "gain" (second gain), "connect", "start2"
// (the second note's start, after the first has started).
function fakeContext({ throwOn, currentTime = 3 } = {}) {
  const log = { oscillators: [], gains: [], suspends: 0 };
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
    currentTime,
    destination: { node: "destination" },
    suspend: async () => {
      log.suspends++;
    },
    createOscillator() {
      if (throwOn === "oscillator") throw new Error("no audio");
      const osc = {
        type: "",
        frequency: param(),
        stops: [],
        connect: () => {
          if (throwOn === "connect") throw new Error("no route");
        },
        disconnect: () => (osc.disconnected = true),
        start: (t) => {
          if (throwOn === "start2" && log.oscillators.indexOf(osc) === 1) throw new Error("start failed");
          osc.startAt = t;
        },
        stop: (t) => osc.stops.push(t),
      };
      log.oscillators.push(osc);
      return osc;
    },
    createGain() {
      if (throwOn === "gain" && log.gains.length === 1) throw new Error("no gain");
      const g = { gain: param(), connect: (to) => (g.to = to), disconnect: () => (g.disconnected = true) };
      log.gains.push(g);
      return g;
    },
  };
  return { ctx, log };
}

test("playCue: schedules each note, scaled by volume, within a second", () => {
  for (const name of Object.keys(CUES)) {
    const { ctx, log } = fakeContext();
    const cue = playCue(ctx, name, 0.5);
    assert.strictEqual(cue.ms, cueLengthMs(name));
    assert.strictEqual(cue.name, name);
    assert.strictEqual(log.oscillators.length, CUES[name].length);
    for (const [i, osc] of log.oscillators.entries()) {
      assert.strictEqual(osc.type, "sine");
      assert.strictEqual(osc.frequency.value, CUES[name][i].freq);
      assert.ok(osc.startAt >= ctx.currentTime && osc.stops[0] <= ctx.currentTime + 1);
      assert.ok(osc.stops[0] > osc.startAt);
      assert.ok(osc.stops[0] <= cue.endTime + 0.011, "nothing sounds past endTime");
    }
    assert.ok(Math.abs(cue.endTime - cue.startTime - (cue.ms / 1000 - 0.005)) < 1e-9);
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

test("playCue: off or silent plays nothing", () => {
  for (const volume of [0, -1, NaN, undefined, null]) {
    const { ctx, log } = fakeContext();
    assert.strictEqual(playCue(ctx, "start", volume), null, String(volume));
    assert.strictEqual(log.oscillators.length, 0);
  }
  assert.strictEqual(playCue(null, "start", 1), null);
  assert.strictEqual(playCue(fakeContext().ctx, "nope", 1), null);
});

test("playCue: a failure at any stage leaves nothing sounding and never throws", () => {
  for (const stage of ["oscillator", "gain", "connect", "start2"]) {
    const { ctx, log } = fakeContext({ throwOn: stage });
    const cue = playCue(ctx, "start", 1);
    // Null only when nothing started; a note that began keeps its guard.
    if (stage === "start2") assert.ok(cue && cue.rolledBack, stage);
    else assert.strictEqual(cue, null, stage);
    for (const osc of log.oscillators) {
      if (osc.startAt !== undefined) {
        // Started before the failure: stopped at once, not left to finish.
        assert.ok(osc.stops.includes(ctx.currentTime), `${stage}: started note stopped now`);
      }
      // Once anything was wired up, everything is unwired again; a failure
      // while still creating nodes leaves them unconnected and unstarted.
      if (stage === "connect" || stage === "start2") assert.ok(osc.disconnected, `${stage}: oscillator disconnected`);
      else assert.strictEqual(osc.startAt, undefined, `${stage}: nothing started`);
    }
    if (stage === "connect" || stage === "start2") {
      for (const g of log.gains) assert.ok(g.disconnected, `${stage}: gain disconnected`);
    } else {
      for (const g of log.gains) assert.strictEqual(g.to, undefined, `${stage}: gain never connected`);
    }
  }
  // The start2 case really did start a note before failing.
  const { ctx, log } = fakeContext({ throwOn: "start2" });
  playCue(ctx, "start", 1);
  assert.ok(log.oscillators[0].startAt !== undefined);
});

test("playCue: stop() cuts the cue now, once", () => {
  const { ctx, log } = fakeContext();
  const cue = playCue(ctx, "start", 1);
  ctx.currentTime = 3.02;
  cue.stop();
  cue.stop();
  for (const osc of log.oscillators) {
    assert.deepStrictEqual(osc.stops.slice(1), [3.02]);
    assert.ok(osc.disconnected);
  }
});

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      timers.set(next, { fn, ms });
      return next++;
    },
    clearTimer: (id) => timers.delete(id),
    runAll() {
      for (const [id, { fn }] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    timers,
  };
}

test("createCuePlayer: a new cue, a cancel, or a new session cuts the cue in flight", () => {
  const timers = fakeTimers();
  const player = createCuePlayer(timers);
  const { ctx, log } = fakeContext();
  // Stopped during the start cue: the start is cut at once, the stop plays.
  player.play(ctx, "start", 1);
  ctx.currentTime = 3.03;
  const stop = player.play(ctx, "stop", 1);
  assert.deepStrictEqual(log.oscillators[0].stops.slice(1), [3.03]);
  assert.deepStrictEqual(log.oscillators[1].stops.slice(1), [3.03]);
  assert.strictEqual(log.oscillators[2].stops.length, 1, "the stop cue is not cut");
  assert.strictEqual(player.active, stop);
  // A superseding session cuts the stop cue.
  ctx.currentTime = 3.05;
  player.begin();
  assert.deepStrictEqual(log.oscillators[2].stops.slice(1), [3.05]);
  assert.strictEqual(player.active, null);
  // Cancel cuts too.
  player.play(ctx, "start", 1);
  ctx.currentTime = 3.06;
  player.silence();
  assert.deepStrictEqual(log.oscillators[4].stops.slice(1), [3.06]);
});

test("createCuePlayer: a stale park never suspends a context a newer session uses", () => {
  const timers = fakeTimers();
  const player = createCuePlayer(timers);
  const { ctx, log } = fakeContext();
  player.play(ctx, "stop", 1);
  player.park(ctx, 1000);
  // The next session starts before the park fires.
  player.begin();
  timers.runAll();
  assert.strictEqual(log.suspends, 0, "begin voided the old park");
  // A park overtaken by a new cue is void as well.
  player.park(ctx, 1000);
  const stale = [...timers.timers.values()][0].fn;
  player.play(ctx, "error", 1);
  stale();
  assert.strictEqual(log.suspends, 0);
  // An uninterrupted park suspends exactly once.
  player.park(ctx, 1000);
  timers.runAll();
  assert.strictEqual(log.suspends, 1);
  // A context whose suspend throws doesn't throw out of the timer.
  player.park({ suspend: () => { throw new Error("closed"); } }, 10);
  assert.doesNotThrow(() => timers.runAll());
});

test("playCue: a failure after the first note started still guards what it emitted", () => {
  const { ctx, log } = fakeContext({ throwOn: "start2" });
  // The audio clock runs on between the two starts: past note one's start,
  // so note one is already audible when note two's start throws.
  const realStart = ctx.createOscillator;
  ctx.createOscillator = function () {
    const osc = realStart.call(this);
    const start = osc.start;
    osc.start = (t) => {
      start(t);
      ctx.currentTime = t + 0.02;
    };
    return osc;
  };
  const cue = playCue(ctx, "start", 1);
  assert.ok(cue, "not null: a note sounded");
  assert.strictEqual(cue.rolledBack, true);
  const first = log.oscillators[0];
  assert.ok(first.startAt !== undefined && ctx.currentTime > first.startAt, "clock is past note one's start");
  assert.ok(first.stops.includes(ctx.currentTime), "note one is cut now");
  assert.ok(first.disconnected && log.oscillators[1].disconnected);
  assert.strictEqual(log.oscillators[1].startAt, undefined, "note two never started");
  // The bound covers note one up to its own scheduled stop, never less.
  assert.ok(cue.endTime >= Math.max(...first.stops), `${cue.endTime} ≥ ${Math.max(...first.stops)}`);
  assert.ok(cue.endTime >= first.startAt + CUES.start[0].dur);
  // So the guard is not zero, and covers it plus latency and tail.
  const until = guardEndFrame({ cueEnd: cue.endTime, outputLatency: 0, baseLatency: 0, inputLatency: 0, sampleRate: RATE });
  assert.ok(until >= Math.ceil((first.startAt + CUES.start[0].dur + GUARD_TAIL_S) * RATE));
  // stop() on a rolled-back handle is a no-op (already silenced).
  const stopsBefore = first.stops.length;
  cue.stop();
  assert.strictEqual(first.stops.length, stopsBefore);
});
