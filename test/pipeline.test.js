// Tests for the pipeline's idle-unload timer: when models get evicted, and what
// happens when a worker is busy at the moment the window elapses.
//
// main/pipeline.js requires Electron and most of the main process at load, so
// this uses the same require.cache stubbing that engines.test.js uses for the
// engines facade — just with a longer list. Nothing in production code changes
// to make this loadable; the module is simply given fakes for its neighbours.
//
// Timers are driven by node:test's mock timers rather than real waits, so the
// configured window (minutes) and the retry (seconds) can both be stepped
// through deterministically.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

const pipelinePath = require.resolve("../main/pipeline");
const dir = path.dirname(pipelinePath);
const resolveFrom = (spec) => require.resolve(spec, { paths: [dir] });

// Load main/pipeline.js against fakes for everything it pulls in. `engines` and
// `settings` are the two the caller actually drives; the rest exist only so the
// module can finish loading.
function loadPipelineWith({ engines, settings }) {
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => os.tmpdir() },
      ipcMain: { on() {} },
      Notification: class {
        show() {}
      },
    },
    [resolveFrom("./windows")]: { sendToOverlay() {}, showOverlay() {}, hideOverlay() {} },
    [resolveFrom("./settings")]: settings,
    [resolveFrom("./services/route")]: { transcribe: async () => "", clean: async () => "" },
    [resolveFrom("./engines")]: engines,
    [resolveFrom("./output/deliver")]: { deliver: async () => ({}) },
    [resolveFrom("./history")]: { add() {} },
    [resolveFrom("./live-preview")]: {
      createLivePreview: () => ({ cancel() {}, handleAudio() {}, snapshotFinal: () => null }),
    },
    [resolveFrom("./util/logger")]: { info() {}, warn() {}, error() {} },
  };

  const saved = {};
  for (const p of Object.keys(stubs)) {
    saved[p] = require.cache[p];
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = stubs[p];
    require.cache[p] = m;
  }
  delete require.cache[pipelinePath];
  try {
    return require(pipelinePath);
  } finally {
    delete require.cache[pipelinePath];
    for (const p of Object.keys(stubs)) {
      if (saved[p]) require.cache[p] = saved[p];
      else delete require.cache[p];
    }
  }
}

const MINUTES = 2;
const WINDOW_MS = MINUTES * 60 * 1000;
const RETRY_MS = 15000; // must match IDLE_UNLOAD_RETRY_MS in main/pipeline.js

// A settings fake whose idle window the test can change mid-run, as a real save
// would. Everything else is whatever the pipeline happens to read.
function fakeSettings(minutes = MINUTES) {
  const value = { engines: { idleUnloadMinutes: minutes } };
  return {
    get: () => value,
    set idleUnloadMinutes(m) {
      value.engines.idleUnloadMinutes = m;
    },
  };
}

// An engines fake that reports whether the unload completed. `resident` flips
// to false once a call is allowed to succeed, mirroring a busy worker draining.
function fakeEngines(results) {
  const calls = [];
  return {
    calls,
    unloadIdle() {
      calls.push(true);
      // Consume one scripted result per call; the last one repeats.
      return results.length > 1 ? results.shift() : results[0];
    },
  };
}

test("pipeline: idle unload fires once the configured window elapses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engines = fakeEngines([true]);
  const pipeline = loadPipelineWith({ engines, settings: fakeSettings() });

  pipeline.onSettingsChanged(); // arms the window (state is idle at load)
  t.mock.timers.tick(WINDOW_MS - 1);
  assert.strictEqual(engines.calls.length, 0, "must not evict before the window");

  t.mock.timers.tick(1);
  assert.strictEqual(engines.calls.length, 1, "evicts when the window elapses");

  // A completed unload does not schedule anything else.
  t.mock.timers.tick(WINDOW_MS * 2);
  assert.strictEqual(engines.calls.length, 1, "a complete unload must not retry");
});

test("pipeline: a busy worker retries in seconds, not another full window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // First call finds a worker busy (a Settings "test transcribe"), then it drains.
  const engines = fakeEngines([false, true]);
  const pipeline = loadPipelineWith({ engines, settings: fakeSettings() });

  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS);
  assert.strictEqual(engines.calls.length, 1, "the window elapsed and found it busy");

  t.mock.timers.tick(RETRY_MS - 1);
  assert.strictEqual(engines.calls.length, 1, "the retry has not landed yet");

  t.mock.timers.tick(1);
  assert.strictEqual(engines.calls.length, 2, "the retry lands seconds later, not minutes");

  // That one succeeded, so nothing further is scheduled.
  t.mock.timers.tick(WINDOW_MS * 2);
  assert.strictEqual(engines.calls.length, 2, "a successful retry ends the loop");
});

test("pipeline: a busy worker keeps retrying until it drains", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engines = fakeEngines([false, false, false, true]);
  const pipeline = loadPipelineWith({ engines, settings: fakeSettings() });

  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS);
  // Ticked one retry at a time: each retry is armed from inside the previous
  // timer's callback, so a single large jump would not chain through them.
  for (let i = 0; i < 3; i++) t.mock.timers.tick(RETRY_MS);
  assert.strictEqual(engines.calls.length, 4, "one window plus three retries");

  for (let i = 0; i < 5; i++) t.mock.timers.tick(RETRY_MS);
  assert.strictEqual(engines.calls.length, 4, "stops once the worker is free");
});

test("pipeline: saving settings mid-retry keeps the short delay", (t) => {
  // onSettingsChanged fires on every save, not just idle-window changes. It
  // must not push a deferred worker back out to the full window.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engines = fakeEngines([false, true]);
  const pipeline = loadPipelineWith({ engines, settings: fakeSettings() });

  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS);
  assert.strictEqual(engines.calls.length, 1, "found busy, retry armed");

  pipeline.onSettingsChanged(); // an unrelated save lands inside the retry
  t.mock.timers.tick(RETRY_MS);
  assert.strictEqual(engines.calls.length, 2, "the retry still ran on the short delay");
});

test("pipeline: switching the idle window to 0 cancels a pending retry", (t) => {
  // 0 means "keep models resident for the session" — it must win over a retry
  // that was already armed.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engines = fakeEngines([false, true]);
  const settings = fakeSettings();
  const pipeline = loadPipelineWith({ engines, settings });

  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS);
  assert.strictEqual(engines.calls.length, 1, "found busy, retry armed");

  settings.idleUnloadMinutes = 0;
  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS * 2);
  assert.strictEqual(engines.calls.length, 1, "0 must cancel the pending retry");
});

test("pipeline: an idle window of 0 never arms at all", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engines = fakeEngines([true]);
  const pipeline = loadPipelineWith({ engines, settings: fakeSettings(0) });

  pipeline.onSettingsChanged();
  t.mock.timers.tick(WINDOW_MS * 5);
  assert.strictEqual(engines.calls.length, 0, "0 keeps models resident");
});
