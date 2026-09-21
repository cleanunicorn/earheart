// Tests for the cleanup benchmark's model-free parts (scripts/bench-cleanup.mjs):
// argument handling, the run matrix, and the report that turns saved runs into
// the tables in docs/cleanup-models.md and the catalog verdicts.
//
// The benchmark runs themselves need multi-GB models and stay out of the suite;
// these pin what decides which runs happen and how their numbers are read —
// FLUENT can't be dropped, the GPU pass never feeds the bar, a locked re-run
// wins over a contended one, and an unknown licence never reaches the catalog.

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const metrics = require("../scripts/cleanup-metrics");
const { FLUENT } = require("../scripts/dictation-corpus");
const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");

const load = () => import("../scripts/bench-cleanup.mjs");

const made = [];
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cleanup-test-"));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test("parseArgs: measure mode defaults and validation", async () => {
  const { parseArgs, UsageError } = await load();
  const dir = tmpdir();
  const model = path.join(dir, "m.gguf");
  fs.writeFileSync(model, "");

  const opts = parseArgs([`--out=${dir}`, model]);
  assert.deepStrictEqual(opts.seeds, [17, 29, 43, 61, 79]);
  assert.deepStrictEqual(opts.corpora, ["fluent", "reported"]);
  assert.strictEqual(opts.gpu, false);
  assert.deepStrictEqual(opts.models, [model]);

  const bad = [
    [model], // no --out
    [`--out=${dir}`], // no model
    [`--out=${dir}`, model, model], // one model per process
    [`--out=${dir}`, "--corpus=short", model], // FLUENT is mandatory
    [`--out=${dir}`, "--corpus=fluent,nope", model],
    [`--out=${dir}`, "--seeds=1,x", model],
    [`--out=${dir}`, path.join(dir, "missing.gguf")],
    ["--bogus", model],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
});

test("parseArgs: the run id must stay one path segment under --out", async () => {
  const { parseArgs, UsageError } = await load();
  const dir = tmpdir();
  const model = path.join(dir, "m.gguf");
  fs.writeFileSync(model, "");
  assert.strictEqual(parseArgs([`--out=${dir}`, "--id=gemma-3-4b", model]).id, "gemma-3-4b");
  for (const id of ["../outside", "a/b", "a\\b", "/abs", ".", "..", "", "con", "trailing."]) {
    assert.throws(() => parseArgs([`--out=${dir}`, `--id=${id}`, model]), UsageError, id);
  }
  // A model file whose own name isn't a safe id needs an explicit --id.
  const odd = path.join(dir, "con.gguf");
  fs.writeFileSync(odd, "");
  assert.throws(() => parseArgs([`--out=${dir}`, odd]), UsageError);
  assert.strictEqual(parseArgs([`--out=${dir}`, "--id=ok", odd]).id, "ok");
});

test("parseArgs: probe and report modes", async () => {
  const { parseArgs, UsageError } = await load();
  const dir = tmpdir();
  assert.deepStrictEqual(parseArgs(["--probe", "o/r", "f.gguf"]).probe, { repo: "o/r", file: "f.gguf" });
  assert.throws(() => parseArgs(["--probe", "o/r"]), UsageError);

  const r = parseArgs(["--report", dir, `--also=${dir}`, `--locked=${dir}`, "--licences=a=mit,b=lfm1.0"]);
  assert.deepStrictEqual(r.licences, { a: "mit", b: "lfm1.0" });
  assert.deepStrictEqual(r.also, [dir]);
  assert.deepStrictEqual(r.locked, [dir]);
  assert.throws(() => parseArgs(["--report", path.join(dir, "nope")]), UsageError);
  assert.throws(() => parseArgs(["--report", dir, `--locked=${path.join(dir, "nope")}`]), UsageError);
});

test("plan: FLUENT under clean + polished, REPORTED under clean, every seed", async () => {
  const { plan } = await load();
  const turns = plan({ corpora: ["fluent", "reported"], seeds: [1, 2], gpu: false });
  const key = (t) => `${t.corpus}/${t.style}#${t.index}`;
  const counts = {};
  for (const t of turns) counts[key(t)] = (counts[key(t)] || 0) + 1;
  assert.deepStrictEqual(counts, {
    "fluent/clean#0": 2,
    "fluent/polished#0": 2,
    "reported/clean#0": 2,
    "reported/clean#1": 2,
  });
  // The prompt is the app's own, through resolveCleanup.
  const fc = turns.find((t) => t.corpus === "fluent" && t.style === "clean");
  assert.deepStrictEqual(
    { systemPrompt: fc.systemPrompt, sampling: fc.sampling },
    resolveCleanup({ ...DEFAULTS.cleanup, style: "clean" })
  );
  assert.strictEqual(fc.input, FLUENT.raw);
  // SHORT is opt-in and adds its 12 inputs under clean.
  assert.strictEqual(plan({ corpora: ["fluent", "short"], seeds: [1], gpu: false }).length, 2 + 12);
});

