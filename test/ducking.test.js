// Tests for "lower other audio while recording" (#340): the controller's
// lifecycle against a fake backend (start/pause/resume/cancel/fail/quit,
// nested owners, ownership, device switches, crash recovery), every OS
// command builder and parser, and — on macOS and Windows — a read-only run of
// the real platform command, so CI on those runners exercises the actual tool.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDucker, createFileStore, MARKER_MAX_AGE_MS, PROBE_RETRY_MS } = require("../main/ducking/controller");
const b = require("../main/ducking/backends");
const { execFileAsync } = require("../main/util/exec-file");

// Output devices with integer volumes 0..100. `addressable: false` models
// macOS: only the default device can be read or written.
function fakeBackend({ devices = { A: { raw: 80, muted: false } }, def = "A", addressable = true, name = "fake" } = {}) {
  const writes = [];
  const backend = {
    name,
    addressable,
    writes,
    devices,
    failWrite: null,
    failRead: null,
    setDefault: (d) => { def = d; },
    probe: async () => {},
    async read(device) {
      if (backend.failRead) throw backend.failRead;
      const id = addressable ? device ?? def : def;
      const d = devices[id];
      if (!d) return null;
      return { device: id, volume: d.raw === null ? null : d.raw / 100, muted: d.muted, raw: d.raw };
    },
    scale: (raw, f) => Math.round(raw * f),
    same: (x, y) => x === y,
    matches: (x, y) => x === y,
    afterWrite: null, // runs between the set and the readback
    async write(device, raw) {
      const id = addressable ? device : def;
      if (id !== device || !devices[id]) return null;
      if (backend.failWrite) throw backend.failWrite;
      writes.push([id, raw]);
      devices[id].raw = raw;
      backend.afterWrite?.();
      return backend.read(device);
    },
  };
  return backend;
}

function memoryStore(initial = null) {
  let value = initial;
  return { load: () => value, save: (v) => { value = { ...v }; }, clear: () => { value = null; }, peek: () => value };
}

function setup({ backend = fakeBackend(), store = memoryStore(), config = { enabled: true, levelPercent: 20 }, now } = {}) {
  const cfg = { ...config };
  const ducker = createDucker({
    backends: [backend],
    store,
    getConfig: () => cfg,
    logger: { warn() {}, info() {} },
    ...(now ? { now } : {}),
  });
  return { ducker, backend, store, cfg };
}

const vol = (backend, id = "A") => backend.devices[id].raw;

test("ducking: stop restores the prior volume and clears the marker", async () => {
  const { ducker, backend, store } = setup();
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16, "lowered to 20% of 80");
  assert.deepStrictEqual(store.peek(), { device: "A", prior: 80, target: 16, mechanism: "fake", at: store.peek().at });
  assert.strictEqual((await ducker.getStatus()).state, "lowered");
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(store.peek(), null);
  assert.deepStrictEqual(backend.writes, [["A", 16], ["A", 80]]);
});

test("ducking: output muted before the take is never touched and stays muted", async () => {
  const backend = fakeBackend({ devices: { A: { raw: 60, muted: true } } });
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  await ducker.setCapturing("dictation", false);
  assert.deepStrictEqual(backend.writes, []);
  assert.strictEqual(backend.devices.A.muted, true);
  assert.strictEqual(store.peek(), null);
});

test("ducking: a device at volume 0 or without a volume control is left alone", async () => {
  for (const raw of [0, null]) {
    const backend = fakeBackend({ devices: { A: { raw, muted: false } } });
    const { ducker } = setup({ backend });
    await ducker.setCapturing("dictation", true);
    assert.strictEqual((await ducker.getStatus()).state, "skipped");
    await ducker.setCapturing("dictation", false);
    assert.deepStrictEqual(backend.writes, []);
  }
});

test("ducking: pause restores, resume lowers again, cancel restores", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16);
  await ducker.setCapturing("dictation", false); // pause
  assert.strictEqual(vol(backend), 80);
  await ducker.setCapturing("dictation", true); // resume
  assert.strictEqual(vol(backend), 16);
  await ducker.setCapturing("dictation", false); // cancel / stop / error
  assert.strictEqual(vol(backend), 80);
});

test("ducking: a user volume change during the take is kept — one step either way, and on pause", async () => {
  for (const userLevel of [17, 15, 0, 100]) {
    const { ducker, backend, store } = setup();
    await ducker.setCapturing("dictation", true);
    backend.devices.A.raw = userLevel; // the user moves the slider
    await ducker.setCapturing("dictation", false);
    assert.strictEqual(vol(backend), userLevel, `kept ${userLevel}`);
    assert.deepStrictEqual(backend.writes, [["A", 16]]);
    assert.strictEqual(store.peek(), null);
  }
});

test("ducking: a user change between the set and its readback is theirs — never adopted, never overwritten", async () => {
  const { ducker, backend, store } = setup();
  backend.afterWrite = () => { backend.devices.A.raw = 30; };
  await ducker.setCapturing("dictation", true);
  const status = await ducker.getStatus();
  assert.strictEqual(status.state, "skipped");
  assert.strictEqual(status.detail, "the volume changed while it was being lowered");
  assert.strictEqual(store.peek(), null);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 30, "the user's 30 stays");
  assert.deepStrictEqual(backend.writes, [["A", 16]]);
});

test("ducking: a timed-out write whose readback shows a user change is left alone", async () => {
  const { ducker, backend, store } = setup();
  const realWrite = backend.write;
  backend.write = async (device, raw) => {
    await realWrite(device, raw);
    backend.devices.A.raw = 45; // the user, before the timeout fired
    throw new Error("timed out");
  };
  await ducker.setCapturing("dictation", true);
  backend.write = realWrite;
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 45);
  assert.strictEqual(store.peek(), null);
});

test("backends: matches() accepts each tool's own rounding and rejects a user's step", () => {
  const run = async () => "";
  const [pactlB, wpctlB] = b.candidates("linux", run);
  // pactl and wpctl read back exactly what was set: one raw step is not ours.
  assert.ok(pactlB.matches([13107, 13107], [13107, 13107]));
  assert.ok(!pactlB.matches([13108, 13107], [13107, 13107]), "one raw unit on one channel");
  assert.strictEqual(wpctlB.scale(0.82, 0.2), 0.16, "wpctl targets are two-decimal");
  assert.strictEqual(wpctlB.scale(0.33, 0.2), 0.07);
  assert.ok(wpctlB.matches(0.16, 0.16));
  assert.ok(!wpctlB.matches(0.17, 0.16) && !wpctlB.matches(0.15, 0.16));
  const mac = b.candidates("darwin", run)[0];
  assert.ok(mac.matches(19, 16), "a 1/16-step snap");
  assert.ok(!mac.matches(22, 16), "a volume-key press");
  const win = b.candidates("win32", run)[0];
  assert.ok(win.matches(0.16000001, 0.16));
  assert.ok(!win.matches(0.17, 0.16));
});

test("ducking: muting during the take is left muted; only the level comes back", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("dictation", true);
  backend.devices.A.muted = true;
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(backend.devices.A.muted, true);
});

test("ducking: an output-device switch restores the lowered device, never the new one", async () => {
  const backend = fakeBackend({ devices: { A: { raw: 80, muted: false }, B: { raw: 16, muted: false } } });
  const { ducker } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  backend.setDefault("B");
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend, "A"), 80);
  assert.strictEqual(vol(backend, "B"), 16, "B was at the lowered level by chance and is not touched");
  assert.deepStrictEqual(backend.writes, [["A", 16], ["A", 80]]);
});

