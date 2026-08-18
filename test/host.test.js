// Tests for the engine-worker host's request/reply protocol, in particular the
// interim { id, progress } messages. Electron's utilityProcess is stubbed with
// a fake child so the protocol can be exercised without the Electron runtime.
//
// Unlike engines.test.js (whose module under test requires electron eagerly at
// load), host.js requires electron lazily inside spawn() — at request time. So
// the stub can't be install-load-restore; it stays in require.cache for this
// whole test file, routing fork() to whichever fake child the current test set.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

// A minimal utilityProcess child: records postMessage calls and lets the test
// fire "message"/"exit" events at the host.
function createFakeChild() {
  const listeners = { message: [], exit: [] };
  return {
    sent: [],
    postMessage(msg) {
      this.sent.push(msg);
    },
    on(event, cb) {
      listeners[event].push(cb);
    },
    emit(event, payload) {
      for (const cb of listeners[event]) cb(payload);
    },
    kill() {},
  };
}

let currentChild = null;

const hostPath = require.resolve("../main/engines/host");
const electronPath = require.resolve("electron", {
  paths: [path.dirname(hostPath)],
});
{
  const m = new Module(electronPath, null);
  m.filename = electronPath;
  m.loaded = true;
  m.exports = { utilityProcess: { fork: () => currentChild } };
  require.cache[electronPath] = m;
}
const { createHost } = require(hostPath);

// Fresh child + host pair for one test.
function setup() {
  currentChild = createFakeChild();
  return { child: currentChild, host: createHost() };
}

test("host: progress messages invoke onProgress without settling the request", async () => {
  const { child, host } = setup();

  const seen = [];
  const promise = host.request("clean", { transcript: "x" }, {
    onProgress: (p) => seen.push(p),
  });
  const { id } = child.sent[0];

  child.emit("message", { id, progress: 0.25 });
  child.emit("message", { id, progress: 0.5 });
  assert.deepStrictEqual(seen, [0.25, 0.5]);

  child.emit("message", { id, ok: true, result: "cleaned" });
  assert.strictEqual(await promise, "cleaned");
});

test("host: progress without an onProgress callback is a no-op", async () => {
  const { child, host } = setup();

  const promise = host.request("clean", {});
  const { id } = child.sent[0];
  child.emit("message", { id, progress: 0.5 }); // must not throw or settle
  child.emit("message", { id, ok: true, result: "ok" });
  assert.strictEqual(await promise, "ok");
});

test("host: non-numeric progress is dropped without touching the timeout", async () => {
  // The protocol promises finite numbers; a malformed message must neither
  // reach the caller nor re-arm the silence deadline.
  const { child, host } = setup();

  const seen = [];
  const promise = host.request("clean", {}, {
    timeoutMs: 30,
    onProgress: (p) => seen.push(p),
  });
  const { id } = child.sent[0];
  child.emit("message", { id, progress: "0.5" });
  child.emit("message", { id, progress: { sneaky: true } });
  child.emit("message", { id, progress: NaN });
  await assert.rejects(promise, /timed out/); // garbage never extended the clock
  assert.deepStrictEqual(seen, []);
});

test("host: progress after the reply (or for an unknown id) is dropped", async () => {
  const { child, host } = setup();

  const seen = [];
  const promise = host.request("clean", {}, { onProgress: (p) => seen.push(p) });
  const { id } = child.sent[0];
  child.emit("message", { id, ok: true, result: "done" });
  child.emit("message", { id, progress: 0.9 }); // late: entry already consumed
  child.emit("message", { id: 999, progress: 0.1 }); // never existed
  assert.strictEqual(await promise, "done");
  assert.deepStrictEqual(seen, []);
});

test("host: a request times out on silence, and progress resets the clock", async () => {
  const { child, host } = setup();

  // Silent worker: the request must reject at the deadline.
  await assert.rejects(
    host.request("clean", {}, { timeoutMs: 20 }),
    /timed out/
  );

  // Progressing worker: each interim message re-arms the timer, so the request
  // survives well past a single timeout window and still resolves. Margins are
  // generous (50ms cadence vs 150ms window) so scheduler jitter on a loaded
  // runner can't push a sleep past the deadline and flake the test.
  const promise = host.request("clean", {}, { timeoutMs: 150 });
  const { id } = child.sent[child.sent.length - 1];
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 50));
    child.emit("message", { id, progress: (i + 1) / 10 });
  }
  child.emit("message", { id, ok: true, result: "slow but alive" });
  assert.strictEqual(await promise, "slow but alive");
});

