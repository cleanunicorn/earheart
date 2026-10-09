// The overlay window's platform policy: which native calls showOverlay() makes,
// with which options, and in which order.
//
// main/windows.js destructures `electron` at module scope and has never been
// executed by a test before this file — test/overlay-contract.test.js only reads
// it as text for INK_COLOR. It is loaded here against a recording fake
// BrowserWindow using the same Module._load interception test/deliver.test.js
// uses, so the real createOverlay()/showOverlay() control flow runs under plain
// `node --test` with no Electron binary and no window server.
//
// What this file can and cannot prove: it pins the JavaScript — call frequency,
// exact options, ordering, and platform gating. It cannot execute a line of macOS
// window behaviour, so the macOS Spaces fix that these assertions guard is verified
// by a human on real hardware, not here. See the PR body.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const WINDOWS = require.resolve("../main/windows");

// A BrowserWindow that records every call as [name, ...args], so a test can
// assert not just that something happened but where it happened relative to
// everything else. Geometry answers are fixed: nothing here depends on layout.
function makeFakeWindow(calls, { refuseRejoin = false, webContentsHandlers = {} } = {}) {
  // Tracks the NSWindow's all-Spaces collection-behaviour bit, so a test can
  // clear it after creation to stand in for the bit being lost at runtime.
  // refuseRejoin stands in for the other failure the production warn
  // distinguishes: the set itself silently not taking.
  let bit = false;
  return class FakeWindow {
    constructor(options) {
      calls.push(["construct", options]);
      // Geometry is tracked so the drag and resize handlers can be driven
      // against a window that really moves.
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
      this.webContents = {
        on: (event, handler) => {
          webContentsHandlers[event] = handler;
        },
        once: (event, handler) => {
          webContentsHandlers[event] = handler;
        },
        send: (channel, payload) => calls.push(["send", channel, payload]),
        isLoading: () => false,
        reload: () => calls.push(["reload"]),
      };
    }
    setAlwaysOnTop(...args) {
      calls.push(["setAlwaysOnTop", ...args]);
    }
    isAlwaysOnTop() {
      return true;
    }
    setVisibleOnAllWorkspaces(visible, options) {
      bit = refuseRejoin ? false : visible;
      calls.push(["setVisibleOnAllWorkspaces", visible, options]);
    }
    isVisibleOnAllWorkspaces() {
      calls.push(["isVisibleOnAllWorkspaces", bit]);
      return bit;
    }
    loadFile() {
      calls.push(["loadFile"]);
    }
    setBounds(bounds) {
      calls.push(["setBounds", bounds]);
      this.bounds = { ...this.bounds, ...bounds };
    }
    getSize() {
      return [this.bounds.width, this.bounds.height];
    }
    setSize(w, h) {
      calls.push(["setSize", w, h]);
      this.bounds = { ...this.bounds, width: w, height: h };
    }
    getPosition() {
      return [this.bounds.x, this.bounds.y];
    }
    setPosition(x, y) {
      calls.push(["setPosition", x, y]);
      this.bounds = { ...this.bounds, x, y };
    }
    showInactive() {
      calls.push(["showInactive"]);
    }
    // Present so the test can prove they are never reached: the card must never
    // take focus from the app being dictated into.
    show() {
      calls.push(["show"]);
    }
    focus() {
      calls.push(["focus"]);
    }
    moveTop() {
      calls.push(["moveTop"]);
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return true;
    }
    hide() {
      calls.push(["hide"]);
    }
    destroy() {
      calls.push(["destroy"]);
    }
    on() {}
  };
}

