// Tests for the bounded final decode: a long recording reaches the STT worker
// as pieces of at most the cap, every decoded word survives a piece failing
// (golden rule 8), and a dead or wedged worker gets exactly one retry.

const { test } = require("node:test");
const assert = require("node:assert");

const { transcribeChunked, joinRaw, MAX_DECODE_SECONDS } = require("../main/final-decode");
const { encodeWav, wavDurationSec, wavSampleFrames } = require("../main/util/wav");

const SR = 16000;

// `seconds` of loud "speech" with a short pause every 7 s, so the splitter has
// somewhere quiet to cut.
function speechWav(seconds) {
  const samples = new Int16Array(Math.round(seconds * SR));
  for (let i = 0; i < samples.length; i++) {
    const t = i / SR;
    samples[i] = t % 7 > 6.6 ? 0 : i % 2 ? 8000 : -8000;
  }
  return encodeWav(samples, SR);
}

const engineError = (code, exitCode) =>
  Object.assign(new Error(code === "ENGINE_TIMEOUT" ? "engine request 'transcribe' timed out" : "engine process exited"), { code, exitCode });

// A fake worker: decodes piece N to "pN", records every input's duration, and
// fails attempts listed in `failures` ({ [attemptIndex]: error }).
function fakeWorker(failures = {}) {
  const inputs = [];
  let attempt = 0;
  return {
    inputs,
    async runTranscribe(wav, { onDecodeMs } = {}) {
      const n = attempt++;
      inputs.push(wavDurationSec(wav));
      if (failures[n]) throw failures[n];
      if (onDecodeMs) onDecodeMs(100);
      return `a${n}`;
    },
  };
}

test("final decode: the cap is 60 s", () => {
  assert.strictEqual(MAX_DECODE_SECONDS, 60);
});

test("final decode: a short recording is one decode, untouched", async () => {
  const w = fakeWorker();
  const wav = speechWav(20);
  const r = await transcribeChunked(wav, { runTranscribe: w.runTranscribe });
  assert.deepStrictEqual(w.inputs, [20]);
  assert.strictEqual(r.text, "a0");
  assert.strictEqual(r.partial, false);
  assert.deepStrictEqual(r.pieces.map((p) => [p.fromFrame, p.toFrame, p.ok]), [[0, 20 * SR, true]]);
});

test("final decode: no worker input exceeds the cap, pieces tile the recording in order", async () => {
  for (const seconds of [61, 124.5, 182.9, 310.9, 600]) {
    const w = fakeWorker();
    const wav = speechWav(seconds);
    const decodeMs = [];
    const r = await transcribeChunked(wav, { runTranscribe: w.runTranscribe, onDecodeMs: (ms) => decodeMs.push(ms) });
    assert.ok(w.inputs.length >= Math.ceil(seconds / 60), `${seconds}s: ${w.inputs.length} pieces`);
    for (const sec of w.inputs) assert.ok(sec <= 60, `${seconds}s: a ${sec}s decode`);
    assert.strictEqual(r.pieces[0].fromFrame, 0);
    assert.strictEqual(r.pieces.at(-1).toFrame, wavSampleFrames(wav));
    for (let i = 1; i < r.pieces.length; i++) assert.strictEqual(r.pieces[i].fromFrame, r.pieces[i - 1].toFrame);
    assert.strictEqual(r.text, w.inputs.map((_, i) => `a${i}`).join(" "));
    assert.strictEqual(r.partial, false);
    assert.strictEqual(decodeMs.length, w.inputs.length, "every piece reports its decode time");
  }
});

test("final decode: the trusted committed prefix leads the text", async () => {
  const w = fakeWorker();
  const r = await transcribeChunked(speechWav(90), { runTranscribe: w.runTranscribe, prefixText: "committed words" });
  assert.strictEqual(r.text, "committed words a0 a1");
});

test("final decode: a worker exit is retried once on a fresh worker", async () => {
  const w = fakeWorker({ 1: engineError("ENGINE_EXITED", 134) });
  let restarts = 0;
  const r = await transcribeChunked(speechWav(90), { runTranscribe: w.runTranscribe, restartStt: () => restarts++ });
  // piece 0 = a0, piece 1 dies (attempt 1) and succeeds on retry (attempt 2).
  assert.strictEqual(r.text, "a0 a2");
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.pieces[1].attempts, 2);
  assert.strictEqual(restarts, 0, "an exited worker is already gone; the host re-forks on the next request");
});

