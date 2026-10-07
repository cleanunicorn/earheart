// Startup behaviour of main/updates.js init() against the real settings module.
//
// init() runs in main.js before the hotkeys register, so anything it throws
// leaves the app with no hotkeys. This loads the real updates.js + settings.js
// with Electron and the window/pipeline neighbours stubbed (the require.cache
// pattern of ipc-models.test.js) and a temp userData directory.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const updatesPath = require.resolve("../main/updates");
const settingsPath = require.resolve("../main/settings");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(updatesPath)] });

// The real feed helpers, except that any latest*.yml "parses" to `latest`.
function feedWith(latest) {
  const real = require("../main/services/update-feed");
  return {
    ...real,
    parseLatestYml: () => ({ version: latest, path: `Earheart-${latest}.AppImage`, sha512: "x" }),
  };
}

function loadUpdates(t, { stored, latest = "0.0.1" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-updates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "userData");
  const appPath = path.join(root, "app"); // no CHANGELOG.md: no notes to show
  fs.mkdirSync(userData);
  fs.mkdirSync(appPath);
  const file = path.join(userData, "settings.json");
  if (stored) fs.writeFileSync(file, JSON.stringify(stored));

  const warnings = [];
  const stubs = {
    [resolveFrom("electron")]: {
      app: {
        getPath: (name) => (name === "userData" ? userData : root),
        getVersion: () => "0.35.1",
        getAppPath: () => appPath,
        isPackaged: false,
      },
      Notification: class {},
      shell: {},
    },
    [resolveFrom("./windows")]: {
      broadcast() {},
      sendToOverlay() {},
      setOverlayPinned() {},
      hideOverlay() {},
      showOverlay() {},
    },
    [resolveFrom("./services/update-feed")]: feedWith(latest),
    [resolveFrom("./pipeline")]: { onStateChange() {}, getState: () => "idle" },
    [resolveFrom("./services/update-fetch")]: { fetchUpdateText: async () => "" },
    [resolveFrom("./util/mac-signature")]: { ensureMacSignature() {} },
    [resolveFrom("./engines/registry")]: {
      DEFAULT_STT_MODEL: "stt-default",
      DEFAULT_CLEANUP_MODEL: "cleanup-default",
    },
    [resolveFrom("./util/logger")]: {
      info() {},
      warn: (...args) => warnings.push(args.join(" ")),
      error() {},
    },
  };

  const previous = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    previous.set(p, require.cache[p]);
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = exports;
    require.cache[p] = m;
  }
  delete require.cache[updatesPath];
  delete require.cache[settingsPath];
  let updates;
  let settings;
  try {
    settings = require(settingsPath);
    updates = require(updatesPath);
  } finally {
    delete require.cache[updatesPath];
    delete require.cache[settingsPath];
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  }
  const feed = process.env.EARHEART_UPDATE_FEED;
  delete process.env.EARHEART_UPDATE_FEED; // dev install: no network checks
  t.after(() => {
    updates.dispose();
    if (feed !== undefined) process.env.EARHEART_UPDATE_FEED = feed;
  });
  const readFile = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  return { updates, settings, warnings, readFile };
}

const existingProfile = {
  overlay: { x: 10, y: 20 },
  updates: { lastSeenVersion: "0.34.0", skippedVersion: "0.33.0" },
};

const fullProfile = {
  hotkey: "CommandOrControl+Alt+X",
  overlay: { x: 10, y: 20 },
  updates: { remind: true, skippedVersion: "", lastSeenVersion: "0.35.1" },
};

// #190: armWhatsNew's save was unguarded, so EACCES/ENOSPC/EPERM on the first
// launch after an update aborted startup before the hotkeys registered.
test("init() survives a failing last-seen-version save", (t) => {
  const { updates, settings, warnings, readFile } = loadUpdates(t, { stored: existingProfile });

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error("EACCES: permission denied");
    err.code = "EACCES";
    throw err;
  };
  try {
    assert.doesNotThrow(() => updates.init({}));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.strictEqual(readFile().updates.lastSeenVersion, "0.34.0");
  assert.strictEqual(settings.get().updates.lastSeenVersion, "0.34.0");
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
});

test("init() records the running version and keeps the rest of the file", (t) => {
  const { updates, warnings, readFile } = loadUpdates(t, { stored: existingProfile });

  updates.init({});

  const disk = readFile();
  assert.strictEqual(disk.updates.lastSeenVersion, "0.35.1");
  assert.strictEqual(disk.updates.skippedVersion, "0.33.0");
  assert.deepStrictEqual(disk.overlay, { x: 10, y: 20 });
  assert.deepStrictEqual(warnings, []);
});

test("init() on a fresh profile does not create the settings file", (t) => {
  const { updates, readFile } = loadUpdates(t);

  updates.init({});

  assert.strictEqual(readFile(), null);
});

// #190 sweep: stopReminding and skipVersion edited a get() result before
// saving. They spread-save now; a partial save object would let
// deepMerge(DEFAULTS, …) reset every omitted key (overlay, hotkey, keys).
test("stopReminding saves remind: false and keeps the rest of the file", (t) => {
  const { updates, settings, readFile } = loadUpdates(t, { stored: fullProfile });
  updates.init({});

  updates.stopReminding();

  const disk = readFile();
  assert.strictEqual(disk.updates.remind, false);
  assert.strictEqual(disk.hotkey, fullProfile.hotkey);
  assert.deepStrictEqual(disk.overlay, fullProfile.overlay);
  assert.strictEqual(disk.updates.lastSeenVersion, "0.35.1");
  assert.deepStrictEqual(settings.get(), disk);
});

test("skipVersion saves the offered version and keeps the rest of the file", async (t) => {
  const { updates, settings, readFile } = loadUpdates(t, { stored: fullProfile, latest: "0.36.0" });
  updates.init({});
  await updates.check({ manual: true });
  assert.strictEqual(updates.getState().latest, "0.36.0");

  updates.skipVersion();

  const disk = readFile();
  assert.strictEqual(disk.updates.skippedVersion, "0.36.0");
  assert.strictEqual(disk.updates.remind, true);
  assert.strictEqual(disk.hotkey, fullProfile.hotkey);
  assert.deepStrictEqual(disk.overlay, fullProfile.overlay);
  assert.deepStrictEqual(settings.get(), disk);
});

test("skipVersion with nothing on offer leaves the file alone", (t) => {
  const { updates, readFile } = loadUpdates(t, { stored: fullProfile });
  updates.init({});
  const before = readFile();

  updates.skipVersion();

  assert.deepStrictEqual(readFile(), before);
});
