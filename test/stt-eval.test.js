// Tests for the speech-to-text evaluation. Most cover the pure helpers in
// scripts/stt-eval.js — the normalisation and WER that decide the accuracy
// column, the statistics, the Q3/Q5 rules and judging, planning and resume
// checks, and the corpus plumbing. The rest drive what can run without models:
// scripts/eval-stt.js's combine/report/argument parsing and its recognizers'
// timeout handling (against stubs), and scripts/stt-eval-worker.js with a
// stubbed addon. A real measurement run needs Electron, the network and
// multi-GB models, so it is not in the suite.

const { test } = require("node:test");
const assert = require("node:assert");

const { wavToFloat32, encodeWav } = require("../main/util/wav");
const e = require("../scripts/stt-eval");

/* ---------------- normalisation ---------------- */

test("stt-eval: cardinals, years, and the number shapes N3 models", () => {
  assert.strictEqual(e.intToWords(0), "zero");
  assert.strictEqual(e.intToWords(7), "seven");
  assert.strictEqual(e.intToWords(19), "nineteen");
  assert.strictEqual(e.intToWords(100), "one hundred");
  assert.strictEqual(e.intToWords(40000), "forty thousand");
  assert.strictEqual(e.intToWords(330117), "three hundred thirty thousand one hundred seventeen");
  assert.strictEqual(e.yearToWords(1963), "nineteen sixty three");
  assert.strictEqual(e.yearToWords(1900), "nineteen hundred");
  assert.strictEqual(e.yearToWords(1905), "nineteen oh five");
  assert.strictEqual(e.yearToWords(2005), "two thousand five");
  assert.strictEqual(e.yearToWords(2017), "twenty seventeen");
  assert.strictEqual(e.yearToWords(1000), "one thousand");

  const n = (s) => e.normalise(s).join(" ");
  assert.strictEqual(n("In 1963,"), "in nineteen sixty three");
  assert.strictEqual(n("40,000 people"), "forty thousand people");
  assert.strictEqual(n("2.5 km"), "two point five km");
  assert.strictEqual(n("20% of it"), "twenty percent of it");
  assert.strictEqual(n("the 3rd and 13th"), "the third and thirteenth");
  assert.strictEqual(n("the 1960s and 20s"), "the nineteen sixties and twenties");
  assert.strictEqual(n("the 1800s"), "the eighteen hundreds");
  assert.strictEqual(n("$5 and $1"), "five dollars and one dollar");
  // The spoken form and the digit form of the same reading meet in the middle.
  assert.strictEqual(n("one-hundred percent"), n("100%"));
  assert.strictEqual(n("Nineteen sixty-three."), n("1963."));
});

test("stt-eval: constructs N3 does not model are left alone and flagged", () => {
  for (const raw of [
    "between 10:00-11:00 pm",
    "at 06:30 and 07:30.",
    "and F1 motor racing",
    "the 802.11n standard",
    "reaching 70km/h",
    "it measures 29¾ inches",
    "price is ~500 francs",
    "from 1000–1300",
    "after reaching 6-6.",
  ]) {
    assert.ok(e.hasUnmodelledConstruct(raw), raw);
  }
  for (const raw of ["In 1963, the dam", "40,000.", "(2006),", "a 20% share", "the 1960s.", "$100"]) {
    assert.ok(!e.hasUnmodelledConstruct(raw), raw);
  }
  // Alphanumerics are not spelled out, so both sides keep the same token.
  assert.deepStrictEqual(e.normalise("F1 and M16"), ["f1", "and", "m16"]);
  // A number before a "." glued to more characters IS partly spelled out — the
  // behaviour the published numbers were measured with, pinned as it is — and
  // every such token is flagged as unmodelled.
  assert.deepStrictEqual(e.normalise("the 802.11n standard"), ["the", "eight", "hundred", "two", "11n", "standard"]);
  assert.deepStrictEqual(e.normalise("5.0Ghz and 2.4Ghz"), ["five", "0ghz", "and", "two", "4ghz"]);
  assert.deepStrictEqual(e.normalise("v1.2 build"), ["v1", "2", "build"]);
  for (const raw of ["the 802.11n standard", "5.0Ghz and 2.4Ghz", "v1.2 build"]) {
    assert.ok(e.hasUnmodelledConstruct(raw), raw);
  }
});

test("stt-eval: each normalisation stage does one thing and can be switched off", () => {
  const text = "“Um, it’s 20% — Done.”";
  assert.deepStrictEqual(e.normalise(text), ["it's", "twenty", "percent", "done"]);
  assert.deepStrictEqual(e.normalise(text, { lowercase: false }), ["it's", "twenty", "percent", "Done"]);
  assert.deepStrictEqual(e.normalise(text, { numbers: false }), ["it's", "20", "done"]);
  assert.deepStrictEqual(e.normalise(text, { fillers: false }), ["um", "it's", "twenty", "percent", "done"]);
  assert.deepStrictEqual(e.normalise(text, { punctuation: false }), ['"um,', "it's", "twenty", "percent", "-", 'done."']);
  // Verbatim keeps case and punctuation: only N0 (typography) and N5 run.
  assert.deepStrictEqual(e.normalise(text, e.VERBATIM), ['"Um,', "it's", "20%", "-", 'Done."']);
});

test("stt-eval: normalisation is idempotent and keeps intra-word apostrophes", () => {
  for (const s of ["Don't stop — it's 1963!", "'quoted' words", "The U.S. Corps", "self-driving cars"]) {
    const once = e.normalise(s);
    assert.deepStrictEqual(e.normalise(once.join(" ")), once, s);
  }
  assert.deepStrictEqual(e.normalise("'quoted' don't"), ["quoted", "don't"]);
  assert.deepStrictEqual(e.normalise("self-driving"), ["self", "driving"]);
});

test("stt-eval: fillers are dropped only as whole tokens", () => {
  // "mm" is a hesitation; "35mm" is a film format and must survive.
  assert.deepStrictEqual(e.normalise("um the 35mm uh format mm"), ["the", "35mm", "format"]);
});

/* ---------------- WER ---------------- */

