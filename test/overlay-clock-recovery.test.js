const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOverlayVm, wavInts } = require("./helpers/overlay-vm");

function fixture(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wall = 0;
  const rig = createOverlayVm({ ...options, now: () => wall });
  t.after(() => rig.send("record:cancel"));
  rig.start = (sid = 371, sounds) => rig.send("record:start", { sid, sounds, maxSeconds: 30, livePreview: { enabled: false } });
  rig.advance = async (ms) => {
    while (ms > 0) {
      const step = Math.min(250, ms);
      wall += step;
      t.mock.timers.tick(step);
      await rig.settle();
      ms -= step;
    }
  };
  return rig;
}

async function capture(rig, sid) {
  rig.pump(8);
  rig.deliver();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const take = rig.messages("audio:captured").find(m => m.sid === sid);
  assert.ok(take, "the expected SID delivers audio");
  assert.ok(wavInts(take.wav).some(s => s !== 0));
  return take;
}

test("a frozen running clock rebuilds once on the same stream and SID before inviting speech", async (t) => {
  const rig = fixture(t);
  rig.start();
  await rig.settle();
  const retired = rig.contexts[0];
  const track = rig.track;
  const oldPost = rig.eval("recording.recorder.port.onmessage");
  await rig.advance(999);
  assert.equal(rig.contexts.length, 1);
  await rig.advance(1);
  assert.equal(rig.contexts.length, 2);
  assert.equal(retired.state, "closed");
  assert.equal(rig.track, track, "reuse the selected microphone grant");
  assert.equal(track.readyState, "live");
  assert.equal(rig.eval("recording.sid"), 371);
  assert.equal(rig.eval("recording.startedAt"), null);
  oldPost({ data: { samples: new Float32Array(512).fill(0.2), frame: 0, rms: 0.2 } });
  rig.deliver(); // the retired node's flush cannot claim readiness either
  assert.equal(rig.eval("recording.chunks.length"), 0);
  await capture(rig, 371);
  assert.equal(track.readyState, "ended");
  assert.equal(rig.messages("record:error").length, 0);
});

test("a second frozen clock fails at the original ten-second deadline without another retry", async (t) => {
  const rig = fixture(t);
  rig.start();
  await rig.settle();
  await rig.advance(9999);
  assert.equal(rig.contexts.length, 2);
  assert.equal(rig.messages("record:error").length, 0);
  await rig.advance(1);
  assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
  assert.equal(rig.track.readyState, "ended");
  assert.equal(rig.eval("recording"), null);
  assert.ok(rig.contexts.every(c => c.state === "closed"));
});

test("an advancing clock with held posts never rebuilds; first samples disable clock recovery", async (t) => {
  const rig = fixture(t);
  rig.start();
  await rig.settle();
  for (let i = 0; i < 12; i++) {
    rig.pump(1);
    await rig.advance(250);
  }
  assert.equal(rig.contexts.length, 1);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0);
  await rig.advance(5000); // now freeze after readiness: startup recovery is over
  assert.equal(rig.contexts.length, 1);
  assert.equal(rig.messages("record:error").length, 0);
});

for (const [label, change] of [
  ["muted track", (rig) => { rig.track.muted = true; }],
  ["disabled track", (rig) => { rig.track.enabled = false; }],
  ["ended track", (rig) => { rig.track.readyState = "ended"; }],
  ["suspended context", (rig) => { rig.contexts[0].state = "suspended"; }],
]) test(`clock recovery waits for the ordinary watchdog with a ${label}`, async (t) => {
  const rig = fixture(t);
  rig.start();
  await rig.settle();
  change(rig);
  await rig.advance(9999);
  assert.equal(rig.contexts.length, 1);
  assert.equal(rig.messages("record:error").length, 0);
  await rig.advance(1);
  assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
});

test("clock recovery requires a full frozen second after resume actually resolves", async (t) => {
  const rig = fixture(t);
  await rig.settle();
  let resume;
  rig.contexts[0].resume = () => {
    rig.contexts[0].state = "running";
    return new Promise(resolve => { resume = resolve; });
  };
  rig.start();
  await rig.settle();
  await rig.advance(2000);
  assert.equal(rig.contexts.length, 1);
  resume();
  await rig.settle();
  await rig.advance(999);
  assert.equal(rig.contexts.length, 1);
  await rig.advance(1);
  assert.equal(rig.contexts.length, 2);
});

function delayedReplacement(t) {
  let resolve;
  let reject;
  let loads = 0;
  const rig = fixture(t, { loadWorklet: () => {
    if (++loads === 2) return new Promise((yes, no) => { resolve = yes; reject = no; });
  } });
  return { rig, resolve: () => resolve(), reject: () => reject(new Error("late module failure")) };
}

for (const action of ["record:stop", "record:discard", "record:cancel"]) {
  test(`${action} during replacement warm-up preserves cancellation semantics and never resumes the cancelled take`, async (t) => {
    const { rig, resolve } = delayedReplacement(t);
    rig.start();
    await rig.settle();
    const track = rig.track;
    await rig.advance(1000);
    assert.equal(rig.contexts.length, 2);
    assert.equal(rig.eval("recording.recovering"), true);
    rig.send(action);
    resolve();
    await rig.settle();
    assert.deepEqual(rig.messages("record:cancelled").map(m => m.sid), action === "record:cancel" ? [] : [371]);
    assert.equal(rig.eval("recording"), null);
    assert.equal(track.readyState, "ended");
    assert.equal(rig.contexts[1].state, "suspended");
    await rig.advance(10000);
    assert.equal(rig.messages("record:error").length, 0);
    assert.equal(rig.messages("audio:captured").length, 0);
  });
}

