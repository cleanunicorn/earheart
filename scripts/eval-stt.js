// Measure the in-process speech-to-text models against each other — the
// harness behind "is there a model that's as good as the shipped Parakeet, or
// better, but faster?".
//
//   xvfb-run -a npx electron scripts/eval-stt.js --no-sandbox --out stt-eval.json   # Linux
//   npx electron scripts/eval-stt.js --out stt-eval.json                            # macOS / Windows
//
// On a machine that is not reliably quiet, split it (what produced the PR's
// numbers): accuracy needs no quiet machine, speed does.
//
//   … eval-stt.js --pass accuracy --exploratory --out acc.json   # all 647 clips, load ignored
//   … eval-stt.js --pass speed --exploratory --out speed.json    # quiet gate, 1/4 of the clips
//   node scripts/eval-stt.js --combine acc.json speed.json --out stt-eval.json
//
// Sharing the CPU with another benchmark? Agree on a lock file: run the timed
// pass as `flock LOCK xvfb-run … --pass speed --cpu-lock LOCK …` (it refuses
// to start without the lock), and give the accuracy pass `--cpu-lock LOCK` so
// it pauses before each model while anyone holds it.
//
//   node scripts/eval-stt.js --report stt-eval.json        # Markdown table from a run
//   node scripts/eval-stt.js --verify-shipped              # re-derive the catalog's pins
//   node scripts/eval-stt.js --discover owner/repo[@commit] …   # pins for a new model
//
// Flags: --cache-dir <dir> (default <userData>/stt-eval; models, corpus and
// clips land there, never in the repo), --models id,id (subset, for
// development), --limit N (first N utterances, for development — the headline
// uses all 647), --keep (don't delete a model after measuring it),
// --quiet-load N (wait for the 1-minute load average to reach N before each
// model; default 4, "Infinity" to not wait), --pass accuracy|speed (one half
// of a split run; default both), --combine <acc.json> [speed.json] (judge a
// split run), --cpu-lock <file> (see above),
// --exploratory (also measure families the worker can't run yet), --resume
// (reuse the measured rows of an existing --out file), --log <file> (append
// one line per model).
//
// WHAT IT MEASURES. Every model is measured through the app's own engine
// worker (main/engines/engine-worker.js, forked by main/engines/host.js),
// never a copy of its recognizer config: the speed number is the worker's own
// `decodeMs` around recognizer.decode(), the same number that paces the
// overlay's transcribing bar. load-stt reports the thread count and provider
// it used, and a model is refused unless that is CPU at the app's
// min(8, cpus-1). Each model gets a fresh worker (a replaced recognizer's
// native memory is only reclaimed when the worker exits): cold load, one
// first decode and one discarded warm-up of a declared clip (their texts must
// match), then the scored pass over every utterance. Headline speed is the
// aggregate decode RTF (total decode time / total audio); p50/p95 per
// utterance and the harness's own wall clock around each request are reported
// beside it, so IPC overhead is visible and never folded in.
//
// THE CORPUS is FLEURS en_us test (google/fleurs, CC BY 4.0), pinned to a
// commit and checksum: 647 utterances of 350 sentences, 106.5 min, 16 kHz.
// It is READ speech of encyclopaedic sentences, not dictation captured
// through Earheart's microphone path. Clips are re-encoded to exactly the
// PCM16 the overlay produces, so the worker parses them with its own reader,
// after one fixed level normalisation that stands in for the overlay's
// autoGainControl (-20 dBFS RMS, peak <= 0.99): FLEURS has recordings as
// quiet as -44 dBFS, which no model in the app would ever be handed.
// Their length (mean 9.9 s, max 29 s) matches what the app decodes by
// default: live preview commits 10-20 s chunks and only the tail is decoded at
// stop. With live preview off, a whole recording (up to 300 s) goes in as one
// buffer; a candidate that clears the threshold is also run on ~60 s and
// ~300 s concatenations to catch a model that drops words there.
//
// ACCURACY is WER after the normalisation spelled out in scripts/stt-eval.js
// (wer_norm, the threshold metric), with wer_verbatim (case and punctuation
// kept), the model's punctuation/capitalisation/hesitation rates, WER on the
// utterances free of number constructs the normaliser doesn't model, and a
// paired bootstrap interval (resampling sentences) for every difference from
// the default.
//
// THE THRESHOLD (stt-model-eval-Q3, fixed before any number existed): a
// candidate earns a catalog entry when, against parakeet-tdt-0.6b-v3-int8 in
// the same run, it is (a) >= 1.3x faster with WER at most 1.0 point worse, or
// (b) lower WER at most 1.1x slower — and does not drop more words on long
// audio than the default does (Q5, revised by Q7: see longFormCompatible). WER always comes from the full corpus. Speed counts only from a quiet
// machine: each model waits for a 1-minute load average of 4, the default is
// measured first and last, and if the two disagree by more than 10 % the run
// is unstable and no speed-based verdict is given. A split run's accuracy
// pass records its decode times as contended and they never reach a verdict;
// its speed pass decodes a declared quarter of the corpus (every 4th sentence,
// scripts/stt-eval.js speedSubset) so a short quiet window is enough.
//
// Numbers are the machine's, not the model's: every run records the CPU, RAM,
// OS, Electron and sherpa-onnx-node versions, and the load average around each
// model. Not in the test suite — it downloads gigabytes. The pure parts are
// pinned in test/stt-eval.test.js.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { execFileSync } = require("node:child_process");

const e = require("./stt-eval");
const manifest = require("./stt-eval-manifest");
const registry = require("../main/engines/registry");
const manager = require("../main/engines/model-manager");
const { listSttVariants } = require("../main/services/hf-models");
const { SAMPLE_RATE } = require("../main/util/wav");

const SCHEMA = 1;
// What the worker must report back — the app's own thread count.
const APP_THREADS = Math.max(1, Math.min(8, os.cpus().length - 1));
const DISK_BUDGET_BYTES = 20e9; // this item's share of a disk used by others too
const MIN_FREE_BYTES = 10e9; // never take the disk below this for anyone
const MAX_EMPTY_RATE = 0.05;
const BRACKET_DRIFT = 0.1;
const LONG_FORM_TARGETS = [60, 300];
const LONG_FORM_GAP_SAMPLES = Math.round(0.3 * SAMPLE_RATE);
// Speed is only comparable on a quiet machine, and this one is shared. Before
// each model the run waits (up to QUIET_TIMEOUT_MS) for the 1-minute load
// average to fall to QUIET_LOAD, and records what it saw either way; the
// default measured first and last is the check that it worked.
const QUIET_LOAD = 4;
const QUIET_POLL_MS = 30000;
const QUIET_TIMEOUT_MS = 4 * 3600 * 1000;
// A low load average is not enough on its own: the parallel cleanup run
// benchmarks on this same CPU. Its processes are only OBSERVED (pgrep, read
// only — never signalled or reniced): sampled before, every
// OTHER_RUN_SAMPLE_MS during, and after each model's decodes. A speed row
// measured while one was running is contended, and a speed pass re-measures
// it (up to SPEED_ATTEMPTS times) once the machine is quiet again.
const OTHER_RUN_PATTERN = "bench-cleanup|eval-cleanup";
const OTHER_RUN_SAMPLE_MS = 10000;
const SPEED_ATTEMPTS = 3;
// Cross-run CPU lock (--cpu-lock <file>). A timed pass (speed / both) runs
// under `flock <file> …` for its whole duration, and refuses to start if the
// lock is not held; the accuracy pass, which is untimed, waits before every
// model and every long-form set while ANYONE holds it, so it never loads the
// CPU under another run's timings (or this run's own speed pass).
const LOCK_POLL_MS = 30000;

