// Tests for piecewise built-in decoding: a recording reaches the STT worker
// one stretch of speech at a time (cut at pauses, never over the cap), every
// decoded word survives a piece failing (golden rule 8), and a dead or wedged
// worker gets exactly one retry.

const { test } = require("node:test");
const assert = require("node:assert");

const { transcribeChunked, joinRaw, MAX_DECODE_SECONDS } = require("../main/chunked-decode");
const { encodeWav, wavDurationSec, wavSampleFrames } = require("../main/util/wav");

const SR = 16000;

// `seconds` of loud sound, silent inside the given [startSec, endSec] gaps.
function wav(seconds, gaps = []) {
  const samples = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 ? 8000 : -8000;
  for (const [from, to] of gaps) samples.fill(0, Math.floor(from * SR), Math.floor(to * SR));
  return encodeWav(samples, SR);
}

const engineError = (code, exitCode) =>
  Object.assign(new Error(code === "ENGINE_TIMEOUT" ? "engine request 'transcribe' timed out" : "engine process exited"), { code, exitCode });

// A fake worker: decodes attempt N to "aN", records every input's duration, and
// fails the attempts listed in `failures` ({ [attemptIndex]: error }).
function fakeWorker(failures = {}) {
  const inputs = [];
  let attempt = 0;
  return {
    inputs,
    async runTranscribe(w, { onDecodeMs } = {}) {
      const n = attempt++;
      inputs.push(wavDurationSec(w));
      if (failures[n]) throw failures[n];
      if (onDecodeMs) onDecodeMs(100);
      return `a${n}`;
    },
  };
}

test("chunked decode: the backstop cap is 20 s", () => {
  assert.strictEqual(MAX_DECODE_SECONDS, 20);
});

test("chunked decode: speech with no pause under the cap is one decode, untouched", async () => {
  const w = fakeWorker();
  const input = wav(15);
  const r = await transcribeChunked(input, { runTranscribe: w.runTranscribe });
  assert.deepStrictEqual(w.inputs, [15]);
  assert.strictEqual(r.text, "a0");
  assert.strictEqual(r.partial, false);
  assert.deepStrictEqual(r.pieces.map((p) => [p.fromFrame, p.toFrame, p.ok]), [[0, 15 * SR, true]]);
});

test("chunked decode: each stretch between pauses is its own decode", async () => {
  // Two utterances sharing one decode is what makes the model drop one.
  const w = fakeWorker();
  const r = await transcribeChunked(wav(10, [[4, 4.4]]), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 2);
  assert.ok(Math.abs(w.inputs[0] - 4.2) < 0.06, `first piece ${w.inputs[0]}s`);
  assert.strictEqual(r.text, "a0 a1");
  // With pause cuts off (the eval script's cap-only mode) it is one decode.
  const w2 = fakeWorker();
  await transcribeChunked(wav(10, [[4, 4.4]]), { runTranscribe: w2.runTranscribe, minPauseSec: Infinity });
  assert.strictEqual(w2.inputs.length, 1);
});

test("chunked decode: no worker input exceeds the cap, pieces tile the recording in order", async () => {
  for (const [seconds, gaps] of [[21, []], [124.5, [[30, 30.5]]], [182.9, []], [310.9, [[100, 100.3], [200, 201]]], [600, []]]) {
    const w = fakeWorker();
    const input = wav(seconds, gaps);
    const decodeMs = [];
    const r = await transcribeChunked(input, { runTranscribe: w.runTranscribe, onDecodeMs: (ms) => decodeMs.push(ms) });
    for (const sec of w.inputs) assert.ok(sec <= 20, `${seconds}s: a ${sec}s decode`);
    assert.strictEqual(r.pieces[0].fromFrame, 0);
    assert.strictEqual(r.pieces.at(-1).toFrame, wavSampleFrames(input));
    for (let i = 1; i < r.pieces.length; i++) assert.strictEqual(r.pieces[i].fromFrame, r.pieces[i - 1].toFrame);
    assert.strictEqual(r.text, w.inputs.map((_, i) => `a${i}`).join(" "));
    assert.strictEqual(r.partial, false);
    assert.strictEqual(decodeMs.length, w.inputs.length, "every piece reports its decode time");
  }
});

