// Automatic microphone choice at take start, and mid-take route changes (#339),
// through the real overlay script and recorder worklet (test/helpers/overlay-vm).

const { test } = require("node:test");
const assert = require("node:assert");
const { createOverlayVm, wavInts } = require("./helpers/overlay-vm");

const dev = (deviceId, label, groupId = deviceId) => ({ kind: "audioinput", deviceId, label, groupId });
const USB_AND_AIRPODS = [dev("default", "Default - AirPods", "g-air"), dev("air", "AirPods", "g-air"), dev("usb", "USB Mic", "g-usb")];
const RECORDS = [
  { name: "AirPods", bluetooth: true, virtual: false },
  { name: "USB Mic", bluetooth: false, virtual: false },
];

const payload = (sid, extra = {}) => ({
  sid, deviceId: "", maxSeconds: 60, discardHotkey: "", sounds: null, livePreview: { enabled: false }, ...extra,
});
const AUTO_NO_BT = { mode: "auto", includeBluetooth: false, includeVirtual: true };

// Objects built inside the VM have another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const requestedId = (rig, i = 0) => rig.mediaCalls[i].deviceId?.exact ?? "";

async function liveTake(rig, sid, extra) {
  rig.send("record:start", payload(sid, extra));
  await rig.settle();
  rig.pump(8);
  rig.deliver();
  await rig.settle();
  const guard = rig.eval("recording.guardUntil"); // a start cue keeps the take's first frames out
  while (guard && rig.frame < guard + 1024) rig.pump(1);
  rig.deliver();
  await rig.settle();
  assert.ok(rig.eval("recording.startedAt") > 0, "live");
}

test("auto, Bluetooth off: the take opens the allowed mic, not the OS default Bluetooth one", async () => {
  const rig = createOverlayVm({
    enumerateDevices: () => USB_AND_AIRPODS,
    invoke: async (channel) => (channel === "mics:classes" ? { records: RECORDS, available: true } : undefined),
  });
  await liveTake(rig, 1, { mic: AUTO_NO_BT, deviceId: "saved-elsewhere" });
  assert.strictEqual(requestedId(rig), "usb");
  assert.strictEqual(rig.eval("recording.microphoneNotice"), "");
});

test("auto never rewrites the saved device: it is only the fallback when labels are hidden", async () => {
  const rig = createOverlayVm({
    enumerateDevices: () => [dev("a", ""), dev("b", "")], // no permission yet → no labels
    invoke: async () => ({ records: RECORDS, available: true }),
  });
  await liveTake(rig, 2, { mic: AUTO_NO_BT, deviceId: "saved-id" });
  assert.strictEqual(requestedId(rig), "saved-id");
});

test("auto with only a Bluetooth mic uses the system default and shows why", async () => {
  const rig = createOverlayVm({
    enumerateDevices: () => [dev("air", "AirPods")],
    invoke: async () => ({ records: RECORDS, available: true }),
  });
  await liveTake(rig, 3, { mic: AUTO_NO_BT });
  assert.strictEqual(requestedId(rig), "");
  assert.match(rig.eval("recording.microphoneNotice"), /Only Bluetooth microphones found — using system default/);
});

test("a probe that is slow, throws or is missing never delays or fails the take", async () => {
  for (const invoke of [() => new Promise(() => {}), async () => { throw new Error("no handler"); }, async () => undefined]) {
    const rig = createOverlayVm({ enumerateDevices: () => USB_AND_AIRPODS, invoke });
    rig.send("record:start", payload(4, { mic: AUTO_NO_BT }));
    await new Promise((resolve) => setTimeout(resolve, 450)); // past the lookup budget
    rig.pump(8);
    rig.deliver();
    await rig.settle();
    assert.ok(rig.eval("recording.startedAt") > 0, "live");
    // Nothing is classified, so nothing is excluded: the OS default (AirPods) is allowed.
    assert.strictEqual(requestedId(rig), "");
  }
});

test("auto with no enumerateDevices at all still records", async () => {
  const rig = createOverlayVm({});
  await liveTake(rig, 5, { mic: AUTO_NO_BT, deviceId: "saved" });
  assert.strictEqual(requestedId(rig), "saved");
});

test("the auto-chosen device vanishing at open falls back to the system default with a notice", async () => {
  const rig = createOverlayVm({
    enumerateDevices: () => USB_AND_AIRPODS,
    invoke: async () => ({ records: RECORDS, available: true }),
    getUserMedia: async (c, calls) => {
      if (calls.length === 1) throw Object.assign(new Error("gone"), { name: "OverconstrainedError", constraint: "deviceId" });
      return rig.streams[0].stream;
    },
  });
  await liveTake(rig, 6, { mic: AUTO_NO_BT });
  assert.deepStrictEqual([requestedId(rig, 0), requestedId(rig, 1)], ["usb", ""]);
  assert.match(rig.eval("recording.microphoneNotice"), /Chosen mic unavailable/);
});

for (const mode of ["manual", "auto"]) {
  test(`permission denial in ${mode} mode shows the same error`, async () => {
    const rig = createOverlayVm({
      enumerateDevices: () => USB_AND_AIRPODS,
      invoke: async () => ({ records: RECORDS, available: true }),
      getUserMedia: async () => { throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }); },
    });
    rig.send("record:start", payload(7, { deviceId: "saved", mic: { ...AUTO_NO_BT, mode } }));
    await rig.settle();
    assert.deepStrictEqual(plain(rig.messages("record:error")), [{ sid: 7, message: "Microphone unavailable: Permission denied" }]);
  });
}

