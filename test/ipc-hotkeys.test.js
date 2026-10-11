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

function loadIpcHandlers({ previous, hotkeyResults, saveError = null, getHotkeyStatus }) {
  const handlers = {};
  const calls = {
    applied: [],
    saved: [],
    autostart: [],
    settingsChanged: 0,
    opened: [],
    closed: 0,
    warnings: [],
    suspended: [],
  };
  let current = previous;
  const settings = {
    DEFAULTS: {},
    get: () => current,
    keyStorage: () => ({ secure: true, backend: null, unreadable: [] }),
    onChanged: () => () => {},
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
      ipcMain: {
        handle: (channel, fn) => { handlers[channel] = fn; },
        on: (channel, fn) => { handlers[channel] = fn; },
      },
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
    [resolveFrom("./tray")]: { refresh() {} },
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
      suspendHotkeys(on) {
        calls.suspended.push(on);
      },
      getHotkeyStatus,
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

// The `{ settings, baseline }` request both forms send. No baseline: these
// tests are about hotkeys, so the form's shared-field values stand.
const request = (attempt) => ({ settings: attempt });

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

test("successful settings save persists and returns both hotkeys", () => {
  const attempt = submitted();
  const results = { hotkey: { ok: true }, pauseHotkey: { ok: true } };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, request(attempt));

  assert.strictEqual(calls.saved[0].hotkey, attempt.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.strictEqual(reply.settings.pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.hotkey.ok, true);
  assert.strictEqual(reply.pauseHotkey.ok, true);
  assert.deepStrictEqual(calls.autostart, [true]);
  assert.strictEqual(calls.settingsChanged, 1);
});

test("settings save keeps a rejected record off disk but in the reply", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: false, error: "record rejected" },
    pauseHotkey: { ok: true },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, request(attempt));

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

  const reply = handlers["settings:save"]({}, request(attempt));

  assert.strictEqual(calls.saved[0].hotkey, attempt.hotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, working.pauseHotkey);
  assert.strictEqual(reply.settings.hotkey, attempt.hotkey);
  assert.strictEqual(reply.settings.pauseHotkey, attempt.pauseHotkey);
  assert.strictEqual(reply.pauseHotkey.error, "pause rejected");
});

test("settings save keeps a rejected discard hotkey off disk but in the reply", () => {
  const before = { ...working, discardHotkey: "CommandOrControl+Alt+D" };
  const attempt = submitted({ discardHotkey: "CommandOrControl+Alt+K" });
  const results = {
    hotkey: { ok: true },
    pauseHotkey: { ok: true },
    discardHotkey: { ok: false, error: "discard rejected" },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: before, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, request(attempt));

  assert.strictEqual(calls.saved[0].discardHotkey, before.discardHotkey);
  assert.strictEqual(calls.saved[0].pauseHotkey, attempt.pauseHotkey, "the other slots still save");
  assert.strictEqual(reply.settings.discardHotkey, attempt.discardHotkey);
  assert.strictEqual(reply.discardHotkey.error, "discard rejected");
});

test("a cleared discard hotkey saves as unbound", () => {
  const before = { ...working, discardHotkey: "CommandOrControl+Alt+D" };
  const attempt = submitted({ discardHotkey: "" });
  const results = {
    hotkey: { ok: true },
    pauseHotkey: { ok: true },
    discardHotkey: { ok: true, empty: true },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: before, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, request(attempt));

  assert.strictEqual(calls.saved[0].discardHotkey, "");
  assert.deepStrictEqual(reply.discardHotkey, { ok: true, empty: true });
});

test("an atomic pair rollback keeps both previous hotkeys on disk", () => {
  const attempt = submitted();
  const results = {
    hotkey: { ok: false, error: "Not changed: pause failed" },
    pauseHotkey: { ok: false, error: "pause rejected" },
  };
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: results });

  const reply = handlers["settings:save"]({}, request(attempt));

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

  const reply = handlers["settings:save"]({}, request(attempt));

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

  const reply = handlers["wizard:complete"]({}, request(attempt));

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

  const reply = handlers["wizard:complete"]({}, request(attempt));

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

  assert.throws(() => handlers["settings:save"]({}, request(attempt)), /disk full/);
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

  assert.throws(() => handlers["settings:save"]({}, request(attempt)), /disk full/);
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

  assert.throws(() => handlers["settings:save"]({}, request(attempt)), /disk full/);
  assert.strictEqual(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /could not restore hotkeys.*rollback blew up/);
});

