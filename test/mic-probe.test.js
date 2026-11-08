// The OS device-class probe (#339, main/mic-probe.js): parsers, and that a
// missing/slow/garbled tool is never an error.

const { test } = require("node:test");
const assert = require("node:assert");
const { createProbe, parsePactlSources, parseSystemProfiler, parsePnpDevices, commandFor } = require("../main/mic-probe");

test("pactl sources: bluez is Bluetooth, monitors are virtual, bus devices are physical", () => {
  const text = JSON.stringify([
    { name: "alsa_input.usb-Blue_Yeti", description: "Yeti Stereo Microphone", properties: { "device.bus": "usb", "device.api": "alsa" } },
    { name: "bluez_input.AA_BB", description: "AirPods Pro", properties: { "device.api": "bluez5", "device.bus": "bluetooth" } },
    { name: "alsa_output.pci.analog-stereo.monitor", description: "Monitor of Built-in Audio", properties: { "device.class": "monitor" } },
    { name: "mystery", description: "No Hints", properties: {} },
  ]);
  assert.deepStrictEqual(parsePactlSources(text), [
    { name: "Yeti Stereo Microphone", bluetooth: false, virtual: false },
    { name: "AirPods Pro", bluetooth: true, virtual: false },
    { name: "Monitor of Built-in Audio", bluetooth: false, virtual: true },
    { name: "No Hints", bluetooth: null, virtual: null },
  ]);
  assert.deepStrictEqual(parsePactlSources("not json"), []);
  assert.deepStrictEqual(parsePactlSources("{}"), []);
});

test("system_profiler: only inputs, by transport", () => {
  const text = JSON.stringify({
    SPAudioDataType: [{ _items: [
      { _name: "MacBook Pro Microphone", coreaudio_device_input: 1, coreaudio_device_transport: "coreaudio_device_type_builtin" },
      { _name: "AirPods", coreaudio_device_input: 1, coreaudio_device_transport: "coreaudio_device_type_bluetooth" },
      { _name: "BlackHole 2ch", coreaudio_device_input: 2, coreaudio_device_transport: "coreaudio_device_type_virtual" },
      { _name: "MacBook Pro Speakers", coreaudio_device_output: 2, coreaudio_device_transport: "coreaudio_device_type_builtin" },
      { _name: "Odd", coreaudio_device_input: 1 },
    ] }],
  });
  assert.deepStrictEqual(parseSystemProfiler(text), [
    { name: "MacBook Pro Microphone", bluetooth: false, virtual: false },
    { name: "AirPods", bluetooth: true, virtual: false },
    { name: "BlackHole 2ch", bluetooth: false, virtual: true },
    { name: "Odd", bluetooth: null, virtual: null },
  ]);
  assert.deepStrictEqual(parseSystemProfiler(""), []);
});

test("Get-PnpDevice: Bluetooth nodes only, a single object included, virtual never claimed", () => {
  const one = JSON.stringify({ FriendlyName: "Headset", InstanceId: "BTHENUM\\DEV_1" });
  assert.deepStrictEqual(parsePnpDevices(one), [{ name: "Headset", bluetooth: true, virtual: null }]);
  const many = JSON.stringify([{ FriendlyName: "A", InstanceId: "BTHHFENUM\\X" }, { FriendlyName: "B", InstanceId: "USB\\X" }]);
  assert.deepStrictEqual(parsePnpDevices(many).map((r) => r.name), ["A"]);
});

test("each platform has a command; others have none", () => {
  assert.strictEqual(commandFor("linux").cmd, "pactl");
  assert.strictEqual(commandFor("darwin").cmd, "system_profiler");
  assert.strictEqual(commandFor("win32").cmd, "powershell.exe");
  assert.strictEqual(commandFor("freebsd"), null);
});

test("a missing tool, a rejecting tool or garbage output give [] — never a throw", async () => {
  for (const run of [
    async () => { throw Object.assign(new Error("spawn pactl ENOENT"), { code: "ENOENT" }); },
    async () => { throw Object.assign(new Error("timed out"), { killed: true }); },
    async () => "<<garbage>>",
  ]) {
    const probe = createProbe({ platform: "linux", run });
    assert.deepStrictEqual(await probe.refresh(), []);
    assert.strictEqual(probe.available(), false);
  }
  assert.deepStrictEqual(await createProbe({ platform: "freebsd" }).refresh(), []);
});

test("the cache answers at once, refreshes once at a time, and goes stale after the ttl", async () => {
  let clock = 0;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const probe = createProbe({
    platform: "linux",
    now: () => clock,
    ttlMs: 1000,
    run: async () => {
      calls++;
      await gate;
      return JSON.stringify([{ name: "Mic", description: "Mic", properties: { "device.bus": "usb" } }]);
    },
  });
  assert.deepStrictEqual(probe.get(), []); // nothing yet, and no wait
  assert.strictEqual(probe.stale(), true);
  const first = probe.refresh();
  assert.strictEqual(probe.refresh(), first, "a second refresh joins the first");
  release();
  await first;
  assert.strictEqual(calls, 1);
  assert.strictEqual(probe.available(), true);
  assert.strictEqual(probe.stale(), false);
  clock = 5000;
  assert.strictEqual(probe.stale(), true);
});
