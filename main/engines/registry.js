// Registry of the models Earheart can download and run in-process.
//
// Two kinds:
//   - "stt"     speech-to-text, run by sherpa-onnx (NVIDIA Parakeet, ONNX)
//   - "cleanup" transcript cleanup, run by node-llama-cpp (Gemma, GGUF)
//
// Each model is just a list of files to fetch. We download individual files
// (rather than an archive) so there is nothing to extract: the download
// manager streams each URL to disk and the engines load the files in place.
//
// `bytes` is the approximate size of each file, used for the wizard's progress
// bar. `sha256` is optional but strongly recommended before release: when
// present the download manager verifies it, which is the only real guard
// against a corrupted, tampered, or wrong file being loaded into the native
// runtimes. The entries below ship without checksums and should have them
// filled in (and the URLs/sizes sanity-checked against the live repos) before
// the built-in engines are released.

// Sherpa-onnx hosts ready-to-run ONNX bundles of the NeMo Parakeet models on
// Hugging Face; we pull the encoder/decoder/joiner and the token table.
const STT_HF = "https://huggingface.co/csukuangfj";

// The ggml-org (llama.cpp) org publishes ungated GGUF builds of the Gemma 3
// instruct models, which is exactly what node-llama-cpp / llama.cpp load. We
// avoid google/* here because those repos are gated and return HTTP 401 to
// anonymous downloads.
const GEMMA_HF = "https://huggingface.co/ggml-org";

const MODELS = {
  stt: {
    "parakeet-tdt-0.6b-v3-int8": {
      id: "parakeet-tdt-0.6b-v3-int8",
      label: "Parakeet TDT 0.6B v3 (multilingual, int8)",
      kind: "stt",
      engine: "sherpa-parakeet",
      // ~25 languages, auto-detected, faster-than-realtime on CPU.
      note: "Runs on this computer · 25 languages · ~660 MB",
      files: [
        { name: "encoder.int8.onnx", bytes: 636_000_000,
          url: `${STT_HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx` },
        { name: "decoder.int8.onnx", bytes: 7_000_000,
          url: `${STT_HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx` },
        { name: "joiner.int8.onnx", bytes: 5_000_000,
          url: `${STT_HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx` },
        { name: "tokens.txt", bytes: 60_000,
          url: `${STT_HF}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt` },
      ],
      // How the sherpa-onnx engine should wire the files together.
      sherpa: {
        encoder: "encoder.int8.onnx",
        decoder: "decoder.int8.onnx",
        joiner: "joiner.int8.onnx",
        tokens: "tokens.txt",
        modelType: "nemo_transducer",
      },
    },
  },
  cleanup: {
    "gemma-3-1b": {
      id: "gemma-3-1b",
      label: "Gemma 3 1B (fast, small)",
      kind: "cleanup",
      engine: "llama-gguf",
      default: true,
      note: "Runs on this computer · ~0.7 GB · best for most laptops",
      files: [
        { name: "gemma-3-1b-it-Q4_K_M.gguf", bytes: 806_058_240,
          url: `${GEMMA_HF}/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf` },
      ],
      gguf: { file: "gemma-3-1b-it-Q4_K_M.gguf" },
    },
    "gemma-3-4b": {
      id: "gemma-3-4b",
      label: "Gemma 3 4B (balanced)",
      kind: "cleanup",
      engine: "llama-gguf",
      note: "Runs on this computer · ~2.6 GB · needs ~6 GB RAM",
      files: [
        { name: "gemma-3-4b-it-Q4_K_M.gguf", bytes: 2_489_757_856,
          url: `${GEMMA_HF}/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf` },
      ],
      gguf: { file: "gemma-3-4b-it-Q4_K_M.gguf" },
    },
    "gemma-4-12b": {
      id: "gemma-4-12b",
      label: "Gemma 3 12B (best quality)",
      kind: "cleanup",
      engine: "llama-gguf",
      note: "Runs on this computer · ~7 GB · needs ~10 GB RAM, strong machine",
      files: [
        { name: "gemma-3-12b-it-Q4_K_M.gguf", bytes: 7_300_574_976,
          url: `${GEMMA_HF}/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-Q4_K_M.gguf` },
      ],
      gguf: { file: "gemma-3-12b-it-Q4_K_M.gguf" },
    },
  },
};

const DEFAULT_STT_MODEL = "parakeet-tdt-0.6b-v3-int8";
const DEFAULT_CLEANUP_MODEL = "gemma-3-1b";

/** Look up a model by kind ("stt" | "cleanup") and id. */
function getModel(kind, id) {
  return (MODELS[kind] && MODELS[kind][id]) || null;
}

/** All models of a kind, as an array (for settings dropdowns). */
function listModels(kind) {
  return Object.values(MODELS[kind] || {});
}

/** Total download size of a model in bytes. */
function totalBytes(model) {
  return model.files.reduce((sum, f) => sum + (f.bytes || 0), 0);
}

module.exports = {
  MODELS,
  DEFAULT_STT_MODEL,
  DEFAULT_CLEANUP_MODEL,
  getModel,
  listModels,
  totalBytes,
};
