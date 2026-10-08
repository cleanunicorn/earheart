// The arms of the cleanup A/B harness (scripts/eval-cleanup.mjs), kept pure so
// test/cleanup-arms.test.js can pin them without a model. CommonJS, like
// scripts/cleanup-metrics.js, so the ESM harness reaches it through
// createRequire and the tests through require.
//
// An arm is a (directive, sampling) pair; only those two differ between arms,
// the rest of the request is production's. Two arms with equal pairs are the
// same experiment, so the table is deduplicated at build time (the duplicate
// is reported, never silently run) rather than hand-pruned: when
// main/cleanup-styles.js changes, an arm that stopped being redundant comes
// back on its own.

const { STYLES } = require("../main/cleanup-styles");

const styleDirective = (id) => STYLES.find((s) => s.id === id).directive;
const styleSampling = (id) => STYLES.find((s) => s.id === id).sampling;

// The directives as they were before the sharpening, kept so the comparison can
// be re-run against whatever main/cleanup-styles.js says today.
const OLD_CLEAN =
  "Remove filler words (um, uh, you know, like) and false starts. " +
  "Collapse repeated words, restarted phrases and stutters into one clean " +
  "version. Keep the speaker's wording and tone — do not summarize, expand " +
  "or add anything.";
const OLD_POLISHED =
  "Produce clean, readable prose: remove fillers and false starts, fix " +
  "grammar, and lightly rephrase awkward phrasing for clarity. Preserve " +
  "the speaker's meaning, intent and approximate length — do not " +
  "summarize, expand or invent details.";

const OLD_CLEAN_S = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05 };
const OLD_POLISHED_S = { temperature: 0.4, topP: 1.0, topK: 0, minP: 0.02 };
// Tighter sampling, the other candidate lever: unbounded nucleus/top-k was the
// suspicion when "remove the fillers" started getting ignored.
const TIGHT_POLISHED_S = { temperature: 0.3, topP: 0.95, topK: 40, minP: 0.02 };

const RAW_ARMS = [
  { id: "clean/old", directive: OLD_CLEAN, sampling: OLD_CLEAN_S },
  { id: "clean/new", directive: styleDirective("clean"), sampling: styleSampling("clean") },
  { id: "polished/old", directive: OLD_POLISHED, sampling: OLD_POLISHED_S },
  { id: "polished/new", directive: styleDirective("polished"), sampling: styleSampling("polished") },
  // Which lever did the work?
  { id: "polished/prompt-only", directive: styleDirective("polished"), sampling: OLD_POLISHED_S },
  { id: "polished/sampling-only", directive: OLD_POLISHED, sampling: TIGHT_POLISHED_S },
  { id: "polished/tight-sampling", directive: styleDirective("polished"), sampling: TIGHT_POLISHED_S },
];

// Sampling compared by value, whatever order the literal lists its keys in.
const armKey = (arm) => `${arm.directive}\0${JSON.stringify(Object.entries(arm.sampling || {}).sort())}`;

/**
 * Keep the first arm of every (directive, sampling) pair.
 * @returns {{ arms: object[], dropped: { id: string, sameAs: string }[] }}
 */
function dedupeArms(arms) {
  const first = new Map();
  const kept = [];
  const dropped = [];
  for (const arm of arms) {
    const key = armKey(arm);
    const twin = first.get(key);
    if (twin) dropped.push({ id: arm.id, sameAs: twin.id });
    else {
      first.set(key, arm);
      kept.push(arm);
    }
  }
  return { arms: kept, dropped };
}

const { arms: ALL_ARMS, dropped: DROPPED_ARMS } = dedupeArms(RAW_ARMS);

/**
 * The arms an ARMS environment value asks for, in table order. Unset or empty
 * means every arm. An unknown id is an error (a typo must not quietly run a
 * narrower comparison), and so is a selection that leaves nothing to run.
 */
function selectArms(allArms, requested) {
  if (requested === undefined || requested === null || requested === "") return allArms;
  const valid = allArms.map((a) => a.id);
  const wanted = [...new Set(requested.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const id of wanted) {
    if (valid.includes(id)) continue;
    const dropped = DROPPED_ARMS.find((d) => d.id === id);
    const why = dropped ? ` (it is the same as ${dropped.sameAs} with today's styles)` : "";
    throw new Error(`ARMS: unknown arm "${id}"${why}; valid: ${valid.join(", ")}`);
  }
  if (!wanted.length) throw new Error(`ARMS selects no arm; valid: ${valid.join(", ")}`);
  return allArms.filter((a) => wanted.includes(a.id));
}

module.exports = {
  OLD_CLEAN,
  OLD_POLISHED,
  OLD_CLEAN_S,
  OLD_POLISHED_S,
  TIGHT_POLISHED_S,
  RAW_ARMS,
  ALL_ARMS,
  DROPPED_ARMS,
  dedupeArms,
  selectArms,
};
