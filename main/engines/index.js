// High-level facade over the in-process engines: where models live on disk,
// downloading them, and running transcription / cleanup through their workers.
// The pipeline and IPC layers use only this module.

const path = require("node:path");
const { app } = require("electron");

const registry = require("./registry");
const manager = require("./model-manager");
const hostModule = require("./host");
const settings = require("../settings");
const { resolveCleanup } = require("../cleanup-styles");
const { cleanContextFor } = require("../util/clean-budget");

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
let loadedCleanupContext = 0; // context size the loaded model was given

// Windows on ARM (and macOS Rosetta) runs our x64 build as an emulated process.
// STT (sherpa-onnx) tolerates that, but node-llama-cpp's GPU auto-probe faults
// hard under emulation — a native crash the worker's try/catch can't catch, so
// it takes the whole cleanup process down and every dictation falls back to the
// raw transcript. That is the "transcription works but cleanup doesn't" report
// on Snapdragon X machines. There is no in-process arm64 STT binary yet (so we
// can't ship a native arm64 build without losing transcription); the fix that
// keeps both halves working is to run cleanup on the CPU backend under
// emulation. `app.runningUnderARM64Translation` is Electron's own signal for
// exactly this — true only when an x64/x86 build runs on an arm64 host — and it
// sees through the emulation that virtualizes env vars and GetNativeSystemInfo.
function runningEmulated() {
  try {
    return app.runningUnderARM64Translation === true;
  } catch {
    return false;
  }
}

// Load the cleanup model into the worker if it isn't already. Throws if the
// model isn't downloaded yet — callers surface that (or fall back to HTTP).
//
// The context is sized from how long the user is allowed to dictate, because
// the whole turn — rules, transcript and generated output — has to fit in it at
// once (main/util/clean-budget.js). Someone who raises Max dictation length
// gets a context that can still hold what they say; everyone else keeps the
// smaller KV cache. A changed size reloads the model: the context is allocated
// at load time, so the worker can't grow one in place.
async function ensureCleanup(modelId) {
  const model = resolve("cleanup", modelId);
  if (!manager.isInstalled(modelsDir(), model)) {
    throw new Error(`Cleanup model "${modelId}" is not downloaded yet`);
  }
  const contextSize = cleanContextFor(settings.get().audio?.maxRecordingSeconds);
  if (loadedCleanup !== modelId || loadedCleanupContext !== contextSize) {
    await cleanupHost.request("load-cleanup", {
      modelPath: path.join(manager.modelDir(modelsDir(), model), model.gguf.file),
      contextSize,
      // Skip the GPU probe on an emulated (Windows-on-ARM / Rosetta) host so
      // the load can't crash the worker; run cleanup on the CPU backend there.
      cpuOnly: runningEmulated(),
    });
    loadedCleanup = modelId;
    loadedCleanupContext = contextSize;
  }
}

// Prefill-ahead: load the cleanup model if needed and evaluate the prompt
// prefix — the static instructions plus whatever transcript prefix is already
// known (the live preview's committed text) — into the worker's context, so
// the next clean() only prefills what follows before generating. The prompt
// built here MUST stay a strict string prefix of clean()'s user turn for the
// KV reuse to hit. Best effort: callers fire-and-forget it.
async function primeCleanup(cfg, transcriptPrefix = "") {
  await ensureCleanup(cfg.builtin.model);
  const { systemPrompt } = resolveCleanup(cfg);
  return cleanupHost.request("prime-cleanup", {
    text: `${systemPrompt}\n\nTranscript:\n${transcriptPrefix}`,
  });
}

// Abort any in-flight or queued cancellable cleanup work (live-preview cleans,
// primes) so the worker is free for the authoritative final clean. A no-op
// when the worker has nothing loaded — never spawns a worker just to cancel.
function cancelClean() {
  if (loadedCleanup === null) return;
  cleanupHost.request("cancel-clean").catch(() => {});
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
  loadedCleanupContext = 0;
}

function stop() {
  forgetStt();
  forgetCleanup();
  sttHost.stop();
  cleanupHost.stop();
}

// Give an idle dictation's memory back to the OS by exiting the worker that
// holds it. The next transcribe/clean re-forks it and re-runs
// ensureStt/ensureCleanup.
//
// Exiting is the only thing that actually reclaims. Dropping the engine handles
// in-process does not: sherpa-onnx exposes no free() at all, so the recognizer
// waits on a V8 finalizer that an idle worker never triggers (measured on
// Parakeet int8: 1.05 GB resident, unchanged 30s after an in-process unload),
// and even once the handles are gone the native allocators keep the pages
// rather than returning them.
//
// The cost is a cold re-load (~3-4s for Parakeet int8) — paid off the critical
// path, because startRecording() warms both engines as recording begins, so it
// lands under the time the user spends speaking. Each worker is stopped
// independently and only if it had a model resident, so a transcribe-only user
// never touches the cleanup worker. Stopping a host notifies its exit listeners,
// which is what clears the loaded-model flags.
//
// A worker with a request in flight is left alone: the pipeline is idle here,
// but a Settings "test transcribe/cleanup" is not part of that state machine and
// killing it mid-run would surface as a bare "engine process exited". Its memory
// is reclaimed by the next idle window instead.
function unloadIdle() {
  if (loadedStt !== null && !sttHost.busy()) sttHost.stop();
  if (loadedCleanup !== null && !cleanupHost.busy()) cleanupHost.stop();
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
  primeCleanup,
  cancelClean,
  stop,
  unloadIdle,
  registry,
};
