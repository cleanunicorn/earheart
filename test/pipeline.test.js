// Tests for the pipeline: the idle-unload timer (when models get evicted, and
// what happens when a worker is busy at the moment the window elapses), and the
// final transcription driven end to end through the registered IPC handlers
// (bounded built-in decodes, delivery when the STT worker dies mid-way, the
// raw-transcript fallback when cleanup fails, and the cancel, stale-session
// and empty-transcript paths that must keep nothing).
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
function loadPipelineWith({ engines, settings, overrides = {} }) {
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => os.tmpdir() },
      ipcMain: { on() {} },
      Notification: class {
        static isSupported() {
          return true;
        }
        on() {}
        show() {}
      },
    },
    [resolveFrom("./windows")]: { sendToOverlay() {}, showOverlay() {}, hideOverlay() {}, openSettings() {} },
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
  for (const [spec, stub] of Object.entries(overrides)) stubs[resolveFrom(spec)] = stub;

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

/* ---------------- final transcription ---------------- */

const { encodeWav, wavDurationSec, wavToFloat32 } = require("../main/util/wav");

const SR = 16000;

// `seconds` of loud "speech" with a short pause every 7 s, so the final
// decode's splitter has somewhere quiet to cut.
function speechWav(seconds) {
  const samples = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (i / SR) % 7 > 6.6 ? 0 : i % 2 ? 8000 : -8000;
  }
  return encodeWav(samples, SR);
}

// Loud sound with no pause at all: pieces are cut only by the 20 s cap.
function loudWav(seconds) {
  const samples = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 8000 : -8000;
  return encodeWav(samples, SR);
}

const exited = () => Object.assign(new Error("engine process exited"), { code: "ENGINE_EXITED", exitCode: 134 });

// A pipeline wired to recording fakes, driven through its real IPC handlers:
// toggle() starts a dictation, `dictate()` hands it the captured WAV and waits
// for the pipeline to return to idle. `transcribe` scripts the STT backend per
// call; `snapshot` is what the live preview hands the final pass.
function dictationRig({
  engine = "builtin",
  display = true,
  cleanup = false,
  transcribe,
  ensureStt,
  primeCleanup,
  deliver: deliverText,
  onHistory,
  clean: cleanupText,
  notificationThrows = false,
  sttReadiness = () => ({ ok: true }),
  cleanupReadiness = () => ({ ok: true }),
  isDownloading = () => false,
  notificationsSupported = true,
} = {}) {
  const log = {
    warmups: [],
    overlaysCreated: 0,
    settingsOpened: 0,
    notes: [],
    transcribe: [],
    delivered: [],
    history: [],
    notifications: [],
    logs: [],
    statuses: [],
    retries: [],
    failedTakeCards: [],
    settingsEvents: [],
    overlaySent: [],
    hidden: 0,
    cleanCancels: 0,
    lastStart: null,
  };
  let snapshot = null;
  let lastStart = null;
  // Set by overlayLoading(): the next overlay is still loading, and this gets
  // its did-finish-load listener (and, as fail(fn), its did-fail-load one).
  let onLoad = null;
  const handlers = {};
  const cfg = {
    stt: { engine, builtin: { model: "stt-model" }, language: "", livePreview: { enabled: display } },
    cleanup: { enabled: cleanup, engine: "builtin" },
    output: {},
    history: { enabled: true, limit: 100 },
    audio: { deviceId: "", maxRecordingSeconds: 300 },
    engines: { idleUnloadMinutes: 0 },
  };
  let calls = 0;
  let liveDeps = null;
  const pipeline = loadPipelineWith({
    engines: {
      ensureStt: async (...args) => {
        log.warmups.push("stt");
        return ensureStt ? ensureStt(...args) : undefined;
      },
      restartStt() {},
      unloadIdle: () => true,
      cancelClean() {
        log.cleanCancels += 1;
      },
      primeCleanup: async (...args) => {
        log.warmups.push("cleanup");
        return primeCleanup?.(...args);
      },
      getSttReadiness: (sttCfg) => sttReadiness(sttCfg),
      getCleanupReadiness: (cfg) => cleanupReadiness(cfg),
    },
    settings: { get: () => cfg },
    overrides: {
      electron: {
        app: { getPath: () => os.tmpdir() },
        ipcMain: { on: (channel, fn) => (handlers[channel] = fn) },
        Notification: class {
          static isSupported() {
            return notificationsSupported;
          }
          constructor(opts) {
            if (notificationThrows) throw new Error("no notification service");
            this.opts = opts;
            this.handlers = {};
          }
          on(event, fn) {
            this.handlers[event] = fn;
          }
          show() {
            log.notifications.push({ ...this.opts, click: this.handlers.click });
            log.notes.push(this);
          }
        },
      },
      "./windows": {
        createOverlay: () => {
          log.overlaysCreated += 1;
          const loading = onLoad;
          return {
            webContents: {
              isLoading: () => !!loading,
              once: (event, fn) => {
                if (event === "did-finish-load") loading(fn);
                if (event === "did-fail-load") loading.fail?.(fn);
              },
            },
          };
        },
        openSettings: () => {
          log.settingsOpened += 1;
        },
        showOverlay() {},
        hideOverlay() {
          log.hidden += 1;
        },
        sendToSettings: (channel) => log.settingsEvents.push(channel),
        sendToOverlay(channel, payload) {
          log.overlaySent.push(channel);
          if (channel === "record:start") {
            lastStart = payload;
            log.lastStart = payload;
          }
          if (channel === "pipeline:status") {
            log.statuses.push(payload.status);
            if (payload.detail?.retry) log.retries.push({ status: payload.status, ...payload.detail.retry });
            if (payload.detail?.failedTake) log.failedTakeCards.push(payload.detail.failedTake);
            if (payload.status === "done") log.done = payload.detail;
          }
        },
      },
      "./services/route": {
        async transcribe(wav, sttCfg, signal, opts) {
          const n = calls++;
          log.transcribe.push({ engine: sttCfg.engine, sec: wavDurationSec(wav) });
          const text = await transcribe(n, wav);
          opts?.onDecodeMs?.(10);
          return text;
        },
        clean: cleanupText || (async (raw) => `cleaned(${raw})`),
      },
      "./output/deliver": {
        deliver: deliverText || (async (text) => {
          log.delivered.push(text);
          return { method: "paste" };
        }),
      },
      "./history": {
        add: (entry) => {
          log.history.push(entry);
          onHistory?.(entry);
        },
      },
      "./live-preview": {
        createLivePreview: (deps) => {
          liveDeps = deps;
          return { cancel() {}, handleAudio() {}, snapshotFinal: () => snapshot };
        },
      },
      "./util/logger": {
        info() {},
        warn: (...args) => log.logs.push(["warn", ...args]),
        error: (...args) => log.logs.push(["error", ...args]),
      },
      "./util/rtf": {
        createPersistedRtfEstimator: () => ({ record() {}, progressAt: () => 0.5, estimate: () => 0.1 }),
      },
    },
  });
  pipeline.init({ isDownloading });
  async function dictate(wav, snap = { committedRaw: "", decodedSamples: 0, broken: false }) {
    snapshot = engine === "builtin" ? snap : null;
    pipeline.toggle();
    assert.strictEqual(pipeline.getState(), "recording");
    const idle = new Promise((resolve) => {
      pipeline.onStateChange((s) => s === "idle" && resolve());
    });
    handlers["audio:captured"]({}, { sid: lastStart.sid, wav });
    await idle;
  }
  return {
    log,
    dictate,
    pipeline,
    cfg,
    handlers,
    liveTranscribe: (...a) => liveDeps.runTranscribe(...a),
    // What the live preview would hand the next final pass.
    setSnapshot: (snap) => (snapshot = snap),
    overlayLoading: (fn) => (onLoad = fn),
    liveCleanupError: (...a) => liveDeps.onCleanupError(...a),
  };
}

test("pipeline: record:start forwards the saved max dictation length to the overlay", () => {
  // The overlay falls back to 300 s for a cap it can't use, so a dropped field
  // would look exactly like the default; 420 tells the two apart.
  const rig = dictationRig({ transcribe: async () => "unused" });
  rig.cfg.audio.maxRecordingSeconds = 420;
  rig.pipeline.toggle();
  assert.strictEqual(rig.log.lastStart.maxSeconds, 420);
});

test("pipeline: record:start names the discard hotkey for the ✕ key's tooltip", () => {
  const { prettyHotkey } = require("../main/util/hotkey-label");
  const rig = dictationRig({ transcribe: async () => "unused" });
  rig.pipeline.toggle();
  assert.strictEqual(rig.log.lastStart.discardHotkey, "", "unset: nothing to name");
  rig.pipeline.cancel();

  rig.cfg.discardHotkey = "CommandOrControl+Alt+D";
  rig.pipeline.toggle();
  assert.strictEqual(rig.log.lastStart.discardHotkey, prettyHotkey("CommandOrControl+Alt+D"));
  assert.doesNotMatch(rig.log.lastStart.discardHotkey, /CommandOrControl/);
});

