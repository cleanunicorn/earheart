const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function loadSettings(userData) {
  const settingsPath = require.resolve("../main/settings");
  const electronPath = require.resolve("electron");
  const registryPath = require.resolve("../main/engines/registry");
  const savedElectron = require.cache[electronPath];
  const savedRegistry = require.cache[registryPath];

  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = { app: { getPath: () => userData } };
  require.cache[electronPath] = electron;

  const registry = new Module(registryPath, null);
  registry.filename = registryPath;
  registry.loaded = true;
  registry.exports = {
    DEFAULT_STT_MODEL: "stt-default",
    DEFAULT_CLEANUP_MODEL: "cleanup-default",
  };
  require.cache[registryPath] = registry;

  delete require.cache[settingsPath];
  const settings = require(settingsPath);
  delete require.cache[settingsPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  if (savedRegistry) require.cache[registryPath] = savedRegistry;
  else delete require.cache[registryPath];
  return settings;
}

test("settings save replaces the file and leaves no partial temp file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = loadSettings(dir);

  settings.save({ hotkey: "First" });
  settings.save({ hotkey: "Second" });

  const file = path.join(dir, "settings.json");
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).hotkey, "Second");
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
    []
  );
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("a failed replacement preserves the previous settings", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = loadSettings(dir);
  settings.save({ hotkey: "Working" });

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    assert.throws(() => settings.save({ hotkey: "Broken" }), /rename failure/);
  } finally {
    fs.renameSync = originalRename;
  }

  const file = path.join(dir, "settings.json");
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).hotkey, "Working");
  assert.strictEqual(settings.get().hotkey, "Working");
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
    []
  );
});
