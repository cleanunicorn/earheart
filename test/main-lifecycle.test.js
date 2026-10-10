// App lifecycle of main/main.js: the single-instance lock, second-instance
// forwarding, the startup sequence, the hotkey-failure path, smoke launches
// and quit cleanup.
//
// main.js takes the single-instance lock and calls main() at require time, so
// it is loaded fresh per test against a controllable Electron `app` and stubs
// for its main-process neighbours (the require.cache pattern of
// test/updates-init.test.js). hotkeys.js and setup-notices.js stay real, so a
// test sees the actual registration and the actual startup-notice policy, with
// only Electron's globalShortcut and Notification faked underneath them.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const MAIN = require.resolve("../main/main");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(MAIN)] });
// Real modules whose state must not leak between loads.
const FRESH = [MAIN, resolveFrom("./hotkeys"), resolveFrom("./setup-notices")];

const RECORD = "CommandOrControl+Shift+Space";
const PAUSE = "CommandOrControl+Alt+P";

function makeCfg(overrides = {}) {
  return {
    hotkey: RECORD,
    pauseHotkey: PAUSE,
    startOnBoot: false,
    output: { mode: "paste" },
    stt: { engine: "builtin" },
    ...overrides,
  };
}

/**
 * Load a fresh main/main.js against fakes and wait for its whenReady handler.
 * Every observable side effect lands, in order, in `events`.
 */
async function loadMain(
  {
    argv = [],
    gotLock = true,
    cfg = makeCfg(),
    firstRun = false,
    occupied = [], // accelerators globalShortcut refuses
    updatesInit = () => {},
    notificationsSupported = true,
  } = {}
) {
  const events = [];
  const appHandlers = {};
  const shortcuts = new Map();
  const ipcInit = {};
  const notices = [];
  let permissionHandler = null;

  class FakeNotification {
    static isSupported() {
      return notificationsSupported;
    }
    constructor(note) {
      this.note = note;
      notices.push(note);
    }
    on() {}
    show() {
      events.push(`notify:${this.note.title}`);
    }
  }

  const stubs = {
    electron: {
      app: {
        requestSingleInstanceLock: () => {
          events.push("requestSingleInstanceLock");
          return gotLock;
        },
        exit: (code) => events.push(`app.exit:${code}`),
        quit: () => events.push("app.quit"),
        on: (event, handler) => {
          appHandlers[event] = handler;
        },
        whenReady: () => Promise.resolve(),
      },
      session: {
        defaultSession: {
          setPermissionRequestHandler: (handler) => {
            permissionHandler = handler;
          },
        },
      },
      Notification: FakeNotification,
      globalShortcut: {
        register(accelerator, callback) {
          events.push(`register:${accelerator}`);
          if (occupied.includes(accelerator)) return false;
          shortcuts.set(accelerator, callback);
          return true;
        },
        unregister(accelerator) {
          events.push(`unregister:${accelerator}`);
          shortcuts.delete(accelerator);
        },
        unregisterAll() {
          events.push("unregisterAll");
          shortcuts.clear();
        },
      },
    },
    "./settings": { isFirstRun: () => firstRun, get: () => cfg },
    "./windows": {
      createOverlay: () => events.push("createOverlay"),
      destroyOverlay: () => events.push("destroyOverlay"),
      openSettings: () => events.push("openSettings"),
      openWizard: () => events.push("openWizard"),
    },
    "./pipeline": {
      init: () => events.push("pipeline.init"),
      toggle: () => events.push("pipeline.toggle"),
      pauseToggle: () => events.push("pipeline.pauseToggle"),
      onSettingsChanged: () => {},
      onOverlayRendererGone: () => {},
    },
    "./tray": { init: () => events.push("tray.init"), refresh: () => {} },
    "./ipc": {
      init: (opts) => {
        Object.assign(ipcInit, opts);
        events.push("ipc.init");
      },
    },
    "./engines": {
      getSttReadiness: () => ({ ok: true }),
      stop: () => events.push("engines.stop"),
    },
    "./autostart": { apply: () => events.push("autostart.apply") },
    "./updates": {
      init: (...args) => {
        events.push("updates.init");
        return updatesInit(...args);
      },
      dispose: () => events.push("updates.dispose"),
      onSettingsChanged: () => {},
    },
    "./util/logger": {
      init: () => events.push("logger.init"),
      info: () => {},
      warn: (...args) => events.push(`warn:${args.join(" ")}`),
      error: () => {},
    },
    "./output/deliver": {
      shouldRepairAtStartup: () => false,
      repairPastePermissions: async () => {},
    },
    "./engines/host": {
      createHost: () => ({ request: async () => ({ stt: true, cleanup: true }), stop() {} }),
      LOADCHECK_TIMEOUT_MS: 1000,
    },
  };

  const saved = new Map();
  const install = (file, exports) => {
    saved.set(file, require.cache[file]);
    const mod = new Module(file, null);
    mod.filename = file;
    mod.loaded = true;
    mod.exports = exports;
    require.cache[file] = mod;
  };
  for (const [spec, exports] of Object.entries(stubs)) install(resolveFrom(spec), exports);
  for (const file of FRESH) delete require.cache[file];

  const originalArgv = process.argv;
  process.argv = [...originalArgv.slice(0, 2), ...argv];
  try {
    require(MAIN);
  } finally {
    // isSmokeTest and startHidden are read at load time.
    process.argv = originalArgv;
    for (const file of FRESH) delete require.cache[file];
    for (const [file, previous] of saved) {
      if (previous) require.cache[file] = previous;
      else delete require.cache[file];
    }
  }
  // Let the whenReady().then(...) startup body run.
  await new Promise((resolve) => setImmediate(resolve));
  return {
    events,
    appHandlers,
    shortcuts,
    ipcInit,
    notices,
    permissionHandler: () => permissionHandler,
  };
}

