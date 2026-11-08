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
const { withStubs } = require("./helpers/stub-modules");
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
    pipelineState = "idle",
    canCloseCorrection = true,
    pruned = () => [], // ids a kept-recordings prune (#343) removes
    ducking = {},
  } = {}
) {
  const events = [];
  const appHandlers = {};
  const shortcuts = new Map();
  const ipcInit = {};
  const recordingsHooks = {};
  const notices = [];
  let permissionHandler = null;
  let stateListener = null;
  let captureListener = null;
  const powerHandlers = {};
  let state = pipelineState;

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
      powerMonitor: {
        on: (event, handler) => {
          events.push(`powerMonitor.on:${event}`);
          powerHandlers[event] = handler;
        },
      },
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
    "./settings": { isFirstRun: () => firstRun, get: () => cfg, onChanged: () => () => {}, cleanupPromptOffer: () => null },
    "./windows": {
      init: () => events.push("windows.init"),
      createOverlay: () => events.push("createOverlay"),
      rejoinOverlayAfterWake: (reason, opts) => events.push(`rejoin:${reason}:${JSON.stringify(opts)}`),
      destroyOverlay: () => events.push("destroyOverlay"),
      openSettings: () => events.push("openSettings"),
      confirmCorrectionClose: () => canCloseCorrection,
      closeCorrection: () => events.push("closeCorrection"),
      openWizard: () => events.push("openWizard"),
      openCorrection: (entry) => events.push(`correct:${entry.text}`),
      sendToSettings: (channel, payload) => events.push(`settings:${channel}:${JSON.stringify(payload ?? null)}`),
    },
    "./appearance": { init: () => events.push("appearance.init") },
    "./recordings": {
      startPruning: (getCfg, onPruned) => {
        events.push("recordings.startPruning");
        recordingsHooks.onPruned = onPruned;
      },
      prune: () => {
        events.push("recordings.prune");
        return pruned();
      },
    },
    "./history": { list: () => [{ text: "last transcript" }] },
    "./pipeline": {
      getState: () => state,
      init: () => events.push("pipeline.init"),
      toggle: () => events.push("pipeline.toggle"),
      pauseToggle: () => events.push("pipeline.pauseToggle"),
      discard: () => events.push("pipeline.discard"),
      stopFromEnter: () => events.push("pipeline.stopFromEnter"),
      onStateChange: (listener) => { stateListener = listener; },
      onCaptureChange: (listener) => { captureListener = listener; },
      onSettingsChanged: () => {},
      onOverlayRendererGone: () => {},
    },
    "./usage": { init: () => {} },
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
    "./ducking": {
      init: () => events.push("ducking.init"),
      setCapturing: (owner, live) => events.push(`ducking.capture:${owner}:${live}`),
      refresh: () => events.push("ducking.refresh"),
      holding: () => false,
      shutdown: async () => events.push("ducking.shutdown"),
      close: () => events.push("ducking.close"),
      ...ducking,
    },
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

  const resolved = Object.fromEntries(
    Object.entries(stubs).map(([spec, exports]) => [resolveFrom(spec), exports])
  );

  const originalArgv = process.argv;
  process.argv = [...originalArgv.slice(0, 2), ...argv];
  try {
    withStubs(resolved, FRESH, () => require(MAIN));
  } finally {
    // isSmokeTest and startHidden are read at load time.
    process.argv = originalArgv;
  }
  // Let the whenReady().then(...) startup body run.
  await new Promise((resolve) => setImmediate(resolve));
  return {
    events,
    appHandlers,
    shortcuts,
    ipcInit,
    recordingsHooks,
    notices,
    permissionHandler: () => permissionHandler,
    changeState: (state) => stateListener(state),
    changeCapture: (live) => captureListener(live),
    cfg,
    powerHandlers,
    setPipelineState: (next) => { state = next; },
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
  // The overlay's IPC is registered before the overlay exists (#204).
  before(events, "windows.init", "createOverlay");
  // The palette is set before any window exists, so none paints the wrong one.
  before(events, "appearance.init", "windows.init");
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
    discardHotkey: { ok: true, empty: true, accelerator: "" },
    correctHotkey: { ok: true, empty: true, accelerator: "" },
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

test("discard is armed during a dictation and released on idle", async () => {
  const discardHotkey = "CommandOrControl+Alt+Escape";
  const { events, shortcuts, changeState } = await loadMain({ cfg: makeCfg({ discardHotkey }) });
  assert.ok(!shortcuts.has(discardHotkey), "idle leaves the shortcut available");
  changeState("recording");
  assert.ok(shortcuts.has(discardHotkey));
  events.length = 0;
  shortcuts.get(discardHotkey)();
  assert.deepStrictEqual(events, ["pipeline.discard"]);
  changeState("transcribing");
  assert.ok(shortcuts.has(discardHotkey), "processing remains discardable");
  changeState("idle");
  assert.ok(!shortcuts.has(discardHotkey));
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

test("quitting destroys the overlay, then releases hotkeys, engines, updates and the volume tool", async () => {
  const { events, appHandlers } = await loadMain();

  // A tray app stays alive with every window closed.
  events.length = 0;
  appHandlers["window-all-closed"]();
  assert.deepStrictEqual(events, []);

  appHandlers["before-quit"]();
  appHandlers["will-quit"]();
  assert.deepStrictEqual(events, ["destroyOverlay", "unregisterAll", "engines.stop", "updates.dispose", "ducking.close"]);
});


test("the pipeline's capture signal drives ducking, and saving settings refreshes it", async () => {
  const { events, changeCapture, ipcInit } = await loadMain();
  assert.ok(events.includes("ducking.init"));
  events.length = 0;
  changeCapture(true);
  changeCapture(false);
  ipcInit.onSettingsChanged();
  // A save also applies kept-recording limits (#343) before ducking refreshes.
  assert.deepStrictEqual(events, ["ducking.capture:dictation:true", "ducking.capture:dictation:false", "recordings.prune", "ducking.refresh"]);
});

test("quitting while other audio is lowered waits for the restore, then quits again", async () => {
  let holding = true;
  let finish;
  const { events, appHandlers } = await loadMain({
    ducking: {
      holding: () => holding,
      shutdown: (ms) => {
        events.push(`ducking.shutdown:${ms}`);
        return new Promise((resolve) => { finish = resolve; });
      },
    },
  });
  events.length = 0;
  let prevented = false;
  appHandlers["before-quit"]({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true, "the first quit waits for the restore");
  assert.deepStrictEqual(events, ["destroyOverlay", "ducking.shutdown:2000"]);
  holding = false;
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(events.slice(-1), ["app.quit"]);
  // The second pass finds nothing held and lets the quit through.
  prevented = false;
  appHandlers["before-quit"]({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, false);
});

test("correction hotkey and desktop command open the latest saved transcript only when idle", async () => {
  const key = "CommandOrControl+Alt+C";
  for (const pipelineState of ["idle", "recording", "processing"]) {
    const { shortcuts, appHandlers, events, ipcInit } = await loadMain({ cfg: makeCfg({ correctHotkey: key }), pipelineState });
    events.length = 0;
    shortcuts.get(key)();
    appHandlers["second-instance"]({}, ["earheart", "--correct-last"]);
    assert.deepStrictEqual(events, pipelineState === "idle" ? ["correct:last transcript", "correct:last transcript"] : []);
    assert.strictEqual(ipcInit.canCorrect(), pipelineState === "idle");
    assert.strictEqual(ipcInit.canCopy(), pipelineState !== "processing");
  }
});


test("cancelling quit with an uncopied correction keeps the recording overlay alive", async () => {
  const { events, appHandlers } = await loadMain({ canCloseCorrection: false });
  events.length = 0;
  let prevented = false;
  appHandlers["before-quit"]({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);
  assert.deepStrictEqual(events, []);
});

test("an update install asks about an uncopied correction first, then closes the editor so quit does not ask again", async () => {
  for (const canCloseCorrection of [false, true]) {
    let callbacks = null;
    const { events } = await loadMain({ canCloseCorrection, updatesInit: (cb) => { callbacks = cb; } });
    events.length = 0;
    assert.strictEqual(callbacks.confirmInstall(), canCloseCorrection);
    assert.deepStrictEqual(events, canCloseCorrection ? ["closeCorrection"] : [], "a kept draft keeps its editor");
  }
});

// Kept recordings (#343): a settings save applies the new limits at once, and
// when that removes recordings History redraws — keeping its page — so one
// that was playing stops instead of playing on with stale buttons (review b-4).
test("a settings save that prunes kept recordings tells History, as an update", async () => {
  let removed = [];
  const { events, ipcInit, recordingsHooks } = await loadMain({ pruned: () => removed });
  assert.ok(events.includes("recordings.startPruning"));
  const sent = () => events.filter((e) => e.startsWith("settings:history:changed"));

  ipcInit.onSettingsChanged();
  assert.ok(events.includes("recordings.prune"), "new limits apply on save");
  assert.deepStrictEqual(sent(), [], "nothing removed, nothing to redraw");

  removed = ["2b0e0a46-2c3f-4b5e-9f00-0123456789ab"];
  ipcInit.onSettingsChanged();
  assert.deepStrictEqual(sent(), ['settings:history:changed:{"updated":true}']);

  // The startup/hourly prune's redraw is an update too.
  const before = sent().length;
  recordingsHooks.onPruned();
  assert.deepStrictEqual(sent().slice(before), ['settings:history:changed:{"updated":true}'], "exactly one new event");
});

// #353: wake.init() is wired with the real powerMonitor and reads the pipeline at
// wake time. main.js passes no platform, so wake.js reads process.platform.
function onPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

test("darwin: waking re-joins the overlay after it is created, deferred while a dictation runs", async (t) => {
  onPlatform(t, "darwin");
  const { events, powerHandlers, setPipelineState } = await loadMain();
  before(events, "createOverlay", "powerMonitor.on:resume");
  before(events, "createOverlay", "powerMonitor.on:unlock-screen");
  events.length = 0;
  powerHandlers.resume();
  powerHandlers["unlock-screen"]();
  setPipelineState("recording");
  powerHandlers.resume();
  setPipelineState("processing");
  powerHandlers["unlock-screen"]();
  assert.deepStrictEqual(events, [
    'rejoin:resume:{"deferOnly":false}',
    'rejoin:unlock-screen:{"deferOnly":false}',
    'rejoin:resume:{"deferOnly":true}',
    'rejoin:unlock-screen:{"deferOnly":true}',
  ]);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform}: no wake listener is registered`, async (t) => {
    onPlatform(t, platform);
    const { events, powerHandlers } = await loadMain();
    assert.deepStrictEqual(events.filter((e) => e.startsWith("powerMonitor")), []);
    assert.deepStrictEqual(Object.keys(powerHandlers), []);
  });
}

test("enter-to-stop holds Enter only for a live capture and stops once (#338)", async () => {
  const { events, shortcuts, changeState, changeCapture, setPipelineState } = await loadMain({
    cfg: makeCfg({ enterToStop: true }),
  });
  assert.ok(!shortcuts.has("Enter"), "idle: Enter is the user's");

  setPipelineState("recording");
  changeState("recording");
  assert.ok(!shortcuts.has("Enter"), "recording but the mic is not live yet (early Enter)");

  changeCapture(true);
  assert.ok(shortcuts.has("Enter"), "capturing");
  changeCapture(false);
  assert.ok(!shortcuts.has("Enter"), "paused: normal Enter");
  changeCapture(true);

  events.length = 0;
  shortcuts.get("Enter")();
  assert.ok(!shortcuts.has("Enter"), "released as the stop is requested");
  assert.deepStrictEqual(events.filter((e) => e.startsWith("pipeline.stop")), ["pipeline.stopFromEnter"]);

  changeCapture(true); // a settings save or resume must not re-arm a spent take
  assert.ok(!shortcuts.has("Enter"));

  setPipelineState("idle");
  changeCapture(false);
  changeState("idle");
  setPipelineState("recording");
  changeState("recording");
  changeCapture(true);
  assert.ok(shortcuts.has("Enter"), "the next take gets its own Enter");
  setPipelineState("idle");
  changeState("idle");
  assert.ok(!shortcuts.has("Enter"), "every terminal state releases it");
});

test("enter-to-stop stays off by default and follows the setting while a take is live (#338)", async () => {
  const { shortcuts, changeState, changeCapture, setPipelineState, cfg, ipcInit } = await loadMain();
  setPipelineState("recording");
  changeState("recording");
  changeCapture(true);
  assert.ok(!shortcuts.has("Enter"), "default off");

  cfg.enterToStop = true;
  ipcInit.onSettingsChanged();
  assert.ok(shortcuts.has("Enter"), "turned on mid-take");
  cfg.enterToStop = false;
  ipcInit.onSettingsChanged();
  assert.ok(!shortcuts.has("Enter"), "turned off mid-take");
});

test("enter-to-stop yields when Enter is a configured hotkey (#338)", async () => {
  const { shortcuts, changeState, changeCapture, setPipelineState } = await loadMain({
    cfg: makeCfg({ enterToStop: true, pauseHotkey: "Enter" }),
  });
  setPipelineState("recording");
  changeState("recording");
  changeCapture(true);
  assert.notStrictEqual(shortcuts.get("Enter"), undefined, "the pause hotkey holds it");
  assert.strictEqual(shortcuts.size >= 1, true);
});