test("plan: the GPU pass is FLUENT/clean only", async () => {
  const { plan } = await load();
  const turns = plan({ corpora: ["fluent", "reported", "short"], seeds: [1, 2, 3], gpu: true });
  assert.strictEqual(turns.length, 3);
  assert.ok(turns.every((t) => t.corpus === "fluent" && t.style === "clean"));
});

// ---- report fixtures -------------------------------------------------------

const PROMPT = resolveCleanup({ ...DEFAULTS.cleanup, style: "clean" }).systemPrompt;
const score = (output) =>
  metrics.scoreOutput({ input: FLUENT.raw, output, systemPrompt: PROMPT, corpus: "fluent" });
const COPY = score(FLUENT.raw); // copies every filler through
const CLEAN = score(FLUENT.raw.replace(/\b(um|uh)\b,?\s*/gi, "")); // removes them
const HALF = score(FLUENT.raw.slice(0, FLUENT.raw.length / 2)); // deletes words

// Write one model's saved run as bench-cleanup does: manifest, runs, summary.
function writeRun(dir, { id, bytes, backend = "cpu", s, wall, load = [10, 10, 10], runLoad = 10 }) {
  const runs = [];
  for (const style of backend === "cpu" ? ["clean", "polished"] : ["clean"]) {
    for (const seed of [1, 2, 3]) {
      runs.push({ corpus: "fluent", style, index: 0, seed, wallMs: wall + seed, ttftMs: 100, genTokens: 200, decodeTps: 20, loadAvg1: runLoad, score: s });
    }
  }
  const manifest = {
    id, file: `${id}.gguf`, bytes, backend, loadMs: 1000, chatWrapper: "X",
    threads: { idealThreads: 12, currentThreads: 12 },
    hardware: { cpu: "CPU", logicalCpus: 24, ramGB: 60, os: "Linux" },
    seeds: [1, 2, 3], loadAvgAtStart: load, loadAvgAtEnd: load,
  };
  const d = path.join(dir, backend === "cpu" ? id : `${id}-gpu`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, "summary.json"), JSON.stringify({ manifest, summary: metrics.summarizeRuns(runs) }));
}

function fixtures() {
  const first = tmpdir();
  const locked = tmpdir();
  // Baseline: copies fillers through, contended first pass at 22 s.
  writeRun(first, { id: "gemma-3-4b", bytes: 2_489_757_856, s: COPY, wall: 22000, runLoad: 30 });
  writeRun(first, { id: "gemma-3-1b", bytes: 806_058_240, s: COPY, wall: 7000 });
  // Clean and faithful, 19 s — but retention 1.00 vs 1.00 only if it keeps words.
  writeRun(first, { id: "good", bytes: 2_100_000_000, s: CLEAN, wall: 19000 });
  // Clean but deletes half the dictation.
  writeRun(first, { id: "lossy", bytes: 2_200_000_000, s: HALF, wall: 10000 });
  // Clean and faithful, but its licence isn't shippable.
  writeRun(first, { id: "lfm", bytes: 700_000_000, s: CLEAN, wall: 5000 });
  // Contended first pass says slow; the locked re-run says fast.
  writeRun(first, { id: "late", bytes: 2_300_000_000, s: CLEAN, wall: 30000, runLoad: 40 });
  writeRun(locked, { id: "late", bytes: 2_300_000_000, s: CLEAN, wall: 20000 });
  writeRun(locked, { id: "gemma-3-4b", bytes: 2_489_757_856, s: COPY, wall: 21000, runLoad: 12 });
  // GPU footnote row: must never feed the bar.
  writeRun(first, { id: "good", bytes: 2_100_000_000, backend: "cuda", s: HALF, wall: 1 });
  return { first, locked };
}

const rowFor = (text, id) => text.split("\n").find((l) => l.startsWith(`| ${id} | gemma`));

