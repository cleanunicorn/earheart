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
  // Transfer the audio's backing buffer instead of copying it across.
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const text = await host.request(
    "transcribe",
    { wav: ab, language: cfg.language || "" },
    [ab]
  );
  return (text || "").trim();
}

/* ---------------- cleanup ---------------- */

let loadedCleanup = null;

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
  // Never let an empty cleanup eat the user's words.
  return cleaned && cleaned.length > 0 ? cleaned : transcript;
}

function stop() {
  loadedStt = null;
  loadedCleanup = null;
  host.stop();
}

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
  registry,
};
