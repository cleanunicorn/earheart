// Behaviour of the model-management IPC handlers in main/ipc.js.
//
// main/ipc.js requires Electron and most of the main process at load, so this
// uses the same require.cache stubbing as pipeline.test.js: the module is given
// fakes for its neighbours and a capturing ipcMain, then init() registers the
// real handlers for the test to invoke. The real registry stays in place, so
// the fallback asserted below is the catalog's own default.

const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ipcPath = require.resolve("../main/ipc");
const registry = require("../main/engines/registry");
const manager = require("../main/engines/model-manager");
const hfModels = require("../main/services/hf-models");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(ipcPath)] });

// Load main/ipc.js against fakes, run init(), and return its handlers keyed by
// channel. `cfg` is the settings object the handlers read first; every save
// lands in `saved` and becomes what the next read returns. `engines` overrides
// members of the engines facade, `hf` members of services/hf-models, and every
// window broadcast lands in `broadcasts`.
function loadIpcHandlers(cfg, { engines = {}, hf = {}, route = {} } = {}) {
  const handlers = {};
  const saved = [];
  const broadcasts = [];
  const warnings = [];
  let stored = cfg;
  const settings = {
    DEFAULTS: {},
    get: () => stored,
    onChanged: () => () => {},
    save: (next) => {
      saved.push(next);
      stored = next;
      return next;
    },
  };
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0" },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
      shell: {},
    },
    [resolveFrom("./settings")]: settings,
    [resolveFrom("./engines")]: {
      registry,
      remove: async () => {},
      removeFiles: async () => {},
      isInstalled: () => false,
      download: async () => {},
      definitionFingerprint: manager.definitionFingerprint,
      ...engines,
    },
    [resolveFrom("./services/hf-models")]: { ...hfModels, ...hf },
    [resolveFrom("./windows")]: {
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    },
    [resolveFrom("./services/route")]: route,
    [resolveFrom("./output/deliver")]: {},
    [resolveFrom("./history")]: {},
    [resolveFrom("./autostart")]: {},
    [resolveFrom("./updates")]: {},
    [resolveFrom("./tray")]: { refresh() {} },
    [resolveFrom("./util/logger")]: { info() {}, warn: (msg) => warnings.push(msg), error() {} },
  };

  const previous = {};
  for (const p of Object.keys(stubs)) {
    previous[p] = require.cache[p];
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = stubs[p];
    require.cache[p] = m;
  }
  delete require.cache[ipcPath];
  try {
    require(ipcPath).init({ applyHotkeys: () => ({}), onSettingsChanged() {} });
  } finally {
    delete require.cache[ipcPath];
    for (const p of Object.keys(stubs)) {
      if (previous[p]) require.cache[p] = previous[p];
      else delete require.cache[p];
    }
  }
  return { handlers, saved, broadcasts, warnings };
}

test("models:status retains removal identity without summing download sizes", () => {
  const model = { id: "custom-example", kind: "stt", label: "Example", note: "Local", custom: true };
  const { handlers } = loadIpcHandlers({}, {
    engines: {
      registry: {
        ...registry,
        listModels: (kind) => kind === "stt" ? [model] : [],
        totalBytes: () => { throw new Error("status must not sum files"); },
      },
      isInstalled: (kind, id) => kind === "stt" && id === model.id,
    },
  });
  assert.deepStrictEqual(handlers["models:status"](), {
    stt: [{ ...model, installed: true }],
    cleanup: [],
  });
});

const customCleanup = {
  id: "custom-acme-foo-q4-k-m",
  kind: "cleanup",
  label: "foo · Q4_K_M",
  engine: "llama-gguf",
  custom: true,
  files: [{ name: "foo-Q4_K_M.gguf", url: "https://huggingface.co/acme/foo/resolve/c/foo-Q4_K_M.gguf" }],
  gguf: { file: "foo-Q4_K_M.gguf" },
};

function configWith(cleanupModel) {
  return {
    stt: { builtin: { model: "parakeet-tdt-0.6b-v3-int8" } },
    cleanup: { engine: "builtin", builtin: { model: cleanupModel } },
    customModels: [customCleanup],
  };
}