test("manual mode with a missing saved mic keeps today's notice and default retry", async () => {
  const rig = createOverlayVm({
    getUserMedia: async (c, calls) => {
      if (calls.length === 1) throw Object.assign(new Error("gone"), { name: "OverconstrainedError", constraint: "deviceId" });
      return rig.streams[0].stream;
    },
  });
  await liveTake(rig, 8, { deviceId: "saved" });
  assert.strictEqual(rig.eval("recording.microphoneNotice"), "Saved mic missing — using system default");
});

// ---- route change mid-capture ----

// A rig whose second microphone (the replacement) is a fresh fake stream.
function recoverableRig(extra = {}) {
  const rig = createOverlayVm({
    getUserMedia: async (c, calls, make) => (calls.length === 1 ? rig.streams[0].stream : make().stream),
    ...extra,
  });
  return rig;
}

test("a mic lost mid-take is re-acquired; speech before the loss stays in the WAV and capture resumes", async () => {
  const rig = recoverableRig();
  await liveTake(rig, 10);
  const before = rig.frame;
  const firstTrack = rig.streams[0].track;
  firstTrack.onended(); // the headset drops
  await rig.settle();
  assert.strictEqual(rig.mediaCalls.length, 2, "exactly one re-acquire");
  assert.ok(firstTrack.stopped, "the dead track is released");
  assert.match(rig.eval("recording.microphoneNotice"), /Microphone changed|switching/);
  // Not live again until the new stream delivers: capture is reported off.
  assert.strictEqual(rig.eval("recording.trackEnded"), true);
  assert.deepStrictEqual(plain(rig.messages("record:capture").at(-1)), { sid: 10, live: false });
  // No error cue yet: the take is being recovered, not torn down.
  rig.pump(8);
  rig.deliver();
  assert.strictEqual(rig.eval("recording.trackEnded"), false);
  assert.deepStrictEqual(plain(rig.messages("record:capture").at(-1)), { sid: 10, live: true });
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  const [captured] = rig.messages("audio:captured");
  const ints = wavInts(captured.wav);
  assert.ok(ints.length >= before, "everything captured before the loss is kept");
  for (let i = 0; i < before; i++) {
    if (ints[i] !== rig.marker(i)) assert.fail(`sample ${i} lost or changed across the route change`);
  }
});

test("a loss that cannot be recovered keeps the take, plays the error cue once and delivers what was captured", async () => {
  const rig = createOverlayVm({
    getUserMedia: async (c, calls) => {
      if (calls.length === 1) return rig.streams[0].stream;
      throw Object.assign(new Error("none"), { name: "NotFoundError" });
    },
  });
  await liveTake(rig, 11, { sounds: { volume: 0.5 } });
  rig.streams[0].track.onended();
  rig.streams[0].track.onended(); // a second "ended" for the same loss
  await rig.settle();
  assert.strictEqual(rig.mediaCalls.length, 2, "one attempt per loss, however many events");
  assert.match(rig.eval("recording.microphoneNotice"), /Microphone lost/);
  assert.strictEqual(rig.eval("recording.trackEnded"), true);
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  assert.strictEqual(rig.messages("audio:captured").length, 1);
  assert.ok(rig.contexts.some((c) => !c.isRecording && rig.oscillators.some((o) => o.ctx === c)), "the error cue played on the cue output");
});

test("stop racing the re-acquire releases the new stream and still delivers", async () => {
  let release;
  const rig = createOverlayVm({
    getUserMedia: async (c, calls, make) => {
      if (calls.length === 1) return rig.streams[0].stream;
      await new Promise((resolve) => (release = resolve));
      return make().stream;
    },
  });
  await liveTake(rig, 12);
  rig.streams[0].track.onended();
  await rig.settle();
  rig.send("record:stop");
  rig.deliver();
  await rig.settle();
  release();
  await rig.settle();
  const replacement = rig.streams[1];
  assert.ok(replacement.track.stopped, "the late stream is stopped, not leaked");
  assert.strictEqual(rig.messages("audio:captured").length, 1);
  assert.strictEqual(rig.eval("recording"), null);
});

test("devicechange finds a dead track whose ended event never arrived", async () => {
  const rig = recoverableRig();
  await liveTake(rig, 13);
  rig.streams[0].track.readyState = "ended"; // no event
  rig.fireDeviceChange();
  await rig.settle();
  assert.strictEqual(rig.mediaCalls.length, 2);
  // And a devicechange with a healthy track does nothing.
  const calls = rig.mediaCalls.length;
  rig.fireDeviceChange();
  await rig.settle();
  assert.strictEqual(rig.mediaCalls.length, calls);
});

test("a recovered loss plays no error cue", async () => {
  const rig = recoverableRig();
  await liveTake(rig, 14, { sounds: { volume: 0.5 } });
  rig.streams[0].track.onended();
  await rig.settle();
  rig.pump(8);
  rig.deliver();
  await rig.settle();
  assert.strictEqual(rig.eval("recording.trackEnded"), false);
  assert.ok(!rig.contexts.some((c) => !c.isRecording && rig.oscillators.some((o) => o.ctx === c)), "no cue output yet");
});
