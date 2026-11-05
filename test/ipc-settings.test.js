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
const { withStubs } = require("./helpers/stub-modules");

const ipcPath = require.resolve("../main/ipc");
const settingsPath = require.resolve("../main/settings");
const recordingsPath = require.resolve("../main/recordings");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(ipcPath)] });

// `realHistory` loads the real main/history.js against this test's userData
// instead of the stub, for the handlers that search and delete entries.
function loadIpc(t, { remove = async () => {}, canCorrect = () => true, canCopy = canCorrect, clearResult = { ok: true }, realHistory = false, safeStorage = null, saveDialog = async () => ({ canceled: true }), retranscribe } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-ipc-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const handlers = {};
  const calls = { broadcasts: [], trayRefresh: 0, historyCleared: 0, deliveries: [], entriesDeleted: [], corrections: [] };
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => userData, getVersion: () => "0.35.1", isReady: () => true },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
      shell: {},
      safeStorage,
      dialog: { showSaveDialog: (win, opts) => saveDialog(opts) },
      BrowserWindow: { fromWebContents: () => null },
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
      openCorrection: (entry) => calls.corrections.push(entry),
      setCorrectionDirty() {},
      closeWizard() {},
      sendToSettings: (channel, payload) => calls.broadcasts.push({ channel, payload }),
    },
    [resolveFrom("./tray")]: {
      refresh: () => {
        calls.trayRefresh += 1;
      },
    },
    [resolveFrom("./history")]: {
      list: () => [],
      isValidId: () => true,
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

  const historyPath = resolveFrom("./history");
  if (realHistory) delete stubs[historyPath];
  const savedHistory = require.cache[historyPath];
  let settings;
  let history;
  let recordings;
  try {
    withStubs(stubs, [ipcPath, settingsPath, recordingsPath, ...(realHistory ? [historyPath] : [])], () => {
      settings = require(settingsPath);
      require(ipcPath).init({
        applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
        onSettingsChanged() {},
        canCorrect,
        canCopy,
        onHistoryCleared: () => { calls.undeliveredCleared = (calls.undeliveredCleared || 0) + 1; },
        onHistoryEntryDeleted: (entry) => calls.entriesDeleted.push(entry),
        ...(retranscribe ? { retranscribe } : {}),
      });
      if (realHistory) history = require.cache[historyPath].exports;
      recordings = require.cache[recordingsPath].exports;
    });
  } finally {
    // withStubs drops the fresh real history; put back whatever was cached before.
    if (realHistory && savedHistory) require.cache[historyPath] = savedHistory;
  }
  const file = path.join(userData, "settings.json");
  return { handlers, settings, calls, history, recordings, userData, readFile: () => JSON.parse(fs.readFileSync(file, "utf8")) };
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
      ["aliases", "customModels", "dictionary", "output", "overlay", "updates"],
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
  // #291: a transcript held back from a paste is history too.
  assert.strictEqual(calls.undeliveredCleared, 1);
});