// The discard hotkey must do exactly what the ✕ key does in each phase —
// discard while recording, cancel while processing, only dismiss once the
// paste is in flight — so it hands the press to the overlay's own ✕ handler
// rather than deciding here (the handler mapping is pinned in
// overlay-contract.test.js).
test("pipeline: discard presses the overlay's ✕ while a dictation is live, and only then", async () => {
  let finishDelivery;
  let announceDeliveryStarted;
  const pendingDelivery = new Promise((resolve) => {
    finishDelivery = resolve;
  });
  const deliveryStarted = new Promise((resolve) => {
    announceDeliveryStarted = resolve;
  });
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "dictated words",
    deliver: async () => {
      announceDeliveryStarted();
      return pendingDelivery;
    },
  });
  const discards = () => rig.log.overlaySent.filter((c) => c === "record:discard").length;

  rig.pipeline.discard();
  assert.strictEqual(discards(), 0, "idle: nothing to discard");

  rig.pipeline.toggle();
  rig.pipeline.discard();
  assert.strictEqual(discards(), 1, "recording");
  assert.strictEqual(rig.pipeline.getState(), "recording", "the overlay's handler decides, not the pipeline");

  const idle = new Promise((resolve) => {
    rig.pipeline.onStateChange((state) => state === "idle" && resolve());
  });
  rig.handlers["audio:captured"]({}, { sid: rig.log.lastStart.sid, wav: speechWav(1) });
  await deliveryStarted;
  rig.pipeline.discard();
  assert.strictEqual(discards(), 2, "processing");

  finishDelivery({ method: "paste" });
  await idle;
  rig.pipeline.discard();
  assert.strictEqual(discards(), 2, "idle again: nothing to discard");
});

test("pipeline: overlay renderer loss rejects stale capture and allows the next hotkey", () => {
  const rig = dictationRig({ transcribe: async () => "unused" });
  const states = [];
  rig.pipeline.onStateChange((state) => states.push(state));

  rig.pipeline.toggle();
  assert.strictEqual(rig.pipeline.getState(), "recording");
  const staleSid = rig.log.lastStart.sid;
  assert.ok(rig.handlers["record:error"]);
  rig.pipeline.onOverlayRendererGone();

  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.ok(rig.log.statuses.includes("error"));
  assert.deepStrictEqual(states, ["recording", "idle"]);

  rig.handlers["audio:captured"]({}, { sid: staleSid, wav: speechWav(1) });
  assert.strictEqual(rig.log.transcribe.length, 0, "a late capture from the dead renderer is stale");

  rig.pipeline.toggle();
  assert.strictEqual(rig.pipeline.getState(), "recording");
  assert.deepStrictEqual(states, ["recording", "idle", "recording"]);
});

test("pipeline: overlay renderer loss outside recording is a no-op", () => {
  const rig = dictationRig({ transcribe: async () => "unused" });
  rig.pipeline.onOverlayRendererGone();

  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.deepStrictEqual(rig.log.statuses, []);
});

test("pipeline: dismissing the overlay during delivery preserves delivery and history", async () => {
  let finishDelivery;
  let announceDeliveryStarted;
  const pendingDelivery = new Promise((resolve) => {
    finishDelivery = resolve;
  });
  const deliveryStarted = new Promise((resolve) => {
    announceDeliveryStarted = resolve;
  });
  let deliverySignal;
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "dictated words",
    deliver: async (text, output, signal) => {
      deliverySignal = signal;
      rig.log.delivered.push(text);
      announceDeliveryStarted();
      return pendingDelivery;
    },
  });

  rig.pipeline.toggle();
  const sid = rig.log.lastStart.sid;
  const idle = new Promise((resolve) => {
    rig.pipeline.onStateChange((state) => state === "idle" && resolve());
  });
  rig.handlers["audio:captured"]({}, { sid, wav: speechWav(1) });
  await deliveryStarted;
  assert.ok(rig.log.statuses.includes("delivering"));

  rig.handlers["pipeline:cancel"]({}, { dismiss: true });
  assert.strictEqual(deliverySignal.aborted, false, "overlay dismissal cannot abort delivery");
  assert.strictEqual(rig.pipeline.getState(), "processing");

  finishDelivery({ method: "paste" });
  await idle;

  assert.deepStrictEqual(rig.log.delivered, ["dictated words"]);
  assert.strictEqual(rig.log.history.length, 1, "the completed dictation is retained in history");
  assert.strictEqual(rig.log.history[0].raw, "dictated words");
  assert.ok(rig.log.statuses.includes("done"));
  assert.strictEqual(rig.pipeline.getState(), "idle");
});

test("pipeline: tray cancellation during delivery still records the transcript", async () => {
  let finishDelivery;
  let announceDeliveryStarted;
  let announceHistoryWritten;
  const pendingDelivery = new Promise((resolve) => {
    finishDelivery = resolve;
  });
  const deliveryStarted = new Promise((resolve) => {
    announceDeliveryStarted = resolve;
  });
  const historyWritten = new Promise((resolve) => {
    announceHistoryWritten = resolve;
  });
  let deliverySignal;
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "dictated words",
    onHistory: announceHistoryWritten,
    deliver: async (text, output, signal) => {
      deliverySignal = signal;
      rig.log.delivered.push(text);
      announceDeliveryStarted();
      return pendingDelivery;
    },
  });

  rig.pipeline.toggle();
  const sid = rig.log.lastStart.sid;
  rig.handlers["audio:captured"]({}, { sid, wav: speechWav(1) });
  await deliveryStarted;
  // The words are the user's as soon as they exist: history has them before
  // the paste keystroke is even attempted, so no cancel can lose them.
  assert.strictEqual(rig.log.history.length, 1, "history is written before delivery starts");
  rig.pipeline.cancel();
  assert.strictEqual(deliverySignal.aborted, true, "tray Cancel still aborts delivery");
  assert.strictEqual(rig.pipeline.getState(), "idle");

  finishDelivery({ method: "cancelled" });
  await historyWritten;
  assert.deepStrictEqual(rig.log.delivered, ["dictated words"]);
  assert.strictEqual(rig.log.history.length, 1);
  assert.strictEqual(rig.log.history[0].raw, "dictated words");
});

test("pipeline: a delivery that throws still keeps the transcript in history", async () => {
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "dictated words",
    deliver: async () => {
      throw new Error("paste tool exploded");
    },
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(rig.log.history.length, 1, "exactly one history row");
  // The row's exact shape: nothing about delivery can be known yet, so
  // nothing about it is recorded.
  assert.deepStrictEqual(rig.log.history[0], { raw: "dictated words", text: "dictated words", cleaned: false });
  // Nothing reached the target app, so the user is still told so.
  assert.ok(rig.log.statuses.includes("error"));
  assert.ok(rig.log.notifications.some((n) => /dictation failed/.test(n.title)));
});

test("pipeline: no built-in final decode exceeds 20 s, on every assembly path", async () => {
  const ok = async (n) => `w${n}`;
  const cases = [
    { name: "no committed chunk", wav: 200, snap: { committedRaw: "", decodedSamples: 0, broken: false }, decoded: 200 },
    { name: "broken snapshot", wav: 200, snap: { committedRaw: "holey", decodedSamples: 30 * SR, broken: true }, decoded: 200 },
    { name: "long tail after a trusted prefix", wav: 200, snap: { committedRaw: "said", decodedSamples: 10 * SR, broken: false }, decoded: 190 },
  ];
  for (const display of [true, false]) {
    for (const c of cases) {
      const rig = dictationRig({ display, transcribe: ok });
      await rig.dictate(speechWav(c.wav), c.snap);
      const secs = rig.log.transcribe.map((t) => t.sec);
      assert.ok(secs.length > 1, `${c.name}: split into pieces`);
      for (const sec of secs) assert.ok(sec <= 20, `${c.name} (display ${display}): a ${sec}s decode`);
      const total = secs.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(total - c.decoded) < 0.01, `${c.name}: decoded ${total}s of ${c.decoded}s`);
      assert.strictEqual(rig.log.delivered.length, 1);
      const expected = secs.map((_, i) => `w${i}`).join(" ");
      assert.strictEqual(rig.log.delivered[0], c.snap.broken || !c.snap.committedRaw ? expected : `said ${expected}`);
      assert.strictEqual(rig.log.history[0].incomplete, undefined);
      assert.strictEqual(rig.log.done.incomplete, false);
      assert.strictEqual(rig.log.notifications.length, 0);
    }
  }
});

test("pipeline: remote STT still gets the whole recording in one request", async () => {
  const rig = dictationRig({ engine: "remote", transcribe: async () => "remote text" });
  await rig.dictate(speechWav(200));
  assert.deepStrictEqual(rig.log.transcribe.map((t) => [t.engine, t.sec]), [["remote", 200]]);
  assert.deepStrictEqual(rig.log.delivered, ["remote text"]);
});

