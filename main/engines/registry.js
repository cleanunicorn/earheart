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
// `bytes` is the exact file size, used for the wizard's progress bar. `sha256`
// is the file's verified checksum: the download manager hashes each file as it
// streams and rejects a mismatch, which is the real guard against a corrupted,
// tampered, or wrong file being loaded into the native runtimes. Every URL is
// pinned to an immutable Hugging Face commit (`resolve/<commit>/…`) rather than
// a moving branch, so the bytes are reproducible and the checksum can't drift.
//
// To refresh after a model is re-published: HEAD the `resolve/main/<file>` URL
// and read `x-repo-commit` (the commit to pin), `x-linked-etag` (the sha256 for
// LFS files), and `x-linked-size` (bytes). For non-LFS files (e.g. tokens.txt)
// download at the pinned commit and `shasum -a 256` it.

// Sherpa-onnx hosts ready-to-run ONNX bundles of the NeMo Parakeet models on
// Hugging Face; we pull the encoder/decoder/joiner and the token table.
const STT_REPO = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const STT_COMMIT = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
const sttUrl = (file) => `${STT_REPO}/resolve/${STT_COMMIT}/${file}`;

// The ggml-org (llama.cpp) org publishes ungated GGUF builds of the Gemma 3
// instruct models, which is exactly what node-llama-cpp / llama.cpp load. We
// avoid google/* here because those repos are gated and return HTTP 401 to
// anonymous downloads. Each model lives in its own repo, so pin per model.
const gemmaUrl = (repo, commit, file) =>
  `https://huggingface.co/ggml-org/${repo}/resolve/${commit}/${file}`;

const MODELS = {
  stt: {
    "parakeet-tdt-0.6b-v3-int8": {
      id: "parakeet-tdt-0.6b-v3-int8",
      label: "Parakeet TDT 0.6B v3 (multilingual, int8)",
      kind: "stt",
      engine: "sherpa-parakeet",
      // ~25 languages, auto-detected, faster-than-realtime on CPU.
      note: "Runs on this computer · 25 languages · ~670 MB",
      files: [
        { name: "encoder.int8.onnx", bytes: 652_184_281,
          sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
          url: sttUrl("encoder.int8.onnx") },
        { name: "decoder.int8.onnx", bytes: 11_845_275,
          sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
          url: sttUrl("decoder.int8.onnx") },
        { name: "joiner.int8.onnx", bytes: 6_355_277,
          sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
          url: sttUrl("joiner.int8.onnx") },
        { name: "tokens.txt", bytes: 93_939,
          sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
          url: sttUrl("tokens.txt") },
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
      note: "Runs on this computer · ~0.8 GB · best for most laptops",
      files: [
        { name: "gemma-3-1b-it-Q4_K_M.gguf", bytes: 806_058_240,
          sha256: "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135",
          url: gemmaUrl("gemma-3-1b-it-GGUF", "f9c28bcd85737ffc5aef028638d3341d49869c27", "gemma-3-1b-it-Q4_K_M.gguf") },
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
          sha256: "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863",
          url: gemmaUrl("gemma-3-4b-it-GGUF", "d0976223747697cb51e056d85c532013931fe52e", "gemma-3-4b-it-Q4_K_M.gguf") },
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
          sha256: "7bb69bff3f48a7b642355d64a90e481182a7794707b3133890646b1efa778ff5",
          url: gemmaUrl("gemma-3-12b-it-GGUF", "ec0cbabd8dbff316f659876a50202295c3c4a314", "gemma-3-12b-it-Q4_K_M.gguf") },
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
