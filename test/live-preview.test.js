// Tests for the live-preview partial-transcription state machine. It's pure
// logic with injected dependencies (no Electron, no real engines), so the
// append-only chunking, drop-if-busy, staleness, engine-gating, and cancel
// behaviors can be exercised directly.

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
  let cleanupImpl = async (raw) => raw;
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
// A chunk payload: seq + final flag + audio.
const chunk = (seq, final) => ({ seq, final, wav });
const raws = (h) => h.sent.filter((m) => m.payload.kind === "raw").map((m) => m.payload.text);
const cleans = (h) => h.sent.filter((m) => m.payload.kind === "cleaned").map((m) => m.payload.text);
const lastRaw = (h) => raws(h).at(-1);
const lastClean = (h) => cleans(h).at(-1);
const tick = () => new Promise((r) => setTimeout(r, 25));

test("an in-progress chunk shows as the live raw tail", async () => {
  const h = harness();
  h.setTranscribe(async () => "the quick");
  await h.lp.handleAudio(1, chunk(0, false));
  assert.strictEqual(lastRaw(h), "the quick");
});

test("committing a chunk accumulates; the next chunk appends, not replaces", async () => {
  const h = harness();
  h.setTranscribe(async () => "first chunk");
  await h.lp.handleAudio(1, chunk(0, true)); // commit chunk 0
  assert.strictEqual(lastRaw(h), "first chunk");

  h.setTranscribe(async () => "second part");
  await h.lp.handleAudio(1, chunk(1, false)); // in-progress chunk 1
  // Committed chunk 0 is preserved; chunk 1 appends as the live tail.
  assert.strictEqual(lastRaw(h), "first chunk second part");
});

test("a growing in-progress chunk replaces only the live tail", async () => {
  const h = harness();
  h.setTranscribe(async () => "alpha");
  await h.lp.handleAudio(1, chunk(0, true)); // commit "alpha"
  h.setTranscribe(async () => "beta");
  await h.lp.handleAudio(1, chunk(1, false)); // tail "beta"
  h.setTranscribe(async () => "beta gamma");
  await h.lp.handleAudio(1, chunk(1, false)); // same seq grows
  assert.strictEqual(lastRaw(h), "alpha beta gamma", "tail replaced, commit preserved");
});

test("handleAudio drops the partial when the session isn't current", async () => {
  const h = harness({ current: false });
  await h.lp.handleAudio(1, chunk(0, false));
  assert.strictEqual(h.transcribeCalls.length, 0);
  assert.strictEqual(h.sent.length, 0);
});

test("handleAudio skips when the STT engine isn't builtin (no remote hammering)", async () => {
  const h = harness({ cfg: builtinCfg({ stt: { engine: "remote" } }) });
  await h.lp.handleAudio(1, chunk(0, false));
  assert.strictEqual(h.transcribeCalls.length, 0);
  assert.strictEqual(h.sent.length, 0);
});

test("handleAudio is drop-if-busy: a second call while one is in flight is ignored", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe(() => d.promise);
  const first = h.lp.handleAudio(1, chunk(0, false));
  await h.lp.handleAudio(1, chunk(0, false)); // dropped (busy)
  assert.strictEqual(h.transcribeCalls.length, 1);
  d.resolve("done now");
  await first;
});

test("identical in-progress text is not re-sent", async () => {
  const h = harness();
  h.setTranscribe(async () => "same text");
  await h.lp.handleAudio(1, chunk(0, false));
  await h.lp.handleAudio(1, chunk(0, false));
  assert.deepStrictEqual(raws(h), ["same text"]);
});

test("a chunk that finishes decoding after the session ends is dropped", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe(() => d.promise);
  const p = h.lp.handleAudio(1, chunk(0, false));
  h.setCurrent(false); // session ends mid-decode
  d.resolve("late text");
  await p;
  assert.strictEqual(h.sent.length, 0);
});

