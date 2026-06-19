// Tests for the live-preview partial-transcription state machine. It's pure
// logic with injected dependencies (no Electron, no real engines), so the
// drop-if-busy, staleness, engine-gating, and cancel behaviors can be exercised
// directly.

const { test } = require("node:test");
const assert = require("node:assert");

const { createLivePreview } = require("../main/live-preview");

// A deferred promise so a test can hold a transcribe/cleanup "in flight" and
// resolve it on demand, to drive the busy/stale races deterministically.
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const builtinCfg = (over = {}) => ({
  stt: { engine: "builtin", livePreview: { cleanupPauseMs: 5 }, ...over.stt },
  cleanup: { enabled: true, engine: "builtin", ...over.cleanup },
});

// Build a live-preview harness with controllable deps. `current` toggles whether
// isCurrent() returns true; `sent` collects overlay messages.
function harness({ cfg = builtinCfg(), current = true } = {}) {
  const sent = [];
  const transcribeCalls = [];
  const cleanupCalls = [];
  let transcribeImpl = async () => "hello world";
  let cleanupImpl = async () => "Hello world.";
  const lp = createLivePreview({
    runTranscribe: (...a) => {
      transcribeCalls.push(a);
      return transcribeImpl(...a);
    },
    runCleanup: (...a) => {
      cleanupCalls.push(a);
      return cleanupImpl(...a);
    },
    sendToOverlay: (channel, payload) => sent.push({ channel, payload }),
    getSettings: () => cfg,
    isCurrent: () => current,
  });
  return {
    lp,
    sent,
    transcribeCalls,
    cleanupCalls,
    setTranscribe: (fn) => (transcribeImpl = fn),
    setCleanup: (fn) => (cleanupImpl = fn),
    setCurrent: (v) => (current = v),
  };
}

const wav = new ArrayBuffer(8);
const raws = (h) => h.sent.filter((m) => m.payload.kind === "raw").map((m) => m.payload.text);
const cleans = (h) => h.sent.filter((m) => m.payload.kind === "cleaned").map((m) => m.payload.text);

test("handleAudio sends a raw partial for the active session", async () => {
  const h = harness();
  await h.lp.handleAudio(1, wav);
  assert.deepStrictEqual(raws(h), ["hello world"]);
});

test("handleAudio drops the partial when the session isn't current", async () => {
  const h = harness({ current: false });
  await h.lp.handleAudio(1, wav);
  assert.strictEqual(h.transcribeCalls.length, 0, "no transcribe for a stale session");
  assert.strictEqual(h.sent.length, 0);
});

test("handleAudio skips when the STT engine isn't builtin (no remote hammering)", async () => {
  const h = harness({ cfg: builtinCfg({ stt: { engine: "remote" } }) });
  await h.lp.handleAudio(1, wav);
  assert.strictEqual(h.transcribeCalls.length, 0);
  assert.strictEqual(h.sent.length, 0);
});

test("handleAudio is drop-if-busy: a second call while one is in flight is ignored", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe(() => d.promise);
  const first = h.lp.handleAudio(1, wav); // starts, awaits d
  await h.lp.handleAudio(1, wav); // should be dropped (busy)
  assert.strictEqual(h.transcribeCalls.length, 1, "second concurrent partial dropped");
  d.resolve("done now");
  await first;
});

test("identical consecutive raw text is not re-sent", async () => {
  const h = harness();
  h.setTranscribe(async () => "same text");
  await h.lp.handleAudio(1, wav);
  await h.lp.handleAudio(1, wav);
  assert.deepStrictEqual(raws(h), ["same text"], "duplicate raw suppressed");
});

test("a partial that finishes after the session ends is dropped", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe(() => d.promise);
  const p = h.lp.handleAudio(1, wav);
  h.setCurrent(false); // session ends mid-decode
  d.resolve("late text");
  await p;
  assert.strictEqual(h.sent.length, 0, "stale result not shown");
});

test("cleanup runs over the full raw text after the pause and is sent", async () => {
  const h = harness();
  h.setTranscribe(async () => "the quick brown fox");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "the quick brown fox", "cleanup gets the full raw text");
    return "The quick brown fox.";
  });
  await h.lp.handleAudio(1, wav);
  // Wait past the 5ms cleanupPauseMs for the scheduled cleanup to fire.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(cleans(h), ["The quick brown fox."]);
});

test("cleanup is skipped when cleanup is disabled", async () => {
  const h = harness({ cfg: builtinCfg({ cleanup: { enabled: false, engine: "builtin" } }) });
  await h.lp.handleAudio(1, wav);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(h.cleanupCalls.length, 0);
});

test("cleanup is skipped when the cleanup engine is remote", async () => {
  const h = harness({ cfg: builtinCfg({ cleanup: { enabled: true, engine: "remote" } }) });
  await h.lp.handleAudio(1, wav);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(h.cleanupCalls.length, 0, "remote cleanup not hit mid-dictation");
});

test("cancel aborts in-flight work and resets state so later results are dropped", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe((wavArg, cfg, signal) => {
    // The injected signal should be aborted by cancel().
    return d.promise.then((v) => {
      assert.ok(signal.aborted, "signal aborted by cancel()");
      return v;
    });
  });
  const p = h.lp.handleAudio(1, wav);
  h.lp.cancel();
  d.resolve("after cancel");
  await p;
  assert.strictEqual(h.sent.length, 0, "nothing sent after cancel");

  // After cancel, a fresh partial works again (busy flag was reset).
  h.setTranscribe(async () => "fresh");
  await h.lp.handleAudio(1, wav);
  assert.deepStrictEqual(raws(h), ["fresh"]);
});
