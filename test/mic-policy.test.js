// The pure automatic-microphone policy (#339, renderer/mic-policy.js).

const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeLabel, classifyDevices, resolveMicrophone } = require("../renderer/mic-policy");

const dev = (deviceId, label, groupId = deviceId) => ({ kind: "audioinput", deviceId, label, groupId });
const auto = (extra) => ({ mode: "auto", savedId: "", includeBluetooth: true, includeVirtual: true, ...extra });

test("normalizeLabel folds case and spacing and strips Chromium's decorations", () => {
  assert.strictEqual(normalizeLabel("  Default -  USB   Mic (046d:0825) "), "usb mic");
  assert.strictEqual(normalizeLabel("Communications - Headset"), "headset");
  assert.strictEqual(normalizeLabel("Mic (Model 2)"), "mic (model 2)"); // not a vid:pid
  assert.strictEqual(normalizeLabel(undefined), "");
});

test("manual mode is the saved id (or the system default) whatever the devices say", () => {
  const devices = [dev("a", "Built-in"), dev("b", "AirPods")];
  const records = [{ name: "AirPods", bluetooth: true, virtual: false }];
  assert.deepStrictEqual(resolveMicrophone({ mode: "manual", savedId: "b", includeBluetooth: false, devices, records }), { deviceId: "b", source: "manual", notice: "" });
  assert.strictEqual(resolveMicrophone({ savedId: "", devices }).deviceId, "");
});

test("auto skips a Bluetooth mic when excluded, choosing the next allowed device", () => {
  const devices = [dev("default", "Default - AirPods", "g-air"), dev("air", "AirPods", "g-air"), dev("usb", "USB Mic", "g-usb")];
  const records = [
    { name: "AirPods", bluetooth: true, virtual: false },
    { name: "USB Mic", bluetooth: false, virtual: false },
  ];
  const out = resolveMicrophone(auto({ includeBluetooth: false, devices, records }));
  assert.strictEqual(out.deviceId, "usb");
  assert.strictEqual(out.source, "ranked");
  assert.strictEqual(out.notice, "");
});

test("auto uses the OS default (as '' — it follows the OS) when it is allowed, and the alias is never its own device", () => {
  const devices = [dev("default", "Default - USB Mic", "g-usb"), dev("builtin", "Built-in", "g-b"), dev("usb", "USB Mic", "g-usb")];
  const out = resolveMicrophone(auto({ devices }));
  assert.deepStrictEqual([out.deviceId, out.source, out.label], ["", "os-default", "USB Mic"]);
  // The pseudo entries never reach the classified list.
  assert.deepStrictEqual(classifyDevices([...devices, dev("communications", "Communications - X")], []).map((d) => d.deviceId), ["builtin", "usb"]);
});

test("the OS default is found by label when the alias has no groupId, and not at all when ambiguous", () => {
  const byLabel = [{ kind: "audioinput", deviceId: "default", label: "Default - USB Mic" }, dev("b", "Built-in"), dev("u", "USB Mic")];
  assert.strictEqual(resolveMicrophone(auto({ devices: byLabel })).source, "os-default");
  const twins = [{ kind: "audioinput", deviceId: "default", label: "Default - USB Mic" }, dev("u1", "USB Mic"), dev("u2", "USB Mic")];
  const out = resolveMicrophone(auto({ devices: twins }));
  assert.strictEqual(out.source, "ranked");
  assert.strictEqual(out.deviceId, "u1"); // enumeration order, deterministic
});

test("a known-eligible device outranks an unknown one; an unknown OS default is still taken", () => {
  const devices = [dev("mystery", "Mystery Mic"), dev("usb", "USB Mic")];
  const records = [{ name: "USB Mic", bluetooth: false, virtual: false }];
  assert.strictEqual(resolveMicrophone(auto({ devices, records })).deviceId, "usb");
  const withDefault = [dev("default", "Default - Mystery Mic", "g"), dev("mystery", "Mystery Mic", "g"), dev("usb", "USB Mic")];
  assert.strictEqual(resolveMicrophone(auto({ devices: withDefault, records })).source, "os-default");
});