test("ducking: a lowered device that disappeared is dropped without writing anywhere", async () => {
  const backend = fakeBackend({ devices: { A: { raw: 80, muted: false }, B: { raw: 50, muted: false } } });
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  delete backend.devices.A;
  backend.setDefault("B");
  await ducker.setCapturing("dictation", false);
  assert.deepStrictEqual(backend.writes, [["A", 16]]);
  assert.strictEqual(vol(backend, "B"), 50);
  assert.strictEqual(store.peek(), null);
});

test("ducking: default-device-only backend (macOS) never writes the switched-to device, and restores the original once it is back", async () => {
  const backend = fakeBackend({
    addressable: false,
    devices: { A: { raw: 80, muted: false }, B: { raw: 16, muted: false } },
  });
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend, "A"), 16);
  backend.setDefault("B"); // B happens to sit at exactly the lowered level
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend, "B"), 16, "B gets no restore write");
  assert.ok(store.peek(), "the marker for A is kept");
  const pending = await ducker.getStatus();
  assert.strictEqual(pending.state, "pending", "Settings says a restore is outstanding");
  assert.match(pending.detail, /restored once it is the default again/);
  // While B is the default, a new take does not lower (A's restore is pending).
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend, "B"), 16);
  assert.match((await ducker.getStatus()).detail, /waiting to be restored/);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual((await ducker.getStatus()).state, "pending", "still outstanding after that take");
  // A is back: the next launch (or take) restores it.
  backend.setDefault("A");
  await ducker.recover();
  assert.strictEqual(vol(backend, "A"), 80);
  assert.strictEqual(store.peek(), null);
  assert.deepStrictEqual(backend.writes, [["A", 16], ["A", 80]]);
});

test("ducking: macOS default switching between the set and its readback keeps the marker and restores the original later", async () => {
  const backend = fakeBackend({
    addressable: false,
    devices: { A: { raw: 80, muted: false }, B: { raw: 60, muted: false } },
  });
  backend.afterWrite = () => { backend.afterWrite = null; backend.setDefault("B"); };
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend, "A"), 16);
  assert.deepStrictEqual(store.peek() && [store.peek().device, store.peek().prior, store.peek().target], ["A", 80, 16]);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend, "B"), 60, "B untouched");
  assert.ok(store.peek(), "A's marker survives");
  backend.setDefault("A");
  await ducker.recover();
  assert.strictEqual(vol(backend, "A"), 80);
  assert.strictEqual(store.peek(), null);
});

test("ducking: macOS default switching during a timed-out set keeps the marker too", async () => {
  const backend = fakeBackend({
    addressable: false,
    devices: { A: { raw: 80, muted: false }, B: { raw: 60, muted: false } },
  });
  const realWrite = backend.write;
  backend.write = async (device, raw) => {
    backend.write = realWrite;
    await realWrite(device, raw);
    backend.setDefault("B");
    throw new Error("timed out");
  };
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend, "A"), 16);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend, "B"), 60, "B untouched");
  assert.ok(store.peek(), "A's marker survives");
  backend.setDefault("A");
  await ducker.recover();
  assert.strictEqual(vol(backend, "A"), 80);
  assert.strictEqual(store.peek(), null);
});

test("ducking: nested owners lower once and restore only when the last lets go", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("one", true);
  await ducker.setCapturing("two", true);
  assert.deepStrictEqual(backend.writes, [["A", 16]], "no double lowering");
  await ducker.setCapturing("one", false);
  assert.strictEqual(vol(backend), 16, "not restored early");
  await ducker.setCapturing("one", false); // a repeated release is harmless
  assert.strictEqual(vol(backend), 16);
  await ducker.setCapturing("two", false);
  assert.strictEqual(vol(backend), 80);
});

test("ducking: a burst of start/pause/resume/stop events settles on the last one", async () => {
  const { ducker, backend } = setup();
  ducker.setCapturing("dictation", true);
  ducker.setCapturing("dictation", false);
  ducker.setCapturing("dictation", true);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(ducker.holding(), false);
  // Two starts in a row settle on one lowering (in-flight overlaps are below).
  ducker.setCapturing("dictation", true);
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16);
});

// Holds the fake's next read or write until released, so lifecycle events
// can land while the OS tool is still working. `reached` resolves once the
// held call has started.
function holdNext(backend, op) {
  const real = backend[op];
  let release;
  let reachedResolve;
  const reached = new Promise((r) => { reachedResolve = r; });
  const gate = new Promise((r) => { release = r; });
  backend[op] = async (...args) => {
    backend[op] = real;
    reachedResolve();
    await gate;
    return real(...args);
  };
  return { reached, release };
}

test("ducking: stop while the lowering's read is in flight ends with nothing changed", async () => {
  const { ducker, backend, store } = setup();
  const held = holdNext(backend, "read");
  const work = ducker.setCapturing("dictation", true);
  await held.reached;
  ducker.setCapturing("dictation", false); // stop / cancel
  held.release();
  await work;
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(store.peek(), null);
  assert.strictEqual(ducker.holding(), false);
  assert.deepStrictEqual(ducker._state().owners, []);
});

test("ducking: stop while the lowering's write is in flight restores right after it lands", async () => {
  const { ducker, backend, store } = setup();
  const held = holdNext(backend, "write");
  const work = ducker.setCapturing("dictation", true);
  await held.reached;
  ducker.setCapturing("dictation", false);
  held.release();
  await work;
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
  assert.deepStrictEqual(backend.writes, [["A", 16], ["A", 80]]);
  assert.strictEqual(store.peek(), null);
});

test("ducking: a new take arriving during the restore lowers again once the restore lands", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("dictation", true);
  const held = holdNext(backend, "write");
  const stopping = ducker.setCapturing("dictation", false);
  await held.reached;
  ducker.setCapturing("dictation", true); // resume, or the next take
  held.release();
  await stopping;
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16);
  assert.deepStrictEqual(backend.writes, [["A", 16], ["A", 80], ["A", 16]], "restored, then lowered again from the restored 80");
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
});

test("ducking: a nested owner joining while the first lowering is in flight neither doubles it nor restores early", async () => {
  const { ducker, backend } = setup();
  const held = holdNext(backend, "write");
  const work = ducker.setCapturing("one", true);
  await held.reached;
  ducker.setCapturing("two", true);
  ducker.setCapturing("one", false);
  held.release();
  await work;
  await ducker.setCapturing("two", true);
  assert.strictEqual(vol(backend), 16);
  assert.deepStrictEqual(backend.writes, [["A", 16]]);
  await ducker.setCapturing("two", false);
  assert.strictEqual(vol(backend), 80);
});

test("ducking: quit during an in-flight lowering waits for it and restores", async () => {
  const { ducker, backend, store } = setup();
  const held = holdNext(backend, "write");
  ducker.setCapturing("dictation", true);
  await held.reached;
  const quitting = ducker.shutdown(1000);
  held.release();
  await quitting;
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(store.peek(), null);
  assert.strictEqual(ducker.holding(), false);
});

test("ducking: setCapturing returns at once — the caller never waits for the OS tool", async () => {
  const backend = fakeBackend();
  let release;
  backend.probe = () => new Promise((r) => { release = r; });
  const { ducker } = setup({ backend });
  const started = Date.now();
  const work = ducker.setCapturing("dictation", true);
  assert.ok(Date.now() - started < 50);
  assert.strictEqual(ducker.holding(), true, "quit would wait for this");
  while (!release) await new Promise((r) => setImmediate(r));
  assert.strictEqual(vol(backend), 80, "nothing lowered while the tool is still starting");
  release();
  await work;
  assert.strictEqual(vol(backend), 16);
});