/* ---------------- arguments ---------------- */

function parseArgs(argv) {
  const opts = {
    models: null, limit: 0, keep: false, exploratory: false, resume: false, discover: [],
    quietLoad: QUIET_LOAD, pass: "both", combine: [], otherRunPattern: OTHER_RUN_PATTERN, cpuLock: null,
  };
  const valued = new Set(["--out", "--cache-dir", "--models", "--limit", "--report", "--log", "--quiet-load", "--pass", "--other-run-pattern", "--cpu-lock"]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value = null;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (valued.has(arg) && value === null) value = argv[++i];
    switch (arg) {
      case "--out": opts.out = value; break;
      case "--cache-dir": opts.cacheDir = value; break;
      case "--models": opts.models = value.split(",").filter(Boolean); break;
      case "--limit": opts.limit = Number(value); break;
      case "--report": opts.report = value; break;
      case "--log": opts.log = value; break;
      case "--quiet-load": opts.quietLoad = Number(value); break;
      case "--other-run-pattern": opts.otherRunPattern = value; break;
      case "--cpu-lock": opts.cpuLock = path.resolve(value); break;
      case "--pass":
        if (!["both", "accuracy", "speed"].includes(value)) throw new Error(`--pass must be accuracy, speed or both`);
        opts.pass = value;
        break;
      case "--combine":
        while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.combine.push(argv[++i]);
        break;
      case "--keep": opts.keep = true; break;
      case "--exploratory": opts.exploratory = true; break;
      case "--resume": opts.resume = true; break;
      case "--verify-shipped": opts.verifyShipped = true; break;
      case "--discover":
        while (argv[i + 1] && !argv[i + 1].startsWith("--")) opts.discover.push(argv[++i]);
        break;
      default:
        // Chromium's own switches (--no-sandbox, …) reach the script too.
        if (!arg.startsWith("--no-sandbox") && !arg.startsWith("--enable-") && !arg.startsWith("--disable-")) {
          throw new Error(`unknown argument: ${argv[i]}`);
        }
    }
  }
  return opts;
}

const log = (...args) => console.error("[eval-stt]", ...args);

/* ---------------- pin discovery (plain Node) ---------------- */

async function hashStream(readable) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of readable) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function hashFile(file) {
  return hashStream(fs.createReadStream(file));
}

// bytes + sha256 for one file at a pinned commit: the LFS etag when it is a
// sha256, else download and hash (tokens.txt and other git-stored files).
async function pinFile(url) {
  const head = await fetch(url, { method: "HEAD", redirect: "manual" });
  const sha256 = e.sha256FromLinkedEtag(head.headers.get("x-linked-etag"));
  const size = Number(head.headers.get("x-linked-size") || 0);
  if (sha256 && size) return { bytes: size, sha256, from: "x-linked-etag" };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const { sha256: hashed, bytes } = await hashStream(res.body);
  return { bytes, sha256: hashed, from: "download" };
}

async function repoInfo(owner, repo, ref) {
  const base = `https://huggingface.co/api/models/${owner}/${repo}`;
  const info = await (await fetch(ref ? `${base}/revision/${ref}` : base)).json();
  if (!info.sha) throw new Error(`${owner}/${repo}: no commit (${JSON.stringify(info).slice(0, 200)})`);
  const tree = await (await fetch(`${base}/tree/${info.sha}?recursive=true`)).json();
  return {
    commit: info.sha,
    gated: Boolean(info.gated),
    files: tree.filter((f) => f.type === "file").map((f) => ({ path: f.path, bytes: f.size })),
  };
}

/**
 * Pins for one repo: the commit, every file's bytes and sha256, and — when
 * hf-models recognises it as a transducer or Whisper bundle — the per-precision
 * `sherpa` wiring the worker needs.
 */
async function discover(spec) {
  const [full, ref] = spec.split("@");
  const [owner, repo] = full.split("/");
  const info = await repoInfo(owner, repo, ref);
  const url = (p) => `https://huggingface.co/${owner}/${repo}/resolve/${info.commit}/${p}`;
  const files = [];
  for (const f of info.files) {
    if (f.path === ".gitattributes" || /(^|\/)(README\.md|test_wavs\/)/.test(f.path)) continue;
    files.push({ name: f.path.split("/").pop(), path: f.path, url: url(f.path), ...(await pinFile(url(f.path))) });
  }
  let variants = null;
  try {
    const listed = await listSttVariants({ owner, repo, ref: info.commit }, fetch);
    const byUrl = new Map(files.map((f) => [f.url, f]));
    variants = listed.variants.map((v) => ({
      label: v.label,
      files: v.files.map((f) => {
        const pinned = byUrl.get(f.url);
        return { name: f.name, bytes: pinned.bytes, sha256: pinned.sha256, url: f.url };
      }),
      sherpa: v.sherpa,
    }));
  } catch (err) {
    variants = { error: err.message };
  }
  return { repo: full, commit: info.commit, gated: info.gated, files, variants };
}

// Re-derive every shipped STT entry's pins from Hugging Face at its own commit
// and compare byte for byte — the self-test for the pins this tool produces.
async function verifyShipped() {
  let ok = true;
  for (const model of registry.listModels("stt")) {
    const [owner, repo, , commit] = new URL(model.files[0].url).pathname.split("/").filter(Boolean);
    const found = await discover(`${owner}/${repo}@${commit}`);
    const byName = new Map(found.files.map((f) => [f.name, f]));
    for (const file of model.files) {
      const got = byName.get(file.name);
      const same = got && got.bytes === file.bytes && got.sha256 === file.sha256 && got.url === file.url;
      if (!same) ok = false;
      log(`${same ? "ok  " : "DIFF"} ${model.id} ${file.name}`, same ? `(${got.from})` : JSON.stringify(got));
    }
  }
  return ok;
}

/* ---------------- corpus ---------------- */