test("a superseding take owns the pending replacement; stale recovery cannot resume or overwrite it", async (t) => {
  const { rig, resolve } = delayedReplacement(t);
  rig.start();
  await rig.settle();
  const retiredTrack = rig.track;
  await rig.advance(1000);
  rig.start(372);
  await rig.settle();
  assert.equal(retiredTrack.readyState, "ended");
  resolve();
  await rig.settle();
  assert.equal(rig.contexts.length, 2, "the successor shares the warming cache");
  assert.equal(rig.eval("recording.sid"), 372);
  assert.equal(rig.eval("recording.clockRetried"), false);
  await capture(rig, 372);
  assert.equal(rig.messages("record:error").length, 0);
  assert.deepEqual(rig.messages("audio:captured").map(m => m.sid), [372]);
});

for (const complete of ["resolve", "reject"]) {
  test(`timeout closes a warming replacement; its late ${complete} cannot poison the next engine`, async (t) => {
    const pending = delayedReplacement(t);
    const { rig } = pending;
    rig.start();
    await rig.settle();
    const retiredTrack = rig.track;
    await rig.advance(10000);
    assert.equal(rig.contexts.length, 2);
    assert.equal(rig.contexts[1].state, "closed");
    assert.equal(retiredTrack.readyState, "ended");
    assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
    rig.start(372);
    await rig.settle();
    const current = rig.contexts[2];
    const cached = rig.eval("audioEngineReady");
    const watchdog = rig.eval("startWatchdogId");
    pending[complete]();
    await rig.settle();
    assert.equal(rig.eval("audioContext"), current);
    assert.equal(rig.eval("audioEngineReady"), cached);
    assert.equal(rig.eval("startWatchdogId"), watchdog);
    assert.equal(current.state, "running");
    await capture(rig, 372);
    assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
  });
}

test("a replacement graph failure releases its stream, reports once and leaves the next take usable", async (t) => {
  let loads = 0;
  let disconnected = 0;
  const rig = fixture(t, { loadWorklet: (ctx) => {
    if (++loads === 2) ctx.createMediaStreamSource = () => ({
      connect() { throw new Error("source failed"); },
      disconnect() { disconnected++; },
    });
  } });
  rig.start();
  await rig.settle();
  const retiredTrack = rig.track;
  await rig.advance(1000);
  assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
  assert.equal(rig.eval("recording"), null);
  assert.equal(retiredTrack.readyState, "ended");
  assert.ok(rig.contexts.every(c => c.state === "closed"));
  assert.equal(disconnected, 1);
  assert.ok(rig.queue.every(entry => entry.owner.processor.stopped));
  rig.start(372);
  await rig.settle();
  await capture(rig, 372);
});

test("recovery plays the start cue once on the replacement and preserves its exact capture guard", async (t) => {
  const rig = fixture(t);
  rig.start(371, { volume: 0.5 });
  await rig.settle();
  await rig.advance(1000);
  const replacement = rig.contexts.filter(c => c.isRecording)[1];
  assert.ok(replacement);
  assert.equal(rig.oscillators.length, 0, "no cue before first samples");
  rig.pump(4);
  rig.deliver();
  const guard = rig.eval("recording.guardUntil");
  assert.ok(guard > 0);
  assert.equal(rig.eval("recording.startedAt"), null);
  const notes = rig.oscillators.filter(o => o.ctx.isRecording);
  assert.equal(notes.length, 2);
  assert.ok(notes.every(o => o.ctx === replacement));
  while (rig.frame < guard + 1024) rig.pump(1);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0);
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [take] = rig.messages("audio:captured");
  assert.equal(take.sid, 371);
  assert.deepEqual(wavInts(take.wav), Array.from({ length: rig.frame - guard }, (_, f) => rig.marker(guard + f)));
  assert.equal(rig.messages("record:error").length, 0);
});

test("wall-clock jumps do not shorten the measured frozen-clock interval", async (t) => {
  const rig = fixture(t);
  rig.start();
  await rig.settle();
  rig.eval("Date = class extends Date { static now() { return 9999999999999; } }");
  await rig.advance(999);
  assert.equal(rig.contexts.length, 1);
  await rig.advance(1);
  assert.equal(rig.contexts.length, 2);
});

test("a late replacement suspend completion cannot resurrect a timed-out take or alter its successor", async (t) => {
  let loads = 0;
  const suspends = [];
  const rig = fixture(t, { loadWorklet: (ctx) => {
    if (++loads === 2) ctx.suspend = () => new Promise(resolve => { suspends.push(resolve); });
  } });
  rig.start();
  await rig.settle();
  await rig.advance(10000);
  // Timeout's suspend can also be pending; the warm-up promise is the first
  // call. Resolve all parked calls below after a fresh successor takes over.
  rig.start(372);
  await rig.settle();
  const current = rig.contexts[2];
  for (const resolve of suspends) resolve();
  await rig.settle();
  assert.equal(rig.eval("audioContext"), current);
  assert.equal(current.state, "running");
  await capture(rig, 372);
  assert.deepEqual(rig.messages("record:error").map(m => m.sid), [371]);
});

test("a late initial resume completion after cancellation cannot restart recovery", async (t) => {
  const rig = fixture(t);
  await rig.settle();
  const ctx = rig.contexts[0];
  let resumed;
  ctx.resume = () => {
    ctx.state = "running";
    return new Promise(resolve => { resumed = resolve; });
  };
  rig.start();
  await rig.settle();
  await rig.advance(500);
  rig.send("record:discard");
  resumed();
  await rig.settle();
  await rig.advance(10000);
  assert.equal(rig.contexts.length, 1);
  assert.equal(rig.track.readyState, "ended");
  assert.deepEqual(rig.messages("record:cancelled").map(m => m.sid), [371]);
  assert.equal(rig.messages("record:error").length, 0);
});