test("ducking: off by default does nothing; turning it on mid-take lowers, off restores", async () => {
  const { ducker, backend, cfg } = setup({ config: { enabled: false, levelPercent: 20 } });
  await ducker.setCapturing("dictation", true);
  assert.deepStrictEqual(backend.writes, []);
  cfg.enabled = true;
  await ducker.refresh();
  assert.strictEqual(vol(backend), 16);
  cfg.enabled = false;
  await ducker.refresh();
  assert.strictEqual(vol(backend), 80);
});

test("ducking: the level setting is a percentage of the volume before, clamped to 0–100", async () => {
  for (const [levelPercent, expected] of [[50, 40], [0, 0], [250, 80], [undefined, 16]]) {
    const { ducker, backend } = setup({ config: { enabled: true, levelPercent } });
    await ducker.setCapturing("dictation", true);
    assert.strictEqual(vol(backend), expected, `level ${levelPercent}`);
  }
});

test("ducking: an unavailable tool reports honestly and never throws into the caller", async () => {
  const backend = fakeBackend();
  backend.probe = async () => {
    const err = new Error("spawn pactl ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  const { ducker } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  await ducker.setCapturing("dictation", false);
  const status = await ducker.getStatus();
  assert.strictEqual(status.available, false);
  assert.strictEqual(status.reason, "fake not found");
  assert.deepStrictEqual(backend.writes, []);
});

test("ducking: no backend for the platform is unavailable, not an error", async () => {
  const ducker = createDucker({ backends: [], store: memoryStore(), getConfig: () => ({ enabled: true }), logger: {} });
  await ducker.setCapturing("dictation", true);
  const status = await ducker.getStatus();
  assert.strictEqual(status.available, false);
  assert.match(status.reason, /not supported/);
});

test("ducking: a probe that failed at launch is tried again later; a missing tool is not", async () => {
  // The audio server is not up yet (start-on-login): connection refused.
  let clock = 1000;
  const backend = fakeBackend();
  let probes = 0;
  let down = true;
  backend.probe = async () => {
    probes++;
    if (down) throw new Error("Connection failure: Connection refused");
  };
  const { ducker } = setup({ backend, now: () => clock });
  await ducker.prepare();
  assert.strictEqual((await ducker.getStatus()).available, false);
  down = false;
  // Within the retry interval the failure stands (no probe per take)…
  await ducker.setCapturing("dictation", true);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(probes, 1);
  assert.strictEqual(vol(backend), 80);
  // …after it, the next take probes again and lowers.
  clock += PROBE_RETRY_MS;
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(probes, 2);
  assert.strictEqual(vol(backend), 16);
  assert.strictEqual((await ducker.getStatus()).available, true);
  await ducker.setCapturing("dictation", false);

  // A tool that is not installed stays unavailable: no re-probe per take.
  const missing = fakeBackend();
  let missingProbes = 0;
  missing.probe = async () => {
    missingProbes++;
    throw Object.assign(new Error("spawn pactl ENOENT"), { code: "ENOENT" });
  };
  const m = setup({ backend: missing, now: () => clock });
  await m.ducker.prepare();
  clock += PROBE_RETRY_MS * 10;
  await m.ducker.setCapturing("dictation", true);
  await m.ducker.prepare();
  assert.strictEqual(missingProbes, 1);
});

test("ducking: access denied on the write leaves the volume, clears the marker and says so", async () => {
  const { ducker, backend, store } = setup();
  backend.failWrite = new Error("Access denied");
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(store.peek(), null);
  const status = await ducker.getStatus();
  assert.match(status.lastError, /could not lower the output volume: Access denied/);
  await ducker.setCapturing("dictation", false);
  assert.deepStrictEqual(backend.writes, []);
});

test("ducking: no lowering when the restore marker can't be saved (a crash would lose the prior volume)", async () => {
  const store = memoryStore();
  store.save = () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); };
  const { ducker, backend } = setup({ store });
  await ducker.setCapturing("dictation", true);
  assert.deepStrictEqual(backend.writes, [], "the volume never moved");
  const status = await ducker.getStatus();
  assert.strictEqual(status.state, "skipped");
  assert.strictEqual(status.detail, "could not save the restore marker");
  assert.match(status.lastError, /could not save the restore marker: no space left on device/);
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
});

test("ducking: a write that timed out but landed is still restored", async () => {
  const { ducker, backend } = setup();
  const realWrite = backend.write;
  backend.write = async (device, raw) => {
    await realWrite(device, raw);
    throw new Error("timed out");
  };
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16);
  const status = await ducker.getStatus();
  assert.strictEqual(status.state, "lowered");
  assert.strictEqual(status.lastError, "", "a lowering that landed is not reported as a failure");
  backend.write = realWrite;
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 80);
});

test("ducking: a failed read skips the take; a failed restore keeps the marker for the next launch", async () => {
  const { ducker, backend, store } = setup();
  backend.failRead = new Error("tool hung");
  await ducker.setCapturing("dictation", true);
  assert.strictEqual((await ducker.getStatus()).state, "skipped");
  backend.failRead = null;
  await ducker.setCapturing("dictation", false);
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 16);
  backend.failWrite = new Error("denied");
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(vol(backend), 16);
  assert.ok(store.peek(), "marker kept");
  backend.failWrite = null;
  // Next launch.
  const next = setup({ backend, store });
  await next.ducker.recover();
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(store.peek(), null);
});

test("ducking: launch recovery restores a crash's lowering only when untouched", async () => {
  const marker = (at = Date.now()) => ({ mechanism: "fake", device: "A", prior: 80, target: 16, at });
  {
    const backend = fakeBackend({ devices: { A: { raw: 16, muted: false } } });
    const { ducker, store } = setup({ backend, store: memoryStore(marker()) });
    await ducker.recover();
    assert.strictEqual(vol(backend), 80);
    assert.strictEqual(store.peek(), null);
  }
  {
    const backend = fakeBackend({ devices: { A: { raw: 17, muted: false } } });
    const { ducker, store } = setup({ backend, store: memoryStore(marker()) });
    await ducker.recover();
    assert.strictEqual(vol(backend), 17, "the user's later change is kept");
    assert.strictEqual(store.peek(), null);
  }
  {
    // Another mechanism wrote it (pactl then, wpctl now) or it is stale: cleared untouched.
    for (const m of [{ ...marker(), mechanism: "other" }, marker(Date.now() - MARKER_MAX_AGE_MS - 1)]) {
      const backend = fakeBackend({ devices: { A: { raw: 16, muted: false } } });
      const { ducker, store } = setup({ backend, store: memoryStore(m) });
      await ducker.recover();
      assert.strictEqual(vol(backend), 16);
      assert.strictEqual(store.peek(), null);
    }
  }
  {
    // Recovery runs even with the setting off: the lowering was ours.
    const backend = fakeBackend({ devices: { A: { raw: 16, muted: false } } });
    const { ducker } = setup({ backend, store: memoryStore(marker()), config: { enabled: false } });
    await ducker.recover();
    assert.strictEqual(vol(backend), 80);
  }
});

