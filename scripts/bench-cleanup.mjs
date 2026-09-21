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
//   node scripts/bench-cleanup.mjs --rescore <out dir>
//   node scripts/bench-cleanup.mjs --report <out dir> [--licences=<id>=<licence>,…]
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
// --rescore re-scores every saved run under an --out directory from its raw
// outputs with the current scoring (timings kept), so a scoring fix reaches
// every model alike. --report reads every summary under an --out directory and prints the
// results table, each candidate against its byte-nearest shipped Gemma through
// the catalog bar (meetsBar in scripts/cleanup-metrics.js), and the GPU
// footnote — the tables in docs/cleanup-models.md and the PR. Re-measured
// speed passes join through --also=<dir> or, for passes taken while holding a
// cross-run CPU lock, --locked=<dir>; each pass is labelled by its load.
// Benchmark runs are not in the test suite: they need multi-GB models. The
// scoring is pinned in test/cleanup-metrics.test.js, and the argument handling,
// run matrix and report tables in test/bench-cleanup.test.js.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const { cleanupUserTurn, cleanupSamplingOptions } = require("../main/util/cleanup-turn");
const { cleanMaxTokens, cleanContextNeed } = require("../main/util/clean-budget");
const { SHORT, REPORTED, FLUENT } = require("./dictation-corpus");
const metrics = require("./cleanup-metrics");
const { isPathSegment } = require("../main/engines/registry");

const CONTEXT_SIZE = 4096;
const DEFAULT_SEEDS = [17, 29, 43, 61, 79];
const CORPORA = { fluent: [FLUENT.raw], reported: REPORTED, short: SHORT };

const USAGE =
  "usage: node scripts/bench-cleanup.mjs --out=<dir> [--id=<label>] [--seeds=17,29,43,61,79]\n" +
  "         [--corpus=fluent,reported[,short]] [--gpu] <model.gguf>\n" +
  "       node scripts/bench-cleanup.mjs --probe <owner/repo> <file.gguf>\n" +
  "       node scripts/bench-cleanup.mjs --rescore <out dir>\n" +
  "       node scripts/bench-cleanup.mjs --report <out dir> [--licences=<id>=<licence>,...]\n" +
  "         [--baselines=gemma-3-1b,gemma-3-4b,gemma-3-12b] [--also=<out dir>]... [--locked=<out dir>]...";

// A bad command line. Thrown rather than exiting so the argument handling can
// be tested; the CLI below prints it with the usage text and exits 2.
class UsageError extends Error {}

function usage(msg) {
  throw new UsageError(msg);
}

function parseArgs(argv) {
  const opts = {
    seeds: DEFAULT_SEEDS,
    corpora: ["fluent", "reported"],
    gpu: false,
    models: [],
    licences: {},
    baselines: ["gemma-3-1b", "gemma-3-4b", "gemma-3-12b"],
    also: [],
    locked: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.startsWith("--") ? a.slice(2).split(/=(.*)/s) : [null, null];
    if (k === "probe") opts.probe = { repo: argv[++i], file: argv[++i] };
    else if (k === "report") opts.report = argv[++i];
    else if (k === "rescore") opts.rescore = argv[++i];
    else if (k === "licences") opts.licences = Object.fromEntries(v.split(",").map((kv) => kv.split("=")));
    else if (k === "baselines") opts.baselines = v.split(",");
    else if (k === "also") opts.also.push(v);
    else if (k === "locked") opts.locked.push(v);
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
  if (opts.rescore !== undefined) {
    if (!opts.rescore || !fs.existsSync(opts.rescore)) usage("--rescore needs the --out directory of earlier runs");
    return opts;
  }
  if (opts.report !== undefined) {
    if (!opts.report || !fs.existsSync(opts.report)) usage("--report needs the --out directory of earlier runs");
    for (const d of [...opts.also, ...opts.locked]) if (!fs.existsSync(d)) usage(`no such directory: ${d}`);
    return opts;
  }
  if (!opts.out) usage("--out=<dir> is required (outputs never go in the repo)");
  if (opts.models.length !== 1) usage("give exactly one model path (one model per process)");
  if (!opts.corpora.includes("fluent")) usage("--corpus must include fluent (the shape that fails)");
  for (const c of opts.corpora) if (!CORPORA[c]) usage(`unknown corpus "${c}"`);
  if (opts.seeds.some((s) => !Number.isInteger(s))) usage("--seeds takes integers");
  for (const m of opts.models) if (!fs.existsSync(m)) usage(`no such file: ${m}`);
  // The id names this run's directory under --out; one plain path segment
  // (the registry's rule for model ids), so "../x" can't write outside --out.
  const id = opts.id ?? path.basename(opts.models[0], ".gguf");
  if (!isPathSegment(id)) usage(`--id must be one plain path segment, got ${JSON.stringify(id)}`);
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
    loadAvgAtStart: os.loadavg().map((x) => Number(x.toFixed(2))),
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
    let firstBatch = 0;
    let firstMs = null;
    let lastMs = null;
    const t0 = performance.now();
    const { responseText, stopReason } = await session.promptWithMeta(userTurn, {
      ...cleanupSamplingOptions(t.sampling),
      seed: t.seed,
      maxTokens: cleanMaxTokens(model.tokenize(t.input).length),
      onToken: (tokens) => {
        const now = performance.now() - t0;
        if (firstMs === null) {
          firstMs = now;
          firstBatch = tokens.length;
        }
        lastMs = now;
        genTokens += tokens.length;
      },
    });
    const wallMs = performance.now() - t0;
    return { output: (responseText || "").trim(), stopReason, wallMs, firstMs, lastMs, genTokens, firstBatch };
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
      firstBatch: r.firstBatch,
      decodeTps: metrics.decodeTokensPerSecond(r.genTokens, r.firstMs, r.lastMs, r.firstBatch),
      // The machine may be shared: record how busy it was, next to the time.
      loadAvg1: Number(os.loadavg()[0].toFixed(2)),
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
  manifest.loadAvgAtEnd = os.loadavg().map((x) => Number(x.toFixed(2)));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ manifest, summary }, null, 2) + "\n");

  return { manifest, summary };
}

