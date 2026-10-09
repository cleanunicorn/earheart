const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Warnings settings.js logs (e.g. a throwing change listener), captured instead
// of written to a real log file.
const warnings = [];

function loadSettings(userData) {
  const settingsPath = require.resolve("../main/settings");
  const electronPath = require.resolve("electron");
  const registryPath = require.resolve("../main/engines/registry");
  const loggerPath = require.resolve("../main/util/logger");
  const savedElectron = require.cache[electronPath];
  const savedRegistry = require.cache[registryPath];
  const savedLogger = require.cache[loggerPath];

  const logger = new Module(loggerPath, null);
  logger.filename = loggerPath;
  logger.loaded = true;
  logger.exports = { info() {}, warn: (...args) => warnings.push(args.join(" ")), error() {} };
  require.cache[loggerPath] = logger;

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
  if (savedLogger) require.cache[loggerPath] = savedLogger;
  else delete require.cache[loggerPath];
  return settings;
}

// A temp userData directory that is removed when the test ends.
function makeSettingsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Replace fs.renameSync with a failing stub for the duration of `fn`.
function withFailingRename(fn) {
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    return fn();
  } finally {
    fs.renameSync = originalRename;
  }
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

  assert.throws(() => withFailingRename(() => settings.save({ hotkey: "Broken" })), /rename failure/);

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

function readFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
}

// #190: get() used to hand out the live cache, so a caller that edited it and
// then failed to save left memory disagreeing with the file.
test("a failed save after editing a get() result leaves memory equal to the file", (t) => {
  const dir = makeSettingsDir(t);
  const settings = loadSettings(dir);
  settings.save({ ...settings.get(), output: { ...settings.get().output, mode: "paste" } });

  const cfg = settings.get();
  cfg.output.mode = "clipboard";
  cfg.updates.lastSeenVersion = "9.9.9";
  assert.throws(() => withFailingRename(() => settings.save(cfg)), /rename failure/);

  assert.deepStrictEqual(settings.get(), readFile(dir));
  assert.strictEqual(settings.get().output.mode, "paste");
});

test("get() before the first save does not expose DEFAULTS", (t) => {
  const settings = loadSettings(makeSettingsDir(t));

  const cfg = settings.get();
  cfg.updates.lastSeenVersion = "9.9.9";
  cfg.customModels.push({ id: "leaked" });
  cfg.output.mode = "clipboard";

  assert.strictEqual(settings.DEFAULTS.updates.lastSeenVersion, "");
  assert.deepStrictEqual(settings.DEFAULTS.customModels, []);
  assert.strictEqual(settings.DEFAULTS.output.mode, "paste");
  assert.strictEqual(settings.get().updates.lastSeenVersion, "");
  assert.deepStrictEqual(settings.get().customModels, []);
  assert.notStrictEqual(settings.get(), settings.get());
  assert.notStrictEqual(settings.get().output, settings.get().output);
});

test("save() neither keeps its input nor hands out the cache", (t) => {
  const settings = loadSettings(makeSettingsDir(t));
  const input = { overlay: { x: 1, y: 2 }, customModels: [{ id: "m" }] };

  const saved = settings.save(input);
  input.overlay.x = 99;
  input.customModels[0].id = "changed";
  saved.overlay.y = 99;
  saved.customModels.push({ id: "extra" });

  assert.deepStrictEqual(settings.get().overlay, { x: 1, y: 2 });
  assert.deepStrictEqual(settings.get().customModels, [{ id: "m" }]);
});

test("onChanged reports each successful save with detached snapshots", (t) => {
  const settings = loadSettings(makeSettingsDir(t));
  settings.save({ hotkey: "First" });
  const events = [];
  const unsubscribe = settings.onChanged((event) => events.push(event));

  settings.save({ ...settings.get(), hotkey: "Second" });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].previous.hotkey, "First");
  assert.strictEqual(events[0].current.hotkey, "Second");
  events[0].current.hotkey = "Mutated";
  assert.strictEqual(settings.get().hotkey, "Second");

  assert.throws(() => withFailingRename(() => settings.save({ hotkey: "Broken" })));
  assert.strictEqual(events.length, 1, "a failed save notifies nobody");

  unsubscribe();
  settings.save({ hotkey: "Third" });
  assert.strictEqual(events.length, 1);
});

test("a throwing change listener does not fail a save that reached disk", (t) => {
  const dir = makeSettingsDir(t);
  const settings = loadSettings(dir);
  const seen = [];
  settings.onChanged(() => {
    throw new Error("listener blew up");
  });
  settings.onChanged(({ current }) => seen.push(current.hotkey));
  warnings.length = 0;

  settings.save({ hotkey: "Saved" });

  assert.strictEqual(readFile(dir).hotkey, "Saved");
  assert.strictEqual(settings.get().hotkey, "Saved");
  assert.deepStrictEqual(seen, ["Saved"]);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /listener blew up/);
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
    [{ maxSeconds: NaN, idle: Infinity }, { maxSeconds: 600, idle: 2 }],
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
  assert.deepStrictEqual(limits(settings.DEFAULTS), { maxSeconds: 600, idle: 2 });
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
  assert.deepStrictEqual(limits(settings.DEFAULTS), { maxSeconds: 600, idle: 2 });
});
