// Measure built-in transcription of long recordings — the evidence behind
// #168 (the default model drops words when one decode spans several
// utterances), #169 (the STT worker exits on a single buffer of ~3 minutes),
// and the pause cuts and MAX_DECODE_SECONDS in main/chunked-decode.js. See
// docs/long-recordings.md.
//
//   xvfb-run -a npx electron scripts/eval-long-decode.js --no-sandbox \
//     --cache-dir <dir> --out <file.json>                       # Linux
//   npx electron scripts/eval-long-decode.js --cache-dir <dir> --out <file.json>
//
// The corpus clips and the model come from the scripts/eval-stt.js cache
// (build it once: `… eval-stt.js --pass accuracy --models
// parakeet-tdt-0.6b-v3-int8 --keep --cache-dir <dir> --out <file>`). Nothing
// is written to the repo.
//
// Recordings: distinct FLEURS sentences from one speaker gender, 300 ms apart,
// in tsv order until each target length is reached (the same construction as
// eval-stt.js's long-form clips; targets 120/180/300 come out at about
// 124.5/182.9/310.9 s). Each goes through:
//
//   pieces   main/chunked-decode.js — the production code — over a real engine
//            worker (main/engines/host.js), once per --caps value: cut at
//            the pauses, never over the cap (--no-pauses: the cap alone).
//   single   (--single) one worker request for the whole buffer: the shape
//            the issues reported. Informational; never gates.
//
// --dictation builds each recording the way a dictation sounds instead (see
// dictationRecording): hesitations inside sentences, long gaps holding
// breaths and clicks, the hotkey's click at either end.
//
// --before adds a pieces run that cuts at every pause and decodes every
// piece — the splitter before it handled hesitations and noise
// (informational, never gates), for a before/after table on either corpus.
//
// Each recording's baseline is its own sentences decoded one clip at a time
// (mean 10 s): the "short buffer" accuracy that recording is held to. A pieces run fails
// the script (exit 1) on word ratio < 0.95, WER more than 3 points above the
// baseline, any worker input over the cap, a failed piece, empty text, or a
// worker that no longer answers a short decode afterwards.
//
// Flags: --cache-dir <dir> (required), --out <file.json> (required),
// --model <id> (default: the shipped default), --targets 120,180,300,
// --caps 20 (comma list: a cap sweep), --no-pauses, --single, --before, --dictation,
// --seed 1 (the dictation shape),
// --max-wer-over-short 0.03, --min-ratio 0.95.

const fs = require("node:fs");
const path = require("node:path");

const e = require("./stt-eval");
const manifest = require("./stt-eval-manifest");
const registry = require("../main/engines/registry");
const manager = require("../main/engines/model-manager");
const { encodeWav, wavDurationSec, SAMPLE_RATE } = require("../main/util/wav");
const { transcribeChunked, MAX_DECODE_SECONDS } = require("../main/chunked-decode");
const { quietestOffset } = require("../renderer/chunk-boundary");

const GAP_SAMPLES = Math.round(0.3 * SAMPLE_RATE);
const LOAD_TIMEOUT_MS = 600000;
const transcribeTimeoutMs = (audioSec) => Math.max(180000, audioSec * 20000);

/* ---------------- pure helpers (unit-tested) ---------------- */