test("removing the selected custom cleanup model falls back to Qwen3 4B Instruct 2507", async (t) => {
  t.after(() => registry.setCustomModels([])); // init() registers the custom model
  const { handlers, saved } = loadIpcHandlers(configWith(customCleanup.id));

  const result = await handlers["models:remove-custom"]({}, { modelId: customCleanup.id });

  assert.strictEqual(result.ok, true);
  // The renderer adopts this, so its Save can't fall back to a missing option.
  assert.strictEqual(result.kind, "cleanup");
  assert.strictEqual(result.model, "qwen3-4b-2507");
  assert.strictEqual(saved.length, 1);
  // A literal, not registry.DEFAULT_CLEANUP_MODEL: the handler reading the
  // wrong constant, or a stale literal, has to fail here.
  assert.strictEqual(saved[0].cleanup.builtin.model, "qwen3-4b-2507");
  assert.deepStrictEqual(saved[0].customModels, []);
  // The STT selection is not touched by a cleanup removal.
  assert.strictEqual(saved[0].stt.builtin.model, "parakeet-tdt-0.6b-v3-int8");
});

test("removing a custom cleanup model that isn't selected keeps the selection", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const { handlers, saved } = loadIpcHandlers(configWith("gemma-3-1b"));

  const result = await handlers["models:remove-custom"]({}, { modelId: customCleanup.id });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, "cleanup");
  assert.strictEqual(result.model, "gemma-3-1b");
  assert.strictEqual(saved[0].cleanup.builtin.model, "gemma-3-1b");
  assert.deepStrictEqual(saved[0].customModels, []);
});

const customStt = {
  id: "custom-acme-bar-int8",
  kind: "stt",
  label: "bar · int8",
  engine: "sherpa-parakeet",
  custom: true,
  files: [{ name: "encoder.int8.onnx", url: "https://huggingface.co/acme/bar/resolve/c/encoder.int8.onnx" }],
  sherpa: { family: "transducer" },
};

test("removing the selected custom STT model returns and saves the STT fallback", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const cfg = {
    stt: { builtin: { model: customStt.id } },
    cleanup: { engine: "builtin", builtin: { model: "gemma-3-1b" } },
    customModels: [customStt],
  };
  const { handlers, saved } = loadIpcHandlers(cfg);

  const result = await handlers["models:remove-custom"]({}, { modelId: customStt.id });

  assert.deepStrictEqual(
    { ok: result.ok, kind: result.kind, model: result.model },
    { ok: true, kind: "stt", model: "parakeet-tdt-0.6b-v3" }
  );
  assert.strictEqual(saved[0].stt.builtin.model, "parakeet-tdt-0.6b-v3");
  assert.strictEqual(saved[0].cleanup.builtin.model, "gemma-3-1b");
});

for (const code of ["EBUSY", "EPERM"]) {
  test(`a ${code} delete fails remove-custom and keeps the definition for a retry`, async (t) => {
    t.after(() => registry.setCustomModels([]));
    let fail = true;
    const removed = [];
    const { handlers, saved, warnings } = loadIpcHandlers(configWith(customCleanup.id), {
      engines: {
        remove: async (kind, id) => {
          if (fail) {
            const err = new Error(`${code}: resource busy or locked, rmdir '${id}'`);
            err.code = code;
            throw err;
          }
          removed.push(`${kind}:${id}`);
        },
      },
    });

    const result = await handlers["models:remove-custom"]({}, { modelId: customCleanup.id });

    assert.strictEqual(result.ok, false);
    // Actionable copy for the user; the raw error, with its path, goes to the log.
    assert.match(result.error, /in use or locked.*try again/);
    assert.doesNotMatch(result.error, new RegExp(code));
    assert.ok(warnings.some((w) => w.includes(code) && w.includes(customCleanup.id)), warnings.join("\n"));
    assert.strictEqual(saved.length, 0, "a failed delete must not drop the definition");
    assert.ok(registry.getModel("cleanup", customCleanup.id), "still registered");

    // Once the files can go, the same request succeeds.
    fail = false;
    const retry = await handlers["models:remove-custom"]({}, { modelId: customCleanup.id });
    assert.strictEqual(retry.ok, true);
    assert.deepStrictEqual(removed, [`cleanup:${customCleanup.id}`]);
    assert.deepStrictEqual(saved[0].customModels, []);
    assert.strictEqual(registry.getModel("cleanup", customCleanup.id), null);
  });
}

