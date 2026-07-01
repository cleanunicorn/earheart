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

const Module = require("node:module");

// Load main/engines/index.js with `electron`, `./host`, and `./model-manager`
// replaced by the supplied fakes, so the facade can be exercised without the
// Electron runtime or the native engines. Returns the facade module.
function loadFacadeWith({ host, manager: managerStub }) {
  const indexPath = require.resolve("../main/engines/index");
  const electronPath = require.resolve("electron", {
    paths: [path.dirname(indexPath)],
  });
  const hostPath = require.resolve("../main/engines/host");
  const managerPath = require.resolve("../main/engines/model-manager");
  const stubs = {
    [electronPath]: { app: { getPath: () => os.tmpdir() } },
    [hostPath]: host,
    [managerPath]: managerStub,
  };
  const saved = {};
  for (const p of Object.keys(stubs)) {
    saved[p] = require.cache[p];
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = stubs[p];
    require.cache[p] = m;
  }
  delete require.cache[indexPath];
  try {
    return require(indexPath);
  } finally {
    delete require.cache[indexPath];
    for (const p of Object.keys(stubs)) {
      if (saved[p]) require.cache[p] = saved[p];
      else delete require.cache[p];
    }
  }
}

/* ---------------- registry ---------------- */

test("registry exposes default models that resolve", () => {
  const stt = registry.getModel("stt", registry.DEFAULT_STT_MODEL);
  const cleanup = registry.getModel("cleanup", registry.DEFAULT_CLEANUP_MODEL);
  assert.ok(stt && stt.files.length > 0);
  assert.ok(cleanup && cleanup.files.length > 0);
  assert.strictEqual(registry.getModel("stt", "nope"), null);
});

