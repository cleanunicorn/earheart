// Benchmark cleanup MODELS against each other — the harness behind "which
// locally-runnable cleanup model should Earheart ship?". scripts/eval-cleanup
// .mjs A/Bs prompt directives on one model; this holds the prompt fixed at
// what ships and varies the model. Survey and recorded numbers:
// docs/cleanup-models.md.
//
//   node scripts/bench-cleanup.mjs --out=<dir> [--id=<label>] \
//     [--seeds=17,29,43,61,79] [--corpus=fluent,reported[,short]] [--gpu] \
//     <model.gguf>
//   node scripts/bench-cleanup.mjs --probe <owner/repo> <file.gguf>
//
// Every clean is prompted exactly as the app prompts: the default config's
// base prompt + style directive through resolveCleanup (main/cleanup-styles
// .js), the single user turn and sampling mapping the engine worker uses
// (main/util/cleanup-turn.js), a 4096-token context, and the worker's
// generation cap (cleanMaxTokens). A maxTokens stop is scored the way the app
// delivers it — the raw transcript — never as the looping text.
//
// Matrix: FLUENT under the shipped default style ("clean") and under
// "polished" (where FLUENT's copy-mode failure was first measured, see
// scripts/dictation-corpus.js), REPORTED and (opt-in) SHORT under "clean";
// the same seeds for every model, so runs pair up. FLUENT cannot be left out:
// it is the shape that fails.
//
// Speed is CPU by default — getLlama({ gpu: false }) and no thread override,
// the app's own CPU path in main/engines/engine-worker.js — and the threads
// node-llama-cpp resolved are printed with the hardware. --gpu re-runs
// FLUENT/clean on the auto-detected GPU for a footnote; the catalog bar never
// reads it. Before each timed clean the chat history AND the context's token
// history are cleared, so a repeated seed can't reuse the previous run's KV
// cache: every clean pays full prefill (the app's prime-cleanup can hide the
// prompt's share of it, so these are upper bounds, equal for every model).
//
// Everything lands under --out/<id>/ (never inside the repo): manifest.json,
// runs.jsonl, summary.json, and raw/<corpus>-<style>-<input>-s<seed>.txt for
// every output, for spot checks. stdout gets the model's markdown table row.
// --probe prints one survey row from Hugging Face (architecture, template,
// licence, gating, pinned commit, sha256, bytes) without downloading weights.
// Not in the test suite: it needs multi-GB models. The scoring is pinned in
// test/cleanup-metrics.test.js.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const { cleanupUserTurn, cleanupSamplingOptions } = require("../main/util/cleanup-turn");
const { cleanMaxTokens, cleanContextNeed } = require("../main/util/clean-budget");
const { SHORT, REPORTED, FLUENT } = require("./dictation-corpus");
const metrics = require("./cleanup-metrics");

const CONTEXT_SIZE = 4096;
const DEFAULT_SEEDS = [17, 29, 43, 61, 79];
const CORPORA = { fluent: [FLUENT.raw], reported: REPORTED, short: SHORT };

