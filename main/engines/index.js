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
const { cleanupTurnPrefix } = require("../util/cleanup-turn");
const { unsupportedSttFamily } = require("../services/hf-models");

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

// Whether a dictation with these STT settings can be transcribed, answered from
// the registry and the disk only — cheap and synchronous, so the pipeline asks
// on every hotkey press before opening the microphone, and startup asks before
// saying "ready". Returns data, not copy (main/setup-notices.js words it):
//   { ok: true }                                      remote engine, or installed
//   { ok: false, reason: "missing", modelId, label }  built-in model not on disk
//   { ok: false, reason: "unknown", modelId }         id not in the registry
// It proves the files are there, not that the native engine will load them;
// the final pass still surfaces a load failure.
function getSttReadiness(sttCfg) {
  if (sttCfg?.engine !== "builtin") return { ok: true };
  const modelId = sttCfg.builtin?.model;
  const model = registry.getModel("stt", modelId);
  if (!model) return { ok: false, reason: "unknown", modelId };
  let installed;
  try {
    installed = manager.isInstalled(modelsDir(), model);
  } catch {
    // An indeterminate check must never cost a dictation: let it record, and
    // the final pass reports whatever is really wrong.
    return { ok: true };
  }
  if (installed) return { ok: true };
  return { ok: false, reason: "missing", modelId, label: model.label || modelId };
}

function download(kind, modelId, { onProgress, signal } = {}) {
  return manager.download(modelsDir(), resolve(kind, modelId), { onProgress, signal });
}

function remove(kind, modelId) {
  return manager.remove(modelsDir(), resolve(kind, modelId));
}

// Delete the files of a definition the registry may not hold (an orphaned
// custom download, or the previous revision of a custom model being replaced).
function removeFiles(model) {
  return manager.remove(modelsDir(), model);
}

function definitionFingerprint(model) {
  return manager.definitionFingerprint(model);
}

/* ---------------- speech-to-text ---------------- */

let loadedStt = null;
const sttLoad = { inflight: null };

// Share one in-flight load between concurrent callers asking for the same
// thing. Recording start warms STT and the final pass loads it again, so on a
// cold start both callers can arrive before the first load settles; each
// posting its own load-stt made the worker (whose STT load isn't queued) build
// the recognizer twice. The cleanup worker queues its loads and checks
// residency itself, so there the memo only saves a redundant round trip. Only
// the in-flight promise is shared: once it settles (either way) the slot is
// cleared, so a failed load is retried rather than replayed.
function sharedLoad(slot, key, start) {
  if (slot.inflight?.key === key) return slot.inflight.promise;
  const entry = { key, promise: start() };
  slot.inflight = entry;
  // Registered first, so the slot is clear before any caller hears the outcome
  // (a retry from a rejection handler must post a fresh load). Handling the
  // rejection here also keeps this bookkeeping branch from being unhandled;
  // callers still get the real rejection from entry.promise.
  const clear = () => {
    // A newer load (another model, or one after a worker exit) owns the slot.
    if (slot.inflight === entry) slot.inflight = null;
  };
  entry.promise.then(clear, clear);
  return entry.promise;
}

