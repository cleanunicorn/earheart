// Pure helpers behind the speech-to-text evaluation (scripts/eval-stt.js) —
// scoring, statistics, the catalog threshold, and the corpus plumbing — kept
// free of Electron, the network, and models so test/stt-eval.test.js can pin
// every one of them. The harness only wires these to the real engine worker.
//
// WER here is always computed on NORMALISED text, and the normalisation is the
// part of an ASR comparison that quietly decides the result, so it is spelled
// out stage by stage and each stage can be switched off (the harness prints
// that ablation for the default model):
//
//   N0  Unicode NFKC; curly quotes -> straight, en/em dash -> "-"
//   N1  lowercase                       hides: whether the model capitalises
//   N3  digits -> words ("1963" -> "nineteen sixty three", "$5" -> "five
//       dollars", "20%" -> "twenty percent", "13th" -> "thirteenth")
//                                       hides: inverse-text-normalisation style
//   N2  punctuation -> removed, "-" -> space, intra-word "'" kept
//                                       hides: whether the model punctuates
//   N4  hesitations (um, uh, erm, …) dropped from both sides
//                                       hides: whether the model emits fillers
//   N5  collapse whitespace
//
// N3 runs before N2 because it needs the "$", "%", "," and "." that N2 strips.
// Digits are spelled out, never parsed back: spelling a number is a total
// function, while reading "forty thousand" back into 40000 needs a grammar.
// Constructs N3 does not model (clock times, ranges, alphanumerics like "F1",
// fractions) are flagged by hasUnmodelledConstruct, so the harness can report
// WER with and without them — if the ranking holds on both, the normalisation
// is not what decided it. Most are left as they are; a number glued to a "."
// that is itself glued to more characters is partly spelled out ("802.11n" ->
// "eight hundred two 11n", "5.0Ghz" -> "five 0ghz", "v1.2" -> "v1 2"). That is
// the same on both sides and always flagged, and it is kept as measured rather
// than changed after the numbers existed.
//
// `wer_verbatim` is N0 + N5 only: case and punctuation intact, which is what
// Earheart actually pastes.

const { join: joinPath } = require("node:path");
const { encodeWav, SAMPLE_RATE } = require("../main/util/wav");

/* ---------------- normalisation ---------------- */

const FILLERS = new Set(["um", "uh", "erm", "uhm", "hmm", "mm"]);

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];

function underHundred(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}

function underThousand(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return underHundred(rest);
  return rest ? `${ONES[h]} hundred ${underHundred(rest)}` : `${ONES[h]} hundred`;
}

/** Cardinal words for a non-negative integer: 40000 -> "forty thousand". */
function intToWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`not a non-negative integer: ${n}`);
  if (n === 0) return "zero";
  const parts = [];
  let rest = n;
  for (const [value, name] of SCALES) {
    if (rest >= value) {
      parts.push(`${underThousand(Math.floor(rest / value))} ${name}`);
      rest %= value;
    }
  }
  if (rest) parts.push(underThousand(rest));
  return parts.join(" ");
}

/**
 * A four-digit year as it is spoken: 1963 -> "nineteen sixty three", 1900 ->
 * "nineteen hundred", 1905 -> "nineteen oh five", 2005 -> "two thousand five",
 * 2017 -> "twenty seventeen". Outside 1100-2099 it is just the cardinal.
 */
function yearToWords(n) {
  if (n >= 2000 && n <= 2009) return intToWords(n);
  if (n < 1100 || n > 2099) return intToWords(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return `${underHundred(hi)} hundred`;
  if (lo < 10) return `${underHundred(hi)} oh ${ONES[lo]}`;
  return `${underHundred(hi)} ${underHundred(lo)}`;
}

const ORDINAL_IRREGULAR = {
  one: "first", two: "second", three: "third", five: "fifth",
  eight: "eighth", nine: "ninth", twelve: "twelfth",
};

function lastWord(words, fn) {
  const parts = words.split(" ");
  parts[parts.length - 1] = fn(parts[parts.length - 1]);
  return parts.join(" ");
}

const toOrdinal = (w) =>
  ORDINAL_IRREGULAR[w] || (w.endsWith("y") ? `${w.slice(0, -1)}ieth` : `${w}th`);
const toPlural = (w) => (w.endsWith("y") ? `${w.slice(0, -1)}ies` : `${w}s`);

// One number-ish token: optional "$", an integer (optionally with thousands
// separators), an optional decimal part, and an optional %, ordinal, or decade
// suffix. Never preceded by a letter, digit or ".", nor followed by a letter
// or digit — so "F1", "M16" and "70km" stay whole. A following "." is allowed
// (it ends sentences), which is why "802.11n" becomes "eight hundred two 11n";
// such tokens are flagged as unmodelled (see the header).
const NUMBER_RE =
  /(?<![\p{L}\p{N}.])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%|st|nd|rd|th|s)?(?![\p{L}\p{N}])/gu;

