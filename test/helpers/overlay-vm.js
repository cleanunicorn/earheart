// Runs the real overlay page script (renderer/overlay.js and the classic
// scripts overlay.html loads before it) in a node VM against the real audio
// worklet (renderer/recorder-worklet.js), with fakes only at the platform
// edges: the DOM (inert), getUserMedia, AudioContext and the IPC bridge.
//
// The test owns the audio thread and the message queue between it and the
// page: pump() renders quanta of marker samples through the real processor,
// deliver() hands its queued posts to the overlay — so posts can be delayed,
// bunched or held back across a stop, deterministically.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "..", "..", "renderer");
const QUANTUM = 128;

// An inert DOM node: every property is another inert node, calls return one,
// and arithmetic sees 0. Assigned properties read back.
function inert() {
  const store = {};
  return new Proxy(function () {}, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      if (prop in store) return store[prop];
      return (store[prop] = inert());
    },
    set(target, prop, value) {
      store[prop] = value;
      return true;
    },
    apply: () => inert(),
    construct: () => inert(),
  });
}

// The page's root custom properties, from the real tokens.css (its first
// declaration of each, i.e. the default :root palette), for the fake
// getComputedStyle — the overlay reads its colours from the stylesheet.
function rootTokens() {
  const css = fs.readFileSync(path.join(RENDERER, "tokens.css"), "utf8");
  const tokens = {};
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    if (!(name in tokens)) tokens[name] = value.trim();
  }
  return tokens;
}

// A fake Web Audio node graph that records what the cue code schedules.
function fakeParam() {
  return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
}