test("ducking: quit restores what is held, then ignores late capture events", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(ducker.holding(), true);
  await ducker.shutdown(1000);
  assert.strictEqual(vol(backend), 80);
  assert.strictEqual(ducker.holding(), false);
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(vol(backend), 80, "no lowering after quit");
});

test("ducking: quit gives up after its bound when the tool hangs", async () => {
  const { ducker, backend } = setup();
  await ducker.setCapturing("dictation", true);
  backend.read = () => new Promise(() => {});
  const started = Date.now();
  await ducker.shutdown(50);
  assert.ok(Date.now() - started < 1000);
  assert.strictEqual(ducker.holding(), false, "the quit goes through");
});

test("ducking: the file store writes atomically and tolerates a missing or corrupt file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-duck-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "audio-duck.json");
  const store = createFileStore(file);
  assert.strictEqual(store.load(), null);
  store.save({ device: "A", prior: [1, 2] });
  assert.deepStrictEqual(store.load(), { device: "A", prior: [1, 2] });
  assert.ok(!fs.existsSync(`${file}.tmp`));
  fs.writeFileSync(file, "{not json");
  assert.strictEqual(store.load(), null);
  store.clear();
  store.clear();
  assert.ok(!fs.existsSync(file));
});

// --- builders and parsers ------------------------------------------------------

test("pactl: argv builders pass the sink and per-channel values as separate arguments", () => {
  assert.deepStrictEqual(b.pactl.defaultSink(), ["pactl", ["get-default-sink"]]);
  assert.deepStrictEqual(b.pactl.getVolume("alsa_output.pci;rm -rf"), ["pactl", ["get-sink-volume", "alsa_output.pci;rm -rf"]]);
  assert.deepStrictEqual(b.pactl.getMute("s"), ["pactl", ["get-sink-mute", "s"]]);
  assert.deepStrictEqual(b.pactl.setVolume("s", [13107, 9830]), ["pactl", ["set-sink-volume", "s", "13107", "9830"]]);
});

test("pactl: parses volume channels and mute", () => {
  const out =
    "Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 19661 /  30% / -31.37 dB\n        balance -0.25\n";
  assert.deepStrictEqual(b.parsePactlVolume(out), [26214, 19661]);
  assert.deepStrictEqual(b.parsePactlVolume("Volume: mono: 65536 / 100% / 0.00 dB\n"), [65536]);
  assert.strictEqual(b.parsePactlMute("Mute: yes\n"), true);
  assert.strictEqual(b.parsePactlMute("Mute: no\n"), false);
  assert.throws(() => b.parsePactlVolume("Lautstärke: ..."), /unexpected pactl volume output/);
  assert.throws(() => b.parsePactlMute(""), /unexpected pactl mute output/);
});

test("pactl backend: keeps channel balance, compares exactly, reports a gone sink as null", async () => {
  const calls = [];
  const sinks = { s1: { ch: [40000, 30000], mute: "no" } };
  const run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    assert.strictEqual(opts.env.LC_ALL, "C");
    const [op, sink, ...vals] = args;
    if (op === "get-default-sink") return "s1\n";
    if (!sinks[sink]) throw new Error("Failed to get sink information: No such entity");
    if (op === "get-sink-volume") return `Volume: ${sinks[sink].ch.map((v, i) => `ch${i}: ${v} / 50% / -1 dB`).join(",   ")}\n`;
    if (op === "get-sink-mute") return `Mute: ${sinks[sink].mute}\n`;
    if (op === "set-sink-volume") { sinks[sink].ch = vals.map(Number); return ""; }
    throw new Error(`unexpected ${op}`);
  };
  const backend = b.createPactlBackend(run);
  const cur = await backend.read();
  assert.deepStrictEqual(cur, { device: "s1", volume: 40000 / 65536, muted: false, raw: [40000, 30000] });
  const target = backend.scale(cur.raw, 0.2);
  assert.deepStrictEqual(target, [8000, 6000]);
  const after = await backend.write("s1", target);
  assert.deepStrictEqual(after.raw, [8000, 6000]);
  assert.ok(backend.same([8000, 6000], after.raw));
  assert.ok(!backend.same([8000, 6001], after.raw), "one raw step on one channel is a user change");
  assert.strictEqual(await backend.read("gone"), null);
  await assert.rejects(backend.read(undefined).then(() => { sinks.s1 = undefined; return backend.read(); }));
  assert.ok(calls.every(([cmd]) => cmd === "pactl"));
});

test("pactl backend + controller: a one-unit change between the set and its readback is the user's", async () => {
  const sink = { ch: [65536, 65536] };
  let nudge = false;
  const run = async (cmd, [op, , ...vals]) => {
    if (op === "get-default-sink") return "s1\n";
    if (op === "get-sink-volume") {
      if (nudge) { nudge = false; sink.ch = [sink.ch[0] + 1, sink.ch[1]]; } // another tool, just after our set
      return `Volume: ${sink.ch.map((v, i) => `c${i}: ${v} / 1% / 0 dB`).join(",   ")}\n`;
    }
    if (op === "get-sink-mute") return "Mute: no\n";
    if (op === "set-sink-volume") { sink.ch = vals.map(Number); nudge = sink.ch[0] < 65536; return ""; }
    throw new Error(op);
  };
  const store = memoryStore();
  const ducker = createDucker({ backends: [b.createPactlBackend(run)], store, getConfig: () => ({ enabled: true, levelPercent: 20 }), logger: {} });
  await ducker.setCapturing("dictation", true);
  assert.deepStrictEqual(sink.ch, [13108, 13107]);
  assert.strictEqual((await ducker.getStatus()).detail, "the volume changed while it was being lowered");
  await ducker.setCapturing("dictation", false);
  assert.deepStrictEqual(sink.ch, [13108, 13107], "never overwritten with the prior 100%");
  assert.strictEqual(store.peek(), null);
});

test("wpctl: builders and parsers", () => {
  assert.deepStrictEqual(b.wpctl.inspect("@DEFAULT_AUDIO_SINK@"), ["wpctl", ["inspect", "@DEFAULT_AUDIO_SINK@"]]);
  assert.deepStrictEqual(b.wpctl.getVolume(36), ["wpctl", ["get-volume", "36"]]);
  assert.deepStrictEqual(b.wpctl.setVolume("36", 0.08), ["wpctl", ["set-volume", "36", "0.0800"]]);
  assert.deepStrictEqual(
    b.parseWpctlInspect('id 36, type PipeWire:Interface:Node\n    audio.channels = "2"\n  * node.name = "auto_null"\n'),
    { id: 36, name: "auto_null" }
  );
  assert.deepStrictEqual(b.parseWpctlVolume("Volume: 0.40\n"), { volume: 0.4, muted: false });
  assert.deepStrictEqual(b.parseWpctlVolume("Volume: 1.00 [MUTED]\n"), { volume: 1, muted: true });
  assert.throws(() => b.parseWpctlInspect("Object '99' not found"), /unexpected wpctl inspect output/);
  assert.throws(() => b.parseWpctlVolume("nope"), /unexpected wpctl volume output/);
});