test("remove-custom drops a definition the registry doesn't know without deleting files", async (t) => {
  t.after(() => registry.setCustomModels([]));
  // A definition the registry refuses (a path segment that can't name a
  // directory) is stored but never registered.
  const invalid = { ...customCleanup, id: "custom-../escape" };
  const cfg = { ...configWith("gemma-3-1b"), customModels: [invalid] };
  const removeCalls = [];
  const { handlers, saved } = loadIpcHandlers(cfg, {
    engines: { remove: async (kind, id) => removeCalls.push(id) },
  });

  const result = await handlers["models:remove-custom"]({}, { modelId: invalid.id });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(removeCalls, []);
  assert.deepStrictEqual(saved[0].customModels, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// An engines.download fake that streams until aborted, then takes a deferred
// cleanup step before rejecting — the window in which an rm would race it.
function abortableDownload(events) {
  const started = deferred();
  const cleanup = deferred();
  const download = (kind, id, { signal }) => {
    events.push(`download:${kind}:${id}`);
    started.resolve();
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        async () => {
          events.push("aborted");
          await cleanup.promise;
          events.push("download settled");
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  };
  return { download, started: started.promise, finishCleanup: cleanup.resolve };
}

function within(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

for (const channel of ["models:remove", "models:remove-custom"]) {
  test(`${channel} aborts and awaits an in-flight download before deleting files`, async (t) => {
    t.after(() => registry.setCustomModels([]));
    const events = [];
    const fake = abortableDownload(events);
    const { handlers, broadcasts } = loadIpcHandlers(configWith("gemma-3-1b"), {
      engines: {
        download: fake.download,
        remove: async (kind, id) => events.push(`remove:${kind}:${id}`),
      },
    });
    const key = { kind: "cleanup", modelId: customCleanup.id };
    const downloading = handlers["models:download"]({}, key);
    await fake.started;

    const removing = handlers[channel]({}, channel === "models:remove" ? key : { modelId: key.modelId });
    // While the removal waits for the download, the same model can't restart.
    await new Promise((r) => setImmediate(r));
    const again = await handlers["models:download"]({}, key);
    assert.strictEqual(again.ok, false);
    assert.strictEqual(events.includes(`remove:cleanup:${customCleanup.id}`), false,
      "files must not be deleted while the download is still settling");

    fake.finishCleanup();
    const result = await within(removing, 1000, channel);
    const downloadResult = await within(downloading, 1000, "download");

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(events, [
      `download:cleanup:${customCleanup.id}`,
      "aborted",
      "download settled",
      `remove:cleanup:${customCleanup.id}`,
    ]);
    assert.strictEqual(downloadResult.cancelled, true);
    const done = broadcasts.filter((b) => b.channel === "models:done" && b.payload.modelId === customCleanup.id);
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].payload.cancelled, true);

    // Once the removal is over the model can be downloaded again.
    const restarted = handlers["models:download"]({}, key);
    await handlers["models:cancel"]({}, key);
    const restartedResult = await within(restarted, 1000, "re-download");
    assert.strictEqual(restartedResult.cancelled, true, JSON.stringify(restartedResult));
  });
}

test("removing one model leaves another model's download running", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const events = [];
  const fake = abortableDownload(events);
  const removed = [];
  const { handlers } = loadIpcHandlers(configWith("gemma-3-1b"), {
    engines: { download: fake.download, remove: async (kind, id) => removed.push(id) },
  });
  const downloading = handlers["models:download"]({}, { kind: "stt", modelId: "parakeet-tdt-0.6b-v3" });
  await fake.started;

  const result = await within(handlers["models:remove"]({}, { kind: "cleanup", modelId: "gemma-3-1b" }), 1000, "remove");

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(removed, ["gemma-3-1b"]);
  assert.strictEqual(events.includes("aborted"), false);
  // models:cancel still reaches the download after the map changed shape.
  await handlers["models:cancel"]({}, { kind: "stt", modelId: "parakeet-tdt-0.6b-v3" });
  fake.finishCleanup();
  const downloadResult = await within(downloading, 1000, "download");
  assert.strictEqual(downloadResult.cancelled, true);
});

// Two Hugging Face listings of the same repo + quant at different commits: the
// custom id is the same, the definition is not.
function ggufListing(commit) {
  return {
    repo: "o/r-GGUF",
    commit,
    recommended: "Q4_K_M",
    variants: [
      {
        label: "Q4_K_M",
        totalBytes: 12,
        files: [
          {
            name: "r-Q4_K_M.gguf",
            bytes: 12,
            url: `https://huggingface.co/o/r-GGUF/resolve/${commit}/r-Q4_K_M.gguf`,
          },
        ],
      },
    ],
  };
}

function addCustomHarness(cfg, listings, { engines = {}, events = [] } = {}) {
  let next = 0;
  let failWipe = false;
  const listing = async () => listings[next++];
  const loaded = loadIpcHandlers(cfg, {
    hf: { listGgufQuants: listing, listSttVariants: listing },
    engines: {
      ...engines,
      removeFiles: async (def) => {
        if (failWipe) {
          const err = new Error("EBUSY: resource busy or locked");
          err.code = "EBUSY";
          throw err;
        }
        manager.modelDir(os.tmpdir(), def); // throws for a kind/id the real delete would reject
        events.push(`wipe:${def.kind}:${def.id}:${def.files[0].url}`);
      },
    },
  });
  const add = (kind = "cleanup") =>
    loaded.handlers["models:add-custom"]({}, { kind, url: "o/r-GGUF", variant: "Q4_K_M" });
  return { ...loaded, events, add, setFailWipe: (v) => (failWipe = v) };
}

test("re-adding a custom model after an upstream change wipes the old revision's bytes", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const h = addCustomHarness(configWith("gemma-3-1b"), [ggufListing("aaa"), ggufListing("bbb")]);

  const first = await h.add();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.modelId, "custom-o-r-gguf-q4-k-m");
  const second = await h.add();
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.modelId, first.modelId, "the id carries no commit");

  // The second add replaced a different definition, so the aaa bytes go
  // before the bbb definition is saved.
  assert.deepStrictEqual(h.events.slice(-1), [
    "wipe:cleanup:custom-o-r-gguf-q4-k-m:https://huggingface.co/o/r-GGUF/resolve/aaa/r-Q4_K_M.gguf",
  ]);
  const stored = h.saved.at(-1).customModels.filter((m) => m.id === first.modelId);
  assert.strictEqual(stored.length, 1);
  assert.match(stored[0].files[0].url, /\/bbb\//);
});