test("pipeline: an STT worker death mid-transcription delivers what decoded, then the next dictation works", async () => {
  // Dictation 1: 50 s of pause-less speech → pieces of 20, 20 and 10 s; the
  // worker dies on piece 2, on its retry, and on both tries of the recovery
  // pass. Pieces 1 and 3 are the user's words and must be delivered.
  let dead = true;
  const rig = dictationRig({
    cleanup: true,
    transcribe: async (n) => {
      if (dead && [1, 2, 4, 5].includes(n)) throw exited();
      return `w${n}`;
    },
  });
  await rig.dictate(loudWav(50));
  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.strictEqual(rig.log.notifications.length, 1, "one notification says the transcript is incomplete");
  assert.match(rig.log.notifications[0].title, /interrupted/);
  assert.deepStrictEqual(rig.log.delivered, ["cleaned(w0 w3)"], "delivered once, through the normal cleanup");
  assert.strictEqual(rig.log.history.length, 1);
  assert.strictEqual(rig.log.history[0].raw, "w0 w3");
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual(rig.log.done.incomplete, true, "the overlay's done card says so too");
  assert.deepStrictEqual(rig.log.settingsEvents, ["history:changed"]);
  assert.ok(!rig.log.statuses.includes("error") && !rig.log.statuses.includes("empty"));

  // Dictation 2: the worker is back; a normal dictation, nothing stale carried over.
  dead = false;
  await rig.dictate(loudWav(10));
  assert.deepStrictEqual(rig.log.delivered, ["cleaned(w0 w3)", "cleaned(w6)"]);
  assert.strictEqual(rig.log.history[1].incomplete, undefined);
  assert.strictEqual(rig.log.notifications.length, 1, "no second notification");
  assert.strictEqual(rig.pipeline.getState(), "idle");
});

test("pipeline: a transcription that recovers nothing is an error, not an empty dictation", async () => {
  const rig = dictationRig({ transcribe: async () => { throw exited(); } });
  await rig.dictate(speechWav(20));
  assert.ok(rig.log.statuses.includes("error"));
  assert.ok(!rig.log.statuses.includes("empty"));
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.deepStrictEqual(rig.log.history, []);
});