// Load the STT model into the worker if it isn't already. Throws if the model
// isn't downloaded yet — the pipeline surfaces the error and preserves any
// text already recovered; routing does not retry through HTTP.
async function ensureStt(modelId) {
  const model = resolve("stt", modelId);
  // Hugging Face discovery used to save any joiner-less bundle as Whisper, so
  // a Canary entry may already sit in settings with a Whisper config the
  // worker can't tell apart from the real thing. Its id, label and repo still
  // say what it is: refuse it here, with the way out, instead of loading it.
  const family =
    model.sherpa && !model.sherpa.joiner
      ? unsupportedSttFamily([model.id, model.label, model.source && model.source.repo].join(" "))
      : null;
  if (family) {
    throw new Error(
      `"${model.label || modelId}" is a ${family} model, which Earheart can't run. ` +
        "Remove it in Settings → Speech-to-text and add a Parakeet or Whisper model instead."
    );
  }
  if (!manager.isInstalled(modelsDir(), model)) {
    throw new Error(`STT model "${modelId}" is not downloaded yet`);
  }
  if (loadedStt !== modelId) {
    await sharedLoad(sttLoad, modelId, async () => {
      await sttHost.request("load-stt", {
        dir: manager.modelDir(modelsDir(), model),
        sherpa: model.sherpa,
        modelId,
      });
      loadedStt = modelId;
    });
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

let cleanupResident = false; // worker may hold a model, even after a failed operation
let cleanupOperationId = 0;

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

// Snapshot a selected cleanup model for an atomic worker load/operation.
// Throws if it is not downloaded; callers surface the failure and retain raw text.
//
// The context is sized from how long the user is allowed to dictate, because
// the whole turn — rules, transcript and generated output — has to fit in it at
// once (main/util/clean-budget.js). Someone who raises Max dictation length
// gets a context that can still hold what they say; everyone else keeps the
// smaller KV cache. A changed size reloads the model: the context is allocated
// at load time, so the worker can't grow one in place.
function cleanupModel(modelId) {
  const model = resolve("cleanup", modelId);
  if (!manager.isInstalled(modelsDir(), model)) {
    throw new Error(`Cleanup model "${modelId}" is not downloaded yet`);
  }
  return {
    modelPath: path.join(manager.modelDir(modelsDir(), model), model.gguf.file),
    contextSize: cleanContextFor(settings.get().audio?.maxRecordingSeconds),
    // Avoid the native GPU probe under Windows-on-ARM / Rosetta emulation.
    cpuOnly: runningEmulated(),
  };
}

function cleanupRequest(type, args, opts) {
  // Set before submission: a cold load is cancellable and must prevent idle
  // eviction. Worker exit clears this marker; never restore it after an await.
  cleanupResident = true;
  return cleanupHost.request(type, args, opts);
}

const cleanupLoad = { inflight: null };

// Load the cleanup model ahead of use. The pipeline doesn't call this: it warms
// with primeCleanup() and every clean() carries its model to the worker, which
// loads it on demand. The key includes the context size: a changed size is a
// different load.
async function ensureCleanup(modelId) {
  const model = cleanupModel(modelId);
  return sharedLoad(cleanupLoad, `${modelId}:${model.contextSize}`, () =>
    cleanupRequest("load-cleanup", model)
  );
}

// Prefill-ahead: load the cleanup model if needed and evaluate the prompt
// prefix — the static instructions plus whatever transcript prefix is already
// known (the live preview's committed text) — into the worker's context, so
// the next clean() only prefills what follows before generating. The prompt
// is a strict string prefix of clean()'s user turn (main/util/cleanup-turn.js
// builds both), which is what lets the KV reuse hit. Best effort: callers
// fire-and-forget it.
async function primeCleanup(cfg, transcriptPrefix = "") {
  const model = cleanupModel(cfg.builtin.model);
  const { systemPrompt } = resolveCleanup(cfg);
  return cleanupRequest("prime-cleanup", {
    model,
    text: cleanupTurnPrefix(systemPrompt, transcriptPrefix),
  });
}

// Abort any in-flight or queued cancellable cleanup work (live-preview cleans,
// primes) so the worker is free for the authoritative final clean. A no-op
// when no cleanup request has reached the worker — never spawns one to cancel.
function cancelClean() {
  if (!cleanupResident) return;
  cleanupHost.request("cancel-clean").catch(() => {});
}

// Accepts a `signal` for parity with the HTTP cleanup client (see transcribe).
// `onProgress` (0..1) relays the worker's token-streaming progress, so the
// pipeline can drive a determinate bar while the model generates.
async function clean(transcript, cfg, signal, { onProgress } = {}) {
  if (signal?.aborted) throw new Error("aborted");
  const model = cleanupModel(cfg.builtin.model);
  const { systemPrompt, sampling } = resolveCleanup(cfg);
  const operationId = ++cleanupOperationId;
  // A caller's signal cancels its own turn. Pipeline cancelClean() still
  // cancels all outstanding previews/primes before authoritative final cleanup.
  const abort = () => {
    if (cleanupResident) cleanupHost.request("cancel-clean", { operationId }).catch(() => {});
  };
  const pending = cleanupRequest("clean", {
    model, operationId, transcript, systemPrompt, sampling,
  }, { onProgress });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const cleaned = await pending;
    if (signal?.aborted) throw new Error("aborted");
    if (typeof cleaned !== "string" || cleaned.trim().length === 0) {
      throw new Error("Cleanup returned no usable text");
    }
    return cleaned;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

// Worker exit forgets STT identity and cleanup residency. Cleanup model
// identity is authoritative inside the worker, checked on every operation.
function forgetStt() {
  loadedStt = null;
  // A load posted to the dead worker is doomed; don't let the successor's
  // callers join it.
  sttLoad.inflight = null;
}

function forgetCleanup() {
  cleanupResident = false;
  cleanupLoad.inflight = null; // as in forgetStt: never join the dead worker's load
}

function stop() {
  forgetStt();
  forgetCleanup();
  sttHost.stop();
  cleanupHost.stop();
}

// Retire the STT worker only — for a decode that timed out: the native call
// keeps running in the worker, so a retry (and the next dictation) must not
// queue behind it. The host already retires a worker whose request timed out
// (host.js), so after a timeout this is a no-op kept as the caller's explicit
// intent. The exit listener forgets the loaded model, so the next transcribe
// re-forks and reloads. Cleanup is untouched.
function restartStt() {
  sttHost.stop();
}

// Stop one worker unless it has a request in flight. Reports whether that
// worker is now gone.
function stopIfIdle(host) {
  if (host.busy()) return false;
  host.stop();
  return true;
}

// Give an idle dictation's memory back to the OS by exiting the worker that
// holds it. The next transcribe/clean re-forks it and reloads the model: STT
// through ensureStt, cleanup inside the worker, which every clean/prime
// carries its model descriptor to.
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
// killing it mid-run would surface as a bare "engine process exited". Skipping
// one is reported back rather than swallowed — the caller's idle window has
// already elapsed, so nothing would re-arm it and that worker would stay
// resident for the rest of the session.
//
// The busy check has to run even when the loaded-model flag says there is
// nothing to reclaim. That flag is only set once a load RESOLVES (see
// ensureStt), so for the several seconds a cold load takes it reads null while
// the worker is very much working — and a `loaded === null` short-circuit would
// skip the worker without reporting it, leaving the model resident with no
// timer armed behind it. Ask the host directly instead: null AND idle is the
// only combination that means "nothing to do here".
//
// @returns {boolean} true when nothing resident is left, false when a busy
// worker was skipped and the caller should come back for it.
function unloadIdle() {
  const sttClear = (loadedStt === null && !sttHost.busy()) || stopIfIdle(sttHost);
  const cleanupClear = (!cleanupResident && !cleanupHost.busy()) || stopIfIdle(cleanupHost);
  return sttClear && cleanupClear;
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
  getSttReadiness,
  download,
  remove,
  removeFiles,
  definitionFingerprint,
  ensureStt,
  transcribe,
  ensureCleanup,
  clean,
  primeCleanup,
  cancelClean,
  stop,
  restartStt,
  unloadIdle,
  registry,
};
