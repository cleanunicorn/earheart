// A/B the cleanup pipeline against the real model — the harness behind "can
// Gemma remove the fillers on its own, or does it need code?".
//
//   node scripts/eval-cleanup.mjs <model.gguf> [seeds]
//   CORPUS=fluent ARMS=polished/old,polished/new node scripts/eval-cleanup.mjs …
//
// ARMS names a subset of the arms in scripts/cleanup-arms.js; an id that is
// not there is an error (a typo must not quietly run fewer arms).
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
// turn shape the engine worker sends (main/util/cleanup-turn.js). Only the
// directive text and the sampling profile differ between arms. Not in the
// test suite: it needs a multi-GB model. The corpora are shared with the tests
// (FLUENT in test/unit.test.js and test/bench-cleanup.test.js; all three
// shapes in test/cleanup-metrics.test.js).

import { createRequire } from "node:module";
import * as llamaCpp from "node-llama-cpp";
const { getLlama, LlamaChatSession } = llamaCpp;

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { stripStumbles } = require("../main/util/stumble-strip");
const { SHORT, REPORTED, FLUENT } = require("./dictation-corpus");
const { cleanupUserTurn, cleanupSamplingOptions, cleanupChatWrapper } = require("../main/util/cleanup-turn");
// The same filler/repeat counters the model benchmark scores with.
const { countFillers, countRepeats } = require("./cleanup-metrics");

const BASE = DEFAULTS.cleanup.systemPrompt;

// The arms (directive + sampling pairs), deduplicated at build time; a
// duplicate is reported below rather than run twice. ARMS picks a subset by
// id, and a misspelled id is an error, not a quietly narrower run.
const { ALL_ARMS, DROPPED_ARMS, selectArms } = require("./cleanup-arms");
const ARMS = selectArms(ALL_ARMS, process.env.ARMS);
for (const d of DROPPED_ARMS) {
  process.stderr.write(`arm ${d.id} not run: same directive and sampling as ${d.sameAs} with today's styles\n`);
}

const CORPORA = { short: SHORT, reported: REPORTED, fluent: [FLUENT.raw] };
const corpusName = process.env.CORPUS || "fluent";
const INPUTS = CORPORA[corpusName];
if (!INPUTS) {
  throw new Error(`CORPUS must be one of ${Object.keys(CORPORA).join(", ")}`);
}

const modelPath = process.argv[2];
const seeds = (process.argv[3] || "1").split(",").map(Number);

const llama = await getLlama();
const model = await llama.loadModel({ modelPath });
const context = await model.createContext({ contextSize: 4096 });
// One sequence, one session, reset between turns — exactly what the worker's
// freshSession() does in production.
const session = new LlamaChatSession({
  contextSequence: context.getSequence(),
  chatWrapper: cleanupChatWrapper(llamaCpp, model),
});
const results = [];

for (const arm of ARMS) {
  const systemPrompt = `${BASE}\n\nEditing style: ${arm.directive}`;
  for (const [i, transcript] of INPUTS.entries()) {
    for (const seed of seeds) {
      session.resetChatHistory();
      const userTurn = cleanupUserTurn(systemPrompt, transcript);
      const out = (
        await session.prompt(userTurn, {
          ...cleanupSamplingOptions(arm.sampling),
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