test("pipeline: a model that fails to load still delivers the committed live-preview text", async () => {
  const rig = dictationRig({
    ensureStt: async () => { throw new Error("model load failed"); },
    transcribe: async () => { throw new Error("model load failed"); },
  });
  await rig.dictate(speechWav(40), { committedRaw: "words said so far", decodedSamples: 30 * SR, broken: false });
  assert.deepStrictEqual(rig.log.delivered, ["words said so far"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual(rig.log.notifications.length, 1);
});

test("pipeline: a broken snapshot's text is delivered when the final decode recovers nothing", async () => {
  const rig = dictationRig({ transcribe: async () => { throw exited(); } });
  await rig.dictate(speechWav(40), { committedRaw: "chunk words", decodedSamples: 10 * SR, broken: true });
  assert.deepStrictEqual(rig.log.delivered, ["chunk words"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
});

test("pipeline: live-preview chunk decodes are split at pauses too", async () => {
  // A committed chunk's text is reused verbatim in the final transcript, and a
  // two-sentence chunk is exactly what makes the model drop one of them.
  const rig = dictationRig({ transcribe: async (n) => `w${n}` });
  const stt = rig.cfg.stt;
  const text = await rig.liveTranscribe(speechWav(15), stt, new AbortController().signal);
  const secs = rig.log.transcribe.map((t) => t.sec);
  assert.ok(secs.length >= 2, `split into ${secs.length} decodes`);
  assert.strictEqual(text, secs.map((_, i) => `w${i}`).join(" "));
});

test("pipeline: a live chunk that decodes only in part fails, so the final pass re-decodes it", async () => {
  // Handing live-preview.js partial text would commit a hole into the final
  // transcript; a thrown decode marks the snapshot broken instead.
  const rig = dictationRig({
    transcribe: async (n) => {
      if (n === 1 || n === 2) throw exited();
      return `w${n}`;
    },
  });
  await assert.rejects(
    rig.liveTranscribe(loudWav(50), rig.cfg.stt, new AbortController().signal),
    (err) => err.message === "live chunk decode incomplete" && err.partialText === "w0 w3"
  );
});

test("pipeline: partial-live salvage fills a failed final range once and remains incomplete", async () => {
  const samples = new Int16Array(50 * SR);
  for (let i = 0; i < samples.length; i++) {
    const amp = i >= 20 * SR && i < 30 * SR ? 6000 : 8000;
    samples[i] = i % 2 ? amp : -amp;
  }
  const holdsMarked = (w) => wavToFloat32(w).samples.some((x) => Math.abs(x * 32768 - 6000) < 1);
  const rig = dictationRig({
    transcribe: async (n, w) => {
      if (holdsMarked(w)) throw exited();
      return `w${n}`;
    },
  });
  await rig.dictate(encodeWav(samples, SR), {
    committedRaw: "recovered words",
    decodedSamples: 0,
    broken: true,
    chunks: [{ from: 20 * SR, to: 30 * SR, text: "recovered words" }],
  });
  assert.deepStrictEqual(rig.log.delivered, ["w0 recovered words w3 w4"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual((rig.log.delivered[0].match(/recovered words/g) || []).length, 1);
});

test("pipeline: speech that decodes to nothing at all falls back to the live-preview words", async () => {
  // Every piece empty is exactly the dictation review A:correctness-1 saw
  // vanish: it is incomplete and delivers what the live preview had.
  const rig = dictationRig({ transcribe: async () => "" });
  await rig.dictate(loudWav(10), { committedRaw: "live words", decodedSamples: 0, broken: true, chunks: [] });
  assert.deepStrictEqual(rig.log.delivered, ["live words"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual(rig.log.notifications.length, 1);
});

test("pipeline: a broken snapshot's words fill the range a failed final piece left out", async () => {
  // 50 s where 25-30 s is audio the worker dies on (amplitude-marked, so the
  // fake knows it whatever the cuts); the committed "middle" chunk covers it.
  const samples = new Int16Array(50 * SR);
  for (let i = 0; i < samples.length; i++) {
    const amp = i >= 25 * SR && i < 30 * SR ? 6000 : 8000;
    samples[i] = i % 2 ? amp : -amp;
  }
  const holdsMarked = (w) => wavToFloat32(w).samples.some((x) => Math.abs(x * 32768 - 6000) < 1);
  const rig = dictationRig({
    transcribe: async (n, w) => {
      if (holdsMarked(w)) throw exited();
      return `w${n}`;
    },
  });
  await rig.dictate(encodeWav(samples, SR), {
    committedRaw: "early middle late",
    decodedSamples: 0,
    broken: true,
    chunks: [
      { from: 0, to: 15 * SR, text: "early" },
      { from: 22 * SR, to: 38 * SR, text: "middle" },
      { from: 41 * SR, to: 50 * SR, text: "late" },
    ],
  });
  // Pieces 0-15, 15-20, 20-22, 22-38 (dies twice: calls 3, 4), 38-40, 40-41, 41-50.
  assert.deepStrictEqual(rig.log.delivered, ["w0 w1 w2 middle w5 w6 w7"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual(rig.log.notifications.length, 1);
});

test("pipeline: a tail under 0.05 s after the committed text is not decoded", async () => {
  // Stop landed right on a chunk boundary: the committed text IS the
  // transcript. The early return also has to keep the { text, partial } shape,
  // or process() reads the dictation as empty.
  const framesWav = (frames) => {
    const samples = new Int16Array(frames);
    for (let i = 0; i < frames; i++) samples[i] = i % 2 ? 8000 : -8000;
    return encodeWav(samples, SR);
  };
  const snap = { committedRaw: "said so far", decodedSamples: 30 * SR, broken: false, chunks: [] };

  const under = dictationRig({ transcribe: async (n) => `w${n}` });
  await under.dictate(framesWav(30 * SR + 799), snap); // 0.0499 s of tail
  assert.strictEqual(under.log.transcribe.length, 0, "nothing decoded");
  assert.deepStrictEqual(under.log.delivered, ["said so far"]);
  assert.strictEqual(under.log.history[0].incomplete, undefined);
  assert.strictEqual(under.log.notifications.length, 0);

  const at = dictationRig({ transcribe: async (n) => `w${n}` });
  await at.dictate(framesWav(30 * SR + 800), snap); // exactly 0.05 s: decoded
  assert.strictEqual(at.log.transcribe.length, 1);
  assert.deepStrictEqual(at.log.delivered, ["said so far w0"]);
});

test("pipeline: a long stretch of speech that decodes to nothing makes the dictation incomplete", async () => {
  // 50 s of pause-less speech, the middle 20 s piece decoding "" (it is at the
  // cap, so there's no padded retry): the user is told the transcript is incomplete.
  const samples = new Int16Array(50 * SR);
  for (let i = 0; i < samples.length; i++) {
    const amp = i >= 20 * SR && i < 40 * SR ? 6000 : 8000;
    samples[i] = i % 2 ? amp : -amp;
  }
  const holdsMarked = (w) => wavToFloat32(w).samples.some((x) => Math.abs(x * 32768 - 6000) < 1);
  const rig = dictationRig({ transcribe: async (n, w) => (holdsMarked(w) ? "" : `w${n}`) });
  await rig.dictate(encodeWav(samples, SR));
  assert.deepStrictEqual(rig.log.delivered, ["w0 w2"]);
  assert.strictEqual(rig.log.history[0].incomplete, true);
  assert.strictEqual(rig.log.notifications.length, 1);
});

test("pipeline: failed cleanup delivers raw once, records failure and notifies", async () => {
  const rig = dictationRig({
    cleanup: true,
    transcribe: async () => "Keep these words.",
    clean: async () => { throw new Error("Cleanup returned no usable text"); },
  });
  await rig.dictate(speechWav(1));
  assert.deepStrictEqual(rig.log.delivered, ["Keep these words."]);
  assert.strictEqual(rig.log.history[0].raw, "Keep these words.");
  assert.strictEqual(rig.log.history[0].text, "Keep these words.");
  assert.strictEqual(rig.log.history[0].cleaned, false);
  // The title is the half of the sentence that says the raw transcript was
  // used (CLEAN_RUNAWAY_MESSAGE leaves it out on purpose); the body is the
  // client's fixed message and never the dictated text.
  const notes = rig.log.notifications.filter((entry) => /cleanup failed/.test(entry.title));
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].title, /cleanup failed, used raw transcript/);
  assert.strictEqual(notes[0].body, "Cleanup returned no usable text");
  const line = rig.log.logs.find(([, label]) => label === "cleanup failed:");
  assert.ok(line, "the failure is logged");
  assert.strictEqual(line[2].message, "Cleanup returned no usable text");
  for (const text of [notes[0].body, String(line[2].message)]) {
    assert.doesNotMatch(text, /Keep these words/);
  }
});

test("pipeline: a cleanup failure that can pass is retried, and the user gets the cleaned text", async () => {
  let attempts = 0;
  const rig = dictationRig({
    cleanup: true,
    transcribe: async () => "keep these words",
    clean: async (raw) => {
      attempts++;
      if (attempts === 1) throw exited();
      return `cleaned(${raw})`;
    },
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(rig.log.delivered, ["cleaned(keep these words)"]);
  assert.strictEqual(rig.log.history[0].cleaned, true);
  assert.deepStrictEqual(rig.log.notifications, [], "a recovered cleanup is not a failure");
  assert.deepStrictEqual(rig.log.retries, [{ status: "cleaning", attempt: 2, of: 3 }], "the overlay counts the tries");
  assert.ok(
    rig.log.logs.some(([level, msg]) => level === "warn" && /cleanup failed, retrying \(attempt 2 of 3\)/.test(msg)),
    "the retry is logged"
  );
});

test("pipeline: a cleanup that keeps failing falls back to the raw text after three tries", async () => {
  let attempts = 0;
  const rig = dictationRig({
    cleanup: true,
    transcribe: async () => "keep these words",
    clean: async () => {
      attempts++;
      throw Object.assign(new Error("Cleanup service error 503"), { status: 503 });
    },
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(attempts, 3);
  assert.deepStrictEqual(rig.log.delivered, ["keep these words"], "golden rule 8: the words still go out");
  assert.strictEqual(rig.log.history[0].cleaned, false);
  assert.deepStrictEqual(rig.log.retries.map((r) => r.attempt), [2, 3]);
  const [note] = rig.log.notifications;
  assert.strictEqual(note.title, "Earheart: cleanup failed 3 times, used raw transcript");
  assert.strictEqual(note.body, "Cleanup service error 503");
});

test("pipeline: a cleanup failure a retry can't fix falls back at once", async () => {
  let attempts = 0;
  const rig = dictationRig({
    cleanup: true,
    transcribe: async () => "keep these words",
    clean: async () => {
      attempts++;
      throw Object.assign(new Error("Cleanup service error 401 — check the API key in Settings"), { status: 401 });
    },
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(attempts, 1);
  assert.deepStrictEqual(rig.log.retries, []);
  assert.deepStrictEqual(rig.log.delivered, ["keep these words"]);
  assert.strictEqual(rig.log.notifications[0].title, "Earheart: cleanup failed, used raw transcript");
});

test("pipeline: a cancel while cleanup waits to retry delivers nothing and retries nothing", async () => {
  let attempts = 0;
  let rig;
  rig = dictationRig({
    cleanup: true,
    transcribe: async () => "keep these words",
    clean: async () => {
      attempts++;
      // Cancel lands while the retry pauses.
      setImmediate(() => rig.pipeline.cancel());
      throw exited();
    },
  });
  await rig.dictate(speechWav(1));
  await new Promise((resolve) => setTimeout(resolve, 400)); // past the first retry pause
  assert.strictEqual(attempts, 1);
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.deepStrictEqual(rig.log.history, []);
  assert.deepStrictEqual(rig.log.notifications, []);
});

test("pipeline: a remote STT request that couldn't reach the service is retried", async () => {
  const rig = dictationRig({
    engine: "remote",
    transcribe: async (n) => {
      if (n === 0) throw Object.assign(new Error("Couldn't reach api.example.test"), { code: "SERVICE_UNREACHABLE" });
      return "remote words";
    },
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(rig.log.transcribe.length, 2);
  assert.deepStrictEqual(rig.log.delivered, ["remote words"]);
  assert.deepStrictEqual(rig.log.retries, [{ status: "transcribing", attempt: 2, of: 3 }]);
  assert.deepStrictEqual(rig.log.notifications, []);
});

test("pipeline: a built-in model load that crashed the worker is tried again", async () => {
  let loads = 0;
  const rig = dictationRig({
    // Load 1 is the warm-up when recording starts (its failure is ignored);
    // load 2 is the final pass's, which crashes; load 3 is its retry.
    ensureStt: async () => {
      if (++loads <= 2) throw exited();
    },
    transcribe: async () => "loaded on the second try",
  });
  await rig.dictate(speechWav(1));
  assert.strictEqual(loads, 3);
  assert.deepStrictEqual(rig.log.delivered, ["loaded on the second try"]);
  assert.deepStrictEqual(rig.log.retries, [{ status: "transcribing", attempt: 2, of: 3 }]);
  assert.ok(!rig.log.statuses.includes("error"));
});

// Every pipeline notification leads to Settings, where the service, key and
// paste options live: clicking one must open it.
function assertClickOpensSettings(rig, entry) {
  assert.strictEqual(typeof entry.click, "function", `"${entry.title}" has a click action`);
  const before = rig.log.settingsOpened;
  entry.click();
  assert.strictEqual(rig.log.settingsOpened, before + 1);
}

test("pipeline: a failed transcription notifies, and the click opens Settings", async () => {
  // The overlay card goes away, so a notification has to carry the failure —
  // and, since #293, that the recording is kept and how to retry it.
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => {
      throw new Error("Couldn't reach api.example.test");
    },
  });
  await rig.dictate(speechWav(1));
  assert.ok(rig.log.statuses.includes("error"));
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.strictEqual(rig.log.notifications.length, 1);
  const [note] = rig.log.notifications;
  assert.strictEqual(note.title, "Earheart: transcription failed, recording kept");
  assert.strictEqual(
    note.body,
    "Retry it from the tray menu or the overlay, or run earheart --retry, within 10 minutes. Couldn't reach api.example.test"
  );
  assertClickOpensSettings(rig, note);
});

test("pipeline: the interrupted, cleanup-failed and paste-failed notifications open Settings", async () => {
  const rig = dictationRig({
    cleanup: true,
    // 50 s of pause-less speech decodes in three pieces; the worker dies on
    // the second, its retry and the recovery pass, so the transcript is
    // incomplete.
    transcribe: async (n) => {
      if ([1, 2, 4, 5].includes(n)) throw exited();
      return `w${n}`;
    },
    clean: async () => {
      throw new Error("Cleanup service error 503");
    },
    deliver: async (text) => {
      rig.log.delivered.push(text);
      return { method: "clipboard", note: "Auto-paste failed", hint: "Paste it with Ctrl+V" };
    },
  });
  await rig.dictate(loudWav(50));
  const titles = rig.log.notifications.map((entry) => entry.title);
  assert.ok(titles.some((t) => /interrupted/.test(t)), titles.join(", "));
  assert.ok(titles.some((t) => /cleanup failed/.test(t)), titles.join(", "));
  assert.ok(titles.some((t) => /auto-paste failed/.test(t)), titles.join(", "));
  for (const entry of rig.log.notifications) assertClickOpensSettings(rig, entry);
});

test("pipeline: a notification that can't be shown never costs the user's words", async () => {
  const rig = dictationRig({
    cleanup: true,
    notificationThrows: true,
    transcribe: async () => "Keep these words.",
    clean: async () => {
      throw new Error("Cleanup service error 503");
    },
  });
  await rig.dictate(speechWav(1));
  assert.deepStrictEqual(rig.log.delivered, ["Keep these words."]);
  assert.strictEqual(rig.log.history[0].text, "Keep these words.");
  assert.ok(rig.log.statuses.includes("done"));
});

/* ---------------- missing speech model (#194) ---------------- */

const MISSING = { ok: false, reason: "missing", modelId: "stt-model", label: "Parakeet TDT 0.6B v3 (int8)" };

test("pipeline: a missing built-in model refuses the recording before the mic opens", () => {
  const rig = dictationRig({ cleanup: true, sttReadiness: () => MISSING, transcribe: async () => "unused" });

  rig.pipeline.toggle();

  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.strictEqual(rig.log.lastStart, null, "no record:start was sent");
  assert.strictEqual(rig.log.overlaysCreated, 0, "no recording overlay was opened");
  assert.deepStrictEqual(rig.log.warmups, [], "no engine was warmed for a dictation that can't run");
  assert.deepStrictEqual(rig.log.transcribe, []);
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.deepStrictEqual(rig.log.history, []);
  assert.strictEqual(rig.log.notifications.length, 1);
  const note = rig.log.notifications[0];
  assert.match(note.title, /speech model not downloaded/);
  assert.ok(note.body.includes(MISSING.label), "names the model by its registry label");
  assert.strictEqual(rig.log.settingsOpened, 0);
  rig.log.notes[0].handlers.click();
  assert.strictEqual(rig.log.settingsOpened, 1, "the notice opens Settings");
});

test("pipeline: the model check runs on every press, so a finished download records at once", async () => {
  let readiness = MISSING;
  const rig = dictationRig({ sttReadiness: () => readiness, transcribe: async () => "hello" });

  rig.pipeline.toggle();
  assert.strictEqual(rig.pipeline.getState(), "idle");

  readiness = { ok: true };
  await rig.dictate(speechWav(2));

  assert.deepStrictEqual(rig.log.delivered, ["hello"]);
});

test("pipeline: the remote engine records as before", async () => {
  const seen = [];
  const rig = dictationRig({
    engine: "remote",
    sttReadiness: (sttCfg) => {
      seen.push(sttCfg.engine);
      return sttCfg.engine === "builtin" ? MISSING : { ok: true };
    },
    transcribe: async () => "remote words",
  });

  await rig.dictate(speechWav(2));

  assert.deepStrictEqual(seen, ["remote"]);
  assert.deepStrictEqual(rig.log.delivered, ["remote words"]);
  assert.strictEqual(rig.log.notifications.length, 0);
});

test("pipeline: an unknown model id is reported, not thrown", () => {
  const rig = dictationRig({ sttReadiness: () => ({ ok: false, reason: "unknown", modelId: "gone" }) });

  assert.doesNotThrow(() => rig.pipeline.toggle());

  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.match(rig.log.notifications[0].title, /no speech model/);
});

test("pipeline: without a notification service a missing model opens Settings", () => {
  const rig = dictationRig({ sttReadiness: () => MISSING, notificationsSupported: false });

  rig.pipeline.toggle();

  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.strictEqual(rig.log.notifications.length, 0);
  assert.strictEqual(rig.log.settingsOpened, 1);
});

test("pipeline: without a notification service a failed dictation opens nothing", async () => {
  // The overlay already said it; Settings popping up uninvited would not help.
  const rig = dictationRig({
    engine: "remote",
    notificationsSupported: false,
    transcribe: async () => {
      throw new Error("Couldn't reach api.example.test");
    },
  });
  await rig.dictate(speechWav(1));
  assert.ok(rig.log.statuses.includes("error"));
  assert.strictEqual(rig.log.notifications.length, 0);
  assert.strictEqual(rig.log.settingsOpened, 0);
});

test("pipeline: a history failure never costs the user's words or says they were lost", async () => {
  const rig = dictationRig({
    transcribe: async () => "Delivered words.",
    onHistory: () => {
      throw new Error("history disk full");
    },
  });
  await rig.dictate(speechWav(1));
  // History runs before delivery now, so its failure must not block the paste.
  assert.deepStrictEqual(rig.log.delivered, ["Delivered words."]);
  assert.ok(!rig.log.notifications.some((n) => /dictation failed/.test(n.title)), "no lost-dictation notice");
  assert.ok(!rig.log.statuses.includes("error"));
  assert.ok(rig.log.statuses.includes("done"));
  assert.ok(rig.log.logs.some(([level, label]) => level === "error" && label === "history add failed:"));
});

test("pipeline: a long error is clipped to the notification limit", async () => {
  const { BODY_MAX } = require("../main/setup-notices");
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => {
      throw new Error("x".repeat(400));
    },
  });
  await rig.dictate(speechWav(1));
  const { body } = rig.log.notifications[0];
  assert.strictEqual(body.length, BODY_MAX);
  // The retry route leads, so clipping a long error never cuts it off.
  assert.ok(body.startsWith("Retry it from the tray menu"), body);
});

/* ---------------- never lose the words: cancel, stale and empty paths (#196) ---------------- */

// Let process() run to its end after the promise it is awaiting settles: its
// continuations are microtasks, and a macrotask runs only once they drain.
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A cleanup that hangs until the test lets it go, so a cancel can land mid-clean.
function heldCleanup() {
  const held = {};
  held.started = new Promise((resolve) => {
    held.clean = (raw, cfg, signal) => {
      held.signal = signal;
      resolve();
      return new Promise((res, rej) => {
        held.finish = res;
        signal.addEventListener("abort", () => held.rejectOnAbort && rej(new Error("aborted")));
      });
    };
  });
  return held;
}

function assertNothingKept(rig) {
  assert.deepStrictEqual(rig.log.delivered, [], "a cancelled dictation is not delivered");
  assert.deepStrictEqual(rig.log.history, [], "nor written to history");
  assert.deepStrictEqual(rig.log.notifications, [], "nor reported as a failure");
  assert.ok(!rig.log.logs.some(([, label]) => label === "cleanup failed:"), "nor logged as one");
  for (const status of ["delivering", "done", "error"]) {
    assert.ok(!rig.log.statuses.includes(status), `no "${status}" after the cancel`);
  }
}

for (const [name, rejectOnAbort] of [
  ["aborts cleanup and delivers nothing", true],
  ["discards a cleanup that finishes anyway", false],
]) {
  test(`pipeline: a cancel while cleaning ${name}`, async () => {
    // Cancel is the user saying "not this one": the dictation ends where it is.
    // A cleanup the abort makes throw is not a cleanup failure (no raw-text
    // fallback, no notice), and one that replies late is not delivered.
    const held = heldCleanup();
    held.rejectOnAbort = rejectOnAbort;
    const rig = dictationRig({ cleanup: true, transcribe: async () => "words to drop", clean: held.clean });

    rig.pipeline.toggle();
    rig.handlers["audio:captured"]({}, { sid: rig.log.lastStart.sid, wav: speechWav(1) });
    await held.started;
    assert.strictEqual(rig.pipeline.getState(), "processing");
    const cancelsBefore = rig.log.cleanCancels;

    rig.pipeline.cancel();
    assert.strictEqual(held.signal.aborted, true, "the cleanup request is aborted");
    assert.strictEqual(rig.log.cleanCancels, cancelsBefore + 1, "and the worker told to stop generating");
    assert.strictEqual(rig.pipeline.getState(), "idle");

    if (!rejectOnAbort) held.finish("cleaned too late");
    await flush();

    assertNothingKept(rig);
    assert.strictEqual(rig.pipeline.getState(), "idle");
  });
}

test("pipeline: empty text says \"empty\", keeps nothing, and hides the overlay after 1.8 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = dictationRig({ engine: "remote", transcribe: async () => "" });
  await rig.dictate(speechWav(1));

  assert.deepStrictEqual(rig.log.statuses, ["transcribing", "empty"]);
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.deepStrictEqual(rig.log.history, []);
  assert.deepStrictEqual(rig.log.notifications, []);

  t.mock.timers.tick(1799);
  assert.strictEqual(rig.log.hidden, 0, "the empty card stays up long enough to read");
  t.mock.timers.tick(1);
  assert.strictEqual(rig.log.hidden, 1);
});

test("pipeline: a new dictation started before the hide timer keeps its overlay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = dictationRig({ engine: "remote", transcribe: async () => "" });
  await rig.dictate(speechWav(1));

  rig.pipeline.toggle(); // the user is already talking again
  assert.strictEqual(rig.pipeline.getState(), "recording");
  t.mock.timers.tick(5000);
  assert.strictEqual(rig.log.hidden, 0, "the old session's timer must not hide the new recording");
});

test("pipeline: a paste hint is notified in full and the card stays up 4 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hint = "Grant Accessibility access, then paste with Cmd+V";
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "Keep these words.",
    deliver: async (text) => {
      rig.log.delivered.push(text);
      return { method: "clipboard", note: "Copied", hint };
    },
  });
  await rig.dictate(speechWav(1));

  assert.deepStrictEqual(rig.log.delivered, ["Keep these words."]);
  assert.deepStrictEqual(rig.log.history, [{ raw: "Keep these words.", text: "Keep these words.", cleaned: false }]);
  assert.deepStrictEqual(
    rig.log.notifications.map(({ title, body }) => ({ title, body })),
    [{ title: "Earheart: auto-paste failed, copied to clipboard", body: hint }]
  );
  assert.strictEqual(rig.log.done.method, "clipboard");

  t.mock.timers.tick(3999);
  assert.strictEqual(rig.log.hidden, 0, "a card with a note outlives the plain 1.6 s one");
  t.mock.timers.tick(1);
  assert.strictEqual(rig.log.hidden, 1);
});

// 8000 frames whose first half (amplitude 6000) is what the live preview
// already committed and whose second half (8000) is the tail.
function halfCommittedWav() {
  const samples = new Int16Array(8000);
  for (let i = 0; i < samples.length; i++) {
    const amp = i < 4000 ? 6000 : 8000;
    samples[i] = i % 2 ? amp : -amp;
  }
  return encodeWav(samples, SR);
}
const amplitudes = (w) => new Set(Array.from(wavToFloat32(w).samples, (x) => Math.round(Math.abs(x * 32768))));

test("pipeline: a trusted snapshot decodes only the tail and joins it onto the committed text", async () => {
  const seen = [];
  const rig = dictationRig({
    transcribe: async (n, w) => {
      seen.push(w);
      return "the tail";
    },
  });
  await rig.dictate(halfCommittedWav(), { committedRaw: "committed words", decodedSamples: 4000, broken: false, chunks: [] });

  assert.strictEqual(seen.length, 1, "one decode, of the tail only");
  assert.strictEqual(wavToFloat32(seen[0]).samples.length, 4000, "4000 of 8000 frames");
  assert.deepStrictEqual([...amplitudes(seen[0])], [8000], "and they are the last 4000");
  assert.deepStrictEqual(rig.log.delivered, ["committed words the tail"]);
  assert.deepStrictEqual(rig.log.history, [
    { raw: "committed words the tail", text: "committed words the tail", cleaned: false },
  ]);
});

test("pipeline: a broken snapshot decodes the whole recording and does not reuse its text", async () => {
  const seen = [];
  const rig = dictationRig({
    transcribe: async (n, w) => {
      seen.push(w);
      return "all of it";
    },
  });
  await rig.dictate(halfCommittedWav(), { committedRaw: "holey words", decodedSamples: 4000, broken: true, chunks: [] });

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(wavToFloat32(seen[0]).samples.length, 8000, "every frame is decoded again");
  assert.deepStrictEqual(rig.log.delivered, ["all of it"], "the broken text is salvage only, not a prefix");
  assert.strictEqual(rig.log.history[0].incomplete, undefined);
});

test("pipeline: an empty or stale audio:captured payload is ignored, not thrown", () => {
  const rig = dictationRig({ transcribe: async () => "unused" });
  rig.pipeline.toggle();
  const { sid } = rig.log.lastStart;

  assert.doesNotThrow(() => rig.handlers["audio:captured"]({}));
  assert.doesNotThrow(() => rig.handlers["audio:captured"]({}, { sid: sid - 1, wav: speechWav(1) }));

  assert.strictEqual(rig.pipeline.getState(), "recording", "the real recording carries on");
  assert.strictEqual(rig.log.transcribe.length, 0);
});

test("pipeline: record:error from the current recording ends it and hides the error after 5 s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = dictationRig({ transcribe: async () => "unused" });
  rig.pipeline.toggle();
  const { sid } = rig.log.lastStart;

  rig.handlers["record:error"]({}, { sid: sid - 1, message: "old mic error" });
  assert.strictEqual(rig.pipeline.getState(), "recording", "a stale session's error is ignored");

  rig.handlers["record:error"]({}, { sid, message: "Microphone unavailable" });
  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.deepStrictEqual(rig.log.statuses, ["error"]);
  t.mock.timers.tick(4999);
  assert.strictEqual(rig.log.hidden, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(rig.log.hidden, 1);
});

test("pipeline: record:cancelled and pipeline:cancel end a recording without processing it", () => {
  const rig = dictationRig({ transcribe: async () => "unused" });

  rig.pipeline.toggle();
  rig.handlers["record:cancelled"]({}, { sid: rig.log.lastStart.sid - 1 });
  assert.strictEqual(rig.pipeline.getState(), "recording", "a stale session's cancel is ignored");
  rig.handlers["record:cancelled"]({}, { sid: rig.log.lastStart.sid });
  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.strictEqual(rig.log.hidden, 1);

  rig.pipeline.toggle();
  const { sid } = rig.log.lastStart;
  rig.handlers["pipeline:cancel"]({});
  assert.strictEqual(rig.pipeline.getState(), "idle");
  assert.ok(rig.log.overlaySent.includes("record:cancel"), "the overlay is told to drop the take");
  assert.strictEqual(rig.log.hidden, 2);

  // The overlay's late capture from the cancelled take is stale.
  rig.handlers["audio:captured"]({}, { sid, wav: speechWav(1) });
  assert.strictEqual(rig.log.transcribe.length, 0);
  assert.deepStrictEqual(rig.log.delivered, []);
});

test("pipeline: live cleanup errors reach the file logger", () => {
  const rig = dictationRig();
  // This callback is independent of the best-effort STT preview diagnostics.
  const error = new Error("cleanup model failed to load");
  rig.liveCleanupError(error);
  assert.ok(rig.log.logs.some(([level, label, err]) =>
    level === "warn" && /live preview cleanup failed/.test(label) && err === error));
});

test("pipeline: cleanup warm-up failures are logged without blocking recording", async () => {
  const err = new Error("model load failed");
  const rig = dictationRig({ cleanup: true, primeCleanup: async () => { throw err; } });
  rig.pipeline.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(rig.pipeline.getState(), "recording");
  assert.ok(rig.log.logs.some(([level, label, metadata, error]) =>
    level === "warn" && label === "cleanup warm-up failed:" && error === err));
  rig.pipeline.cancel();
});

for (const error of [new Error("cleanup cancelled"), Object.assign(new Error("aborted"), { name: "AbortError" })]) {
  test(`pipeline: expected warm-up cancellation stays quiet (${error.name})`, async () => {
    const rig = dictationRig({ cleanup: true, primeCleanup: async () => { throw error; } });
    rig.pipeline.toggle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!rig.log.logs.some(([, label]) => label === "cleanup warm-up failed:"));
    rig.pipeline.cancel();
  });
}

test("pipeline: missing optional cleanup bypasses phases and calls, retaining raw history with one notice per launch", async () => {
  let calls = 0;
  const rig = dictationRig({ cleanup: true, transcribe: async () => "raw words",
    cleanupReadiness: () => ({ ok: false, reason: "missing", modelId: "cleanup-model", label: "Cleanup" }),
    clean: async () => { calls++; throw new Error("must bypass"); } });
  await rig.dictate(speechWav(1)); await rig.dictate(speechWav(1));
  assert.equal(calls, 0);
  assert.ok(!rig.log.warmups.includes("cleanup"));
  assert.ok(!rig.log.statuses.includes("cleaning"));
  assert.deepStrictEqual(rig.log.delivered, ["raw words", "raw words"]);
  assert.equal(rig.log.history[0].cleaned, false);
  assert.equal(rig.log.notifications.length, 1);
  assert.match(rig.log.notifications[0].body, /Settings → Cleanup/);
  rig.log.notifications[0].click();
  assert.equal(rig.log.settingsOpened, 1);
});
test("pipeline: active optional download marks raw done and suppresses failure notices", async () => {
  const rig = dictationRig({ cleanup: true, transcribe: async () => "raw",
    cleanupReadiness: () => ({ ok: false, reason: "missing", modelId: "cleanup-model" }),
    isDownloading: () => true });
  await rig.dictate(speechWav(1));
  assert.equal(rig.log.done.rawReason, "cleanup-downloading");
  assert.equal(rig.log.notifications.length, 0);
  assert.ok(!rig.log.warmups.includes("cleanup"));
});
test("pipeline: cleanup completion before save reconciles once and primes only when idle", async () => {
  const rig = dictationRig({ cleanup: false, transcribe: async () => "raw" });
  rig.cfg.cleanup.builtin = { model: "fresh" };
  rig.pipeline.onCleanupDownloaded("fresh");
  assert.equal(rig.log.notifications.length, 0);
  rig.pipeline.toggle();
  rig.cfg.cleanup.enabled = true;
  rig.pipeline.onSettingsChanged();
  assert.equal(rig.log.notifications.length, 1);
  assert.ok(!rig.log.warmups.includes("cleanup"));
  rig.pipeline.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(rig.log.warmups.filter((k) => k === "cleanup"), ["cleanup"]);
  rig.pipeline.onSettingsChanged();
  assert.equal(rig.log.notifications.length, 1);
});
test("pipeline: completion during transcription rechecks disk before final cleanup", async () => {
  let ready = false;
  const rig = dictationRig({ cleanup: true,
    cleanupReadiness: () => ready ? { ok: true } : { ok: false, reason: "missing", modelId: "fresh" },
    isDownloading: () => true,
    transcribe: async () => { ready = true; return "raw"; } });
  await rig.dictate(speechWav(1));
  assert.deepStrictEqual(rig.log.delivered, ["cleaned(raw)"]);
  assert.equal(rig.log.done.rawReason, null);
});

/* ---------------- retry a failed transcription (#293) ---------------- */

// A remote STT that fails while `down` is set, as a service that times out
// and then comes back.
function flakyStt() {
  const stt = { down: true, seen: [], reply: "the whole explanation" };
  stt.transcribe = async (n, wav) => {
    stt.seen.push(wav);
    if (stt.down) throw new Error("STT request timed out");
    return stt.reply;
  };
  return stt;
}

// Run the held take through the pipeline again and wait for it to settle.
async function retried(rig) {
  const idle = new Promise((resolve) => rig.pipeline.onStateChange((s) => s === "idle" && resolve()));
  const started = rig.pipeline.retryFailedTake();
  if (started) await idle;
  return started;
}

test("pipeline: a failed transcription keeps the take, and a retry delivers it once", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  const take = speechWav(30);
  await rig.dictate(take);
  assert.deepStrictEqual(rig.log.delivered, []);
  const held = rig.pipeline.getFailedTake();
  assert.ok(held, "the recording is held");
  assert.strictEqual(held.bytes, take.length);
  assert.ok(rig.log.statuses.includes("error"));

  stt.down = false; // the service is back
  assert.strictEqual(await retried(rig), true);
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
  assert.strictEqual(rig.log.history.length, 1, "one history entry");
  assert.ok(Buffer.from(stt.seen.at(-1)).equals(Buffer.from(take)), "the same audio, not a re-recording");
  assert.strictEqual(rig.pipeline.getFailedTake(), null, "released once delivered");
  assert.strictEqual(await retried(rig), false, "nothing left to deliver twice");
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
});

test("pipeline: a retry that fails again keeps the take for the next one", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  await retried(rig);
  assert.ok(rig.pipeline.getFailedTake(), "still held after a second failure");
  assert.deepStrictEqual(rig.log.delivered, []);
  stt.down = false;
  await retried(rig);
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
  assert.strictEqual(rig.log.history.length, 1);
});

test("pipeline: a retry uses the engine chosen since the failure", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  rig.cfg.stt.engine = "builtin"; // switched in Settings
  stt.down = false;
  await retried(rig);
  assert.strictEqual(rig.log.transcribe.at(-1).engine, "builtin");
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
});

test("pipeline: the failure card offers the held take, and the notice says how to retry", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  assert.deepStrictEqual(rig.log.failedTakeCards, [{ expiresInSec: 600 }]);
  const [note] = rig.log.notifications;
  assert.match(note.title, /recording kept/);
  assert.match(note.body, /earheart --retry/);
  // A failure with nothing held (a paste failure) offers no retry.
  const pasteFails = dictationRig({
    engine: "remote",
    transcribe: async () => "words",
    deliver: async () => { throw new Error("paste tool missing"); },
  });
  await pasteFails.dictate(speechWav(5));
  assert.deepStrictEqual(pasteFails.log.failedTakeCards, []);
});

test("pipeline: cancelling a retry mid-transcription releases the take", async () => {
  let release;
  const stt = flakyStt();
  const rig = dictationRig({
    engine: "remote",
    transcribe: async (n, wav) => {
      if (n === 0) return stt.transcribe(n, wav);
      await new Promise((resolve) => { release = resolve; });
      return "late words";
    },
  });
  await rig.dictate(speechWav(5));
  assert.ok(rig.pipeline.getFailedTake());
  rig.pipeline.retryFailedTake();
  await flush();
  rig.pipeline.cancel();
  release();
  await flush();
  assert.strictEqual(rig.pipeline.getFailedTake(), null, "an intentional cancel isn't kept");
  assert.deepStrictEqual(rig.log.delivered, [], "the stale reply can't deliver");
  assert.deepStrictEqual(rig.log.history, []);
});

test("pipeline: only a new dictation that transcribes lets the failed take go", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  const take = speechWav(30);
  await rig.dictate(take);
  rig.pipeline.toggle(); // a mic check, or a mis-press...
  assert.strictEqual(rig.pipeline.retryFailedTake(), false, "no retry while recording");
  rig.pipeline.cancel(); // ...thrown away
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length, "kept: nothing new was said");

  // The service is still down and the user tries a quick test: it fails too,
  // and the longer recording stays.
  await rig.dictate(speechWav(1));
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length, "a short failure didn't replace it");
  assert.deepStrictEqual(rig.log.failedTakeCards.at(-1), { expiresInSec: 600, earlier: true });
  assert.match(rig.log.notifications.at(-1).title, /earlier recording still kept/);

  // A take that hears nothing doesn't count as speaking again.
  stt.down = false;
  stt.reply = "";
  await rig.dictate(speechWav(1));
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length, "an empty take didn't replace it");

  // Words, at last: the held take is superseded.
  stt.reply = "said again";
  await rig.dictate(speechWav(3));
  assert.strictEqual(rig.pipeline.getFailedTake(), null);
  assert.deepStrictEqual(rig.log.delivered, ["said again"]);
});