test("chunked decode: the trusted committed prefix leads the text", async () => {
  const w = fakeWorker();
  const r = await transcribeChunked(wav(30), { runTranscribe: w.runTranscribe, prefixText: "committed words" });
  assert.strictEqual(r.text, "committed words a0 a1");
});

test("chunked decode: a worker exit is retried once on a fresh worker", async () => {
  const w = fakeWorker({ 1: engineError("ENGINE_EXITED", 134) });
  let restarts = 0;
  const r = await transcribeChunked(wav(30), { runTranscribe: w.runTranscribe, restartStt: () => restarts++ });
  // piece 0 = a0; piece 1 dies (attempt 1) and succeeds on retry (attempt 2).
  assert.strictEqual(r.text, "a0 a2");
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.pieces[1].attempts, 2);
  assert.strictEqual(restarts, 0, "an exited worker is already gone; the host re-forks on the next request");
});

test("chunked decode: a timeout retires the wedged worker before the retry", async () => {
  const w = fakeWorker({ 0: engineError("ENGINE_TIMEOUT") });
  let restarts = 0;
  const r = await transcribeChunked(wav(30), { runTranscribe: w.runTranscribe, restartStt: () => restarts++ });
  assert.strictEqual(restarts, 1);
  assert.strictEqual(r.text, "a1 a2");
  assert.strictEqual(r.partial, false);
});

test("chunked decode: a piece that fails twice is skipped, later pieces still decode", async () => {
  const warned = [];
  const w = fakeWorker({ 1: engineError("ENGINE_EXITED", 134), 2: engineError("ENGINE_EXITED", 134) });
  const r = await transcribeChunked(wav(50), {
    runTranscribe: w.runTranscribe,
    log: { warn: (...a) => warned.push(a.join(" ")) },
  });
  assert.strictEqual(r.text, "a0 a3");
  assert.strictEqual(r.partial, true);
  assert.deepStrictEqual(r.pieces.map((p) => p.ok), [true, false, true]);
  assert.strictEqual(r.pieces[1].code, "ENGINE_EXITED");
  assert.strictEqual(r.pieces[1].exitCode, 134);
  assert.ok(warned.some((m) => /134/.test(m)), "the exit code is logged");
});

test("chunked decode: an error the worker replied with is not retried", async () => {
  const w = fakeWorker({ 1: new Error("bad piece") });
  const r = await transcribeChunked(wav(50), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 3, "no retry: three pieces, three attempts");
  assert.strictEqual(r.text, "a0 a2");
  assert.strictEqual(r.partial, true);
});

test("chunked decode: two failed pieces in a row stop the run, keeping what decoded", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 1: dead, 2: dead, 3: dead, 4: dead });
  const r = await transcribeChunked(wav(100), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 5, "piece 0 + two pieces x two attempts, then stop");
  assert.strictEqual(r.text, "a0");
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.pieces.length, 5);
  assert.ok(r.pieces.slice(3).every((p) => !p.ok && p.skipped), "the rest are marked, not tried");
});

test("chunked decode: nothing recovered at all throws the worker's error", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 0: dead, 1: dead });
  await assert.rejects(transcribeChunked(wav(10), { runTranscribe: w.runTranscribe }), /engine process exited/);
  // A model that isn't downloaded keeps today's error path too.
  await assert.rejects(
    transcribeChunked(wav(10), { runTranscribe: async () => { throw new Error("model not installed"); } }),
    /model not installed/
  );
});

test("chunked decode: a failed tail still delivers the committed prefix", async () => {
  const w = fakeWorker({ 0: new Error("model not installed") });
  const r = await transcribeChunked(wav(10), { runTranscribe: w.runTranscribe, prefixText: "already said" });
  assert.strictEqual(r.text, "already said");
  assert.strictEqual(r.partial, true);
});