test("stt-eval: WER identity, empty hypothesis, and hand-worked edits", () => {
  const ref = ["the", "cat", "sat", "on", "the", "mat"];
  assert.deepStrictEqual(e.editCounts(ref, ref), { sub: 0, del: 0, ins: 0, ref: 6, errors: 0 });
  assert.deepStrictEqual(e.editCounts(ref, []), { sub: 0, del: 6, ins: 0, ref: 6, errors: 6 });
  assert.deepStrictEqual(e.editCounts([], ["a", "b"]), { sub: 0, del: 0, ins: 2, ref: 0, errors: 2 });
  // one substitution
  assert.deepStrictEqual(
    e.editCounts(ref, ["the", "dog", "sat", "on", "the", "mat"]),
    { sub: 1, del: 0, ins: 0, ref: 6, errors: 1 }
  );
  // one deletion
  assert.deepStrictEqual(
    e.editCounts(ref, ["the", "cat", "on", "the", "mat"]),
    { sub: 0, del: 1, ins: 0, ref: 6, errors: 1 }
  );
  // one insertion
  assert.deepStrictEqual(
    e.editCounts(ref, ["the", "cat", "sat", "down", "on", "the", "mat"]),
    { sub: 0, del: 0, ins: 1, ref: 6, errors: 1 }
  );
  // A shuffled hypothesis of the same words is mostly wrong.
  const shuffled = ["mat", "the", "on", "sat", "cat", "the"];
  assert.ok(e.editCounts(ref, shuffled).errors >= 4);
});

test("stt-eval: corpus WER weights by words; the per-utterance mean does not", () => {
  const counts = [
    { errors: 1, ref: 1 }, // a one-word utterance, fully wrong
    { errors: 0, ref: 99 },
  ];
  assert.strictEqual(e.corpusWer(counts), 0.01);
  assert.strictEqual(e.meanUtteranceWer(counts), 0.5);
  assert.strictEqual(e.corpusWer([]), 0);
});

/* ---------------- statistics ---------------- */

test("stt-eval: percentile and RTF aggregation", () => {
  assert.strictEqual(e.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.strictEqual(e.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.ok(Number.isNaN(e.percentile([], 50)));
  const stats = e.rtfStats([
    { decodeMs: 1000, audioSec: 10 },
    { decodeMs: 3000, audioSec: 10 },
  ]);
  // Aggregate is total decode over total audio, not a mean of ratios.
  assert.strictEqual(stats.decodeRtf, 0.2);
  assert.strictEqual(stats.p50, 0.1);
  assert.strictEqual(stats.p95, 0.3);
  assert.strictEqual(stats.audioSec, 20);
});

test("stt-eval: the bootstrap is seeded and resamples whole clusters", () => {
  const items = [];
  for (let s = 0; s < 40; s++) {
    // Two readings per sentence; the candidate is better on every fourth one.
    for (let reading = 0; reading < 2; reading++) {
      items.push({ cluster: `s${s}`, ref: 10, baseErrors: 1, candErrors: s % 4 === 0 ? 0 : 1 });
    }
  }
  const a = e.pairedBootstrap(items, { seed: 7 });
  const b = e.pairedBootstrap(items, { seed: 7 });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.delta, -20 / 800);
  assert.ok(a.hi < 0 && a.separable);
  assert.ok(a.winFraction > 0.95);

  // Identical systems: interval straddles 0 and is "not separable".
  const same = e.pairedBootstrap(items.map((it) => ({ ...it, candErrors: it.baseErrors })));
  assert.strictEqual(same.delta, 0);
  assert.ok(same.lo <= 0 && same.hi >= 0);
  assert.strictEqual(same.separable, false);

  // Readings of one sentence travel together: with a single cluster, every
  // resample draws that cluster whole, so the interval collapses to a point.
  const one = e.pairedBootstrap([
    { cluster: "x", ref: 10, baseErrors: 3, candErrors: 1 },
    { cluster: "x", ref: 10, baseErrors: 1, candErrors: 2 },
  ]);
  assert.strictEqual(one.lo, one.hi);
  assert.strictEqual(one.lo, -1 / 20);
});

/* ---------------- threshold ---------------- */

test("stt-eval: Q3 rule (a) — 1.3x faster, at most 1.0 WER point worse", () => {
  const base = { errors: 500, ref: 10000, decodeRtf: 0.13 };
  // Exactly at both boundaries: passes.
  let r = e.classify(base, { errors: 600, ref: 10000, decodeRtf: 0.1 });
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.rule, "a");
  // One error past the WER boundary: fails.
  r = e.classify(base, { errors: 601, ref: 10000, decodeRtf: 0.1 });
  assert.strictEqual(r.eligible, false);
  // Just short of 1.3x: fails.
  r = e.classify(base, { errors: 500, ref: 10000, decodeRtf: 0.1001 });
  assert.strictEqual(r.eligible, false);
});

test("stt-eval: Q3 rule (b) — lower WER, at most 1.1x slower", () => {
  const base = { errors: 500, ref: 10000, decodeRtf: 0.1 };
  let r = e.classify(base, { errors: 499, ref: 10000, decodeRtf: 0.11 });
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.rule, "b");
  // Equal WER is not "lower".
  r = e.classify(base, { errors: 500, ref: 10000, decodeRtf: 0.1 });
  assert.strictEqual(r.eligible, false);
  // Past 1.1x slower.
  r = e.classify(base, { errors: 400, ref: 10000, decodeRtf: 0.1101 });
  assert.strictEqual(r.eligible, false);
  assert.throws(() => e.classify(base, { errors: 1, ref: 9, decodeRtf: 0.1 }), /different references/);
});

test("stt-eval: Q5/Q7 long-form guard is relative to the default", () => {
  const base60 = { wordRatio: 0.988, wer: 0.05 };
  const base300 = { wordRatio: 0.45, wer: 0.58 };
  const clip = (label, wordRatio, wer, base, error) => ({ label, wordRatio, wer, base, ...(error ? { error } : {}) });
  // Matching the default's own long-buffer loss is compatible.
  assert.deepStrictEqual(
    e.longFormCompatible([clip("60s", 0.95, 0.07, base60), clip("300s", 0.45, 0.58, base300)]),
    { compatible: true, reasons: [] }
  );
  // (a) exactly 0.10 below the default passes; just past it fails.
  assert.strictEqual(e.longFormCompatible([clip("300s", 0.35, 0.58, base300)]).compatible, true);
  assert.strictEqual(e.longFormCompatible([clip("300s", 0.349, 0.58, base300)]).compatible, false);
  // (b) exactly 5 points above passes; just past it fails.
  assert.strictEqual(e.longFormCompatible([clip("300s", 0.45, 0.63, base300)]).compatible, true);
  assert.strictEqual(e.longFormCompatible([clip("300s", 0.45, 0.6301, base300)]).compatible, false);
  // (c) failing where the default did not; failing where it also failed is not held against it.
  const crashed = e.longFormCompatible([clip("300s", 0, 1, base300, "engine process exited")]);
  assert.strictEqual(crashed.compatible, false);
  assert.match(crashed.reasons[0], /failed \(engine process exited\) where the default did not/);
  assert.strictEqual(e.longFormCompatible([clip("300s", 0, 1, base300)]).compatible, false, "empty output counts as failing");
  const bothFailed = { wordRatio: 0, wer: 1, error: "engine process exited" };
  assert.strictEqual(e.longFormCompatible([clip("300s", 0, 1, bothFailed, "engine process exited")]).compatible, true);
  // The absolute 0.9 cut applies at 60 s only.
  assert.strictEqual(e.longFormCompatible([clip("60s", 0.9, 0.05, base60)]).compatible, true);
  const low60 = e.longFormCompatible([clip("60s", 0.899, 0.05, { wordRatio: 0.95, wer: 0.05 })]);
  assert.deepStrictEqual(low60.reasons, ["60s: word ratio 0.899 < 0.9"]);
  assert.strictEqual(e.longFormCompatible([clip("300s", 0.5, 0.5, { wordRatio: 0.55, wer: 0.5 })]).compatible, true);
});