test("pipeline: a longer new failure replaces the held take", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(2));
  const longer = speechWav(20);
  await rig.dictate(longer);
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, longer.length);
  assert.deepStrictEqual(rig.log.failedTakeCards.at(-1), { expiresInSec: 600 });
});

test("pipeline: a retry waiting on a reloading overlay keeps the take until it runs", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  let finishLoad;
  rig.overlayLoading((fn) => { finishLoad = fn; });
  assert.strictEqual(rig.pipeline.retryFailedTake(), true);
  assert.ok(rig.pipeline.getFailedTake(), "still held while the overlay loads");
  assert.strictEqual(rig.pipeline.retryFailedTake(), false, "one retry at a time");
  // Superseded: the user starts dictating before the overlay is back.
  rig.overlayLoading(null);
  rig.pipeline.toggle();
  finishLoad();
  assert.ok(rig.pipeline.getFailedTake(), "a superseded retry didn't eat the recording");
  rig.pipeline.cancel();
  stt.down = false;
  assert.strictEqual(await retried(rig), true);
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
});

test("pipeline: a retry runs once its overlay finishes loading, and a failed load doesn't block the next", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  // A load that fails never finishes...
  let failLoad;
  const failing = () => {};
  failing.fail = (fn) => { failLoad = fn; };
  rig.overlayLoading(failing);
  assert.strictEqual(rig.pipeline.retryFailedTake(), true);
  failLoad();
  // ...and the next retry still goes, this time once the overlay loads.
  let finishLoad;
  rig.overlayLoading((fn) => { finishLoad = fn; });
  stt.down = false;
  assert.strictEqual(rig.pipeline.retryFailedTake(), true, "not blocked by the failed load");
  assert.ok(rig.pipeline.getFailedTake());
  const idle = new Promise((resolve) => rig.pipeline.onStateChange((s) => s === "idle" && resolve()));
  rig.overlayLoading(null);
  finishLoad();
  await idle;
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
  assert.ok(rig.log.overlaySent.includes("pipeline:take-released"), "the overlay hears the take went");
});