async function prepareCorpus(cacheDir, limit, { speed = false } = {}) {
  const corpus = manifest.CORPUS;
  const model = { kind: "corpus", id: corpus.id, files: corpus.files };
  log(`corpus: ${corpus.source} @ ${corpus.commit}`);
  const cached = manager.isInstalled(cacheDir, model);
  for (const f of corpus.files) log(`  ${cached ? "cached" : "fetch"} ${f.url} (${f.bytes} B, sha256 ${f.sha256})`);
  await manager.download(cacheDir, model);
  const dir = manager.modelDir(cacheDir, model);
  for (const f of corpus.files) {
    const got = await hashFile(path.join(dir, f.name));
    if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) {
      throw new Error(`corpus file ${f.name} re-hash mismatch: ${JSON.stringify(got)}`);
    }
  }
  const rows = e.parseFleursTsv(fs.readFileSync(path.join(dir, corpus.tsv), "utf8"));
  if (rows.length !== corpus.utterances) {
    throw new Error(`expected ${corpus.utterances} utterances, tsv has ${rows.length}`);
  }
  const mismatches = e.tsvColumnMismatches(rows);
  if (mismatches.length > rows.length * 0.01) {
    throw new Error(`tsv columns disagree on ${mismatches.length} rows — parsed the wrong columns?`);
  }

  // Extract once: gunzip to a temporary .tar, walk it, write each clip as
  // overlay-identical PCM16, then drop the .tar.
  const clipsDir = path.join(dir, "pcm16");
  const done = path.join(clipsDir, ".complete");
  // The marker names the archive AND the conversion, so a change to either
  // re-extracts instead of silently reusing clips made the old way.
  const stamp = `${corpus.files[0].sha256} level:${e.TARGET_RMS}/${e.PEAK_CEILING}`;
  const gains = [];
  if (!fs.existsSync(done) || fs.readFileSync(done, "utf8").split("\n")[0] !== stamp) {
    await fsp.rm(clipsDir, { recursive: true, force: true });
    await fsp.mkdir(clipsDir, { recursive: true });
    const tarPath = path.join(dir, "audio.tar");
    await pipeline(fs.createReadStream(path.join(dir, corpus.archive)), zlib.createGunzip(), fs.createWriteStream(tarPath));
    const fd = fs.openSync(tarPath, "r");
    try {
      const readAt = (offset, length) => {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, offset);
        return buf;
      };
      let n = 0;
      for (const entry of e.tarEntries(readAt, fs.fstatSync(fd).size)) {
        if (!entry.name.endsWith(".wav")) continue;
        const { wav, gain } = e.toPcm16Wav(readAt(entry.offset, entry.size), { level: true });
        fs.writeFileSync(path.join(clipsDir, path.basename(entry.name)), wav);
        gains.push(gain);
        n++;
      }
      log(`  extracted ${n} clips`);
    } finally {
      fs.closeSync(fd);
      await fsp.rm(tarPath, { force: true });
    }
    fs.writeFileSync(done, `${stamp}\n${JSON.stringify(gains)}`);
  }
  const levelGains = JSON.parse(fs.readFileSync(done, "utf8").split("\n")[1]);

  const clips = rows.map((r) => {
    const wavPath = path.join(clipsDir, r.file);
    if (!fs.existsSync(wavPath)) throw new Error(`clip ${r.file} missing from the archive`);
    const samples = (fs.statSync(wavPath).size - 44) / 2;
    return {
      file: r.file,
      sentenceId: r.sentenceId,
      gender: r.gender,
      raw: r.raw,
      samples,
      expectedSamples: r.numSamples,
      audioSec: samples / SAMPLE_RATE,
      wavPath,
      refNorm: e.normalise(r.raw),
      refVerbatim: e.normalise(r.raw, e.VERBATIM),
      unmodelled: e.hasUnmodelledConstruct(r.raw),
    };
  });
  // Duration accounting: the audio we decode is the audio the tsv describes.
  const got = clips.reduce((s, c) => s + c.samples, 0);
  const want = clips.reduce((s, c) => s + c.expectedSamples, 0);
  if (Math.abs(got - want) / SAMPLE_RATE > 0.1) {
    throw new Error(`clip durations ${got / SAMPLE_RATE}s != tsv ${want / SAMPLE_RATE}s`);
  }
  const limited = limit > 0 ? clips.slice(0, limit) : clips;
  const selected = speed ? e.speedSubset(limited) : limited;
  return {
    allClips: clips,
    id: corpus.id,
    source: corpus.source,
    commit: corpus.commit,
    licence: corpus.licence,
    files: corpus.files.map(({ name, bytes, sha256, url }) => ({ name, bytes, sha256, url })),
    utterances: selected.length,
    sentences: new Set(selected.map((c) => c.sentenceId)).size,
    referenceWords: selected.reduce((s, c) => s + c.refNorm.length, 0),
    audioSec: selected.reduce((s, c) => s + c.audioSec, 0),
    columnMismatches: mismatches.length,
    level: {
      targetRms: e.TARGET_RMS,
      peakCeiling: e.PEAK_CEILING,
      gainP50: e.percentile(levelGains, 50),
      gainMin: Math.min(...levelGains),
      gainMax: Math.max(...levelGains),
    },
    unmodelledUtterances: selected.filter((c) => c.unmodelled).length,
    limited: limit > 0,
    subset: speed ? `speed: every ${e.SPEED_SUBSET_EVERY}th sentence cluster by numeric sentence id` : "all",
    utteranceIndex: selected.map((c) => ({ file: c.file, sentenceId: c.sentenceId, refWords: c.refNorm.length })),
    clips: selected,
  };
}

// ~60 s and ~300 s single buffers of distinct sentences, same speaker gender,
// 300 ms apart — the live-preview-off shape. Deterministic: tsv order.
function buildLongForm(clips) {
  const out = [];
  for (const target of LONG_FORM_TARGETS) {
    const seen = new Set();
    const picked = [];
    let sec = 0;
    for (const c of clips) {
      if (c.gender !== "FEMALE" || seen.has(c.sentenceId)) continue;
      seen.add(c.sentenceId);
      picked.push(c);
      sec += c.audioSec + LONG_FORM_GAP_SAMPLES / SAMPLE_RATE;
      if (sec >= target) break;
    }
    const pcm = e.concatPcm16(
      picked.map((c) => {
        const buf = fs.readFileSync(c.wavPath);
        return new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
      }),
      LONG_FORM_GAP_SAMPLES
    );
    const raw = picked.map((c) => c.raw).join(" ");
    out.push({
      label: `${target}s`,
      audioSec: pcm.length / SAMPLE_RATE,
      wav: require("../main/util/wav").encodeWav(pcm, SAMPLE_RATE),
      refNorm: e.normalise(raw),
      utterances: picked.map((c) => c.file),
    });
  }
  return out;
}

/* ---------------- recognisers ---------------- */

// The app's path: a fresh engine worker per model.
function workerRecognizer(model, dir) {
  const { createHost } = require("../main/engines/host");
  const host = createHost({ serviceName: "earheart-stt-eval" });
  return {
    path: "worker",
    async load() {
      return host.request("load-stt", { dir, sherpa: model.sherpa, modelId: model.id }, { timeoutMs: 600000 });
    },
    async transcribe(wav, audioSec) {
      return host.request("transcribe", { wav }, { timeoutMs: Math.max(180000, audioSec * 20000) });
    },
    close() {
      host.stop();
    },
  };
}

