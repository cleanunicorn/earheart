// A/B the cleanup pipeline against the real model — the harness behind "can
// Gemma remove the fillers on its own, or does it need code?".
//
//   node scripts/eval-cleanup.mjs <model.gguf> [seeds]
//   CORPUS=fluent ARMS=polished/old,polished/new node scripts/eval-cleanup.mjs …
//
// CORPUS picks the SHAPE of dictation (see scripts/dictation-corpus.js), and
// the shape is the whole story:
//
//   short / reported — short, filler-dense fragments. gemma-3-4b-it-Q4_K_M,
//     2 full-length transcripts x 5 seeds: the old Polished directive left 20
//     fillers and 5 repeats (0/10 clean runs); sharpening the directive alone
//     — same sampling — produced 10/10 clean runs. Changing sampling alone did
//     nothing.
//   fluent (default) — one long, mostly fluent dictation with 6 fillers
//     sprinkled through it, reported from production. Same model, 3 seeds:
//     BOTH the old and the sharpened Polished directive returned all 6 fillers,
//     3 runs out of 3, output/input length ratio 1.00. The base prompt's
//     preservation rules put the model in copy mode and one editing directive
//     does not outvote them.
//
// That second shape is why the deterministic backstop (main/util/stumble-strip
// .js, applied in main/services/route.js) exists. So every arm is scored TWICE
// — as the model returned it, and after the backstop — and a directive change
// is only an improvement if it moves the "model" column.
//
// Each arm reproduces production exactly: the prompt assembly from
// main/cleanup-styles.js (base prompt + style directive) and the single-user-
// turn shape from main/engines/engine-worker.js. Only the directive text and
// the sampling profile differ between arms. Not in the test suite: it needs a
// multi-GB model. The shapes themselves are pinned in test/unit.test.js.

import { createRequire } from "node:module";
import { getLlama, LlamaChatSession } from "node-llama-cpp";

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { STYLES } = require("../main/cleanup-styles");
const { stripStumbles } = require("../main/util/stumble-strip");
const { SHORT, REPORTED, FLUENT } = require("./dictation-corpus");

const BASE = DEFAULTS.cleanup.systemPrompt;

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

const ALL_ARMS = [
  { id: "clean/old", directive: OLD_CLEAN, sampling: OLD_CLEAN_S },
  { id: "clean/new", directive: styleDirective("clean"), sampling: styleSampling("clean") },
  { id: "polished/old", directive: OLD_POLISHED, sampling: OLD_POLISHED_S },
  { id: "polished/new", directive: styleDirective("polished"), sampling: styleSampling("polished") },
  // Which lever did the work?
  { id: "polished/prompt-only", directive: styleDirective("polished"), sampling: OLD_POLISHED_S },
  { id: "polished/sampling-only", directive: OLD_POLISHED, sampling: TIGHT_POLISHED_S },
  { id: "polished/tight-sampling", directive: styleDirective("polished"), sampling: TIGHT_POLISHED_S },
];
const ARMS = process.env.ARMS
  ? ALL_ARMS.filter((a) => process.env.ARMS.split(",").includes(a.id))
  : ALL_ARMS;

const CORPORA = { short: SHORT, reported: REPORTED, fluent: [FLUENT.raw] };
const corpusName = process.env.CORPUS || "fluent";
const INPUTS = CORPORA[corpusName];
if (!INPUTS) {
  throw new Error(`CORPUS must be one of ${Object.keys(CORPORA).join(", ")}`);
}

const FILLER = /(?<![\w-])(?:u[mh]+|erm+)(?![\w-])/gi;
const REPEAT =
  /(?<![\p{L}\p{N}'’-])([\p{L}\p{N}][\p{L}\p{N}'’-]*)((?:[^\S\n]+\1)+)(?![\p{L}\p{N}'’-])/giu;
const KEEP_DOUBLED = new Set(["had", "that", "very", "really", "so", "no", "yes"]);

function countFillers(text) {
  return (text.match(FILLER) || []).length;
}
function countRepeats(text) {
  let n = 0;
  text.replace(REPEAT, (m, word, rest) => {
    if (KEEP_DOUBLED.has(word.toLowerCase()) || /\p{N}/u.test(word)) return m;
    const echoes = rest.trim().split(/\s+/);
    if (echoes.every((e) => e === e.toLowerCase() || word === "I")) n++;
    return m;
  });
  return n;
}

function samplingOptions(s) {
  const o = { temperature: s.temperature };
  if (s.topP != null) o.topP = s.topP;
  if (s.topK != null && s.topK > 0) o.topK = s.topK;
  if (s.minP != null && s.minP > 0) o.minP = s.minP;
  return o;
}

const modelPath = process.argv[2];
const seeds = (process.argv[3] || "1").split(",").map(Number);

const llama = await getLlama();
const model = await llama.loadModel({ modelPath });
const context = await model.createContext({ contextSize: 4096 });
// One sequence, one session, reset between turns — exactly what the worker's
// freshSession() does in production.
const session = new LlamaChatSession({ contextSequence: context.getSequence() });
const results = [];

for (const arm of ARMS) {
  const systemPrompt = `${BASE}\n\nEditing style: ${arm.directive}`;
  for (const [i, transcript] of INPUTS.entries()) {
    for (const seed of seeds) {
      session.resetChatHistory();
      const userTurn = `${systemPrompt}\n\nTranscript:\n${transcript}\n\nCleaned transcript:`;
      const out = (
        await session.prompt(userTurn, {
          ...samplingOptions(arm.sampling),
          seed,
          maxTokens: 1024,
        })
      ).trim();
      // What production actually delivers for a tidied style: the model's text
      // through the deterministic backstop.
      const delivered = stripStumbles(out);
      results.push({
        arm: arm.id,
        corpus: corpusName,
        input: i,
        seed,
        fillers: countFillers(out),
        repeats: countRepeats(out),
        deliveredFillers: countFillers(delivered),
        deliveredRepeats: countRepeats(delivered),
        inFillers: countFillers(transcript),
        inRepeats: countRepeats(transcript),
        ratio: out.length / transcript.length,
        out,
        delivered,
      });
      process.stderr.write(".");
    }
  }
  process.stderr.write(`\n${arm.id} done\n`);
}

// Per-arm summary on stderr (the JSON on stdout stays machine-readable): what
// the model left in, and what the user would actually receive.
const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
process.stderr.write(`\ncorpus=${corpusName} seeds=${seeds.join(",")}\n`);
process.stderr.write("arm                        model f/r   delivered f/r   clean runs\n");
for (const arm of ARMS) {
  const rows = results.filter((r) => r.arm === arm.id);
  const clean = rows.filter((r) => r.deliveredFillers === 0 && r.deliveredRepeats === 0).length;
  process.stderr.write(
    `${arm.id.padEnd(26)} ${String(sum(rows, "fillers")).padStart(3)}/${String(sum(rows, "repeats")).padEnd(3)}` +
      `   ${String(sum(rows, "deliveredFillers")).padStart(6)}/${String(sum(rows, "deliveredRepeats")).padEnd(6)}` +
      `  ${clean}/${rows.length}\n`
  );
}

console.log(JSON.stringify(results, null, 1));