test("stt-eval: the speed subset keeps every 4th sentence cluster, all its readings, in a fixed order", () => {
  const clips = [];
  for (const id of [10, 2, 7, 1, 30, 4, 5, 9, 8]) {
    clips.push({ sentenceId: String(id), file: `${id}a` }, { sentenceId: String(id), file: `${id}b` });
  }
  // Sorted numerically: 1 2 4 5 7 8 9 10 30 -> indices 0, 4, 8 -> ids 1, 7, 30.
  assert.deepStrictEqual(e.speedSubset(clips).map((c) => c.file), ["7a", "7b", "1a", "1b", "30a", "30b"]);
  assert.deepStrictEqual(e.speedSubset(clips), e.speedSubset([...clips].reverse()).reverse());
  assert.strictEqual(e.SPEED_SUBSET_EVERY, 4);
});

test("stt-eval: style rates read the raw hypotheses", () => {
  const r = e.styleRates(["Hello, world.", "um so uh yes", ""]);
  assert.strictEqual(r.punctuationRate, 1 / 3);
  assert.strictEqual(r.capitalisationRate, 1 / 3);
  assert.strictEqual(r.hesitationsPer1000Words, 2 / 6 * 1000);
});

/* ---------------- corpus plumbing ---------------- */

const TSV = [
  "1980\ta.wav\tUnfortunately, it's 20 percent.\tunfortunately it's 20% \tu n |\t202240\tMALE",
  "1980\tb.wav\tUnfortunately, it's 20 percent.\tunfortunately it's 20 percent\tu n |\t126720\tFEMALE",
  "7\tc.wav\tIn 1963, dams.\tin 1963 dams\ti n |\t16000\tFEMALE",
  "",
].join("\n");

test("stt-eval: FLEURS tsv parse and the column cross-check", () => {
  const rows = e.parseFleursTsv(TSV);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[2], {
    sentenceId: "7",
    file: "c.wav",
    raw: "In 1963, dams.",
    normalized: "in 1963 dams",
    numSamples: 16000,
    gender: "FEMALE",
  });
  // Row 0's own "normalised" column writes 20% where the raw says "percent".
  assert.deepStrictEqual(e.tsvColumnMismatches(rows).map((r) => r.file), ["a.wav"]);
  assert.throws(() => e.parseFleursTsv("a\tb\tc"), /expected 7 fields/);
  assert.throws(() => e.parseFleursTsv("1\ta\tb\tc\td\tx\tMALE"), /bad num_samples/);
});

// Minimal tar writer for the reader's tests: one 512-byte header per entry.
function tarHeader(name, size, type, magic) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  if (magic === "gnu") h.write("ustar  \0", 257, "binary");
  else h.write("ustar\u000000", 257, "binary");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function tarEntry(name, data, type = "0", magic = "gnu") {
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(body);
  return Buffer.concat([tarHeader(name, data.length, type, magic), body]);
}