test("wpctl backend: device identity is id plus node name; a reused id or a vanished node reads as gone", async () => {
  const nodes = { 36: { name: "speakers", vol: "0.40" } };
  const run = async (cmd, [op, id, value]) => {
    assert.strictEqual(cmd, "wpctl");
    const key = id === "@DEFAULT_AUDIO_SINK@" ? "36" : id;
    const node = nodes[key];
    if (op === "inspect") {
      if (!node) throw new Error(`Object '${id}' not found`);
      return `id ${key}, type PipeWire:Interface:Node\n  * node.name = "${node.name}"\n`;
    }
    if (op === "get-volume") return node ? `Volume: ${node.vol}\n` : `Node '${id}' not found\n`;
    if (op === "set-volume") { node.vol = Number(value).toFixed(2); return ""; }
    throw new Error(op);
  };
  const backend = b.createWpctlBackend(run);
  const cur = await backend.read();
  assert.deepStrictEqual(cur, { device: "36:speakers", volume: 0.4, muted: false, raw: 0.4 });
  const after = await backend.write("36:speakers", backend.scale(cur.raw, 0.2));
  assert.strictEqual(after.raw, 0.08);
  nodes[36].name = "headset"; // id 36 reused by another device
  assert.strictEqual(await backend.read("36:speakers"), null);
  delete nodes[36];
  assert.strictEqual(await backend.read("36:speakers"), null);
});

test("osascript: builders pass the level through argv and parsers read volume, mute and missing value", () => {
  assert.deepStrictEqual(b.osa.get(), ["osascript", ["-e", "get volume settings"]]);
  const [cmd, args] = b.osa.set(16);
  assert.strictEqual(cmd, "osascript");
  assert.strictEqual(args.at(-1), "16");
  assert.ok(!args.slice(0, -1).join(" ").includes("16"), "the value is not spliced into the script");
  assert.deepStrictEqual(b.osa.devices(), ["system_profiler", ["SPAudioDataType", "-json"]]);
  assert.deepStrictEqual(
    b.parseOsaVolume("output volume:44, input volume:75, alert volume:100, output muted:false"),
    { raw: 44, volume: 0.44, muted: false }
  );
  assert.deepStrictEqual(
    b.parseOsaVolume("output volume:missing value, input volume:75, alert volume:100, output muted:missing value"),
    { raw: null, volume: null, muted: false }
  );
  assert.strictEqual(b.parseOsaVolume("output volume:0, output muted:true").muted, true);
  assert.throws(() => b.parseOsaVolume("execution error"), /unexpected osascript output/);
});

test("system_profiler: the default output device is the flagged item, named with its transport", () => {
  const json = JSON.stringify({
    SPAudioDataType: [{
      _name: "coreaudio_device",
      _items: [
        { _name: "MacBook Pro Microphone", coreaudio_default_audio_input_device: "spaudio_yes" },
        { _name: "MacBook Pro Speakers", coreaudio_default_audio_output_device: "spaudio_yes", coreaudio_device_transport: "coreaudio_device_type_builtin" },
        { _name: "AirPods", coreaudio_device_transport: "coreaudio_device_type_bluetooth" },
      ],
    }],
  });
  assert.strictEqual(b.parseMacDefaultOutput(json), "MacBook Pro Speakers|coreaudio_device_type_builtin");
  assert.strictEqual(b.parseMacDefaultOutput(JSON.stringify({ SPAudioDataType: [] })), null);
  assert.throws(() => b.parseMacDefaultOutput("not json"), /unexpected system_profiler output/);
});

// Two identical USB DACs: same name, same transport. osascript would write
// whichever is the default, so the identity can't guard a restore — refused.
const twinDacs = (defaultIndex) => JSON.stringify({
  SPAudioDataType: [{
    _items: [0, 1].map((i) => ({
      _name: "USB Audio DAC",
      coreaudio_device_transport: "coreaudio_device_type_usb",
      coreaudio_device_output: 2,
      ...(i === defaultIndex ? { coreaudio_default_audio_output_device: "spaudio_yes" } : {}),
    })),
  }],
});

test("system_profiler: two outputs sharing a name and transport are refused, not guessed", () => {
  assert.throws(() => b.parseMacDefaultOutput(twinDacs(0)), /two outputs are both named "USB Audio DAC"/);
  // Same name on different transports stays distinguishable.
  const mixed = JSON.stringify({ SPAudioDataType: [{ _items: [
    { _name: "Headset", coreaudio_device_transport: "coreaudio_device_type_usb", coreaudio_device_output: 2, coreaudio_default_audio_output_device: "spaudio_yes" },
    { _name: "Headset", coreaudio_device_transport: "coreaudio_device_type_bluetooth", coreaudio_device_output: 2 },
  ] }] });
  assert.strictEqual(b.parseMacDefaultOutput(mixed), "Headset|coreaudio_device_type_usb");
});

test("macOS backend + controller: with twin outputs nothing is lowered, the status says why, and the twin is never written", async () => {
  let defaultIndex = 0;
  const volumes = [80, 16];
  const writes = [];
  const run = async (cmd, args) => {
    if (cmd === "system_profiler") return twinDacs(defaultIndex);
    if (args.length === 2) return `output volume:${volumes[defaultIndex]}, output muted:false`;
    writes.push([defaultIndex, Number(args.at(-1))]);
    volumes[defaultIndex] = Number(args.at(-1));
    return "";
  };
  const store = memoryStore();
  const ducker = createDucker({ backends: [b.createMacBackend(run)], store, getConfig: () => ({ enabled: true, levelPercent: 20 }), logger: {} });
  await ducker.setCapturing("dictation", true);
  const status = await ducker.getStatus();
  assert.strictEqual(status.available, true, "the tool works; this device can't be told apart");
  assert.strictEqual(status.state, "skipped");
  assert.match(status.lastError, /two outputs are both named/);
  defaultIndex = 1; // the twin sitting at the would-be lowered level
  await ducker.setCapturing("dictation", false);
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual(volumes, [80, 16]);
  assert.strictEqual(store.peek(), null);
});

// A system_profiler + osascript double: `def` is the default output, each
// tool takes `cost` ms, and `calls` records what ran in order (with "set"
// marking the moment the volume moved).
function fakeMacTools({ cost = { system_profiler: 0, osascript: 0 } } = {}) {
  const tools = { def: "Speakers", volumes: { Speakers: 50, AirPods: 70 }, calls: [], setAt: null, t0: Date.now() };
  tools.run = async (cmd, args) => {
    const delay = cost[cmd] || 0;
    if (cmd === "system_profiler") {
      tools.calls.push("system_profiler");
      const def = tools.def; // what the profile sees is the default when it starts
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return JSON.stringify({ SPAudioDataType: [{ _items: [{ _name: def, coreaudio_default_audio_output_device: "spaudio_yes" }] }] });
    }
    if (args.length === 2) {
      tools.calls.push("get");
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return `output volume:${tools.volumes[tools.def]}, input volume:50, alert volume:100, output muted:false`;
    }
    if (delay) await new Promise((r) => setTimeout(r, delay));
    tools.calls.push("set");
    tools.setAt ??= Date.now() - tools.t0;
    tools.volumes[tools.def] = Number(args.at(-1));
    return "";
  };
  return tools;
}

test("macOS backend: the set goes out at once, and a switch before it shows in the readback", async () => {
  const tools = fakeMacTools();
  const backend = b.createMacBackend(tools.run);
  assert.strictEqual(backend.addressable, false);
  const cur = await backend.read();
  assert.strictEqual(cur.device, "Speakers|");
  tools.calls.length = 0;
  assert.deepStrictEqual(await backend.write("Speakers|", 10), { device: "Speakers|", volume: 0.1, muted: false, raw: 10 });
  assert.strictEqual(tools.calls[0], "set", "no second device lookup before the set (#369)");
  assert.strictEqual(tools.calls[1], "get", "the volume query starts right after the set");
  tools.def = "AirPods";
  const after = await backend.write("Speakers|", 50);
  assert.strictEqual(after.device, "AirPods|", "the readback names the device that took the set");
  await assert.rejects(b.createMacBackend(async (c) => (c === "system_profiler" ? "{}" : "")).read(), /no default output/);
});

