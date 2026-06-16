// Tests for the in-process engine support modules that don't need Electron or
// the native runtimes: the model registry and the download manager.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const registry = require("../main/engines/registry");
const manager = require("../main/engines/model-manager");

/* ---------------- registry ---------------- */

test("registry exposes default models that resolve", () => {
  const stt = registry.getModel("stt", registry.DEFAULT_STT_MODEL);
  const cleanup = registry.getModel("cleanup", registry.DEFAULT_CLEANUP_MODEL);
  assert.ok(stt && stt.files.length > 0);
  assert.ok(cleanup && cleanup.files.length > 0);
  assert.strictEqual(registry.getModel("stt", "nope"), null);
});

test("registry totalBytes sums the file sizes", () => {
  const model = { files: [{ bytes: 10 }, { bytes: 5 }, {}] };
  assert.strictEqual(registry.totalBytes(model), 15);
});

test("exactly one cleanup model is marked default", () => {
  const defaults = registry.listModels("cleanup").filter((m) => m.default);
  assert.strictEqual(defaults.length, 1);
  assert.strictEqual(defaults[0].id, registry.DEFAULT_CLEANUP_MODEL);
});

/* ---------------- download manager ---------------- */

// A tiny static file server backing a fake model, so the download manager runs
// end to end (stream -> .part -> rename -> marker) without the network.
function serveFiles(fileMap) {
  const server = http.createServer((req, res) => {
    const body = fileMap[req.url];
    if (!body) {
      res.statusCode = 404;
      res.end("nope");
      return;
    }
    res.setHeader("content-length", body.length);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function withTmp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "earheart-models-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("download streams files, reports progress, and marks complete", async () => {
  const a = Buffer.from("encoder-bytes-".repeat(100));
  const b = Buffer.from("tokens");
  const { server, base } = await serveFiles({ "/a.onnx": a, "/b.txt": b });
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "stt",
        id: "fake",
        files: [
          { name: "a.onnx", bytes: a.length, url: `${base}/a.onnx` },
          { name: "b.txt", bytes: b.length, url: `${base}/b.txt` },
        ],
      };
      assert.strictEqual(manager.isInstalled(dir, model), false);

      const fractions = [];
      await manager.download(dir, model, {
        onProgress: (p) => fractions.push(p.fraction),
      });

      assert.strictEqual(manager.isInstalled(dir, model), true);
      assert.deepStrictEqual(
        fs.readFileSync(manager.filePath(dir, model, model.files[0])),
        a
      );
      // Progress is monotonic and finishes at exactly 1.
      assert.strictEqual(fractions.at(-1), 1);
      for (let i = 1; i < fractions.length; i++) {
        assert.ok(fractions[i] >= fractions[i - 1]);
      }
      // No leftover temp files.
      assert.ok(!fs.existsSync(manager.filePath(dir, model, model.files[0]) + ".part"));
    });
  } finally {
    server.close();
  }
});

test("download verifies sha256 and rejects a mismatch", async () => {
  const good = Buffer.from("trustworthy bytes");
  const sha = crypto.createHash("sha256").update(good).digest("hex");
  const { server, base } = await serveFiles({ "/m.gguf": good });
  try {
    await withTmp(async (dir) => {
      const ok = {
        kind: "cleanup", id: "ok",
        files: [{ name: "m.gguf", bytes: good.length, url: `${base}/m.gguf`, sha256: sha }],
      };
      await manager.download(dir, ok); // matching checksum: resolves
      assert.strictEqual(manager.isInstalled(dir, ok), true);

      const bad = {
        kind: "cleanup", id: "bad",
        files: [{ name: "m.gguf", bytes: good.length, url: `${base}/m.gguf`, sha256: "deadbeef" }],
      };
      await assert.rejects(() => manager.download(dir, bad), /Checksum mismatch/);
      assert.strictEqual(manager.isInstalled(dir, bad), false);
    });
  } finally {
    server.close();
  }
});

test("download skips files already on disk and remove frees them", async () => {
  const a = Buffer.from("already here");
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.end(a);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "stt", id: "skip",
        files: [{ name: "a.bin", bytes: a.length, url: `${base}/a.bin` }],
      };
      // Pre-place the file as if a previous run had fetched it.
      await fsp.mkdir(manager.modelDir(dir, model), { recursive: true });
      await fsp.writeFile(manager.filePath(dir, model, model.files[0]), a);

      await manager.download(dir, model);
      assert.strictEqual(hits, 0); // never hit the network
      assert.strictEqual(manager.isInstalled(dir, model), true);

      await manager.remove(dir, model);
      assert.strictEqual(manager.isInstalled(dir, model), false);
    });
  } finally {
    server.close();
  }
});

test("isInstalled rejects a model whose file was truncated after download", async () => {
  const a = Buffer.from("the-whole-file-".repeat(20));
  const { server, base } = await serveFiles({ "/a.bin": a });
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "stt", id: "trunc",
        files: [{ name: "a.bin", bytes: a.length, url: `${base}/a.bin` }],
      };
      await manager.download(dir, model);
      assert.strictEqual(manager.isInstalled(dir, model), true);

      // Simulate corruption/truncation of an already-installed file: the marker
      // recorded the original size, so the shorter file no longer matches.
      await fsp.writeFile(manager.filePath(dir, model, model.files[0]), "tiny");
      assert.strictEqual(manager.isInstalled(dir, model), false);
    });
  } finally {
    server.close();
  }
});

test("download surfaces HTTP errors", async () => {
  const { server, base } = await serveFiles({}); // serves 404 for everything
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "stt", id: "missing",
        files: [{ name: "x", bytes: 1, url: `${base}/x` }],
      };
      await assert.rejects(() => manager.download(dir, model), /Download failed/);
    });
  } finally {
    server.close();
  }
});
