// Cleanup "style" presets — the single source of truth shared by the settings
// window, the built-in engine and the remote client.
//
// The settings UI shows one slider ("how close should the cleanup stay to your
// exact words") instead of raw sampling numbers. Each stop bundles two things:
//
//   1. a prompt directive — the DOMINANT lever. How aggressively the model is
//      allowed to edit (touch nothing vs. lightly rephrase) is driven far more
//      by the instructions than by sampling temperature.
//   2. a sampling profile — temperature plus nucleus (topP) / top-k / min-p,
//      which mostly control determinism and reinforce the directive.
//
// A "custom" style (no entry here) bypasses the presets and uses the raw
// numbers under cleanup.custom, for power users and for migrated configs that
// only ever set a bare temperature.

const STYLES = [
  {
    id: "verbatim",
    label: "Verbatim",
    hint: "Fix punctuation only — keep every word",
    directive:
      "Make the smallest possible changes: correct only punctuation, " +
      "capitalization and obvious transcription errors. Keep every word the " +
      "speaker said — do not remove fillers, false starts or repetition, and " +
      "do not rephrase.",
    sampling: { temperature: 0.0, topP: 0.9, topK: 20, minP: 0.05 },
  },
  {
    id: "clean",
    label: "Clean",
    hint: "Remove fillers, stumbles and repeats",
    directive:
      "Remove filler words (um, uh, you know, like) and false starts. " +
      "Collapse repeated words, restarted phrases and stutters into one clean " +
      "version. Keep the speaker's wording and tone — do not summarize, expand " +
      "or add anything.",
    sampling: { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05 },
  },
  {
    id: "polished",
    label: "Polished",
    hint: "Smooth it into clear, readable prose",
    directive:
      "Produce clean, readable prose: remove fillers and false starts, fix " +
      "grammar, and lightly rephrase awkward phrasing for clarity. Preserve " +
      "the speaker's meaning, intent and approximate length — do not " +
      "summarize, expand or invent details.",
    sampling: { temperature: 0.4, topP: 1.0, topK: 0, minP: 0.02 },
  },
];

const DEFAULT_STYLE = "clean";

// Sampling values that reproduce "only temperature was ever set" — used as the
// neutral baseline for legacy configs migrated onto the custom style. topP 1,
// topK 0 and minP 0 all mean "no filtering", so nothing but temperature
// reaches the model, exactly as before.
const NEUTRAL_SAMPLING = { topP: 1, topK: 0, minP: 0 };

function styleById(id) {
  return STYLES.find((s) => s.id === id) || STYLES.find((s) => s.id === DEFAULT_STYLE);
}

// Resolve a cleanup config slice into the prompt + sampling actually used.
// custom → the user's raw numbers and their base prompt untouched; otherwise
// the chosen preset's sampling plus its directive appended to the base prompt.
function resolveCleanup(cfg) {
  const base = cfg.systemPrompt || "";
  if (cfg.style === "custom") {
    return { systemPrompt: base, sampling: { ...(cfg.custom || {}) } };
  }
  const style = styleById(cfg.style);
  const systemPrompt = `${base}\n\nEditing style: ${style.directive}`;
  return { systemPrompt, sampling: { ...style.sampling } };
}

// OpenAI-compatible chat body fields. Only the portable knobs go on the wire:
// `temperature` and `top_p` are standard everywhere, but `top_k` / `min_p` are
// non-standard extensions that make strict servers (e.g. OpenAI) 400. So the
// remote path relies on temperature + top_p + the prompt directive (all of
// which work on any server) and leaves top-k / min-p to the built-in engine.
// top_p at its no-op value (>= 1) is omitted so existing remote calls are
// unchanged for anyone who never tuned it.
function remoteSamplingBody(sampling) {
  const body = {};
  if (sampling.temperature != null) body.temperature = sampling.temperature;
  if (sampling.topP != null && sampling.topP < 1) body.top_p = sampling.topP;
  return body;
}

module.exports = {
  STYLES,
  DEFAULT_STYLE,
  NEUTRAL_SAMPLING,
  styleById,
  resolveCleanup,
  remoteSamplingBody,
};