const fmt = (x, d = 0) => (x === null || x === undefined ? "–" : Number(x).toFixed(d));

const TABLE_HEAD =
  "| model | FLUENT clean: fillers/repeats/other fillers (model) | clean runs | FLUENT polished: fillers/repeats/other | delivered after backstop (clean): fillers/repeats/other | fidelity fails clean/polished | ratio | retention | novel | echo/refusal/runaway | REPORTED: stumbles · fidelity fails | CPU wall ms median [min–max] | load avg | TTFT ms | decode tok/s | load ms | size | chat wrapper |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

function markdownRow({ manifest: m, summary }) {
  const c = summary["fluent/clean"];
  const p = summary["fluent/polished"];
  const r = summary["reported/clean"];
  const w = c.wallMs;
  const flags = (x) => `${x.echo}/${x.refusal}/${x.runaway}`;
  return (
    `| ${m.id} | ${c.fillers}/${c.repeats}/${c.markers ?? 0} | ${c.cleanRuns}/${c.n} | ` +
    `${p ? `${p.fillers}/${p.repeats}/${p.markers ?? 0}` : "–"} | ` +
    `${c.deliveredFillers}/${c.deliveredRepeats}/${c.deliveredMarkers ?? 0} | ${c.fidelityFails}/${p ? p.fidelityFails : "–"} | ` +
    `${fmt(c.medianRatio, 2)} | ${fmt(c.medianRetention, 2)} | ${fmt(c.medianNovel, 2)} | ${flags(c)}${p ? ` · ${flags(p)}` : ""} | ` +
    `${r ? `${r.stumbles} · ${r.fidelityFails}` : "–"} | ${fmt(w.median)} [${fmt(w.min)}–${fmt(w.max)}] | ${fmt(c.loadAvg1, 1)} | ` +
    `${fmt(c.ttftMs)} | ${fmt(c.decodeTps, 1)} | ${m.loadMs} | ${(m.bytes / 1e9).toFixed(2)} GB | ${m.chatWrapper} |`
  );
}

