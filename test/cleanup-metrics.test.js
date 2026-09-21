// Tests for the cleanup benchmark's scoring (scripts/cleanup-metrics.js).
//
// The benchmark decides whether a cleanup model earns a catalog entry, so its
// guards are pinned here without a model: a model must not "win" on fillers by
// deleting the user's words, echoing the prompt, refusing, thinking out loud or
// running away, and the bar must refuse a candidate that is better but slower,
// faster but lossy, or better only after the deterministic backstop.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  countFillers,
  countRepeats,
  lengthRatio,
  contentWords,
  contentRetention,
  novelContentRatio,
  criticalRetention,
  detectEcho,
  detectRefusal,
  scoreOutput,
  FIDELITY,
  median,
  minMax,
  decodeTokensPerSecond,
  summarizeRuns,
  nearestComparator,
  meetsBar,
  summarizeProbe,
} = require("../scripts/cleanup-metrics");
const { FLUENT } = require("../scripts/dictation-corpus");
const { DEFAULTS } = require("../main/settings");

const PROMPT = DEFAULTS.cleanup.systemPrompt;
const fluent = (output, extra = {}) =>
  scoreOutput({ input: FLUENT.raw, output, systemPrompt: PROMPT, corpus: "fluent", ...extra });

test("filler and repeat counters match the production backstop's families", () => {
  assert.strictEqual(countFillers("so um I uh think erm Umm yes"), 4);
  assert.strictEqual(countFillers("the umbrella is huge"), 0);
  assert.strictEqual(countRepeats("the the parser and we we call"), 2);
  // Deliberate doublings the backstop keeps are not counted.
  assert.strictEqual(countRepeats("it is very very fast"), 0);
  assert.strictEqual(countFillers(FLUENT.modelOutput), 6);
});

test("lengthRatio compares code points, output over input", () => {
  assert.strictEqual(lengthRatio("abcd", "ab"), 0.5);
  assert.strictEqual(lengthRatio("😀😀", "😀😀"), 1);
  assert.strictEqual(lengthRatio("", "x"), 0);
});

test("contentWords drops function words and fillers, keeps content", () => {
  assert.deepStrictEqual(
    contentWords("So um, the Parser and the renderer's tests!"),
    ["parser", "renderer's", "tests"]
  );
});

test("content retention is a multiset recall of the input's content words", () => {
  assert.strictEqual(contentRetention("parser parser renderer", "parser renderer"), 2 / 3);
  assert.strictEqual(contentRetention("the a an", "anything"), 1);
  assert.ok(contentRetention(FLUENT.raw, FLUENT.modelOutput) >= 0.98);
});

test("novel content ratio flags words the speaker never said", () => {
  assert.strictEqual(novelContentRatio("parser renderer", "parser renderer"), 0);
  assert.ok(Math.abs(novelContentRatio("parser", "parser database migration") - 2 / 3) < 1e-9);
});

test("critical retention catches a dropped negation, number or code token", () => {
  assert.strictEqual(criticalRetention("don't touch main.py", "don't touch main.py").lost, 0);
  assert.strictEqual(criticalRetention("don't touch main.py", "Touch main.py").lost, 1);
  assert.strictEqual(criticalRetention("only in src/utils on port 3000", "in src/utils on port").lost, 2);
  assert.strictEqual(criticalRetention("never without it", "never without it").lost, 0);
});

test("echo detection: prompt fragments, labels, thinking and preambles", () => {
  assert.strictEqual(detectEcho(FLUENT.modelOutput, PROMPT), false);
  assert.strictEqual(detectEcho("Cleaned transcript: hello", PROMPT), true);
  assert.strictEqual(detectEcho("<think>the user wants</think> hello", PROMPT), true);
  assert.strictEqual(detectEcho("Here is the cleaned text: hello", PROMPT), true);
  assert.strictEqual(detectEcho("```\nhello\n```", PROMPT), true);
  assert.strictEqual(
    detectEcho("Rules: Reproduce negations and scope limits exactly as spoken", PROMPT),
    true
  );
  assert.strictEqual(detectEcho("Editing style: tidy", PROMPT), true);
});

test("refusal detection is anchored at the start", () => {
  assert.strictEqual(detectRefusal("I'm sorry, but I can't help with that."), true);
  assert.strictEqual(detectRefusal("As an AI, I cannot"), true);
  assert.strictEqual(detectRefusal("I can’t do that"), true);
  assert.strictEqual(detectRefusal("The tests say I cannot merge yet."), false);
});

