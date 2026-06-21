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
  // Default send records to `sent`; a test can override it to simulate a send
  // that throws (e.g. the overlay torn down mid-pass).
  let sendImpl = (channel, payload) => sent.push({ channel, payload });
  const lp = createLivePreview({
    runTranscribe: (...a) => {
      transcribeCalls.push(a);
      return transcribeImpl(...a);
    },
    runCleanup: (...a) => {
      cleanupCalls.push(a);
      return cleanupImpl(...a);
    },
    sendToOverlay: (channel, payload) => sendImpl(channel, payload),
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
    setSend: (fn) => (sendImpl = fn),
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
// One `tick` (25ms) is sized to comfortably cover one cleanup pause window
// (cleanupPauseMs is 5ms in builtinCfg). Tests that count cleanup passes rely on
// this 5x margin — keep cleanupPauseMs well under tick if either is ever changed.
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

test("cleanup re-cleans the whole committed transcript and replaces the cleaned line", async () => {
  const h = harness();
  h.setTranscribe(async () => "the first chunk");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "the first chunk", "first pass cleans the whole committed transcript");
    return "The first chunk.";
  });
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  assert.strictEqual(lastClean(h), "The first chunk.");

  // A second committed chunk re-cleans the WHOLE transcript (both chunks) and the
  // cleaned line is replaced with that result — not appended per-chunk. Cleaning
  // the whole thing is what makes the live cleaned line read like the final clean.
  h.setTranscribe(async () => "second chunk");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "the first chunk second chunk", "second pass cleans the full transcript");
    return "The first chunk, second chunk.";
  });
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  assert.strictEqual(lastClean(h), "The first chunk, second chunk.", "cleaned line is replaced, not appended");
});

test("no new commit means no redundant re-clean", async () => {
  const h = harness();
  h.setTranscribe(async () => "only chunk");
  await h.lp.handleAudio(1, chunk(0, true)); // commit -> one cleanup pass
  await tick();
  const passesAfterFirst = h.cleanupCalls.length;
  // A growing in-progress (non-final) chunk commits nothing new, so the cleaned
  // line must not be re-cleaned.
  h.setTranscribe(async () => "only chunk more");
  await h.lp.handleAudio(1, chunk(1, false));
  await tick();
  assert.strictEqual(h.cleanupCalls.length, passesAfterFirst, "no extra clean without a new commit");
});

test("an empty cleanup result does not re-clean the same transcript forever", async () => {
  const h = harness();
  h.setTranscribe(async () => "um uh you know");
  // Cleanup legitimately strips an all-filler chunk to nothing.
  h.setCleanup(async () => "");
  await h.lp.handleAudio(1, chunk(0, true)); // commit -> one cleanup pass returns ""
  await tick();
  await tick(); // give any (wrongly) re-armed pause timer room to fire
  // The empty result is recorded as "this snapshot is cleaned", so the pass is
  // not retried: exactly one cleanup call, and nothing painted to the overlay.
  assert.strictEqual(h.cleanupCalls.length, 1, "empty result is not re-cleaned in a loop");
  assert.strictEqual(cleans(h).length, 0, "an empty clean emits no cleaned line");
});

test("consecutive empty results then a real one cleans the whole transcript once", async () => {
  const h = harness();
  // Two filler-only chunks clean to nothing, then a real one.
  h.setTranscribe(async () => "um");
  h.setCleanup(async () => "");
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  h.setTranscribe(async () => "uh");
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  h.setTranscribe(async () => "real");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "um uh real", "the non-empty pass cleans the whole transcript, not a delta");
    return "Real.";
  });
  await h.lp.handleAudio(1, chunk(2, true));
  await tick();
  assert.strictEqual(h.cleanupCalls.length, 3, "each commit cleaned once; no empty-driven loop");
  assert.deepStrictEqual(cleans(h), ["Real."], "the two empties emitted nothing; the real one emitted once");
});

test("an empty result does not poison a later real commit", async () => {
  const h = harness();
  h.setTranscribe(async () => "first");
  h.setCleanup(async () => ""); // empty advances lastCleanedRaw to "first"
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  // A later commit must still re-clean the WHOLE transcript, not skip because
  // the empty pass advanced the marker.
  h.setTranscribe(async () => "second");
  let seen = null;
  h.setCleanup(async (raw) => {
    seen = raw;
    return "First second.";
  });
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  assert.strictEqual(seen, "first second", "the later pass re-cleans the full transcript");
  assert.strictEqual(lastClean(h), "First second.");
});