test("stt-eval: tar reader walks GNU and ustar entries, long names, and pax paths", () => {
  const long = `test/${"x".repeat(120)}.wav`;
  const paxRecord = (key, value) => {
    const body = ` ${key}=${value}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len++;
    return Buffer.from(`${len}${body}`);
  };
  const tar = Buffer.concat([
    tarEntry("test/", Buffer.alloc(0), "5"),
    tarEntry("test/a.wav", Buffer.from("hello")),
    tarEntry("././@LongLink", Buffer.from(`${long}\0`), "L"),
    tarEntry(long.slice(0, 100), Buffer.from("long")),
    tarEntry("PaxHeader", paxRecord("path", "test/pax.wav"), "x", "posix"),
    tarEntry("ignored", Buffer.from("pax"), "0", "posix"),
    Buffer.alloc(1024),
  ]);
  const read = e.bufferReader(tar);
  const entries = [...e.tarEntries(read, tar.length)];
  assert.deepStrictEqual(entries.map((x) => x.name), ["test/a.wav", long, "test/pax.wav"]);
  assert.deepStrictEqual(
    entries.map((x) => read(x.offset, x.size).toString()),
    ["hello", "long", "pax"]
  );

  const corrupt = Buffer.from(tar);
  corrupt[520] ^= 0xff; // inside the second header's name field
  assert.throws(() => [...e.tarEntries(e.bufferReader(corrupt), corrupt.length)], /checksum/);
  const link = Buffer.concat([tarEntry("l", Buffer.alloc(0), "2"), Buffer.alloc(1024)]);
  assert.throws(() => [...e.tarEntries(e.bufferReader(link), link.length)], /unsupported tar entry/);
});

function floatWav(samples, sampleRate = 16000, format = 3) {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => data.writeFloatLE(s, i * 4));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("stt-eval: float32 WAV -> the overlay's PCM16, parsed by the worker's own reader", () => {
  const ramp = [-1.5, -1, -0.5, 0, 0.25, 0.5, 1, 1.5];
  const { wav, pcm } = e.toPcm16Wav(floatWav(ramp));
  // Clamped, and scaled/truncated exactly as renderer/overlay.js does.
  assert.deepStrictEqual([...pcm], [-32768, -32768, -16384, 0, 8191, 16383, 32767, 32767]);
  const back = wavToFloat32(wav);
  assert.strictEqual(back.sampleRate, 16000);
  assert.strictEqual(back.samples.length, ramp.length);
  assert.ok(Math.abs(back.samples[2] - -0.5) < 1e-4);

  // PCM16 in passes straight through.
  const pcmIn = encodeWav(new Int16Array([1, -2, 3]));
  assert.deepStrictEqual([...e.toPcm16Wav(pcmIn).pcm], [1, -2, 3]);

  assert.throws(() => e.toPcm16Wav(floatWav([0], 44100)), /expected 16000 Hz/);
  assert.throws(() => e.toPcm16Wav(Buffer.from("nope")), /RIFF/);
});

test("stt-eval: level normalisation brings quiet clips to the target, never past the peak ceiling", () => {
  // A -44 dBFS clip (FLEURS has these) is brought up to -20 dBFS RMS.
  const quiet = Float32Array.from({ length: 1600 }, (_, i) => 0.006 * Math.sin(i / 5));
  const g = e.levelGain(quiet);
  const rms = Math.sqrt(quiet.reduce((s, v) => s + (v * g) ** 2, 0) / quiet.length);
  assert.ok(Math.abs(rms - e.TARGET_RMS) < 1e-6, `rms ${rms}`);
  // A clip with one loud click is capped by its peak instead.
  const click = new Float32Array(1600).fill(0.001);
  click[10] = 0.5;
  assert.strictEqual(e.levelGain(click), e.PEAK_CEILING / 0.5);
  assert.strictEqual(e.levelGain(new Float32Array(10)), 1, "silence stays silence");

  const { pcm, gain } = e.toPcm16Wav(floatWav(Array.from(quiet)), { level: true });
  assert.strictEqual(gain, g);
  assert.ok(Math.max(...pcm) > 4000, "quantised well above the noise floor");
  // Off by default: the plain conversion keeps the samples as they are.
  assert.strictEqual(e.toPcm16Wav(floatWav(Array.from(quiet))).gain, 1);
});

test("stt-eval: concatenating clips inserts the silence gap", () => {
  const out = e.concatPcm16([new Int16Array([1, 2]), new Int16Array([3])], 2);
  assert.deepStrictEqual([...out], [1, 2, 0, 0, 3]);
});

test("stt-eval: only a 64-hex LFS etag counts as a sha256", () => {
  const sha = "a32b12d1".padEnd(64, "0");
  assert.strictEqual(e.sha256FromLinkedEtag(`"${sha}"`), sha);
  assert.strictEqual(e.sha256FromLinkedEtag(`W/"${sha.toUpperCase()}"`), sha);
  // tokens.txt: a git blob id, verified on csukuangfj/…-v2-int8 — not a sha256.
  assert.strictEqual(e.sha256FromLinkedEtag('"f0742785f6073e80b911964c455b05f3609bf23b"'), null);
  assert.strictEqual(e.sha256FromLinkedEtag(undefined), null);
});

/* ---------------- the evaluation manifest ---------------- */

const manifest = require("../scripts/stt-eval-manifest");
const registry = require("../main/engines/registry");

const PINNED_HF = /^https:\/\/huggingface\.co\/(datasets\/)?[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\//;

test("stt-eval manifest: every file is checksum-pinned to an immutable commit", () => {
  const all = [
    ...manifest.CORPUS.files.map((f) => ["corpus", f]),
    ...manifest.CANDIDATES.flatMap((c) => c.files.map((f) => [c.id, f])),
  ];
  for (const [owner, f] of all) {
    const where = `${owner} -> ${f.name}`;
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `${where}: sha256`);
    assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, `${where}: bytes`);
    assert.match(f.url, PINNED_HF, `${where}: url must pin resolve/<40-hex commit>`);
    assert.strictEqual(decodeURIComponent(new URL(f.url).pathname.split("/").pop()), f.name, `${where}: url basename`);
    assert.ok(registry.isPathSegment(f.name), `${where}: file name must be a single path segment`);
  }
});

test("stt-eval manifest: candidates are catalog-shaped and wire only files they download", () => {
  const ids = manifest.CANDIDATES.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate candidate id");
  for (const c of manifest.CANDIDATES) {
    // A shipped id is only allowed for a catalogued winner, and then it must be
    // the very same model (same files and wiring) — never a different one.
    const shipped = registry.getModel("stt", c.id);
    if (shipped) {
      assert.deepStrictEqual(shipped.files, c.files, `${c.id}: shares a shipped id with different files`);
      assert.deepStrictEqual(shipped.sherpa, c.sherpa, `${c.id}: shares a shipped id with different wiring`);
    }
    assert.ok(registry.isPathSegment(c.id), `${c.id}: id must be a path segment`);
    assert.strictEqual(c.kind, "stt");
    assert.ok(c.label && c.note && c.licence, `${c.id}: label, note and licence`);
    assert.ok(!("default" in c), `${c.id}: a candidate never carries default`);
    assert.ok(["wired", "exploratory"].includes(c.arm), `${c.id}: arm`);
    const names = c.files.map((f) => f.name);
    for (const [role, file] of Object.entries(c.sherpa)) {
      if (role === "family" || role === "modelType") continue;
      assert.ok(names.includes(file), `${c.id}: sherpa.${role} "${file}" is not downloaded`);
    }
    if (c.arm === "wired") {
      // The worker routes on the joiner alone: transducer with one, Whisper without.
      assert.ok(c.sherpa.encoder && c.sherpa.decoder && c.sherpa.tokens, `${c.id}: wired roles`);
      assert.ok(!c.sherpa.family, `${c.id}: a wired model uses the worker's own routing`);
    } else {
      assert.ok(["moonshine", "nemoCtc", "canary"].includes(c.sherpa.family), `${c.id}: exploratory family`);
    }
  }
});

test("stt-eval manifest: the corpus and every skipped survey row are pinned down", () => {
  assert.strictEqual(manifest.BASELINE_ID, registry.DEFAULT_STT_MODEL);
  assert.ok(manifest.CORPUS.files.some((f) => f.name === manifest.CORPUS.archive));
  assert.ok(manifest.CORPUS.files.some((f) => f.name === manifest.CORPUS.tsv));
  assert.strictEqual(manifest.CORPUS.utterances, 647);
  for (const s of manifest.SKIPPED) {
    assert.ok(s.repo && s.reason && s.reason.length > 10, `unclassified survey row: ${JSON.stringify(s)}`);
  }
});

/* ---------------- judging a split run ---------------- */

const CFG = { baselineId: "base", quietLoad: 4, bracketDrift: 0.1 };
const MACHINE = { appThreads: 8 };
const speedRow = (id, role, decodeRtf, endLoad, extra = {}) => ({
  id, role, arm: "wired", status: "measured", decodeRtf, contended: false,
  loadavgBefore: [2, 2, 2], loadavgAfter: [endLoad, 2, 2], quietWait: { limit: 4 }, otherRun: { active: false, samples: 5 },
  ...extra,
});
const speedFile = (rows) => ({ machine: MACHINE, corpus: { subset: "speed" }, rows });
// Accuracy rows over 2 utterances of 50 words each, one sentence cluster each.
const accRow = (id, role, errors, extra = {}) => ({
  id, role, arm: "wired", status: "measured", errors, ref: 100, perUtteranceErrors: [Math.floor(errors / 2), Math.ceil(errors / 2)],
  longForm: [{ label: "60s", wordRatio: 0.99, wer: 0.05 }, { label: "300s", wordRatio: 0.45, wer: 0.58 }],
  ...extra,
});
const accResult = (rows) => ({
  corpus: { utteranceIndex: [{ sentenceId: "1", refWords: 50 }, { sentenceId: "2", refWords: 50 }] },
  rows,
});

