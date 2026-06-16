// In-app transcript cleanup: runs a small Gemma GGUF through node-llama-cpp
// inside the Electron main process — no Ollama, no llama.cpp server, no API
// key. Mirrors services/cleanup.js (clean(transcript, cfg, signal) -> text)
// including its golden rule: a failed or empty cleanup never eats the user's
// words, the raw transcript is returned instead.
//
// node-llama-cpp is an ESM-only package, so it is imported dynamically and
// lazily; the model is loaded on first use and reused across dictations.

const { stripThinking } = require("./cleanup");
const models = require("./model-manager");
const catalog = require("./model-catalog");

let llama = null;
let model = null;
let loadedPath = null;

async function getLlama() {
  if (llama) return llama;
  let mod;
  try {
    mod = await import("node-llama-cpp");
  } catch (err) {
    throw new Error(
      "Local cleanup engine is unavailable on this system " +
        `(node-llama-cpp failed to load: ${err.message}). ` +
        "Switch cleanup to a remote service in Settings, or turn cleanup off."
    );
  }
  llama = await mod.getLlama();
  return llama;
}

async function ensureModel(cfg) {
  const spec = catalog.getCleanupModel(cfg.localModel, cfg.localModelUri);
  const filePath = models.cleanupModelFilePath(spec);
  if (model && loadedPath === filePath) return model;

  const engine = await getLlama();
  model = await engine.loadModel({ modelPath: filePath });
  loadedPath = filePath;
  return model;
}

/**
 * @param {string} transcript
 * @param {object} cfg - settings.cleanup slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function clean(transcript, cfg, signal) {
  if (signal?.aborted) throw new Error("aborted");
  const m = await ensureModel(cfg);

  // A fresh context+session per call keeps cleanups independent (no bleed
  // between unrelated dictations) and bounds memory between uses.
  const context = await m.createContext({ contextSize: { max: 4096 } });
  try {
    const { LlamaChatSession } = await import("node-llama-cpp");
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: cfg.systemPrompt,
    });
    const answer = await session.prompt(transcript, {
      temperature: cfg.temperature ?? 0.2,
      signal,
    });
    const cleaned = stripThinking(answer);
    return cleaned.length > 0 ? cleaned : transcript;
  } finally {
    await context.dispose();
  }
}

function unload() {
  // Models hold native memory; drop references so GC/finalizers can reclaim.
  model = null;
  loadedPath = null;
}

module.exports = { clean, unload };
