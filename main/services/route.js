// Routes a transcribe/clean stage to the in-process engine or the HTTP client
// based on the slice's `engine` field ("builtin" | "remote"). Both backends take
// the same (payload, cfg, signal) shape, so the only difference is which
// implementation runs. The pipeline and the Settings "test" IPC handlers all go
// through here, so the builtin-vs-remote choice lives in exactly one place.

const stt = require("./stt");
const cleanup = require("./cleanup");
const engines = require("../engines");
const { stripStumbles } = require("../util/stumble-strip");

// Styles whose directive promises no fillers and no repeated words. The
// directive alone does not deliver that: measured against the real Gemma 3 4B
// (scripts/eval-cleanup.mjs, the FLUENT corpus), a long, mostly fluent
// dictation with fillers sprinkled through it comes back with every "um" and
// "uh" still in place, 3 runs out of 3 — the base prompt's preservation rules
// ("never add information", "reproduce it verbatim") put the model in copy
// mode, and one editing directive does not outvote them. So the promise needs
// a deterministic backstop (main/util/stumble-strip.js) — applied here so both
// engines and both callers (final clean and live preview) get the same
// guarantee. "verbatim" keeps every word by definition and "custom" runs the
// user's own prompt, so neither is second-guessed.
const TIDIED_STYLES = new Set(["clean", "polished"]);

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
  return TIDIED_STYLES.has(cfg.style) ? stripStumbles(cleaned) : cleaned;
}

module.exports = { transcribe, clean };