test("final decode: a timeout retires the wedged worker before the retry", async () => {
  const w = fakeWorker({ 0: engineError("ENGINE_TIMEOUT") });
  let restarts = 0;
  const r = await transcribeChunked(speechWav(90), { runTranscribe: w.runTranscribe, restartStt: () => restarts++ });
  assert.strictEqual(restarts, 1);
  assert.strictEqual(r.text, "a1 a2");
  assert.strictEqual(r.partial, false);
});

test("final decode: a piece that fails twice is skipped, later pieces still decode", async () => {
  const warned = [];
  const w = fakeWorker({ 1: engineError("ENGINE_EXITED", 134), 2: engineError("ENGINE_EXITED", 134) });
  const r = await transcribeChunked(speechWav(150), {
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

test("final decode: an error the worker replied with is not retried", async () => {
  const w = fakeWorker({ 1: new Error("bad piece") });
  const r = await transcribeChunked(speechWav(150), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 3, "no retry: three pieces, three attempts");
  assert.strictEqual(r.text, "a0 a2");
  assert.strictEqual(r.partial, true);
});

test("final decode: two failed pieces in a row stop the run, keeping what decoded", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 1: dead, 2: dead, 3: dead, 4: dead });
  const r = await transcribeChunked(speechWav(300), { runTranscribe: w.runTranscribe });
  assert.strictEqual(w.inputs.length, 5, "piece 0 + two pieces x two attempts, then stop");
  assert.strictEqual(r.text, "a0");
  assert.strictEqual(r.partial, true);
  assert.ok(r.pieces.length >= 5);
  assert.ok(r.pieces.slice(3).every((p) => !p.ok && p.skipped), "the rest are marked, not tried");
});

test("final decode: nothing recovered at all throws the worker's error", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 0: dead, 1: dead });
  await assert.rejects(transcribeChunked(speechWav(20), { runTranscribe: w.runTranscribe }), /engine process exited/);
  // A model that isn't downloaded keeps today's error path too.
  await assert.rejects(
    transcribeChunked(speechWav(20), { runTranscribe: async () => { throw new Error("model not installed"); } }),
    /model not installed/
  );
});

test("final decode: a failed tail still delivers the committed prefix", async () => {
  const w = fakeWorker({ 0: new Error("model not installed") });
  const r = await transcribeChunked(speechWav(20), { runTranscribe: w.runTranscribe, prefixText: "already said" });
  assert.strictEqual(r.text, "already said");
  assert.strictEqual(r.partial, true);
});

test("final decode: a broken snapshot's text is the salvage when no piece decodes", async () => {
  const dead = engineError("ENGINE_EXITED", 134);
  const w = fakeWorker({ 0: dead, 1: dead });
  const r = await transcribeChunked(speechWav(20), { runTranscribe: w.runTranscribe, salvageText: "words with a hole" });
  assert.strictEqual(r.text, "words with a hole");
  assert.strictEqual(r.partial, true);
  // ...but never mixed into a run where pieces decoded (it would duplicate them).
  const w2 = fakeWorker({ 1: dead, 2: dead });
  const r2 = await transcribeChunked(speechWav(90), { runTranscribe: w2.runTranscribe, salvageText: "words with a hole" });
  assert.strictEqual(r2.text, "a0");
  // ...and not used at all when everything decoded.
  const r3 = await transcribeChunked(speechWav(20), { runTranscribe: fakeWorker().runTranscribe, salvageText: "stale" });
  assert.strictEqual(r3.text, "a0");
});

test("final decode: a cancelled session stops between pieces", async () => {
  let cancelled = false;
  const w = fakeWorker();
  const run = async (wav, opts) => {
    const text = await w.runTranscribe(wav, opts);
    cancelled = true;
    return text;
  };
  const r = await transcribeChunked(speechWav(200), { runTranscribe: run, stale: () => cancelled });
  assert.strictEqual(w.inputs.length, 1, "no decode after the session went stale");
  assert.strictEqual(r.stale, true);
  // A failure caused by the cancel is not an error either.
  const r2 = await transcribeChunked(speechWav(20), {
    runTranscribe: async () => { cancelled = true; throw new Error("aborted"); },
    stale: () => cancelled,
  });
  assert.strictEqual(r2.stale, true);
});

test("final decode: joinRaw spaces two non-empty sides and passes either alone", () => {
  assert.strictEqual(joinRaw("a", "b"), "a b");
  assert.strictEqual(joinRaw("", "b"), "b");
  assert.strictEqual(joinRaw("a", ""), "a");
  assert.strictEqual(joinRaw("", ""), "");
});
