// Technical dictation against a real cleanup model: does the model write
// spoken code as code, and what does the stumble backstop do to its output?
// The harness behind the technical-dictation numbers in
// docs/cleanup-models.md, and behind which catalog models carry
// `stumbleBackstop: false` (main/engines/registry.js).
//
//   node scripts/eval-technical.mjs --out=<dir> [--id=<label>] [--seeds=17,29,43]
//     [--styles=clean,polished] [--corpus=technical,heldout,prose]
//     [--prompt=<file>] [--gpu] <model.gguf>
//   node scripts/eval-technical.mjs --report <out dir>
//
// Every clean is prompted exactly as the app prompts (the same path as
// scripts/bench-cleanup.mjs): resolveCleanup's prompt, the engine worker's
// user turn, sampling, chat wrapper and generation cap, a 4096-token context,
// CPU (--gpu: the auto-detected GPU, for speed; compare prompts on one
// backend, since a GPU can pick different tokens for the same seed). --prompt swaps in a candidate BASE prompt (a text file); the style
// directive and sampling stay the app's. A maxTokens stop is delivered the way
// the app delivers it — the raw transcript, unstripped.
//
// Each output is scored three ways:
//   - symbols: each `keep` of the corpus item (scripts/dictation-corpus.js),
//     on the model's own output — did it write the spoken code at all?
//   - broke: a `keep` the model's output had and the backstop's output lost;
//   - rescued: a filler or stutter the backstop removed that is not a doubled
//     symbol word.
// The bench's fidelity guards don't apply here: they count a correct
// "dot dot slash" -> "../" as lost words.
//
// Outputs land under --out/<id>/runs.jsonl (never inside the repo). Not in the
// test suite: it needs a multi-GB model.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const { cleanupUserTurn, cleanupSamplingOptions, cleanupChatWrapper } = require("../main/util/cleanup-turn");
const { cleanMaxTokens } = require("../main/util/clean-budget");
const { stripStumbles } = require("../main/util/stumble-strip");
const { TECHNICAL, TECHNICAL_HELDOUT, FLUENT, REPORTED } = require("./dictation-corpus");

const CORPORA = {
  technical: TECHNICAL,
  heldout: TECHNICAL_HELDOUT,
  prose: [{ text: FLUENT.raw, keep: [] }, ...REPORTED.map((text) => ({ text, keep: [] }))],
};

// The words a doubled symbol is spoken as: the same list the backstop exempts.
const SYMBOL_DOUBLE = /\b(dot|dash|hyphen|slash|backslash|equals|underscore|star|asterisk|pipe|ampersand|plus|minus|colon|semicolon|hash|pound|bang|tilde|caret|percent|dollar|backtick)(?: \1\b)+/gi;
const FILLER = /(?<![\p{L}\p{N}_-])(?:u[mh]+|erm+)(?![\p{L}\p{N}_-])/giu;

function parseArgs(argv) {
  const opts = { seeds: [17, 29, 43], styles: ["clean", "polished"], corpora: ["technical", "heldout", "prose"], models: [] };
  for (const a of argv) {
    const [k, v] = a.startsWith("--") ? a.slice(2).split(/=(.*)/s) : [null, null];
    if (k === "out") opts.out = v;
    else if (k === "id") opts.id = v;
    else if (k === "seeds") opts.seeds = v.split(",").map(Number);
    else if (k === "styles") opts.styles = v.split(",");
    else if (k === "corpus") opts.corpora = v.split(",");
    else if (k === "prompt") opts.prompt = fs.readFileSync(v, "utf8");
    else if (k === "report") opts.report = true;
    else if (k === "gpu") opts.gpu = true;
    else if (k) throw new Error(`unknown flag --${k}`);
    else opts.models.push(a);
  }
  for (const c of opts.corpora) if (!CORPORA[c]) throw new Error(`unknown corpus "${c}"`);
  return opts;
}

