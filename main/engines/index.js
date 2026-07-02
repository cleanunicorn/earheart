// High-level facade over the in-process engines: where models live on disk,
// downloading them, and running transcription / cleanup through their workers.
// The pipeline and IPC layers use only this module.

const path = require("node:path");
const { app } = require("electron");

const registry = require("./registry");
const manager = require("./model-manager");
const hostModule = require("./host");
const { resolveCleanup } = require("../cleanup-styles");

// STT and cleanup each get their own worker process so they run in parallel and
// a crash in one engine can't take down the other (see host.js). Each lazily
// forks on the first request, so a transcribe-only user never spawns the cleanup
// worker, and vice versa.
const sttHost = hostModule.createHost({ serviceName: "earheart-stt" });
const cleanupHost = hostModule.createHost({ serviceName: "earheart-cleanup" });

function modelsDir() {
  return path.join(app.getPath("userData"), "models");
}

function resolve(kind, modelId) {
  const model = registry.getModel(kind, modelId);
  if (!model) throw new Error(`Unknown ${kind} model: ${modelId}`);
  return model;
}

/* ---------------- model files ---------------- */

function isInstalled(kind, modelId) {
  return manager.isInstalled(modelsDir(), resolve(kind, modelId));
}

function download(kind, modelId, { onProgress, signal } = {}) {
  return manager.download(modelsDir(), resolve(kind, modelId), { onProgress, signal });
}

function remove(kind, modelId) {
  return manager.remove(modelsDir(), resolve(kind, modelId));
}

/* ---------------- speech-to-text ---------------- */

let loadedStt = null;

// Load the STT model into the worker if it isn't already. Throws if the model
// isn't downloaded yet — callers surface that (or fall back to the HTTP path).
async function ensureStt(modelId) {
  const model = resolve("stt", modelId);
  if (!manager.isInstalled(modelsDir(), model)) {
    throw new Error(`STT model "${modelId}" is not downloaded yet`);
  }
  if (loadedStt !== modelId) {
    await sttHost.request("load-stt", {
      dir: manager.modelDir(modelsDir(), model),
      sherpa: model.sherpa,
      modelId,
    });
    loadedStt = modelId;
  }
}

// Accepts a `signal` for parity with the HTTP transcribe client, so the
// pipeline can route to either backend identically. The worker request itself
// isn't abortable mid-flight, but an already-cancelled call returns early
// rather than spending a model load / inference.
// `onDecodeMs` receives the worker's own decode timing (excludes model load
// and any queueing in front of the request) — the clean sample the RTF
// estimator needs.
async function transcribe(wav, cfg, signal, { onDecodeMs } = {}) {
  if (signal?.aborted) throw new Error("aborted");
  await ensureStt(cfg.builtin.model);
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  // Copy out an exact-length ArrayBuffer for the worker. Electron's
  // utilityProcess.postMessage only accepts MessagePortMain objects in its
  // transfer list (not ArrayBuffers, unlike worker_threads) — passing the
  // buffer there throws "port at index 0 is not a valid port" — so the audio
  // is structured-cloned across. A few seconds of PCM16 is small enough that
  // the one extra copy is negligible.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const reply = await sttHost.request("transcribe", {
    wav: ab,
    language: cfg.language || "",
  });
  // The worker replies { text, decodeMs }; tolerate a bare string so test
  // fakes (and any older worker) keep working.
  const text = reply && typeof reply === "object" ? reply.text : reply;
  if (onDecodeMs && reply && Number.isFinite(reply.decodeMs)) {
    onDecodeMs(reply.decodeMs);
  }
  return (text || "").trim();
}

/* ---------------- cleanup ---------------- */

let loadedCleanup = null;

// Load the cleanup model into the worker if it isn't already. Throws if the
// model isn't downloaded yet — callers surface that (or fall back to HTTP).
async function ensureCleanup(modelId) {
  const model = resolve("cleanup", modelId);
  if (!manager.isInstalled(modelsDir(), model)) {
    throw new Error(`Cleanup model "${modelId}" is not downloaded yet`);
  }
  if (loadedCleanup !== modelId) {
    await cleanupHost.request("load-cleanup", {
      modelPath: path.join(manager.modelDir(modelsDir(), model), model.gguf.file),
    });
    loadedCleanup = modelId;
  }
}

// Accepts a `signal` for parity with the HTTP cleanup client (see transcribe).
// `onProgress` (0..1) relays the worker's token-streaming progress, so the
// pipeline can drive a determinate bar while the model generates.
async function clean(transcript, cfg, signal, { onProgress } = {}) {
  if (signal?.aborted) throw new Error("aborted");
  await ensureCleanup(cfg.builtin.model);
  // The selected style supplies both the prompt (base + directive) and the
  // sampling profile (temperature/topP/topK/minP) the worker applies.
  const { systemPrompt, sampling } = resolveCleanup(cfg);
  const cleaned = await cleanupHost.request(
    "clean",
    {
      transcript,
      systemPrompt,
      sampling,
    },
    { onProgress }
  );
  // Never let an empty (or whitespace-only) cleanup eat the user's words.
  return cleaned && cleaned.trim().length > 0 ? cleaned : transcript;
}

// Forget which models a worker had resident, so the next call re-runs
// ensureStt/ensureCleanup instead of assuming a model is still loaded.
function forgetStt() {
  loadedStt = null;
}

function forgetCleanup() {
  loadedCleanup = null;
}

function stop() {
  forgetStt();
  forgetCleanup();
  sttHost.stop();
  cleanupHost.stop();
}

// Release the loaded models without killing the workers, leaving them ready for
// a fast re-load; the next transcribe/clean call re-runs ensureStt/ensureCleanup.
// The cleanup engine frees its memory promptly via dispose(); the STT engine
// has no explicit free, so its memory is reclaimed by GC rather than at once.
// Each worker is unloaded independently and only if it had a model resident.
async function unloadIdle() {
  const jobs = [];
  if (loadedStt !== null) {
    forgetStt();
    jobs.push(sttHost.request("unload-stt"));
  }
  if (loadedCleanup !== null) {
    forgetCleanup();
    jobs.push(cleanupHost.request("unload-cleanup"));
  }
  if (jobs.length === 0) return;
  try {
    await Promise.all(jobs);
  } catch {
    // A worker may have exited; the flags are already cleared either way.
  }
}

// If a worker dies (native crash, or our own stop()), it comes back empty.
// Forget what we thought it had loaded so the next call re-loads the model
// instead of sending inference to a worker that has no model resident. Each
// host's exit only affects its own engine's loaded-state.
sttHost.onExit(forgetStt);
cleanupHost.onExit(forgetCleanup);

module.exports = {
  modelsDir,
  isInstalled,
  download,
  remove,
  ensureStt,
  transcribe,
  ensureCleanup,
  clean,
  stop,
  unloadIdle,
  registry,
};
