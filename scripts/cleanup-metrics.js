// Scoring for the cleanup benchmark (scripts/bench-cleanup.mjs), kept pure so
// test/cleanup-metrics.test.js can pin it without a model. CommonJS, like
// scripts/dictation-corpus.js, so the ESM scripts reach it through
// createRequire and the tests through require.
//
// Filler counts alone would reward a model for deleting the user's words, so
// every output is also held to fidelity guards: length ratio, content-word
// retention, words the speaker never said, critical tokens (negations, scope words, numbers, code), prompt
// echo (including visible <think> reasoning), refusal, empty output and a
// runaway. A runaway is scored the way production delivers it: the engine
// throws on a maxTokens stop and the user gets the raw transcript
// (main/engines/engine-worker.js), so the delivered text is the input.
//
// Eval-only: nothing in the app requires this file.

// The production backstop's own filler and repeat rules — imported, not
// copied, so these counts always describe what it strips.
const {
  stripStumbles,
  collapseRepeats,
  FILLER,
  REPEAT,
  isStrippableFiller,
} = require("../main/util/stumble-strip");

// Counts what the backstop would strip (an all-caps "UM" is kept as an acronym).
function countFillers(text) {
  return (text.match(FILLER) || []).filter(isStrippableFiller).length;
}

// The rest of the fillers the Clean and Polished directives tell the model to
// delete (main/cleanup-styles.js: "er, mm, you know, like, I mean"), which the
// deterministic backstop leaves alone. "like" and "you know" are ordinary
// words too ("something like that", "do you know the way"), so only their
// unmistakably filler uses count — a missed one understates a model's
// stumbles, a false one would blame it for keeping the speaker's words.
const MARKERS = [
  /(?<![\w'’-])(?:[Ee]r+|[Mm]m+|[Hh]mm+)(?![\w'’-])/g, // er, mm, hmm (not all-caps "ER")
  /\b(?:kind|sort) of like\b/gi, // "kind of like this is where"
  /,\s*like\s*,/gi, // ", like, "
  /(?:^|[.!?]\s+)(?:so,?\s+)?like\s*,/gim, // "Like, …" / "So like, …" opening a sentence
  /\bso,?\s+like\b(?!\s*,)/gi, // "So like how can we"
  /\bI mean\s*,/g, // "I mean, …"
  /(?<!\b(?:do|does|did|don't|didn't|if|whether|what|as|that)\s+)\byou know\b(?!\s+(?:that|what|how|why|where|who|when|if|whether|it|him|her|them|the|a|an|about)\b)/gi,
];

function countMarkers(text) {
  return MARKERS.reduce((n, re) => n + (text.match(re) || []).length, 0);
}

// A "repeat" is what the backstop would collapse — the production rule itself
// (deliberate doublings, numbers and spelled-out letters are not stutters), so
// the delivered column can never report a repeat the backstop keeps on purpose.
function countRepeats(text) {
  let n = 0;
  text.replace(REPEAT, (m) => {
    if (collapseRepeats(m) !== m) n++;
    return m;
  });
  return n;
}

// Function words: dropping or restoring one ("the the" → "the", a restart
// collapsed) is legitimate cleanup and must not read as lost content. Negations
// are here too because criticalRetention guards them on their own, strictly.
const FUNCTION_WORDS = new Set(
  (
    "a an the and or but nor so if then than that this these those there here " +
    "is are was were be been being am do does did done have has had having " +
    "i me my mine we us our ours you your yours he him his she her hers it its " +
    "they them their theirs what which who whom whose when where why how " +
    "to of in on at by for with from into onto over under about as up down out " +
    "off again just very too also only not no never don't doesn't didn't isn't " +
    "aren't wasn't weren't can't won't wouldn't shouldn't couldn't without " +
    "can could will would shall should may might must let let's " +
    "i'm i've i'd i'll you're you've you'd you'll we're we've we'd we'll " +
    "it's that's there's what's he's she's they're they've " +
    "all any some each every both either neither one more most much many " +
    "such own same other like well oh okay ok yeah yes kind sort really"
  ).split(" ")
);
// A whole word the backstop would strip ("um", "uhh", "erm").
const isFillerWord = (w) => (w.match(FILLER) || [])[0] === w;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

function words(text) {
  return (text.toLowerCase().replace(/’/g, "'").match(WORD) || []);
}

