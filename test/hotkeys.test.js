const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function loadHotkeys(registerImpl) {
  const hotkeysPath = require.resolve("../main/hotkeys");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  const calls = { registered: [], unregistered: [] };
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = {
    globalShortcut: {
      register(accelerator, callback) {
        calls.registered.push({ accelerator, callback });
        return registerImpl(accelerator);
      },
      unregister(accelerator) {
        calls.unregistered.push(accelerator);
      },
      unregisterAll() {},
    },
  };
  require.cache[electronPath] = electron;
  delete require.cache[hotkeysPath];
  const hotkeys = require(hotkeysPath);
  delete require.cache[hotkeysPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  return { hotkeys, calls };
}

test("a rejected replacement keeps the working hotkey registered", () => {
  const { hotkeys, calls } = loadHotkeys(
    (accelerator) => accelerator !== "CommandOrControl+Alt+X"
  );
  assert.deepStrictEqual(
    hotkeys.register("record", "CommandOrControl+Shift+Space", () => {}),
    { ok: true }
  );
  assert.strictEqual(
    hotkeys.register("record", "CommandOrControl+Alt+X", () => {}).ok,
    false
  );
  assert.deepStrictEqual(calls.unregistered, []);
});

test("a successful replacement releases the previous hotkey afterwards", () => {
  const { hotkeys, calls } = loadHotkeys(() => true);
  hotkeys.register("record", "CommandOrControl+Shift+Space", () => {});
  hotkeys.register("record", "CommandOrControl+Alt+X", () => {});
  assert.deepStrictEqual(calls.unregistered, ["CommandOrControl+Shift+Space"]);
});

test("a slot collision does not unregister either existing hotkey", () => {
  const { hotkeys, calls } = loadHotkeys(() => true);
  hotkeys.register("record", "CommandOrControl+Shift+Space", () => {});
  hotkeys.register("pause", "CommandOrControl+Alt+P", () => {});
  const result = hotkeys.register("pause", "CommandOrControl+Shift+Space", () => {});
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /record hotkey/);
  assert.deepStrictEqual(calls.unregistered, []);
});

test("reapplying the same hotkey does not drop and reacquire it", () => {
  const { hotkeys, calls } = loadHotkeys(() => true);
  hotkeys.register("record", "CommandOrControl+Shift+Space", () => {});
  hotkeys.register("record", "CommandOrControl+Shift+Space", () => {});
  assert.strictEqual(calls.registered.length, 1);
  assert.deepStrictEqual(calls.unregistered, []);
});
