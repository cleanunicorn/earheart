// High-level facade over the in-process engines: where models live on disk,
// downloading them, and running transcription / cleanup through the worker.
// The pipeline and IPC layers use only this module.

const path = require("node:path");
const { app } = require("electron");

const registry = require("./registry");
const manager = require("./model-manager");
const host = require("./host");

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
    await host.request("load-stt", {
      dir: manager.modelDir(modelsDir(), model),
      sherpa: model.sherpa,
      modelId,
    });
    loadedStt = modelId;
  }
}

async function transcribe(wav, cfg) {
  await ensureStt(cfg.builtin.model);
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  // Copy out an exact-length ArrayBuffer for the worker. Electron's
  // utilityProcess.postMessage only accepts MessagePortMain objects in its
  // transfer list (not ArrayBuffers, unlike worker_threads) — passing the
  // buffer there throws "port at index 0 is not a valid port" — so the audio
  // is structured-cloned across. A few seconds of PCM16 is small enough that
  // the one extra copy is negligible.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const text = await host.request("transcribe", {
    wav: ab,
    language: cfg.language || "",
  });
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
    await host.request("load-cleanup", {
      modelPath: path.join(manager.modelDir(modelsDir(), model), model.gguf.file),
    });
    loadedCleanup = modelId;
  }
}

async function clean(transcript, cfg) {
  await ensureCleanup(cfg.builtin.model);
  const cleaned = await host.request("clean", {
    transcript,
    systemPrompt: cfg.systemPrompt,
    temperature: cfg.temperature,
  });
  // Never let an empty (or whitespace-only) cleanup eat the user's words.
  return cleaned && cleaned.trim().length > 0 ? cleaned : transcript;
}

// Forget which models the worker had resident, so the next call re-runs
// ensureStt/ensureCleanup instead of assuming a model is still loaded.
function forgetLoaded() {
  loadedStt = null;
  loadedCleanup = null;
}

function stop() {
  forgetLoaded();
  host.stop();
}

// Release the loaded models without killing the worker, leaving it ready for a
// fast re-load; the next transcribe/clean call re-runs ensureStt/ensureCleanup.
// The cleanup engine frees its memory promptly via dispose(); the STT engine
// has no explicit free, so its memory is reclaimed by GC rather than at once.
// No-op if the worker has already exited (nothing is loaded).
async function unloadIdle() {
  if (loadedStt === null && loadedCleanup === null) return;
  forgetLoaded();
  try {
    await Promise.all([
      host.request("unload-stt"),
      host.request("unload-cleanup"),
    ]);
  } catch {
    // Worker may have exited; the flags are already cleared either way.
  }
}

// If the worker dies (native crash, or our own stop()), it comes back empty.
// Forget what we thought it had loaded so the next call re-loads the model
// instead of sending inference to a worker that has no model resident.
host.onExit(forgetLoaded);

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