// The exploratory path, for families the worker has no config for yet: the
// same recognizer settings in scripts/stt-eval-worker.js, forked the same way
// (a utilityProcess). Rows from here are labelled and compared only against
// the default measured through the same file (the calibration row); a winner
// is wired into the real worker and re-measured there before it can reach the
// catalog.
function directRecognizer(model, dir) {
  const { utilityProcess } = require("electron");
  const child = utilityProcess.fork(path.join(__dirname, "stt-eval-worker.js"), [], {
    serviceName: "earheart-stt-eval-direct",
    stdio: "inherit",
  });
  let nextId = 1;
  const pending = new Map();
  child.on("message", (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  });
  child.on("exit", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("exploratory worker exited"));
    }
    pending.clear();
  });
  const request = (type, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, type, ...args });
    });
  return {
    path: "direct",
    load: () => request("load", { dir, sherpa: model.sherpa }, 600000),
    transcribe: (wav, audioSec) => request("transcribe", { wav }, Math.max(180000, audioSec * 20000)),
    close: () => child.kill(),
  };
}

/* ---------------- measuring one model ---------------- */

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function diskCheck(cacheDir, model) {
  const need = model.files.reduce((s, f) => s + (f.bytes || 0), 0);
  const st = fs.statfsSync(cacheDir);
  const free = st.bavail * st.bsize;
  const used = dirSize(cacheDir);
  if (free - need < MIN_FREE_BYTES) return `disk: ${need} B needed, ${free} B free, floor ${MIN_FREE_BYTES} B`;
  if (used + need > DISK_BUDGET_BYTES) return `disk: ${used} B cached + ${need} B > budget ${DISK_BUDGET_BYTES} B`;
  return null;
}

function scoreDecodes(corpus, decodes) {
  const norm = [];
  const verb = [];
  const clean = [];
  corpus.clips.forEach((c, i) => {
    const text = decodes[i].text;
    const n = e.editCounts(c.refNorm, e.normalise(text));
    norm.push(n);
    verb.push(e.editCounts(c.refVerbatim, e.normalise(text, e.VERBATIM)));
    if (!c.unmodelled) clean.push(n);
  });
  const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
  return {
    errors: sum(norm, "errors"),
    ref: sum(norm, "ref"),
    sub: sum(norm, "sub"),
    del: sum(norm, "del"),
    ins: sum(norm, "ins"),
    werNorm: e.corpusWer(norm),
    werNormMeanUtt: e.meanUtteranceWer(norm),
    werVerbatim: e.corpusWer(verb),
    werNormClean: e.corpusWer(clean),
    perUtteranceErrors: norm.map((x) => x.errors),
  };
}

function ablation(corpus, decodes) {
  const base = e.corpusWer(corpus.clips.map((c, i) => e.editCounts(c.refNorm, e.normalise(decodes[i].text))));
  const out = { all: base };
  for (const stage of Object.keys(e.ALL_STAGES)) {
    const off = { [stage]: false };
    out[`without_${stage}`] = e.corpusWer(
      corpus.clips.map((c, i) => e.editCounts(e.normalise(c.raw, off), e.normalise(decodes[i].text, off)))
    );
  }
  return out;
}

async function measureModel(entry, ctx) {
  const { model, role, arm } = entry;
  const row = { id: model.id, label: model.label, role, arm, path: arm === "exploratory" || role === "calibration" ? "direct" : "worker" };
  const blocked = diskCheck(ctx.cacheDir, model);
  if (blocked) return { ...row, status: "skipped", reason: blocked };

  const dl = Date.now();
  const cached = manager.isInstalled(ctx.cacheDir, model);
  for (const f of model.files) log(`  ${cached ? "cached" : "fetch"} ${f.url} (${f.bytes} B, sha256 ${f.sha256})`);
  await manager.download(ctx.cacheDir, model);
  const dir = manager.modelDir(ctx.cacheDir, model);
  row.downloadMs = Date.now() - dl;
  row.files = [];
  for (const f of model.files) {
    const got = await hashFile(path.join(dir, f.name));
    if (got.sha256 !== f.sha256 || got.bytes !== f.bytes) {
      throw new Error(`${model.id}/${f.name}: re-hash mismatch ${JSON.stringify(got)}`);
    }
    row.files.push({ name: f.name, bytes: got.bytes, sha256: got.sha256, url: f.url });
  }
  row.bytes = row.files.reduce((s, f) => s + f.bytes, 0);

  const rec = row.path === "direct" ? directRecognizer(model, dir) : workerRecognizer(model, dir);
  row.loadavgBefore = os.loadavg();
  const sampler = otherRunSampler(ctx.opts.otherRunPattern);
  try {
    const t0 = Date.now();
    const loaded = await rec.load();
    row.coldLoadWallMs = Date.now() - t0;
    row.numThreads = loaded.numThreads;
    row.provider = loaded.provider;
    if (loaded.provider !== "cpu" || loaded.numThreads !== APP_THREADS) {
      throw new Error(`worker ran provider=${loaded.provider} threads=${loaded.numThreads}, app uses cpu/${APP_THREADS}`);
    }
    // Declared warm-up clip: the corpus's first utterance, decoded twice.
    const warm = ctx.corpus.clips[0];
    const warmWav = fs.readFileSync(warm.wavPath);
    const first = await rec.transcribe(warmWav, warm.audioSec);
    const second = await rec.transcribe(warmWav, warm.audioSec);
    row.firstDecodeMs = first.decodeMs;
    row.firstDecodeRtf = first.decodeMs / 1000 / warm.audioSec;
    row.deterministic = first.text === second.text;

    const decodes = [];
    for (const [i, c] of ctx.corpus.clips.entries()) {
      const wav = fs.readFileSync(c.wavPath);
      const t = process.hrtime.bigint();
      const r = await rec.transcribe(wav, c.audioSec);
      const wallMs = Number(process.hrtime.bigint() - t) / 1e6;
      decodes.push({ file: c.file, text: r.text, decodeMs: r.decodeMs, wallMs, audioSec: c.audioSec });
      if ((i + 1) % 100 === 0) log(`  ${model.id}: ${i + 1}/${ctx.corpus.clips.length}`);
    }
    if (decodes.length !== ctx.corpus.clips.length) throw new Error("coverage: missing hypotheses");
    const empty = decodes.filter((d) => !d.text).length;
    row.emptyRate = empty / decodes.length;
    const speed = e.rtfStats(decodes);
    const wall = e.rtfStats(decodes.map((d) => ({ decodeMs: d.wallMs, audioSec: d.audioSec })));
    Object.assign(row, {
      decodeRtf: speed.decodeRtf,
      p50Rtf: speed.p50,
      p95Rtf: speed.p95,
      wallRtf: wall.decodeRtf,
      decodeSec: speed.decodeSec,
      audioSec: speed.audioSec,
      ...scoreDecodes(ctx.corpus, decodes),
      ...e.styleRates(decodes.map((d) => d.text)),
    });
    row.decodes = decodes.map(({ file, text, decodeMs, wallMs }) => ({ file, text, decodeMs, wallMs: Math.round(wallMs * 10) / 10 }));
    if (row.emptyRate > MAX_EMPTY_RATE) {
      row.status = "failed";
      row.reason = `empty-output rate ${(row.emptyRate * 100).toFixed(1)} % > ${MAX_EMPTY_RATE * 100} %`;
    } else {
      row.status = "measured";
    }
    if (role === "bracket-first" && ctx.opts.pass !== "speed" && !ctx.ablation) {
      ctx.ablation = ablation(ctx.corpus, decodes);
    }

    // Q5: long single buffers. The accuracy pass runs them for every model
    // (it cannot know yet who clears Q3); a single quiet run only for the
    // default and anything clearing Q3; the speed pass never.
    const ref = row.path === "direct" ? ctx.calibration : ctx.bracketFirst;
    const passesQ3 =
      row.status === "measured" && ref && role !== "calibration" && model.id !== manifest.BASELINE_ID &&
      e.classify(ref, row).eligible;
    const isDefaultRun = model.id === manifest.BASELINE_ID && (role === "bracket-first" || role === "calibration");
    const wantLongForm =
      ctx.opts.pass === "accuracy" ? row.status === "measured" : ctx.opts.pass === "both" && (isDefaultRun || passesQ3);
    if (wantLongForm) {
      if (ctx.opts.pass === "accuracy") {
        row.lockWaitLongFormMs = await waitForLock(ctx.opts.cpuLock, `${model.id} long-form`, ctx.appendLog);
      }
      row.longForm = [];
      for (const clip of ctx.longForm) {
        try {
          const r = await rec.transcribe(clip.wav, clip.audioSec);
          const hyp = e.normalise(r.text);
          const counts = e.editCounts(clip.refNorm, hyp);
          row.longForm.push({
            label: clip.label,
            audioSec: clip.audioSec,
            decodeMs: r.decodeMs,
            decodeRtf: r.decodeMs / 1000 / clip.audioSec,
            wer: counts.errors / counts.ref,
            wordRatio: hyp.length / clip.refNorm.length,
            text: r.text,
          });
        } catch (err) {
          row.longForm.push({ label: clip.label, audioSec: clip.audioSec, error: String(err.message || err), wer: 1, wordRatio: 0 });
        }
      }
    }
  } catch (err) {
    row.status = "failed";
    row.reason = String((err && err.message) || err);
  } finally {
    rec.close();
    row.otherRun = sampler.stop();
    row.loadavgAfter = os.loadavg();
  }
  return row;
}

