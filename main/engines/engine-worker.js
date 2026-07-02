// Runs in an Electron utilityProcess: hosts the in-process STT (sherpa-onnx /
// Parakeet) and cleanup (node-llama-cpp / Gemma) engines, off the main process
// so a long inference or a native crash never freezes the UI.
//
// The native modules are required lazily and defensively: if they aren't
// installed (or a model isn't downloaded yet) the worker answers with a clear
// error and the caller falls back to the HTTP path — the app keeps working.
//
// Protocol: the parent posts { id, type, ...args }; we reply with
// { id, ok: true, result } or { id, ok: false, error }. Long-running handlers
// may post interim { id, progress } messages before the reply; the host routes
// them to the caller's onProgress without settling the request.
//
// Engine state (the recognizer, the llama context/session) is single-instance,
// so requests are assumed to arrive one at a time. The dictation pipeline is a
// state machine that runs a single transcribe/clean at once; Settings "test"
// actions are the only other callers and are not expected to overlap a live
// dictation.

const path = require("node:path");
const { wavToFloat32, SAMPLE_RATE } = require("../util/wav");

const port = process.parentPort;

// Parakeet's mel-feature dimension, fixed by the model.
const FEATURE_DIM = 80;
// Cleanup engine defaults (overridable per request).
const DEFAULT_CONTEXT_SIZE = 2048;
const DEFAULT_CLEANUP_TEMPERATURE = 0.2;

let recognizer = null; // sherpa-onnx OfflineRecognizer
let sttModelId = null;

let llama = null; // node-llama-cpp instance
let llamaModel = null;
let llamaContext = null;
let llamaSession = null;
let cleanupModelPath = null;

function reply(id, promise) {
  Promise.resolve(promise)
    .then((result) => port.postMessage({ id, ok: true, result }))
    .catch((err) => port.postMessage({ id, ok: false, error: String(err && err.message || err) }));
}

// Interim { id, progress } sender for a request, throttled at the source so a
// per-token callback can't flood the IPC channel. Timestamp-based (no timers),
// so nothing outlives the request — a dropped trailing update is fine because
// the reply itself is the final word.
const PROGRESS_INTERVAL_MS = 100;
// Streamed cleanup progress never claims completion — only the reply does.
const CLEAN_PROGRESS_CAP = 0.99;

function makeProgressEmitter(id) {
  let lastSentAt = 0;
  return (progress) => {
    const now = Date.now();
    if (now - lastSentAt < PROGRESS_INTERVAL_MS) return;
    lastSentAt = now;
    port.postMessage({ id, progress });
  };
}

/* ---------------- speech-to-text (sherpa-onnx / Parakeet) ---------------- */

async function loadStt({ dir, sherpa, modelId }) {
  if (recognizer && sttModelId === modelId) return { ready: true };
  let sherpaOnnx;
  try {
    sherpaOnnx = require("sherpa-onnx-node");
  } catch (err) {
    throw new Error(`sherpa-onnx-node not available: ${err.message}`);
  }
  // Drop the previous recognizer before swapping models (the cleanup engine
  // does the same via disposeCleanup).
  await disposeStt();
  recognizer = new sherpaOnnx.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, sherpa.encoder),
        decoder: path.join(dir, sherpa.decoder),
        joiner: path.join(dir, sherpa.joiner),
      },
      tokens: path.join(dir, sherpa.tokens),
      numThreads: Math.max(1, Math.min(4, require("node:os").cpus().length - 1)),
      provider: "cpu",
      modelType: sherpa.modelType || "nemo_transducer",
      debug: false,
    },
  });
  sttModelId = modelId;
  return { ready: true };
}

async function transcribe({ wav, language }) {
  if (!recognizer) throw new Error("STT model not loaded");
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  const { samples, sampleRate } = wavToFloat32(buf);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  return (result && result.text ? result.text : "").trim();
  // `language` is accepted for parity with the HTTP API; Parakeet v3
  // auto-detects, so it is not forwarded.
}

/* ---------------- cleanup (node-llama-cpp / Gemma) ---------------- */

async function loadCleanup({ modelPath, contextSize }) {
  if (llamaModel && cleanupModelPath === modelPath) return { ready: true };
  // node-llama-cpp v3 is ESM-only; reach it via dynamic import from CommonJS.
  let mod;
  try {
    mod = await import("node-llama-cpp");
  } catch (err) {
    throw new Error(`node-llama-cpp not available: ${err.message}`);
  }
  await disposeCleanup();
  llama = llama || (await mod.getLlama());
  llamaModel = await llama.loadModel({ modelPath });
  llamaContext = await llamaModel.createContext({
    contextSize: contextSize || DEFAULT_CONTEXT_SIZE,
  });
  llamaSession = null;
  cleanupModelPath = modelPath;
  return { ready: true };
}