// Load a fresh main/windows.js against fakes. Fresh per test because the module
// keeps the overlay as module-level singleton state.
//
// `displays` is a mutable list of work areas (the first is primary), so a test
// can unplug a monitor mid-run; `stored` is what settings.get() returns, and
// every settings.save() lands in `saved`. ipcMain handlers are captured in
// `ipc` so the overlay's drag/resize channels can be driven directly.
function loadWindows({
  refuseRejoin = false,
  displays = [{ x: 0, y: 0, width: 1920, height: 1080 }],
  stored = {},
} = {}) {
  const calls = [];
  const warnings = [];
  const webContentsHandlers = {};
  const ipc = {};
  const saved = [];
  // Nearest display: the one containing the point, else the closest by
  // distance to its work area — a fair stand-in for Electron's choice.
  const nearest = ({ x, y }) => {
    const dist = (a) =>
      Math.hypot(
        Math.max(a.x - x, 0, x - (a.x + a.width)),
        Math.max(a.y - y, 0, y - (a.y + a.height))
      );
    return displays.reduce((best, a) => (dist(a) < dist(best) ? a : best));
  };
  const electron = {
    BrowserWindow: makeFakeWindow(calls, { refuseRejoin, webContentsHandlers }),
    ipcMain: {
      on: (channel, handler) => {
        ipc[channel] = handler;
      },
    },
    screen: {
      getPrimaryDisplay: () => ({ workArea: displays[0] }),
      getAllDisplays: () => displays.map((workArea) => ({ workArea })),
      getDisplayNearestPoint: (point) => ({ workArea: nearest(point) }),
    },
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return electron;
    if (request === "./settings") {
      return { get: () => stored, save: (next) => saved.push(next) };
    }
    if (request === "./util/logger") {
      return { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} };
    }
    return realLoad.call(this, request, ...rest);
  };
  delete require.cache[WINDOWS];
  try {
    return { windows: require(WINDOWS), calls, warnings, webContentsHandlers, ipc, saved, displays };
  } finally {
    Module._load = realLoad;
    delete require.cache[WINDOWS];
  }
}

// Pin process.platform for one test, restored afterwards — the pattern
// test/deliver.test.js:50-54 already uses. Both platform guards in
// main/windows.js read process.platform at call time, so no reload is needed.
function onPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

// The opening the "one show on macOS" cases share: load, create, then note where
// the show begins so assertions can slice the calls it made. Cases that assert
// between create and show, or load twice, set themselves up instead — calling
// onPlatform twice in one test would leave the override in place for the rest of
// the file, because t.after hooks run in registration order.
function showOnceOnDarwin(t, options) {
  onPlatform(t, "darwin");
  const { windows, calls, warnings } = loadWindows(options);
  windows.createOverlay();
  const show = calls.length;
  windows.showOverlay();
  return { windows, calls, warnings, show, during: calls.slice(show) };
}

const names = (calls) => calls.map(([name]) => name);
const indexOf = (calls, name) => names(calls).indexOf(name);
const countOf = (calls, name) => names(calls).filter((n) => n === name).length;

test("overlay renderer loss invokes the injected callback before reload", () => {
  const { windows, calls, webContentsHandlers } = loadWindows();
  windows.createOverlay({ onOverlayRendererGone: () => calls.push(["renderer-gone-callback"]) });

  webContentsHandlers["render-process-gone"]();

  const callback = indexOf(calls, "renderer-gone-callback");
  const reloaded = indexOf(calls, "reload");
  assert.ok(callback >= 0, "renderer loss should notify the injected callback");
  assert.ok(reloaded > callback, "the callback must run before renderer reload");
});

test("overlay renderer loss replays the exact error status after reload", () => {
  const status = {
    status: "error",
    detail: { message: "Recording lost because the overlay stopped unexpectedly" },
  };
  const { windows, calls, webContentsHandlers } = loadWindows();
  windows.createOverlay({
    onOverlayRendererGone: () => {
      calls.push(["renderer-gone-callback"]);
      windows.sendToOverlay("pipeline:status", status);
    },
  });

  webContentsHandlers["render-process-gone"]();

  assert.strictEqual(
    countOf(calls.slice(indexOf(calls, "reload")), "send"),
    0,
    "the error status must not be sent to the dead renderer"
  );
  webContentsHandlers["did-finish-load"]();

  const replay = calls.find(
    ([name, channel]) => name === "send" && channel === "pipeline:status"
  );
  assert.deepStrictEqual(replay, ["send", "pipeline:status", status]);
});