test("macOS backend + controller: a switch between the restore's read and its set keeps the marker, and the original is restored once back", async () => {
  const tools = fakeMacTools();
  const backend = b.createMacBackend(tools.run);
  const { ducker, store } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(tools.volumes.Speakers, 10);
  // The user switches outputs right after the restore read Speakers.
  const read = backend.read;
  backend.read = async (...a) => {
    const r = await read(...a);
    tools.def = "AirPods";
    backend.read = read;
    return r;
  };
  await ducker.setCapturing("dictation", false);
  assert.strictEqual(tools.volumes.AirPods, 50, "the race the set can't see: AirPods got Speakers' level");
  assert.strictEqual(store.peek()?.device, "Speakers|", "marker kept for the device that is still lowered");
  assert.strictEqual((await ducker.getStatus()).state, "pending");
  tools.def = "Speakers";
  await ducker.recover();
  assert.strictEqual(tools.volumes.Speakers, 50, "restored once it is the default again");
  assert.strictEqual(store.peek(), null);
});

test("PowerShell: fixed encoded helper script; requests are validated JSON lines, never script", () => {
  const [cmd, args] = b.WIN_HELPER;
  assert.strictEqual(cmd, "powershell.exe");
  assert.deepStrictEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.strictEqual(Buffer.from(args.at(-1), "base64").toString("utf16le"), b.WIN_SCRIPT);
  const id = "{0.0.0.00000000}.{c3a1f2e4-1111-2222-3333-444455556666}";
  assert.deepStrictEqual(JSON.parse(b.winRequest(7, "set", id, 0.16)), { id: 7, op: "set", device: id, level: 0.16 });
  assert.strictEqual(JSON.parse(b.winRequest(7, "set", id, 1 / 3)).level, 0.3333, "four decimals, as before");
  assert.deepStrictEqual(JSON.parse(b.winRequest(8, "read")), { id: 8, op: "read", device: "" });
  assert.ok(b.winRequest(8, "read").endsWith("\n") && !b.winRequest(8, "read").slice(0, -1).includes("\n"), "one line");
  assert.throws(() => b.winRequest(1, "read", "x'; Remove-Item C:\\ -Recurse"), /unexpected audio endpoint id/);
  assert.throws(() => b.winRequest(1, "read", 'a"}\n{"op":"set'), /unexpected audio endpoint id/);
  assert.throws(() => b.winRequest(1, "set", "{0.0.0.00000000}.{a}", 1.5), /out of range/);
  assert.throws(() => b.winRequest(1, "set", "{0.0.0.00000000}.{a}", NaN), /out of range/);
  // The script parses each request as JSON and never evaluates it.
  assert.match(b.WIN_SCRIPT, /ConvertFrom-Json \$line/);
  assert.doesNotMatch(b.WIN_SCRIPT, /Invoke-Expression|iex /);
});

test("PowerShell: parses the endpoint state, a gone endpoint, and rejects anything else", () => {
  assert.deepStrictEqual(b.parseWinState('{"device":"{0.0.0.00000000}.{x}","volume":0.42,"muted":false}'), {
    device: "{0.0.0.00000000}.{x}",
    volume: 0.42,
    muted: false,
    raw: 0.42,
  });
  assert.strictEqual(b.parseWinState('{"gone":true}'), null);
  assert.throws(() => b.parseWinState("Add-Type : error CS1002"), /unexpected PowerShell output/);
  assert.throws(() => b.parseWinState('{"device":1}'), /unexpected PowerShell output/);
});

// A stand-in for the PowerShell helper process: each spawn costs `startMs`
// (PowerShell + compiling the shim), each request `requestMs`. `answer(req)`
// is the result object; return undefined to never answer.
function fakeSpawn({ startMs = 0, requestMs = 0, answer } = {}) {
  const { EventEmitter } = require("node:events");
  const spawned = [];
  const devices = { "{0.0.0.00000000}.{x}": { volume: 0.5, muted: false } };
  const fallback = (req) => {
    const id = req.device || "{0.0.0.00000000}.{x}";
    const d = devices[id];
    if (!d) return { gone: true };
    if (req.op === "set") d.volume = req.level;
    return { device: id, ...d };
  };
  function spawn(cmd, args, opts) {
    const child = new EventEmitter();
    child.cmd = cmd;
    child.args = args;
    child.opts = opts;
    child.requests = [];
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    let ready = new Promise((r) => setTimeout(r, startMs));
    child.stdin = new EventEmitter();
    Object.assign(child.stdin, {
      write(line) {
        const req = JSON.parse(line);
        child.requests.push(req);
        ready = ready.then(() => new Promise((r) => setTimeout(r, requestMs))).then(() => {
          if (child.killed) return;
          const r = (answer || fallback)(req, fallback);
          if (r === undefined) return;
          // Noise first: only the line with the request's id answers it.
          child.stdout.emit("data", "WARNING: some PowerShell chatter\n");
          const text = JSON.stringify({ id: req.id, r });
          child.stdout.emit("data", text.slice(0, 5));
          child.stdout.emit("data", `${text.slice(5)}\r\n`);
        });
      },
      end() {},
    });
    child.kill = () => {
      child.killed = true;
    };
    spawned.push(child);
    return child;
  }
  return { spawn, spawned, devices };
}