const before = (events, a, b) => {
  const ia = events.indexOf(a);
  const ib = events.indexOf(b);
  assert.ok(ia >= 0, `${a} should happen`);
  assert.ok(ib >= 0, `${b} should happen`);
  assert.ok(ia < ib, `${a} should happen before ${b}: ${events.join(", ")}`);
};

test("a second instance that loses the lock exits without starting the app", async () => {
  const { events, appHandlers } = await loadMain({ gotLock: false });
  assert.deepStrictEqual(events, ["requestSingleInstanceLock", "app.exit:0"]);
  assert.deepStrictEqual(Object.keys(appHandlers), [], "no lifecycle handlers are wired");
});

test("the first instance forwards a second instance's --toggle and --pause", async () => {
  const { events, appHandlers } = await loadMain();
  const secondInstance = appHandlers["second-instance"];
  assert.strictEqual(typeof secondInstance, "function");

  events.length = 0;
  secondInstance({}, ["/opt/Earheart/earheart", "--toggle"]);
  secondInstance({}, ["/opt/Earheart/earheart", "--pause"]);
  // Launched again with no action (e.g. from the app menu): show Settings.
  secondInstance({}, ["/opt/Earheart/earheart"]);
  assert.deepStrictEqual(events, ["pipeline.toggle", "pipeline.pauseToggle", "openSettings"]);
});