function parseArgs(argv) {
  const opts = {
    model: registry.DEFAULT_STT_MODEL,
    targets: [120, 180, 300],
    caps: [MAX_DECODE_SECONDS],
    single: false,
    pauses: true,
    dictation: false,
    before: false,
    seed: 1,
    maxWerOverShort: 0.03,
    minRatio: 0.95,
  };
  const numbers = (v) => v.split(",").filter(Boolean).map(Number);
  // A threshold that isn't a finite number in [0, 1] would turn its check off:
  // every comparison against NaN is false.
  const fraction = (name, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} needs a number from 0 to 1 (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const next = () => {
      const v = value !== null ? value : argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--cache-dir": opts.cacheDir = next(); break;
      case "--out": opts.out = next(); break;
      case "--model": opts.model = next(); break;
      case "--targets": opts.targets = numbers(next()); break;
      case "--caps": opts.caps = numbers(next()); break;
      case "--single": opts.single = true; break;
      case "--no-pauses": opts.pauses = false; break;
      case "--dictation": opts.dictation = true; break;
      case "--before": opts.before = true; break;
      case "--seed": opts.seed = Number(next()); break;
      case "--max-wer-over-short": opts.maxWerOverShort = fraction(arg, next()); break;
      case "--min-ratio": opts.minRatio = fraction(arg, next()); break;
      default:
        // Chromium's own switches (--no-sandbox, …) reach the script too.
        if (!arg.startsWith("--no-sandbox") && !arg.startsWith("--enable-") && !arg.startsWith("--disable-")) {
          throw new Error(`unknown argument: ${argv[i]}`);
        }
    }
  }
  for (const [name, list] of [["--targets", opts.targets], ["--caps", opts.caps]]) {
    if (!list.length || list.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error(`${name} needs positive finite numbers`);
  }
  return opts;
}

// Deterministic [0, 1) generator, so a dictation recording is the same on
// every run and machine for a given --seed.
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

// The sounds a dictation adds to read speech, as PCM16 at SAMPLE_RATE. RMS is
// stated after the overlay's auto gain control, where the splitter sees it.
const DICTATION_SHAPE = {
  hesitationSec: [0.4, 1.2], // a pause dropped inside a sentence
  hesitationsPerSentence: [0, 2],
  gapSec: [0.8, 2.5], // between sentences
  breathChance: 0.5, // a breath in a gap: band of noise, ~0.3 s
  clickChance: 0.4, // a click in a gap: a few ms burst
  floorRms: 0.002, // the room, under the silence level (0.012)
};

const sec = (s) => Math.round(s * SAMPLE_RATE);

// Silence at the room's floor.
function roomTone(n, rand, rms = DICTATION_SHAPE.floorRms) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * rms * Math.sqrt(3);
  return out;
}

// A breath: noise under a sine envelope, peaking around 0.03 RMS.
function breath(rand) {
  const n = sec(0.25 + rand() * 0.2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * 0.05 * Math.sin((Math.PI * i) / n);
  return out;
}

// A click: a few milliseconds of loud, decaying noise (a key, the hotkey).
function click(rand) {
  const n = sec(0.004 + rand() * 0.006);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * 0.4 * (1 - i / n);
  return out;
}

// Where in a sentence clip a hesitation goes: the quietest 100 ms between
// 25 % and 75 % of it — a gap between words, usually, and sometimes a
// stretch inside one, which is what people do too.
function hesitationPoints(clip, count) {
  const floats = Float32Array.from(clip, (x) => x / 32768);
  const points = [];
  const lo = Math.floor(floats.length * 0.25);
  const hi = Math.floor(floats.length * 0.75);
  const span = Math.floor((hi - lo) / Math.max(1, count));
  for (let k = 0; k < count && span > sec(0.2); k++) {
    const from = lo + k * span;
    points.push(from + quietestOffset(floats.subarray(from, from + span), sec(0.1), sec(0.01)));
  }
  return points;
}

/**
 * One dictation-shaped recording from sentence clips: each clip in order,
 * hesitations inside them, gaps between them with breaths and clicks, a
 * click at either end — all over the room's floor. The words are the clips'
 * and nothing else, so the clips' text stays the reference.
 * @param {Int16Array[]} clips
 * @param {number} seed
 * @returns {Int16Array}
 */
function dictationRecording(clips, seed) {
  const rand = mulberry32(seed);
  const between = ([a, b]) => a + rand() * (b - a);
  const parts = [roomTone(sec(0.1), rand), click(rand), roomTone(sec(0.5), rand)];
  clips.forEach((clip, ci) => {
    const [minH, maxH] = DICTATION_SHAPE.hesitationsPerSentence;
    const points = hesitationPoints(clip, minH + Math.floor(rand() * (maxH - minH + 1)));
    let from = 0;
    for (const at of [...points, clip.length]) {
      parts.push(Float32Array.from(clip.subarray(from, at), (x) => x / 32768));
      if (at < clip.length) parts.push(roomTone(sec(between(DICTATION_SHAPE.hesitationSec)), rand));
      from = at;
    }
    if (ci === clips.length - 1) return;
    const gap = sec(between(DICTATION_SHAPE.gapSec));
    const extras = [];
    if (rand() < DICTATION_SHAPE.breathChance) extras.push(breath(rand));
    if (rand() < DICTATION_SHAPE.clickChance) extras.push(click(rand));
    const room = Math.max(0, gap - extras.reduce((n, x) => n + x.length, 0));
    const slices = extras.length + 1;
    for (let i = 0; i < slices; i++) {
      parts.push(roomTone(Math.floor(room / slices), rand));
      if (extras[i]) parts.push(extras[i]);
    }
  });
  parts.push(roomTone(sec(0.6), rand), click(rand), roomTone(sec(0.1), rand));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[at + i] = Math.max(-32768, Math.min(32767, Math.round(p[i] * 32768)));
    at += p.length;
  }
  // The clips' own floor is digital silence in places; add the room over all.
  const floor = roomTone(total, rand);
  for (let i = 0; i < total; i++) out[i] = Math.max(-32768, Math.min(32767, out[i] + Math.round(floor[i] * 32768)));
  return out;
}

