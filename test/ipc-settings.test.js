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

function loadIpc(t, { remove = async () => {}, canCorrect = () => true, canCopy = canCorrect, clearResult = { ok: true } } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-ipc-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = {};
  const calls = { broadcasts: [], trayRefresh: 0, historyCleared: 0, deliveries: [] };
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => userData, getVersion: () => "0.35.1" },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
      shell: {},
    },
    [resolveFrom("./engines")]: {
      registry: {
        setCustomModels() {},
        getModel: () => customModel,
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
      openSettings() {},
      setCorrectionDirty() {},
      closeWizard() {},
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
        return clearResult;
      },
    },
    [resolveFrom("./services/route")]: {},
    [resolveFrom("./output/deliver")]: { deliver: async (text, cfg) => { calls.deliveries.push({ text, cfg }); return { method: "clipboard" }; } },
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
      canCorrect,
      canCopy,
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
    const reply = handlers[channel]({}, { settings: edited, baseline });

    // The reply carries what was saved, which the form then shows.
    assert.strictEqual(reply.settings.output.mode, "clipboard");
    assert.strictEqual(reply.settings.updates.remind, false);
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

// The legacy { mode: "paste", restoreClipboard: false } encoding behaves as
// paste-copy. A tray click that retires it to real paste changes only
// restoreClipboard, so main must compare modes as delivery sees them or the
// open form's stale paste-copy wins.
test("a form save keeps a tray click that retired the legacy paste-copy encoding", (t) => {
  const { handlers, settings, readFile } = loadIpc(t);
  const legacy = settings.get();
  settings.save({ ...legacy, output: { ...legacy.output, mode: "paste", restoreClipboard: false } });
  const snapshot = settings.get();
  const baseline = { outputMode: "paste-copy", remind: true }; // what the form shows
  const cur = settings.get();
  settings.save({ ...cur, output: { ...cur.output, mode: "paste", restoreClipboard: true } });

  // The form never touched its radio: it still shows (and sends) paste-copy.
  const stale = { ...snapshot, output: { ...snapshot.output, mode: "paste-copy", restoreClipboard: true } };
  handlers["settings:save"]({}, { settings: stale, baseline });

  assert.strictEqual(readFile().output.mode, "paste");
  assert.strictEqual(readFile().output.restoreClipboard, true);
});

for (const channel of ["settings:save", "wizard:complete"]) {
  test(`a malformed ${channel} request is rejected without writing`, (t) => {
    const { handlers, settings, readFile } = loadIpc(t);
    settings.save({ ...settings.get(), hotkey: "Kept" });

    assert.throws(() => handlers[channel]({}, null), /settings request/);
    assert.throws(() => handlers[channel]({}, { settings: "nope" }), /settings request/);
    assert.strictEqual(readFile().hotkey, "Kept");
  });
}

// A baseline value of the wrong type is not something the form saw from main,
// so it must not let main overwrite the form's choice; a well-typed field next
// to it still reconciles.
test("baseline fields of the wrong type leave the form's value in place", (t) => {
  const { handlers, settings, readFile } = loadIpc(t);
  settings.save(settings.get());
  const { snapshot } = openForm(settings);
  writeMainSide(settings); // main: mode clipboard, remind false

  const edited = {
    ...snapshot,
    output: { ...snapshot.output, mode: "paste-copy" },
    updates: { ...snapshot.updates, remind: true },
  };
  handlers["settings:save"]({}, { settings: edited, baseline: { outputMode: 7, remind: "yes" } });
  assert.strictEqual(readFile().output.mode, "paste-copy");
  assert.strictEqual(readFile().updates.remind, true);

  writeMainSide(settings);
  handlers["settings:save"]({}, { settings: edited, baseline: { outputMode: "paste", remind: "yes" } });
  assert.strictEqual(readFile().output.mode, "clipboard", "the well-typed field still reconciles");
  assert.strictEqual(readFile().updates.remind, true);
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
  // Only what the forms apply; API keys stay out of the event.
  for (const side of ["previous", "current"]) {
    assert.deepStrictEqual(
      Object.keys(changed[0].payload[side]).sort(),
      ["customModels", "dictionary", "output", "overlay", "updates"],
      side
    );
  }
  assert.doesNotMatch(JSON.stringify(changed[0].payload), /apiKey/);
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

  assert.deepStrictEqual(handlers["history:clear"](), { ok: true });
  assert.strictEqual(calls.historyCleared, 1);
  assert.strictEqual(calls.trayRefresh, 1);
});