test("report: the bar passes a clean, faithful, faster, shippable candidate only", async () => {
  const { report } = await load();
  const { first, locked } = fixtures();
  const text = report({
    report: first, also: [], locked: [locked],
    baselines: ["gemma-3-1b", "gemma-3-4b", "gemma-3-12b"],
    licences: { good: "apache-2.0", lossy: "apache-2.0", late: "mit", lfm: "lfm1.0" },
  });
  // CLEAN keeps every content word, so retention ties the copying baseline.
  assert.match(rowFor(text, "good"), /\*\*yes\*\*/);
  assert.match(rowFor(text, "lossy"), /\| no \(fails 3\/3.*\*\*no\*\*/);
  assert.match(rowFor(text, "lfm"), /lfm1\.0 ✗.*\*\*no\*\*/);
  // Speed comes from the locked re-run for both sides: 20 s vs 21 s.
  assert.match(rowFor(text, "late"), /yes \(20002 \[locked re-run\] vs 21002 \[locked re-run\]\)/);
  // Byte-nearest comparator: lfm (0.7 GB) is judged against the 1B.
  assert.match(rowFor(text, "lfm"), /\| lfm \| gemma-3-1b \|/);
  // The GPU row is a footnote with its own numbers, never a bar input.
  assert.match(text, /\| good \| cuda \|/);
});

test("report: several locked passes are numbered in the speed table", async () => {
  const { report } = await load();
  const { first, locked } = fixtures();
  const text = report({
    report: first, also: [], locked: [locked, locked],
    baselines: ["gemma-3-1b", "gemma-3-4b", "gemma-3-12b"], licences: { late: "mit" },
  });
  assert.match(text, /\| late \| locked re-run 1 \|/);
  assert.match(text, /\| late \| locked re-run 2 \|/);
});

test("report: an unknown licence never passes, and passes are labelled by load", async () => {
  const { report } = await load();
  const { first } = fixtures();
  const text = report({
    report: first, also: [], locked: [],
    baselines: ["gemma-3-1b", "gemma-3-4b", "gemma-3-12b"], licences: {},
  });
  assert.match(rowFor(text, "good"), /unknown ✗.*\*\*no\*\*/);
  const pass = (id) => text.split("\n").find((l) => l.startsWith(`| ${id} | first pass |`));
  assert.match(pass("good"), /\| quiet \|/);
  assert.match(pass("gemma-3-4b"), /\| contended \|/);
});

test("markdownRow renders a saved run's FLUENT numbers", async () => {
  const { markdownRow } = await load();
  const dir = tmpdir();
  writeRun(dir, { id: "m", bytes: 2_000_000_000, s: COPY, wall: 1000 });
  const run = JSON.parse(fs.readFileSync(path.join(dir, "m", "summary.json"), "utf8"));
  const row = markdownRow(run);
  // 6 fillers and 1 "kind of like" × 3 seeds, clean and polished.
  assert.match(row, /^\| m \| 18\/0\/3 \| 0\/3 \| 18\/0\/3 \|/);
  assert.match(row, /\| 0\/0\/3 \|/); // delivered: backstop took the fillers, "kind of like" stays
  assert.match(row, /1002 \[1001–1003\]/);
  assert.match(row, /2\.00 GB \| X \|$/);
});

test("rescore re-scores saved runs from their raw outputs and keeps the timings", async () => {
  const { rescore } = await load();
  const dir = tmpdir();
  const d = path.join(dir, "m");
  fs.mkdirSync(path.join(d, "raw"), { recursive: true });
  // A stale score (as if an older scorer wrote it) next to the real raw text.
  const stale = { ...CLEAN, fillers: 99, fidelityOk: true };
  const rows = [
    { corpus: "fluent", style: "clean", index: 0, seed: 1, stopReason: "eogToken", wallMs: 1234, loadAvg1: 9, score: stale },
    { corpus: "fluent", style: "clean", index: 0, seed: 2, stopReason: "maxTokens", wallMs: 5678, loadAvg1: 9, score: stale },
  ];
  fs.writeFileSync(path.join(d, "raw", "fluent-clean-0-s1.txt"), FLUENT.modelOutput + "\n");
  fs.writeFileSync(path.join(d, "raw", "fluent-clean-0-s2.txt"), "I want to I want to\n");
  fs.writeFileSync(path.join(d, "runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(d, "summary.json"), JSON.stringify({ manifest: { id: "m" }, summary: {} }));

  assert.deepStrictEqual(rescore(dir), { models: 1, runs: 2 });
  const after = fs.readFileSync(path.join(d, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(after[0].score.fillers, 6); // FLUENT.modelOutput's six
  assert.strictEqual(after[0].wallMs, 1234);
  assert.strictEqual(after[1].score.runaway, true); // stopReason is honoured
  const { manifest, summary } = JSON.parse(fs.readFileSync(path.join(d, "summary.json"), "utf8"));
  assert.strictEqual(manifest.id, "m");
  assert.ok(manifest.rescoredAt);
  assert.strictEqual(summary["fluent/clean"].fillers, 6);
  assert.strictEqual(summary["fluent/clean"].fidelityFails, 1);
});
