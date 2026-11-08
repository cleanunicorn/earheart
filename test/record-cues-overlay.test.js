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

// The frame the take must start at, computed independently from what the
// overlay scheduled: the start cue's last oscillator stop, plus latencies and
// the tail. A cue-era frame is anything before it.
function startCueBound(rig, latency = LATENCY) {
  const startNotes = rig.oscillators.filter((o) => o.ctx.sampleRate === RATE);
  assert.ok(startNotes.length > 0, "the start cue was scheduled on the recording context");
  const cueEnd = Math.max(...startNotes.map((o) => o.stops[0])) - 0.01;
  return (cueEnd + latency.outputLatency + latency.baseLatency + latency.inputLatency + TAIL_S) * RATE;
}

for (const [label, latency] of [
  ["speakers", LATENCY],
  // A Bluetooth-scale output path: the guard grows with it, uncapped.
  ["bluetooth", { ...LATENCY, outputLatency: 0.6 }],
]) test(`record cues (${label}): delayed, bunched posts never put the start cue into a partial or the final WAV`, async () => {
  const rig = createOverlayVm(latency);
  rig.send("record:start", startPayload(341, { preview: true }));
  await rig.settle();

  // The audio thread runs ahead of a stalled page: 8 batches are captured
  // before the page sees any of them, then the first arrives alone.
  rig.pump(32);
  rig.deliver(1);
  const guard = rig.eval("recording.guardUntil");
  const bound = startCueBound(rig, latency);
  assert.ok(guard >= Math.floor(bound), `guard ${guard} covers the cue + latency + tail (${bound.toFixed(1)})`);
  assert.ok(guard % 512 !== 0, "a batch straddles the guard boundary");
  assert.strictEqual(rig.eval("recording.startedAt"), null, "not Listening… during the guard");

  // Capture well past the guard, delivered as one burst.
  while (rig.frame < guard + RATE / 2) rig.pump(1);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0, "Listening… once kept samples arrive");

  // A live-preview partial: it covers the take from its first kept frame.
  rig.eval("sendPartial()");
  const [partial] = rig.messages("audio:partial");
  assert.strictEqual(partial.fromSample, 0);
  const keptSoFar = rig.eval("totalSamples(recording.chunks)");
  expectFrames(wavInts(partial.wav), guard, guard + keptSoFar, rig.marker, "partial");

  // More capture, a held-back post, then stop: the stop flush and the
  // in-flight post both join the take, contiguous to the last captured frame.
  rig.pump(10);
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [captured] = rig.messages("audio:captured");
  assert.ok(captured, `stop delivers the take (${JSON.stringify(rig.sent.map((m) => m.channel))})`);
  expectFrames(wavInts(captured.wav), guard, rig.frame, rig.marker, "final");
});

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

test("record cues: with sounds off the take keeps every frame from the first post", async () => {
  const rig = createOverlayVm(LATENCY);
  rig.send("record:start", startPayload(344, { sounds: null }));
  await rig.settle();
  rig.pump(20);
  rig.deliver();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  assert.strictEqual(rig.oscillators.length, 0, "no cue scheduled");
  const [captured] = rig.messages("audio:captured");
  expectFrames(wavInts(captured.wav), 0, rig.frame, rig.marker, "final");
});

// A take that is live (past the guard, kept samples delivered).
async function liveTake(rig, sid) {
  rig.send("record:start", startPayload(sid));
  await rig.settle();
  rig.pump(4);
  rig.deliver();
  const guard = rig.eval("recording.guardUntil");
  while (rig.frame < guard + 1024) rig.pump(1);
  rig.deliver();
  assert.ok(rig.eval("recording.startedAt") > 0, "live");
}

const cueOutput = (rig) => rig.contexts.find((c) => !c.isRecording && rig.oscillators.some((o) => o.ctx === c));
const notesOn = (rig, ctx) => rig.oscillators.filter((o) => o.ctx === ctx);

for (const [label, end] of [
  ["stop", (rig) => rig.send("record:stop")],
  ["a mic that ends mid-take", (rig) => rig.track.onended()],
]) {
  for (const cancel of ["record:cancel", "record:discard"]) {
    test(`record cues: ${cancel} after ${label} cuts the end cue still sounding`, async () => {
      // The lost mic never comes back, so recovery (#339) fails and the cue plays.
      const rig = createOverlayVm({
        ...LATENCY,
        getUserMedia: async (c, calls) => {
          if (calls.length > 1) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
          return rig.streams[0].stream;
        },
      });
      await liveTake(rig, 400);
      end(rig);
      await rig.settle();
      rig.deliver();
      await rig.settle();
      const ctx = cueOutput(rig);
      assert.ok(ctx, "an end cue played on the cue output");
      const notes = notesOn(rig, ctx);
      assert.ok(notes.length > 0);
      for (const n of notes) assert.strictEqual(n.stops.length, 1, "only its own scheduled stop so far");
      ctx.time = notes[0].startAt + 0.01; // mid-cue
      rig.send(cancel);
      for (const n of notes) {
        assert.deepStrictEqual(n.stops.slice(1), [ctx.time], "cut at the cancel");
        assert.ok(n.disconnected);
      }
    });
  }
}

test("record cues: a stale session's cancel never cuts the newer session's cue", async () => {
  const rig = createOverlayVm(LATENCY);
  await liveTake(rig, 500);
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  // Session 501 starts; its start cue is sounding on the recording context.
  rig.send("record:start", startPayload(501));
  await rig.settle();
  rig.pump(4);
  rig.deliver();
  const startNotes = rig.oscillators.filter((o) => o.ctx.isRecording).slice(-2);
  assert.strictEqual(startNotes.length, 2);
  for (const n of startNotes) assert.strictEqual(n.stops.length, 1);
  rig.eval('stepCue({ type: "cancel", sid: 500 })');
  for (const n of startNotes) assert.strictEqual(n.stops.length, 1, "untouched by the stale cancel");
  // The current session's cancel does cut it.
  rig.eval('stepCue({ type: "cancel", sid: 501 })');
  for (const n of startNotes) assert.strictEqual(n.stops.length, 2, "cut by the current cancel");
});

test("overlay VM fixture: root custom properties read like the real stylesheet", () => {
  // The overlay reads its colours from tokens.css through getComputedStyle;
  // the fixture must answer with the real palette, not a guess.
  const rig = createOverlayVm(LATENCY);
  assert.strictEqual(rig.eval('getComputedStyle(document.documentElement).getPropertyValue("--accent")'), "#fb4d5c");
  assert.strictEqual(rig.eval('getComputedStyle(document.documentElement).getPropertyValue("--no-such-token")'), "");
});