test("chunked decode: a broken snapshot's text is the salvage when no piece decodes", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 0: dead, 1: dead });
  const r = await transcribeChunked(wav(10), { runTranscribe: w.runTranscribe, salvageText: "words with a hole" });
  assert.strictEqual(r.text, "words with a hole");
  assert.strictEqual(r.partial, true);
  // ...but never mixed into a run where pieces decoded (it would duplicate them).
  const w2 = fakeWorker({ 1: dead, 2: dead });
  const r2 = await transcribeChunked(wav(30), { runTranscribe: w2.runTranscribe, salvageText: "words with a hole" });
  assert.strictEqual(r2.text, "a0");
  // ...and not used at all when everything decoded.
  const r3 = await transcribeChunked(wav(10), { runTranscribe: fakeWorker().runTranscribe, salvageText: "stale" });
  assert.strictEqual(r3.text, "a0");
});

test("chunked decode: a cancelled session stops between pieces", async () => {
  let cancelled = false;
  const w = fakeWorker();
  const run = async (input, opts) => {
    const text = await w.runTranscribe(input, opts);
    cancelled = true;
    return text;
  };
  const r = await transcribeChunked(wav(60), { runTranscribe: run, stale: () => cancelled });
  assert.strictEqual(w.inputs.length, 1, "no decode after the session went stale");
  assert.strictEqual(r.stale, true);
  // A failure caused by the cancel is not an error either.
  const r2 = await transcribeChunked(wav(10), {
    runTranscribe: async () => { cancelled = true; throw new Error("aborted"); },
    stale: () => cancelled,
  });
  assert.strictEqual(r2.stale, true);
});

test("chunked decode: an empty recording is one (empty) decode", async () => {
  const w = fakeWorker();
  const r = await transcribeChunked(encodeWav(new Int16Array(0)), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 1);
  assert.strictEqual(r.partial, false);
});

test("chunked decode: joinRaw spaces two non-empty sides and passes either alone", () => {
  assert.strictEqual(joinRaw("a", "b"), "a b");
  assert.strictEqual(joinRaw("", "b"), "b");
  assert.strictEqual(joinRaw("a", ""), "a");
  assert.strictEqual(joinRaw("", ""), "");
});

test("chunked decode: a speech piece that decodes to no text is re-decoded with silence around it", async () => {
  // A fragment cut out mid-flow can decode to "" and come back once it has
  // room to start and stop (docs/long-recordings.md).
  const seen = [];
  const r = await transcribeChunked(wav(10), {
    runTranscribe: async (w) => {
      seen.push(wavDurationSec(w));
      return seen.length === 1 ? "" : "rescued";
    },
  });
  assert.deepStrictEqual(seen, [10, 10.5], "second attempt carries 250 ms of silence each side");
  assert.deepStrictEqual([r.text, r.partial, r.pieces[0].ok, r.pieces[0].attempts], ["rescued", false, true, 2]);
});

test("chunked decode: an empty piece among decoded ones is accepted, marked unconfirmed", async () => {
  // The speech probe leans "speech" on purpose, so a breath or click after a
  // sentence also reads as speech; the lab's remaining empty pieces were all
  // such tails. Calling every one of them lost words would mark nearly every
  // long dictation incomplete.
  let n = 0;
  const r = await transcribeChunked(wav(50), { runTranscribe: async () => (n++ === 1 || n === 3 ? "" : `a${n - 1}`) });
  // piece 1 decodes "" twice (plain, padded); pieces 0 and 2 decode.
  assert.strictEqual(r.text, "a0 a3");
  assert.strictEqual(r.partial, false);
  assert.deepStrictEqual(r.pieces.map((p) => [p.ok, !!p.unconfirmed]), [[true, false], [true, true], [true, false]]);
});

