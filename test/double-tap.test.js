const { test } = require("node:test");
const assert = require("node:assert");
const dt = require("../main/double-tap");

// A fake clock whose timers fire as time is advanced; no real waiting.
function harness({ windowMs = 500, state = "idle" } = {}) {
  let t = 1000;
  let timers = [];
  const log = [];
  const h = {
    state,
    log,
    rec: null,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
    pendingTimers: () => timers.length,
  };
  h.rec = dt.createDoubleTap({
    getState: () => h.state,
    start: () => {
      log.push("start");
      h.state = "recording";
    },
    stop: () => {
      log.push("stop");
      h.state = "idle";
    },
    windowMs: () => windowMs,
    now: () => t,
    setTimer: (fn, ms) => {
      const x = { fn, at: t + ms };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      timers = timers.filter((y) => y !== x);
    },
  });
  return h;
}

test("a valid double tap starts exactly one session, after the settle check", () => {
  const h = harness();
  h.rec.press();
  h.advance(200);
  h.rec.press();
  assert.deepStrictEqual(h.log, []);
  h.advance(dt.SETTLE_MS - 1);
  assert.deepStrictEqual(h.log, []);
  h.advance(1);
  assert.deepStrictEqual(h.log, ["start"]);
  h.advance(5000);
  assert.deepStrictEqual(h.log, ["start"]);
});

test("a single tap does nothing, and neither does a slow second tap", () => {
  const h = harness({ windowMs: 500 });
  h.rec.press();
  h.advance(5000);
  assert.deepStrictEqual(h.log, []);
  h.rec.press();
  h.advance(600); // past the window: this is a new first tap
  h.rec.press();
  h.advance(1000);
  assert.deepStrictEqual(h.log, []);
});

test("the window is honoured per call", () => {
  const h = harness({ windowMs: 1000 });
  h.rec.press();
  h.advance(900);
  h.rec.press();
  h.advance(500);
  assert.deepStrictEqual(h.log, ["start"]);
});

test("a held key (slow first repeat, then fast repeats) never latches", () => {
  const h = harness();
  h.rec.press();
  h.advance(300); // first auto-repeat
  h.rec.press();
  for (let i = 0; i < 20; i++) {
    h.advance(33);
    h.rec.press();
  }
  h.advance(2000);
  assert.deepStrictEqual(h.log, []);
});

test("a held key stays ignored until quiet, then taps work again", () => {
  const h = harness();
  h.rec.press();
  h.advance(300);
  h.rec.press();
  h.advance(33);
  h.rec.press(); // dropped
  h.advance(100);
  h.rec.press(); // still in the quiet period
  h.advance(dt.QUIET_MS + 10);
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.advance(500);
  assert.deepStrictEqual(h.log, ["start"]);
});

test("double tap whose second tap is held does not stop itself", () => {
  const h = harness();
  h.rec.press();
  h.advance(150);
  h.rec.press(); // held from here
  h.advance(dt.SETTLE_MS); // latched
  assert.deepStrictEqual(h.log, ["start"]);
  h.advance(130); // first auto-repeat of the still-held key
  h.rec.press();
  for (let i = 0; i < 30; i++) {
    h.advance(33);
    h.rec.press();
  }
  assert.deepStrictEqual(h.log, ["start"]);
});

test("a single press stops a live dictation at once, once", () => {
  const h = harness();
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.advance(dt.SETTLE_MS + dt.STOP_GUARD_MS);
  h.rec.press();
  assert.deepStrictEqual(h.log, ["start", "stop"]);
  h.advance(50);
  h.rec.press(); // autorepeat-fast duplicate: now idle, counts as a first tap only
  assert.deepStrictEqual(h.log, ["start", "stop"]);
});

test("a press while processing never starts or double-stops", () => {
  const h = harness({ state: "processing" });
  h.rec.press();
  h.advance(200);
  h.rec.press();
  h.advance(1000);
  // stop() is delegated to the pipeline, which ignores processing; the
  // recognizer must never latch a start.
  assert.ok(!h.log.includes("start"));
});

test("a settle timer that fires after the state changed does not start", () => {
  const h = harness();
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.state = "recording"; // started from the tray in the meantime
  h.advance(dt.SETTLE_MS + 10);
  assert.deepStrictEqual(h.log, []);
});

test("reset (state or settings change) cancels a pending sequence", () => {
  const h = harness();
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.rec.reset();
  h.advance(1000);
  assert.deepStrictEqual(h.log, []);
  assert.strictEqual(h.pendingTimers(), 0);
  h.rec.press();
  h.rec.reset();
  h.advance(100);
  h.rec.press(); // first tap again after reset, not a second
  h.advance(1000);
  assert.deepStrictEqual(h.log, []);
});

test("dispose cancels timers and ignores later presses", () => {
  const h = harness();
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.rec.dispose();
  assert.strictEqual(h.pendingTimers(), 0);
  h.advance(1000);
  h.rec.press();
  h.advance(150);
  h.rec.press();
  h.advance(1000);
  assert.deepStrictEqual(h.log, []);
});