// Map a resolved cleanup sampling profile onto node-llama-cpp prompt options.
// topK 0 and minP 0 mean "disabled", so they're only forwarded when active;
// temperature always has a value (falls back to the engine default).
function samplingOptions(sampling) {
  const s = sampling || {};
  const opts = { temperature: s.temperature ?? DEFAULT_CLEANUP_TEMPERATURE };
  if (s.topP != null) opts.topP = s.topP;
  if (s.topK != null && s.topK > 0) opts.topK = s.topK;
  if (s.minP != null && s.minP > 0) opts.minP = s.minP;
  return opts;
}

async function clean({ transcript, systemPrompt, sampling }, emitProgress) {
  if (!llamaContext) throw new Error("Cleanup model not loaded");
  const mod = await import("node-llama-cpp");
  // No systemPrompt: tested against Gemma 1B, putting the cleanup rules in the
  // chat system prompt makes the small model behave like an assistant and
  // answer/expand the dictation instead of cleaning it. Inlining the rules and
  // the transcript into a single user turn keeps it in "transform this text"
  // mode and returns just the cleaned text. (See scripts/try-cleanup-prompts.)
  if (!llamaSession) {
    llamaSession = new mod.LlamaChatSession({
      contextSequence: llamaContext.getSequence(),
    });
  } else {
    llamaSession.resetChatHistory();
  }
  // The transcript is labelled as data and followed by a cue, so the model
  // continues with the cleaned text rather than a reply to its content.
  const userTurn =
    `${systemPrompt}\n\nTranscript:\n${transcript}\n\nCleaned transcript:`;
  // Cleaned output tracks the input's length closely (punctuation in, fillers
  // out), so generated-chars / transcript-chars is an honest progress ratio.
  const total = Math.max(1, transcript.length);
  let generated = 0;
  const out = await llamaSession.prompt(userTurn, {
    ...samplingOptions(sampling),
    onTextChunk: (text) => {
      generated += text.length;
      if (emitProgress) emitProgress(Math.min(CLEAN_PROGRESS_CAP, generated / total));
    },
  });
  return (out || "").trim();
}

async function disposeCleanup() {
  try {
    if (llamaSession && llamaSession.dispose) llamaSession.dispose();
    if (llamaContext && llamaContext.dispose) await llamaContext.dispose();
    if (llamaModel && llamaModel.dispose) await llamaModel.dispose();
  } catch {
    // Best effort; we're tearing down anyway.
  }
  llamaSession = null;
  llamaContext = null;
  llamaModel = null;
  cleanupModelPath = null;
}

async function disposeStt() {
  // sherpa-onnx-node's OfflineRecognizer exposes no explicit free(); its native
  // memory is released by a finalizer once the handle is unreachable. So we just
  // drop the reference and let GC reclaim it — reclamation is not immediate.
  recognizer = null;
  sttModelId = null;
}

/* ---------------- dispatch ---------------- */

// Module-load smoke check: require/import both native addons without touching
// any model files, so CI can prove the prebuilt .node binaries link against the
// current Electron's ABI (a major Electron bump moves the N-API/V8 surface).
// Returns which engines loaded rather than throwing, so the smoke caller can
// assert on both regardless of which one breaks.
async function loadcheck() {
  const engines = {};
  try {
    require("sherpa-onnx-node");
    engines.stt = true;
  } catch (err) {
    engines.stt = false;
    engines.sttError = String((err && err.message) || err);
  }
  try {
    await import("node-llama-cpp");
    engines.cleanup = true;
  } catch (err) {
    engines.cleanup = false;
    engines.cleanupError = String((err && err.message) || err);
  }
  return engines;
}

const HANDLERS = {
  ping: async () => ({ pong: true }),
  loadcheck,
  "load-stt": loadStt,
  transcribe,
  "unload-stt": disposeStt,
  "load-cleanup": loadCleanup,
  clean,
  "unload-cleanup": disposeCleanup,
};

port.on("message", (event) => {
  const { id, type, ...args } = event.data || {};
  const handler = HANDLERS[type];
  if (!handler) {
    port.postMessage({ id, ok: false, error: `Unknown request: ${type}` });
    return;
  }
  reply(id, handler(args, makeProgressEmitter(id)));
});