test("pipeline: discard releases the held take, from the overlay or earheart --discard", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  const hiddenBefore = rig.log.hidden;
  rig.handlers["pipeline:discard-take"]();
  assert.strictEqual(rig.pipeline.getFailedTake(), null);
  assert.strictEqual(rig.log.hidden, hiddenBefore + 1, "the failure card goes with it");

  await rig.dictate(speechWav(5));
  rig.pipeline.discard(); // idle: `earheart --discard`
  assert.strictEqual(rig.pipeline.getFailedTake(), null);
});

test("pipeline: the overlay's Retry runs the held take", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
  await rig.dictate(speechWav(5));
  stt.down = false;
  const idle = new Promise((resolve) => rig.pipeline.onStateChange((s) => s === "idle" && resolve()));
  rig.handlers["pipeline:retry"]();
  await idle;
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
});

test("pipeline: only a transcription failure holds the take; cleanup and paste failures already keep the words", async () => {
  const cleanupFails = dictationRig({
    engine: "remote",
    cleanup: true,
    transcribe: async () => "raw words",
    clean: async () => { throw new Error("cleanup model crashed"); },
  });
  await cleanupFails.dictate(speechWav(5));
  assert.deepStrictEqual(cleanupFails.log.delivered, ["raw words"], "raw-text fallback still delivers");
  assert.strictEqual(cleanupFails.pipeline.getFailedTake(), null);

  const pasteFails = dictationRig({
    engine: "remote",
    transcribe: async () => "words",
    deliver: async () => { throw new Error("paste tool missing"); },
  });
  await pasteFails.dictate(speechWav(5));
  assert.strictEqual(pasteFails.log.history.length, 1, "History has the words");
  assert.strictEqual(pasteFails.pipeline.getFailedTake(), null);
});