test("FLUENT's known model output passes every fidelity guard", () => {
  const s = fluent(FLUENT.modelOutput);
  assert.strictEqual(s.fillers, 6);
  assert.strictEqual(s.fidelityOk, true, JSON.stringify(s));
  assert.strictEqual(s.runaway, false);
  // The backstop removes what the model left.
  assert.strictEqual(s.deliveredFillers, 0);
});

test("a model that deletes half the dictation fails retention and length", () => {
  const half = FLUENT.raw.slice(0, Math.floor(FLUENT.raw.length / 2));
  const s = fluent(half);
  assert.ok(s.retention < FIDELITY.minRetention);
  assert.ok(s.ratio < FIDELITY.ratio.fluent[0]);
  assert.strictEqual(s.fidelityOk, false);
});

test("echo, refusal, empty and critical loss each fail fidelity", () => {
  assert.strictEqual(fluent(`Transcript:\n${FLUENT.modelOutput}`).fidelityOk, false);
  assert.strictEqual(fluent("I'm sorry, I can't help with that.").fidelityOk, false);
  const empty = fluent("   ");
  assert.strictEqual(empty.empty, true);
  assert.strictEqual(empty.fidelityOk, false);
  const lossy = scoreOutput({
    input: "don't change the parser, only the renderer",
    output: "Change the parser, and the renderer.",
    systemPrompt: PROMPT,
    corpus: "short",
  });
  assert.strictEqual(lossy.criticalLost, 2);
  assert.strictEqual(lossy.fidelityOk, false);
});

test("a runaway delivers the raw input, as production does", () => {
  const s = fluent("I want to I want to I want to", { stopReason: "maxTokens" });
  assert.strictEqual(s.runaway, true);
  assert.strictEqual(s.fidelityOk, false);
  assert.strictEqual(s.delivered, FLUENT.raw);
  assert.strictEqual(s.deliveredFillers, countFillers(FLUENT.raw));
});

test("the length band is tighter on FLUENT than on filler-dense corpora", () => {
  assert.deepStrictEqual(FIDELITY.ratio.fluent, [0.85, 1.05]);
  assert.deepStrictEqual(FIDELITY.ratio.other, [0.7, 1.1]);
  const input = "so um the the parser uh is is broken you know";
  const s = scoreOutput({ input, output: "So the parser is broken, you know.", systemPrompt: PROMPT, corpus: "short" });
  assert.strictEqual(s.fidelityOk, true, JSON.stringify(s));
});

test("median, minMax and decode tokens/s", () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([]), null);
  assert.deepStrictEqual(minMax([3, 1, 2]), [1, 3]);
  // 11 tokens, first at 100 ms, last at 1100 ms: 10 tokens over 1 s.
  assert.strictEqual(decodeTokensPerSecond(11, 100, 1100), 10);
  assert.strictEqual(decodeTokensPerSecond(1, 100, 1100), null);
  assert.strictEqual(decodeTokensPerSecond(5, 100, 100), null);
});

// A run row as the harness writes it.
const run = (over = {}) => ({
  corpus: "fluent",
  style: "clean",
  wallMs: 1000,
  ttftMs: 100,
  genTokens: 200,
  decodeTps: 20,
  score: fluent(FLUENT.modelOutput),
  ...over,
});

test("summarizeRuns groups by corpus/style and sums stumbles", () => {
  const clean = fluent(FLUENT.raw.replace(/\b(um|uh)\b,?\s*/gi, ""));
  const sum = summarizeRuns([
    run(),
    run({ wallMs: 3000, score: clean }),
    run({ style: "polished", wallMs: 2000 }),
  ]);
  const fc = sum["fluent/clean"];
  assert.strictEqual(fc.n, 2);
  assert.strictEqual(fc.fillers, 6 + clean.fillers);
  assert.strictEqual(fc.stumbles, fc.fillers + fc.repeats);
  assert.strictEqual(fc.cleanRuns, clean.fillers + clean.repeats === 0 ? 1 : 0);
  assert.deepStrictEqual(fc.wallMs, { median: 2000, min: 1000, max: 3000 });
  // Rows without a load average (older runs) summarize to null, not NaN.
  assert.strictEqual(fc.loadAvg1, null);
  assert.strictEqual(sum["fluent/polished"].n, 1);
});

