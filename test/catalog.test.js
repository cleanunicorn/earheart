// The custom-model registry follows the settings on its own (#204): bound at
// the composition root, it registers the saved custom models at once and
// every saved change after — no IPC layer involved, so a script, a test or
// any other writer of settings sees the same models the app does.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../main/engines/registry");
const { bindCustomModels } = require("../main/engines/catalog");
const logger = require("../main/util/logger");

const custom = (id) => ({
  id,
  kind: "cleanup",
  label: id,
  engine: "llama-gguf",
  custom: true,
  files: [{ name: `${id}.gguf`, url: `https://huggingface.co/acme/x/resolve/c/${id}.gguf` }],
  gguf: { file: `${id}.gguf` },
});

// A settings module in miniature: get, save, and change listeners.
function fakeSettings(initial) {
  let stored = initial;
  const listeners = new Set();
  return {
    get: () => stored,
    onChanged: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    save(next) {
      const previous = stored;
      stored = next;
      for (const fn of listeners) fn({ previous, current: next });
    },
  };
}

test("custom models resolve as soon as they are bound, without ipc.init", (t) => {
  t.after(() => registry.setCustomModels([]));
  const settings = fakeSettings({ customModels: [custom("custom-acme-a")] });
  const unbind = bindCustomModels(settings);
  t.after(unbind);
  assert.ok(registry.getModel("cleanup", "custom-acme-a"));
});

test("a saved change to the custom models reaches the registry, whoever saves it", (t) => {
  t.after(() => registry.setCustomModels([]));
  const settings = fakeSettings({ customModels: [] });
  const unbind = bindCustomModels(settings);
  t.after(unbind);
  settings.save({ customModels: [custom("custom-acme-b")] });
  assert.ok(registry.getModel("cleanup", "custom-acme-b"));
  settings.save({ customModels: [] });
  assert.strictEqual(registry.getModel("cleanup", "custom-acme-b"), null);
});

test("unbinding stops following the settings", (t) => {
  t.after(() => registry.setCustomModels([]));
  const settings = fakeSettings({ customModels: [] });
  bindCustomModels(settings)();
  settings.save({ customModels: [custom("custom-acme-c")] });
  assert.strictEqual(registry.getModel("cleanup", "custom-acme-c"), null);
});

test("a custom model the registry drops leaves a trace in the log, not just the console", (t) => {
  t.after(() => registry.setCustomModels([]));
  const warnings = [];
  const original = logger.warn;
  logger.warn = (...args) => warnings.push(args.join(" "));
  try {
    registry.setCustomModels([{ ...custom("custom-acme-d"), id: "../escape" }]);
  } finally {
    logger.warn = original;
  }
  assert.ok(warnings.some((w) => /invalid path segment: \.\.\/escape/.test(w)), JSON.stringify(warnings));
});
