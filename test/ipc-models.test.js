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
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(ipcPath)] });

// Load main/ipc.js against fakes, run init(), and return its handlers keyed by
// channel. `cfg` is the settings object the handlers read; every save lands in
// `saved`.
function loadIpcHandlers(cfg) {
  const handlers = {};
  const saved = [];
  const settings = {
    DEFAULTS: {},
    get: () => cfg,
    save: (next) => {
      saved.push(next);
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
      isInstalled: () => false,
    },
    [resolveFrom("./windows")]: {},
    [resolveFrom("./services/route")]: {},
    [resolveFrom("./output/deliver")]: {},
    [resolveFrom("./history")]: {},
    [resolveFrom("./autostart")]: {},
    [resolveFrom("./updates")]: {},
    [resolveFrom("./util/logger")]: { info() {}, warn() {}, error() {} },
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
  return { handlers, saved };
}

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
  assert.strictEqual(saved[0].cleanup.builtin.model, "gemma-3-1b");
  assert.deepStrictEqual(saved[0].customModels, []);
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
