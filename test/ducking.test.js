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
const { createDucker, createFileStore, MARKER_MAX_AGE_MS } = require("../main/ducking/controller");
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

test("macOS backend: refuses to write when another device became the default", async () => {
  let def = "Speakers";
  let volume = 50;
  const run = async (cmd, args) => {
    if (cmd === "system_profiler") {
      return JSON.stringify({ SPAudioDataType: [{ _items: [{ _name: def, coreaudio_default_audio_output_device: "spaudio_yes" }] }] });
    }
    if (args.length === 2) return `output volume:${volume}, input volume:50, alert volume:100, output muted:false`;
    volume = Number(args.at(-1));
    return "";
  };
  const backend = b.createMacBackend(run);
  assert.strictEqual(backend.addressable, false);
  const cur = await backend.read();
  assert.strictEqual(cur.device, "Speakers|");
  assert.strictEqual((await backend.write("Speakers|", 10)).raw, 10);
  def = "AirPods";
  assert.strictEqual(await backend.write("Speakers|", 50), null);
  assert.strictEqual(volume, 10, "AirPods never got Speakers' level");
  await assert.rejects(b.createMacBackend(async (c) => (c === "system_profiler" ? "{}" : "")).read(), /no default output/);
});

test("PowerShell: fixed encoded script, values only through validated environment variables", () => {
  const [cmd, args, opts] = b.winCommand("set", "{0.0.0.00000000}.{c3a1f2e4-1111-2222-3333-444455556666}", 0.16);
  assert.strictEqual(cmd, "powershell.exe");
  assert.deepStrictEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.strictEqual(Buffer.from(args.at(-1), "base64").toString("utf16le"), b.WIN_SCRIPT);
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(opts.env.EARHEART_VOLUME_OP, "set");
  assert.strictEqual(opts.env.EARHEART_VOLUME_DEVICE, "{0.0.0.00000000}.{c3a1f2e4-1111-2222-3333-444455556666}");
  assert.strictEqual(opts.env.EARHEART_VOLUME_LEVEL, "0.1600");
  // Read of the default device: no id, no level.
  const [, , readOpts] = b.winCommand("read");
  assert.strictEqual(readOpts.env.EARHEART_VOLUME_DEVICE, "");
  assert.strictEqual(readOpts.env.EARHEART_VOLUME_LEVEL, "");
  assert.throws(() => b.winCommand("read", "x'; Remove-Item C:\\ -Recurse"), /unexpected audio endpoint id/);
  assert.throws(() => b.winCommand("set", "{0.0.0.00000000}.{a}", 1.5), /out of range/);
  assert.throws(() => b.winCommand("set", "{0.0.0.00000000}.{a}", NaN), /out of range/);
  // The script reads its inputs from the environment only.
  assert.match(b.WIN_SCRIPT, /\$env:EARHEART_VOLUME_OP/);
  assert.match(b.WIN_SCRIPT, /\$env:EARHEART_VOLUME_DEVICE/);
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

test("Windows backend: a gone endpoint reads as null; scale stays within 0..1", async () => {
  const backend = b.createWindowsBackend(async (cmd, args, opts) =>
    opts.env.EARHEART_VOLUME_DEVICE ? '{"gone":true}' : '{"device":"{0.0.0.00000000}.{x}","volume":0.5,"muted":false}'
  );
  assert.strictEqual((await backend.read()).volume, 0.5);
  assert.strictEqual(await backend.read("{0.0.0.00000000}.{x}"), null);
  assert.strictEqual(backend.scale(0.5, 0.2), 0.1);
  assert.ok(backend.same(0.1, 0.1 + 1e-9));
  assert.ok(!backend.same(0.1, 0.11));
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

test("real OS: the Windows Core Audio shim compiles and reads", { skip: process.platform !== "win32" }, async () => {
  const [cmd, args, opts] = b.winCommand("read");
  try {
    const state = b.parseWinState(await execFileAsync(cmd, args, { ...opts, timeout: 60000 }));
    assert.ok(state && state.volume >= 0 && state.volume <= 1, JSON.stringify(state));
  } catch (err) {
    // No audio endpoint on the runner (E_NOTFOUND 0x80070490) is fine; a
    // compile or PowerShell parse error is not.
    assert.doesNotMatch(err.message, /error CS\d+|ParserError|Cannot add type|unexpected PowerShell output/, err.message);
    assert.match(err.message, /0x8|HRESULT|Element not found|not found/i, err.message);
  }
});