function numberToWords(dollar, intPart, decimals, suffix) {
  const plain = intPart.replace(/,/g, "");
  const n = Number(plain);
  if (!Number.isSafeInteger(n)) return null;
  const isYear = !decimals && !dollar && plain.length === 4 && !intPart.includes(",");
  let words;
  if (suffix === "st" || suffix === "nd" || suffix === "rd" || suffix === "th") {
    if (decimals || dollar) return null;
    return lastWord(intToWords(n), toOrdinal);
  }
  if (suffix === "s") {
    if (decimals || dollar) return null;
    // Decades and centuries: 1960s, 20s, 1800s.
    return lastWord(isYear ? yearToWords(n) : intToWords(n), toPlural);
  }
  words = isYear ? yearToWords(n) : intToWords(n);
  if (decimals) {
    words += ` point ${[...decimals].map((d) => ONES[Number(d)]).join(" ")}`;
  }
  if (suffix === "%") words += " percent";
  if (dollar) words += n === 1 && !decimals ? " dollar" : " dollars";
  return words;
}

/** N3 on its own: spell every modelled number in `text` out as words. */
function verbaliseNumbers(text) {
  return text.replace(NUMBER_RE, (match, dollar, intPart, decimals, suffix) => {
    const words = numberToWords(dollar, intPart, decimals, suffix);
    return words === null ? match : ` ${words} `;
  });
}

// A whitespace token, stripped of the punctuation that can surround a number,
// that still carries a digit but is not a shape N3 models.
const MODELLED_TOKEN_RE = /^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|st|nd|rd|th|s)?$/;

/**
 * True when the reference holds a number construct N3 leaves untouched: a
 * clock time, a range, an alphanumeric ("F1", "802.11n", "70km/h"), a
 * fraction, an approximation sign. Judged on the raw reference only.
 */
function hasUnmodelledConstruct(raw) {
  for (const token of raw.normalize("NFKC").split(/\s+/)) {
    const core = token.replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, "");
    if (/\d/.test(core) && !MODELLED_TOKEN_RE.test(core)) return true;
  }
  return false;
}

const ALL_STAGES = { lowercase: true, numbers: true, punctuation: true, fillers: true };
const VERBATIM = { lowercase: false, numbers: false, punctuation: false, fillers: false };

/**
 * Normalise a transcript into word tokens. `stages` switches N1-N4 off one at
 * a time (N0 and N5 always run); the default is the full N0-N5 pipeline.
 * @returns {string[]}
 */