test("stt-eval judge: DV10 end-of-decode load makes a row contended, for every row alike", () => {
  const res = speedFile([]);
  assert.strictEqual(e.speedCleanliness(speedRow("x", "candidate", 0.04, 12), res, CFG).clean, true);
  const busy = e.speedCleanliness(speedRow("x", "candidate", 0.05, 12.1), res, CFG);
  assert.strictEqual(busy.clean, false);
  assert.match(busy.reason, /end-of-decode 1-min load 12\.1 > 12 \(DV10\)/);
  assert.match(e.speedCleanliness(speedRow("x", "c", 0.04, 5, { contended: true, otherRun: { active: true } }), res, CFG).reason, /other run seen/);
  assert.match(e.speedCleanliness(speedRow("x", "c", 0.04, 5, { contended: true }), res, CFG).reason, /quiet gate/);
});

test("stt-eval judge: a speed file counts only if its own first/last default runs are clean and stable", () => {
  const ok = speedFile([speedRow("base", "bracket-first", 0.0425, 7), speedRow("base", "bracket-last", 0.0429, 8)]);
  assert.strictEqual(e.speedFileBrackets(ok, CFG).stable, true);
  const drift = speedFile([speedRow("base", "bracket-first", 0.04, 7), speedRow("base", "bracket-last", 0.0441, 8)]);
  assert.match(e.speedFileBrackets(drift, CFG).reason, /drift 10\.2 % > 10 %/);
  const busyLast = speedFile([speedRow("base", "bracket-first", 0.04, 7), speedRow("base", "bracket-last", 0.04, 13)]);
  assert.strictEqual(e.speedFileBrackets(busyLast, CFG).stable, false);
});

test("stt-eval judge: the first clean attempt is used, against its own file's default, and every attempt is kept", () => {
  const main = speedFile([
    speedRow("base", "bracket-first", 0.0425, 7),
    speedRow("cand", "candidate", 0.0531, 17.9), // contended by DV10
    speedRow("fast", "candidate", 0.0104, 4.5),
    speedRow("base", "bracket-last", 0.0429, 8),
  ]);
  const remeasure = speedFile([
    speedRow("base", "bracket-first", 0.05, 8), // a slower machine state, bracketed
    speedRow("cand", "candidate", 0.05, 6.7),
    speedRow("base", "bracket-last", 0.05, 8),
  ]);
  const acc = accResult([accRow("base", "bracket-first", 6), accRow("cand", "candidate", 5), accRow("fast", "candidate", 6)]);
  e.judge(acc, [{ res: main, name: "speed.json" }, { res: remeasure, name: "remeasure.json" }], CFG);
  const cand = acc.rows[1];
  assert.deepStrictEqual(cand.speedAttempts.map((a) => [a.file, a.usable, a.used]), [["speed.json", false, false], ["remeasure.json", true, true]]);
  assert.match(cand.speedAttempts[0].reason, /DV10/);
  // Compared with the re-measure's own default (0.05), not the main pass's (0.0425).
  assert.strictEqual(cand.speed.refDecodeRtf, 0.05);
  assert.strictEqual(cand.vsDefault.speedup, 1);
  assert.strictEqual(cand.verdict, "eligible (rule b)");
  const fast = acc.rows[2];
  assert.strictEqual(fast.verdict, "eligible (rule a)");
  assert.ok(fast.vsDefault.speedup > 4);
  // The default itself: its first clean attempt, with the re-measure's kept but unused.
  assert.deepStrictEqual(acc.rows[0].speedAttempts.map((a) => a.used), [true, false]);
});

test("stt-eval judge: no clean speed means no speed-based verdict; WER alone can still rule a model out", () => {
  const main = speedFile([speedRow("base", "bracket-first", 0.04, 7), speedRow("slow", "candidate", 0.03, 13), speedRow("bad", "candidate", 0.01, 13), speedRow("base", "bracket-last", 0.04, 7)]);
  const acc = accResult([accRow("base", "bracket-first", 6), accRow("slow", "candidate", 6), accRow("bad", "candidate", 8)]);
  e.judge(acc, [{ res: main, name: "speed.json" }], CFG);
  assert.strictEqual(acc.rows[1].verdict, "speed not measured cleanly — no speed-based verdict");
  assert.strictEqual(acc.rows[1].eligible, false);
  assert.match(acc.rows[2].verdict, /WER alone rules out both rules/);
  // An unstable file gives nobody a speed.
  const unstable = speedFile([speedRow("base", "bracket-first", 0.04, 7), speedRow("slow", "candidate", 0.02, 5), speedRow("base", "bracket-last", 0.05, 7)]);
  const acc2 = accResult([accRow("base", "bracket-first", 6), accRow("slow", "candidate", 6)]);
  e.judge(acc2, [{ res: unstable, name: "u.json" }], CFG);
  assert.strictEqual(acc2.speedClean, false);
  assert.strictEqual(acc2.rows[1].verdict, "speed not measured cleanly — no speed-based verdict");
});

test("stt-eval judge: shipped baselines get no verdict; long-form and the exploratory arm gate eligibility", () => {
  const main = speedFile([
    speedRow("base", "bracket-first", 0.04, 7),
    speedRow("fp32", "baseline", 0.03, 6),
    speedRow("trunc", "candidate", 0.01, 5),
    speedRow("base", "calibration", 0.04, 7),
    speedRow("ctc", "candidate", 0.01, 5, { arm: "exploratory" }),
    speedRow("base", "bracket-last", 0.04, 7),
  ]);
  const acc = accResult([
    accRow("base", "bracket-first", 6),
    accRow("fp32", "baseline", 5),
    accRow("trunc", "candidate", 6, { longForm: [{ label: "60s", wordRatio: 0.66, wer: 0.35 }, { label: "300s", wordRatio: 0.45, wer: 0.58 }] }),
    accRow("base", "calibration", 6),
    accRow("ctc", "candidate", 6, { arm: "exploratory" }),
  ]);
  e.judge(acc, [{ res: main, name: "speed.json" }], CFG);
  const [, fp32, trunc, , ctc] = acc.rows;
  assert.strictEqual(fp32.verdict, "shipped");
  assert.strictEqual(fp32.eligible, false);
  assert.strictEqual(trunc.verdict, "incompatible on long audio");
  assert.ok(trunc.longFormCheck.reasons.length >= 1);
  assert.strictEqual(ctc.eligible, false, "never catalogued from the exploratory arm");
  assert.match(ctc.verdict, /exploratory arm \(rule a\) — wire and re-measure/);
  assert.strictEqual(ctc.vsDefault.against, "calibration (direct path)");
});

/* ---------------- resuming a run ---------------- */