test("Windows helper: one PowerShell answers every request; errors, timeouts and exits come back as rejections", async () => {
  const fake = fakeSpawn();
  const helper = b.createWinHelper(fake.spawn, { timeoutMs: 200 });
  const backend = b.createWindowsBackend(helper);
  assert.strictEqual((await backend.read()).volume, 0.5);
  assert.strictEqual(await backend.read("{0.0.0.00000000}.{gone}"), null);
  assert.strictEqual((await backend.write("{0.0.0.00000000}.{x}", 0.1)).volume, 0.1);
  // Concurrent callers are answered one at a time, in order.
  const both = await Promise.all([backend.read(), backend.write("{0.0.0.00000000}.{x}", 0.2)]);
  assert.deepStrictEqual(both.map((x) => x.volume), [0.1, 0.2]);
  assert.strictEqual(fake.spawned.length, 1, "started once");
  assert.strictEqual(fake.spawned[0].opts.windowsHide, true);
  assert.strictEqual(backend.scale(0.5, 0.2), 0.1);
  assert.ok(backend.same(0.1, 0.1 + 1e-9));
  assert.ok(!backend.same(0.1, 0.11));
  // A refused request never reaches the process.
  await assert.rejects(backend.read("x'; Remove-Item C:\\"), /unexpected audio endpoint id/);
  assert.strictEqual(fake.spawned[0].requests.length, 5);
  helper.close();
  assert.strictEqual(fake.spawned[0].killed, true);
  assert.strictEqual(helper.running(), false);

  // The shim's own error (no endpoint, access denied) is the rejection's message.
  const failing = b.createWindowsBackend(b.createWinHelper(fakeSpawn({ answer: () => ({ error: "Element not found. (0x80070490)" }) }).spawn));
  await assert.rejects(failing.read(), /Element not found/);

  // A hung helper is killed at the timeout; the next request starts a fresh one.
  let hang = true;
  const flaky = fakeSpawn({ answer: (req, fallback) => (hang ? undefined : fallback(req)) });
  const h = b.createWinHelper(flaky.spawn, { timeoutMs: 50 });
  await assert.rejects(h.request("read"), /did not answer within 50 ms/);
  assert.strictEqual(flaky.spawned[0].killed, true);
  hang = false;
  assert.strictEqual(b.parseWinState(await h.request("read")).volume, 0.5);
  assert.strictEqual(flaky.spawned.length, 2);

  // The process dying mid-request rejects it with what PowerShell said.
  const dying = fakeSpawn({ answer: () => undefined });
  const d = b.createWinHelper(dying.spawn, { timeoutMs: 1000 });
  const pending = d.request("read");
  await new Promise((r) => setImmediate(r));
  dying.spawned[0].stderr.emit("data", "Add-Type : error CS1002");
  dying.spawned[0].emit("exit", 1);
  await assert.rejects(pending, /error CS1002/);

  // A late answer from the killed helper never answers the fresh one's request.
  hang = true;
  await assert.rejects(h.request("read"), /did not answer/);
  hang = false;
  const fresh = h.request("read");
  while (flaky.spawned.length < 3 || !flaky.spawned[2].requests.length) await new Promise((r) => setImmediate(r));
  const freshId = flaky.spawned[2].requests[0].id;
  flaky.spawned[1].stdout.emit("data", `${JSON.stringify({ id: freshId, r: { device: "{0.0.0.00000000}.{stale}", volume: 0.9, muted: false } })}\n`);
  // A mismatched id on the live helper is ignored too.
  flaky.spawned[2].stdout.emit("data", `${JSON.stringify({ id: freshId + 100, r: { gone: true } })}\n`);
  assert.deepStrictEqual(b.parseWinState(await fresh), { device: "{0.0.0.00000000}.{x}", volume: 0.5, muted: false, raw: 0.5 });

  // close() while a request is in flight rejects it; the next one starts afresh.
  const busy = fakeSpawn({ answer: () => undefined });
  const c = b.createWinHelper(busy.spawn, { timeoutMs: 1000 });
  const inFlight = c.request("read");
  await new Promise((r) => setImmediate(r));
  c.close();
  await assert.rejects(inFlight, /helper closed/);
  assert.strictEqual(busy.spawned[0].killed, true);

  // powershell.exe missing: the spawn's error event rejects, and a later
  // request tries a fresh process.
  const enoent = fakeSpawn({ answer: () => undefined });
  const e = b.createWinHelper(enoent.spawn, { timeoutMs: 1000 });
  const first = e.request("read");
  await new Promise((r) => setImmediate(r));
  enoent.spawned[0].emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }));
  await assert.rejects(first, /ENOENT/);
  const second = e.request("read");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(enoent.spawned.length, 2);
  e.close();
  await assert.rejects(second, /closed/);

  // spawn() throwing synchronously rejects the request; the queue still works.
  let throwOnce = true;
  const ok = fakeSpawn();
  const s2 = b.createWinHelper((...args) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("spawn EPERM");
    }
    return ok.spawn(...args);
  });
  await assert.rejects(s2.request("read"), /EPERM/);
  assert.strictEqual(b.parseWinState(await s2.request("read")).volume, 0.5);
  s2.close();

  // A broken pipe on stdin rejects the request instead of crashing the app.
  const piped = fakeSpawn({ answer: () => undefined });
  const p = b.createWinHelper(piped.spawn, { timeoutMs: 1000 });
  const broken = p.request("read");
  await new Promise((r) => setImmediate(r));
  piped.spawned[0].stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await assert.rejects(broken, /EPIPE/);
  assert.strictEqual(piped.spawned[0].killed, true);
  h.close();
});

test("Windows backend + controller: the helper starts at prepare(), is reused by every take, and stops when the setting is turned off", async () => {
  const fake = fakeSpawn();
  const backend = b.createWindowsBackend(b.createWinHelper(fake.spawn));
  const { ducker, cfg } = setup({ backend });
  await ducker.prepare();
  assert.strictEqual(fake.spawned.length, 1, "running before the first take");
  for (let take = 0; take < 2; take++) {
    await ducker.setCapturing("dictation", true);
    assert.strictEqual(fake.devices["{0.0.0.00000000}.{x}"].volume, 0.1);
    await ducker.setCapturing("dictation", false);
    assert.strictEqual(fake.devices["{0.0.0.00000000}.{x}"].volume, 0.5);
  }
  assert.strictEqual(fake.spawned.length, 1, "one helper for every take");
  // Turned off mid-take: the restore lands first, then the helper goes.
  await ducker.setCapturing("dictation", true);
  cfg.enabled = false;
  await ducker.refresh();
  assert.strictEqual(fake.devices["{0.0.0.00000000}.{x}"].volume, 0.5);
  assert.strictEqual(fake.spawned[0].killed, true);
  cfg.enabled = true;
  await ducker.refresh();
  assert.strictEqual(fake.spawned.length, 2, "turned back on: started again ahead of the take");
  await ducker.shutdown();
  assert.strictEqual(fake.spawned[1].killed, true, "quit lets it go");
});

test("macOS backend + controller: a switch between the lowering's read and its set lowers the new output — the original is held, and Settings says so", async () => {
  const tools = fakeMacTools();
  const backend = b.createMacBackend(tools.run);
  const { ducker, store } = setup({ backend });
  const read = backend.read;
  backend.read = async (...a) => {
    const r = await read(...a);
    tools.def = "AirPods"; // the user switches right after the read
    backend.read = read;
    return r;
  };
  await ducker.setCapturing("dictation", true);
  assert.strictEqual(tools.volumes.AirPods, 10, "the set took the output that was the default when it landed");
  assert.strictEqual(tools.volumes.Speakers, 50);
  const status = await ducker.getStatus();
  assert.strictEqual(status.state, "lowered");
  assert.match(status.lastError, /switched while it was being lowered/);
  assert.strictEqual(store.peek()?.device, "Speakers|");
  await ducker.setCapturing("dictation", false);
  // AirPods' own level before was never read: it is left quiet (safe) rather
  // than set to Speakers' level (possibly far too loud in headphones).
  assert.strictEqual(tools.volumes.AirPods, 10);
  tools.def = "Speakers";
  await ducker.recover();
  assert.strictEqual(tools.volumes.Speakers, 50, "Speakers was never lowered: left as is");
  assert.strictEqual(store.peek(), null);
});