// Settings renders the startup registration result when it opens, before any
// Save — so settings:get has to carry it, and reading it must never re-register.
test("settings:get reports the last hotkey registration without re-registering", () => {
  const status = {
    hotkey: { ok: false, error: "Could not register", accelerator: working.hotkey },
    pauseHotkey: { ok: true, accelerator: working.pauseHotkey },
  };
  const { handlers, calls } = loadIpcHandlers({
    previous: working,
    hotkeyResults: { hotkey: { ok: true }, pauseHotkey: { ok: true } },
    getHotkeyStatus: () => status,
  });

  const first = handlers["settings:get"]();
  const second = handlers["settings:get"]();

  assert.deepStrictEqual(first.hotkeyStatus, status);
  assert.deepStrictEqual(second.hotkeyStatus, status);
  assert.deepStrictEqual(calls.applied, []);
});

test("settings:get reports a later registration result", () => {
  let status = { hotkey: { ok: false, error: "taken", accelerator: "A" }, pauseHotkey: { ok: true } };
  const { handlers } = loadIpcHandlers({
    previous: working,
    hotkeyResults: { hotkey: { ok: true }, pauseHotkey: { ok: true } },
    getHotkeyStatus: () => status,
  });
  assert.strictEqual(handlers["settings:get"]().hotkeyStatus.hotkey.ok, false);

  status = { hotkey: { ok: true, accelerator: "B" }, pauseHotkey: { ok: true } };

  assert.strictEqual(handlers["settings:get"]().hotkeyStatus.hotkey.ok, true);
});

test("settings:get reports no hotkey status when none is wired", () => {
  const { handlers } = loadIpcHandlers({
    previous: working,
    hotkeyResults: { hotkey: { ok: true }, pauseHotkey: { ok: true } },
  });

  assert.strictEqual(handlers["settings:get"]().hotkeyStatus, null);
});

// A fake webContents: enough for the capture handler to key on it and hear
// its page go away.
function fakeSender() {
  const listeners = {};
  return {
    listeners,
    on(name, fn) {
      (listeners[name] ||= []).push(fn);
    },
    emit(name) {
      for (const fn of listeners[name] || []) fn();
    },
    destroy() {
      this.emit("destroyed");
    },
  };
}

test("hotkey capture suspends the global hotkeys until it ends", () => {
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
  const sender = fakeSender();

  handlers["hotkeys:capture"]({ sender }, true);
  handlers["hotkeys:capture"]({ sender }, false);

  assert.deepStrictEqual(calls.suspended, [true, false]);
});

test("hotkeys stay suspended while any window is still capturing", () => {
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
  const settingsWindow = fakeSender();
  const wizardWindow = fakeSender();

  handlers["hotkeys:capture"]({ sender: settingsWindow }, true);
  handlers["hotkeys:capture"]({ sender: wizardWindow }, true);
  handlers["hotkeys:capture"]({ sender: settingsWindow }, false);
  assert.strictEqual(calls.suspended.at(-1), true, "the wizard is still capturing");

  handlers["hotkeys:capture"]({ sender: wizardWindow }, false);
  assert.strictEqual(calls.suspended.at(-1), false);
});

test("a window closed mid-capture restores the global hotkeys", () => {
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
  const sender = fakeSender();

  handlers["hotkeys:capture"]({ sender }, true);
  sender.destroy();

  assert.deepStrictEqual(calls.suspended, [true, false]);
});

for (const gone of ["render-process-gone", "did-navigate"]) {
  test(`a page lost to ${gone} mid-capture restores the global hotkeys`, () => {
    const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
    const sender = fakeSender();

    handlers["hotkeys:capture"]({ sender }, true);
    sender.emit(gone);

    assert.deepStrictEqual(calls.suspended, [true, false]);
  });
}

test("each window's cleanup is wired once, however many captures it runs", () => {
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
  const sender = fakeSender();

  for (let i = 0; i < 20; i++) {
    handlers["hotkeys:capture"]({ sender }, true);
    handlers["hotkeys:capture"]({ sender }, false);
  }
  assert.strictEqual(sender.listeners.destroyed.length, 1);

  calls.suspended.length = 0;
  sender.destroy();
  assert.deepStrictEqual(calls.suspended, [], "a window that is not capturing changes nothing");
});

test("anything but true ends a capture, so a malformed payload cannot strand the hotkeys", () => {
  const { handlers, calls } = loadIpcHandlers({ previous: working, hotkeyResults: {} });
  const sender = fakeSender();

  handlers["hotkeys:capture"]({ sender }, "yes");
  assert.deepStrictEqual(calls.suspended, [false]);
  handlers["hotkeys:capture"]({ sender }, true);
  handlers["hotkeys:capture"]({ sender }, undefined);
  assert.deepStrictEqual(calls.suspended, [false, true, false]);
});