// What the backstop removed that wasn't a doubled symbol word: hold the
// doublings back and see whether it still changes anything.
function rescued(output) {
  const held = [];
  const masked = output.replace(SYMBOL_DOUBLE, (m) => {
    held.push(m);
    return `Qsym${String.fromCharCode(97 + ((held.length - 1) % 26))}q`;
  });
  return stripStumbles(masked) !== masked;
}

function score(item, output, stopReason) {
  const runaway = stopReason === "maxTokens";
  const delivered = runaway ? item.text : stripStumbles(output);
  const keep = item.keep.map((k) => ({
    name: k.name,
    model: !runaway && k.any.some((re) => re.test(output)),
    delivered: k.any.some((re) => re.test(delivered)),
  }));
  return {
    runaway,
    delivered,
    changed: !runaway && delivered !== output,
    fillers: runaway ? 0 : (output.match(FILLER) || []).length,
    rescued: !runaway && rescued(output),
    keep,
  };
}

async function run(opts) {
  const [modelPath] = opts.models;
  if (!opts.out || opts.models.length !== 1) throw new Error("usage: --out=<dir> <model.gguf>");
  const id = opts.id || path.basename(modelPath, ".gguf");
  const dir = path.join(opts.out, id);
  fs.mkdirSync(dir, { recursive: true });
  const mod = await import("node-llama-cpp");
  const llama = await mod.getLlama(opts.gpu ? {} : { gpu: false });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 4096 });
  const sequence = context.getSequence();
  const session = new mod.LlamaChatSession({ contextSequence: sequence, chatWrapper: cleanupChatWrapper(mod, model) });
  const runsFile = path.join(dir, "runs.jsonl");
  fs.writeFileSync(runsFile, "");
  for (const style of opts.styles) {
    const cfg = { ...DEFAULTS.cleanup, style, ...(opts.prompt ? { systemPrompt: opts.prompt } : {}) };
    const { systemPrompt, sampling } = resolveCleanup(cfg);
    for (const corpus of opts.corpora) {
      for (const [index, item] of CORPORA[corpus].entries()) {
        for (const seed of opts.seeds) {
          session.resetChatHistory();
          await sequence.clearHistory();
          const { responseText, stopReason } = await session.promptWithMeta(cleanupUserTurn(systemPrompt, item.text), {
            ...cleanupSamplingOptions(sampling),
            seed,
            maxTokens: cleanMaxTokens(model.tokenize(item.text).length),
          });
          const output = (responseText || "").trim();
          const s = score(item, output, stopReason);
          fs.appendFileSync(runsFile, JSON.stringify({ id, style, corpus, index, seed, stopReason, output, ...s }) + "\n");
          console.error(`[${id}] ${style}/${corpus}#${index} s${seed}` +
            s.keep.map((k) => ` ${k.name}:${k.model ? (k.delivered ? "ok" : "BROKEN-BY-BACKSTOP") : "MODEL-LOST"}`).join(""));
        }
      }
    }
  }
}

// One row per id/style/corpus: symbols the model wrote, symbols the backstop
// broke, runs it rescued, fillers left in the model's output.
function report(out) {
  console.log("| model | style | corpus | runs | symbols written by the model | broken by backstop | runs rescued by backstop | fillers left (model) |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const id of fs.readdirSync(out).sort()) {
    const file = path.join(out, id, "runs.jsonl");
    if (!fs.existsSync(file)) continue;
    const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.style}|${r.corpus}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    for (const [k, rs] of groups) {
      const [style, corpus] = k.split("|");
      const keeps = rs.flatMap((r) => r.keep);
      const written = keeps.filter((x) => x.model).length;
      const broke = keeps.filter((x) => x.model && !x.delivered).length;
      const resc = rs.filter((r) => r.rescued).length;
      const fill = rs.reduce((n, r) => n + r.fillers, 0);
      console.log(`| ${id} | ${style} | ${corpus} | ${rs.length} | ${keeps.length ? `${written}/${keeps.length}` : "–"} | ${broke} | ${resc} | ${fill} |`);
    }
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.report) report(opts.models[0]);
else await run(opts);