test("a cleaned send that throws leaves the marker so the next pause retries", async () => {
  const h = harness();
  h.setTranscribe(async () => "the first chunk");
  h.setCleanup(async () => "The first chunk.");
  let throwOnce = true;
  h.setSend((channel, payload) => {
    if (payload.kind === "cleaned" && throwOnce) {
      throwOnce = false;
      throw new Error("overlay gone"); // marker must NOT have advanced yet
    }
    h.sent.push({ channel, payload });
  });
  await h.lp.handleAudio(1, chunk(0, true)); // pass 1: send throws -> catch -> re-arm
  await tick();
  await tick(); // pass 2 resends successfully
  assert.deepStrictEqual(cleans(h), ["The first chunk."], "the cleaned line is retried after a thrown send");
});

test("cancel keeps cleanup drop-if-busy: no second concurrent cleanup mid-flight", async () => {
  const h = harness();
  h.setTranscribe(async () => "old words");
  const d = deferred();
  let inFlight = 0;
  h.setCleanup(() => {
    inFlight++;
    return d.promise;
  });
  await h.lp.handleAudio(1, chunk(0, true)); // cleanup starts, awaits d (inFlight=1)
  await tick();
  h.lp.cancel(); // mid-cleanup — must NOT free cleanupBusy
  // A new session commits while the cancelled session's cleanup is still running.
  h.setTranscribe(async () => "new words");
  await h.lp.handleAudio(2, chunk(0, true));
  await tick();
  assert.strictEqual(inFlight, 1, "the in-flight pass still holds the busy flag; no concurrent second pass");
  d.resolve("done"); // let the in-flight pass settle so no pending promise leaks
  await tick();
});

test("a failed cleanup pass retries on the next pause and recovers", async () => {
  const h = harness();
  h.setTranscribe(async () => "the first chunk");
  let n = 0;
  h.setCleanup(async (raw) => {
    n++;
    if (n === 1) throw new Error("cleanup boom"); // lastCleanedRaw must stay put
    assert.strictEqual(raw, "the first chunk", "the retry re-cleans the whole transcript");
    return "The first chunk.";
  });
  await h.lp.handleAudio(1, chunk(0, true)); // commit -> pass 1 throws -> re-arm
  await tick();
  await tick(); // pass 2 recovers
  assert.ok(n >= 2, "the failed pass was retried");
  assert.deepStrictEqual(cleans(h), ["The first chunk."], "nothing emitted until the recovery");
});

test("a result resolving after the session goes stale is dropped without poisoning later passes", async () => {
  const h = harness();
  h.setTranscribe(async () => "early words");
  const d = deferred();
  h.setCleanup(() => d.promise);
  await h.lp.handleAudio(1, chunk(0, true)); // commit -> pass starts, awaits d
  await tick();
  h.setCurrent(false); // session goes stale mid-cleanup
  d.resolve("Early words.");
  await tick();
  assert.strictEqual(cleans(h).length, 0, "the stale result is dropped");

  // A later, current pass must still clean the WHOLE transcript — proving the
  // dropped pass left lastCleanedRaw untouched rather than marking it cleaned.
  h.setCurrent(true);
  h.setTranscribe(async () => "more words");
  let seen = null;
  h.setCleanup(async (raw) => {
    seen = raw;
    return "Early words, more words.";
  });
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  assert.strictEqual(seen, "early words more words", "the later pass re-cleans the full transcript");
  assert.strictEqual(lastClean(h), "Early words, more words.");
});

test("a later whole-transcript pass rewrites earlier cleaned text (replace, not append)", async () => {
  const h = harness();
  h.setTranscribe(async () => "hello");
  h.setCleanup(async () => "Hello.");
  await h.lp.handleAudio(1, chunk(0, true));
  await tick();
  assert.strictEqual(lastClean(h), "Hello.");

  // The second chunk's whole-transcript clean reworks the earlier sentence too;
  // the cleaned line is replaced with the new result, not appended to the old.
  h.setTranscribe(async () => "there world");
  h.setCleanup(async (raw) => {
    assert.strictEqual(raw, "hello there world", "the pass cleans the full transcript");
    return "Hi there, world.";
  });
  await h.lp.handleAudio(1, chunk(1, true));
  await tick();
  assert.strictEqual(lastClean(h), "Hi there, world.");
  assert.ok(!lastClean(h).startsWith("Hello."), "earlier cleaned text was rewritten, not kept");
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
  // Each pass cleans the exact committed snapshot at its scheduling time — the
  // first the chunk-0 text, the second the full transcript — not a delta or a
  // stale value.
  assert.strictEqual(h.cleanupCalls[0][0], "chunk zero", "first pass cleaned the chunk-0 snapshot");
  assert.strictEqual(h.cleanupCalls[1][0], "chunk zero chunk one", "second pass cleaned the full snapshot");
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