function contentWords(text) {
  return words(text).filter((w) => !FUNCTION_WORDS.has(w) && !isFillerWord(w));
}

function multiset(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// Share of `expected`'s items (with multiplicity) that `actual` still has.
function recall(expected, actual) {
  if (expected.length === 0) return 1;
  const have = multiset(actual);
  let kept = 0;
  for (const x of expected) {
    const n = have.get(x) || 0;
    if (n > 0) {
      kept++;
      have.set(x, n - 1);
    }
  }
  return kept / expected.length;
}

function lengthRatio(input, output) {
  const n = [...input].length;
  return n === 0 ? 0 : [...output].length / n;
}

function contentRetention(input, output) {
  return recall(contentWords(input), contentWords(output));
}

// Share of the output's content words the speaker never said: catches a model
// that keeps the words and then invents more.
function novelContentRatio(input, output) {
  const out = contentWords(output);
  if (out.length === 0) return 0;
  return 1 - recall(out, contentWords(input));
}

// The base prompt's hard rules (main/settings.js): negations and scope limits
// are reproduced exactly, and spoken code becomes code. A lost one inverts or
// breaks the instruction, so any loss fails fidelity.
const NEGATION = new Set(["not", "no", "never", "without", "only", "except", "nor", "none", "nothing"]);

function criticalTokens(text) {
  const out = [];
  for (const raw of text.toLowerCase().replace(/’/g, "'").split(/\s+/)) {
    const t = raw.replace(/^[^\p{L}\p{N}.\-/_]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t) continue;
    if (NEGATION.has(t) || t.endsWith("n't") || /\d/.test(t) || /\w[./_]\w|^--?\w/.test(t)) {
      out.push(t);
    }
  }
  return out;
}

function criticalRetention(input, output) {
  const expected = criticalTokens(input);
  const r = recall(expected, criticalTokens(output));
  return { expected: expected.length, lost: Math.round((1 - r) * expected.length) };
}

// Echo: the model repeated the frame or its instructions, or reasoned out loud,
// instead of returning only the cleaned text.
const ECHO_LABEL = /(^|\n)\s*(cleaned transcript:|transcript:|editing style:)/i;
const THINK = /<\/?think>/i;
const PREAMBLE = /^\s*(here(?:'|’)?s\b|here is\b|sure[,!.]|certainly[,!.]|```)/i;
const QUOTED = /^["“][\s\S]*["”]$/;
const PROMPT_SLICE = 40;

function detectEcho(output, systemPrompt = "") {
  if (ECHO_LABEL.test(output) || THINK.test(output) || PREAMBLE.test(output)) return true;
  if (output.includes("```")) return true;
  // The prompt says "no quotes": a reply wrapped whole in quotation marks is
  // the model presenting the text rather than returning it.
  if (QUOTED.test(output.trim())) return true;
  const hay = output.toLowerCase();
  for (const line of systemPrompt.split("\n")) {
    const text = line.replace(/^\s*-\s*/, "").trim();
    if (text.length >= PROMPT_SLICE && hay.includes(text.slice(0, PROMPT_SLICE).toLowerCase())) {
      return true;
    }
  }
  return false;
}

const REFUSAL =
  /^\s*(?:i(?:'|’)?m sorry|i am sorry|sorry,|i can(?:'|’)?t\b|i cannot\b|i(?:'|’)?m unable|i am unable|as an ai\b|i can help\b)/i;

function detectRefusal(output) {
  return REFUSAL.test(output);
}

// Frozen at the plumbing run (M5) before any candidate was measured. FLUENT is
// mostly fluent, so an honest cleanup keeps nearly all of it; SHORT/REPORTED
// are filler-dense and legitimately shrink more. Retention only sees words the
// model dropped, so maxNovel bounds the words it added: every run that passed
// the other guards on 2026-09-21 stayed at or below 0.07, and the rewrites the
// spot checks flagged start around 0.15.
const FIDELITY = {
  ratio: { fluent: [0.85, 1.05], other: [0.7, 1.1] },
  minRetention: 0.9,
  maxNovel: 0.1,
};

function scoreOutput({ input, output, stopReason, systemPrompt = "", corpus = "fluent" }) {
  const text = (output || "").trim();
  const runaway = stopReason === "maxTokens";
  const delivered = runaway ? input : stripStumbles(text);
  const ratio = lengthRatio(input, text);
  const retention = contentRetention(input, text);
  const critical = criticalRetention(input, text);
  const empty = text === "";
  const echo = detectEcho(text, systemPrompt);
  const refusal = detectRefusal(text);
  const novel = novelContentRatio(input, text);
  const [lo, hi] = corpus === "fluent" ? FIDELITY.ratio.fluent : FIDELITY.ratio.other;
  const fidelityOk =
    !runaway && !empty && !echo && !refusal && critical.lost === 0 &&
    ratio >= lo && ratio <= hi && retention >= FIDELITY.minRetention && novel <= FIDELITY.maxNovel;
  return {
    fillers: countFillers(text),
    repeats: countRepeats(text),
    markers: countMarkers(text),
    delivered,
    deliveredFillers: countFillers(delivered),
    deliveredRepeats: countRepeats(delivered),
    // The backstop leaves these alone, so whatever the model kept is delivered.
    deliveredMarkers: countMarkers(delivered),
    ratio,
    retention,
    novel,
    criticalLost: critical.lost,
    echo,
    refusal,
    empty,
    runaway,
    fidelityOk,
  };
}

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function minMax(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? [Math.min(...v), Math.max(...v)] : [null, null];
}

// Decode speed: tokens after the first, over the time since the first. Prefill
// is what time-to-first-token already reports.
function decodeTokensPerSecond(genTokens, firstTokenMs, endMs) {
  const dt = endMs - firstTokenMs;
  if (!(genTokens > 1) || !(dt > 0)) return null;
  return (genTokens - 1) / (dt / 1000);
}

// Aggregate run rows ({corpus, style, wallMs, ttftMs, genTokens, decodeTps,
// score}) into one summary per corpus/style.
function summarizeRuns(runs) {
  const groups = {};
  for (const r of runs) (groups[`${r.corpus}/${r.style}`] ||= []).push(r);
  const out = {};
  for (const [key, rs] of Object.entries(groups)) {
    const sum = (f) => rs.reduce((n, r) => n + f(r), 0);
    const count = (f) => rs.filter(f).length;
    const walls = rs.map((r) => r.wallMs);
    const [wmin, wmax] = minMax(walls);
    const fillers = sum((r) => r.score.fillers);
    const repeats = sum((r) => r.score.repeats);
    const markers = sum((r) => r.score.markers ?? 0);
    const stumbled = (r) => r.score.fillers + r.score.repeats + (r.score.markers ?? 0);
    out[key] = {
      n: rs.length,
      fillers,
      repeats,
      markers,
      stumbles: fillers + repeats + markers,
      cleanRuns: count((r) => stumbled(r) === 0 && r.score.fidelityOk),
      deliveredFillers: sum((r) => r.score.deliveredFillers),
      deliveredRepeats: sum((r) => r.score.deliveredRepeats),
      deliveredMarkers: sum((r) => r.score.deliveredMarkers ?? 0),
      fidelityFails: count((r) => !r.score.fidelityOk),
      echo: count((r) => r.score.echo),
      refusal: count((r) => r.score.refusal),
      runaway: count((r) => r.score.runaway),
      empty: count((r) => r.score.empty),
      criticalLost: sum((r) => r.score.criticalLost),
      medianRatio: median(rs.map((r) => r.score.ratio)),
      medianRetention: median(rs.map((r) => r.score.retention)),
      minRetention: minMax(rs.map((r) => r.score.retention))[0],
      medianNovel: median(rs.map((r) => r.score.novel)),
      wallMs: { median: median(walls), min: wmin, max: wmax },
      ttftMs: median(rs.map((r) => r.ttftMs)),
      decodeTps: median(rs.map((r) => r.decodeTps)),
      genTokens: median(rs.map((r) => r.genTokens)),
      loadAvg1: median(rs.map((r) => r.loadAvg1)),
    };
  }
  return out;
}

// The benchmark host can be shared, so a timing is only as good as the load it
// was taken under. A pass is quiet when its load — the 1-minute average at
// start, at end, and after every clean — never exceeds QUIET_LOAD (about what
// the benchmark alone produces with its 12 threads); a pass with no recorded
// load can't be called either.
const QUIET_LOAD = 14;

function classifyPass({ loadAvgAtStart, loadAvgAtEnd, runLoads = [] }) {
  const loads = [loadAvgAtStart?.[0], loadAvgAtEnd?.[0], ...runLoads].filter((x) => Number.isFinite(x));
  if (loads.length === 0) return { recorded: false, maxLoad: null, contended: null };
  const maxLoad = Math.max(...loads);
  return { recorded: true, maxLoad, contended: maxLoad > QUIET_LOAD };
}

// Two speed estimates for one model across its passes ({label, locked,
// maxLoad, wallMedian, wallMin}): the median of its least-contended pass —
// a pass run under the cross-run CPU lock first, then the lowest peak load —
// and the fastest single clean across every pass, the least-interfered sample.
function speedEstimates(passes) {
  const rank = (p) => [p.locked ? 0 : 1, p.maxLoad ?? Infinity];
  const best = [...passes].sort((a, b) => {
    const [la, ma] = rank(a);
    const [lb, mb] = rank(b);
    return la - lb || ma - mb;
  })[0];
  return {
    median: best.wallMedian,
    from: best.label,
    min: Math.min(...passes.map((p) => p.wallMin)),
  };
}

// AC6 compares a candidate with the shipped Gemma nearest in file size: bytes
// drive download size, RAM and speed; parameter labels don't compare across
// architectures and quantizations. A tie goes to the smaller Gemma.
function nearestComparator(bytes, gemmas) {
  return [...gemmas]
    .sort((a, b) => a.bytes - b.bytes)
    .reduce((best, g) => (Math.abs(g.bytes - bytes) < Math.abs(best.bytes - bytes) ? g : best));
}

// Licences a new catalog entry may carry (question Q4); anything else is
// measured and surveyed, never added.
const SHIPPABLE_LICENCES = new Set(["apache-2.0", "mit", "gemma"]);

// The catalog bar (AC6), on FLUENT. Each side is { licence, summary } with
// summary from summarizeRuns. Quality is the model's own output — the backstop
// can bring any model's delivered count to zero, so it never decides a win —
// and it must be strictly better: a tie, even a faster one, is not a win.
function meetsBar(candidate, comparator) {
  const cs = candidate.summary["fluent/clean"];
  const gs = comparator.summary["fluent/clean"];
  const cp = candidate.summary["fluent/polished"];
  const gp = comparator.summary["fluent/polished"];
  const r = {
    licence: SHIPPABLE_LICENCES.has(candidate.licence),
    quality: cs.stumbles < gs.stumbles && cs.cleanRuns >= gs.cleanRuns,
    polished: Boolean(cp && gp) && cp.stumbles <= gp.stumbles,
    fidelity:
      cs.fidelityFails === 0 && Boolean(cp) && cp.fidelityFails === 0 &&
      cs.medianRetention >= gs.medianRetention,
    speed: cs.wallMs.median <= gs.wallMs.median,
  };
  r.pass = r.licence && r.quality && r.polished && r.fidelity && r.speed;
  return r;
}

// One survey row from the HF model API (?expand[]=gguf&expand[]=cardData&
// expand[]=gated) and the HEAD of resolve/main/<file> — the same headers the
// registry's refresh recipe pins from (main/engines/registry.js).
function summarizeProbe(api, headers, file) {
  const h = (k) => (typeof headers.get === "function" ? headers.get(k) : headers[k]) ?? null;
  const template = api.gguf?.chat_template;
  const card = api.cardData || {};
  const etag = h("x-linked-etag");
  const size = h("x-linked-size");
  return {
    arch: api.gguf?.architecture ?? null,
    templateChars: typeof template === "string" ? template.length : 0,
    thinking: typeof template === "string" && /enable_thinking|<think>/.test(template),
    licence: card.license_name || card.license || null,
    gated: api.gated ?? null,
    commit: h("x-repo-commit"),
    sha256: etag ? etag.replace(/^W\//, "").replace(/"/g, "") : null,
    bytes: size ? Number(size) : null,
    split: /-\d{5}-of-\d{5}\.gguf$/i.test(file),
  };
}

module.exports = {
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
  FIDELITY,
  scoreOutput,
  median,
  minMax,
  decodeTokensPerSecond,
  summarizeRuns,
  classifyPass,
  speedEstimates,
  nearestComparator,
  meetsBar,
  summarizeProbe,
};