test("nearestComparator picks the byte-nearest Gemma, ties to the smaller", () => {
  const gemmas = [
    { id: "g1", bytes: 800 },
    { id: "g4", bytes: 2500 },
    { id: "g12", bytes: 7300 },
  ];
  assert.strictEqual(nearestComparator(560, gemmas).id, "g1");
  assert.strictEqual(nearestComparator(1650, gemmas).id, "g1"); // tie → smaller
  assert.strictEqual(nearestComparator(3650, gemmas).id, "g4");
  assert.strictEqual(nearestComparator(5160, gemmas).id, "g12");
});

// Summaries for the bar: stumbles/cleanRuns/fidelity/wall per FLUENT style.
const side = ({ stumbles = 6, cleanRuns = 0, polished = 6, wall = 1000, retention = 1, fails = 0, licence = "apache-2.0" } = {}) => ({
  licence,
  summary: {
    "fluent/clean": {
      stumbles, cleanRuns, fidelityFails: fails, medianRetention: retention,
      wallMs: { median: wall, min: wall, max: wall },
    },
    "fluent/polished": { stumbles: polished, fidelityFails: 0 },
  },
});
const gemma = side({ licence: "gemma" });

test("meetsBar passes a candidate that is better, as fast, and faithful", () => {
  const r = meetsBar(side({ stumbles: 2, cleanRuns: 2, polished: 3, wall: 900 }), gemma);
  assert.strictEqual(r.pass, true, JSON.stringify(r));
});

test("meetsBar refuses better-but-slower", () => {
  const r = meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, wall: 1001 }), gemma);
  assert.strictEqual(r.speed, false);
  assert.strictEqual(r.pass, false);
});

test("meetsBar refuses faster-but-lossy", () => {
  const r = meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, wall: 500, retention: 0.99 }), gemma);
  assert.strictEqual(r.fidelity, false);
  const r2 = meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, wall: 500, fails: 1 }), gemma);
  assert.strictEqual(r2.fidelity, false);
  assert.strictEqual(r2.pass, false);
});

test("meetsBar refuses a quality tie, even when faster (strict AC6)", () => {
  const r = meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, wall: 100 }), side({ stumbles: 0, cleanRuns: 5, polished: 0, licence: "gemma" }));
  assert.strictEqual(r.quality, false);
  assert.strictEqual(r.pass, false);
});

test("meetsBar refuses a polished regression and a non-shippable licence", () => {
  assert.strictEqual(meetsBar(side({ stumbles: 2, cleanRuns: 2, polished: 7 }), gemma).polished, false);
  const lfm = meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, wall: 100, licence: "lfm1.0" }), gemma);
  assert.strictEqual(lfm.licence, false);
  assert.strictEqual(lfm.pass, false);
  assert.strictEqual(meetsBar(side({ stumbles: 0, cleanRuns: 5, polished: 0, licence: "mit" }), gemma).pass, true);
});

test("meetsBar never counts a delivered-only improvement", () => {
  // Same model-stage stumbles; only the backstop's output would differ.
  const r = meetsBar(side({ stumbles: 6, cleanRuns: 0 }), gemma);
  assert.strictEqual(r.quality, false);
});

test("summarizeProbe reads arch, template, licence and the pin from HF", () => {
  const api = {
    gated: false,
    cardData: { license: "other", license_name: "lfm1.0" },
    gguf: { architecture: "lfm2", chat_template: "{% if enable_thinking %}<think>{% endif %}" },
  };
  const headers = new Map([
    ["x-repo-commit", "5399e76c648f4eb8c053feb1ab747277dea5bf8b"],
    ["x-linked-etag", '"55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed"'],
    ["x-linked-size", "730893248"],
  ]);
  const p = summarizeProbe(api, headers, "LFM2-1.2B-Q4_K_M.gguf");
  assert.deepStrictEqual(p, {
    arch: "lfm2",
    templateChars: 42,
    thinking: true,
    licence: "lfm1.0",
    gated: false,
    commit: "5399e76c648f4eb8c053feb1ab747277dea5bf8b",
    sha256: "55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed",
    bytes: 730893248,
    split: false,
  });
  assert.strictEqual(summarizeProbe({}, new Map(), "m-00001-of-00002.gguf").split, true);
  assert.strictEqual(summarizeProbe({ cardData: { license: "mit" } }, {}, "m.gguf").licence, "mit");
});