test("ducking: prepare()/close() — warm failures are logged not thrown, off waits for the restore, and nothing starts after quit", async () => {
  // Turned off mid-take: the tool is let go only after the restore landed.
  const events = [];
  const backend = fakeBackend();
  const write = backend.write;
  backend.write = async (...a) => {
    await new Promise((r) => setTimeout(r, 20));
    events.push(`write:${a[1]}`);
    return write(...a);
  };
  backend.close = () => events.push("close");
  const { ducker, cfg } = setup({ backend });
  await ducker.setCapturing("dictation", true);
  cfg.enabled = false;
  await ducker.refresh();
  assert.deepStrictEqual(events, ["write:16", "write:80", "close"]);
  ducker.close();
  assert.deepStrictEqual(events.slice(-1), ["close"], "close() lets the tool go directly");

  // warm() rejecting (antivirus blocking the compile, say) resolves and logs.
  const infos = [];
  const cold = fakeBackend();
  cold.warm = async () => {
    throw new Error("Add-Type blocked");
  };
  const warmFail = createDucker({ backends: [cold], store: memoryStore(), getConfig: () => ({ enabled: true }), logger: { info: (m) => infos.push(m), warn() {} } });
  await warmFail.prepare();
  assert.match(infos.join("\n"), /could not start fake ahead of time: Add-Type blocked/);
  await warmFail.setCapturing("dictation", true);
  assert.strictEqual(vol(cold), 16, "the take still lowers");

  // No backend for the platform: prepare() resolves, nothing to start.
  const none = createDucker({ backends: [], store: memoryStore(), getConfig: () => ({ enabled: true }), logger: {} });
  await none.prepare();
  assert.strictEqual((await none.getStatus()).available, false);

  // After quit, prepare() starts nothing.
  const late = fakeBackend();
  let probes = 0;
  late.probe = async () => {
    probes++;
  };
  const q = setup({ backend: late });
  await q.ducker.shutdown();
  await q.ducker.prepare();
  assert.strictEqual(probes, 0);
});

// #369: what the user hears is the set, so this measures the time from the
// first samples (setCapturing) to the volume actually moving — not just that
// the caller returns at once. Each tool call is given a cost in the ratio a
// real machine shows (system_profiler ≫ osascript; a PowerShell start ≫ a
// helper request), and each budget sits about halfway between the fixed path
// and the old one, so a loaded CI runner has room either way:
//   macOS   fixed ≈ one lookup + the set (400 ms here); old ≈ probe + two
//           sequential lookups + the set (900–1000 ms); budget 2 × SP = 600 ms
//   Windows fixed ≈ two helper requests (~4 ms); old ≥ two PowerShell starts
//           (1200 ms+); budget START / 2 = 300 ms
test("ducking: once prepared, the volume moves within one tool round trip of the first samples (#369)", async () => {
  const SP = 300; // system_profiler; osascript 100
  const MAC_BUDGET = SP * 2;
  const tools = fakeMacTools({ cost: { system_profiler: SP, osascript: 100 } });
  const mac = setup({ backend: b.createMacBackend(tools.run) });
  await mac.ducker.prepare();
  for (let take = 1; take <= 2; take++) {
    tools.calls.length = 0;
    tools.setAt = null;
    tools.t0 = Date.now();
    await mac.ducker.setCapturing("dictation", true);
    assert.deepStrictEqual(tools.calls.slice(0, tools.calls.indexOf("set")).sort(), ["get", "system_profiler"], `take ${take}: one lookup before the set`);
    assert.ok(tools.setAt < MAC_BUDGET, `take ${take}: macOS set after ${tools.setAt} ms (budget ${MAC_BUDGET} ms)`);
    await mac.ducker.setCapturing("dictation", false);
  }

  const START = 600; // starting PowerShell and compiling the shim
  const WIN_BUDGET = START / 2;
  const fake = fakeSpawn({ startMs: START, requestMs: 2 });
  const win = setup({ backend: b.createWindowsBackend(b.createWinHelper(fake.spawn)) });
  await win.ducker.prepare();
  for (let take = 1; take <= 2; take++) {
    const t0 = Date.now();
    await win.ducker.setCapturing("dictation", true);
    const ms = Date.now() - t0;
    assert.strictEqual(fake.devices["{0.0.0.00000000}.{x}"].volume, 0.1);
    assert.ok(ms < WIN_BUDGET, `take ${take}: Windows lowered after ${ms} ms (budget ${WIN_BUDGET} ms)`);
    await win.ducker.setCapturing("dictation", false);
  }
  await win.ducker.shutdown();
});

test("backend selection: pactl before wpctl on Linux, one each on macOS and Windows, none elsewhere", () => {
  const run = async () => "";
  assert.deepStrictEqual(b.candidates("linux", run).map((x) => x.name), ["pactl", "wpctl"]);
  assert.deepStrictEqual(b.candidates("darwin", run).map((x) => x.name), ["osascript"]);
  assert.deepStrictEqual(b.candidates("win32", run).map((x) => x.name), ["powershell"]);
  assert.deepStrictEqual(b.candidates("freebsd", run), []);
});

// --- real platform tools, read-only ------------------------------------------------

// CI runners may have no audio device; what must hold is that the real command
// runs and its output parses (or fails for lack of a device), never that the
// script itself is broken.
test("real OS: the macOS commands run and parse", { skip: process.platform !== "darwin" }, async () => {
  const osaOut = await execFileAsync(...b.osa.get(), { timeout: 10000 });
  const parsed = b.parseOsaVolume(osaOut);
  assert.ok(parsed.raw === null || (parsed.raw >= 0 && parsed.raw <= 100));
  const profile = await execFileAsync(...b.osa.devices(), { timeout: 30000 });
  const device = b.parseMacDefaultOutput(profile);
  assert.ok(device === null || typeof device === "string");
});

test("real OS: the Windows helper compiles once and answers repeat reads fast", { skip: process.platform !== "win32" }, async () => {
  const helper = b.createWinHelper(require("node:child_process").spawn, { timeoutMs: 60000 });
  const backend = b.createWindowsBackend(helper);
  const timed = async () => {
    const t0 = Date.now();
    try {
      const state = await backend.read();
      assert.ok(state && state.volume >= 0 && state.volume <= 1, JSON.stringify(state));
    } catch (err) {
      // No audio endpoint on the runner (E_NOTFOUND 0x80070490) is fine; a
      // compile or PowerShell parse error is not.
      assert.doesNotMatch(err.message, /error CS\d+|ParserError|Cannot add type|unexpected PowerShell output|exited/, err.message);
      assert.match(err.message, /0x8|HRESULT|Element not found|not found|no default output/i, err.message);
    }
    return Date.now() - t0;
  };
  try {
    const first = await timed();
    const second = await timed();
    const third = await timed();
    console.log(`Windows helper: first read ${first} ms (start + compile), then ${second} ms, ${third} ms`);
    assert.ok(Math.max(second, third) < 500, `repeat reads ${second}/${third} ms: the helper is not being reused`);
  } finally {
    helper.close();
  }
});

// #369: the launch wiring is the fix — the tool must be started by init(), not
// at the first take. main-lifecycle stubs ./ducking whole, so it is pinned here.
test("ducking init(): starts the volume tool at launch and hands the call timeout to the backends", async (t) => {
  const { withStubs } = require("./helpers/stub-modules");
  const indexPath = require.resolve("../main/ducking/index");
  const from = (spec) => require.resolve(spec, { paths: [path.dirname(indexPath)] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-duck-init-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const backend = { ...fakeBackend(), warm: async () => calls.push("warm"), probe: async () => calls.push("probe") };
  let options = null;
  const handlers = {};
  const ducking = withStubs(
    {
      [from("electron")]: { app: { getPath: () => dir }, ipcMain: { handle: (ch, fn) => (handlers[ch] = fn) } },
      [from("../settings")]: { get: () => ({ audio: { duckOtherAudio: true, duckLevelPercent: 20 } }) },
      [from("../util/logger")]: { warn() {}, info() {} },
      [from("./backends")]: { candidates: (platform, run, opts) => ((options = opts), [backend]) },
    },
    [indexPath],
    () => require(indexPath)
  );
  ducking.init();
  for (let i = 0; i < 50 && !calls.includes("warm"); i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, ["probe", "warm"], "probed and warmed before any take");
  assert.ok(Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0, "the helper gets the per-call timeout");
  await ducking.shutdown(100);
});