test("a healthy launch registers both hotkeys and announces ready", async () => {
  const { events, shortcuts, ipcInit, permissionHandler } = await loadMain();

  assert.strictEqual(events[1], "logger.init", "logging starts before anything can fail");
  before(events, "pipeline.init", "ipc.init");
  before(events, "createOverlay", "tray.init");
  before(events, `register:${RECORD}`, "notify:Earheart is ready");
  assert.ok(events.includes(`register:${PAUSE}`));
  assert.ok(events.includes("updates.init"));
  assert.ok(!events.includes("openSettings") && !events.includes("openWizard"));

  // The registered shortcuts drive the pipeline.
  events.length = 0;
  shortcuts.get(RECORD)();
  shortcuts.get(PAUSE)();
  assert.deepStrictEqual(events, ["pipeline.toggle", "pipeline.pauseToggle"]);

  // Settings reads the launch's hotkey status through ipc.
  assert.deepStrictEqual(ipcInit.getHotkeyStatus(), {
    hotkey: { ok: true, accelerator: RECORD },
    pauseHotkey: { ok: true, accelerator: PAUSE },
  });

  // Only the microphone and clipboard writes from app pages are granted.
  const appUrl = pathToFileURL(path.join(__dirname, "../renderer/overlay.html")).href;
  const decide = (permission, requestingUrl = appUrl) => {
    let granted;
    permissionHandler()(null, permission, (ok) => {
      granted = ok;
    }, { requestingUrl });
    return granted;
  };
  assert.strictEqual(decide("media"), true);
  assert.strictEqual(decide("clipboard-sanitized-write"), true);
  assert.strictEqual(decide("geolocation"), false);
  assert.strictEqual(decide("media", "https://example.com/"), false);
  assert.strictEqual(decide("clipboard-sanitized-write", "https://example.com/"), false);
});

test("a record hotkey that fails to register opens Settings instead of a ready notice", async () => {
  const { events, notices } = await loadMain({ occupied: [RECORD] });
  assert.ok(events.includes("openSettings"), events.join(", "));
  assert.deepStrictEqual(notices, [], "no 'press X to dictate' notice is shown");
  assert.ok(
    events.some((e) => e.startsWith("warn:") && e.includes("Could not register")),
    "the failure is logged"
  );
});

test("a hidden launch with a failed record hotkey shows a notice instead of Settings", async () => {
  const { events, notices } = await loadMain({ argv: ["--hidden"], occupied: [RECORD] });
  assert.ok(!events.includes("openSettings"), "autostart does not pop a window");
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].title, "Earheart: hotkey not working");
});

test("a first run opens the setup wizard", async () => {
  const { events } = await loadMain({ firstRun: true });
  assert.ok(events.includes("openWizard"));
  assert.ok(!events.includes("openSettings"));
});

test("hotkeys still register when updates.init throws", async () => {
  const { events, shortcuts } = await loadMain({
    updatesInit: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.ok(shortcuts.has(RECORD), `record hotkey registered: ${events.join(", ")}`);
  assert.ok(shortcuts.has(PAUSE), "pause hotkey registered");
  assert.ok(events.includes("notify:Earheart is ready"), "startup still announces");
  assert.ok(
    events.some((e) => e.startsWith("warn:") && e.includes("EACCES")),
    "the update failure is logged"
  );
});

test("a smoke-test launch skips updates and notices, then quits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged = [];
  t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));
  const { events, shortcuts } = await loadMain({ argv: ["--smoke-test"] });

  assert.ok(!events.includes("updates.init"), "no update checks in CI");
  assert.ok(shortcuts.has(RECORD), "hotkeys are still exercised");
  assert.ok(!events.some((e) => e.startsWith("notify:") || e === "openSettings" || e === "openWizard"));
  assert.ok(!events.includes("app.quit"));

  t.mock.timers.tick(1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes("app.quit"));
  // CI greps for this exact line.
  assert.ok(logged.includes("[earheart] smoke test OK"), logged.join("\n"));
});

test("quitting destroys the overlay, then releases hotkeys, engines and updates", async () => {
  const { events, appHandlers } = await loadMain();

  // A tray app stays alive with every window closed.
  events.length = 0;
  appHandlers["window-all-closed"]();
  assert.deepStrictEqual(events, []);

  appHandlers["before-quit"]();
  appHandlers["will-quit"]();
  assert.deepStrictEqual(events, ["destroyOverlay", "unregisterAll", "engines.stop", "updates.dispose"]);
});
