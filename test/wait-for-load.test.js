const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { waitForLoad } = require("../scripts/wait-for-load");

// A stand-in for Electron's webContents: only the event surface the helper uses.
function fakeWebContents() {
  return new EventEmitter();
}

test("waitForLoad resolves when did-finish-load fires", async () => {
  const wc = fakeWebContents();
  const wait = waitForLoad(wc, 1000);
  wc.emit("did-finish-load");
  await wait;
  assert.strictEqual(wc.listenerCount("did-finish-load"), 0);
});

test("waitForLoad rejects with a named error when the load never finishes", async () => {
  const wc = fakeWebContents();
  const started = Date.now();
  await assert.rejects(
    waitForLoad(wc, 20),
    (err) => {
      assert.strictEqual(
        err.message,
        "waitForLoad: page did not finish loading within 20 ms"
      );
      return true;
    }
  );
  assert.ok(Date.now() - started < 1000, "fails at the deadline, not later");
});

test("waitForLoad removes its listener after timing out", async () => {
  const wc = fakeWebContents();
  await assert.rejects(waitForLoad(wc, 20));
  assert.strictEqual(wc.listenerCount("did-finish-load"), 0);
  // A late load must not throw or resolve anything.
  wc.emit("did-finish-load");
});