// The sentences for one target length: distinct sentence ids, one gender, tsv
// order, until the running length (clips + gaps) reaches the target.
function pickSentences(rows, targetSec) {
  const seen = new Set();
  const picked = [];
  let sec = 0;
  for (const r of rows) {
    if (r.gender !== "FEMALE" || seen.has(r.sentenceId)) continue;
    seen.add(r.sentenceId);
    picked.push(r);
    sec += r.numSamples / SAMPLE_RATE + GAP_SAMPLES / SAMPLE_RATE;
    if (sec >= targetSec) break;
  }
  return picked;
}

// Word ratio and WER of one hypothesis against its reference, both normalised
// the way eval-stt.js scores (scripts/stt-eval.js).
function score(refText, hypText) {
  const ref = e.normalise(refText);
  const hyp = e.normalise(hypText || "");
  const counts = e.editCounts(ref, hyp);
  return { refWords: ref.length, hypWords: hyp.length, ratio: ref.length ? hyp.length / ref.length : 0, wer: ref.length ? counts.errors / ref.length : 0, counts };
}

// Short-clip baseline of the first `n` clips — a recording's own sentences,
// since every target's sentences are a prefix of the longest target's.
// `scores` holds each clip's edit counts and hypothesis word count.
function prefixBaseline(scores, n) {
  if (n > scores.length) throw new Error(`baseline for ${n} clips, but only ${scores.length} clips were decoded`);
  const counts = scores.slice(0, n).map((s) => s.counts);
  const refWords = counts.reduce((sum, c) => sum + c.ref, 0);
  const hypWords = scores.slice(0, n).reduce((sum, s) => sum + s.hypWords, 0);
  return { clips: n, wer: e.corpusWer(counts), ratio: refWords ? hypWords / refWords : 0 };
}

// Why a pieces run fails the gate; empty when it passes.
function judgePieces(run, { shortWer, cap, minRatio, maxWerOverShort }) {
  const reasons = [];
  if (run.error) reasons.push(`failed: ${run.error}`);
  if (!run.hypWords) reasons.push("empty transcript");
  if (run.ratio < minRatio) reasons.push(`word ratio ${run.ratio.toFixed(3)} < ${minRatio}`);
  const ceiling = shortWer + maxWerOverShort;
  if (run.wer > ceiling) reasons.push(`WER ${(run.wer * 100).toFixed(1)}% > ${(ceiling * 100).toFixed(1)}% (short-clip ${(shortWer * 100).toFixed(1)}% + ${(maxWerOverShort * 100).toFixed(1)} pts)`);
  if (run.maxPieceSec > cap + 1e-6) reasons.push(`a ${run.maxPieceSec.toFixed(1)} s worker input exceeds the ${cap} s cap`);
  if (run.failedPieces) reasons.push(`${run.failedPieces} piece(s) failed`);
  if (run.alive === false) reasons.push("the worker did not answer a short decode afterwards");
  return reasons;
}

function markdown(result) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `Model ${result.model}; each recording is held to its own sentences decoded one clip at a time (short-clip WER)`,
    "",
    "| recording | audio | short-clip WER | decode | pieces | longest piece | word ratio | WER | worker | result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of result.runs) {
    const worker = r.error ? `${r.error}${r.exitCode !== undefined ? ` (exit code ${r.exitCode})` : ""}` : r.alive === false ? "dead after" : "ok";
    const verdict = r.mode === "single" || r.mode === "before" ? "(before)" : r.reasons.length ? `FAIL: ${r.reasons.join("; ")}` : "pass";
    const shape = r.mode === "single" ? "one buffer" : r.mode === "before" ? `every pause + ≤ ${r.cap} s cap` : `${r.pauses ? "pauses + " : ""}≤ ${r.cap} s cap`;
    lines.push(`| ${r.corpus || "read"} | ${r.audioSec.toFixed(1)} s | ${pct(r.baseline.wer)} (${r.baseline.clips} clips) | ${shape} | ${r.pieces}${r.unconfirmedPieces ? ` (${r.unconfirmedPieces} empty)` : ""} | ${r.maxPieceSec.toFixed(1)} s | ${r.ratio.toFixed(3)} | ${pct(r.wer)} | ${worker} | ${verdict} |`);
  }
  return lines.join("\n");
}