test("host: concurrent requests get their own progress, routed by id", async () => {
  // The pending map supports overlapping requests (a Settings test action can
  // overlap a dictation). A regression stashing the callback host-wide instead
  // of per-entry would cross-wire request B's bar with request A's progress —
  // and pass every single-request test.
  const { child, host } = setup();

  const seenA = [];
  const seenB = [];
  const promiseA = host.request("clean", {}, { onProgress: (p) => seenA.push(p) });
  const promiseB = host.request("clean", {}, { onProgress: (p) => seenB.push(p) });
  const idA = child.sent[0].id;
  const idB = child.sent[1].id;

  child.emit("message", { id: idA, progress: 0.3 });
  child.emit("message", { id: idB, progress: 0.7 });
  assert.deepStrictEqual(seenA, [0.3]);
  assert.deepStrictEqual(seenB, [0.7]);

  child.emit("message", { id: idA, ok: true, result: "a" });
  child.emit("message", { id: idB, ok: true, result: "b" });
  assert.strictEqual(await promiseA, "a");
  assert.strictEqual(await promiseB, "b");
});

test("host: progress re-arms the timeout, it doesn't disable it", async () => {
  // The deadline bounds silence, not total duration — so after progress STOPS,
  // the clock must still be running. A touch() that merely cleared the timer
  // would pass the silent-timeout and progress-until-reply tests but hang the
  // pipeline forever on a worker that emits once and then wedges.
  const { child, host } = setup();

  const promise = host.request("clean", {}, {
    timeoutMs: 100,
    onProgress: () => {},
  });
  const { id } = child.sent[0];
  await new Promise((r) => setTimeout(r, 30)); // well inside the first window
  child.emit("message", { id, progress: 0.1 });
  // Worker goes silent: the re-armed deadline must still fire.
  await assert.rejects(promise, /timed out/);
});

test("host: worker exit rejects in-flight requests", async () => {
  const { child, host } = setup();

  const promise = host.request("transcribe", {});
  child.emit("exit");
  await assert.rejects(promise, /engine process exited/);
});

test("host: busy() tracks in-flight requests", async () => {
  // Idle eviction asks busy() whether the worker can be killed, so an
  // off-by-one here either kills a worker mid-request or never kills one.
  const { child, host } = setup();

  assert.strictEqual(host.busy(), false, "nothing requested yet");
  const promise = host.request("transcribe", {});
  assert.strictEqual(host.busy(), true, "a request is in flight");

  const { id } = child.sent[0];
  child.emit("message", { id, ok: true, result: "done" });
  assert.strictEqual(await promise, "done");
  assert.strictEqual(host.busy(), false, "a settled request is no longer pending");
});

test("host: stop() rejects in-flight requests and notifies exit listeners", async () => {
  // stop() is the idle-eviction path, not just the quit path: index.js clears
  // its loaded-model flags from the exit listeners, so a stop() that killed the
  // worker without notifying would leave the facade believing a dead worker
  // still had a model resident.
  const { host } = setup();
  let exits = 0;
  host.onExit(() => exits++);

  // A short deadline so a stop() that forgot to drain fails the assertion
  // below rather than hanging this test forever on an unsettled promise.
  const promise = host.request("transcribe", {}, { timeoutMs: 50 });
  host.stop();

  await assert.rejects(promise, /engine process exited/);
  assert.strictEqual(exits, 1, "callers must be told the worker is gone");
  assert.strictEqual(host.busy(), false, "stop() drains pending");

  // Stopping again with no worker is a no-op, not a second spurious notify.
  host.stop();
  assert.strictEqual(exits, 1);
});

test("host: a retired worker can't clobber its successor", async () => {
  // The race idle eviction made reachable: stop() kills worker A and a new
  // request forks successor B before A's async "exit" lands. Without the
  // `child !== proc` guards, A's late events would reject B's in-flight
  // request and re-fire the exit listeners, wrongly forgetting a model B just
  // loaded. Nothing else exercises those guards — engines.test.js stubs this
  // module out entirely.
  const { child: a, host } = setup();
  let exits = 0;
  host.onExit(() => exits++);

  const first = host.request("transcribe", {});
  a.emit("message", { id: a.sent[0].id, ok: true, result: "from A" });
  assert.strictEqual(await first, "from A");

  host.stop(); // idle eviction; the fake kill() leaves `a` able to emit
  assert.strictEqual(exits, 1);

  const b = (currentChild = createFakeChild());
  const second = host.request("transcribe", {});
  assert.strictEqual(b.sent.length, 1, "the request went to the successor");

  a.emit("exit"); // the real OS event, arriving after the successor exists
  assert.strictEqual(exits, 1, "a retired worker must not re-fire exit listeners");
  assert.strictEqual(host.busy(), true, "B's request must still be in flight");

  // Ids are host-wide and monotonic, so a real A could never reuse B's id —
  // forcing the collision here is what pins the message-handler guard.
  a.emit("message", { id: b.sent[0].id, ok: true, result: "stale from A" });
  b.emit("message", { id: b.sent[0].id, ok: true, result: "from B" });
  assert.strictEqual(await second, "from B");
});