// Every earlier run under one --out directory: the results table, each
// candidate against its byte-nearest shipped Gemma through the catalog bar,
// and the GPU footnote. Licences come from --licences (the harness can't read
// them from a GGUF); the shipped Gemmas are "gemma".
//
// Speed can be re-measured: --also=<dir> adds more passes, --locked=<dir>
// passes taken while holding a cross-run CPU lock (nothing else heavy running).
// Every pass is labelled by its load (classifyPass); the bar's speed criterion
// uses each model's least-contended pass, and the table also shows whether the
// verdict survives the fastest clean of every pass (speedEstimates).
// The files a benchmark run leaves under --out/<id>/.
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Re-score every saved run under an --out directory from its raw outputs with
// the current scoring, keeping its timings and manifest. Scoring changes after
// a benchmark (a new guard, a counter fix) are then applied to every model
// alike, and the tables regenerate from the same raw text.
function rescore(dir) {
  let models = 0;
  let runs = 0;
  for (const d of fs.readdirSync(dir).map((x) => path.join(dir, x))) {
    const runsFile = path.join(d, "runs.jsonl");
    const summaryFile = path.join(d, "summary.json");
    if (!fs.existsSync(runsFile) || !fs.existsSync(summaryFile)) continue;
    const rows = readJsonl(runsFile);
    for (const row of rows) {
      const raw = path.join(d, "raw", `${row.corpus}-${row.style}-${row.index}-s${row.seed}.txt`);
      const { systemPrompt } = resolveCleanup({ ...DEFAULTS.cleanup, style: row.style });
      const score = metrics.scoreOutput({
        input: CORPORA[row.corpus][row.index],
        output: fs.readFileSync(raw, "utf8"),
        stopReason: row.stopReason,
        systemPrompt,
        corpus: row.corpus,
      });
      row.score = { ...score, delivered: undefined };
      runs++;
    }
    const { manifest } = readJson(summaryFile);
    manifest.rescoredAt = new Date().toISOString();
    fs.writeFileSync(runsFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(summaryFile, JSON.stringify({ manifest, summary: metrics.summarizeRuns(rows) }, null, 2) + "\n");
    models++;
  }
  return { models, runs };
}

function readRuns(dir) {
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter((d) => fs.existsSync(path.join(d, "summary.json")))
    .map((d) => {
      const r = readJson(path.join(d, "summary.json"));
      const runs = readJsonl(path.join(d, "runs.jsonl"));
      return { ...r, runLoads: runs.map((x) => x.loadAvg1) };
    });
}

// Every CPU pass per model id — the first pass, then --also, then --locked —
// with its load label and FLUENT/clean wall-clock.
function collectPasses(cpu, opts) {
  const sources = [
    { label: "first pass", locked: false, runs: cpu },
    ...opts.also.map((d) => ({ label: `re-run (${path.basename(d)})`, locked: false, runs: readRuns(d) })),
    ...opts.locked.map((d, i) => ({
      label: opts.locked.length > 1 ? `locked re-run ${i + 1}` : "locked re-run",
      locked: true,
      runs: readRuns(d),
    })),
  ];
  const passes = {};
  for (const src of sources) {
    for (const r of src.runs) {
      if (r.manifest.backend !== "cpu") continue;
      const w = r.summary["fluent/clean"].wallMs;
      const load = metrics.classifyPass({ ...r.manifest, runLoads: r.runLoads });
      (passes[r.manifest.id] ||= []).push({
        label: src.label,
        locked: src.locked,
        maxLoad: load.maxLoad,
        load,
        start: r.manifest.loadAvgAtStart?.[0],
        end: r.manifest.loadAvgAtEnd?.[0],
        wallMedian: w.median,
        wallMin: w.min,
        wallMax: w.max,
      });
    }
  }
  return passes;
}

function passesTable(cpu, passes) {
  const out = [
    "| model | pass | 1-min load: start · peak · end | load label | FLUENT/clean wall ms median [min–max] |",
    "|---|---|---|---|---|",
  ];
  for (const r of cpu) {
    for (const p of passes[r.manifest.id]) {
      const label = !p.load.recorded ? "load not recorded" : p.load.contended ? "contended" : "quiet";
      out.push(
        `| ${r.manifest.id} | ${p.label} | ${fmt(p.start, 1)} · ${fmt(p.maxLoad, 1)} · ${fmt(p.end, 1)} | ${label} | ` +
          `${fmt(p.wallMedian)} [${fmt(p.wallMin)}–${fmt(p.wallMax)}] |`
      );
    }
  }
  return out;
}

// Each candidate against its byte-nearest shipped Gemma through the catalog bar.
function verdictTable(cpu, passes, opts) {
  const gemmas = cpu.filter((r) => opts.baselines.includes(r.manifest.id));
  const licence = (id) => (opts.baselines.includes(id) ? "gemma" : opts.licences[id] || "unknown");
  const speed = (id) => metrics.speedEstimates(passes[id]);
  const yn = (b) => (b ? "yes" : "no");
  const out = [
    "| candidate | vs | licence | quality (clean, strictly fewer) | polished (no more) | fidelity | speed: least-contended median ≤ | speed: min of all passes ≤ | adds to catalog |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of cpu) {
    if (opts.baselines.includes(r.manifest.id) || gemmas.length === 0) continue;
    const g = metrics.nearestComparator(
      r.manifest.bytes,
      gemmas.map((x) => ({ id: x.manifest.id, bytes: x.manifest.bytes, run: x }))
    ).run;
    const cs = speed(r.manifest.id);
    const gs = speed(g.manifest.id);
    // The bar reads wall-clock from the summary: hand it the least-contended pass.
    const withSpeed = (x, sp) => ({
      ...x.summary,
      "fluent/clean": { ...x.summary["fluent/clean"], wallMs: { ...x.summary["fluent/clean"].wallMs, median: sp.median } },
    });
    const bar = metrics.meetsBar(
      { licence: licence(r.manifest.id), summary: withSpeed(r, cs) },
      { licence: "gemma", summary: withSpeed(g, gs) }
    );
    const robust = cs.min <= gs.min;
    const c = r.summary["fluent/clean"];
    const gc = g.summary["fluent/clean"];
    out.push(
      `| ${r.manifest.id} | ${g.manifest.id} | ${licence(r.manifest.id)} ${bar.licence ? "✓" : "✗"} | ` +
        `${yn(bar.quality)} (${c.stumbles} vs ${gc.stumbles}) | ${yn(bar.polished)} | ` +
        `${yn(bar.fidelity)} (fails ${c.fidelityFails}/${r.summary["fluent/polished"]?.fidelityFails ?? "–"}, ` +
        `retention ${fmt(c.medianRetention, 2)} vs ${fmt(gc.medianRetention, 2)}) | ` +
        `${yn(bar.speed)} (${fmt(cs.median)} [${cs.from}] vs ${fmt(gs.median)} [${gs.from}]) | ` +
        `${yn(robust)} (${fmt(cs.min)} vs ${fmt(gs.min)}) | **${yn(bar.pass)}**${bar.pass && !robust ? " (not robust)" : ""} |`
    );
  }
  return out;
}

function gpuFootnote(gpu) {
  const out = [
    "| GPU footnote (FLUENT/clean) | backend | wall ms median [min–max] | decode tok/s | fillers/repeats | fidelity fails |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of gpu) {
    const c = r.summary["fluent/clean"];
    out.push(
      `| ${r.manifest.id} | ${r.manifest.backend} | ${fmt(c.wallMs.median)} [${fmt(c.wallMs.min)}–${fmt(c.wallMs.max)}] | ` +
        `${fmt(c.decodeTps, 1)} | ${c.fillers}/${c.repeats} | ${c.fidelityFails}/${c.n} |`
    );
  }
  return out;
}

function hardwareLine(t) {
  return (
    `Hardware: ${t.hardware.cpu} (${t.hardware.logicalCpus} logical CPUs), ${t.hardware.ramGB} GB RAM, ${t.hardware.os}; ` +
    `CPU backend, node-llama-cpp threads ideal/current ${t.threads.idealThreads}/${t.threads.currentThreads}; ` +
    `seeds ${t.seeds.join(",")}.`
  );
}

function report(opts) {
  const all = readRuns(opts.report);
  const cpu = all.filter((r) => r.manifest.backend === "cpu").sort((a, b) => a.manifest.bytes - b.manifest.bytes);
  const gpu = all.filter((r) => r.manifest.backend !== "cpu").sort((a, b) => a.manifest.bytes - b.manifest.bytes);
  const passes = collectPasses(cpu, opts);
  const out = [TABLE_HEAD, ...cpu.map(markdownRow), "", ...passesTable(cpu, passes), "", ...verdictTable(cpu, passes, opts)];
  if (gpu.length) out.push("", ...gpuFootnote(gpu));
  if (cpu[0]) out.push("", hardwareLine(cpu[0].manifest));
  return out.join("\n");
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`bench-cleanup: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.probe) {
    await probe(opts.probe);
  } else if (opts.rescore) {
    const n = rescore(opts.rescore);
    console.log(`re-scored ${n.runs} runs of ${n.models} models under ${opts.rescore}`);
  } else if (opts.report) {
    console.log(report(opts));
  } else {
    const mod = await import("node-llama-cpp");
    console.log(TABLE_HEAD);
    console.log(markdownRow(await benchModel(opts.models[0], opts, mod)));
    // Exit without tearing the native backend down: disposing it segfaults
    // node-llama-cpp 3.18.1 here (exit 139), after every file is written. One
    // model per process also keeps each model's timings free of the last one's
    // memory.
    process.exit(0);
  }
}

// Run as a command; imported (by test/bench-cleanup.test.js) it only exports
// its parts — benchModel takes the node-llama-cpp module as an argument, so a
// test can hand it a fake one.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

export { UsageError, parseArgs, plan, benchModel, markdownRow, report, rescore };