test("cleanup runs only on newly committed text and appends to the cleaned line", async () => {
  const h = harness();
  h.setTranscribe(async () => "the first chunk");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "the first chunk", "cleanup gets only the committed chunk text");
    return "The first chunk.";
  });
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  assert.strictEqual(lastClean(h), "The first chunk.");

  // A second committed chunk cleans only the new text, appended to the line.
  h.setTranscribe(async () => "second chunk");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "second chunk", "second pass cleans only the new chunk");
    return "Second chunk.";
  });
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  assert.strictEqual(lastClean(h), "The first chunk. Second chunk.", "cleaned line accumulates");
});

test("cleanup is skipped when cleanup is disabled", async () => {
  const h = harness({ cfg: builtinCfg({ cleanup: { enabled: false, engine: "builtin" } }) });
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  assert.strictEqual(h.cleanupCalls.length, 0);
});

test("cleanup is skipped when the cleanup engine is remote", async () => {
  const h = harness({ cfg: builtinCfg({ cleanup: { enabled: true, engine: "remote" } }) });
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  assert.strictEqual(h.cleanupCalls.length, 0);
});

test("an in-progress (non-final) chunk does not trigger cleanup", async () => {
  const h = harness();
  await h.lp.handleAudio(1, chunk(0, false)); // not committed
  await tick();
  assert.strictEqual(h.cleanupCalls.length, 0, "only committed chunks are cleaned");
});

test("cancel aborts in-flight work and resets accumulators", async () => {
  const h = harness();
  const d = deferred();
  h.setTranscribe((wavArg, cfg, signal) =>
    d.promise.then((v) => {
      assert.ok(signal.aborted, "signal aborted by cancel()");
      return v;
    })
  );
  const p = h.lp.handleAudio(1, chunk(0, false));
  h.lp.cancel();
  d.resolve("after cancel");
  await p;
  assert.strictEqual(h.sent.length, 0, "nothing sent after cancel");

  // After cancel, accumulators are reset: a fresh chunk 0 starts clean.
  h.setTranscribe(async () => "fresh");
  await h.lp.handleAudio(1, chunk(0, false));
  assert.deepStrictEqual(raws(h), ["fresh"]);
});

test("cleanup re-arms when more committed while a cleanup pass ran", async () => {
  const h = harness();
  h.setTranscribe(async () => "chunk zero");
  const d1 = deferred();
  let cleanupN = 0;
  h.setCleanup(async (raw) => {
    cleanupN++;
    if (cleanupN === 1) {
      // While this first cleanup is in flight, another chunk commits.
      h.setTranscribe(async () => "chunk one");
      await h.lp.handleAudio(1, chunk(1, true));
      return d1.promise;
    }
    return `cleaned:${raw}`;
  });

  await h.lp.handleAudio(1, chunk(0, true)); // commit chunk 0 -> schedules cleanup
  await tick(); // first cleanup starts, awaits d1
  d1.resolve("cleaned:chunk zero");
  await tick(); // re-arm fires for the newly committed chunk 1

  assert.strictEqual(cleanupN, 2, "a second cleanup pass ran for the later chunk");
  assert.ok(cleans(h).some((t) => t.includes("chunk one")), "the later chunk was cleaned");
});

test("cancel during a cleanup await prevents a re-armed pause timer", async () => {
  const h = harness();
  h.setTranscribe(async () => "c-zero");
  const d = deferred();
  let cleanupN = 0;
  h.setCleanup(async () => {
    cleanupN++;
    h.setTranscribe(async () => "c-one");
    await h.lp.handleAudio(1, chunk(1, true)); // more committed during the await
    return d.promise;
  });

  await h.lp.handleAudio(1, chunk(0, true));
  await tick(); // cleanup in flight
  h.lp.cancel();
  d.resolve("late cleaned");
  await tick();

  assert.strictEqual(cleanupN, 1, "no second cleanup after cancel");
  assert.strictEqual(cleans(h).length, 0, "cancelled cleanup result not sent");
});