// --- The guarantees that predate the Spaces fix -----------------------------
// These three run against behaviour that already existed, so they pass before
// the fix as well as after. That is the point: they prove the harness produces
// real assertions rather than vacuous ones, which is what makes the failing
// case below meaningful.

test("linux: showOverlay() makes no all-Spaces call; creation still makes exactly one", (t) => {
  onPlatform(t, "linux");
  const { windows, calls } = loadWindows();
  windows.createOverlay();
  const afterCreate = calls.length;
  windows.showOverlay();

  assert.strictEqual(
    countOf(calls.slice(0, afterCreate), "setVisibleOnAllWorkspaces"),
    1,
    "createOverlay() must keep its single all-Spaces call on Linux"
  );
  assert.strictEqual(
    countOf(calls.slice(afterCreate), "setVisibleOnAllWorkspaces"),
    0,
    "showOverlay() must not touch workspace behaviour on Linux"
  );
});

test("win32: showOverlay() makes no all-Spaces call and keeps the topmost-band sequence", (t) => {
  onPlatform(t, "win32");
  const { windows, calls } = loadWindows();
  windows.createOverlay();
  const show = calls.length;
  windows.showOverlay();
  const during = calls.slice(show);

  assert.strictEqual(
    countOf(during, "setVisibleOnAllWorkspaces"),
    0,
    "showOverlay() must not touch workspace behaviour on Windows, where it is a no-op anyway"
  );
  // Leaving the topmost band and re-entering it is what puts the card back on
  // top; moveTop() alone does not. Order matters, so assert the sequence.
  assert.deepStrictEqual(
    during
      .filter(([n]) => n === "setAlwaysOnTop" || n === "moveTop" || n === "showInactive")
      .map(([n, ...args]) => [n, ...args]),
    [
      ["showInactive"],
      ["setAlwaysOnTop", false],
      ["setAlwaysOnTop", true, "screen-saver"],
      ["moveTop"],
    ],
    "the Windows topmost-band refresh must still run, in order, after showInactive()"
  );
});

// Runs on darwin, but none of the code it asserts has a platform branch: the
// constructor options and the size nudge are unconditional. One platform proves
// them — the title says darwin anyway, so nobody reads this as linux or win32
// coverage that exists when it does not.
test("darwin: the card never takes focus and the hit-testing nudge survives", (t) => {
  onPlatform(t, "darwin");
  const { windows, calls } = loadWindows();
  windows.createOverlay();
  const [, options] = calls.find(([name]) => name === "construct");

  assert.strictEqual(options.focusable, false, "the card must never take keyboard focus");
  assert.strictEqual(
    options.acceptFirstMouse,
    true,
    "macOS swallows the first click on an inactive window without this"
  );

  windows.showOverlay();
  assert.strictEqual(countOf(calls, "show"), 0, "the overlay must be shown with showInactive()");
  assert.strictEqual(countOf(calls, "focus"), 0, "the overlay must never be focused");

  // Transparent frameless windows do not hit-test until their bounds change
  // while visible, so the nudge has to follow showInactive(), not precede it.
  const shown = indexOf(calls, "showInactive");
  const nudge = names(calls).reduce(
    (acc, name, i) => (name === "setSize" && i > shown ? [...acc, i] : acc),
    []
  );
  assert.strictEqual(nudge.length, 2, "the one-pixel nudge must still be a pair of setSize calls");
  assert.deepStrictEqual(calls[nudge[0]], ["setSize", 500, 96]);
  assert.deepStrictEqual(calls[nudge[1]], ["setSize", 500, 95]);
});

// --- The macOS Spaces fix ---------------------------------------------------
// createOverlay() asserts the all-Spaces collection behaviour exactly once, at
// launch, on a window that has never been ordered in. These pin the per-show
// re-assertion that replaces that one frozen sample.