function usage(msg) {
  if (msg) console.error(`bench-cleanup: ${msg}`);
  console.error(
    "usage: node scripts/bench-cleanup.mjs --out=<dir> [--id=<label>] [--seeds=17,29,43,61,79]\n" +
      "         [--corpus=fluent,reported[,short]] [--gpu] <model.gguf>\n" +
      "       node scripts/bench-cleanup.mjs --probe <owner/repo> <file.gguf>"
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { seeds: DEFAULT_SEEDS, corpora: ["fluent", "reported"], gpu: false, models: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.startsWith("--") ? a.slice(2).split(/=(.*)/s) : [null, null];
    if (k === "probe") opts.probe = { repo: argv[++i], file: argv[++i] };
    else if (k === "out") opts.out = v;
    else if (k === "id") opts.id = v;
    else if (k === "gpu") opts.gpu = true;
    else if (k === "seeds") opts.seeds = v.split(",").map(Number);
    else if (k === "corpus") opts.corpora = v.split(",").filter(Boolean);
    else if (k) usage(`unknown flag --${k}`);
    else opts.models.push(a);
  }
  if (opts.probe) {
    if (!opts.probe.repo || !opts.probe.file) usage("--probe needs <owner/repo> <file.gguf>");
    return opts;
  }
  if (!opts.out) usage("--out=<dir> is required (outputs never go in the repo)");
  if (opts.models.length !== 1) usage("give exactly one model path (one model per process)");
  if (!opts.corpora.includes("fluent")) usage("--corpus must include fluent (the shape that fails)");
  for (const c of opts.corpora) if (!CORPORA[c]) usage(`unknown corpus "${c}"`);
  if (opts.seeds.some((s) => !Number.isInteger(s))) usage("--seeds takes integers");
  for (const m of opts.models) if (!fs.existsSync(m)) usage(`no such file: ${m}`);
  return opts;
}

async function probe({ repo, file }) {
  const base = `https://huggingface.co/api/models/${repo}`;
  const res = await fetch(`${base}?expand[]=gguf&expand[]=cardData&expand[]=gated`);
  if (!res.ok) throw new Error(`HF API ${res.status} for ${repo}`);
  const api = await res.json();
  // The 302 from resolve/main carries the pin headers the registry uses.
  const head = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, {
    method: "HEAD",
    redirect: "manual",
  });
  const row = metrics.summarizeProbe(api, head.headers, file);
  console.log(JSON.stringify({ repo, file, status: head.status, ...row }, null, 2));
}

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(8 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest("hex");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// The runs one model gets: FLUENT under clean + polished, the rest under clean.
function plan(opts) {
  const turns = [];
  for (const corpus of opts.corpora) {
    const styles = corpus === "fluent" && !opts.gpu ? ["clean", "polished"] : ["clean"];
    if (opts.gpu && corpus !== "fluent") continue;
    for (const style of styles) {
      const { systemPrompt, sampling } = resolveCleanup({ ...DEFAULTS.cleanup, style });
      CORPORA[corpus].forEach((input, index) => {
        for (const seed of opts.seeds) turns.push({ corpus, style, index, seed, input, systemPrompt, sampling });
      });
    }
  }
  return turns;
}

async function benchModel(modelPath, opts, mod) {
  const id = opts.id || path.basename(modelPath, ".gguf");
  const dir = path.join(opts.out, opts.gpu ? `${id}-gpu` : id);
  fs.mkdirSync(path.join(dir, "raw"), { recursive: true });
  const log = (m) => console.error(`[${id}] ${m}`);

  const bytes = fs.statSync(modelPath).size;
  log(`hashing ${bytes} bytes`);
  const sha256 = sha256File(modelPath);

  const tInit = performance.now();
  const llama = await mod.getLlama(opts.gpu ? {} : { gpu: false });
  const backendMs = performance.now() - tInit;
  const tLoad = performance.now();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: CONTEXT_SIZE });
  const loadMs = performance.now() - tLoad;
  const sequence = context.getSequence();
  const session = new mod.LlamaChatSession({ contextSequence: sequence });

  const manifest = {
    id,
    file: path.basename(modelPath),
    bytes,
    sha256,
    backend: llama.gpu || "cpu",
    contextSize: CONTEXT_SIZE,
    threads: {
      cpuMathCores: llama.cpuMathCores,
      maxThreads: llama.maxThreads,
      idealThreads: context.idealThreads,
      currentThreads: context.currentThreads,
    },
    chatWrapper: session.chatWrapper.constructor.name,
    hardware: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      ramGB: Math.round(os.totalmem() / 2 ** 30),
      os: `${os.type()} ${os.release()}`,
    },
    seeds: opts.seeds,
    corpora: opts.corpora,
    backendMs: Math.round(backendMs),
    loadMs: Math.round(loadMs),
    gitCommit: gitCommit(),
    startedAt: new Date().toISOString(),
  };
  log(`loaded in ${manifest.loadMs} ms · backend ${manifest.backend} · wrapper ${manifest.chatWrapper} · threads ${JSON.stringify(manifest.threads)}`);

  // One clean, timed from the prompt call to its result, after clearing every
  // trace of the previous one (untimed) so no run reuses another's KV cache.
  async function clean(t) {
    session.resetChatHistory();
    await sequence.clearHistory();
    const userTurn = cleanupUserTurn(t.systemPrompt, t.input);
    const need = cleanContextNeed(model.tokenize(userTurn).length, model.tokenize(t.input).length);
    if (need > CONTEXT_SIZE) throw new Error(`turn needs ${need} tokens > context ${CONTEXT_SIZE}`);
    let genTokens = 0;
    let firstMs = null;
    let lastMs = null;
    const t0 = performance.now();
    const { responseText, stopReason } = await session.promptWithMeta(userTurn, {
      ...cleanupSamplingOptions(t.sampling),
      seed: t.seed,
      maxTokens: cleanMaxTokens(model.tokenize(t.input).length),
      onToken: (tokens) => {
        const now = performance.now() - t0;
        if (firstMs === null) firstMs = now;
        lastMs = now;
        genTokens += tokens.length;
      },
    });
    const wallMs = performance.now() - t0;
    return { output: (responseText || "").trim(), stopReason, wallMs, firstMs, lastMs, genTokens };
  }

  const turns = plan(opts);
  log(`warm-up, then ${turns.length} timed cleans`);
  await clean(turns[0]);

  const runsFile = path.join(dir, "runs.jsonl");
  fs.writeFileSync(runsFile, "");
  const runs = [];
  for (const [n, t] of turns.entries()) {
    const r = await clean(t);
    const score = metrics.scoreOutput({
      input: t.input,
      output: r.output,
      stopReason: r.stopReason,
      systemPrompt: t.systemPrompt,
      corpus: t.corpus,
    });
    const row = {
      corpus: t.corpus,
      style: t.style,
      index: t.index,
      seed: t.seed,
      stopReason: r.stopReason,
      wallMs: Math.round(r.wallMs),
      ttftMs: r.firstMs === null ? null : Math.round(r.firstMs),
      genTokens: r.genTokens,
      decodeTps: metrics.decodeTokensPerSecond(r.genTokens, r.firstMs, r.lastMs),
      score: { ...score, delivered: undefined },
    };
    runs.push(row);
    fs.appendFileSync(runsFile, JSON.stringify(row) + "\n");
    fs.writeFileSync(path.join(dir, "raw", `${t.corpus}-${t.style}-${t.index}-s${t.seed}.txt`), r.output + "\n");
    log(
      `${n + 1}/${turns.length} ${t.corpus}/${t.style}#${t.index} s${t.seed}: ${row.wallMs} ms, ` +
        `${row.genTokens} tok, fillers ${score.fillers} repeats ${score.repeats}` +
        `${score.fidelityOk ? "" : " FIDELITY-FAIL"}${r.stopReason === "maxTokens" ? " RUNAWAY" : ""}`
    );
  }

  const summary = metrics.summarizeRuns(runs);
  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ manifest, summary }, null, 2) + "\n");

  return { manifest, summary };
}

