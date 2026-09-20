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
// window behaviour, so the macOS Spaces fix these assertions guard is verified by
// a human on real hardware, not here. See the PR body.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const WINDOWS = require.resolve("../main/windows");

// A BrowserWindow that records every call as [name, ...args], so a test can
// assert not just that something happened but where it happened relative to
// everything else. Geometry answers are fixed: nothing here depends on layout.
function makeFakeWindow(calls, { refuseRejoin = false } = {}) {
  // Tracks the NSWindow's all-Spaces collection-behaviour bit, so a test can
  // clear it after creation to stand in for the bit being lost at runtime.
  // refuseRejoin stands in for the other failure the production warn
  // distinguishes: the set itself silently not taking.
  let bit = false;
  return class FakeWindow {
    constructor(options) {
      calls.push(["construct", options]);
      this.webContents = {
        on: () => {},
        once: () => {},
        send: (channel) => calls.push(["send", channel]),
        isLoading: () => false,
        reload: () => {},
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
    }
    getSize() {
      return [500, 95];
    }
    setSize(w, h) {
      calls.push(["setSize", w, h]);
    }
    getPosition() {
      return [0, 0];
    }
    setPosition() {}
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
function loadWindows({ refuseRejoin = false } = {}) {
  const calls = [];
  const warnings = [];
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const electron = {
    BrowserWindow: makeFakeWindow(calls, { refuseRejoin }),
    ipcMain: { on: () => {} },
    screen: {
      getPrimaryDisplay: () => ({ workArea }),
      getAllDisplays: () => [{ workArea }],
      getDisplayNearestPoint: () => ({ workArea }),
    },
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return electron;
    if (request === "./settings") return { get: () => ({}), save: () => {} };
    if (request === "./util/logger") {
      return { info: () => {}, warn: (msg) => warnings.push(msg), error: () => {} };
    }
    return realLoad.call(this, request, ...rest);
  };
  delete require.cache[WINDOWS];
  try {
    return { windows: require(WINDOWS), calls, warnings };
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

// The three-line opening every "show once on macOS" case shares: load, create,
// then note where the show begins so assertions can slice the calls it made.
function showOnceOnDarwin(t) {
  onPlatform(t, "darwin");
  const { windows, calls, warnings } = loadWindows();
  windows.createOverlay();
  const show = calls.length;
  windows.showOverlay();
  return { windows, calls, warnings, show, during: calls.slice(show) };
}

const names = (calls) => calls.map(([name]) => name);
const indexOf = (calls, name) => names(calls).indexOf(name);
const countOf = (calls, name) => names(calls).filter((n) => n === name).length;

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

test("every platform: the card never takes focus and the hit-testing nudge survives", (t) => {
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
  onPlatform(t, "darwin");
  const { windows, calls } = loadWindows();
  windows.createOverlay();
  const show = calls.length;
  windows.showOverlay();
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
  onPlatform(t, "darwin");
  const { windows, calls } = loadWindows();
  windows.createOverlay();
  windows.showOverlay();
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
  onPlatform(t, "darwin");
  const { windows, calls, warnings } = loadWindows({ refuseRejoin: true });
  windows.createOverlay();
  const show = calls.length;
  windows.showOverlay();

  // The warn's two outcomes mean different things and route to different repairs:
  // "now true" is the bit having been cleared and put back, "now false" is the set
  // itself not taking — which the escalation treats as a different bug entirely.
  // Without this case only the first half is reachable, so a regression in the
  // second half would ship unnoticed.
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /now false/);
  assert.strictEqual(countOf(calls.slice(show), "setVisibleOnAllWorkspaces"), 1);
});