// #287: a failed delete reached Settings as success.
test("history:clear hands a failed delete back to Settings", (t) => {
  const failed = { ok: false, error: "EPERM" };
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

test("remember with heard words saves the spelling and its alias together", async (t) => {
  const { handlers, readFile } = loadIpc(t);
  const result = await handlers["correction:remember"]({}, { spelling: "Earheart", heard: "air heart" });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.alias, true);
  assert.deepStrictEqual(readFile().cleanup.dictionary, ["Earheart"]);
  assert.deepStrictEqual(readFile().cleanup.aliases, [{ term: "Earheart", heard: ["air heart"] }]);
  const plain = await handlers["correction:remember"]({}, { spelling: "kubectl" });
  assert.strictEqual(plain.alias, false);
  assert.deepStrictEqual(readFile().cleanup.aliases, [{ term: "Earheart", heard: ["air heart"] }]);
});

test("remember refuses an alias another term owns and saves nothing", async (t) => {
  const { handlers, readFile } = loadIpc(t);
  await handlers["correction:remember"]({}, { spelling: "Earheart", heard: "air heart" });
  const before = readFile().cleanup;
  const result = await handlers["correction:remember"]({}, { spelling: "Airheart", heard: "Air Heart" });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /already becomes “Earheart”/);
  assert.deepStrictEqual(readFile().cleanup.dictionary, before.dictionary, "the spelling is not saved either");
  assert.deepStrictEqual(readFile().cleanup.aliases, before.aliases);
  for (const bad of [{ spelling: "x -> y", heard: "air" }, { spelling: "x", heard: 5 }, { spelling: "x", heard: "a\nb" }, { spelling: "x", heard: "" }]) {
    assert.strictEqual((await handlers["correction:remember"]({}, bad)).ok, false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(readFile().cleanup.aliases, before.aliases);
});

test("an alias remembered while Settings is open survives its stale save with independent edits", async (t) => {
  const { settings, handlers, readFile } = loadIpc(t);
  settings.save({ ...settings.get(), cleanup: { ...settings.get().cleanup, aliases: [{ term: "Earheart", heard: ["air heart", "old"] }] } });
  const snapshot = settings.get();
  const baseline = require("../renderer/settings-sync").sharedBaseline(snapshot);
  assert.strictEqual((await handlers["correction:remember"]({}, { spelling: "kubectl", heard: "cube cuddle" })).ok, true);
  snapshot.cleanup.aliases = [{ term: "Earheart", heard: ["air heart", "ear heart"] }];
  await handlers["settings:save"]({}, { settings: snapshot, baseline });
  assert.deepStrictEqual(readFile().cleanup.aliases, [
    { term: "Earheart", heard: ["air heart", "ear heart"] },
    { term: "kubectl", heard: ["cube cuddle"] },
  ]);
});

test("a stale Settings save that conflicts with a remembered alias fails and keeps it", async (t) => {
  const { settings, handlers, readFile } = loadIpc(t);
  const snapshot = settings.get();
  const baseline = require("../renderer/settings-sync").sharedBaseline(snapshot);
  assert.strictEqual((await handlers["correction:remember"]({}, { spelling: "Other", heard: "Earheart" })).ok, true);
  snapshot.cleanup.aliases = [{ term: "Earheart", heard: ["air heart"] }];
  await assert.rejects(async () => handlers["settings:save"]({}, { settings: snapshot, baseline }), /Always replace was not saved/);
  assert.deepStrictEqual(readFile().cleanup.aliases, [{ term: "Other", heard: ["Earheart"] }]);
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


// #68: with "Deliver as one line" on, a copy is one line too — it is how a
// corrected prompt reaches a terminal agent.
test("transcript copies follow Deliver as one line", async (t) => {
  const { handlers, settings, calls } = loadIpc(t);
  settings.save({ ...settings.get(), output: { ...settings.get().output, singleLine: true } });
  await handlers["transcript:copy"]({}, "first part\n\nsecond part");
  assert.deepStrictEqual(calls.deliveries.at(-1), { text: "first part second part", cfg: { mode: "clipboard" } });
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
  const { handlers, calls, history } = loadIpc(t, { realHistory: true });
  history.add({ text: "saved words" }, { enabled: true, limit: 100 });
  const [entry] = history.list();
  // Matching words and timestamp are not enough any more: only the entry id.
  for (const request of [{ text: entry.text, at: entry.at }, { id: "missing" }, { id: 42 }, null]) {
    const result = await handlers["correction:open"]({}, request);
    assert.strictEqual(result.ok, false, JSON.stringify(request));
    assert.match(result.error, /no longer in History/);
  }
  assert.deepStrictEqual(calls.corrections, []);
});

test("correction:open opens the saved History entry with that id", async (t) => {
  const { handlers, calls, history } = loadIpc(t, { realHistory: true });
  const id = history.add({ text: "fix my spelling" }, { enabled: true, limit: 100 });
  assert.deepStrictEqual(await handlers["correction:open"]({}, { id, text: "forged words" }), { ok: true });
  assert.deepStrictEqual(calls.corrections.map((entry) => entry.text), ["fix my spelling"]);
});

/* ---- History search and single delete (#342) ---- */

const HISTORY_CFG = { enabled: true, limit: 100 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("history:search answers one filtered page from saved History", async (t) => {
  const { handlers, history } = loadIpc(t, { realHistory: true });
  for (const text of ["deploy the app", "write the tests", "deploy again"]) history.add({ text }, HISTORY_CFG);
  const result = await handlers["history:search"]({}, { query: "DEPLOY", offset: 0, limit: 1 });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.entries.map((entry) => entry.text), ["deploy again"]);
  assert.deepStrictEqual([result.total, result.offset, result.limit, result.all], [2, 0, 1, 3]);
  const everything = await handlers["history:search"]({});
  assert.strictEqual(everything.total, 3, "no request means the whole list");
});

test("history:search refuses a malformed request instead of guessing", async (t) => {
  const { handlers } = loadIpc(t, { realHistory: true });
  for (const request of [null, "deploy", 5, { query: 5 }, { query: ["deploy"] }]) {
    const result = await handlers["history:search"]({}, request);
    assert.strictEqual(result.ok, false, JSON.stringify(request));
    assert.strictEqual(typeof result.error, "string");
  }
});

test("history:delete removes one entry, refreshes the tray and drops its held-back copy", async (t) => {
  const { handlers, calls, history, userData } = loadIpc(t, { realHistory: true });
  history.add({ text: "older" }, HISTORY_CFG);
  const id = history.add({ text: "private" }, HISTORY_CFG);
  history.add({ text: "newer" }, HISTORY_CFG);
  calls.trayRefresh = 0;

  assert.deepStrictEqual(handlers["history:delete"]({}, id), { ok: true, removed: true });
  assert.deepStrictEqual(history.list().map((entry) => entry.text), ["newer", "older"]);
  assert.strictEqual(calls.trayRefresh, 1, "Copy last transcription must not offer deleted words");
  assert.deepStrictEqual(calls.entriesDeleted, [id], "the held-back copy is matched by entry id");
  await settle();
  const saved = JSON.parse(fs.readFileSync(path.join(userData, "history.json"), "utf8"));
  assert.deepStrictEqual(saved.map((entry) => entry.text), ["newer", "older"]);
});

test("history:delete refuses an id that is not one, and an unknown id deletes nothing", async (t) => {
  const { handlers, calls, history } = loadIpc(t, { realHistory: true });
  history.add({ text: "keep me" }, HISTORY_CFG);
  calls.trayRefresh = 0;
  for (const id of [undefined, null, 42, "", "../history", "x".repeat(65), { id: "x" }]) {
    assert.deepStrictEqual(handlers["history:delete"]({}, id), { ok: false, error: "EINVAL" }, JSON.stringify(id));
  }
  assert.deepStrictEqual(handlers["history:delete"]({}, "no-such-entry"), { ok: true, removed: false });
  assert.deepStrictEqual(history.list().map((entry) => entry.text), ["keep me"]);
  assert.strictEqual(calls.trayRefresh, 0);
  assert.deepStrictEqual(calls.entriesDeleted, []);
});

test("history:delete hands a failed write back to Settings and keeps the entry", async (t) => {
  const { handlers, calls, history } = loadIpc(t, { realHistory: true });
  const id = history.add({ text: "still here" }, HISTORY_CFG);
  await settle();
  calls.trayRefresh = 0;
  const original = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("EPERM: simulated"), { code: "EPERM" });
  };
  let result;
  try {
    result = handlers["history:delete"]({}, id);
  } finally {
    fs.renameSync = original;
  }
  assert.deepStrictEqual(result, { ok: false, error: "EPERM" });
  assert.deepStrictEqual(history.list().map((entry) => entry.text), ["still here"]);
  assert.deepStrictEqual(calls.entriesDeleted, [], "a held-back copy stays when the entry does");
  assert.strictEqual(calls.trayRefresh, 0);
});

test("copying is allowed while recording even though correction cannot open", async (t) => {
  const { handlers, calls } = loadIpc(t, { canCorrect: () => false, canCopy: () => true });
  assert.strictEqual((await handlers["transcript:copy"]({}, "previous prompt")).ok, true);
  assert.strictEqual(calls.deliveries.length, 1);
});

test("cleanup:prompt-offer saves the answer at once and is not offered again", async (t) => {
  const { handlers, settings, readFile } = loadIpc(t);
  const own = "My own rules.";
  settings.save({ ...settings.get(), cleanup: { ...settings.get().cleanup, systemPrompt: own } });
  const offer = settings.cleanupPromptOffer(settings.get());
  assert.strictEqual(offer.kind, "custom");

  const kept = await handlers["cleanup:prompt-offer"]({}, { decision: "keep" });
  assert.deepStrictEqual(kept, { ok: true, systemPrompt: own, promptOfferDecided: offer.id });
  assert.strictEqual(readFile().cleanup.systemPrompt, own);
  assert.strictEqual(settings.cleanupPromptOffer(settings.get()), null);

  // "use" switches to the new default.
  settings.save({ ...settings.get(), cleanup: { ...settings.get().cleanup, promptOfferDecided: "" } });
  const used = await handlers["cleanup:prompt-offer"]({}, { decision: "use" });
  assert.strictEqual(used.systemPrompt, settings.DEFAULTS.cleanup.systemPrompt);
  assert.strictEqual(readFile().cleanup.systemPrompt, settings.DEFAULTS.cleanup.systemPrompt);

  const bad = await handlers["cleanup:prompt-offer"]({}, { decision: "maybe" });
  assert.strictEqual(bad.ok, false);
});

/* ---- Kept recordings (#343) ---- */

function keyring() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (text) => Buffer.from(`k:${text}`),
    decryptString: (buf) => buf.toString().slice(2),
  };
}