const runFile = (over = {}) => ({
  schema: 1,
  pass: "accuracy",
  corpus: { commit: "c0", files: [{ sha256: "a" }, { sha256: "b" }], subset: "all", utterances: 647 },
  machine: { cpu: "Ryzen", logicalCpus: 24, appThreads: 8, versions: { electron: "42", sherpaOnnxNode: "1.13.3" }, measuringCode: "h1" },
  ...over,
});

test("stt-eval resume: an identical run may be resumed", () => {
  assert.deepStrictEqual(e.resumeCompatibility(runFile(), runFile()), { ok: true, problems: [] });
});

test("stt-eval resume: every field that decides a number must match", () => {
  const cases = {
    schema: runFile({ schema: 2 }),
    pass: runFile({ pass: "speed" }),
    "corpus commit": runFile({ corpus: { ...runFile().corpus, commit: "c1" } }),
    "corpus files": runFile({ corpus: { ...runFile().corpus, files: [{ sha256: "a" }, { sha256: "x" }] } }),
    "corpus subset": runFile({ corpus: { ...runFile().corpus, subset: "speed" } }),
    utterances: runFile({ corpus: { ...runFile().corpus, utterances: 40 } }),
    "machine.appThreads": runFile({ machine: { ...runFile().machine, appThreads: 4 } }),
    "versions.sherpaOnnxNode": runFile({ machine: { ...runFile().machine, versions: { electron: "42", sherpaOnnxNode: "1.14.0" } } }),
    "measuring code": runFile({ machine: { ...runFile().machine, measuringCode: "h2" } }),
  };
  for (const [field, previous] of Object.entries(cases)) {
    const r = e.resumeCompatibility(previous, runFile());
    assert.strictEqual(r.ok, false, field);
    assert.strictEqual(r.problems.length, 1, `${field}: ${r.problems}`);
    assert.ok(r.problems[0].startsWith(field), `${field}: ${r.problems[0]}`);
  }
});

test("stt-eval resume: --resume-across-code waives the code hash only", () => {
  const otherCode = runFile({ machine: { ...runFile().machine, measuringCode: "h0" } });
  assert.strictEqual(e.resumeCompatibility(otherCode, runFile(), { acrossCode: true }).ok, true);
  const otherPass = runFile({ pass: "speed", machine: { ...runFile().machine, measuringCode: "h0" } });
  assert.deepStrictEqual(
    e.resumeCompatibility(otherPass, runFile(), { acrossCode: true }).problems.map((p) => p.split(":")[0]),
    ["pass"]
  );
});

test("stt-eval resume: a row is reused only for the very files the model pins now", () => {
  const model = { files: [{ name: "enc", sha256: "1" }, { name: "tok", sha256: "2" }] };
  const row = { status: "measured", files: [{ name: "tok", sha256: "2", bytes: 9 }, { name: "enc", sha256: "1", bytes: 9 }] };
  assert.strictEqual(e.rowReusable(row, model), true);
  assert.strictEqual(e.rowReusable({ ...row, files: [{ name: "enc", sha256: "9" }, { name: "tok", sha256: "2" }] }, model), false);
  assert.strictEqual(e.rowReusable({ ...row, status: "failed" }, model), false);
  assert.strictEqual(e.rowReusable(undefined, model), false);
});

/* ---------------- what a run measures ---------------- */

test("stt-eval plan: a catalogued candidate is planned once, as a candidate, and keeps its verdict", () => {
  const shipped = registry.listModels("stt");
  const plan = e.planModels(shipped, manifest.CANDIDATES, { baselineId: manifest.BASELINE_ID, exploratory: true, pass: "both" });
  const key = (x) => `${x.model.id}|${x.role}`;
  assert.strictEqual(new Set(plan.map(key)).size, plan.length, "no model planned twice in one role");
  const rows110m = plan.filter((x) => x.model.id === "parakeet-tdt-110m-en");
  assert.deepStrictEqual(rows110m.map((x) => [x.role, x.arm, x.catalogued]), [["candidate", "wired", true]]);
  // It is measured from the catalog payload (identical to its manifest pins).
  assert.strictEqual(rows110m[0].model, registry.getModel("stt", "parakeet-tdt-110m-en"));
  // Shipped models that were never candidates stay verdict-free baselines.
  assert.deepStrictEqual(
    plan.filter((x) => x.role === "baseline").map((x) => x.model.id).sort(),
    ["parakeet-tdt-0.6b-v2", "parakeet-tdt-0.6b-v3"]
  );
  // The default opens and (for a timed pass) closes the run; accuracy has no closing run.
  assert.strictEqual(plan[0].role, "bracket-first");
  assert.strictEqual(plan[plan.length - 1].role, "bracket-last");
  const acc = e.planModels(shipped, manifest.CANDIDATES, { baselineId: manifest.BASELINE_ID, pass: "accuracy" });
  assert.ok(!acc.some((x) => x.role === "bracket-last" || x.arm === "exploratory"));

  // Judged from its own measurements, the catalogued 110M still earns its entry.
  const measured = speedFile([
    speedRow(manifest.BASELINE_ID, "bracket-first", 0.0425, 7),
    speedRow("parakeet-tdt-110m-en", "candidate", 0.0104, 4.5),
    speedRow(manifest.BASELINE_ID, "bracket-last", 0.0429, 8),
  ]);
  const accRows = accResult([
    accRow(manifest.BASELINE_ID, "bracket-first", 6),
    accRow("parakeet-tdt-110m-en", "candidate", 6, { catalogued: true, longForm: [{ label: "60s", wordRatio: 1.006, wer: 0.0432 }, { label: "300s", wordRatio: 0, wer: 1, error: "engine process exited" }] }),
  ]);
  accRows.rows[0].longForm = [{ label: "60s", wordRatio: 0.988, wer: 0.0494 }, { label: "300s", wordRatio: 0, wer: 1, error: "engine process exited" }];
  e.judge(accRows, [{ res: measured, name: "speed.json" }], { baselineId: manifest.BASELINE_ID, quietLoad: 4, bracketDrift: 0.1 });
  assert.strictEqual(accRows.rows[1].verdict, "eligible (rule a)");
  assert.strictEqual(accRows.rows[1].eligible, true);
});

test("stt-eval plan: --models narrows the plan and the baseline must exist", () => {
  const shipped = registry.listModels("stt");
  const some = e.planModels(shipped, manifest.CANDIDATES, {
    baselineId: manifest.BASELINE_ID, pass: "speed", models: [manifest.BASELINE_ID, "parakeet-tdt-0.6b-v2-int8"],
  });
  assert.deepStrictEqual(some.map((x) => `${x.model.id}|${x.role}`), [
    `${manifest.BASELINE_ID}|bracket-first`, "parakeet-tdt-0.6b-v2-int8|candidate", `${manifest.BASELINE_ID}|bracket-last`,
  ]);
  assert.throws(() => e.planModels(shipped, [], { baselineId: "nope" }), /not in the catalog/);
});

