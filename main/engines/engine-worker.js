// Runs in an Electron utilityProcess: hosts the in-process STT (sherpa-onnx /
// Parakeet) and cleanup (node-llama-cpp / Gemma) engines, off the main process
// so a long inference or a native crash never freezes the UI.
//
// The native modules are required lazily and defensively: if they aren't
// installed (or a model isn't downloaded yet) the worker answers with a clear
// error and the caller falls back to the HTTP path — the app keeps working.
//
// Protocol: the parent posts { id, type, ...args }; we reply with
// { id, ok: true, result } or { id, ok: false, error }.
//
// Engine state (the recognizer, the llama context/session) is single-instance,
// so requests are assumed to arrive one at a time. The dictation pipeline is a
// state machine that runs a single transcribe/clean at once; Settings "test"
// actions are the only other callers and are not expected to overlap a live
// dictation.

const path = require("node:path");
const { wavToFloat32 } = require("../util/wav");

const port = process.parentPort;

let recognizer = null; // sherpa-onnx OfflineRecognizer
let sttModelId = null;

let llama = null; // node-llama-cpp instance
let llamaModel = null;
let llamaContext = null;
let llamaSession = null;
let cleanupModelPath = null;
let cleanupSystemPrompt = null;

function reply(id, promise) {
  Promise.resolve(promise)
    .then((result) => port.postMessage({ id, ok: true, result }))
    .catch((err) => port.postMessage({ id, ok: false, error: String(err && err.message || err) }));
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
  // Free the previous recognizer before swapping models so we don't leak its
  // native memory (the cleanup engine does the same via disposeCleanup).
  if (recognizer && typeof recognizer.free === "function") {
    try {
      recognizer.free();
    } catch {
      // best effort
    }
  }
  recognizer = null;
  sttModelId = null;
  recognizer = new sherpaOnnx.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
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
    contextSize: contextSize || 2048,
  });
  llamaSession = null;
  cleanupModelPath = modelPath;
  cleanupSystemPrompt = null;
  return { ready: true };
}

async function clean({ transcript, systemPrompt, temperature }) {
  if (!llamaContext) throw new Error("Cleanup model not loaded");
  const mod = await import("node-llama-cpp");
  // The system prompt is fixed for a session; rebuild when the user edits it.
  if (!llamaSession || cleanupSystemPrompt !== systemPrompt) {
    if (llamaSession && llamaSession.dispose) llamaSession.dispose();
    llamaSession = new mod.LlamaChatSession({
      contextSequence: llamaContext.getSequence(),
      systemPrompt,
    });
    cleanupSystemPrompt = systemPrompt;
  } else {
    llamaSession.resetChatHistory();
  }
  const out = await llamaSession.prompt(transcript, {
    temperature: temperature ?? 0.2,
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
  cleanupSystemPrompt = null;
}

/* ---------------- dispatch ---------------- */

const HANDLERS = {
  ping: async () => ({ pong: true }),
  "load-stt": loadStt,
  transcribe,
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
  reply(id, handler(args));
});
