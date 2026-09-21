// Exploratory STT worker for scripts/eval-stt.js --exploratory: a stand-in for
// main/engines/engine-worker.js that can also build the sherpa-onnx families
// the app's worker has no config for yet (moonshine, NeMo CTC, canary).
//
// Like the app's worker it runs in an Electron utilityProcess (Electron's main
// process cannot host the sherpa-onnx addon: it dies with SIGTRAP), and it
// builds the recognizer with the same settings — 16 kHz, 80-dim features,
// min(8, cpus-1) threads, CPU — and times recognizer.decode() the same way.
// That is a copy, not the app's code, which is why its rows are labelled
// "direct" and only compared with the default measured through this same
// file (the calibration row). A family that wins here is wired into the real
// worker and re-measured there before it can reach the catalog.

const path = require("node:path");
const os = require("node:os");
const { wavToFloat32, SAMPLE_RATE } = require("../main/util/wav");

const port = process.parentPort;
const FEATURE_DIM = 80;

let recognizer = null;

function familyConfig(dir, s) {
  const p = (f) => path.join(dir, f);
  switch (s.family || (s.joiner ? "transducer" : "whisper")) {
    case "transducer":
      return { transducer: { encoder: p(s.encoder), decoder: p(s.decoder), joiner: p(s.joiner) } };
    case "whisper":
      return { whisper: { encoder: p(s.encoder), decoder: p(s.decoder) } };
    case "moonshine":
      return {
        moonshine: {
          preprocessor: p(s.preprocessor),
          encoder: p(s.encoder),
          uncachedDecoder: p(s.uncachedDecoder),
          cachedDecoder: p(s.cachedDecoder),
        },
      };
    case "nemoCtc":
      return { nemoCtc: { model: p(s.model) } };
    case "canary":
      return { canary: { encoder: p(s.encoder), decoder: p(s.decoder), srcLang: "en", tgtLang: "en", usePnc: 1 } };
    default:
      throw new Error(`unknown sherpa family: ${s.family}`);
  }
}

async function load({ dir, sherpa }) {
  const sherpaOnnx = require("sherpa-onnx-node");
  const runtime = { numThreads: Math.max(1, Math.min(8, os.cpus().length - 1)), provider: "cpu" };
  const modelType = sherpa.modelType || (sherpa.joiner && !sherpa.family ? "nemo_transducer" : undefined);
  recognizer = new sherpaOnnx.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      ...familyConfig(dir, sherpa),
      tokens: path.join(dir, sherpa.tokens),
      ...runtime,
      ...(modelType ? { modelType } : {}),
      debug: false,
    },
  });
  return { ready: true, ...runtime };
}

async function transcribe({ wav }) {
  if (!recognizer) throw new Error("STT model not loaded");
  const { samples, sampleRate } = wavToFloat32(Buffer.from(wav));
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate, samples });
  const startedAt = Date.now();
  recognizer.decode(stream);
  const decodeMs = Date.now() - startedAt;
  const result = recognizer.getResult(stream);
  return { text: (result && result.text ? result.text : "").trim(), decodeMs };
}

const HANDLERS = { load, transcribe };

port.on("message", (event) => {
  const { id, type, ...args } = event.data || {};
  const handler = HANDLERS[type];
  Promise.resolve(handler ? handler(args) : Promise.reject(new Error(`Unknown request: ${type}`)))
    .then((result) => port.postMessage({ id, ok: true, result }))
    .catch((err) => port.postMessage({ id, ok: false, error: String((err && err.message) || err) }));
});