test("unknown devices are never excluded by the Bluetooth/virtual toggles", () => {
  const devices = [dev("only", "Headset")];
  const out = resolveMicrophone(auto({ includeBluetooth: false, includeVirtual: false, devices, records: [] }));
  assert.strictEqual(out.deviceId, "only");
  assert.strictEqual(out.notice, "");
});

test("same-name devices stay unknown even though a probe record names them", () => {
  const devices = [dev("u1", "USB Mic"), dev("u2", "USB Mic")];
  const records = [{ name: "USB Mic", bluetooth: true, virtual: false }];
  assert.deepStrictEqual(classifyDevices(devices, records).map((d) => d.bluetooth), [null, null]);
  // ...and one device with two probe records (several pactl sources) joins nothing.
  const two = [{ name: "USB Mic", bluetooth: true }, { name: "USB Mic", bluetooth: false }];
  assert.strictEqual(classifyDevices([dev("u1", "USB Mic")], two)[0].bluetooth, null);
});

test("a virtual device is hidden when virtual is off and shown when on", () => {
  const devices = [dev("loop", "Monitor of Speakers"), dev("usb", "USB Mic")];
  const records = [{ name: "Monitor of Speakers", bluetooth: false, virtual: true }, { name: "USB Mic", bluetooth: false, virtual: false }];
  assert.strictEqual(resolveMicrophone(auto({ includeVirtual: false, devices, records })).deviceId, "usb");
  assert.strictEqual(resolveMicrophone(auto({ includeVirtual: true, devices: [devices[0]], records })).deviceId, "loop");
});

test("when the preferred class is absent, auto falls back to the system default and says so", () => {
  const devices = [dev("air", "AirPods")];
  const records = [{ name: "AirPods", bluetooth: true, virtual: false }];
  const out = resolveMicrophone(auto({ includeBluetooth: false, devices, records }));
  assert.deepStrictEqual([out.deviceId, out.source], ["", "fallback"]);
  assert.match(out.notice, /Only Bluetooth microphones found — using system default/);
});

test("empty labels (no permission yet), no devices or an empty probe fall back to the saved choice", () => {
  const unlabelled = [dev("a", ""), dev("b", "")];
  assert.deepStrictEqual(resolveMicrophone(auto({ savedId: "saved", devices: unlabelled })), { deviceId: "saved", source: "saved", notice: "" });
  assert.strictEqual(resolveMicrophone(auto({ devices: unlabelled })).deviceId, "");
  assert.strictEqual(resolveMicrophone(auto({ savedId: "saved", devices: [] })).deviceId, "saved");
  assert.strictEqual(resolveMicrophone(auto({ savedId: "saved" })).deviceId, "saved");
});

test("unplug and replug: the same label with a new deviceId resolves to the new id", () => {
  const records = [{ name: "USB Mic", bluetooth: false, virtual: false }, { name: "Built-in", bluetooth: false, virtual: false }];
  const before = [dev("id-1", "USB Mic"), dev("b", "Built-in")];
  const after = [dev("id-2", "USB Mic"), dev("b", "Built-in")];
  assert.strictEqual(resolveMicrophone(auto({ devices: before, records })).deviceId, "id-1");
  assert.strictEqual(resolveMicrophone(auto({ devices: after, records })).deviceId, "id-2");
  assert.strictEqual(resolveMicrophone(auto({ devices: [dev("b", "Built-in")], records })).deviceId, "b");
});

test("a saved device that is also Bluetooth is not forced in auto mode, and stays saved in manual", () => {
  const devices = [dev("air", "AirPods"), dev("b", "Built-in")];
  const records = [{ name: "AirPods", bluetooth: true, virtual: false }, { name: "Built-in", bluetooth: false, virtual: false }];
  assert.strictEqual(resolveMicrophone(auto({ savedId: "air", includeBluetooth: false, devices, records })).deviceId, "b");
  assert.strictEqual(resolveMicrophone({ mode: "manual", savedId: "air", devices, records }).deviceId, "air");
});

test("a missing saved device in manual mode is returned as-is (the overlay's retry handles it)", () => {
  assert.strictEqual(resolveMicrophone({ mode: "manual", savedId: "gone", devices: [dev("b", "Built-in")] }).deviceId, "gone");
});