test("chunked decode: speech that yields no text anywhere is never a silent empty dictation", async () => {
  // Review A:correctness-1's case: every piece empty would otherwise pass as
  // "nobody spoke" — the salvage is used, or it is an error.
  const r = await transcribeChunked(wav(10), { runTranscribe: async () => "", salvageText: "already decoded live words" });
  assert.deepStrictEqual([r.text, r.partial, r.pieces[0].ok, r.pieces[0].code], ["already decoded live words", true, false, "EMPTY_SPEECH"]);
  await assert.rejects(transcribeChunked(wav(10), { runTranscribe: async () => "" }), /no text/);
  const kept = await transcribeChunked(wav(10), { runTranscribe: async () => "", prefixText: "committed" });
  assert.deepStrictEqual([kept.text, kept.partial], ["committed", true]);
});

test("chunked decode: silence that decodes to no text is fine, with no second try", async () => {
  const silent = encodeWav(new Int16Array(10 * SR));
  let calls = 0;
  const r = await transcribeChunked(silent, { runTranscribe: async () => (calls++, "") });
  assert.deepStrictEqual([r.text, r.partial, r.pieces[0].ok, calls], ["", false, true, 1]);
});

test("chunked decode: a failed piece is filled from committed live-preview chunks inside it", async () => {
  // A broken snapshot's words can't lead the transcript, but the chunks that
  // lie wholly inside a range the final pass failed to decode are exactly
  // what the user said there. Chunks that overlap a decoded piece are left
  // out: that would repeat words.
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 1: dead, 2: dead }); // pieces 0-20 s ok, 20-40 s fails twice, 40-50 s ok
  const chunk = (fromSec, toSec, text) => ({ from: fromSec * SR, to: toSec * SR, text });
  const r = await transcribeChunked(wav(50), {
    runTranscribe: w.runTranscribe,
    salvageText: "c0 c1 c2 c3 straddle c4",
    salvageChunks: [
      chunk(0, 10, "c0"),
      chunk(10, 20, "c1"),
      chunk(20, 30, "c2"),
      chunk(30, 38, "c3"),
      chunk(38, 45, "straddle"),
      chunk(45, 50, "c4"),
    ],
  });
  assert.strictEqual(r.text, "a0 c2 c3 a3");
  assert.strictEqual(r.partial, true);
});

test("chunked decode: a timeout on the retry retires that worker too", async () => {
  // Otherwise the replacement stays inside its native decode and the next
  // piece — or the next dictation — queues behind it for another full timeout.
  const timeout = engineError("ENGINE_TIMEOUT");
  const w = fakeWorker({ 0: timeout, 1: timeout });
  let restarts = 0;
  const restartsSeenBy = [];
  const run = async (input, opts) => {
    restartsSeenBy.push(restarts);
    return w.runTranscribe(input, opts);
  };
  const r = await transcribeChunked(wav(30), { runTranscribe: run, restartStt: () => restarts++ });
  assert.strictEqual(restarts, 2, "one restart per timed-out worker");
  assert.deepStrictEqual(restartsSeenBy, [0, 1, 2], "the next piece is sent after both restarts");
  assert.strictEqual(r.text, "a2");
  assert.strictEqual(r.partial, true);
});

test("chunked decode: an unconfirmed empty piece is filled from committed live-preview chunks too", async () => {
  // Heard speech, decoded to nothing even padded: if the live preview had
  // words for that range, they are the user's (manager audit M-1).
  let n = 0;
  const chunk = (fromSec, toSec, text) => ({ from: fromSec * SR, to: toSec * SR, text });
  const r = await transcribeChunked(wav(50), {
    // piece 1 (20-40 s) decodes "" plain and padded; pieces 0 and 2 decode.
    runTranscribe: async () => (n++ === 1 || n === 3 ? "" : `a${n - 1}`),
    salvageChunks: [chunk(5, 15, "early"), chunk(22, 36, "live words"), chunk(38, 45, "straddle")],
  });
  assert.strictEqual(r.text, "a0 live words a3");
  // The words were delivered, so the transcript is not incomplete.
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.pieces[1].unconfirmed, true);
});