// #287: a failed delete reached Settings as success.
test("history:clear hands a failed delete back to Settings", (t) => {
  const failed = { ok: false, error: "EPERM: operation not permitted" };
  const { handlers } = loadIpc(t, { clearResult: failed });
  assert.deepStrictEqual(handlers["history:clear"](), failed);
});

// Same stale-snapshot shape across an await: removal read the settings before
// deleting the files, then saved that copy afterwards.
test("removing a custom model keeps settings written while its files were deleted", async (t) => {
  let finishRemove;
  let beginRemove;
  const removing = new Promise((resolve) => (beginRemove = resolve));
  const { handlers, settings, readFile } = loadIpc(t, {
    remove: () => new Promise((resolve) => {
      finishRemove = resolve;
      beginRemove();
    }),
  });
  settings.save({ ...settings.get(), customModels: [customModel] });

  const pending = handlers["models:remove-custom"]({}, { modelId: customModel.id });
  await removing;
  settings.save({ ...settings.get(), overlay: { x: 10, y: 20 } });
  finishRemove();
  const result = await pending;

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(readFile().customModels, []);
  assert.deepStrictEqual(readFile().overlay, { x: 10, y: 20 });
});

test("remembered spellings survive a stale Settings save with independent dictionary edits", async (t) => {
  const { settings, handlers, readFile } = loadIpc(t);
  settings.save({ ...settings.get(), cleanup: { ...settings.get().cleanup, dictionary: ["remove", "keep"] } });
  const snapshot = settings.get();
  const baseline = require("../renderer/settings-sync").sharedBaseline(snapshot);
  assert.strictEqual((await handlers["correction:remember"]({}, "kubectl")).ok, true);
  snapshot.cleanup.dictionary = ["keep", "typed"];
  await handlers["settings:save"]({}, { settings: snapshot, baseline });
  assert.deepStrictEqual(readFile().cleanup.dictionary, ["keep", "kubectl", "typed"]);
});

test("remember failure preserves existing dictionary and reports failure", async (t) => {
  const { settings, handlers } = loadIpc(t);
  const before = settings.get().cleanup.dictionary;
  const originalSave = settings.save;
  settings.save = () => { throw new Error("disk full"); };
  try {
    assert.deepStrictEqual(await handlers["correction:remember"]({}, "kubectl"), { ok: false, error: "disk full" });
  } finally { settings.save = originalSave; }
  assert.deepStrictEqual(settings.get().cleanup.dictionary, before);
});


test("explicit transcript copies use clipboard-only delivery and reject invalid payloads", async (t) => {
  const { handlers, calls } = loadIpc(t);
  assert.deepStrictEqual(await handlers["transcript:copy"]({}, "corrected prompt"), { ok: true });
  assert.deepStrictEqual(calls.deliveries, [{ text: "corrected prompt", cfg: { mode: "clipboard" } }]);
  for (const value of [null, {}, " ", "x".repeat(1000001)]) {
    assert.strictEqual((await handlers["transcript:copy"]({}, value)).ok, false);
  }
  assert.strictEqual(calls.deliveries.length, 1);
});

test("correction and copying cannot interrupt an active dictation", async (t) => {
  const { handlers, calls } = loadIpc(t, { canCorrect: () => false });
  for (const channel of ["correction:open", "transcript:copy"]) {
    const result = await handlers[channel]({}, "text");
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /current dictation/);
  }
  assert.strictEqual(calls.deliveries.length, 0);
});


test("an unavailable History entry cannot open a correction while idle", async (t) => {
  const { handlers } = loadIpc(t);
  const result = await handlers["correction:open"]({}, { text: "forged", at: "missing" });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no longer in History/);
});

test("copying is allowed while recording even though correction cannot open", async (t) => {
  const { handlers, calls } = loadIpc(t, { canCorrect: () => false, canCopy: () => true });
  assert.strictEqual((await handlers["transcript:copy"]({}, "previous prompt")).ok, true);
  assert.strictEqual(calls.deliveries.length, 1);
});
