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

test("waitForLoad rejects at once when the main frame fails to load", async () => {
  const wc = fakeWebContents();
  const started = Date.now();
  const wait = waitForLoad(wc, 5000);
  // Electron: did-fail-load(event, errorCode, errorDescription, validatedURL, isMainFrame)
  wc.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///missing.html", true);
  await assert.rejects(wait, (err) => {
    assert.strictEqual(
      err.message,
      "waitForLoad: page failed to load: ERR_FILE_NOT_FOUND (-6) file:///missing.html"
    );
    return true;
  });
  assert.ok(Date.now() - started < 1000, "fails on the event, not at the deadline");
  assert.strictEqual(wc.listenerCount("did-finish-load"), 0);
  assert.strictEqual(wc.listenerCount("did-fail-load"), 0);
});

test("waitForLoad ignores subframe failures and aborted navigations", async () => {
  const wc = fakeWebContents();
  const wait = waitForLoad(wc, 1000);
  wc.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///iframe.html", false);
  wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///page.html", true);
  wc.emit("did-finish-load");
  await wait;
  assert.strictEqual(wc.listenerCount("did-fail-load"), 0);
});

test("waitForLoad defaults to a 15 s deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wc = fakeWebContents();
  const wait = waitForLoad(wc);
  const settled = wait.then(() => "resolved", () => "rejected");
  t.mock.timers.tick(14999);
  assert.strictEqual(
    await Promise.race([settled, Promise.resolve("pending")]),
    "pending",
    "still waiting just before the default deadline"
  );
  t.mock.timers.tick(1);
  await assert.rejects(wait, /within 15000 ms/);
});

test("waitForLoad cancels its deadline timer once the page loads", async () => {
  const activeTimeouts = () =>
    process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const wc = fakeWebContents();
  const before = activeTimeouts();
  const wait = waitForLoad(wc, 60_000);
  assert.strictEqual(activeTimeouts(), before + 1, "the deadline timer is armed");
  wc.emit("did-finish-load");
  await wait;
  assert.strictEqual(activeTimeouts(), before, "the deadline timer is cleared");
});
