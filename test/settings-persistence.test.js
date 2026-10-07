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

// A temp userData directory that is removed when the test ends.
function makeSettingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("settings save replaces the file and leaves no partial temp file", (t) => {
  const dir = makeSettingsDir(t);
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
  const dir = makeSettingsDir(t);
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

// Changing the cleanup default must not move existing users: every saved
// settings file already holds the model they had (save() writes the full
// merged object), and there is deliberately no migration.
test("a saved cleanup model survives a new default", (t) => {
  const dir = makeSettingsDir(t);
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ cleanup: { engine: "builtin", builtin: { model: "gemma-3-1b" } } })
  );
  const settings = loadSettings(dir);

  assert.strictEqual(settings.get().cleanup.builtin.model, "gemma-3-1b");
  // A fresh profile, by contrast, gets whatever the registry now defaults to.
  const fresh = makeSettingsDir(t);
  assert.strictEqual(loadSettings(fresh).get().cleanup.builtin.model, "cleanup-default");
});

// The limits Settings shows as min/max on its two Performance fields. Main
// keeps its own copy (it must not parse renderer markup), so read the markup
// here and hold the two together.
function fieldRange(id) {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "settings.html"), "utf8");
  const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
  assert.ok(tag, `settings.html must have #${id}`);
  const min = Number(tag.match(/\bmin="([^"]+)"/)?.[1]);
  const max = Number(tag.match(/\bmax="([^"]+)"/)?.[1]);
  assert.ok(Number.isFinite(min) && Number.isFinite(max), `#${id} must declare numeric min and max`);
  return { min, max };
}

function limits(s) {
  return { maxSeconds: s.audio.maxRecordingSeconds, idle: s.engines.idleUnloadMinutes };
}

test("save clamps the dictation length and idle unload to the Settings ranges", (t) => {
  const dir = makeSettingsDir(t);
  const settings = loadSettings(dir);
  const file = path.join(dir, "settings.json");
  const seconds = fieldRange("max-seconds");
  const minutes = fieldRange("idle-unload");

  for (const [input, expected] of [
    [{ maxSeconds: -5, idle: -1 }, { maxSeconds: seconds.min, idle: minutes.min }],
    [{ maxSeconds: 99999, idle: 9999 }, { maxSeconds: seconds.max, idle: minutes.max }],
    [{ maxSeconds: seconds.min - 1, idle: minutes.max + 1 }, { maxSeconds: seconds.min, idle: minutes.max }],
    [{ maxSeconds: 420.6, idle: 2.4 }, { maxSeconds: 421, idle: 2 }],
    [{ maxSeconds: NaN, idle: Infinity }, { maxSeconds: 300, idle: 2 }],
    [{ maxSeconds: 300, idle: 0 }, { maxSeconds: 300, idle: 0 }],
  ]) {
    const next = { hotkey: "Kept", audio: { deviceId: "mic", maxRecordingSeconds: input.maxSeconds }, engines: { idleUnloadMinutes: input.idle } };
    const snapshot = JSON.stringify(next);
    const returned = settings.save(next);
    assert.deepStrictEqual(limits(returned), expected, JSON.stringify(input));
    assert.deepStrictEqual(limits(settings.get()), expected);
    assert.deepStrictEqual(limits(JSON.parse(fs.readFileSync(file, "utf8"))), expected);
    assert.strictEqual(returned.audio.deviceId, "mic");
    assert.strictEqual(returned.hotkey, "Kept");
    assert.strictEqual(JSON.stringify(next), snapshot, "save must not mutate its argument");
  }
  assert.deepStrictEqual(limits(settings.DEFAULTS), { maxSeconds: 300, idle: 2 });
});

test("a hand-edited settings file can't load an out-of-range limit", (t) => {
  const dir = makeSettingsDir(t);
  const file = path.join(dir, "settings.json");
  const raw = JSON.stringify({ hotkey: "Mine", audio: { maxRecordingSeconds: -5 }, engines: { idleUnloadMinutes: 99999 } });
  fs.writeFileSync(file, raw);
  const settings = loadSettings(dir);

  assert.deepStrictEqual(limits(settings.get()), { maxSeconds: 10, idle: 240 });
  assert.strictEqual(settings.get().hotkey, "Mine");
  // Validation, not a migration: loading never rewrites the user's file.
  assert.strictEqual(fs.readFileSync(file, "utf8"), raw);
  assert.deepStrictEqual(limits(settings.DEFAULTS), { maxSeconds: 300, idle: 2 });
});
