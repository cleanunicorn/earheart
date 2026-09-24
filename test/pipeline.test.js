// Tests for the pipeline: the idle-unload timer (when models get evicted, and
// what happens when a worker is busy at the moment the window elapses), and the
// final transcription driven end to end through the registered IPC handlers
// (bounded built-in decodes, and delivery when the STT worker dies mid-way).
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
function dictationRig({ engine = "builtin", display = true, cleanup = false, transcribe, ensureStt } = {}) {
  const log = {
    transcribe: [],
    delivered: [],
    history: [],
    notifications: [],
    statuses: [],
    settingsEvents: [],
    lastStart: null,
  };
  let snapshot = null;
  let lastStart = null;
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
      ensureStt: ensureStt || (async () => {}),
      restartStt() {},
      unloadIdle: () => true,
      cancelClean() {},
      primeCleanup: async () => {},
    },
    settings: { get: () => cfg },
    overrides: {
      electron: {
        app: { getPath: () => os.tmpdir() },
        ipcMain: { on: (channel, fn) => (handlers[channel] = fn) },
        Notification: class {
          constructor(opts) {
            this.opts = opts;
          }
          show() {
            log.notifications.push(this.opts);
          }
        },
      },
      "./windows": {
        createOverlay: () => ({ webContents: { isLoading: () => false } }),
        showOverlay() {},
        hideOverlay() {},
        sendToSettings: (channel) => log.settingsEvents.push(channel),
        sendToOverlay(channel, payload) {
          if (channel === "record:start") {
            lastStart = payload;
            log.lastStart = payload;
          }
          if (channel === "pipeline:status") {
            log.statuses.push(payload.status);
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
        clean: async (raw) => `cleaned(${raw})`,
      },
      "./output/deliver": {
        deliver: async (text) => {
          log.delivered.push(text);
          return { method: "paste" };
        },
      },
      "./history": { add: (entry) => log.history.push(entry) },
      "./live-preview": {
        createLivePreview: (deps) => {
          liveDeps = deps;
          return { cancel() {}, handleAudio() {}, snapshotFinal: () => snapshot };
        },
      },
      "./util/rtf": {
        createPersistedRtfEstimator: () => ({ record() {}, progressAt: () => 0.5, estimate: () => 0.1 }),
      },
    },
  });
  pipeline.init();
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
  };
}

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
  // worker dies on piece 2 and again on its retry. Pieces 1 and 3 are the
  // user's words and must be delivered.
  let dead = true;
  const rig = dictationRig({
    cleanup: true,
    transcribe: async (n) => {
      if (dead && (n === 1 || n === 2)) throw exited();
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
  assert.deepStrictEqual(rig.log.delivered, ["cleaned(w0 w3)", "cleaned(w4)"]);
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
