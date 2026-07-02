// Routes a transcribe/clean stage to the in-process engine or the HTTP client
// based on the slice's `engine` field ("builtin" | "remote"). Both backends take
// the same (payload, cfg, signal) shape, so the only difference is which
// implementation runs. The pipeline and the Settings "test" IPC handlers all go
// through here, so the builtin-vs-remote choice lives in exactly one place.

const stt = require("./stt");
const cleanup = require("./cleanup");
const engines = require("../engines");

function transcribe(wav, cfg, signal) {
  const impl = cfg.engine === "builtin" ? engines.transcribe : stt.transcribe;
  return impl(wav, cfg, signal);
}

// `opts.onProgress` only has an effect on the builtin engine (the worker
// streams token progress); the HTTP client ignores it.
function clean(raw, cfg, signal, opts) {
  const impl = cfg.engine === "builtin" ? engines.clean : cleanup.clean;
  return impl(raw, cfg, signal, opts);
}

module.exports = { transcribe, clean };
