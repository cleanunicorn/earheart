// The settings commit path in main/ipc.js against the real settings module.
//
// Main-side writers (tray, updater, overlay drag, custom models) and the open
// Settings / wizard forms all save the same file. These tests load the real
// ipc.js + settings.js with Electron and the other neighbours stubbed (the
// require.cache pattern of ipc-models.test.js) and assert what reached disk.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ipcPath = require.resolve("../main/ipc");
const settingsPath = require.resolve("../main/settings");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(ipcPath)] });

function loadIpc(t, { remove = async () => {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-ipc-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = {};
  const calls = { broadcasts: [], trayRefresh: 0, historyCleared: 0, opened: [], closed: 0 };
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => userData, getVersion: () => "0.35.1" },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
      shell: {},
    },
    [resolveFrom("./engines")]: {
      registry: {
        setCustomModels() {},
        DEFAULT_STT_MODEL: "stt-default",
        DEFAULT_CLEANUP_MODEL: "cleanup-default",
      },
      remove,
      isInstalled: () => false,
    },
    [resolveFrom("./engines/registry")]: {
      DEFAULT_STT_MODEL: "stt-default",
      DEFAULT_CLEANUP_MODEL: "cleanup-default",
    },
    [resolveFrom("./windows")]: {
      sendToForms: (channel, payload) => calls.broadcasts.push({ channel, payload }),
      openSettings: (options) => calls.opened.push(options),
      closeWizard: () => {
        calls.closed += 1;
      },
    },
    [resolveFrom("./tray")]: {
      refresh: () => {
        calls.trayRefresh += 1;
      },
    },
    [resolveFrom("./history")]: {
      list: () => [],
      clear: () => {
        calls.historyCleared += 1;
      },
    },
    [resolveFrom("./services/route")]: {},
    [resolveFrom("./output/deliver")]: {},
    [resolveFrom("./autostart")]: { apply() {}, isEnabled: () => false },
    [resolveFrom("./updates")]: {},
    [resolveFrom("./util/logger")]: { info() {}, warn() {}, error() {} },
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
  delete require.cache[ipcPath];
  delete require.cache[settingsPath];
  let settings;
  try {
    settings = require(settingsPath);
    require(ipcPath).init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged() {},
    });
  } finally {
    delete require.cache[ipcPath];
    delete require.cache[settingsPath];
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  }
  const file = path.join(userData, "settings.json");
  return { handlers, settings, calls, readFile: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}

// What a form holds when it opens: the settings it spreads on save, and the
// shared values it last saw from main.
function openForm(settings) {
  const snapshot = settings.get();
  return {
    snapshot,
    baseline: { outputMode: snapshot.output.mode, remind: snapshot.updates.remind !== false },
  };
}

const customModel = { id: "custom-acme-foo", kind: "cleanup", label: "foo", custom: true };

// Every main-side write the issue lists, made while a form is open.
function writeMainSide(settings) {
  const save = (patch) => settings.save({ ...settings.get(), ...patch(settings.get()) });
  save((cur) => ({ updates: { ...cur.updates, skippedVersion: "0.34.0" } }));
  save((cur) => ({ updates: { ...cur.updates, lastSeenVersion: "0.34.0" } }));
  save((cur) => ({ updates: { ...cur.updates, remind: false } }));
  save((cur) => ({ output: { ...cur.output, mode: "clipboard" } }));
  save(() => ({ overlay: { x: 10, y: 20 } }));
  save(() => ({ customModels: [customModel] }));
}