const fmt = (x, d = 0) => (x === null || x === undefined ? "–" : Number(x).toFixed(d));

function markdownRow({ manifest: m, summary }) {
  const c = summary["fluent/clean"];
  const p = summary["fluent/polished"];
  const w = c.wallMs;
  return (
    `| ${m.id} | ${m.backend} | ${c.fillers}/${c.repeats} | ${p ? `${p.fillers}/${p.repeats}` : "–"} | ` +
    `${c.deliveredFillers}/${c.deliveredRepeats} | ${c.cleanRuns}/${c.n} | ${c.fidelityFails} | ` +
    `${fmt(c.medianRatio, 2)} | ${fmt(c.medianRetention, 2)} | ${fmt(w.median)} [${fmt(w.min)}–${fmt(w.max)}] | ` +
    `${fmt(c.ttftMs)} | ${fmt(c.decodeTps, 1)} | ${m.loadMs} | ${(m.bytes / 1e9).toFixed(2)} GB |`
  );
}

const opts = parseArgs(process.argv.slice(2));
if (opts.probe) {
  await probe(opts.probe);
} else {
  const mod = await import("node-llama-cpp");
  console.log(
    "| model | backend | FLUENT clean fillers/repeats (model) | FLUENT polished fillers/repeats | delivered fillers/repeats | clean runs | fidelity fails | ratio | retention | wall ms median [min–max] | TTFT ms | decode tok/s | load ms | size |\n" +
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  console.log(markdownRow(await benchModel(opts.models[0], opts, mod)));
  // Exit without tearing the native backend down: disposing it segfaults
  // node-llama-cpp 3.18.1 here (exit 139), after every file is written. One
  // model per process also keeps each model's timings free of the last one's
  // memory.
  process.exit(0);
}