test("pipeline: partial-transcript salvage still delivers, and holds nothing", async () => {
  const rig = dictationRig({ transcribe: async () => { throw exited(); } });
  await rig.dictate(speechWav(40), { committedRaw: "words said so far", decodedSamples: 30 * SR, broken: false });
  assert.deepStrictEqual(rig.log.delivered, ["words said so far"]);
  assert.strictEqual(rig.pipeline.getFailedTake(), null);
});

test("pipeline: a retry of a built-in take decodes the whole recording, not a stale live preview", async () => {
  const stt = flakyStt();
  const rig = dictationRig({ transcribe: stt.transcribe });
  await rig.dictate(speechWav(5), { committedRaw: "", decodedSamples: 0, broken: false });
  assert.ok(rig.pipeline.getFailedTake());
  // Whatever the live preview holds now belongs to no take; used as the
  // retry's prefix it would splice someone else's words in.
  rig.setSnapshot({ committedRaw: "stale words", decodedSamples: 2 * SR, broken: false });
  stt.down = false;
  await retried(rig);
  assert.deepStrictEqual(rig.log.delivered, ["the whole explanation"]);
  assert.strictEqual(Math.round(rig.log.transcribe.at(-1).sec), 5, "the whole take was decoded");
});

test("pipeline: a new take cancelled before delivery, or cut short, keeps the held recording", async () => {
  const stt = flakyStt();
  const held = heldCleanup();
  held.rejectOnAbort = true;
  const rig = dictationRig({ engine: "remote", cleanup: true, transcribe: stt.transcribe, clean: held.clean });
  const take = speechWav(30);
  await rig.dictate(take);
  stt.down = false;
  stt.reply = "said again";
  // Cancelled while the new take is cleaning: its words never land, and the
  // held recording must not go with them.
  const idle = new Promise((resolve) => rig.pipeline.onStateChange((s) => s === "idle" && resolve()));
  rig.pipeline.toggle();
  rig.handlers["audio:captured"]({}, { sid: rig.log.lastStart.sid, wav: speechWav(3) });
  await held.started;
  rig.pipeline.cancel();
  await idle;
  await flush();
  assert.deepStrictEqual(rig.log.delivered, []);
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length);
});