test("re-adding an unchanged custom model keeps its install", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const h = addCustomHarness(configWith("gemma-3-1b"), [ggufListing("aaa"), ggufListing("aaa")]);

  await h.add();
  const wipesAfterFirst = h.events.length;
  const second = await h.add();

  assert.strictEqual(second.ok, true);
  assert.strictEqual(h.events.length, wipesAfterFirst, "identical definition: nothing wiped");
});

test("adding a custom model with no stored definition clears orphaned bytes first", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const cfg = { ...configWith("gemma-3-1b"), customModels: [] };
  const h = addCustomHarness(cfg, [ggufListing("aaa")]);

  const result = await h.add();

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(h.events, [
    "wipe:cleanup:custom-o-r-gguf-q4-k-m:https://huggingface.co/o/r-GGUF/resolve/aaa/r-Q4_K_M.gguf",
  ]);
});

test("a failed wipe on re-add keeps the old definition", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const h = addCustomHarness(configWith("gemma-3-1b"), [ggufListing("aaa"), ggufListing("bbb")]);
  await h.add();
  const savesBefore = h.saved.length;
  h.setFailWipe(true);

  const result = await h.add();

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /in use or locked/);
  assert.strictEqual(h.saved.length, savesBefore);
  assert.match(registry.getModel("cleanup", "custom-o-r-gguf-q4-k-m").files[0].url, /\/aaa\//);
});

test("a download refused while its model is being removed still reports models:done", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const gate = deferred();
  const { handlers, broadcasts } = loadIpcHandlers(configWith("gemma-3-1b"), {
    engines: { remove: () => gate.promise },
  });
  const key = { kind: "cleanup", modelId: customCleanup.id };
  // No download in flight, so only the removal's busy mark can refuse this.
  const removing = handlers["models:remove-custom"]({}, { modelId: key.modelId });
  await new Promise((r) => setImmediate(r));

  const refused = await handlers["models:download"]({}, key);

  assert.deepStrictEqual(refused, { ok: false, error: "This model is being removed" });
  // Settings clears its optimistic "Downloading…" row only on models:done.
  assert.deepStrictEqual(
    broadcasts.filter((b) => b.channel === "models:done").map((b) => b.payload),
    [{ kind: "cleanup", modelId: customCleanup.id, ok: false, error: "This model is being removed" }]
  );
  gate.resolve();
  assert.strictEqual((await within(removing, 1000, "remove-custom")).ok, true);
});

