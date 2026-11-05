// Integration coverage for the record cues (#341) through the real capture
// path: the real recorder worklet posts batches tagged with their capture
// frame, and the real overlay script ingests them, plays the cues, builds
// the live-preview partials and the final WAV. Every captured sample carries
// its own frame as a marker that survives 16-bit encoding, so a WAV says
// exactly which frames it holds.

const { test } = require("node:test");
const assert = require("node:assert");

const { createOverlayVm, wavInts } = require("./helpers/overlay-vm");

const RATE = 16000;
const LATENCY = { outputLatency: 0.04, baseLatency: 0.01, inputLatency: 0.02 };
const TAIL_S = 0.05;

function startPayload(sid, { sounds = { volume: 0.5 }, preview = false } = {}) {
  return {
    sid,
    deviceId: null,
    maxSeconds: 60,
    discardHotkey: "",
    sounds,
    livePreview: preview
      ? { enabled: true, display: true, intervalMs: 3600000, chunkSeconds: 10 }
      : { enabled: false },
  };
}

// The markers a WAV must hold if it covers frames [from, to) exactly.
function expectFrames(ints, from, to, marker, label) {
  assert.strictEqual(ints.length, to - from, `${label}: ${ints.length} samples, expected frames ${from}..${to}`);
  for (let i = 0; i < ints.length; i++) {
    if (ints[i] !== marker(from + i)) {
      assert.fail(`${label}: sample ${i} holds frame marker ${ints[i]}, expected ${marker(from + i)} (frame ${from + i})`);
    }
  }
}

test("record cues: a stop after the guard ends, before the first kept post arrives, keeps that audio", async () => {
  // Latencies chosen so the guard frame falls mid-batch (frame 3872 of the
  // 3584..4096 batch): that batch is still filling when the stop lands.
  const rig = createOverlayVm({ ...LATENCY, inputLatency: 0.01 });
  rig.send("record:start", startPayload(342));
  await rig.settle();
  rig.pump(4); // one batch: the first post arms the guard
  rig.deliver();
  const guard = rig.eval("recording.guardUntil");
  // The audio thread passes the guard; the batch holding the first kept
  // frames is still being filled (not posted) when the user stops.
  while (rig.frame <= guard) rig.pump(1);
  assert.ok(rig.frame % 512 !== 0, "the batch holding the guard frame is not yet posted");
  rig.deliver(); // every full batch so far: all before the guard
  assert.strictEqual(rig.eval("totalSamples(recording.chunks)"), 0, "nothing kept yet");
  rig.send("record:stop");
  rig.deliver(); // the ordered stop flush
  await rig.settle();
  assert.strictEqual(rig.messages("record:cancelled").length, 0, "not abandoned: audio past the guard exists");
  const [captured] = rig.messages("audio:captured");
  assert.ok(captured, "the take is delivered");
  expectFrames(wavInts(captured.wav), guard, rig.frame, rig.marker, "final");
});

test("record cues: a stop inside the guard keeps nothing and abandons the attempt", async () => {
  const rig = createOverlayVm(LATENCY);
  rig.send("record:start", startPayload(343));
  await rig.settle();
  rig.pump(4);
  rig.deliver();
  rig.pump(2); // still inside the guard
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  assert.strictEqual(JSON.stringify(rig.messages("record:cancelled")), JSON.stringify([{ sid: 343 }]));
  assert.strictEqual(rig.messages("audio:captured").length, 0);
});
