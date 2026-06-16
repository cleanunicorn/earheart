// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { encodeWav, encodeSilenceWav, decodeWav } = require("../main/util/wav");
const { stripThinking } = require("../main/services/cleanup");
const { deepMerge, migrate, DEFAULTS } = require("../main/settings");
const catalog = require("../main/services/model-catalog");
const modelManager = require("../main/services/model-manager");

test("encodeWav produces a valid RIFF header", () => {
  const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(samples, 16000);
  assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(wav.readUInt32LE(24), 16000); // sample rate
  assert.strictEqual(wav.readUInt16LE(22), 1); // mono
  assert.strictEqual(wav.readUInt32LE(40), samples.length * 2); // data size
  assert.strictEqual(wav.length, 44 + samples.length * 2);
  assert.strictEqual(wav.readInt16LE(44 + 2), 1000);
});

test("encodeSilenceWav has the requested duration", () => {
  const wav = encodeSilenceWav(0.5);
  assert.strictEqual(wav.readUInt32LE(40), 16000 * 0.5 * 2);
});

test("stripThinking removes reasoning blocks", () => {
  assert.strictEqual(
    stripThinking("<think>hmm, let me see</think>Hello world."),
    "Hello world."
  );
  assert.strictEqual(stripThinking("No tags here."), "No tags here.");
  assert.strictEqual(
    stripThinking("<THINK>a</THINK>\n\n  Result  "),
    "Result"
  );
});

test("deepMerge keeps defaults for missing keys and overrides present ones", () => {
  const base = { a: 1, nested: { x: "default", y: 2 }, arr: [1, 2] };
  const override = { nested: { x: "custom" }, arr: [3] };
  const merged = deepMerge(base, override);
  assert.deepStrictEqual(merged, {
    a: 1,
    nested: { x: "custom", y: 2 },
    arr: [3],
  });
});

test("deepMerge ignores null/undefined overrides", () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});

/* ---------- WAV decoding (feeds the in-app Parakeet recognizer) ---------- */