test("darwin: every show re-asserts all-Spaces, after setBounds and before the window is ordered in", (t) => {
  const { during } = showOnceOnDarwin(t);

  assert.strictEqual(
    countOf(during, "setVisibleOnAllWorkspaces"),
    1,
    "showOverlay() must re-assert all-Spaces exactly once per show on macOS"
  );
  // Ordering is the assertion, not presence. A window that is not all-Spaces at
  // the moment it is ordered in goes to the Space it remembers, so re-asserting
  // after showInactive() would be a visible jump off the user's Space at best.
  const bounds = indexOf(during, "setBounds");
  const rejoin = indexOf(during, "setVisibleOnAllWorkspaces");
  const shown = indexOf(during, "showInactive");
  assert.ok(bounds >= 0 && rejoin >= 0 && shown >= 0, "all three calls must happen");
  assert.ok(bounds < rejoin, "the re-assert must follow setBounds");
  assert.ok(rejoin < shown, "the re-assert must precede showInactive()");
});

test("darwin: creation stays on the default path that establishes the process type", (t) => {
  onPlatform(t, "darwin");
  const { windows, calls } = loadWindows();
  windows.createOverlay();

  const [, visible, options] = calls.find(([name]) => name === "setVisibleOnAllWorkspaces");
  assert.strictEqual(visible, true);
  // The other half of the two-phase contract, and the half that is silent when it
  // breaks: adding skipTransformProcessType here would skip the transform that
  // rejoinActiveSpace() then relies on having happened, leaving the per-show call
  // resting on a process type nothing ever established. Pin the absence of the key,
  // not just the presence of the call.
  assert.deepStrictEqual(options, { visibleOnFullScreen: true });
});

test("darwin: the re-assert skips the process-type transform", (t) => {
  const { during } = showOnceOnDarwin(t);

  const [, visible, options] = during.find(([name]) => name === "setVisibleOnAllWorkspaces");
  assert.strictEqual(visible, true);
  // Without skipTransformProcessType the default path transforms the process
  // between UIElementApplication and ForegroundApplication, which Electron
  // documents as hiding the window and the Dock for a short time every call —
  // once per dictation. createOverlay() has already done that transform once,
  // which is what makes skipping it here correct.
  assert.deepStrictEqual(options, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
});

test("darwin: a second show re-asserts again rather than caching the first", (t) => {
  const { windows, calls, show } = showOnceOnDarwin(t);
  windows.hideOverlay();
  windows.showOverlay();
  windows.destroyOverlay();

  assert.strictEqual(
    countOf(calls.slice(show), "setVisibleOnAllWorkspaces"),
    2,
    "the state must be re-established per show, not remembered from the first one"
  );
});

test("darwin: a show that supersedes a fade-out still re-asserts", (t) => {
  const { windows, calls } = showOnceOnDarwin(t);
  // A fade-out is in flight; this show cancels it and takes the early branch
  // through showOverlay(). The re-assert must not live in a cold-start path.
  windows.hideOverlay();
  const resume = calls.length;
  windows.showOverlay();
  windows.destroyOverlay();

  assert.strictEqual(
    countOf(calls.slice(resume), "setVisibleOnAllWorkspaces"),
    1,
    "superseding a fade-out is still a show and must re-assert"
  );
});

test("darwin: losing the bit is logged with what re-applying achieved; holding it is silent", (t) => {
  onPlatform(t, "darwin");

  const quiet = loadWindows();
  quiet.windows.createOverlay();
  quiet.windows.showOverlay();
  assert.deepStrictEqual(quiet.warnings, [], "a healthy window must not warn on every dictation");

  const lost = loadWindows();
  const win = lost.windows.createOverlay();
  win.setVisibleOnAllWorkspaces(false); // the bit is cleared after creation
  const show = lost.calls.length;
  lost.windows.showOverlay();

  assert.strictEqual(lost.warnings.length, 1, "losing the bit must be reported once");
  assert.match(lost.warnings[0], /all-Spaces/);
  // The read-back after the set is the only thing that separates "the bit was
  // lost and we put it back" from "the set itself did not take", which is what
  // a bug report needs to decide whether re-asserting is even the right repair.
  assert.match(lost.warnings[0], /now true/);
  // The diagnostic must never become a gate: the repair runs either way.
  assert.strictEqual(countOf(lost.calls.slice(show), "setVisibleOnAllWorkspaces"), 1);
});

test("darwin: a re-apply that does not take is reported as such, not as a repair", (t) => {
  const { calls, warnings, show } = showOnceOnDarwin(t, { refuseRejoin: true });

  // The warn's two outcomes mean different things and route to different repairs:
  // "now true" is the bit having been cleared and put back, "now false" is the set
  // itself not taking — which the escalation treats as a different bug entirely.
  // Without this case only the first half is reachable, so a regression in the
  // second half would ship unnoticed.
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /now false/);
  assert.strictEqual(countOf(calls.slice(show), "setVisibleOnAllWorkspaces"), 1);
});