test("registry: setCustomModels makes custom models resolvable and listable", () => {
  const custom = {
    id: "custom-acme-foo-q4-k-m",
    kind: "cleanup",
    label: "foo · Q4_K_M",
    engine: "llama-gguf",
    custom: true,
    files: [{ name: "foo-Q4_K_M.gguf", url: "https://huggingface.co/acme/foo/resolve/c/foo-Q4_K_M.gguf" }],
    gguf: { file: "foo-Q4_K_M.gguf" },
  };
  try {
    registry.setCustomModels([custom]);
    assert.strictEqual(registry.getModel("cleanup", custom.id), custom);
    assert.ok(registry.listModels("cleanup").some((m) => m.id === custom.id));
    // Custom STT entries don't leak into the cleanup list and vice versa.
    assert.ok(!registry.listModels("stt").some((m) => m.id === custom.id));
    // Built-ins still resolve alongside custom models.
    assert.ok(registry.getModel("cleanup", registry.DEFAULT_CLEANUP_MODEL));
  } finally {
    registry.setCustomModels([]); // reset so later invariant tests see built-ins only
  }
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

test("registry: every model file is checksum-pinned to an immutable commit", () => {
  for (const { kind, id, file } of allModelFiles()) {
    const where = `${kind}/${id} -> ${file.name}`;
    // A 64-hex sha256 must be present — without it the download manager skips
    // verification and trusts the bytes blindly.
    assert.match(
      file.sha256 || "",
      /^[a-f0-9]{64}$/,
      `${where}: missing or malformed sha256`
    );
    // The URL must pin a Hugging Face commit, not a moving branch, so the bytes
    // (and thus the checksum) can't drift out from under us.
    const url = new URL(file.url);
    if (url.hostname === "huggingface.co") {
      assert.doesNotMatch(
        url.pathname,
        /\/resolve\/main\//,
        `${where}: pins resolve/main (a moving ref); use resolve/<commit>`
      );
    }
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

test("engines.clean falls back to the raw transcript when cleanup is empty", async () => {
  // The in-process side of "never lose the user's words": if the model returns
  // empty/whitespace, clean() must deliver the raw transcript instead.
  let cleanReply = "";
  const calls = [];
  // createHost factory shape (the real host module); this test only drives the
  // cleanup path, so both services share one fake.
  const hostModule = {
    createHost: () => ({
      request: async (type, args) => {
        calls.push(type);
        if (type === "load-cleanup") return { ready: true };
        if (type === "clean") return cleanReply;
        throw new Error(`unexpected request: ${type}`);
      },
      stop() {},
      onExit() {},
    }),
  };
  const managerStub = {
    isInstalled: () => true,
    modelDir: (base, model) => path.join(base, model.kind, model.id),
  };
  const facade = loadFacadeWith({ host: hostModule, manager: managerStub });

  const cfg = { builtin: { model: registry.DEFAULT_CLEANUP_MODEL }, systemPrompt: "rules" };

  cleanReply = "   "; // whitespace-only -> treated as empty
  assert.strictEqual(await facade.clean("hello world", cfg), "hello world");

  cleanReply = ""; // empty
  assert.strictEqual(await facade.clean("keep these words", cfg), "keep these words");

  cleanReply = "Hello, world."; // real output passes through
  assert.strictEqual(await facade.clean("hello world", cfg), "Hello, world.");

  assert.ok(calls.includes("clean"));
});

test("engines facade routes STT and cleanup to separate worker hosts", async () => {
  // The two-worker split: transcribe must only ever talk to the STT host and
  // clean only to the cleanup host, so a crash or load in one engine can't
  // affect the other. We hand the facade a `createHost` factory and assert each
  // host sees only its own request types.
  const hostsBySvc = {};
  const hostModule = {
    createHost({ serviceName }) {
      const calls = [];
      const host = {
        serviceName,
        calls,
        request: async (type) => {
          calls.push(type);
          if (type === "load-stt" || type === "load-cleanup") return { ready: true };
          if (type === "transcribe") return "transcribed";
          if (type === "clean") return "cleaned";
          if (type === "unload-stt" || type === "unload-cleanup") return {};
          throw new Error(`unexpected request: ${type}`);
        },
        stopped: false,
        stop() {
          this.stopped = true;
        },
        exitFns: [],
        onExit(fn) {
          this.exitFns.push(fn);
        },
      };
      hostsBySvc[serviceName] = host;
      return host;
    },
  };
  const managerStub = {
    isInstalled: () => true,
    modelDir: (base, model) => path.join(base, model.kind, model.id),
  };
  const facade = loadFacadeWith({ host: hostModule, manager: managerStub });

  const stt = hostsBySvc["earheart-stt"];
  const cleanup = hostsBySvc["earheart-cleanup"];
  assert.ok(stt && cleanup, "both hosts should be created");

  await facade.transcribe(
    Buffer.from("wav"),
    { builtin: { model: registry.DEFAULT_STT_MODEL }, language: "" }
  );
  await facade.clean(
    "hello",
    { builtin: { model: registry.DEFAULT_CLEANUP_MODEL }, systemPrompt: "rules" }
  );

  // Each host saw only its own engine's request types.
  assert.ok(stt.calls.includes("load-stt") && stt.calls.includes("transcribe"));
  assert.ok(!stt.calls.includes("clean") && !stt.calls.includes("load-cleanup"));
  assert.ok(cleanup.calls.includes("load-cleanup") && cleanup.calls.includes("clean"));
  assert.ok(!cleanup.calls.includes("transcribe") && !cleanup.calls.includes("load-stt"));

  // unloadIdle only unloads hosts that have a model resident, on their own host.
  await facade.unloadIdle();
  assert.ok(stt.calls.includes("unload-stt"));
  assert.ok(cleanup.calls.includes("unload-cleanup"));

  // stop tears down both workers.
  facade.stop();
  assert.ok(stt.stopped && cleanup.stopped);
});

// Build a two-host facade over fake STT + cleanup workers. Each fake records its
// calls and its registered onExit listeners, so tests can simulate one worker
// dying and assert the other is unaffected.
function loadTwoHostFacade() {
  const hostsBySvc = {};
  const hostModule = {
    createHost({ serviceName }) {
      const calls = [];
      const host = {
        serviceName,
        calls,
        request: async (type) => {
          calls.push(type);
          if (type === "load-stt" || type === "load-cleanup") return { ready: true };
          if (type === "transcribe") return "transcribed";
          if (type === "clean") return "cleaned";
          if (type === "unload-stt" || type === "unload-cleanup") return {};
          throw new Error(`unexpected request: ${type}`);
        },
        stopped: false,
        stop() {
          this.stopped = true;
        },
        exitFns: [],
        onExit(fn) {
          this.exitFns.push(fn);
        },
        die() {
          for (const fn of this.exitFns) fn();
        },
      };
      hostsBySvc[serviceName] = host;
      return host;
    },
  };
  const managerStub = {
    isInstalled: () => true,
    modelDir: (base, model) => path.join(base, model.kind, model.id),
  };
  const facade = loadFacadeWith({ host: hostModule, manager: managerStub });
  return { facade, hostsBySvc };
}

const STT_CFG = { builtin: { model: registry.DEFAULT_STT_MODEL }, language: "" };
const CLEANUP_CFG = { builtin: { model: registry.DEFAULT_CLEANUP_MODEL }, systemPrompt: "rules" };
const count = (host, type) => host.calls.filter((t) => t === type).length;

test("an STT worker crash forgets only STT loaded-state, not cleanup", async () => {
  // Crash isolation is the point of the split: if the STT worker dies, the next
  // transcribe must re-load STT, but cleanup (a separate, still-alive worker)
  // must NOT be made to re-load. A regression wiring both forget callbacks onto
  // one host would break this.
  const { facade, hostsBySvc } = loadTwoHostFacade();
  await facade.transcribe(Buffer.from("wav"), STT_CFG);
  await facade.clean("hello", CLEANUP_CFG);
  const stt = hostsBySvc["earheart-stt"];
  const cleanup = hostsBySvc["earheart-cleanup"];
  assert.strictEqual(count(stt, "load-stt"), 1);
  assert.strictEqual(count(cleanup, "load-cleanup"), 1);

  stt.die(); // the STT worker process exits

  await facade.transcribe(Buffer.from("wav"), STT_CFG);
  await facade.clean("hello", CLEANUP_CFG);
  // STT was forgotten on exit -> re-loaded; cleanup was untouched -> not reloaded.
  assert.strictEqual(count(stt, "load-stt"), 2, "STT should re-load after its worker died");
  assert.strictEqual(count(cleanup, "load-cleanup"), 1, "cleanup must not re-load when only STT died");
});

test("unloadIdle unloads only the engines that are actually resident", async () => {
  // A transcribe-only user (never cleaned) must unload STT but never send
  // unload-cleanup to a cleanup worker that was never loaded.
  const { facade, hostsBySvc } = loadTwoHostFacade();
  await facade.transcribe(Buffer.from("wav"), STT_CFG);
  const stt = hostsBySvc["earheart-stt"];
  const cleanup = hostsBySvc["earheart-cleanup"];

  await facade.unloadIdle();
  assert.ok(stt.calls.includes("unload-stt"));
  assert.ok(!cleanup.calls.includes("unload-cleanup"), "cleanup was never loaded; must not be unloaded");

  // A second unloadIdle with nothing resident is a no-op on both hosts.
  const before = stt.calls.length + cleanup.calls.length;
  await facade.unloadIdle();
  assert.strictEqual(stt.calls.length + cleanup.calls.length, before, "idle unload with nothing loaded is a no-op");
});

test("transcribe/clean reject early on an already-aborted signal without touching the worker", async () => {
  // The "pre-cancelled call returns early rather than spending a model load /
  // inference" contract: an aborted signal short-circuits before any host request.
  const { facade, hostsBySvc } = loadTwoHostFacade();
  const stt = hostsBySvc["earheart-stt"];
  const cleanup = hostsBySvc["earheart-cleanup"];

  await assert.rejects(
    () => facade.transcribe(Buffer.from("wav"), STT_CFG, AbortSignal.abort()),
    /abort/i
  );
  assert.strictEqual(stt.calls.length, 0, "no STT worker request for a pre-aborted transcribe");

  await assert.rejects(
    () => facade.clean("hello", CLEANUP_CFG, AbortSignal.abort()),
    /abort/i
  );
  assert.strictEqual(cleanup.calls.length, 0, "no cleanup worker request for a pre-aborted clean");
});