for (const channel of ["settings:save", "wizard:complete"]) {
  // #190: the form save spread the snapshot taken when the window opened and
  // re-injected only `overlay`, rolling back every other main-side write.
  test(`${channel} keeps main-side writes made while the form was open`, (t) => {
    const { handlers, settings, readFile } = loadIpc(t);
    settings.save(settings.get());
    const { snapshot, baseline } = openForm(settings);
    writeMainSide(settings);

    const edited = { ...snapshot, history: { ...snapshot.history, enabled: false } };
    handlers[channel]({}, { settings: edited, baseline });

    const disk = readFile();
    assert.strictEqual(disk.updates.skippedVersion, "0.34.0");
    assert.strictEqual(disk.updates.lastSeenVersion, "0.34.0");
    assert.strictEqual(disk.updates.remind, false);
    assert.strictEqual(disk.output.mode, "clipboard");
    assert.deepStrictEqual(disk.overlay, { x: 10, y: 20 });
    assert.deepStrictEqual(disk.customModels, [customModel]);
    assert.strictEqual(disk.history.enabled, false, "the form's own edit still lands");
  });

  test(`${channel} applies a form change to a shared field main left alone`, (t) => {
    const { handlers, settings, readFile } = loadIpc(t);
    settings.save(settings.get());
    const { snapshot, baseline } = openForm(settings);

    const edited = {
      ...snapshot,
      output: { ...snapshot.output, mode: "paste-copy" },
      updates: { ...snapshot.updates, remind: false },
    };
    handlers[channel]({}, { settings: edited, baseline });

    assert.strictEqual(readFile().output.mode, "paste-copy");
    assert.strictEqual(readFile().updates.remind, false);
  });
}

test("a form that already reflects a main change can change it again", (t) => {
  const { handlers, settings, readFile } = loadIpc(t);
  settings.save(settings.get());
  writeMainSide(settings);
  // The form applied the settings:changed broadcast: its baseline is now the
  // main value, and the user picks something else.
  const { snapshot, baseline } = openForm(settings);
  const edited = { ...snapshot, output: { ...snapshot.output, mode: "paste" } };

  handlers["settings:save"]({}, { settings: edited, baseline });

  assert.strictEqual(readFile().output.mode, "paste");
});

test("a malformed save request is rejected without writing", (t) => {
  const { handlers, settings, readFile } = loadIpc(t);
  settings.save({ ...settings.get(), hotkey: "Kept" });

  assert.throws(() => handlers["settings:save"]({}, null), /settings request/);
  assert.throws(() => handlers["settings:save"]({}, { settings: "nope" }), /settings request/);
  assert.strictEqual(readFile().hotkey, "Kept");
});

test("every successful save broadcasts settings:changed and refreshes the tray", (t) => {
  const { settings, calls } = loadIpc(t);
  settings.save(settings.get());
  calls.broadcasts.length = 0;
  calls.trayRefresh = 0;

  const cur = settings.get();
  settings.save({ ...cur, output: { ...cur.output, mode: "clipboard" } });

  const changed = calls.broadcasts.filter((b) => b.channel === "settings:changed");
  assert.strictEqual(changed.length, 1);
  assert.strictEqual(changed[0].payload.previous.output.mode, "paste");
  assert.strictEqual(changed[0].payload.current.output.mode, "clipboard");
  assert.strictEqual(calls.trayRefresh, 1);

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    assert.throws(() => settings.save(settings.get()));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(calls.broadcasts.filter((b) => b.channel === "settings:changed").length, 1);
  assert.strictEqual(calls.trayRefresh, 1);
});

// #190: Clear history left "Copy last transcription" enabled (and silently
// doing nothing) because the tray was never rebuilt.
test("history:clear refreshes the tray", (t) => {
  const { handlers, calls } = loadIpc(t);
  calls.trayRefresh = 0;

  assert.deepStrictEqual(handlers["history:clear"](), []);
  assert.strictEqual(calls.historyCleared, 1);
  assert.strictEqual(calls.trayRefresh, 1);
});

// Same stale-snapshot shape across an await: removal read the settings before
// deleting the files, then saved that copy afterwards.
test("removing a custom model keeps settings written while its files were deleted", async (t) => {
  let finishRemove;
  const { handlers, settings, readFile } = loadIpc(t, {
    remove: () => new Promise((resolve) => (finishRemove = resolve)),
  });
  settings.save({ ...settings.get(), customModels: [customModel] });

  const pending = handlers["models:remove-custom"]({}, { modelId: customModel.id });
  settings.save({ ...settings.get(), overlay: { x: 10, y: 20 } });
  finishRemove();
  const result = await pending;

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(readFile().customModels, []);
  assert.deepStrictEqual(readFile().overlay, { x: 10, y: 20 });
});