test("pipeline: a partial salvage doesn't supersede the held recording", async () => {
  const rig = dictationRig({ transcribe: async () => { throw exited(); } });
  const take = speechWav(30);
  await rig.dictate(take); // nothing recovered: held
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length);
  await rig.dictate(speechWav(40), { committedRaw: "words said so far", decodedSamples: 30 * SR, broken: false });
  assert.deepStrictEqual(rig.log.delivered, ["words said so far"]);
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, take.length, "the engine that cut it short failed the held one too");
});

/* ---------------- a paste held back because the clipboard changed (#291) ---------------- */

test("pipeline: a delivery the clipboard change held back says so and stays copyable", async () => {
  let result = { method: "clipboard-changed", note: "Copy it from the tray menu", hint: "Another app changed the clipboard before Earheart could paste, so nothing was pasted." };
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "the agent prompt",
    deliver: async (text) => {
      rig.log.delivered.push(text);
      return result;
    },
  });
  await rig.dictate(speechWav(2));
  const [note] = rig.log.notifications;
  assert.strictEqual(note.title, "Earheart: not pasted, the clipboard changed");
  assert.match(note.body, /nothing was pasted/);
  assert.strictEqual(rig.log.done.method, "clipboard-changed");
  assert.strictEqual(rig.pipeline.getUndelivered().text, "the agent prompt");
  // A cancelled delivery landed nothing, so the held-back one stays.
  result = { method: "cancelled" };
  await rig.dictate(speechWav(2));
  assert.strictEqual(rig.pipeline.getUndelivered().text, "the agent prompt");
  // Clearing History clears it too.
  rig.pipeline.clearUndelivered();
  assert.strictEqual(rig.pipeline.getUndelivered(), null);
  // And the next delivery that lands supersedes a held-back one.
  result = { method: "clipboard-changed", note: "Copy it from the tray menu", hint: "nothing was pasted" };
  await rig.dictate(speechWav(2));
  result = { method: "paste" };
  await rig.dictate(speechWav(2));
  assert.strictEqual(rig.pipeline.getUndelivered(), null);
});

/* ---------------- deliver as one line (#68) ---------------- */

test("pipeline: 'deliver as one line' joins the delivered text and keeps History's as spoken", async () => {
  const rig = dictationRig({ engine: "remote", transcribe: async () => "First part.\n\nSecond part." });
  rig.cfg.output.singleLine = true;
  await rig.dictate(speechWav(2));
  assert.deepStrictEqual(rig.log.delivered, ["First part. Second part."]);
  assert.strictEqual(rig.log.history[0].text, "First part.\n\nSecond part.");
  assert.strictEqual(rig.log.done.preview, "First part. Second part.");
});

test("pipeline: without the setting a multi-line transcript is delivered as it is", async () => {
  const rig = dictationRig({ engine: "remote", transcribe: async () => "First part.\n\nSecond part." });
  await rig.dictate(speechWav(2));
  assert.deepStrictEqual(rig.log.delivered, ["First part.\n\nSecond part."]);
});

// Cancelling a replacement take must not discard the earlier failed audio.
test("pipeline: cancelling delivery keeps the earlier failed take retryable", async () => {
  const stt = flakyStt();
  let finishDelivery;
  let deliveryStarted;
  const started = new Promise((resolve) => { deliveryStarted = resolve; });
  let holdDelivery = true;
  const rig = dictationRig({
    engine: "remote",
    transcribe: stt.transcribe,
    deliver: async () => {
      if (!holdDelivery) return { method: "paste" };
      deliveryStarted();
      return new Promise((resolve) => { finishDelivery = resolve; });
    },
  });
  const original = speechWav(30);
  await rig.dictate(original);
  stt.down = false;
  rig.pipeline.toggle();
  rig.handlers["audio:captured"]({}, { sid: rig.log.lastStart.sid, wav: speechWav(3) });
  await started;
  rig.pipeline.cancel();
  finishDelivery({ method: "cancelled" });
  await flush();
  assert.strictEqual(rig.pipeline.getFailedTake().bytes, original.length);
  holdDelivery = false;
  assert.strictEqual(await retried(rig), true);
  assert.ok(Buffer.from(stt.seen.at(-1)).equals(Buffer.from(original)), "retry receives the original WAV");
  assert.strictEqual(rig.pipeline.getFailedTake(), null);
});

for (const [seconds, duration] of [[5, "less than a minute"], [59, "less than a minute"], [60, "1 minute"], [120, "2 minutes"]]) {
  test(`pipeline: an earlier take with ${seconds}s left has an honest retry notice`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const stt = flakyStt();
    const rig = dictationRig({ engine: "remote", transcribe: stt.transcribe });
    await rig.dictate(speechWav(30));
    const expiresAt = rig.pipeline.getFailedTake().expiresAt;
    now = expiresAt - seconds * 1000;
    await rig.dictate(speechWav(1));
    assert.deepStrictEqual(rig.log.failedTakeCards.at(-1), { expiresInSec: seconds, earlier: true });
    assert.strictEqual(rig.log.notifications.at(-1).body,
      `Retry it from the tray menu or the overlay, or run earheart --retry, within ${duration}. STT request timed out`);
    assert.strictEqual(rig.pipeline.getFailedTake().expiresAt, expiresAt, "the copy must not renew retention");
    rig.pipeline.discardFailedTake();
  });
}

test("pipeline: clipboard takeover keeps the transcript with History disabled", async () => {
  const rig = dictationRig({
    engine: "remote",
    transcribe: async () => "first part\nsecond part",
    deliver: async () => ({ method: "clipboard-changed", hint: "Nothing was pasted." }),
  });
  rig.cfg.history.enabled = false;
  rig.cfg.output.singleLine = true;
  await rig.dictate(speechWav(2));
  assert.deepStrictEqual(rig.log.history, []);
  assert.strictEqual(rig.pipeline.getUndelivered().text, "first part\nsecond part");
  assert.strictEqual(rig.log.done.method, "clipboard-changed");
});
