// The failed-take holder (#293): one recording, in memory, for a stated time.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFailedTake, FAILED_TAKE_TTL_MS } = require("../main/failed-take");
const { encodeSilenceWav } = require("../main/util/wav");

// Deterministic clock and timers: `advance` fires whatever is due.
function fakeTime() {
  let now = 1_000_000;
  const timers = new Map();
  let next = 0;
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

function holder(extra = {}) {
  const time = fakeTime();
  const changes = [];
  const take = createFailedTake({
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onChange: (info) => changes.push(info),
    ...extra,
  });
  return { take, time, changes };
}

const wav = (seconds) => encodeSilenceWav(seconds);

test("failed take: holds one recording and says how long for", () => {
  const { take, changes } = holder();
  assert.equal(take.info(), null);
  const recording = wav(3);
  const info = take.keep(recording);
  assert.equal(info.bytes, recording.length);
  assert.equal(Math.round(info.seconds), 3);
  assert.equal(info.expiresInSec, FAILED_TAKE_TTL_MS / 1000);
  assert.equal(changes.length, 1);
  assert.deepEqual(take.info(), info);
});

test("failed take: a retry takes it out, so it can't run twice", () => {
  const { take, time, changes } = holder();
  const recording = wav(1);
  take.keep(recording);
  assert.equal(take.take(), recording);
  assert.equal(take.take(), null, "nothing left for a second retry");
  assert.equal(take.info(), null);
  assert.equal(time.pending(), 0, "the expiry timer is released too");
  assert.deepEqual(changes.at(-1), null);
});

test("failed take: expires after its lifetime, and not before", () => {
  const { take, time, changes } = holder();
  take.keep(wav(1));
  time.advance(FAILED_TAKE_TTL_MS - 1);
  assert.notEqual(take.info(), null);
  time.advance(1);
  assert.equal(take.info(), null);
  assert.deepEqual(changes.at(-1), null, "the expiry is announced");
});

test("failed take: a newer failure replaces it, with a fresh lifetime", () => {
  const { take, time } = holder();
  take.keep(wav(1));
  time.advance(FAILED_TAKE_TTL_MS - 1000);
  const newer = wav(2);
  take.keep(newer);
  assert.equal(time.pending(), 1, "the old take's timer is gone");
  time.advance(5000);
  assert.equal(take.take(), newer, "the old timer didn't drop the new take");
});

test("failed take: discard releases it and reports whether there was one", () => {
  const { take, time, changes } = holder();
  assert.equal(take.discard(), false);
  assert.equal(changes.length, 0, "nothing to announce");
  take.keep(wav(1));
  assert.equal(take.discard(), true);
  assert.equal(take.info(), null);
  assert.equal(time.pending(), 0);
  assert.deepEqual(changes.at(-1), null);
});

test("failed take: a throwing listener never costs the recording", () => {
  const { take } = holder({ onChange: () => { throw new Error("tray gone"); } });
  const recording = wav(1);
  assert.doesNotThrow(() => take.keep(recording));
  assert.equal(take.take(), recording);
});

test("failed take: the real expiry timer doesn't keep the process alive", () => {
  let timer;
  const take = createFailedTake({ setTimer: (fn, ms) => (timer = setTimeout(fn, ms)) });
  take.keep(wav(1));
  assert.equal(timer.hasRef(), false);
  take.discard(); // and leave nothing behind
});