const LIMITS = { maxAgeDays: 30, maxMegabytes: 1024 };
const WAV = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt fake audio");

function withRecording(t, opts = {}) {
  const rig = loadIpc(t, { realHistory: true, safeStorage: keyring(), ...opts });
  const id = rig.history.add({ text: "kept words" }, HISTORY_CFG);
  const other = rig.history.add({ text: "no audio" }, HISTORY_CFG);
  assert.deepStrictEqual(rig.recordings.getStore().save(id, WAV, { limits: LIMITS }), { ok: true });
  return { ...rig, id, other, file: path.join(rig.userData, "audio", `${id}.wav.enc`) };
}

test("history:search marks which entries have a kept recording", async (t) => {
  const { handlers, id, other, file } = withRecording(t);
  let result = await handlers["history:search"]({}, {});
  assert.strictEqual(result.entries.find((e) => e.id === id).audio, "kept");
  assert.strictEqual("audio" in result.entries.find((e) => e.id === other), false);
  // A file in a format this build can't read is marked unreadable up front.
  const bytes = fs.readFileSync(file);
  bytes[4] = 9;
  fs.writeFileSync(file, bytes);
  result = await handlers["history:search"]({}, {});
  assert.strictEqual(result.entries.find((e) => e.id === id).audio, "unreadable");
});

