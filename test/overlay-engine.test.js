const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOverlayVm, wavInts } = require("./helpers/overlay-vm");

const start = (rig, sid) => rig.send("record:start", { sid, maxSeconds: 30, livePreview: { enabled: false } });
const cleanup = (t, rig) => t.after(() => rig.send("record:cancel"));

function holdGrant(rig) {
  rig.eval(`
    const realGrant = navigator.mediaDevices.getUserMedia;
    let grant;
    let lateTrack;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      grant = async () => {
        const stream = await realGrant();
        lateTrack = stream.getAudioTracks()[0];
        resolve(stream);
      };
    });
  `);
}

// This deliberately models state=running with a frozen render clock: no pump
// means no quantum or worklet message. It tests handling, not Chromium's cause.
test("a frozen running engine times out, releases its track and rebuilds on the next take", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = createOverlayVm();
  cleanup(t, rig);
  start(rig, 371);
  await rig.settle();
  const retired = rig.contexts[0];
  const track = rig.track;
  assert.equal(retired.state, "running");
  assert.equal(retired.currentTime, 0);
  t.mock.timers.tick(9999);
  assert.equal(rig.messages("record:error").length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(rig.messages("record:error").map((m) => m.sid), [371]);
  assert.equal(track.readyState, "ended");
  assert.equal(retired.state, "closed");
  assert.equal(rig.eval("recording"), null);
  start(rig, 372);
  await rig.settle();
  assert.notEqual(rig.contexts.at(-1), retired);
  assert.equal(rig.track.readyState, "live");
  rig.pump(8);
  rig.deliver();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [take] = rig.messages("audio:captured");
  assert.equal(take.sid, 372);
  assert.equal(wavInts(take.wav).length, 1024);
  assert.equal(retired.currentTime, 0, "a closed context's clock never follows its replacement");
});

test("stop while acquisition is pending cancels after setup; reuse captures only the new node's posts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = createOverlayVm();
  cleanup(t, rig);
  // Delay the actual grant, keeping the real record:stop / stopWhenReady path.
  holdGrant(rig);
  start(rig, 373);
  t.mock.timers.tick(30000); // an OS permission prompt may outlive the sample watchdog
  assert.equal(rig.messages("record:error").length, 0);
  rig.send("record:stop");
  assert.equal(rig.eval("stopWhenReady"), true);
  assert.equal(rig.messages("record:cancelled").length, 0);
  rig.eval("grant(); navigator.mediaDevices.getUserMedia = realGrant");
  await rig.settle();
  assert.deepEqual(rig.messages("record:cancelled").map((m) => m.sid), [373]);
  const oldTrack = rig.track;
  assert.equal(oldTrack.readyState, "ended");
  start(rig, 374);
  await rig.settle();
  assert.equal(rig.contexts.length, 1, "reuse the warmed context");
  assert.notEqual(rig.track, oldTrack);
  // A retired node's queued flush must go to that node, not the latest one.
  rig.deliver();
  assert.equal(rig.eval("recording.startedAt"), null);
  rig.pump(8);
  rig.deliver();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [take] = rig.messages("audio:captured");
  assert.equal(take.sid, 374);
  assert.deepEqual(wavInts(take.wav), Array.from({ length: 1024 }, (_, f) => rig.marker(f)));
});

test("queued samples from a superseded node cannot make its successor live", async (t) => {
  const rig = createOverlayVm();
  cleanup(t, rig);
  start(rig, 375);
  await rig.settle();
  rig.pump(4); // held in the message queue across the next start
  start(rig, 376);
  await rig.settle();
  rig.deliver();
  assert.equal(rig.eval("recording.startedAt"), null);
  assert.equal(rig.eval("recording.chunks.length"), 0);
  rig.pump(4);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0);
});

test("a superseded watchdog cannot time out the new owner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = createOverlayVm();
  cleanup(t, rig);
  start(rig, 377);
  await rig.settle();
  t.mock.timers.tick(5000);
  start(rig, 378);
  await rig.settle();
  t.mock.timers.tick(5000);
  assert.equal(rig.messages("record:error").length, 0);
  assert.equal(rig.eval("recording.sid"), 378);
  assert.equal(rig.contexts[0].state, "running");
  t.mock.timers.tick(5000);
  assert.deepEqual(rig.messages("record:error").map((m) => m.sid), [378]);
});

test("a late grant releases its own track without parking the current take", async (t) => {
  const rig = createOverlayVm();
  cleanup(t, rig);
  holdGrant(rig);
  start(rig, 379);
  rig.eval("navigator.mediaDevices.getUserMedia = realGrant");
  start(rig, 380);
  await rig.settle();
  const currentTrack = rig.track;
  await rig.eval("grant()");
  await rig.settle();
  assert.equal(rig.eval("lateTrack.readyState"), "ended");
  assert.equal(currentTrack.readyState, "live");
  assert.equal(rig.eval("recording.sid"), 380);
  assert.equal(rig.contexts[0].state, "running");
  rig.pump(4);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0);
  assert.equal(rig.messages("record:error").length, 0);
});

test("a stopped take's held tail finishes under its own SID after a new take starts", async (t) => {
  const rig = createOverlayVm();
  cleanup(t, rig);
  start(rig, 381);
  await rig.settle();
  rig.pump(6); // one live batch plus a partial batch still in the processor
  rig.deliver();
  rig.send("record:stop");
  // Hold the stop flush while the next session builds its own node.
  start(rig, 382);
  await rig.settle();
  rig.deliver();
  await rig.settle();
  const [first] = rig.messages("audio:captured");
  assert.equal(first.sid, 381);
  assert.deepEqual(wavInts(first.wav), Array.from({ length: 768 }, (_, f) => rig.marker(f)));
  assert.equal(rig.eval("recording.sid"), 382);
  assert.equal(rig.eval("recording.startedAt"), null);
  assert.equal(rig.eval("recording.chunks.length"), 0);
  rig.pump(4);
  rig.deliver();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [, second] = rig.messages("audio:captured");
  assert.equal(second.sid, 382);
  assert.deepEqual(wavInts(second.wav), Array.from({ length: 512 }, (_, f) => rig.marker(768 + f)));
});
