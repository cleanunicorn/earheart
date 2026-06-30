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
// Hugging Face; we pull the encoder/decoder/joiner and the token table. Each
// bundle lives in its own repo (int8 vs fp32, v3 multilingual vs v2 English),
// so pin a repo + commit per model. The fp32 builds store the encoder weights
// in a separate `encoder.weights` external-data file alongside `encoder.onnx`;
// both must be downloaded into the same directory for the loader to find them.
const sttUrl = (repo, commit, file) =>
  `https://huggingface.co/csukuangfj/${repo}/resolve/${commit}/${file}`;

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
      default: true,
      // ~25 languages, auto-detected, faster-than-realtime on CPU.
      note: "Runs on this computer · 25 languages · ~670 MB · best for most laptops",
      files: [
        { name: "encoder.int8.onnx", bytes: 652_184_281,
          sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", "encoder.int8.onnx") },
        { name: "decoder.int8.onnx", bytes: 11_845_275,
          sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", "decoder.int8.onnx") },
        { name: "joiner.int8.onnx", bytes: 6_355_277,
          sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", "joiner.int8.onnx") },
        { name: "tokens.txt", bytes: 93_939,
          sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "2bda32ec70b097a55adaa07d9a7173915b43cc78", "tokens.txt") },
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
    "parakeet-tdt-0.6b-v3": {
      id: "parakeet-tdt-0.6b-v3",
      label: "Parakeet TDT 0.6B v3 (multilingual, full precision)",
      kind: "stt",
      engine: "sherpa-parakeet",
      // Same 25-language model as the default, but fp32 weights — slightly
      // higher accuracy at a larger download and more RAM/CPU per transcription.
      note: "Runs on this computer · 25 languages · ~2.4 GB · higher accuracy, needs a stronger machine",
      files: [
        { name: "encoder.onnx", bytes: 41_766_257,
          sha256: "3eed7ce424bf8339ad09233533c687e2dbd07e74ccf5027b5e7344019ea373b0",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3", "1a468a35cbba69418f126de829e75261dea4a4e4", "encoder.onnx") },
        { name: "encoder.weights", bytes: 2_435_420_160,
          sha256: "3af3f51af5f2d01dbbf5af47d42c7962a2c205f11004254bb4f2b979862f39a8",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3", "1a468a35cbba69418f126de829e75261dea4a4e4", "encoder.weights") },
        { name: "decoder.onnx", bytes: 47_233_743,
          sha256: "d593cdb0e571f5a457ec2219af9968cbf6b0e8198e8f7839b40a8754593bf68c",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3", "1a468a35cbba69418f126de829e75261dea4a4e4", "decoder.onnx") },
        { name: "joiner.onnx", bytes: 25_286_330,
          sha256: "b9b0bcf88ac571902e69a6536223ed2d94885e981b85045410f1403d53121a63",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3", "1a468a35cbba69418f126de829e75261dea4a4e4", "joiner.onnx") },
        { name: "tokens.txt", bytes: 93_939,
          sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3", "1a468a35cbba69418f126de829e75261dea4a4e4", "tokens.txt") },
      ],
      sherpa: {
        encoder: "encoder.onnx",
        decoder: "decoder.onnx",
        joiner: "joiner.onnx",
        tokens: "tokens.txt",
        modelType: "nemo_transducer",
      },
    },
    "parakeet-tdt-0.6b-v2": {
      id: "parakeet-tdt-0.6b-v2",
      label: "Parakeet TDT 0.6B v2 (English only, full precision)",
      kind: "stt",
      engine: "sherpa-parakeet",
      // English-only fp32 model. Top of the English ASR leaderboards; pick this
      // if you only dictate in English and want the best accuracy.
      note: "Runs on this computer · English only · ~2.4 GB · best English accuracy, needs a stronger machine",
      files: [
        { name: "encoder.onnx", bytes: 41_766_257,
          sha256: "7ce8d2b3f45fcd3b553d3b7a188436db7748c271081cc004f28bf76f3df01893",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "86891485dd8ad7cb28cb1aade45c3e23d0197c30", "encoder.onnx") },
        { name: "encoder.weights", bytes: 2_435_420_160,
          sha256: "90cd4bb6c9b60496d49be9bec3a844f4e9bf22c62a45ea93f391cc00f9a47cfe",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "86891485dd8ad7cb28cb1aade45c3e23d0197c30", "encoder.weights") },
        { name: "decoder.onnx", bytes: 28_883_663,
          sha256: "0140d12782ccf550a9709f03a52c2782b3c54d045f47ce14af39c713ab42de7f",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "86891485dd8ad7cb28cb1aade45c3e23d0197c30", "decoder.onnx") },
        { name: "joiner.onnx", bytes: 6_907_576,
          sha256: "a9e57e488cd1016cbefd51f60712896af6590e3f61ff466a540e085bbd6af59e",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "86891485dd8ad7cb28cb1aade45c3e23d0197c30", "joiner.onnx") },
        { name: "tokens.txt", bytes: 9_384,
          sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
          url: sttUrl("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2", "86891485dd8ad7cb28cb1aade45c3e23d0197c30", "tokens.txt") },
      ],
      sherpa: {
        encoder: "encoder.onnx",
        decoder: "decoder.onnx",
        joiner: "joiner.onnx",
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

// User-added models (cleanup GGUFs from a custom Hugging Face URL). Kept in
// memory and registered at startup from persisted settings (see main/ipc.js),
// so they resolve through the same getModel/listModels path the built-ins use
// — no special-casing in the download manager, engines, or IPC layers. Same
// shape as a MODELS entry, minus the sha256 we can't pre-verify for a user URL.
let customModels = [];

function setCustomModels(list) {
  customModels = Array.isArray(list) ? list.filter((m) => m && m.id && m.kind) : [];
}

/** Look up a model by kind ("stt" | "cleanup") and id. */
function getModel(kind, id) {
  return (
    (MODELS[kind] && MODELS[kind][id]) ||
    customModels.find((m) => m.kind === kind && m.id === id) ||
    null
  );
}

/** All models of a kind, as an array (built-ins first, then custom). */
function listModels(kind) {
  return Object.values(MODELS[kind] || {}).concat(
    customModels.filter((m) => m.kind === kind)
  );
}

/** Total download size of a model in bytes. */
function totalBytes(model) {
  return model.files.reduce((sum, f) => sum + (f.bytes || 0), 0);
}

module.exports = {
  MODELS,
  DEFAULT_STT_MODEL,
  DEFAULT_CLEANUP_MODEL,
  setCustomModels,
  getModel,
  listModels,
  totalBytes,
};