/* ---------------- combining passes and the report (scripts/eval-stt.js) ---------------- */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const harness = require("../scripts/eval-stt");

// A minimal but complete pair of pass files, shaped like the harness writes them.
function passFiles(t, { speedOver = {}, accOver = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-combine-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const machine = { cpu: "cpu", logicalCpus: 24, ramGb: 60, platform: "linux", appThreads: 8,
    versions: { electron: "42", sherpaOnnxNode: "1.13.3" }, gitHead: "abc", measuringCode: "h1" };
  const corpus = (subset, utterances) => ({ id: "fleurs", source: "google/fleurs", commit: "c0", subset, utterances,
    referenceWords: 100, audioSec: 20, files: [], utteranceIndex: [{ sentenceId: "1", refWords: 50 }, { sentenceId: "2", refWords: 50 }] });
  const accRowFull = (id, role, errors, extra) => ({
    ...accRow(id, role, errors, extra), path: "worker", werNorm: errors / 100, werVerbatim: errors / 50,
    punctuationRate: 1, capitalisationRate: 1, bytes: 500e6, decodeRtf: 0.09, contended: true,
    coldLoadWallMs: 2000, firstDecodeMs: 500, loadavgBefore: [20, 1, 1], loadavgAfter: [20, 1, 1],
  });
  const acc = {
    schema: 1, pass: "accuracy", status: "accuracy complete", command: "acc", machine, corpus: corpus("all", 647),
    rows: [accRowFull("base", "bracket-first", 6), accRowFull("fast", "candidate", 6)], ...accOver,
  };
  const speed = {
    schema: 1, pass: "speed", status: "speed complete", command: "speed", machine, corpus: corpus("speed subset", 166),
    cpuLock: { file: "/x/cpu-quiet.lock", role: "held for the whole pass" },
    rows: [speedRow("base", "bracket-first", 0.0425, 7, { p50Rtf: 0.042, p95Rtf: 0.045 }),
      speedRow("fast", "candidate", 0.0104, 4.5, { p50Rtf: 0.0104, p95Rtf: 0.012 }),
      speedRow("base", "bracket-last", 0.0429, 8)],
    ...speedOver,
  };
  const accPath = path.join(dir, "acc.json");
  const speedPath = path.join(dir, "speed.json");
  fs.writeFileSync(accPath, JSON.stringify(acc));
  fs.writeFileSync(speedPath, JSON.stringify(speed));
  return { accPath, speedPath };
}

test("stt-eval combine: a clean split run merges, judges and reports", (t) => {
  const { accPath, speedPath } = passFiles(t);
  // The CLI's default baseline is the real one; this fixture names its own.
  const combined = harness.combine(accPath, [speedPath], { baselineId: "base" });
  assert.strictEqual(combined.status, "complete");
  assert.strictEqual(combined.pass, "combined");
  const fast = combined.rows.find((r) => r.id === "fast");
  assert.strictEqual(fast.speed.decodeRtf, 0.0104, "the clean speed-pass number, not the accuracy pass's 0.09");
  assert.strictEqual(fast.verdict, "eligible (rule a)");
  const md = harness.report(combined);
  assert.match(md, /Every speed timing was taken while holding cpu-quiet\.lock/);
  assert.match(md, /\| fast \| candidate \| worker \| 6\.00 \| 12\.00 \|/);
  assert.match(md, /0\.0104 \(0\.0104 \/ 0\.0120\)/);
  assert.match(md, /cleanup run idle, load 2\.0–4\.5/);
  assert.match(md, /eligible \(rule a\) \|$/m);
  assert.match(md, /default first\/last 0\.0425 \/ 0\.0429 \(drift 0\.9 %/);
});

test("stt-eval combine: refuses passes that do not belong together", (t) => {
  const cases = [
    [{ speedOver: { pass: "accuracy" } }, /is not a speed pass/],
    [{ accOver: { pass: "speed" } }, /is not an accuracy pass/],
    [{ speedOver: { machine: { measuringCode: "h2" }, corpus: { commit: "c0", subset: "s" } } }, /different corpus pins or measuring code/],
  ];
  for (const [over, re] of cases) {
    const { accPath, speedPath } = passFiles(t, over);
    assert.throws(() => harness.combine(accPath, [speedPath], { baselineId: "base" }), re);
  }
  const { accPath, speedPath } = passFiles(t);
  const other = speedPath.replace("speed.json", "other.json");
  const s = JSON.parse(fs.readFileSync(speedPath, "utf8"));
  s.corpus.subset = "another subset";
  fs.writeFileSync(other, JSON.stringify(s));
  assert.throws(() => harness.combine(accPath, [speedPath, other], { baselineId: "base" }), /a different speed subset/);
});

test("stt-eval combine: no speed pass, or an unusable one, gives no speed-based verdict", (t) => {
  const { accPath } = passFiles(t);
  const noSpeed = harness.combine(accPath, [], { baselineId: "base" });
  assert.match(noSpeed.status, /speed: not measured/);
  assert.strictEqual(noSpeed.rows[1].verdict, "speed not measured cleanly — no speed-based verdict");
  const md = harness.report(noSpeed);
  assert.match(md, /0\.0900\*/, "the accuracy pass's contended time is shown starred");
  assert.match(md, /measured while the machine was busy/);

  const { accPath: a2, speedPath: s2 } = passFiles(t, { speedOver: { status: "unstable" } });
  assert.match(harness.combine(a2, [s2], { baselineId: "base" }).status, /speed: unstable/);
});

test("stt-eval harness: argument parsing", () => {
  const o = harness.parseArgs(["--out", "x.json", "--pass=speed", "--limit", "40", "--models", "a,b", "--resume-across-code", "--no-sandbox"]);
  assert.deepStrictEqual([o.out, o.pass, o.limit, o.models, o.resume, o.resumeAcrossCode], ["x.json", "speed", 40, ["a", "b"], true, true]);
  assert.throws(() => harness.parseArgs(["--pass", "fast"]), /--pass must be/);
  assert.throws(() => harness.parseArgs(["--bogus"]), /unknown argument/);
});

/* ---------------- the harness's recognizers: a timed-out decode never keeps running ---------------- */

const { mock } = require("node:test");
const Module = require("node:module");

test("stt-eval harness: a worker request that times out stops the worker; other errors do not", async () => {
  const hostModule = require("../main/engines/host");
  const realCreateHost = hostModule.createHost;
  let stops = 0;
  let reply = () => Promise.reject(new Error("engine request 'transcribe' timed out"));
  hostModule.createHost = () => ({ request: () => reply(), stop: () => { stops++; } });
  try {
    const rec = harness.workerRecognizer({ id: "m", sherpa: {} }, "/models/m");
    await assert.rejects(rec.transcribe(Buffer.alloc(0), 10), /timed out/);
    assert.strictEqual(stops, 1, "the timed-out worker is stopped");
    reply = () => Promise.reject(new Error("STT model not loaded"));
    await assert.rejects(rec.transcribe(Buffer.alloc(0), 10), /not loaded/);
    assert.strictEqual(stops, 1, "an ordinary failure leaves the worker alone");
  } finally {
    hostModule.createHost = realCreateHost;
  }
});

test("stt-eval harness: an exploratory request that times out kills its utility process", async () => {
  const electronPath = require.resolve("electron", { paths: [path.join(__dirname, "../scripts")] });
  const saved = require.cache[electronPath];
  const killed = [];
  const posted = [];
  const child = {
    on() {},
    postMessage: (msg) => posted.push(msg),
    kill: () => killed.push(true),
  };
  const stub = new Module(electronPath, null);
  stub.filename = electronPath;
  stub.loaded = true;
  stub.exports = { utilityProcess: { fork: (file) => { child.file = file; return child; } } };
  require.cache[electronPath] = stub;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rec = harness.directRecognizer({ id: "m", sherpa: { family: "moonshine" } }, "/models/m");
    assert.match(child.file, /stt-eval-worker\.js$/);
    const pending = rec.transcribe(Buffer.alloc(0), 5); // timeout: max(180 s, 5 s × 20 000)
    assert.strictEqual(posted[0].type, "transcribe");
    mock.timers.tick(179999);
    assert.deepStrictEqual(killed, [], "not before its deadline");
    mock.timers.tick(1);
    await assert.rejects(pending, /transcribe timed out after 180000 ms/);
    assert.deepStrictEqual(killed, [true]);
  } finally {
    mock.timers.reset();
    if (saved) require.cache[electronPath] = saved;
    else delete require.cache[electronPath];
  }
});

/* ---------------- the exploratory worker (scripts/stt-eval-worker.js) ---------------- */

test("stt-eval worker config: the exact recognizer config for every sherpa family", () => {
  const rt = { numThreads: 8, provider: "cpu" };
  const cfg = (sherpa) => e.sherpaRecognizerConfig("/m", sherpa, rt);
  // Expected paths are joined the platform's way, as the builder does.
  const P = (f) => path.join("/m", f);
  const common = { tokens: P("tokens.txt"), numThreads: 8, provider: "cpu", debug: false };
  assert.deepStrictEqual(cfg({ encoder: "e", decoder: "d", joiner: "j", tokens: "tokens.txt" }), {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: P("e"), decoder: P("d"), joiner: P("j") }, ...common, modelType: "nemo_transducer" },
  });
  assert.deepStrictEqual(cfg({ encoder: "e", decoder: "d", joiner: "j", tokens: "tokens.txt", modelType: "transducer" }).modelConfig.modelType, "transducer");
  assert.deepStrictEqual(cfg({ encoder: "e", decoder: "d", tokens: "tokens.txt", modelType: "whisper" }).modelConfig, {
    whisper: { encoder: P("e"), decoder: P("d") }, ...common, modelType: "whisper",
  });
  assert.deepStrictEqual(cfg({ family: "moonshine", preprocessor: "p", encoder: "e", uncachedDecoder: "u", cachedDecoder: "c", tokens: "tokens.txt" }).modelConfig, {
    moonshine: { preprocessor: P("p"), encoder: P("e"), uncachedDecoder: P("u"), cachedDecoder: P("c") }, ...common,
  });
  assert.deepStrictEqual(cfg({ family: "nemoCtc", model: "model.onnx", tokens: "tokens.txt" }).modelConfig, {
    nemoCtc: { model: P("model.onnx") }, ...common,
  });
  assert.deepStrictEqual(cfg({ family: "canary", encoder: "e", decoder: "d", tokens: "tokens.txt" }).modelConfig, {
    canary: { encoder: P("e"), decoder: P("d"), srcLang: "en", tgtLang: "en", usePnc: 1 }, ...common,
  });
  assert.throws(() => cfg({ family: "senseVoice", tokens: "t" }), /unknown sherpa family: senseVoice/);
  // Every exploratory manifest entry builds, with every file it names.
  for (const c of manifest.CANDIDATES.filter((x) => x.arm === "exploratory")) {
    const mc = e.sherpaRecognizerConfig("/m", c.sherpa, rt).modelConfig;
    assert.ok(mc[c.sherpa.family], `${c.id}: ${c.sherpa.family} sub-config`);
    for (const v of Object.values(mc[c.sherpa.family])) {
      if (typeof v === "string" && v.startsWith(P(""))) assert.ok(c.files.some((f) => P(f.name) === v), `${c.id}: ${v} is downloaded`);
    }
  }
});