test("a second change to a model that is already being changed is refused", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const gate = deferred();
  const removed = [];
  const { handlers, saved } = loadIpcHandlers(configWith(customCleanup.id), {
    engines: {
      remove: async (kind, id) => {
        await gate.promise;
        removed.push(id);
      },
    },
  });
  const first = handlers["models:remove-custom"]({}, { modelId: customCleanup.id });
  await new Promise((r) => setImmediate(r));

  // A double-clicked Remove sends the same request again mid-delete.
  // Bounded, so a missing guard fails here instead of waiting on the gate.
  const second = await within(
    handlers["models:remove-custom"]({}, { modelId: customCleanup.id }), 1000, "second remove-custom"
  ).catch((err) => ({ ok: "waited", error: err.message }));
  const plain = await within(
    handlers["models:remove"]({}, { kind: "cleanup", modelId: customCleanup.id }), 1000, "models:remove"
  ).catch((err) => ({ ok: "waited", error: err.message }));

  assert.strictEqual(second.ok, false);
  assert.match(second.error, /already being changed/);
  assert.strictEqual(plain.ok, false);
  assert.strictEqual(saved.length, 0, "the refused requests must not save");
  gate.resolve();
  const result = await within(first, 1000, "first remove-custom");
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(removed, [customCleanup.id]);
  assert.strictEqual(saved.length, 1);
});

test("re-adding over a hand-edited definition that names no directory replaces it", async (t) => {
  t.after(() => registry.setCustomModels([]));
  // A trailing space can't name a directory; settings.json is hand-editable.
  const broken = { ...customCleanup, id: "custom-o-r-gguf-q4-k-m", kind: "cleanup " };
  const cfg = { ...configWith("gemma-3-1b"), customModels: [broken] };
  const h = addCustomHarness(cfg, [ggufListing("aaa")]);

  const result = await h.add();

  assert.strictEqual(result.ok, true, result.error);
  assert.deepStrictEqual(h.events, [
    "wipe:cleanup:custom-o-r-gguf-q4-k-m:https://huggingface.co/o/r-GGUF/resolve/aaa/r-Q4_K_M.gguf",
  ]);
  const stored = h.saved.at(-1).customModels;
  assert.deepStrictEqual(stored.map((m) => m.kind), ["cleanup"]);
});

test("models:remove gives actionable copy for a locked file and passes other errors through", async (t) => {
  t.after(() => registry.setCustomModels([]));
  let next;
  const { handlers, warnings } = loadIpcHandlers(configWith("gemma-3-1b"), {
    engines: { remove: async () => { throw next; } },
  });
  const key = { kind: "cleanup", modelId: "gemma-3-1b" };

  next = Object.assign(new Error("EACCES: permission denied, rmdir '/x/models/cleanup/gemma-3-1b'"), { code: "EACCES" });
  const locked = await handlers["models:remove"]({}, key);
  next = new Error("Unknown cleanup model: gemma-3-1b");
  const other = await handlers["models:remove"]({}, key);

  assert.match(locked.error, /in use or locked/);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
  assert.strictEqual(other.error, "Unknown cleanup model: gemma-3-1b");
});

test("re-adding an id under the other kind wipes the bytes under both kinds", async (t) => {
  t.after(() => registry.setCustomModels([]));
  // Ids are custom-<repo>-<variant> for both kinds, and directories are
  // <kind>/<id>, so an STT variant labelled like a GGUF quant collides.
  const sttListing = {
    ...ggufListing("bbb"),
    variants: [{ ...ggufListing("bbb").variants[0], sherpa: { encoder: "r-Q4_K_M.gguf" } }],
  };
  const h = addCustomHarness(configWith("gemma-3-1b"), [ggufListing("aaa"), sttListing]);

  await h.add("cleanup");
  const result = await h.add("stt");

  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.modelId, "custom-o-r-gguf-q4-k-m");
  assert.deepStrictEqual(h.events.slice(-2), [
    "wipe:cleanup:custom-o-r-gguf-q4-k-m:https://huggingface.co/o/r-GGUF/resolve/aaa/r-Q4_K_M.gguf",
    "wipe:stt:custom-o-r-gguf-q4-k-m:https://huggingface.co/o/r-GGUF/resolve/bbb/r-Q4_K_M.gguf",
  ]);
  const stored = h.saved.at(-1).customModels.filter((m) => m.id === result.modelId);
  assert.deepStrictEqual(stored.map((m) => m.kind), ["stt"]);
});

