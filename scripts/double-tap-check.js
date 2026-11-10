// Real-event acceptance for double-tap activation (Linux/X11; run under Xvfb:
// `make double-tap-check`). Registers a real Electron globalShortcut, feeds
// its callbacks to the real recognizer, and drives the keyboard with xdotool,
// so OS key events and X auto-repeat (not mocked callbacks) are what is tested.
const { app, globalShortcut } = require("electron");
const { spawnSync } = require("node:child_process");
const { createDoubleTap } = require("../main/double-tap");

const KEY = "CommandOrControl+Alt+P";
const XKEY = "ctrl+alt+p";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xdo = (...args) => {
  const r = spawnSync("xdotool", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`xdotool ${args.join(" ")}: ${r.stderr}`);
};

let state = "idle";
let presses = 0;
const events = [];
const recognizer = createDoubleTap({
  getState: () => state,
  start: () => { events.push("start"); state = "recording"; },
  stop: () => { events.push("stop"); state = "idle"; },
});

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`[double-tap-check] ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (${detail})`}`);
}
async function scenario(name, run, expected, minPresses = 1) {
  state = "idle";
  events.length = 0;
  presses = 0;
  recognizer.reset();
  await sleep(900); // let any previous quiet period lapse
  await run();
  await sleep(1000);
  check(
    name,
    presses >= minPresses && JSON.stringify(events) === JSON.stringify(expected),
    `${presses} presses reached the app, got ${JSON.stringify(events)}`
  );
}

app.whenReady().then(async () => {
  if (process.platform !== "linux") {
    console.log("[double-tap-check] skipped: X11 only");
    return app.exit(0);
  }
  const registered = globalShortcut.register(KEY, () => { presses++; recognizer.press(); });
  if (!registered) {
    console.error("[double-tap-check] FAIL could not register a real global shortcut");
    return app.exit(1);
  }
  try {
    await scenario("single tap does nothing", async () => xdo("key", XKEY), []);
    await scenario("a real double tap starts exactly once", async () => {
      xdo("key", XKEY);
      await sleep(150);
      xdo("key", XKEY);
    }, ["start"], 2);
    await scenario("a double tap then a single tap starts then stops", async () => {
      xdo("key", XKEY);
      await sleep(150);
      xdo("key", XKEY);
      await sleep(1200);
      xdo("key", XKEY);
    }, ["start", "stop"], 3);
    await scenario("a held key (real X auto-repeat) never latches", async () => {
      xdo("keydown", XKEY);
      await sleep(1500);
      xdo("keyup", XKEY);
    }, [], 5); // real auto-repeat must have reached the app, else this proves nothing
    await scenario("two taps past the window do not latch", async () => {
      xdo("key", XKEY);
      await sleep(900);
      xdo("key", XKEY);
    }, [], 2);
  } catch (err) {
    console.error(`[double-tap-check] FAIL ${err.message}`);
    results.push(false);
  }
  globalShortcut.unregisterAll();
  recognizer.dispose();
  app.exit(results.every(Boolean) ? 0 : 1);
});