/* ---------------- measurement (Electron) ---------------- */

const log = (...args) => console.error("[eval-long-decode]", ...args);

// A real engine worker with the model loaded on demand — reloaded after the
// worker dies, the way the app's facade does it.
function createWorker(model, dir) {
  const { createHost } = require("../main/engines/host");
  const host = createHost({ serviceName: "earheart-long-decode" });
  let loaded = false;
  host.onExit(() => {
    loaded = false;
  });
  async function ensure() {
    if (loaded) return;
    await host.request("load-stt", { dir, sherpa: model.sherpa, modelId: model.id }, { timeoutMs: LOAD_TIMEOUT_MS });
    loaded = true;
  }
  return {
    async transcribe(wav, { onDecodeMs } = {}) {
      await ensure();
      const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
      const reply = await host.request("transcribe", { wav: ab }, { timeoutMs: transcribeTimeoutMs(wavDurationSec(wav)) });
      if (onDecodeMs && Number.isFinite(reply?.decodeMs)) onDecodeMs(reply.decodeMs);
      return (reply?.text || "").trim();
    },
    restart: () => host.stop(),
    stop: () => host.stop(),
  };
}

// One (recording, mode) measurement: decode, score against the reference,
// check the worker still answers, and judge a pieces run against the gate.
async function measureMode(m, { worker, wav, audioSec, ref, target, utterances, baseline, aliveWav, opts }) {
  const row = { target, audioSec, utterances, baseline, ...m };
  const inputs = [];
  let decodeMs = 0;
  const runTranscribe = (piece, decodeOpts) => {
    inputs.push(wavDurationSec(piece));
    return worker.transcribe(piece, { onDecodeMs: (ms) => { decodeMs += ms; decodeOpts?.onDecodeMs?.(ms); } });
  };
  const startedAt = Date.now();
  let text = "";
  try {
    if (m.mode === "single") {
      text = await runTranscribe(wav);
      row.pieces = 1;
      row.failedPieces = 0;
    } else {
      const r = await transcribeChunked(wav, {
        runTranscribe,
        restartStt: worker.restart,
        maxSec: m.cap,
        minPauseSec: m.pauses ? undefined : Infinity,
        // "before": cut at every pause, decode every piece — the splitter
        // until it handled hesitations and noise.
        ...(m.mode === "before" ? { minSoundSec: 0, minUtteranceSec: 0, keepPauseSec: Infinity } : {}),
        log: { warn: (...a) => log(...a) },
      });
      text = r.text;
      row.pieces = r.pieces.length;
      row.failedPieces = r.pieces.filter((p) => !p.ok).length;
      // Heard speech, decoded to nothing even padded: accepted, but counted.
      row.unconfirmedPieces = r.pieces.filter((p) => p.ok && p.unconfirmed).length;
      row.noisePieces = r.pieces.filter((p) => p.noise).length;
      row.pieceSeconds = r.pieces.map((p) => +((p.toFrame - p.fromFrame) / SAMPLE_RATE).toFixed(2));
      const failed = r.pieces.find((p) => !p.ok);
      if (failed) Object.assign(row, { error: failed.error, exitCode: failed.exitCode });
    }
  } catch (err) {
    Object.assign(row, { error: err.message, code: err.code, exitCode: err.exitCode, pieces: row.pieces || inputs.length, failedPieces: 1 });
  }
  row.wallMs = Date.now() - startedAt;
  row.decodeMs = decodeMs;
  row.workerInputs = inputs.length;
  row.maxPieceSec = inputs.length ? Math.max(...inputs) : 0;
  Object.assign(row, score(ref, text));
  delete row.counts;
  row.text = text;
  // Is the worker still usable? A short decode through the same host.
  try {
    row.alive = !!(await worker.transcribe(aliveWav));
  } catch (err) {
    row.alive = false;
    row.aliveError = err.message;
  }
  row.reasons = m.mode === "pieces"
    ? judgePieces(row, { shortWer: baseline.wer, cap: m.cap, minRatio: opts.minRatio, maxWerOverShort: opts.maxWerOverShort })
    : [];
  log(`${m.corpus || "read"} ${audioSec.toFixed(1)} s ${m.mode}${m.cap ? ` cap ${m.cap}` : ""}: ratio ${row.ratio.toFixed(3)}, WER ${(row.wer * 100).toFixed(1)}%, pieces ${row.pieces}, max ${row.maxPieceSec.toFixed(1)} s${row.error ? `, ${row.error}${row.exitCode !== undefined ? ` (exit code ${row.exitCode})` : ""}` : ""}${row.reasons.length ? ` — FAIL ${row.reasons.join("; ")}` : ""}`);
  return row;
}

