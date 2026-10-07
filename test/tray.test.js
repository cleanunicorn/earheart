// Behaviour of the tray menu in main/tray.js against the real settings module.
//
// tray.js requires Electron and its neighbours at load, so this uses the
// require.cache stubbing of ipc-models.test.js: Electron's Tray/Menu are fakes
// that capture the menu template, and settings.js is the real module writing to
// a temp userData directory, so the assertions read what reached the disk.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const trayPath = require.resolve("../main/tray");
const settingsPath = require.resolve("../main/settings");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(trayPath)] });

// Load the real tray.js + settings.js against fakes and init() the tray.
// `menus` collects every menu template the tray builds, newest last.
function loadTray(t, { historyEntries = [], stored } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-tray-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  if (stored) fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(stored));
  const menus = [];
  const warnings = [];
  const notifications = [];
  const entries = historyEntries;
  class FakeTray {
    on() {}
    setImage() {}
    setToolTip() {}
    setContextMenu(menu) {
      menus.push(menu);
    }
  }
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => userData },
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => template },
      Notification: class {
        constructor(options) {
          this.options = options;
        }
        show() {
          notifications.push(this.options);
        }
      },
      nativeImage: {
        createFromPath: () => ({ isEmpty: () => false }),
        createEmpty: () => ({}),
      },
      clipboard: { writeText() {} },
    },
    [resolveFrom("./windows")]: { openSettings() {} },
    [resolveFrom("./updates")]: { getState: () => ({ status: "idle" }) },
    [resolveFrom("./history")]: { list: () => entries },
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
  delete require.cache[trayPath];
  delete require.cache[settingsPath];
  let tray;
  let settings;
  try {
    settings = require(settingsPath);
    tray = require(trayPath);
  } finally {
    delete require.cache[trayPath];
    delete require.cache[settingsPath];
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  }
  const pipeline = { getState: () => "idle", onStateChange() {}, toggle() {}, cancel() {} };
  tray.init({ quit() {} }, pipeline);
  const file = path.join(userData, "settings.json");
  return { settings, menus, warnings, notifications, readFile: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

const item = (menu, label) => menu.find((entry) => entry.label === label);

const MODES = [
  ["Paste into active app", "paste"],
  ["Paste and keep on clipboard", "paste-copy"],
  ["Copy to clipboard only", "clipboard"],
];

const customModel = { id: "custom-acme-foo", kind: "cleanup", label: "foo", custom: true };

// #190: the radios used to save the settings object captured when the menu
// was built, so a click wiped anything saved since without a tray rebuild.
test("an output-mode click keeps settings written after the menu was built", (t) => {
  const { settings, menus, readFile } = loadTray(t);
  const staleMenu = menus.at(-1);
  // Written main-side without rebuilding the tray: an overlay drag and a
  // custom-model add.
  settings.save({ ...settings.get(), overlay: { x: 10, y: 20 } });
  settings.save({ ...settings.get(), customModels: [customModel] });

  for (const [label, mode] of [...MODES].reverse()) {
    item(staleMenu, label).click();
    const disk = readFile();
    assert.strictEqual(disk.output.mode, mode, label);
    assert.deepStrictEqual(disk.overlay, { x: 10, y: 20 }, label);
    assert.deepStrictEqual(disk.customModels, [customModel], label);
    assert.deepStrictEqual(settings.get(), disk, label);
  }
});

test("an output-mode click keeps updater bookkeeping written after the menu was built", (t) => {
  const { settings, menus, readFile } = loadTray(t);
  const staleMenu = menus.at(-1);
  const cur = settings.get();
  settings.save({ ...cur, updates: { ...cur.updates, skippedVersion: "0.34.0", lastSeenVersion: "0.35.0" } });

  item(staleMenu, "Copy to clipboard only").click();

  const disk = readFile();
  assert.strictEqual(disk.output.mode, "clipboard");
  assert.strictEqual(disk.updates.skippedVersion, "0.34.0");
  assert.strictEqual(disk.updates.lastSeenVersion, "0.35.0");
});

test("a failed output-mode save warns, keeps memory equal to disk and restores the radio", (t) => {
  const { settings, menus, warnings, notifications, readFile } = loadTray(t);
  settings.save({ ...settings.get(), output: { ...settings.get().output, mode: "paste" } });
  const builtBefore = menus.length;

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    assert.doesNotThrow(() => item(menus.at(-1), "Copy to clipboard only").click());
  } finally {
    fs.renameSync = originalRename;
  }

  assert.strictEqual(readFile().output.mode, "paste");
  assert.strictEqual(settings.get().output.mode, "paste");
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /simulated rename failure/);
  assert.ok(menus.length > builtBefore, "the menu is rebuilt from the persisted mode");
  assert.strictEqual(item(menus.at(-1), "Paste into active app").checked, true);
  assert.strictEqual(item(menus.at(-1), "Copy to clipboard only").checked, false);
  assert.strictEqual(notifications.length, 1, "the user is told the click didn't take");
  assert.match(notifications[0].title, /Could not change the output mode/);
});

test("Copy last transcription is disabled when the history is empty", (t) => {
  const { menus } = loadTray(t, { historyEntries: [] });
  assert.strictEqual(item(menus.at(-1), "Copy last transcription").enabled, false);
});

test("Copy last transcription is enabled when the history has an entry", (t) => {
  const { menus } = loadTray(t, { historyEntries: [{ text: "hello" }] });
  assert.strictEqual(item(menus.at(-1), "Copy last transcription").enabled, true);
});

// A profile from before the explicit paste-copy mode stores "paste & keep on
// clipboard" as { mode: "paste", restoreClipboard: false }. The tray used to
// check "Paste into active app" for it, and clicking that kept the old flag,
// so delivery went on keeping the transcript on the clipboard.
test("a legacy paste-and-keep profile shows as paste-copy and a paste click restores", (t) => {
  const { menus, readFile } = loadTray(t, {
    stored: { output: { mode: "paste", restoreClipboard: false } },
  });
  const legacyMenu = menus.at(-1);
  assert.strictEqual(item(legacyMenu, "Paste and keep on clipboard").checked, true);
  assert.strictEqual(item(legacyMenu, "Paste into active app").checked, false);

  item(legacyMenu, "Paste into active app").click();

  assert.deepStrictEqual(
    { mode: readFile().output.mode, restoreClipboard: readFile().output.restoreClipboard },
    { mode: "paste", restoreClipboard: true }
  );
});
