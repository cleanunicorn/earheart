// In-app speech-to-text: runs NVIDIA Parakeet through sherpa-onnx inside the
// Electron main process — no Python, no separate server, no API key. Speaks
// the same contract as services/stt.js (transcribe(wav, cfg, signal) -> text)
// so pipeline.js can pick either engine without caring which one it got.
//
// The native module (sherpa-onnx-node) is required lazily and tolerantly: if a
// platform build is missing, we surface a clear error instead of crashing the
// app at startup, and the remote/server STT paths keep working.

const { decodeWav } = require("../util/wav");
const models = require("./model-manager");
const catalog = require("./model-catalog");

let recognizer = null;
let loadedId = null;

function loadAddon() {
  try {
    return require("sherpa-onnx-node");
  } catch (err) {
    throw new Error(
      "Local speech-to-text engine is unavailable on this system " +
        `(sherpa-onnx-node failed to load: ${err.message}). ` +
        "Switch STT to a remote service in Settings, or reinstall Earheart."
    );
  }
}

function ensureRecognizer(modelId) {
  const id = modelId || catalog.DEFAULT_STT_MODEL;
  if (recognizer && loadedId === id) return recognizer;

  const paths = models.sttModelPaths(id); // throws if not downloaded
  const sherpa = loadAddon();

  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      tokens: paths.tokens,
      modelType: paths.modelType,
      numThreads: Math.max(1, Math.min(4, require("node:os").cpus().length - 1)),
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  loadedId = id;
  return recognizer;
}

/**
 * @param {Buffer|ArrayBuffer} wav - 16 kHz mono PCM16 WAV (what the recorder produces)
 * @param {object} cfg - settings.stt slice (uses cfg.localModel)
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function transcribe(wav, cfg, signal) {
  if (signal?.aborted) throw new Error("aborted");
  const rec = ensureRecognizer(cfg.localModel);
  const { samples, sampleRate } = decodeWav(wav);
  if (samples.length === 0) return "";

  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  const result = await rec.decodeAsync(stream);
  return (result?.text || "").trim();
}

// Free native resources (called on quit, or when switching away from builtin).
function unload() {
  recognizer = null;
  loadedId = null;
}

module.exports = { transcribe, unload };
