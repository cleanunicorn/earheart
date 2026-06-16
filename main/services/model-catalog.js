// Catalog of models Earheart can download and run in-process, with no Python,
// no separate server and no API keys. Speech-to-text runs through
// sherpa-onnx (NVIDIA Parakeet, an offline transducer); cleanup runs through
// node-llama-cpp (a small Gemma GGUF). Everything here is plain data plus a
// couple of lookup helpers so it can be unit-tested without Electron.
//
// File names and Hugging Face repos are the published locations for these
// models. They are downloaded on first run (see model-manager.js); the chosen
// model is configurable, and the cleanup model also accepts a custom Hugging
// Face URI, so a wrong default here is recoverable from the UI.

// ---------------------------------------------------------------------------
// Speech-to-text (sherpa-onnx offline transducer, NeMo Parakeet)
// ---------------------------------------------------------------------------

// A sherpa-onnx NeMo transducer ships as three ONNX graphs plus a tokens file.
// `role` tells the recognizer config which file is which.
const STT_MODELS = {
  "parakeet-tdt-0.6b-v3-int8": {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT 0.6B v3 (int8)",
    note: "Multilingual (25 languages), runs faster than realtime on CPU.",
    approxBytes: 660 * 1024 * 1024,
    // Hugging Face repo holding the sherpa-onnx export.
    repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    revision: "main",
    files: [
      { name: "encoder.int8.onnx", role: "encoder" },
      { name: "decoder.int8.onnx", role: "decoder" },
      { name: "joiner.int8.onnx", role: "joiner" },
      { name: "tokens.txt", role: "tokens" },
    ],
    // sherpa-onnx model type for NeMo Parakeet TDT exports.
    modelType: "nemo_transducer",
  },
};

const DEFAULT_STT_MODEL = "parakeet-tdt-0.6b-v3-int8";

// ---------------------------------------------------------------------------
// Cleanup (node-llama-cpp, GGUF). Sizes are approximate download sizes.
// `uri` is a node-llama-cpp model URI ("hf:<repo>/<file>") which it resolves
// and downloads with resume + progress.
// ---------------------------------------------------------------------------

const CLEANUP_MODELS = {
  "gemma-3-1b-it-q4": {
    id: "gemma-3-1b-it-q4",
    label: "Gemma 3 1B (Q4) — recommended",
    note: "Small and fast; great for punctuation and filler-word cleanup on CPU.",
    approxBytes: 720 * 1024 * 1024,
    uri: "hf:ggml-org/gemma-3-1b-it-GGUF/gemma-3-1b-it-Q4_K_M.gguf",
  },
  "gemma-3-4b-it-q4": {
    id: "gemma-3-4b-it-q4",
    label: "Gemma 3 4B (Q4) — higher quality",
    note: "Better cleanup, noticeably slower on CPU and a larger download.",
    approxBytes: 2500 * 1024 * 1024,
    uri: "hf:ggml-org/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf",
  },
};

const DEFAULT_CLEANUP_MODEL = "gemma-3-1b-it-q4";

// A custom cleanup model: the user pastes a Hugging Face URI / GGUF URL in the
// UI and we store it under this synthetic id with the uri they gave.
const CUSTOM_CLEANUP_ID = "custom";

function getSttModel(id) {
  return STT_MODELS[id] || STT_MODELS[DEFAULT_STT_MODEL];
}

/**
 * Resolve a cleanup model spec by id. For the custom id, `customUri` supplies
 * the location the user entered.
 * @param {string} id
 * @param {string} [customUri]
 */
function getCleanupModel(id, customUri) {
  if (id === CUSTOM_CLEANUP_ID) {
    return {
      id: CUSTOM_CLEANUP_ID,
      label: "Custom model",
      note: "",
      approxBytes: 0,
      uri: (customUri || "").trim(),
    };
  }
  return CLEANUP_MODELS[id] || CLEANUP_MODELS[DEFAULT_CLEANUP_MODEL];
}

// Listings for the UI (stable order, plain objects).
function sttModelList() {
  return Object.values(STT_MODELS);
}
function cleanupModelList() {
  return Object.values(CLEANUP_MODELS);
}

module.exports = {
  STT_MODELS,
  CLEANUP_MODELS,
  DEFAULT_STT_MODEL,
  DEFAULT_CLEANUP_MODEL,
  CUSTOM_CLEANUP_ID,
  getSttModel,
  getCleanupModel,
  sttModelList,
  cleanupModelList,
};