test("history:audio-get returns the original WAV, and only for an entry in History", async (t) => {
  const { handlers, id, other } = withRecording(t);
  const got = await handlers["history:audio-get"]({}, id);
  assert.strictEqual(got.ok, true);
  assert.ok(Buffer.from(got.wav).equals(WAV));
  assert.deepStrictEqual(await handlers["history:audio-get"]({}, other), { ok: false, error: "missing" });
  assert.deepStrictEqual(await handlers["history:audio-get"]({}, "../../etc"), { ok: false, error: "missing" });
  assert.deepStrictEqual(await handlers["history:audio-get"]({}, "4a1b2c3d-0000-4000-8000-000000000000"), { ok: false, error: "missing" });
});

test("history:audio-get reports damaged audio as unreadable", async (t) => {
  const { handlers, id, file } = withRecording(t);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.deepStrictEqual(await handlers["history:audio-get"]({}, id), { ok: false, error: "unreadable" });
});

test("history:audio-export saves the original WAV where the user picks; cancel writes nothing", async (t) => {
  let answer = { canceled: true };
  const asked = [];
  const { handlers, id, other, userData } = withRecording(t, { saveDialog: async (opts) => { asked.push(opts); return answer; } });
  assert.deepStrictEqual(await handlers["history:audio-export"]({ sender: {} }, id), { ok: false, cancelled: true });
  assert.match(asked[0].defaultPath, /earheart-.*\.wav$/);
  const dest = path.join(userData, "export.wav");
  assert.strictEqual(fs.existsSync(dest), false);
  answer = { canceled: false, filePath: dest };
  assert.deepStrictEqual(await handlers["history:audio-export"]({ sender: {} }, id), { ok: true });
  assert.ok(fs.readFileSync(dest).equals(WAV));
  // Nothing to export: answered before any dialog.
  asked.length = 0;
  assert.deepStrictEqual(await handlers["history:audio-export"]({ sender: {} }, other), { ok: false, error: "missing" });
  assert.strictEqual(asked.length, 0);
  // A destination that can't be written says so.
  answer = { canceled: false, filePath: path.join(userData, "no-such-dir", "x.wav") };
  assert.deepStrictEqual(await handlers["history:audio-export"]({ sender: {} }, id), { ok: false, error: "ENOENT" });
});