test("re-adding a changed custom model stops its download before wiping", async (t) => {
  t.after(() => registry.setCustomModels([]));
  const events = [];
  const fake = abortableDownload(events);
  const h = addCustomHarness(configWith("gemma-3-1b"), [ggufListing("aaa"), ggufListing("bbb")], {
    engines: { download: fake.download },
    events,
  });
  const first = await h.add();
  const downloading = h.handlers["models:download"]({}, { kind: "cleanup", modelId: first.modelId });
  await fake.started;
  const sinceStart = events.length;

  const readding = h.add();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(events.slice(sinceStart).some((e) => e.startsWith("wipe:")), false,
    "the old revision must not be wiped while its download is still settling");
  fake.finishCleanup();
  const result = await within(readding, 1000, "add-custom");

  assert.strictEqual(result.ok, true, result.error);
  assert.deepStrictEqual(events.slice(-4), [
    `download:cleanup:${first.modelId}`,
    "aborted",
    "download settled",
    `wipe:cleanup:${first.modelId}:https://huggingface.co/o/r-GGUF/resolve/aaa/r-Q4_K_M.gguf`,
  ]);
  assert.strictEqual((await within(downloading, 1000, "download")).cancelled, true);
});
/* ---------------- adding a Hugging Face STT repo of an unsupported family ---------------- */

// Serve one repo tree to the handlers' global fetch for the length of a test.
function serveTree(t, paths) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes("/tree/")
      ? paths.map((p) => ({ type: "file", path: p, size: 1 }))
      : { sha: "c" };
    return { ok: true, status: 200, async json() { return body; } };
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

for (const [what, url, message] of [
  ["a Canary repo", "csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8", /NeMo Canary model, which Earheart can't run/],
  ["an unidentified encoder-decoder repo", "u/fire-red-asr", /Couldn't tell which kind of speech model/],
]) {
  test(`Find versions and Add both refuse ${what}, and nothing is saved`, async (t) => {
    t.after(() => registry.setCustomModels([]));
    serveTree(t, ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]);
    const { handlers, saved } = loadIpcHandlers(configWith("gemma-3-1b"));

    const found = await handlers["models:hf-variants"]({}, { kind: "stt", url });
    assert.strictEqual(found.ok, false);
    assert.match(found.error, message);

    // Add re-discovers server-side, so a renderer that skipped Find can't
    // save the entry either.
    const added = await handlers["models:add-custom"]({}, { kind: "stt", url, variant: "int8" });
    assert.strictEqual(added.ok, false);
    assert.match(added.error, message);
    assert.strictEqual(saved.length, 0);
    assert.ok(!registry.listModels("stt").some((m) => m.custom), "nothing registered");
  });
}

/* ---------------- Settings Test results (#187) ---------------- */

// The Test buttons show whatever these handlers return. Driven here through
// the real remote clients against a local server whose error replies echo a
// key and the dictated text, the way providers do.
async function withReply(status, body, run) {
  const server = require("node:http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const remoteRoute = {
  transcribe: require("../main/services/stt").transcribe,
  clean: require("../main/services/cleanup").clean,
};
const SECRETS = /sk-secret-value|sk-client-secret|this is uh a test|private/;

test("the Settings Test results never show a provider's reply", async () => {
  const { handlers } = loadIpcHandlers({}, { route: remoteRoute });
  const echo = JSON.stringify({
    error: { message: "Incorrect API key provided: sk-secret-value; content: um so this is uh a test, private" },
  });

  await withReply(401, echo, async (baseUrl) => {
    const cfg = { engine: "remote", baseUrl, apiKey: "sk-client-secret", model: "m" };
    const stt = await handlers["stt:test"]({}, cfg);
    assert.deepStrictEqual(stt, { ok: false, error: "STT service error 401 — check the API key in Settings" });
    const models = await handlers["models:list-remote"]({}, cfg);
    assert.deepStrictEqual(models, {
      ok: false,
      error: "Model list service error 401 — check the API key in Settings",
    });
  });
  await withReply(400, echo, async (baseUrl) => {
    const cleanup = await handlers["cleanup:test"]({}, { engine: "remote", baseUrl, apiKey: "sk-client-secret", model: "m" });
    assert.deepStrictEqual(cleanup, { ok: false, error: "Cleanup service error 400" });
    assert.doesNotMatch(cleanup.error, SECRETS);
  });
});

test("the Settings Test results name an unreachable host in plain words", async () => {
  const { handlers } = loadIpcHandlers({}, { route: remoteRoute });
  const probe = require("node:http").createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  const cfg = { engine: "remote", baseUrl: `http://${host}/v1`, model: "m" };

  for (const channel of ["stt:test", "cleanup:test", "models:list-remote"]) {
    const result = await handlers[channel]({}, cfg);
    assert.deepStrictEqual(result, { ok: false, error: `Couldn't reach ${host}` }, channel);
  }
});