/* ---------------- the run ---------------- */

// Is a process of the other run alive? Read-only: pgrep lists, never signals.
// null where pgrep does not exist (Windows) — unknown, and recorded as such.
function otherRunActive(pattern) {
  if (!pattern) return false;
  try {
    const out = execFileSync("pgrep", ["-af", pattern], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // Not ourselves: this harness's own command line (and its xvfb/npx
    // wrappers) can carry the pattern when it is passed as a flag.
    return out.split("\n").some((line) => line.trim() && !line.includes("eval-stt.js"));
  } catch (err) {
    if (err.status === 1) return false; // pgrep: no match
    return null;
  }
}

// Samples otherRunActive now, every OTHER_RUN_SAMPLE_MS, and on stop().
function otherRunSampler(pattern) {
  const samples = [otherRunActive(pattern)];
  const timer = setInterval(() => samples.push(otherRunActive(pattern)), OTHER_RUN_SAMPLE_MS);
  return {
    stop() {
      clearInterval(timer);
      samples.push(otherRunActive(pattern));
      const hits = samples.filter((x) => x === true).length;
      const unknown = samples.filter((x) => x === null).length;
      return { pattern, samples: samples.length, hits, unknown, active: hits > 0 ? true : unknown ? null : false };
    },
  };
}

// Is the cross-run lock held right now (by anyone, us included)? Read-only:
// a non-blocking `flock -n` that takes and drops it at once if free.
function lockHeld(file) {
  try {
    execFileSync("flock", ["-n", file, "true"], { stdio: "ignore" });
    return false;
  } catch (err) {
    if (err.status === 1) return true;
    throw new Error(`cannot check --cpu-lock ${file}: ${err.message}`);
  }
}

// The accuracy pass's side of the lock: wait while it is held.
async function waitForLock(file, what, appendLog) {
  if (!file) return 0;
  const started = Date.now();
  let announced = false;
  while (lockHeld(file)) {
    if (!announced) {
      log(`cpu lock held — waiting before ${what}`);
      appendLog(`waiting: cpu lock held (before ${what})`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  return Date.now() - started;
}

async function waitForQuiet(limit, pattern, appendLog) {
  const started = Date.now();
  let load = os.loadavg()[0];
  let other = otherRunActive(pattern);
  let announced = false;
  while ((load > limit || other === true) && Date.now() - started < QUIET_TIMEOUT_MS) {
    if (!announced) {
      const why = `1-min load ${load.toFixed(1)} (limit ${limit})${other ? `, other run active (${pattern})` : ""}`;
      log(`waiting for a quiet machine: ${why}`);
      appendLog(`waiting for quiet: ${why}`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, QUIET_POLL_MS));
    load = os.loadavg()[0];
    other = otherRunActive(pattern);
  }
  return { waitedMs: Date.now() - started, load, limit, otherRunActive: other, quiet: load <= limit && other !== true };
}

// Everything that shapes a number: the harness, its manifest, the worker
// that decodes, the WAV reader, and the catalog the baselines come from. Two
// passes can be combined only if this matches — unrelated commits in between
// don't matter.
const MEASURING_CODE = [
  "scripts/eval-stt.js",
  "scripts/stt-eval.js",
  "scripts/stt-eval-manifest.js",
  "scripts/stt-eval-worker.js",
  "main/engines/engine-worker.js",
  "main/engines/host.js",
  "main/util/wav.js",
  "main/engines/registry.js",
];

function measuringCodeHash() {
  const hash = crypto.createHash("sha256");
  for (const f of MEASURING_CODE) hash.update(`${f}\0`).update(fs.readFileSync(path.join(__dirname, "..", f)));
  return hash.digest("hex");
}

function machine() {
  const cpus = os.cpus();
  let head = null;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout — record nothing rather than guess.
  }
  return {
    cpu: cpus[0] && cpus[0].model,
    logicalCpus: cpus.length,
    appThreads: APP_THREADS,
    ramGb: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron,
      v8: process.versions.v8,
      sherpaOnnxNode: require("sherpa-onnx-node/package.json").version,
    },
    gitHead: head,
    measuringCode: measuringCodeHash(),
  };
}

// The measurement order: the default first (it is the reference every
// candidate is judged against as soon as it is measured), the other shipped
// models, the wired candidates, the exploratory arm behind its calibration
// row, and the default again to show the machine stayed as quiet as it began.
function plan(opts) {
  const shipped = registry.listModels("stt");
  const def = shipped.find((m) => m.id === manifest.BASELINE_ID);
  const list = [{ model: def, role: "bracket-first", arm: "shipped" }];
  for (const m of shipped) if (m.id !== def.id) list.push({ model: m, role: "baseline", arm: "shipped" });
  for (const c of manifest.CANDIDATES.filter((x) => x.arm === "wired")) list.push({ model: c, role: "candidate", arm: "wired" });
  if (opts.exploratory) {
    list.push({ model: def, role: "calibration", arm: "exploratory" });
    for (const c of manifest.CANDIDATES.filter((x) => x.arm === "exploratory")) {
      list.push({ model: c, role: "candidate", arm: "exploratory" });
    }
  }
  // The closing bracket only checks the machine stayed quiet: speed's concern.
  if (opts.pass !== "accuracy") list.push({ model: def, role: "bracket-last", arm: "shipped" });
  return opts.models ? list.filter((x) => opts.models.includes(x.model.id)) : list;
}

// A speed number counts only if it came from a quiet machine: a speed or
// single run whose quiet gate held. The accuracy pass's decode times are kept
// (marked contended) but never reach classify().
const cleanSpeed = (row) => (row && row.status === "measured" && !row.contended ? row : null);

/**
 * Judge every candidate. WER comes from `acc` (the full corpus); decode RTF
 * only from clean rows of `spd` — the same result for a single quiet run, the
 * speed pass's result for a split one, or null when there is none yet.
 */
function judge(acc, spd) {
  const key = (r) => `${r.id}|${r.role}`;
  const speedRows = new Map((spd ? spd.rows : []).map((r) => [key(r), r]));
  const speedOf = (r) => cleanSpeed(speedRows.get(key(r)));
  const rows = acc.rows;
  const first = rows.find((r) => r.role === "bracket-first" && r.status === "measured");
  const calib = rows.find((r) => r.role === "calibration" && r.status === "measured");
  const sFirst = spd && spd.rows.find((r) => r.role === "bracket-first" && r.status === "measured");
  const sLast = spd && spd.rows.find((r) => r.role === "bracket-last" && r.status === "measured");
  acc.brackets = sFirst && sLast
    ? { first: sFirst.decodeRtf, last: sLast.decodeRtf, drift: Math.abs(sLast.decodeRtf - sFirst.decodeRtf) / sFirst.decodeRtf }
    : null;
  const speedStable = Boolean(acc.brackets && acc.brackets.drift <= BRACKET_DRIFT && cleanSpeed(sFirst) && cleanSpeed(sLast));
  acc.speedSource = spd === acc ? "this run" : spd ? `speed pass (${spd.corpus.subset}, ${spd.corpus.utterances} utterances)` : "none";
  acc.speedClean = speedStable;
  for (const r of rows) {
    const s = speedOf(r);
    r.speed = s && speedStable
      ? {
        decodeRtf: s.decodeRtf, p50Rtf: s.p50Rtf, p95Rtf: s.p95Rtf, wallRtf: s.wallRtf,
        coldLoadWallMs: s.coldLoadWallMs, firstDecodeMs: s.firstDecodeMs,
        otherRunIdle: s.otherRun && s.otherRun.active === false, otherRunSamples: s.otherRun && s.otherRun.samples,
        loadavg: [s.loadavgBefore[0], s.loadavgAfter[0]],
      }
      : null;
  }
  const index = acc.corpus.utteranceIndex;
  for (const r of rows) {
    if (r.status !== "measured" || r.role === "bracket-first" || r.role === "bracket-last" || r.role === "calibration") continue;
    const ref = r.arm === "exploratory" ? calib : first;
    if (!ref) continue;
    const bootstrap = e.pairedBootstrap(
      index.map((u, i) => ({ cluster: u.sentenceId, ref: u.refWords, baseErrors: ref.perUtteranceErrors[i], candErrors: r.perUtteranceErrors[i] }))
    );
    const deltaWer = (r.errors - ref.errors) / ref.ref;
    if (!r.speed || !ref.speed) {
      r.vsDefault = { eligible: false, rule: null, speedup: null, deltaWer, bootstrap, against: ref.role };
      r.eligible = false;
      r.verdict = "speed not measured cleanly — no speed-based verdict";
      continue;
    }
    r.vsDefault = {
      ...e.classify({ errors: ref.errors, ref: ref.ref, decodeRtf: ref.speed.decodeRtf }, { errors: r.errors, ref: r.ref, decodeRtf: r.speed.decodeRtf }),
      bootstrap,
      against: r.arm === "exploratory" ? "calibration (direct path)" : "bracket-first (worker)",
    };
    if (r.vsDefault.eligible) {
      const baseLong = ref.longForm;
      r.longFormCheck = r.longForm && baseLong
        ? e.longFormCompatible(r.longForm.map((l, i) => ({ ...l, base: baseLong[i] })))
        : { compatible: false, reasons: ["long-form not measured"] };
      // Q2: an exploratory family is never catalogued from the direct path.
      r.eligible = r.longFormCheck.compatible && r.arm === "wired";
      r.verdict = !r.longFormCheck.compatible
        ? "incompatible on long audio"
        : r.arm === "wired"
          ? `eligible (rule ${r.vsDefault.rule})`
          : `clears Q3 on the direct path (rule ${r.vsDefault.rule}) — wire and re-measure`;
    } else {
      r.eligible = false;
      r.verdict = "does not clear Q3";
    }
  }
}

function runStatus(result, opts) {
  const rows = result.rows;
  const haveBaselines = registry.listModels("stt").every((m) =>
    rows.some((r) => r.id === m.id && r.status === "measured" && r.role !== "calibration")
  );
  const failed = rows.some((r) => r.status === "failed");
  if (opts.models || opts.limit) return "partial (development subset)";
  if (!haveBaselines || failed) return "incomplete";
  if (opts.pass === "accuracy") return "accuracy complete";
  const first = rows.find((r) => r.role === "bracket-first" && r.status === "measured");
  const last = rows.find((r) => r.role === "bracket-last" && r.status === "measured");
  const stable = first && last && !first.contended && !last.contended &&
    Math.abs(last.decodeRtf - first.decodeRtf) / first.decodeRtf <= BRACKET_DRIFT;
  return stable ? (opts.pass === "speed" ? "speed complete" : "complete") : "unstable";
}

const lockOfPass = (res) => Boolean(res.cpuLock && res.cpuLock.role === "held for the whole pass");

// Merge a split run: the accuracy pass's rows, judged with the speed pass's
// clean decode times.
function combine(accFile, speedFile) {
  const acc = JSON.parse(fs.readFileSync(accFile, "utf8"));
  const spd = speedFile ? JSON.parse(fs.readFileSync(speedFile, "utf8")) : null;
  if (acc.pass !== "accuracy") throw new Error(`${accFile} is not an accuracy pass (pass: ${acc.pass})`);
  if (spd && spd.pass !== "speed") throw new Error(`${speedFile} is not a speed pass (pass: ${spd.pass})`);
  if (spd && (spd.corpus.commit !== acc.corpus.commit || spd.machine.measuringCode !== acc.machine.measuringCode)) {
    throw new Error("accuracy and speed passes come from different corpus pins or measuring code");
  }
  const out = {
    ...acc,
    pass: "combined",
    passes: {
      accuracy: { file: path.basename(accFile), status: acc.status, command: acc.command },
      speed: spd ? { file: path.basename(speedFile), status: spd.status, command: spd.command, cpuLock: lockOfPass(spd), corpus: { subset: spd.corpus.subset, utterances: spd.corpus.utterances, audioSec: spd.corpus.audioSec } } : null,
    },
  };
  judge(out, spd);
  out.status = spd && spd.status === "speed complete" && acc.status === "accuracy complete"
    ? "complete"
    : `accuracy: ${acc.status}; speed: ${spd ? spd.status : "not measured"}`;
  return out;
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1));
  await fsp.rename(tmp, file);
}

