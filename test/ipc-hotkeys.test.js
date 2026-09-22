// Hotkey application and persistence form one transaction across the Settings
// and wizard IPC handlers. This loads the real handlers against capturing
// neighbours, following the require.cache pattern used by ipc-models.test.js.

const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const ipcPath = require.resolve("../main/ipc");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(ipcPath)] });

function loadIpcHandlers({ previous, hotkeyResults, saveError = null }) {
  const handlers = {};
  const calls = {
    applied: [],
    saved: [],
    autostart: [],
    settingsChanged: 0,
    opened: [],
    closed: 0,
    warnings: [],
  };
  let current = previous;
  const settings = {
    DEFAULTS: {},
    get: () => current,
    save: (next) => {
      calls.saved.push(next);
      if (saveError) throw saveError;
      current = { normalized: true, ...next };
      return current;
    },
  };
  const windows = {
    openSettings(options) {
      calls.opened.push(options);
    },
    closeWizard() {
      calls.closed += 1;
    },
  };
  const autostart = {
    apply(value) {
      calls.autostart.push(value);
    },
    isEnabled: () => false,
  };
  const stubs = {
    [resolveFrom("electron")]: {
      app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0" },
      ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; }, on() {} },
      shell: {},
    },
    [resolveFrom("./settings")]: settings,
    [resolveFrom("./engines")]: {
      registry: {
        setCustomModels() {},
        DEFAULT_STT_MODEL: "stt-default",
        DEFAULT_CLEANUP_MODEL: "cleanup-default",
      },
      remove: async () => {},
      isInstalled: () => false,
    },
    [resolveFrom("./windows")]: windows,
    [resolveFrom("./services/route")]: {},
    [resolveFrom("./output/deliver")]: {},
    [resolveFrom("./history")]: {},
    [resolveFrom("./autostart")]: autostart,
    [resolveFrom("./updates")]: {},
    [resolveFrom("./util/logger")]: {
      info() {},
      warn(message) {
        calls.warnings.push(message);
      },
      error() {},
    },
  };

  const priorCache = new Map();
  for (const [modulePath, exports] of Object.entries(stubs)) {
    priorCache.set(modulePath, require.cache[modulePath]);
    const stub = new Module(modulePath, null);
    stub.filename = modulePath;
    stub.loaded = true;
    stub.exports = exports;
    require.cache[modulePath] = stub;
  }
  delete require.cache[ipcPath];
  try {
    require(ipcPath).init({
      applyHotkeys(cfg) {
        calls.applied.push(cfg);
        return typeof hotkeyResults === "function"
          ? hotkeyResults(cfg, calls.applied.length)
          : hotkeyResults;
      },
      onSettingsChanged() {
        calls.settingsChanged += 1;
      },
    });
  } finally {
    delete require.cache[ipcPath];
    for (const [modulePath, oldModule] of priorCache) {
      if (oldModule) require.cache[modulePath] = oldModule;
      else delete require.cache[modulePath];
    }
  }
  return { handlers, calls };
}

const working = {
  hotkey: "CommandOrControl+Shift+Space",
  pauseHotkey: "CommandOrControl+Alt+P",
  startOnBoot: false,
  overlay: { x: 20, y: 30 },
  output: { mode: "paste" },
  customModels: [],
};

function submitted(overrides = {}) {
  return {
    ...working,
    hotkey: "CommandOrControl+Alt+X",
    pauseHotkey: "CommandOrControl+Alt+Q",
    startOnBoot: true,
    overlay: { x: 999, y: 999 },
    output: { mode: "copy" },
    ...overrides,
  };
}

test("settings save keeps a rejected record off disk but in the reply", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: false, error: "record rejected" },
    pauseHotkey: { ok: true },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, attempt);

  assert.strictEqual(calls.saved.length, 1);
  assert.strictEqual(calls.saved[0].hotkey, working.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, attempt.pauseHotkey);
  assert.deepStrictEqual(calls.saved[0].output, { mode: "copy" });
  assert.deepStrictEqual(calls.saved[0].overlay, working.overlay);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.strictEqual(reply.settings.pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.settings.normalized, true);
  assert.strictEqual(reply.hotkey.error, "record rejected");
  assert.deepStrictEqual(calls.autostart, [true]);
  assert.strictEqual(calls.settingsChanged, 1);
});