function normalise(text, stages = ALL_STAGES) {
  const s = { ...ALL_STAGES, ...stages };
  let t = String(text || "")
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-");
  if (s.lowercase) t = t.toLowerCase();
  if (s.numbers) t = verbaliseNumbers(t);
  if (s.punctuation) {
    t = t.replace(/-/g, " ").replace(/[^\p{L}\p{N}\s']/gu, " ");
  }
  let tokens = t.split(/\s+/).filter(Boolean);
  if (s.punctuation) {
    tokens = tokens.map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  }
  if (s.fillers) {
    // Whole-token match only: "35mm" is a measurement, not a hesitation.
    tokens = tokens.filter((w) => !FILLERS.has(w.toLowerCase()));
  }
  return tokens;
}

/* ---------------- WER ---------------- */

/**
 * Word-level Levenshtein alignment of two token arrays.
 * @returns {{ sub: number, del: number, ins: number, ref: number, errors: number }}
 */
function editCounts(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  // cost[j] and its S/D/I breakdown for the previous and current rows.
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = { c: j, s: 0, d: 0, i: j };
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = { c: i, s: 0, d: i, i: 0 };
    for (let j = 1; j <= m; j++) {
      const diag = prev[j - 1];
      const same = ref[i - 1] === hyp[j - 1];
      let best = same
        ? { c: diag.c, s: diag.s, d: diag.d, i: diag.i }
        : { c: diag.c + 1, s: diag.s + 1, d: diag.d, i: diag.i };
      const up = prev[j];
      if (up.c + 1 < best.c) best = { c: up.c + 1, s: up.s, d: up.d + 1, i: up.i };
      const left = cur[j - 1];
      if (left.c + 1 < best.c) best = { c: left.c + 1, s: left.s, d: left.d, i: left.i + 1 };
      cur[j] = best;
    }
    prev = cur;
  }
  const last = prev[m];
  return { sub: last.s, del: last.d, ins: last.i, ref: n, errors: last.c };
}

/** Corpus-level (micro) WER: total edits over total reference words. */
function corpusWer(counts) {
  let errors = 0;
  let ref = 0;
  for (const c of counts) {
    errors += c.errors;
    ref += c.ref;
  }
  return ref ? errors / ref : 0;
}

/** Mean of per-utterance WER — reported beside corpusWer, never instead of it. */
function meanUtteranceWer(counts) {
  const scored = counts.filter((c) => c.ref > 0);
  if (!scored.length) return 0;
  return scored.reduce((sum, c) => sum + c.errors / c.ref, 0) / scored.length;
}

/* ---------------- statistics ---------------- */

/** Nearest-rank percentile (p in 0-100) of a list of numbers. */
function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/**
 * Speed of one model over a set of decodes, each `{ decodeMs, audioSec }`.
 * The headline is the aggregate RTF (total decode time over total audio), the
 * number Q3 judges; per-utterance p50/p95 describe the spread.
 */
function rtfStats(decodes) {
  let ms = 0;
  let sec = 0;
  const per = [];
  for (const d of decodes) {
    ms += d.decodeMs;
    sec += d.audioSec;
    if (d.audioSec > 0) per.push(d.decodeMs / 1000 / d.audioSec);
  }
  return {
    decodeRtf: sec ? ms / 1000 / sec : NaN,
    p50: percentile(per, 50),
    p95: percentile(per, 95),
    decodeSec: ms / 1000,
    audioSec: sec,
  };
}

/** Seeded PRNG (mulberry32), so a bootstrap interval is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired bootstrap of the WER difference (candidate minus baseline) between
 * two systems scored on the same utterances. Resamples CLUSTERS, not
 * utterances: FLEURS reads most sentences twice (different speakers), and
 * treating both readings as independent draws would overstate confidence.
 *
 * @param {Array<{ cluster: string, ref: number, baseErrors: number, candErrors: number }>} items
 * @returns {{ delta: number, lo: number, hi: number, winFraction: number, separable: boolean }}
 */
function pairedBootstrap(items, { iterations = 1000, seed = 1, alpha = 0.05 } = {}) {
  const clusters = new Map();
  for (const it of items) {
    const c = clusters.get(it.cluster) || { ref: 0, base: 0, cand: 0 };
    c.ref += it.ref;
    c.base += it.baseErrors;
    c.cand += it.candErrors;
    clusters.set(it.cluster, c);
  }
  const list = [...clusters.values()];
  const total = list.reduce((acc, c) => {
    acc.ref += c.ref;
    acc.base += c.base;
    acc.cand += c.cand;
    return acc;
  }, { ref: 0, base: 0, cand: 0 });
  const delta = total.ref ? (total.cand - total.base) / total.ref : 0;
  const rand = mulberry32(seed);
  const deltas = [];
  let wins = 0;
  for (let b = 0; b < iterations; b++) {
    let ref = 0;
    let diff = 0;
    for (let k = 0; k < list.length; k++) {
      const c = list[Math.floor(rand() * list.length)];
      ref += c.ref;
      diff += c.cand - c.base;
    }
    const d = ref ? diff / ref : 0;
    deltas.push(d);
    if (d < 0) wins++;
  }
  const lo = percentile(deltas, (alpha / 2) * 100);
  const hi = percentile(deltas, (1 - alpha / 2) * 100);
  return { delta, lo, hi, winFraction: wins / iterations, separable: lo > 0 || hi < 0 };
}

/* ---------------- the catalog threshold (stt-model-eval-Q3) ---------------- */

// A candidate earns a catalog entry when, against the shipped default on the
// same corpus and machine, either
//   (a) it is at least 1.3x faster in CPU realtime factor while its WER is no
//       more than 1.0 point (absolute) worse, or
//   (b) its WER is lower while it is no more than 1.1x slower.
const THRESHOLD = { speedup: 1.3, werSlack: 0.01, slowdown: 1.1 };

// Float tolerance for the two RTF ratio comparisons only — the WER sides are
// compared on integer error counts over the same reference words, exactly.
const RATIO_EPS = 1e-9;

/**
 * Apply Q3. `base` and `cand` are `{ errors, ref, decodeRtf }` measured on the
 * same utterances (so `ref` is equal and WER compares as error counts).
 * @returns {{ eligible: boolean, rule: "a" | "b" | null, speedup: number, deltaWer: number }}
 */
function classify(base, cand, threshold = THRESHOLD) {
  if (base.ref !== cand.ref) throw new Error("base and candidate were scored on different references");
  const speedup = base.decodeRtf / cand.decodeRtf;
  const slowdown = cand.decodeRtf / base.decodeRtf;
  const deltaWer = (cand.errors - base.errors) / base.ref;
  const a =
    speedup >= threshold.speedup - RATIO_EPS &&
    cand.errors <= base.errors + threshold.werSlack * base.ref;
  const b = cand.errors < base.errors && slowdown <= threshold.slowdown + RATIO_EPS;
  return { eligible: a || b, rule: a ? "a" : b ? "b" : null, speedup, deltaWer };
}

// stt-model-eval-Q5 as revised by Q7: a candidate that clears Q3 on short
// clips is still incompatible if it loses words on a long single-buffer
// recording (the path taken with live preview off) — the Whisper 30 s window
// failure mode — judged RELATIVE to the shipped default, which itself loses
// words on long buffers. At any long-form length it is incompatible if
//   (a) its word ratio is more than 0.10 below the default's,
//   (b) its wer_norm is more than 5 points above the default's, or
//   (c) it fails (error or empty output) where the default did not;
// and at ~60 s alone (where the default holds 0.988) its word ratio must also
// be at least 0.9 absolute.
const LONG_FORM = { ratioSlack: 0.1, werSlack: 0.05, minWordRatio: 0.9, absoluteAt: "60s" };

// "More than" is compared with a float tolerance, so 0.45 - 0.10 = 0.35 is a
// boundary that passes rather than a rounding accident.
const LONG_FORM_EPS = 1e-9;

const failedClip = (c) => Boolean(c.error) || !(c.wordRatio > 0);

/**
 * @param {Array<{ label: string, wordRatio: number, wer: number, error?: string,
 *   base: { wordRatio: number, wer: number, error?: string } }>} clips
 * @returns {{ compatible: boolean, reasons: string[] }}
 */
function longFormCompatible(clips, limits = LONG_FORM) {
  const reasons = [];
  for (const c of clips) {
    const base = c.base;
    if (failedClip(c)) {
      if (!failedClip(base)) reasons.push(`${c.label}: failed (${c.error || "empty output"}) where the default did not`);
      continue;
    }
    if (c.wordRatio < base.wordRatio - limits.ratioSlack - LONG_FORM_EPS) {
      reasons.push(`${c.label}: word ratio ${c.wordRatio.toFixed(3)} is more than ${limits.ratioSlack} below the default's ${base.wordRatio.toFixed(3)}`);
    }
    if (c.wer > base.wer + limits.werSlack + LONG_FORM_EPS) {
      reasons.push(`${c.label}: wer_norm ${(c.wer * 100).toFixed(2)} % is more than ${limits.werSlack * 100} points above the default's ${(base.wer * 100).toFixed(2)} %`);
    }
    if (c.label === limits.absoluteAt && c.wordRatio < limits.minWordRatio - LONG_FORM_EPS) {
      reasons.push(`${c.label}: word ratio ${c.wordRatio.toFixed(3)} < ${limits.minWordRatio}`);
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

/* ---------------- judging a run ---------------- */

// Is a speed row clean, and if not, why. In the pass itself: the quiet gate
// held and no other-run process was seen (row.contended). At combine time, the
// same rule for every row (DV10, proposed after one row's number was seen and
// stated as such in the PR): the 1-minute load at the END of the decodes must
// not exceed the harness's own threads plus the quiet limit — the gate only
// looks at the load before a model starts.
function speedCleanliness(row, res, { quietLoad }) {
  if (!row || row.status !== "measured") return { clean: false, reason: row ? `${row.status}: ${row.reason}` : "not measured" };
  if (row.contended) {
    const other = row.otherRun && row.otherRun.active !== false;
    return { clean: false, reason: other ? "other run seen during the decodes" : "quiet gate did not hold" };
  }
  const limit = res.machine.appThreads + (row.quietWait ? row.quietWait.limit : quietLoad);
  const end = row.loadavgAfter[0];
  if (end > limit) return { clean: false, reason: `end-of-decode 1-min load ${end.toFixed(1)} > ${limit} (DV10)` };
  return { clean: true, reason: null };
}

// A speed file's own first/last default runs: both clean and within the
// allowed drift, or none of its rows count.
function speedFileBrackets(res, cfg) {
  const first = res.rows.find((r) => r.role === "bracket-first");
  const last = res.rows.find((r) => r.role === "bracket-last");
  if (!first || !last || first.status !== "measured" || last.status !== "measured") {
    return { stable: false, reason: "missing first/last default run" };
  }
  const drift = Math.abs(last.decodeRtf - first.decodeRtf) / first.decodeRtf;
  const cf = speedCleanliness(first, res, cfg);
  const cl = speedCleanliness(last, res, cfg);
  const stable = cf.clean && cl.clean && drift <= cfg.bracketDrift;
  return {
    stable,
    first: first.decodeRtf,
    last: last.decodeRtf,
    drift,
    reason: stable ? null : cf.reason || cl.reason || `drift ${(drift * 100).toFixed(1)} % > ${cfg.bracketDrift * 100} %`,
  };
}

const speedFields = (s, ref, file, res) => ({
  decodeRtf: s.decodeRtf, p50Rtf: s.p50Rtf, p95Rtf: s.p95Rtf, wallRtf: s.wallRtf,
  coldLoadWallMs: s.coldLoadWallMs, firstDecodeMs: s.firstDecodeMs,
  otherRunIdle: Boolean(s.otherRun && s.otherRun.active === false),
  otherRunSamples: s.otherRun && s.otherRun.samples,
  loadavg: [s.loadavgBefore[0], s.loadavgAfter[0]],
  file,
  heldCpuLock: Boolean(res.cpuLock && res.cpuLock.role === "held for the whole pass"),
  refDecodeRtf: ref ? ref.decodeRtf : null,
});

/**
 * Judge every candidate of a run, in place. WER comes from `acc` (the full
 * corpus); decode RTF only from clean rows of the speed results `spds`
 * ([{ res, name }], in order: the speed pass, then any re-measures — or the run
 * itself for a single quiet run). A row's speed is its FIRST clean attempt in
 * a file whose own first/last default runs are clean and stable, compared with
 * THAT file's default (the calibration row for the exploratory arm) — never
 * one run's number against another run's default. Every attempt is kept in
 * row.speedAttempts so the report can show the ones not used.
 * cfg: { baselineId, quietLoad, bracketDrift }.
 */
function judge(acc, spds, cfg) {
  const key = (r) => `${r.id}|${r.role}`;
  const files = spds.map(({ res, name }) => ({
    res,
    name,
    brackets: speedFileBrackets(res, cfg),
    rows: new Map(res.rows.map((r) => [key(r), r])),
  }));
  acc.speedFiles = files.map((f) => ({ file: f.name, subset: f.res.corpus.subset, utterances: f.res.corpus.utterances, brackets: f.brackets }));
  acc.brackets = files[0] ? files[0].brackets : null;
  acc.speedClean = Boolean(files[0] && files[0].brackets.stable);
  const refRole = (r) => (r.arm === "exploratory" || r.role === "calibration" ? "calibration" : "bracket-first");
  for (const r of acc.rows) {
    r.speedAttempts = [];
    r.speed = null;
    for (const f of files) {
      const s = f.rows.get(key(r));
      if (!s) continue;
      const c = speedCleanliness(s, f.res, cfg);
      const ref = f.rows.get(`${cfg.baselineId}|${refRole(r)}`);
      const refClean = Boolean(ref && speedCleanliness(ref, f.res, cfg).clean);
      const usable = c.clean && f.brackets.stable && refClean;
      const reason = !c.clean
        ? c.reason
        : !f.brackets.stable
          ? `its file's first/last default: ${f.brackets.reason}`
          : !refClean ? "its reference default run is not clean" : null;
      const attempt = { file: f.name, decodeRtf: s.decodeRtf, endLoad: s.loadavgAfter[0], usable, reason, used: false };
      r.speedAttempts.push(attempt);
      if (usable && !r.speed) {
        r.speed = speedFields(s, ref, f.name, f.res);
        attempt.used = true;
      }
    }
  }
  const first = acc.rows.find((r) => r.role === "bracket-first" && r.status === "measured");
  const calib = acc.rows.find((r) => r.role === "calibration" && r.status === "measured");
  const index = acc.corpus.utteranceIndex;
  for (const r of acc.rows) {
    if (r.status !== "measured" || r.role === "bracket-first" || r.role === "bracket-last" || r.role === "calibration") continue;
    const ref = r.arm === "exploratory" ? calib : first;
    if (!ref) continue;
    const bootstrap = pairedBootstrap(
      index.map((u, i) => ({ cluster: u.sentenceId, ref: u.refWords, baseErrors: ref.perUtteranceErrors[i], candErrors: r.perUtteranceErrors[i] }))
    );
    const deltaWer = (r.errors - ref.errors) / ref.ref;
    const against = r.arm === "exploratory" ? "calibration (direct path)" : "bracket-first (worker)";
    // More than werSlack worse fails (a), and not lower fails (b): no speed
    // number can rescue it, so the verdict says so rather than "not measured".
    const werRulesOut = r.errors > ref.errors + THRESHOLD.werSlack * ref.ref;
    r.eligible = false;
    if (!r.speed || !ref.speed) {
      r.vsDefault = { eligible: false, rule: null, speedup: null, deltaWer, bootstrap, against };
      r.verdict = r.role === "baseline"
        ? "shipped"
        : werRulesOut
          ? "does not clear Q3 (WER alone rules out both rules; speed not measured cleanly)"
          : "speed not measured cleanly — no speed-based verdict";
      continue;
    }
    r.vsDefault = {
      ...classify({ errors: ref.errors, ref: ref.ref, decodeRtf: r.speed.refDecodeRtf }, { errors: r.errors, ref: r.ref, decodeRtf: r.speed.decodeRtf }),
      bootstrap,
      against,
    };
    if (r.role === "baseline") {
      // Already in the catalog: compared for information, never a verdict.
      r.verdict = "shipped";
      continue;
    }
    if (!r.vsDefault.eligible) {
      r.verdict = "does not clear Q3";
      continue;
    }
    const baseLong = ref.longForm;
    r.longFormCheck = r.longForm && baseLong
      ? longFormCompatible(r.longForm.map((l, i) => ({ ...l, base: baseLong[i] })))
      : { compatible: false, reasons: ["long-form not measured"] };
    // Q2: a family the worker cannot run is never catalogued from the
    // exploratory arm; it is wired in and re-measured through the worker first.
    r.eligible = r.longFormCheck.compatible && r.arm === "wired";
    r.verdict = !r.longFormCheck.compatible
      ? "incompatible on long audio"
      : r.arm === "wired"
        ? `eligible (rule ${r.vsDefault.rule})`
        : `clears Q3 on the exploratory arm (rule ${r.vsDefault.rule}) — wire and re-measure`;
  }
}

/* ---------------- what a run measures, in order ---------------- */

/**
 * The measurement order: the default first (every candidate is judged against
 * it), the other shipped models, the wired candidates, the exploratory arm
 * behind its calibration row, and — for a timed pass — the default again to
 * show the machine stayed as quiet as it began.
 *
 * A candidate that has since been catalogued stays a CANDIDATE: it is measured
 * once, from its catalog payload (test/engines.test.js holds that payload
 * byte-identical to its manifest pins), and still goes through Q3 and the
 * long-form check — so a rerun reproduces the decision that catalogued it.
 * Only shipped models that were never candidates are verdict-free baselines.
 */
function planModels(shipped, candidates, { baselineId, exploratory = false, pass = "both", models = null }) {
  const def = shipped.find((m) => m.id === baselineId);
  if (!def) throw new Error(`the baseline ${baselineId} is not in the catalog`);
  const candidateIds = new Set(candidates.map((c) => c.id));
  const list = [{ model: def, role: "bracket-first", arm: "shipped" }];
  for (const m of shipped) {
    if (m.id !== def.id && !candidateIds.has(m.id)) list.push({ model: m, role: "baseline", arm: "shipped" });
  }
  for (const c of candidates.filter((x) => x.arm === "wired")) {
    const catalogued = shipped.find((m) => m.id === c.id);
    list.push({ model: catalogued || c, role: "candidate", arm: "wired", catalogued: Boolean(catalogued) });
  }
  if (exploratory) {
    list.push({ model: def, role: "calibration", arm: "exploratory" });
    for (const c of candidates.filter((x) => x.arm === "exploratory")) {
      list.push({ model: c, role: "candidate", arm: "exploratory", catalogued: false });
    }
  }
  // The closing bracket only checks the machine stayed quiet: speed's concern.
  if (pass !== "accuracy") list.push({ model: def, role: "bracket-last", arm: "shipped" });
  return models ? list.filter((x) => models.includes(x.model.id)) : list;
}

/* ---------------- resuming a run ---------------- */

// What must match before --resume may reuse a single row of an earlier --out
// file: the same kind of pass over the same corpus selection, on the same
// runtime, by the same measuring code. `acrossCode` (--resume-across-code) is
// the one deliberate exception, for the measuring code only; it is recorded in
// the result, never silent.
const RUNTIME_FIELDS = ["cpu", "logicalCpus", "appThreads"];
const RUNTIME_VERSIONS = ["electron", "sherpaOnnxNode"];

/**
 * @returns {{ ok: boolean, problems: string[] }}
 */
function resumeCompatibility(previous, current, { acrossCode = false } = {}) {
  const problems = [];
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label}: ${JSON.stringify(a)} in the file, ${JSON.stringify(b)} now`);
  };
  const pc = previous.corpus || {};
  const pm = previous.machine || {};
  same("schema", previous.schema, current.schema);
  same("pass", previous.pass, current.pass);
  same("corpus commit", pc.commit, current.corpus.commit);
  same("corpus files", (pc.files || []).map((f) => f.sha256), current.corpus.files.map((f) => f.sha256));
  same("corpus subset", pc.subset, current.corpus.subset);
  same("utterances", pc.utterances, current.corpus.utterances);
  for (const k of RUNTIME_FIELDS) same(`machine.${k}`, pm[k], current.machine[k]);
  for (const k of RUNTIME_VERSIONS) same(`versions.${k}`, (pm.versions || {})[k], current.machine.versions[k]);
  if (!acrossCode) same("measuring code", pm.measuringCode, current.machine.measuringCode);
  return { ok: problems.length === 0, problems };
}

/**
 * May this earlier row stand in for measuring `model` now? Only a measured row
 * whose files are the very files the model pins today (a re-pinned model is
 * a different model).
 */
function rowReusable(row, model) {
  if (!row || row.status !== "measured" || !Array.isArray(row.files)) return false;
  const pins = (files) => files.map((f) => `${f.name}:${f.sha256}`).sort().join("|");
  return pins(row.files) === pins(model.files);
}

/* ---------------- the exploratory recognizer config ---------------- */

// scripts/stt-eval-worker.js builds sherpa-onnx recognizers for families the
// app's worker has no config for yet. The settings copy the app's worker
// (16 kHz, 80-dim features, the given runtime) — a copy, which is why its rows
// are compared only with the default measured the same way.
const FEATURE_DIM = 80;

/**
 * The OfflineRecognizer config for a model's `sherpa` block, by family:
 * transducer (has a joiner), whisper, moonshine, nemoCtc, canary.
 */
function sherpaRecognizerConfig(dir, s, runtime) {
  const p = (f) => joinPath(dir, f);
  const family = s.family || (s.joiner ? "transducer" : "whisper");
  let modelFiles;
  switch (family) {
    case "transducer":
      modelFiles = { transducer: { encoder: p(s.encoder), decoder: p(s.decoder), joiner: p(s.joiner) } };
      break;
    case "whisper":
      modelFiles = { whisper: { encoder: p(s.encoder), decoder: p(s.decoder) } };
      break;
    case "moonshine":
      modelFiles = {
        moonshine: {
          preprocessor: p(s.preprocessor),
          encoder: p(s.encoder),
          uncachedDecoder: p(s.uncachedDecoder),
          cachedDecoder: p(s.cachedDecoder),
        },
      };
      break;
    case "nemoCtc":
      modelFiles = { nemoCtc: { model: p(s.model) } };
      break;
    case "canary":
      modelFiles = { canary: { encoder: p(s.encoder), decoder: p(s.decoder), srcLang: "en", tgtLang: "en", usePnc: 1 } };
      break;
    default:
      throw new Error(`unknown sherpa family: ${s.family}`);
  }
  const modelType = s.modelType || (family === "transducer" ? "nemo_transducer" : undefined);
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      ...modelFiles,
      tokens: p(s.tokens),
      ...runtime,
      ...(modelType ? { modelType } : {}),
      debug: false,
    },
  };
}

/* ---------------- the speed subset ---------------- */

// Speed is measured on a quiet machine, and a shared machine is quiet in short
// windows, so the speed pass decodes a fixed quarter of the corpus rather than
// all of it: every SPEED_SUBSET_EVERY-th sentence cluster, by numeric FLEURS
// sentence id, with every reading of a kept sentence. Declared before any
// number existed; accuracy is always scored on the full corpus.
const SPEED_SUBSET_EVERY = 4;

function speedSubset(clips, every = SPEED_SUBSET_EVERY) {
  const ids = [...new Set(clips.map((c) => c.sentenceId))].sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b))
  );
  const keep = new Set(ids.filter((_, i) => i % every === 0));
  return clips.filter((c) => keep.has(c.sentenceId));
}

/* ---------------- hypothesis style indicators ---------------- */

/** How a model's raw output looks, before any normalisation hides it. */
function styleRates(hypotheses) {
  const n = hypotheses.length || 1;
  let punct = 0;
  let caps = 0;
  let words = 0;
  let fillers = 0;
  for (const h of hypotheses) {
    if (/[.?!,]/.test(h)) punct++;
    if (/\p{Lu}/u.test(h)) caps++;
    const tokens = normalise(h, { numbers: false, fillers: false });
    words += tokens.length;
    fillers += tokens.filter((w) => FILLERS.has(w)).length;
  }
  return {
    punctuationRate: punct / n,
    capitalisationRate: caps / n,
    hesitationsPer1000Words: words ? (fillers / words) * 1000 : 0,
  };
}

/* ---------------- corpus plumbing ---------------- */

/**
 * Parse a FLEURS split tsv: id, file, raw transcription, normalised
 * transcription, characters, num_samples, gender.
 */
function parseFleursTsv(text) {
  const rows = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length !== 7) throw new Error(`tsv line ${i + 1}: expected 7 fields, got ${f.length}`);
    const numSamples = Number(f[5]);
    if (!Number.isInteger(numSamples) || numSamples <= 0) {
      throw new Error(`tsv line ${i + 1}: bad num_samples "${f[5]}"`);
    }
    rows.push({
      sentenceId: f[0],
      file: f[1],
      raw: f[2],
      normalized: f[3],
      numSamples,
      gender: f[6].trim(),
    });
  }
  return rows;
}

/**
 * Parse-check: the raw and FLEURS-normalised columns must spell the same
 * letters. A mismatch means the columns were read wrong, not that a reference
 * is noisy. Returns the rows that disagree.
 */
function tsvColumnMismatches(rows) {
  const letters = (s) => s.toLowerCase().replace(/[^\p{L}]/gu, "");
  return rows.filter((r) => letters(r.raw) !== letters(r.normalized));
}

function octal(buf, start, len) {
  // GNU base-256 for sizes past 8 GiB: high bit set on the first byte.
  if (buf[start] & 0x80) {
    let n = buf[start] & 0x7f;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = buf.toString("ascii", start, start + len).replace(/[\0 ]+$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function cstring(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.toString("utf8", start, end < 0 || end > start + len ? start + len : end);
}

function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const len = parseInt(data.toString("ascii", pos, space), 10);
    if (!len) break;
    const record = data.toString("utf8", space + 1, pos + len - 1);
    const eq = record.indexOf("=");
    out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/**
 * Walk a tar archive (POSIX ustar or GNU) through `readAt(offset, length)`,
 * yielding `{ name, offset, size }` for each regular file. Handles GNU long
 * names ("L") and pax headers ("x"/"g"); skips directories; refuses links and
 * anything else rather than guess.
 */
function* tarEntries(readAt, totalSize) {
  let pos = 0;
  let longName = null;
  let pax = {};
  while (pos + 512 <= totalSize) {
    const h = readAt(pos, 512);
    if (h.every((b) => b === 0)) return; // end-of-archive block
    const stored = octal(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== stored) throw new Error(`tar header checksum mismatch at offset ${pos}`);
    const magic = h.toString("ascii", 257, 263);
    if (!magic.startsWith("ustar")) throw new Error(`not a ustar/GNU tar header at offset ${pos}`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const dataAt = pos + 512;
    const next = dataAt + Math.ceil(size / 512) * 512;
    let name = cstring(h, 0, 100);
    // POSIX ustar splits long paths into prefix/name; GNU uses that space
    // for other fields, so only read the prefix under the POSIX magic.
    if (magic === "ustar\0") {
      const prefix = cstring(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (type === "L") {
      longName = cstring(readAt(dataAt, size), 0, size);
    } else if (type === "x") {
      pax = parsePax(readAt(dataAt, size));
    } else if (type === "g") {
      // Global pax header: nothing we rely on.
    } else if (type === "5") {
      longName = null;
      pax = {};
    } else if (type === "0" || type === "\0" || type === "7") {
      yield { name: pax.path || longName || name, offset: dataAt, size };
      longName = null;
      pax = {};
    } else {
      throw new Error(`unsupported tar entry type "${type}" for ${name}`);
    }
    pos = next;
  }
}

/** A `readAt` over an in-memory buffer, for tarEntries. */
const bufferReader = (buf) => (offset, length) => buf.subarray(offset, offset + length);

// Level normalisation, standing in for the overlay's microphone capture: it
// records with autoGainControl on (renderer/overlay.js), so a model in the app
// never sees a -44 dBFS recording — and FLEURS has many (peaks of 0.006 full
// scale), on which Parakeet returns nothing once the buffer passes ~12 s.
// Every clip, for every model, gets the same gain: to TARGET_RMS, capped so
// the peak stays under PEAK_CEILING. Applied before quantising to PCM16, as
// AGC acts before the overlay's encoder does.
const TARGET_RMS = 0.1; // -20 dBFS
const PEAK_CEILING = 0.99;

/** The gain that brings `samples` (float, [-1, 1]) to TARGET_RMS, peak-capped. */
function levelGain(samples) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (!peak) return 1;
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(TARGET_RMS / rms, PEAK_CEILING / peak);
}

/**
 * Re-encode a mono WAV as the exact PCM16 bytes Earheart's overlay produces
 * (renderer/overlay.js: clamp to [-1, 1], scale by 0x8000 below zero and
 * 0x7fff above, truncate into an Int16Array), so the engine worker parses it
 * with its own wavToFloat32. Accepts IEEE float32 (FLEURS) or PCM16. With
 * `level: true` the samples are first normalised (see levelGain).
 * @returns {{ wav: Buffer, pcm: Int16Array, sampleRate: number, gain: number }}
 */
function toPcm16Wav(buf, { level = false } = {}) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV is missing its fmt or data chunk");
  if (fmt.channels !== 1) throw new Error(`expected mono, got ${fmt.channels} channels`);
  if (fmt.sampleRate !== SAMPLE_RATE) throw new Error(`expected ${SAMPLE_RATE} Hz, got ${fmt.sampleRate}`);
  let floats;
  if (fmt.format === 3 && fmt.bits === 32) {
    floats = new Float32Array(Math.floor(data.length / 4));
    for (let i = 0; i < floats.length; i++) floats[i] = data.readFloatLE(i * 4);
  } else if (fmt.format === 1 && fmt.bits === 16) {
    floats = new Float32Array(Math.floor(data.length / 2));
    for (let i = 0; i < floats.length; i++) floats[i] = data.readInt16LE(i * 2) / 32768;
  } else {
    throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
  }
  const gain = level ? levelGain(floats) : 1;
  const pcm = new Int16Array(floats.length);
  if (fmt.format === 1 && gain === 1) {
    // Already the overlay's format: keep the samples bit-exact.
    for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
    return { wav: encodeWav(pcm, SAMPLE_RATE), pcm, sampleRate: SAMPLE_RATE, gain };
  }
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i] * gain));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return { wav: encodeWav(pcm, SAMPLE_RATE), pcm, sampleRate: SAMPLE_RATE, gain };
}

/* ---------------- pin discovery ---------------- */

/**
 * The sha256 a Hugging Face `x-linked-etag` header vouches for, or null. For
 * an LFS file the etag IS the content sha256 (64 hex, quoted); for a small
 * file kept in git (tokens.txt) it is the 40-hex git blob id, which is not a
 * content hash at all — that file has to be downloaded and hashed instead.
 */
function sha256FromLinkedEtag(etag) {
  const v = String(etag || "").replace(/^W\//, "").replace(/"/g, "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** Join PCM16 clips with `gapSamples` of silence between them. */
function concatPcm16(clips, gapSamples) {
  const total = clips.reduce((n, c) => n + c.length, 0) + gapSamples * Math.max(0, clips.length - 1);
  const out = new Int16Array(total);
  let at = 0;
  clips.forEach((c, i) => {
    if (i) at += gapSamples;
    out.set(c, at);
    at += c.length;
  });
  return out;
}

module.exports = {
  FILLERS,
  ALL_STAGES,
  VERBATIM,
  THRESHOLD,
  LONG_FORM,
  intToWords,
  yearToWords,
  verbaliseNumbers,
  hasUnmodelledConstruct,
  normalise,
  editCounts,
  corpusWer,
  meanUtteranceWer,
  percentile,
  rtfStats,
  mulberry32,
  pairedBootstrap,
  classify,
  longFormCompatible,
  SPEED_SUBSET_EVERY,
  speedSubset,
  speedCleanliness,
  speedFileBrackets,
  judge,
  resumeCompatibility,
  rowReusable,
  planModels,
  sherpaRecognizerConfig,
  styleRates,
  parseFleursTsv,
  tsvColumnMismatches,
  tarEntries,
  bufferReader,
  TARGET_RMS,
  PEAK_CEILING,
  levelGain,
  toPcm16Wav,
  concatPcm16,
  sha256FromLinkedEtag,
};
