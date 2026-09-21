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

test("removing the selected custom cleanup model falls back to Granite 4.0 Micro", async (t) => {
  t.after(() => registry.setCustomModels([])); // init() registers the custom model
  const { handlers, saved } = loadIpcHandlers(configWith(customCleanup.id));

  const result = await handlers["models:remove-custom"]({}, { modelId: customCleanup.id });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(saved.length, 1);
  // A literal, not registry.DEFAULT_CLEANUP_MODEL: the handler reading the
  // wrong constant, or a stale literal, has to fail here.
  assert.strictEqual(saved[0].cleanup.builtin.model, "granite-4.0-micro");
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