test("settings save keeps a rejected pause off disk but in the reply", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: true },
    pauseHotkey: { ok: false, error: "pause rejected" },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, attempt);

  assert.strictEqual(calls.saved[0].hotkey, attempt.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, working.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.strictEqual(reply.settings.pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.pauseHotkey.error, "pause rejected");
});

test("an atomic pair rollback keeps both previous hotkeys on disk", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: false, error: "Not changed: pause failed" },
    pauseHotkey: { ok: false, error: "pause rejected" },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, attempt);

  assert.strictEqual(calls.saved[0].hotkey, working.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, working.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.strictEqual(reply.settings.pauseHotkey, attempt.pauseHotkey);
});

test("an intentionally empty record remains persisted as a misconfiguration", () => {
  const attempt = submitted({ hotkey: "" });
  const results = {
    hotkey: { ok: false, empty: true, error: "No hotkey configured" },
    pauseHotkey: { ok: true },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, attempt);

  assert.strictEqual(calls.saved[0].hotkey, "");
  assert.strictEqual(reply.settings.hotkey, "");
});

test("wizard completion reconciles a record failure and stays open", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: false, error: "record rejected" },
    pauseHotkey: { ok: true },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["wizard:complete"]({}, attempt);

  assert.strictEqual(calls.saved[0].hotkey, working.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.deepStrictEqual(calls.opened, []);
  assert.strictEqual(calls.closed, 0);
});

test("successful wizard completion persists both hotkeys and hands off", () => {
  const attempt = submitted();
  const results = { hotkey: { ok: true }, pauseHotkey: { ok: true } };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["wizard:complete"]({}, attempt);

  assert.strictEqual(calls.saved[0].hotkey, attempt.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.deepStrictEqual(calls.opened, [{ fromWizard: true }]);
  assert.strictEqual(calls.closed, 1);
});

test("a settings write failure restores the pair that remains on disk", () => {
  const attempt = submitted();
  const writeError = new Error("disk full");
  const results = { hotkey: { ok: true }, pauseHotkey: { ok: true } };
  const { handlers, calls } = loadIpcHandlers({
    previous: working,
    hotkeyResults: results,
    saveError: writeError,
  });

  assert.throws(() => handlers["settings:save"]({}, attempt), /disk full/);
  assert.strictEqual(calls.applied.length, 2);
  assert.deepStrictEqual(calls.applied[0].overlay, working.overlay);
  assert.deepStrictEqual(calls.applied[1], working);
  assert.deepStrictEqual(calls.autostart, []);
  assert.strictEqual(calls.settingsChanged, 0);
});

test("a failed write keeps its error when hotkey rollback reports a failure", () => {
  const attempt = submitted();
  const { handlers, calls } = loadIpcHandlers({
    previous: working,
    saveError: new Error("disk full"),
    hotkeyResults(cfg, call) {
      return call === 1
        ? { hotkey: { ok: true }, pauseHotkey: { ok: true } }
        : {
            hotkey: { ok: false, error: "record restore failed" },
            pauseHotkey: { ok: true },
          };
    },
  });

  assert.throws(() => handlers["settings:save"]({}, attempt), /disk full/);
  assert.strictEqual(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /could not restore hotkeys.*record restore failed/);
});

test("a failed write keeps its error when hotkey rollback throws", () => {
  const attempt = submitted();
  const { handlers, calls } = loadIpcHandlers({
    previous: working,
    saveError: new Error("disk full"),
    hotkeyResults(cfg, call) {
      if (call === 2) throw new Error("rollback blew up");
      return { hotkey: { ok: true }, pauseHotkey: { ok: true } };
    },
  });

  assert.throws(() => handlers["settings:save"]({}, attempt), /disk full/);
  assert.strictEqual(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /could not restore hotkeys.*rollback blew up/);
});