test("decodeWav round-trips PCM16 mono from encodeWav", () => {
  const samples = new Int16Array([0, 16384, -16384, 32767, -32768]);
  const { samples: out, sampleRate } = decodeWav(encodeWav(samples, 16000));
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(out.length, samples.length);
  // 16384 / 32768 == 0.5
  assert.ok(Math.abs(out[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(out[2] + 0.5) < 1e-3);
  assert.ok(out[3] > 0.99 && out[4] < -0.99);
});

test("decodeWav averages stereo channels to mono", () => {
  // Build a tiny 2-channel PCM16 WAV by hand: L=+full, R=-full -> mono ~0.
  const sr = 16000;
  const frames = 3;
  const dataSize = frames * 2 * 2; // 2 channels, 2 bytes
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(32767, 44 + i * 4);
    buf.writeInt16LE(-32768, 44 + i * 4 + 2);
  }
  const { samples } = decodeWav(buf);
  assert.strictEqual(samples.length, frames);
  for (const s of samples) assert.ok(Math.abs(s) < 0.01);
});

test("decodeWav rejects non-WAV input", () => {
  assert.throws(() => decodeWav(Buffer.from("not a wav file at all")), /WAV/);
});

/* ---------- settings migration for the new engine field ---------- */

test("migrate forces existing installs (no engine field) onto the service path", () => {
  const stored = { stt: { baseUrl: "http://x/v1" }, cleanup: { enabled: true } };
  const merged = migrate(stored, deepMerge(DEFAULTS, stored));
  assert.strictEqual(merged.stt.engine, "service");
  assert.strictEqual(merged.cleanup.engine, "service");
});

test("fresh installs keep the builtin engine defaults", () => {
  const merged = migrate({}, deepMerge(DEFAULTS, {}));
  assert.strictEqual(merged.stt.engine, "builtin");
  assert.strictEqual(merged.cleanup.engine, "builtin");
  assert.strictEqual(merged.cleanup.enabled, true);
});

test("an install that already chose an engine is left untouched", () => {
  const stored = { stt: { engine: "builtin" }, cleanup: { engine: "builtin" } };
  const merged = migrate(stored, deepMerge(DEFAULTS, stored));
  assert.strictEqual(merged.stt.engine, "builtin");
  assert.strictEqual(merged.cleanup.engine, "builtin");
});

/* ---------- model catalog ---------- */

test("catalog returns the default STT model and resolves custom cleanup URIs", () => {
  assert.strictEqual(catalog.getSttModel().id, catalog.DEFAULT_STT_MODEL);
  assert.strictEqual(catalog.getSttModel("nope").id, catalog.DEFAULT_STT_MODEL);

  const custom = catalog.getCleanupModel("custom", " hf:me/repo/x.gguf ");
  assert.strictEqual(custom.id, "custom");
  assert.strictEqual(custom.uri, "hf:me/repo/x.gguf");

  assert.ok(catalog.sttModelList().length >= 1);
  assert.ok(catalog.cleanupModelList().length >= 1);
});

/* ---------- model manager: install detection + download with progress ---------- */

test("isSttInstalled is true only once every model file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-models-"));
  modelManager.setModelsDir(dir);
  try {
    const id = catalog.DEFAULT_STT_MODEL;
    assert.strictEqual(modelManager.isSttInstalled(id), false);
    assert.throws(() => modelManager.sttModelPaths(id), /not downloaded/);

    const spec = catalog.getSttModel(id);
    const mdir = modelManager.sttModelDir(id);
    fs.mkdirSync(mdir, { recursive: true });
    for (const f of spec.files) fs.writeFileSync(path.join(mdir, f.name), "x");

    assert.strictEqual(modelManager.isSttInstalled(id), true);
    const paths = modelManager.sttModelPaths(id);
    assert.ok(paths.encoder && paths.decoder && paths.joiner && paths.tokens);
    assert.strictEqual(paths.modelType, spec.modelType);
  } finally {
    modelManager.setModelsDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadFile streams to disk and reports progress", async () => {
  const body = Buffer.alloc(4096, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/file.bin`;
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dl-")), "file.bin");

  try {
    let last = 0;
    const { bytes } = await modelManager.downloadFile(url, dest, {
      onProgress: ({ received, total }) => {
        last = received;
        assert.strictEqual(total, body.length);
      },
    });
    assert.strictEqual(bytes, body.length);
    assert.strictEqual(last, body.length);
    assert.strictEqual(fs.statSync(dest).size, body.length);
    assert.ok(!fs.existsSync(dest + ".part"));
  } finally {
    server.close();
  }
});

test("downloadFile resumes from a partial file using Range", async () => {
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  let sawRange = null;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      sawRange = range;
      const start = Number(range.replace(/bytes=(\d+)-/, "$1"));
      const slice = body.subarray(start);
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(slice);
    } else {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    }
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/f.bin`;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "dl2-"));
  const dest = path.join(tmpdir, "f.bin");
  // Pretend a previous attempt got the first 400 bytes.
  fs.writeFileSync(dest + ".part", body.subarray(0, 400));

  try {
    const { bytes } = await modelManager.downloadFile(url, dest);
    assert.strictEqual(sawRange, "bytes=400-");
    assert.strictEqual(bytes, body.length);
    assert.deepStrictEqual(fs.readFileSync(dest), body);
  } finally {
    server.close();
  }
});

test("downloadStt fetches every file and reports combined progress", async () => {
  const spec = catalog.getSttModel();
  const server = http.createServer((req, res) => {
    const payload = Buffer.from(`payload-for-${path.basename(req.url)}`);
    res.writeHead(200, { "content-length": String(payload.length) });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-"));
  modelManager.setModelsDir(dir);

  // Point HF downloads at our local server.
  const fetchImpl = (url, opts) =>
    fetch(url.replace(/^https:\/\/huggingface\.co/, `http://127.0.0.1:${port}`), opts);

  try {
    let progressed = false;
    await modelManager.downloadStt(spec.id, {
      fetchImpl,
      onProgress: ({ received }) => {
        if (received > 0) progressed = true;
      },
    });
    assert.ok(progressed);
    assert.strictEqual(modelManager.isSttInstalled(spec.id), true);
    for (const f of spec.files) {
      assert.ok(fs.existsSync(path.join(modelManager.sttModelDir(spec.id), f.name)));
    }
  } finally {
    modelManager.setModelsDir(null);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