// Options beyond the latencies (all optional):
//   getUserMedia(constraints, calls)  replaces the default (always the first
//                                     stream); `calls` are the constraints so far
//   enumerateDevices()                absent → the page sees no such function
//   invoke(channel, payload)          the IPC invoke bridge (mics:classes …)
function createOverlayVm({
  outputLatency = 0.04,
  baseLatency = 0.01,
  inputLatency = 0.02,
  trackLatency = inputLatency,
  now = () => performance.now(),
  loadWorklet = async () => {},
  getUserMedia = null,
  enumerateDevices = null,
  invoke = async () => {},
} = {}) {
  const sent = [];
  const handlers = {};
  const oscillators = []; // { ctx, startAt, stops: [], disconnected }
  const contexts = [];
  const queue = []; // { owner, data }: posts not yet delivered to the page
  let node = null;
  let deviceChange = null;

  // ---- the real worklet, in its own scope ----
  function processorFor(owner) {
    const scope = {
      sampleRate: owner.ctx.sampleRate,
      currentFrame: 0,
      Float32Array,
      Math,
      AudioWorkletProcessor: class {
        constructor() {
          this.port = { onmessage: null, postMessage: (data) => queue.push({ owner, data }) };
        }
      },
      registerProcessor: (name, cls) => (scope.Processor = cls),
    };
    vm.runInNewContext(fs.readFileSync(path.join(RENDERER, "recorder-worklet.js"), "utf8"), scope);
    owner.scope = scope;
    return new scope.Processor();
  }

  class FakeAudioContext {
    constructor(options = {}) {
      this.frame = 0;
      this.sampleRate = options.sampleRate || 48000;
      this.state = "suspended";
      this.outputLatency = outputLatency;
      this.baseLatency = baseLatency;
      this.destination = { node: "destination" };
      this.audioWorklet = { addModule: () => loadWorklet(this) };
      this.isRecording = this.sampleRate === 16000;
      contexts.push(this);
    }
    // The recording context's clock is the audio thread's frame count; the
    // page sees it as of the last rendered quantum, like Chromium.
    // Other contexts (the cue output) keep a clock the test sets.
    get currentTime() {
      return this.isRecording ? this.frame / this.sampleRate : this.time || 0;
    }
    async resume() {
      this.state = "running";
    }
    async suspend() {
      this.state = "suspended";
    }
    async close() {
      this.state = "closed";
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createOscillator() {
      const osc = {
        ctx: this,
        type: "",
        frequency: fakeParam(),
        stops: [],
        connect() {},
        disconnect() {
          osc.disconnected = true;
        },
        start(t) {
          osc.startAt = t;
        },
        stop(t) {
          osc.stops.push(t);
        },
      };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return { gain: fakeParam(), connect() {}, disconnect() {} };
    }
  }

  class FakeWorkletNode {
    constructor(ctx) {
      this.ctx = ctx;
      this.processor = processorFor(this);
      node = this;
      this.port = {
        onmessage: null,
        postMessage: (command) => this.processor.port.onmessage({ data: command }),
      };
    }
    disconnect() {}
  }

  // A fake mic: a track that can end (readyState + its "ended" listeners) and
  // records stop(). `onended()` ends it, as the old single-listener rig did.
  const makeStream = () => {
    const listeners = [];
    const track = {
      enabled: true,
      muted: false,
      readyState: "live",
      stopped: false,
      stop() {
        track.stopped = true;
        track.readyState = "ended"; // a stopped track reports ended, as in Chromium
      },
      addEventListener(type, fn) {
        if (type === "ended") listeners.push(fn);
      },
      onended() {
        track.readyState = "ended";
        for (const fn of listeners.slice()) fn();
      },
      getSettings: () => ({ latency: trackLatency }),
    };
    return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } };
  };
  const { track, stream } = makeStream();
  const mediaCalls = []; // the audio constraints of every getUserMedia call
  const streams = [{ track, stream }];

  const context = {
    console,
    performance: { now },
    Math,
    Date,
    Promise,
    Float32Array,
    Int16Array,
    ArrayBuffer,
    DataView,
    Number,
    Array,
    Boolean,
    JSON,
    Object,
    String,
    Error,
    Symbol,
    // The page's timers must not keep the test process alive when a test ends
    // with a take still recording (its timer interval, startup watchdog).
    setTimeout: (...args) => {
      const handle = setTimeout(...args);
      handle?.unref?.();
      return handle;
    },
    clearTimeout,
    setInterval: (...args) => {
      const handle = setInterval(...args);
      handle?.unref?.();
      return handle;
    },
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
    },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    document: { getElementById: () => inert(), createElement: () => inert(), body: inert(), documentElement: inert() },
    // Root custom properties read like the stylesheet's; anything else "".
    getComputedStyle: (element) => {
      const tokens = element === context.document.documentElement ? rootTokens() : {};
      return { getPropertyValue: (name) => tokens[name] ?? "" };
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async (constraints) => {
          mediaCalls.push(constraints?.audio);
          if (getUserMedia) {
            const made = await getUserMedia(constraints, mediaCalls, makeStream);
            if (!streams.some((s) => s.stream === made)) streams.push({ stream: made, track: made.getAudioTracks()[0] });
            return made;
          }
          // Default mic: the first call gets the initial stream; every later
          // call a fresh live track, as a real getUserMedia hands out.
          if (mediaCalls.length === 1) return stream;
          const fresh = makeStream();
          streams.push(fresh);
          return fresh.stream;
        },
        ...(enumerateDevices ? { enumerateDevices: async () => enumerateDevices() } : {}),
        addEventListener: (type, fn) => {
          if (type === "devicechange") deviceChange = fn;
        },
      },
    },
    earheart: {
      on: (channel, fn) => (handlers[channel] = fn),
      send: (channel, payload) => sent.push({ channel, payload }),
      invoke: (channel, payload) => invoke(channel, payload),
    },
  };
  context.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), devicePixelRatio: 1 };
  vm.createContext(context);
  // The window's i18n client (renderer/i18n-client.js) in English.
  {
    const core = require("../../renderer/i18n");
    const translator = core.createTranslator({ locale: "en", catalogs: require("../../renderer/locales") });
    context.i18n = { t: translator.t, locale: "en", onChange: () => () => {} };
  }
  for (const file of ["chunk-boundary.js", "microphone.js", "mic-policy.js", "record-cues.js", "speech-probe.js", "transcript.js", "overlay.js"]) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, file), "utf8"), context, { filename: file });
  }

  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  return {
    sent,
    oscillators,
    contexts,
    queue,
    get track() { return streams[streams.length - 1].track; },
    mediaCalls,
    streams,
    makeStream,
    fireDeviceChange: () => deviceChange?.(),
    // A sample value that survives encodeWav's 16-bit conversion as exactly
    // `marker(frame)`: every captured frame is identifiable in the WAV.
    marker: (f) => (f % 30000) + 1,
    get frame() {
      return node?.ctx.frame || 0;
    },
    send(channel, payload) {
      handlers[channel](payload);
    },
    eval: (code) => vm.runInContext(code, context),
    settle,
    // Render `quanta` quanta of marker samples through the real processor.
    pump(quanta) {
      for (let q = 0; q < quanta; q++) {
        if (node.ctx.state !== "running") return;
        const frame = node.ctx.frame;
        const input = new Float32Array(QUANTUM);
        for (let i = 0; i < QUANTUM; i++) input[i] = ((((frame + i) % 30000) + 1) + 0.5) / 0x7fff;
        node.scope.currentFrame = frame;
        node.processor.process([[input]]);
        node.ctx.frame += QUANTUM;
      }
    },
    // Hand the first `count` queued posts (all by default) to the page.
    deliver(count = queue.length) {
      for (const { owner, data } of queue.splice(0, count)) owner.port.onmessage?.({ data });
    },
    messages: (channel) => sent.filter((m) => m.channel === channel).map((m) => m.payload),
  };
}

// The 16-bit samples of an overlay WAV (44-byte header, as encodeWav writes).
function wavInts(wav) {
  const buf = Buffer.from(wav);
  return Array.from(new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length)));
}

module.exports = { createOverlayVm, wavInts };