test("stt-eval worker: load reports the app's runtime; transcribe before load fails", async () => {
  const workerPath = require.resolve("../scripts/stt-eval-worker");
  const sherpaPath = require.resolve("sherpa-onnx-node", { paths: [path.dirname(workerPath)] });
  const savedSherpa = require.cache[sherpaPath];
  const savedPort = process.parentPort;
  const built = [];
  const stub = new Module(sherpaPath, null);
  stub.filename = sherpaPath;
  stub.loaded = true;
  stub.exports = { OfflineRecognizer: class { constructor(c) { built.push(c); } } };
  require.cache[sherpaPath] = stub;
  let onMessage = null;
  const replies = [];
  process.parentPort = { on: (ev, fn) => { if (ev === "message") onMessage = fn; }, postMessage: (m) => replies.push(m) };
  delete require.cache[workerPath];
  try {
    require(workerPath);
    const send = (data) => new Promise((resolve) => {
      const seen = replies.length;
      onMessage({ data });
      const poll = () => (replies.length > seen ? resolve(replies[seen]) : setImmediate(poll));
      poll();
    });
    const early = await send({ id: 1, type: "transcribe", wav: Buffer.alloc(0) });
    assert.deepStrictEqual(early, { id: 1, ok: false, error: "STT model not loaded" });
    const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
    const loaded = await send({ id: 2, type: "load", dir: "/m", sherpa: { family: "nemoCtc", model: "model.onnx", tokens: "tokens.txt" } });
    assert.deepStrictEqual(loaded, { id: 2, ok: true, result: { ready: true, numThreads: threads, provider: "cpu" } });
    assert.deepStrictEqual(built[0].featConfig, { sampleRate: 16000, featureDim: 80 });
    assert.strictEqual(built[0].modelConfig.numThreads, threads);
    const unknown = await send({ id: 3, type: "nope" });
    assert.match(unknown.error, /Unknown request: nope/);
  } finally {
    delete require.cache[workerPath];
    if (savedSherpa) require.cache[sherpaPath] = savedSherpa;
    else delete require.cache[sherpaPath];
    process.parentPort = savedPort;
  }
});