/* ---------------- overlay placement ---------------- */

// The default spot on a 1920x1080 primary display: bottom-center, 24 px up.
const DEFAULT_SPOT = { x: 710, y: 961 };
const constructedAt = (calls) => {
  const [, options] = calls.find(([name]) => name === "construct");
  return { x: options.x, y: options.y };
};
const lastOf = (calls, name) => calls.filter(([n]) => n === name).at(-1);

test("a saved overlay position that still fits a display is restored", () => {
  // A spot on a second monitor to the right of the primary.
  const { windows, calls } = loadWindows({
    displays: [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 1920, height: 1080 },
    ],
    stored: { overlay: { x: 2500, y: 100 } },
  });
  windows.createOverlay();
  assert.deepStrictEqual(constructedAt(calls), { x: 2500, y: 100 });
});

test("a saved overlay position off every display falls back to bottom-center", () => {
  // The monitor it was saved on is unplugged.
  const gone = loadWindows({ stored: { overlay: { x: 2500, y: 100 } } });
  gone.windows.createOverlay();
  assert.deepStrictEqual(constructedAt(gone.calls), DEFAULT_SPOT);

  // Partly off-screen is not good enough either: the whole card must fit.
  const straddling = loadWindows({ stored: { overlay: { x: 1500, y: 100 } } });
  straddling.windows.createOverlay();
  assert.deepStrictEqual(constructedAt(straddling.calls), DEFAULT_SPOT);

  // A malformed saved position is ignored rather than trusted.
  const malformed = loadWindows({ stored: { overlay: { x: "10", y: 20 } } });
  malformed.windows.createOverlay();
  assert.deepStrictEqual(constructedAt(malformed.calls), DEFAULT_SPOT);
});

test("showing the overlay re-clamps a remembered spot after the display shrinks", () => {
  const { windows, calls, displays } = loadWindows({ stored: { overlay: { x: 1400, y: 900 } } });
  windows.createOverlay();
  assert.deepStrictEqual(constructedAt(calls), { x: 1400, y: 900 });

  displays[0] = { x: 0, y: 0, width: 1280, height: 720 }; // resolution dropped
  const show = calls.length;
  windows.showOverlay();

  const [, bounds] = calls.slice(show).find(([name]) => name === "setBounds");
  assert.deepStrictEqual(bounds, { x: 1280 - 500, y: 720 - 95, width: 500, height: 95 });
});

