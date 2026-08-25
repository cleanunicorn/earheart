// Routes a transcribe/clean stage to the in-process engine or the HTTP client
// based on the slice's `engine` field ("builtin" | "remote"). Both backends take
// the same (payload, cfg, signal) shape, so the only difference is which
// implementation runs. The pipeline and the Settings "test" IPC handlers all go
// through here, so the builtin-vs-remote choice lives in exactly one place.

const stt = require("./stt");
const cleanup = require("./cleanup");
const engines = require("../engines");
const { stripFillers } = require("../util/filler-strip");

// Styles whose directive promises a filler-free result. A small local model
// keeps "um"/"uh" often enough that the promise needs a deterministic backstop
// (main/util/filler-strip.js) — applied here so both engines and both callers
// (final clean and live preview) get the same guarantee. "verbatim" keeps every
// word by definition and "custom" runs the user's own prompt, so neither is
// second-guessed.
const FILLER_FREE_STYLES = new Set(["clean", "polished"]);

// `opts.onDecodeMs` only has an effect on the builtin engine (the worker
// reports its decode timing); the HTTP client ignores it.
function transcribe(wav, cfg, signal, opts) {
  const impl = cfg.engine === "builtin" ? engines.transcribe : stt.transcribe;
  return impl(wav, cfg, signal, opts);
}

// `opts.onProgress` only has an effect on the builtin engine (the worker
// streams token progress); the HTTP client ignores it.
async function clean(raw, cfg, signal, opts) {
  const impl = cfg.engine === "builtin" ? engines.clean : cleanup.clean;
  const cleaned = await impl(raw, cfg, signal, opts);
  return FILLER_FREE_STYLES.has(cfg.style) ? stripFillers(cleaned) : cleaned;
}

module.exports = { transcribe, clean };
