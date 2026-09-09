const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function loadDeliver(initialClipboard) {
  const deliverPath = require.resolve("../main/output/deliver");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  let value = initialClipboard;
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = {
    clipboard: {
      readText: () => value,
      writeText: (next) => {
        value = next;
      },
    },
    systemPreferences: {},
    shell: {},
  };
  require.cache[electronPath] = electron;
  delete require.cache[deliverPath];
  const deliver = require(deliverPath);
  delete require.cache[deliverPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  return { deliver: deliver.deliver, clipboard: () => value, setClipboard: (v) => (value = v) };
}

test("cancelling before paste restores the previous clipboard", async () => {
  const fake = loadDeliver("previous words");
  const controller = new AbortController();
  const pending = fake.deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: 10 },
    controller.signal
  );
  assert.strictEqual(fake.clipboard(), "new transcript");
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(fake.clipboard(), "previous words");
});

test("cancelling does not overwrite a newer clipboard change", async () => {
  const fake = loadDeliver("previous words");
  const controller = new AbortController();
  const pending = fake.deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: 10 },
    controller.signal
  );
  fake.setClipboard("copied by another app");
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(fake.clipboard(), "copied by another app");
});