test("dragging a grown overlay keeps it on-screen and saves its bottom-anchored spot", () => {
  const { windows, calls, ipc, saved } = loadWindows({ stored: { output: { mode: "paste" } } });
  windows.createOverlay();
  // A live transcript grows the card upward to 200 px.
  ipc["overlay:resize"]({}, { height: 200 });
  assert.deepStrictEqual(lastOf(calls, "setBounds")[1], { x: 710, y: 856, width: 500, height: 200 });

  ipc["overlay:drag-start"]({}, { x: 800, y: 900 });
  ipc["overlay:drag"]({}, { x: 5000, y: 5000 }); // far past the bottom-right corner

  // Clamped with the grown height, so the window's bottom edge stays on-screen.
  assert.deepStrictEqual(lastOf(calls, "setPosition"), ["setPosition", 1920 - 500, 1080 - 200]);
  assert.strictEqual(saved.length, 0, "nothing is written while the drag is in flight");

  ipc["overlay:drag-end"]();
  // Saved where a base-height card would sit with the same bottom edge, and
  // merged into the current settings rather than replacing them.
  assert.deepStrictEqual(saved, [{ output: { mode: "paste" }, overlay: { x: 1420, y: 1080 - 95 } }]);

  // The next show resets to base height at that spot: same bottom edge.
  const show = calls.length;
  windows.showOverlay();
  const [, bounds] = calls.slice(show).find(([name]) => name === "setBounds");
  assert.deepStrictEqual(bounds, { x: 1420, y: 985, width: 500, height: 95 });
});

test("dragging clamps to an offset work area's top-left corner", () => {
  const { windows, calls, ipc, saved } = loadWindows({
    displays: [{ x: 100, y: 50, width: 1600, height: 900 }],
  });
  windows.createOverlay();
  ipc["overlay:drag-start"]({}, { x: 0, y: 0 });
  ipc["overlay:drag"]({}, { x: -5000, y: -5000 });
  assert.deepStrictEqual(lastOf(calls, "setPosition"), ["setPosition", 100, 50]);
  ipc["overlay:drag-end"]();
  assert.deepStrictEqual(saved.at(-1).overlay, { x: 100, y: 50 });
});

test("drag events without a drag-start, and a drag-end without a move, change nothing", () => {
  const { windows, calls, ipc, saved } = loadWindows();
  windows.createOverlay();
  ipc["overlay:drag"]({}, { x: 10, y: 10 });
  assert.strictEqual(lastOf(calls, "setPosition"), undefined);
  ipc["overlay:drag-start"]({}, { x: 0, y: 0 });
  ipc["overlay:drag-end"]();
  assert.deepStrictEqual(saved, []);
});

test("overlay resize is capped by the work area and floored at the base height", () => {
  const { windows, calls, ipc } = loadWindows();
  windows.createOverlay();
  const bottom = DEFAULT_SPOT.y + 95;

  // A runaway transcript: capped 48 px short of the work-area height, growing
  // upward from a fixed bottom edge.
  ipc["overlay:resize"]({}, { height: 5000 });
  assert.deepStrictEqual(lastOf(calls, "setBounds")[1], {
    x: 710, y: bottom - (1080 - 48), width: 500, height: 1080 - 48,
  });

  // Shrinking below the base card is floored at the base height.
  ipc["overlay:resize"]({}, { height: 10 });
  assert.deepStrictEqual(lastOf(calls, "setBounds")[1], { x: 710, y: 961, width: 500, height: 95 });

  // An unchanged height or a non-number is a no-op.
  const before = calls.length;
  ipc["overlay:resize"]({}, { height: 95 });
  ipc["overlay:resize"]({}, { height: "300" });
  assert.strictEqual(calls.length, before);
});

test("overlay growth near the top of the screen is floored at the work-area top", () => {
  const { windows, calls, ipc } = loadWindows();
  windows.createOverlay();
  ipc["overlay:drag-start"]({}, { x: 0, y: 0 });
  ipc["overlay:drag"]({}, { x: 0, y: -2000 }); // card pinned to the top edge
  assert.deepStrictEqual(lastOf(calls, "setPosition"), ["setPosition", 710, 0]);

  ipc["overlay:resize"]({}, { height: 400 });
  // Growing upward would push the top off-screen; it stays at y = 0 and the
  // window extends downward instead.
  assert.deepStrictEqual(lastOf(calls, "setBounds")[1], { x: 710, y: 0, width: 500, height: 400 });
});