test("history:delete removes the entry's kept recording too", async (t) => {
  const { handlers, id, file, recordings } = withRecording(t);
  assert.ok(fs.existsSync(file));
  assert.deepStrictEqual(handlers["history:delete"]({}, id), { ok: true, removed: true });
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(recordings.getStore().status().count, 0);
});

test("history:clear removes every kept recording and the key", async (t) => {
  const { handlers, userData } = withRecording(t);
  assert.deepStrictEqual(handlers["history:clear"](), { ok: true });
  assert.deepStrictEqual(fs.readdirSync(path.join(userData, "audio")), []);
});

test("recordings:status and recordings:clear: History text stays", async (t) => {
  const { handlers, history, calls } = withRecording(t);
  const status = await handlers["recordings:status"]();
  assert.strictEqual(status.secure, true);
  assert.strictEqual(status.count, 1);
  assert.strictEqual(status.key, "ok");
  assert.deepStrictEqual(await handlers["recordings:clear"](), { ok: true });
  assert.strictEqual((await handlers["recordings:status"]()).count, 0);
  assert.strictEqual(history.list().length, 2);
  // An update to listed entries: Settings keeps its page (review b-5).
  assert.deepStrictEqual(calls.broadcasts.filter((b) => b.channel === "history:changed"), [
    { channel: "history:changed", payload: { updated: true } },
  ]);
});

test("recordings:status says why without secure storage", async (t) => {
  const { handlers } = loadIpc(t, { realHistory: true, safeStorage: { ...keyring(), getSelectedStorageBackend: () => "basic_text", isEncryptionAvailable: () => false } });
  const status = await handlers["recordings:status"]();
  assert.strictEqual(status.secure, false);
  assert.match(status.reason, /can't be encrypted/);
});

test("history:retranscribe hands a valid id to the pipeline and refuses anything else", async (t) => {
  const seen = [];
  const { handlers } = loadIpc(t, { realHistory: true, retranscribe: async (id) => { seen.push(id); return { ok: true, stored: true }; } });
  const id = "4a1b2c3d-0000-4000-8000-000000000000";
  assert.deepStrictEqual(await handlers["history:retranscribe"]({}, id), { ok: true, stored: true });
  assert.deepStrictEqual(await handlers["history:retranscribe"]({}, "../x"), { ok: false, error: "missing" });
  assert.deepStrictEqual(seen, [id]);
});

// #348: Appearance is edited only in Settings, but the wizard's save spreads
// the snapshot it opened with. A stale wizard completing after Settings saved
// Light must not put the old appearance back.
test("a stale wizard does not overwrite an appearance saved in Settings", (t) => {
  const { sharedBaseline } = require("../renderer/settings-sync");
  const { handlers, settings, readFile } = loadIpc(t);
  settings.save(settings.get());
  // Both forms open on the same snapshot, with the baseline the pages send.
  const wizard = settings.get();
  const wizardBaseline = sharedBaseline(wizard);
  const editor = settings.get();
  assert.strictEqual(wizardBaseline.appearance, "system");

  handlers["settings:save"]({}, { settings: { ...editor, appearance: "light" }, baseline: sharedBaseline(editor) });
  assert.strictEqual(readFile().appearance, "light");

  const reply = handlers["wizard:complete"]({}, { settings: { ...wizard, hotkey: "F9" }, baseline: wizardBaseline });
  assert.strictEqual(readFile().appearance, "light", "the live appearance wins over the wizard's stale copy");
  assert.strictEqual(reply.settings.appearance, "light");
  assert.strictEqual(readFile().hotkey, "F9", "the wizard's own edit still lands");

  // And Settings can still change it: its baseline matches the live value.
  const again = settings.get();
  handlers["settings:save"]({}, { settings: { ...again, appearance: "dark" }, baseline: sharedBaseline(again) });
  assert.strictEqual(readFile().appearance, "dark");
});
