// main/wake.js: the macOS sleep/wake re-join of the overlay to all Spaces (#353).
//
// powerMonitor is a recording fake, so this pins which events are listened to,
// on which platforms, and what the re-join is told at the moment of the wake.
// What the re-join does to the window is pinned in test/windows.test.js.
//
// Neither file can execute macOS Space behaviour. The real-Mac check: with two or
// more Spaces, dictate on Space 1, sleep the Mac, wake it, switch to Space 2,
// focus a text field and press the hotkey; the overlay must appear on Space 2,
// with no Dock icon and no flicker, across several sleep/wake cycles (also with
// a lock/unlock in between). earheart.log should show
// "overlay re-joined all Spaces after resume (now true)".

const { test } = require("node:test");
const assert = require("node:assert");
const wake = require("../main/wake");

function fakePowerMonitor() {
  const handlers = {};
  return {
    handlers,
    on(event, fn) {
      assert.ok(!handlers[event], `${event} registered twice`);
      handlers[event] = fn;
    },
  };
}

function wire({ platform = "darwin", busy = () => false } = {}) {
  const powerMonitor = fakePowerMonitor();
  const rejoins = [];
  const events = wake.init({
    powerMonitor,
    isBusy: busy,
    rejoin: (reason, opts) => rejoins.push([reason, opts]),
    platform,
  });
  return { powerMonitor, rejoins, events };
}

test("darwin: resume and unlock-screen are listened to, and nothing runs until they fire", () => {
  const { powerMonitor, rejoins, events } = wire();
  assert.deepStrictEqual(events, ["resume", "unlock-screen"]);
  assert.deepStrictEqual(Object.keys(powerMonitor.handlers).sort(), ["resume", "unlock-screen"]);
  assert.deepStrictEqual(rejoins, [], "wiring alone re-joins nothing");
});

test("darwin: an idle wake re-joins now, naming the event", () => {
  const { powerMonitor, rejoins } = wire();
  powerMonitor.handlers.resume();
  powerMonitor.handlers["unlock-screen"]();
  assert.deepStrictEqual(rejoins, [
    ["resume", { deferOnly: false }],
    ["unlock-screen", { deferOnly: false }],
  ]);
});

test("darwin: a wake during a dictation only defers, read at wake time", () => {
  let state = "idle";
  const { powerMonitor, rejoins } = wire({ busy: () => state !== "idle" });
  state = "recording";
  powerMonitor.handlers.resume();
  state = "processing";
  powerMonitor.handlers["unlock-screen"]();
  state = "idle";
  powerMonitor.handlers.resume();
  assert.deepStrictEqual(rejoins, [
    ["resume", { deferOnly: true }],
    ["unlock-screen", { deferOnly: true }],
    ["resume", { deferOnly: false }],
  ]);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform}: no listener is registered, so a wake changes nothing`, () => {
    const { powerMonitor, rejoins, events } = wire({ platform });
    assert.deepStrictEqual(events, []);
    assert.deepStrictEqual(powerMonitor.handlers, {});
    assert.deepStrictEqual(rejoins, []);
  });
}

test("a missing powerMonitor is tolerated rather than thrown on", () => {
  assert.deepStrictEqual(wake.init({ powerMonitor: undefined, isBusy: () => false, rejoin: () => {}, platform: "darwin" }), []);
});