async function run(opts) {
  const { app } = require("electron");
  await app.whenReady();
  const cacheDir = path.resolve(opts.cacheDir || path.join(app.getPath("userData"), "stt-eval"));
  await fsp.mkdir(cacheDir, { recursive: true });
  const out = path.resolve(opts.out);
  const appendLog = (line) => opts.log && fs.appendFileSync(opts.log, `${new Date().toISOString()} ${line}\n`);

  if (opts.cpuLock && opts.pass !== "accuracy" && !lockHeld(opts.cpuLock)) {
    throw new Error(`a timed pass must run under the lock: flock ${opts.cpuLock} npx electron scripts/eval-stt.js …`);
  }
  const corpus = await prepareCorpus(cacheDir, opts.limit, { speed: opts.pass === "speed" });
  const { clips, allClips, ...corpusInfo } = corpus;
  const previous = opts.resume && fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
  const result = {
    schema: SCHEMA,
    pass: opts.pass,
    status: "running",
    command: process.argv.slice(1).join(" "),
    machine: machine(),
    corpus: corpusInfo,
    threshold: { ...e.THRESHOLD, against: manifest.BASELINE_ID, longForm: e.LONG_FORM, bracketDrift: BRACKET_DRIFT },
    skipped: manifest.SKIPPED,
    // A timed pass verified at start that the lock was held (by the flock it
    // runs under); the accuracy pass only yields to it.
    cpuLock: opts.cpuLock
      ? { file: opts.cpuLock, role: opts.pass === "accuracy" ? "yields to holders" : "held for the whole pass" }
      : null,
    rows: [],
  };
  if (previous) {
    result.resumed = { rows: previous.rows.filter((r) => r.status === "measured").length, measuringCode: previous.machine.measuringCode };
  }
  if (previous && previous.corpus && previous.corpus.utterances !== corpusInfo.utterances) {
    throw new Error("--resume: the existing file was measured on a different corpus selection");
  }
  const ctx = { opts, appendLog, cacheDir, corpus, longForm: buildLongForm(allClips), ablation: null, bracketFirst: null, calibration: null };
  const order = plan(opts);
  for (const entry of order) {
    const reused = previous && previous.rows.find((r) => r.id === entry.model.id && r.role === entry.role && r.status === "measured");
    let row;
    if (reused) {
      row = reused;
      log(`${entry.model.id} (${entry.role}): reused from ${out}`);
    } else {
      log(`${entry.model.id} (${entry.role}, ${entry.arm}) — free ${Math.round(fs.statfsSync(cacheDir).bavail * fs.statfsSync(cacheDir).bsize / 1e9)} GB`);
      // The accuracy pass does not wait: its decode times are contended by
      // definition and never used for speed.
      const lockWaitMs = opts.pass === "accuracy" ? await waitForLock(opts.cpuLock, entry.model.id, appendLog) : 0;
      const attempts = [];
      for (;;) {
        const waited = opts.pass === "accuracy" ? null : await waitForQuiet(opts.quietLoad, opts.otherRunPattern, appendLog);
        appendLog(`start ${entry.model.id} (${entry.role})${attempts.length ? ` — speed attempt ${attempts.length + 1}` : ""}`);
        row = await measureModel(entry, ctx);
        row.quietWait = waited;
        // Clean only if the gate held AND no other-run process was seen at
        // any sample during the decodes (unknown counts as not clean).
        row.contended = !waited || !waited.quiet || row.otherRun.active !== false;
        attempts.push({ contended: row.contended, decodeRtf: row.decodeRtf, otherRun: row.otherRun, loadavgBefore: row.loadavgBefore, loadavgAfter: row.loadavgAfter });
        if (opts.pass === "accuracy" || row.status !== "measured" || !row.contended || attempts.length >= SPEED_ATTEMPTS) break;
        log(`${entry.model.id} (${entry.role}): contended (other run ${row.otherRun.active}), re-measuring when quiet`);
      }
      row.speedAttempts = attempts;
      if (opts.cpuLock && opts.pass === "accuracy") row.lockWaitMs = lockWaitMs + (row.lockWaitLongFormMs || 0);
    }
    if (row.role === "bracket-first" && row.status === "measured") ctx.bracketFirst = row;
    if (row.role === "calibration" && row.status === "measured") ctx.calibration = row;
    result.rows.push(row);
    const summary = row.status === "measured"
      ? `wer_norm ${(row.werNorm * 100).toFixed(2)} % decodeRtf ${row.decodeRtf.toFixed(4)}`
      : `${row.status}: ${row.reason}`;
    log(`${entry.model.id} (${entry.role}): ${summary}`);
    appendLog(`done ${entry.model.id} (${entry.role}) ${summary}`);
    result.ablation = ctx.ablation;
    await writeJson(out, result);
    // Keep the default until its last use; everything else goes once recorded.
    const usedLater = order.slice(order.indexOf(entry) + 1).some((x) => x.model.id === entry.model.id);
    if (!opts.keep && !usedLater && entry.model.files) await manager.remove(cacheDir, entry.model);
  }
  result.status = runStatus(result, opts);
  if (opts.pass === "both") judge(result, result);
  await writeJson(out, result);
  process.stderr.write(`\n${report(result)}\n`);
  log(`status: ${result.status} -> ${out}`);
  appendLog(`run ${result.status}`);
  return /complete$|^partial/.test(result.status) ? 0 : 1;
}

