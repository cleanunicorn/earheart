// Tests for the speech-to-text evaluation's pure helpers (scripts/stt-eval.js):
// the normalisation and WER that decide the accuracy column, the statistics,
// the Q3 catalog threshold, and the corpus plumbing. The harness itself
// (scripts/eval-stt.js) needs Electron, the network and multi-GB models, so it
// is not in the suite; everything it computes a number with is pinned here.

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

test("stt-eval: Q5 long-form compatibility precondition", () => {
  const ok = e.longFormCompatible([
    { label: "60s", wordRatio: 0.95, wer: 0.08, baseWer: 0.06 },
    { label: "300s", wordRatio: 1.0, wer: 0.11, baseWer: 0.06 },
  ]);
  assert.deepStrictEqual(ok, { compatible: true, reasons: [] });
  const truncated = e.longFormCompatible([{ label: "300s", wordRatio: 0.12, wer: 0.9, baseWer: 0.06 }]);
  assert.strictEqual(truncated.compatible, false);
  assert.strictEqual(truncated.reasons.length, 2);
  const worse = e.longFormCompatible([{ label: "60s", wordRatio: 1, wer: 0.1101, baseWer: 0.06 }]);
  assert.strictEqual(worse.compatible, false);
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
    assert.ok(!registry.getModel("stt", c.id), `${c.id}: collides with a shipped id`);
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
