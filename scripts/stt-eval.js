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
// fractions) are left alone and flagged by hasUnmodelledConstruct, so the
// harness can report WER with and without them — if the ranking holds on both,
// the normalisation is not what decided it.
//
// `wer_verbatim` is N0 + N5 only: case and punctuation intact, which is what
// Earheart actually pastes.

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
// suffix. Never glued to a letter, digit, or "." on either side — "F1",
// "802.11n" and "70km" stay as they are (and are flagged as unmodelled).
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

// stt-model-eval-Q5: a candidate that clears Q3 on short clips is still
// incompatible if it drops words on a long single-buffer recording (the path
// taken with live preview off) — the Whisper 30 s window failure mode.
const LONG_FORM = { minWordRatio: 0.9, werSlack: 0.05 };

/**
 * @param {Array<{ label: string, wordRatio: number, wer: number, baseWer: number }>} clips
 * @returns {{ compatible: boolean, reasons: string[] }}
 */
function longFormCompatible(clips, limits = LONG_FORM) {
  const reasons = [];
  for (const c of clips) {
    if (c.wordRatio < limits.minWordRatio) {
      reasons.push(`${c.label}: hypothesis/reference word ratio ${c.wordRatio.toFixed(3)} < ${limits.minWordRatio}`);
    }
    if (c.wer > c.baseWer + limits.werSlack) {
      reasons.push(`${c.label}: wer_norm ${(c.wer * 100).toFixed(2)} > default ${(c.baseWer * 100).toFixed(2)} + ${limits.werSlack * 100}`);
    }
  }
  return { compatible: reasons.length === 0, reasons };
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

/**
 * Re-encode a mono WAV as the exact PCM16 bytes Earheart's overlay produces
 * (renderer/overlay.js: clamp to [-1, 1], scale by 0x8000 below zero and
 * 0x7fff above, truncate into an Int16Array), so the engine worker parses it
 * with its own wavToFloat32. Accepts IEEE float32 (FLEURS) or PCM16.
 * @returns {{ wav: Buffer, pcm: Int16Array, sampleRate: number }}
 */
function toPcm16Wav(buf) {
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
  let pcm;
  if (fmt.format === 3 && fmt.bits === 32) {
    const count = Math.floor(data.length / 4);
    pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const s = Math.max(-1, Math.min(1, data.readFloatLE(i * 4)));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  } else if (fmt.format === 1 && fmt.bits === 16) {
    const count = Math.floor(data.length / 2);
    pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) pcm[i] = data.readInt16LE(i * 2);
  } else {
    throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
  }
  return { wav: encodeWav(pcm, SAMPLE_RATE), pcm, sampleRate: SAMPLE_RATE };
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
  styleRates,
  parseFleursTsv,
  tsvColumnMismatches,
  tarEntries,
  bufferReader,
  toPcm16Wav,
  concatPcm16,
  sha256FromLinkedEtag,
};