async function run(opts) {
  const { app } = require("electron");
  await app.whenReady();
  const cacheDir = path.resolve(opts.cacheDir);
  const model = registry.getModel("stt", opts.model);
  if (!model) throw new Error(`unknown STT model ${opts.model}`);
  if (!manager.isInstalled(cacheDir, model)) throw new Error(`${model.id} is not in ${cacheDir} — build the cache with scripts/eval-stt.js (see the header)`);
  const corpusDir = manager.modelDir(cacheDir, { kind: "corpus", id: manifest.CORPUS.id });
  const clipsDir = path.join(corpusDir, "pcm16");
  if (!fs.existsSync(path.join(clipsDir, ".complete"))) throw new Error(`no extracted clips in ${clipsDir} — build the cache with scripts/eval-stt.js`);
  const rows = e.parseFleursTsv(fs.readFileSync(path.join(corpusDir, manifest.CORPUS.tsv), "utf8"));
  const clip = (r) => {
    const buf = fs.readFileSync(path.join(clipsDir, r.file));
    return new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
  };

  const worker = createWorker(model, manager.modelDir(cacheDir, model));
  const result = { model: model.id, electron: process.versions.electron, at: new Date().toISOString(), options: opts, runs: [] };
  try {
    // Baseline: every sentence the longest recording uses, one clip per
    // decode, scored per clip so each recording's own prefix can be summed.
    const longest = pickSentences(rows, Math.max(...opts.targets));
    const clipScores = [];
    for (const r of longest) clipScores.push(score(r.raw, await worker.transcribe(encodeWav(clip(r)))));

    for (const target of opts.targets) {
      const picked = pickSentences(rows, target);
      if (picked.some((r, i) => r.file !== longest[i].file)) throw new Error(`${target} s sentences are not a prefix of the baseline set`);
      const baseline = prefixBaseline(clipScores, picked.length);
      log(`${target} s baseline: ${baseline.clips} clips, WER ${(baseline.wer * 100).toFixed(2)}%, ratio ${baseline.ratio.toFixed(3)}`);
      const pcm = opts.dictation ? dictationRecording(picked.map(clip), opts.seed) : e.concatPcm16(picked.map(clip), GAP_SAMPLES);
      const wav = encodeWav(pcm);
      const audioSec = wavDurationSec(wav);
      const ref = picked.map((r) => r.raw).join(" ");
      const corpus = opts.dictation ? "dictation" : "read";
      const modes = [
        ...(opts.single ? [{ mode: "single" }] : []),
        ...(opts.before && opts.pauses ? opts.caps.map((cap) => ({ mode: "before", cap, pauses: true })) : []),
        ...opts.caps.map((cap) => ({ mode: "pieces", cap, pauses: opts.pauses })),
      ].map((m) => ({ ...m, corpus }));
      const aliveWav = encodeWav(clip(picked[0]));
      for (const m of modes) {
        result.runs.push(
          await measureMode(m, { worker, wav, audioSec, ref, target, utterances: picked.length, baseline, aliveWav, opts })
        );
      }
    }
  } finally {
    worker.stop();
  }
  fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${markdown(result)}\n`);
  return result.runs.some((r) => r.reasons.length) ? 1 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cacheDir || !opts.out) throw new Error("--cache-dir <dir> and --out <file.json> are required");
  if (!process.versions.electron) throw new Error("needs Electron: npx electron scripts/eval-long-decode.js …");
  return run(opts);
}

// Run only as the entry script. Electron's loader doesn't make the entry
// require.main, so compare against the script it was started with; requiring
// this file for its helpers (tests, lab probes) never starts a run.
const isEntry =
  require.main === module ||
  (!!process.versions.electron && !!process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (isEntry) {
  main().then(
    (code) => (process.versions.electron ? require("electron").app.exit(code) : process.exit(code)),
    (err) => {
      log("failed:", (err && err.stack) || err);
      if (process.versions.electron) require("electron").app.exit(1);
      else process.exit(1);
    }
  );
}

module.exports = { parseArgs, pickSentences, score, prefixBaseline, judgePieces, markdown, dictationRecording, mulberry32 };