/* ---------------- report ---------------- */

const pct = (x, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? "—" : (x * 100).toFixed(d));
const num = (x, d = 3) => (x === undefined || x === null || Number.isNaN(x) ? "—" : x.toFixed(d));

function report(result) {
  const lines = [];
  const c = result.corpus;
  lines.push(`Corpus: ${c.source} ${c.id} @ ${c.commit.slice(0, 8)} — ${c.utterances} utterances, ${c.referenceWords} words, ${(c.audioSec / 60).toFixed(1)} min (${c.subset || "all"})`);
  const m = result.machine;
  lines.push(`Machine: ${m.cpu}, ${m.logicalCpus} logical CPUs, ${m.ramGb} GB, ${m.platform}; Electron ${m.versions.electron}, sherpa-onnx-node ${m.versions.sherpaOnnxNode}; CPU, ${m.appThreads} threads`);
  if (result.passes && result.passes.speed) {
    const sp = result.passes.speed;
    lines.push(`Speed from: ${sp.corpus.subset}, ${sp.corpus.utterances} utterances, ${(sp.corpus.audioSec / 60).toFixed(1)} min`);
  }
  if (result.brackets) {
    lines.push(`Default measured first/last: decodeRtf ${num(result.brackets.first, 4)} / ${num(result.brackets.last, 4)} (drift ${pct(result.brackets.drift, 1)} %, limit ${BRACKET_DRIFT * 100} %)`);
  }
  const lockOf = (x) => x && x.cpuLock && x.cpuLock.role === "held for the whole pass";
  if (lockOf(result) || (result.passes && result.passes.speed && result.passes.speed.cpuLock)) {
    lines.push("Every speed timing was taken while holding cpu-quiet.lock, shared with the parallel cleanup run.");
  }
  lines.push(`Status: ${result.status}`);
  lines.push("");
  lines.push("| model | role | path | wer_norm % | wer_verbatim % | Δ vs default (95 % CI), pts | decode RTF (p50 / p95) | speedup | cold load s | first decode s | speed measured with | punct % | caps % | size MB | verdict |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  let contendedShown = false;
  for (const r of result.rows) {
    if (r.status !== "measured") {
      lines.push(`| ${r.id} | ${r.role} | ${r.path} | — | — | — | — | — | — | — | — | — | — | — | ${r.status}: ${r.reason} |`);
      continue;
    }
    const v = r.vsDefault;
    const ci = v ? `${pct(v.deltaWer)} (${pct(v.bootstrap.lo)} … ${pct(v.bootstrap.hi)})${v.bootstrap.separable ? "" : " n.s."}` : "—";
    // Clean speed when there is one; otherwise this row's own (contended) numbers, marked.
    const sp = r.speed || (r.contended === false ? r : null);
    let speedCell;
    let loadCell;
    // Per-timing statement of the conditions: was the other run's process seen,
    // and the 1-minute load average before / after the model.
    const cond = (x) => {
      const la = x.loadavg || [x.loadavgBefore && x.loadavgBefore[0], x.loadavgAfter && x.loadavgAfter[0]];
      const other = x.otherRunIdle !== undefined ? x.otherRunIdle : x.otherRun && x.otherRun.active === false;
      return `cleanup run ${other ? "idle" : "ACTIVE or unknown"}, load ${num(la[0], 1)}–${num(la[1], 1)}`;
    };
    const condCell = sp ? cond(sp) : cond(r);
    if (sp) {
      speedCell = `${num(sp.decodeRtf, 4)} (${num(sp.p50Rtf, 4)} / ${num(sp.p95Rtf, 4)})`;
      loadCell = `${num(sp.coldLoadWallMs / 1000, 1)} | ${num(sp.firstDecodeMs / 1000, 2)}`;
    } else {
      contendedShown = true;
      speedCell = `${num(r.decodeRtf, 4)}*`;
      loadCell = `${num(r.coldLoadWallMs / 1000, 1)}* | ${num(r.firstDecodeMs / 1000, 2)}*`;
    }
    lines.push(
      `| ${r.id} | ${r.role} | ${r.path} | ${pct(r.werNorm)} | ${pct(r.werVerbatim)} | ${ci} | ${speedCell} | ${v && v.speedup ? `${num(v.speedup, 2)}x` : "—"} | ${loadCell} | ${condCell} | ${pct(r.punctuationRate, 0)} | ${pct(r.capitalisationRate, 0)} | ${Math.round(r.bytes / 1e6)} | ${r.verdict || (r.role.startsWith("bracket") || r.role === "calibration" ? "reference" : "baseline")} |`
    );
  }
  if (contendedShown) {
    lines.push("");
    lines.push("\\* measured while the machine was busy (not a clean speed number; never used for a verdict).");
  }
  const long = result.rows.filter((r) => r.longForm);
  if (long.length) {
    lines.push("");
    lines.push("| model | role | clip | WER % | word ratio | decode RTF |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of long) {
      for (const l of r.longForm) {
        lines.push(`| ${r.id} | ${r.role} | ${l.label} (${num(l.audioSec, 0)} s) | ${pct(l.wer)} | ${num(l.wordRatio, 3)} | ${l.error ? `error: ${l.error}` : `${num(l.decodeRtf, 4)}${r.contended ? "*" : ""}`} |`);
      }
    }
  }
  if (result.ablation) {
    lines.push("");
    lines.push(`Normalisation ablation on the default (wer_norm %): all stages ${pct(result.ablation.all)}; ` +
      Object.entries(result.ablation).filter(([k]) => k !== "all").map(([k, v]) => `${k.replace("without_", "without ")} ${pct(v)}`).join("; "));
  }
  if (result.skipped && result.skipped.length) {
    lines.push("");
    lines.push("Surveyed and not measured:");
    for (const s of result.skipped) lines.push(`- ${s.repo}: ${s.reason}`);
  }
  return lines.join("\n");
}

/* ---------------- entry ---------------- */

async function main() {
  const opts = parseArgs(process.argv.slice(process.versions.electron ? 2 : 2));
  if (opts.report) {
    process.stdout.write(`${report(JSON.parse(fs.readFileSync(opts.report, "utf8")))}\n`);
    return 0;
  }
  if (opts.verifyShipped) return (await verifyShipped()) ? 0 : 1;
  if (opts.combine.length) {
    if (!opts.out) throw new Error("--combine needs --out <file.json>");
    const merged = combine(opts.combine[0], opts.combine[1]);
    await writeJson(path.resolve(opts.out), merged);
    process.stderr.write(`${report(merged)}\n`);
    return 0;
  }
  if (opts.discover.length) {
    const found = [];
    for (const spec of opts.discover) found.push(await discover(spec));
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    return 0;
  }
  if (!opts.out) throw new Error("--out <file.json> is required for a measurement run");
  if (!process.versions.electron) throw new Error("a measurement run needs Electron: npx electron scripts/eval-stt.js …");
  return run(opts);
}

main().then(
  (code) => (process.versions.electron ? require("electron").app.exit(code) : process.exit(code)),
  (err) => {
    log("failed:", (err && err.stack) || err);
    if (process.versions.electron) require("electron").app.exit(1);
    else process.exit(1);
  }
);
