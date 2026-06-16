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

// Every concrete download URL across every model, paired with its model id so a
// failure points at the offending entry.
function allModelFiles() {
  const out = [];
  for (const kind of Object.keys(registry.MODELS)) {
    for (const model of registry.listModels(kind)) {
      for (const file of model.files) {
        out.push({ kind, id: model.id, file });
      }
    }
  }
  return out;
}

// Hugging Face namespaces that gate their repos behind a license click and so
// return HTTP 401 to anonymous downloads (the failure that broke the wizard).
// Keep the model files on ungated mirrors instead. Add hosts here as needed.
const GATED_HF_OWNERS = ["google", "meta-llama", "mistralai"];

test("registry: every model file has a well-formed https url and filename", () => {
  for (const { kind, id, file } of allModelFiles()) {
    const where = `${kind}/${id} -> ${file.name}`;
    assert.ok(file.name, `${where}: missing name`);
    let url;
    assert.doesNotThrow(() => {
      url = new URL(file.url);
    }, `${where}: url is not parseable (${file.url})`);
    assert.strictEqual(url.protocol, "https:", `${where}: must be https`);
    // The basename of the URL must match the declared file name, so the wizard
    // writes the file under the name the engine later looks up.
    const urlBase = decodeURIComponent(url.pathname.split("/").pop());
    assert.strictEqual(urlBase, file.name, `${where}: url basename != name`);
  }
});

test("registry: no model file is hosted on a gated Hugging Face repo", () => {
  for (const { kind, id, file } of allModelFiles()) {
    const url = new URL(file.url);
    if (url.hostname !== "huggingface.co") continue;
    // First path segment is the repo owner, e.g. /google/gemma-...
    const owner = url.pathname.split("/").filter(Boolean)[0];
    assert.ok(
      !GATED_HF_OWNERS.includes(owner),
      `${kind}/${id} -> ${file.name}: hosted on gated HF owner "${owner}"; ` +
        `anonymous download returns HTTP 401. Use an ungated mirror.`
    );
  }
});

test("registry: every cleanup model resolves to its gguf file", () => {
  for (const model of registry.listModels("cleanup")) {
    assert.ok(model.gguf && model.gguf.file, `${model.id}: missing gguf.file`);
    const names = model.files.map((f) => f.name);
    assert.ok(
      names.includes(model.gguf.file),
      `${model.id}: gguf.file "${model.gguf.file}" is not among downloaded files ${JSON.stringify(names)}`
    );
  }
});

// Opt-in live check: actually reach each URL and assert it is not gated/missing.
// Skipped by default (network, slow) — run with EARHEART_NET_TESTS=1 to enable.
test(
  "registry: model urls are anonymously reachable (live)",
  { skip: !process.env.EARHEART_NET_TESTS && "set EARHEART_NET_TESTS=1 to run" },
  async () => {
    for (const { kind, id, file } of allModelFiles()) {
      let res;
      try {
        res = await fetch(file.url, { method: "HEAD", redirect: "follow" });
      } catch (err) {
        // No connectivity (offline CI, sandbox) — this check is inconclusive
        // rather than a real failure, so don't fail the suite on it.
        assert.ok(true, `${kind}/${id} -> ${file.name}: network unavailable (${err.message})`);
        continue;
      }
      assert.ok(
        res.status !== 401 && res.status !== 403,
        `${kind}/${id} -> ${file.name}: HTTP ${res.status} (gated/forbidden)`
      );
      assert.ok(
        res.ok,
        `${kind}/${id} -> ${file.name}: HTTP ${res.status} (not reachable)`
      );
    }
  }
);

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

test("isInstalled accepts a legacy or malformed marker as presence-only", async () => {
  const a = Buffer.from("legacy-bytes-".repeat(10));
  const { server, base } = await serveFiles({ "/a.bin": a });
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "stt", id: "legacy",
        files: [{ name: "a.bin", bytes: a.length, url: `${base}/a.bin` }],
      };
      await manager.download(dir, model);
      assert.strictEqual(manager.isInstalled(dir, model), true);

      const markerPath = path.join(manager.modelDir(dir, model), manager.MARKER);
      const file = manager.filePath(dir, model, model.files[0]);

      // A marker written by an older build that didn't record sizes (empty or
      // not size-shaped JSON) must still count an installed model as installed,
      // so an upgrade never silently forces a multi-GB re-download.
      for (const legacyMarker of ["", "{not json", "{}"]) {
        await fsp.writeFile(markerPath, legacyMarker);
        assert.strictEqual(
          manager.isInstalled(dir, model),
          true,
          `marker ${JSON.stringify(legacyMarker)} should read as installed`
        );
      }

      // With a presence-only marker, a missing file flips it back to false.
      await fsp.rm(file);
      assert.strictEqual(manager.isInstalled(dir, model), false);
    });
  } finally {
    server.close();
  }
});

test("an aborted download leaves no .part and a retry succeeds", async () => {
  const full = Buffer.from("the-full-payload-".repeat(64));
  // First request: send a few bytes then destroy the socket mid-stream so the
  // transfer fails. Later requests: serve the whole file.
  let attempt = 0;
  const server = http.createServer((req, res) => {
    attempt++;
    if (attempt === 1) {
      res.setHeader("content-length", full.length);
      res.write(full.subarray(0, 8));
      res.socket.destroy(); // abrupt failure, like a dropped connection
      return;
    }
    res.setHeader("content-length", full.length);
    res.end(full);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withTmp(async (dir) => {
      const model = {
        kind: "cleanup", id: "resume",
        files: [{ name: "m.gguf", bytes: full.length, url: `${base}/m.gguf` }],
      };
      const dest = manager.filePath(dir, model, model.files[0]);

      await assert.rejects(() => manager.download(dir, model));
      // No half-written .part is left behind to masquerade as a real file, and
      // the model is not considered installed.
      assert.ok(!fs.existsSync(`${dest}.part`), "stray .part should be discarded");
      assert.strictEqual(manager.isInstalled(dir, model), false);

      // A second attempt re-fetches the whole file and completes.
      await manager.download(dir, model);
      assert.strictEqual(manager.isInstalled(dir, model), true);
      assert.deepStrictEqual(fs.readFileSync(dest), full);
    });
  } finally {
    server.close();
  }
});
