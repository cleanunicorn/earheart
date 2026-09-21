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
  countMarkers,
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
  classifyPass,
  speedEstimates,
  nearestComparator,
  meetsBar,
  summarizeProbe,
} = require("../scripts/cleanup-metrics");
const { FLUENT, SHORT, REPORTED } = require("../scripts/dictation-corpus");
const { stripStumbles } = require("../main/util/stumble-strip");
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
  // All caps reads as an acronym, as in the production backstop.
  assert.strictEqual(countFillers("the UM team and the UH office, um, agreed"), 1);
});

test("the counters count exactly what the production backstop removes", () => {
  // Contract with main/util/stumble-strip.js: whatever countFillers /
  // countRepeats see, stripStumbles removes, and what it keeps they don't count.
  const samples = [
    FLUENT.raw,
    FLUENT.modelOutput,
    ...SHORT,
    ...REPORTED,
    "the UM team and the UH office, um, agreed",
    "Umm, so uh, the the the parser, erm, is is broken.",
    "it is very very fast and we had had enough",
  ];
  for (const text of samples) {
    const out = stripStumbles(text);
    assert.strictEqual(countFillers(out), 0, `filler left in: ${out}`);
    assert.strictEqual(countRepeats(out), 0, `repeat left in: ${out}`);
  }
  assert.match(stripStumbles("the UM team"), /UM/);
});

test("countMarkers counts the directive's other fillers, only where they are fillers", () => {
  // Each family the Clean/Polished directives name, as a filler…
  assert.strictEqual(countMarkers("so er the build, mm, failed"), 2);
  assert.strictEqual(countMarkers("Hmm, that's odd"), 1);
  assert.strictEqual(countMarkers("the user goes kind of like this"), 1);
  assert.strictEqual(countMarkers("and it's sort of like a queue"), 1);
  assert.strictEqual(countMarkers("the page is, like, for admins"), 1);
  assert.strictEqual(countMarkers("Like, why does it fail?"), 1);
  assert.strictEqual(countMarkers("So like how can we move it"), 1);
  assert.strictEqual(countMarkers("I mean, it works"), 1);
  assert.strictEqual(countMarkers("we build it twice you know once in the test job"), 1);
  // …and never the same words doing their ordinary job.
  for (const ordinary of [
    "add something like connect Gmail",
    "more like the form they see",
    "it looks like rain",
    "I like the renderer",
    "do you know the way",
    "you know that it fails",
    "I mean it",
    "the ER waiting room", // an acronym, not "er"
    "the summer term",
  ]) {
    assert.strictEqual(countMarkers(ordinary), 0, ordinary);
  }
  // FLUENT's one: "kind of like this is where the user goes".
  assert.strictEqual(countMarkers(FLUENT.raw), 1);
  assert.strictEqual(countMarkers(REPORTED[1]), 2); // "you know" twice
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
  // "No quotes": a reply wrapped whole in quotation marks.
  assert.strictEqual(detectEcho('"I wanted to ask about the pipeline."', PROMPT), true);
  assert.strictEqual(detectEcho("“I wanted to ask.”", PROMPT), true);
  assert.strictEqual(detectEcho('He said "stop" and left.', PROMPT), false);
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
  // The backstop removes the um/uh the model left, but not "kind of like":
  // that one is still in what the user gets.
  assert.strictEqual(s.deliveredFillers, 0);
  assert.strictEqual(s.markers, 1);
  assert.strictEqual(s.deliveredMarkers, 1);
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

test("a model that keeps every word but adds its own fails the novelty guard", () => {
  const input = "so um I think that the the parser uh is broken and we we should fix it";
  const s = scoreOutput({
    input,
    output: "I think the parser is broken; we should fix it in postgres tomorrow.",
    systemPrompt: PROMPT,
    corpus: "short",
  });
  // Length, retention and critical tokens all pass; only the invented words fail it.
  assert.ok(s.ratio >= FIDELITY.ratio.other[0] && s.ratio <= FIDELITY.ratio.other[1], String(s.ratio));
  assert.strictEqual(s.retention, 1);
  assert.strictEqual(s.criticalLost, 0);
  assert.ok(s.novel > FIDELITY.maxNovel, String(s.novel));
  assert.strictEqual(s.fidelityOk, false);
  // At the threshold it still passes.
  assert.strictEqual(FIDELITY.maxNovel, 0.1);
  assert.strictEqual(fluent(FLUENT.modelOutput).novel, 0);
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
  // Model-stage stumbles include the directive's other fillers ("kind of like").
  assert.strictEqual(fc.markers, 1 + clean.markers);
  assert.strictEqual(fc.deliveredMarkers, fc.markers); // the backstop never removes them
  assert.strictEqual(fc.stumbles, fc.fillers + fc.repeats + fc.markers);
  assert.strictEqual(fc.cleanRuns, clean.fillers + clean.repeats + clean.markers === 0 ? 1 : 0);
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

test("classifyPass calls a pass quiet only if start, end and every clean stayed low", () => {
  assert.deepStrictEqual(
    classifyPass({ loadAvgAtStart: [12.6, 20, 20], loadAvgAtEnd: [13, 1, 1], runLoads: [12.7, 13.9] }),
    { recorded: true, maxLoad: 13.9, contended: false }
  );
  // Quiet at start, contended by the end: contended.
  assert.strictEqual(
    classifyPass({ loadAvgAtStart: [13.15], loadAvgAtEnd: [38.31], runLoads: [21.7] }).contended,
    true
  );
  assert.deepStrictEqual(classifyPass({}), { recorded: false, maxLoad: null, contended: null });
});

test("speedEstimates prefers the locked pass, then the quietest, and takes the min over all", () => {
  const passes = [
    { label: "first", locked: false, maxLoad: 17.3, wallMedian: 22172, wallMin: 21888 },
    { label: "rerun", locked: false, maxLoad: 38.3, wallMedian: 29793, wallMin: 28839 },
    { label: "locked", locked: true, maxLoad: 15.1, wallMedian: 21500, wallMin: 21300 },
  ];
  assert.deepStrictEqual(speedEstimates(passes), { median: 21500, from: "locked", min: 21300 });
  assert.deepStrictEqual(speedEstimates(passes.slice(0, 2)), { median: 22172, from: "first", min: 21888 });
  // An unrecorded load ranks after any recorded one.
  const e = speedEstimates([
    { label: "old", locked: false, maxLoad: null, wallMedian: 100, wallMin: 90 },
    { label: "new", locked: false, maxLoad: 30, wallMedian: 120, wallMin: 95 },
  ]);
  assert.strictEqual(e.from, "new");
  assert.strictEqual(e.min, 90);
});
