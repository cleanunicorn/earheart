// Tests for the pure half of scripts/eval-long-decode.js: the gate a pieces
// long-recording run must pass (it is what turns the measurement in
// docs/long-recordings.md into a pass/fail), the sentence picking, and the
// arguments. The measurement itself needs Electron and a downloaded model.

const { test } = require("node:test");
const assert = require("node:assert");

const { parseArgs, pickSentences, score, judgePieces, prefixBaseline } = require("../scripts/eval-long-decode");

const GATE = { shortWer: 0.05, cap: 60, minRatio: 0.95, maxWerOverShort: 0.03 };
const good = { hypWords: 900, ratio: 0.99, wer: 0.06, maxPieceSec: 58, failedPieces: 0, alive: true };

test("eval-long-decode: a run matching the short-clip baseline passes", () => {
  assert.deepStrictEqual(judgePieces(good, GATE), []);
  // Exactly at the WER ceiling and the ratio floor still passes.
  assert.deepStrictEqual(judgePieces({ ...good, wer: 0.08, ratio: 0.95, maxPieceSec: 60 }, GATE), []);
});

test("eval-long-decode: every way a pieces run can fail is reported", () => {
  const cases = [
    [{ ratio: 0.839 }, /word ratio 0.839 < 0.95/],
    [{ wer: 0.0801 }, /WER 8.0% > 8.0%/],
    [{ maxPieceSec: 60.5 }, /exceeds the 60 s cap/],
    [{ failedPieces: 1 }, /1 piece\(s\) failed/],
    [{ alive: false }, /did not answer/],
    [{ hypWords: 0, ratio: 0 }, /empty transcript/],
    [{ error: "engine process exited" }, /failed: engine process exited/],
  ];
  for (const [change, reason] of cases) {
    const reasons = judgePieces({ ...good, ...change }, GATE);
    assert.ok(reasons.some((r) => reason.test(r)), `${JSON.stringify(change)} → ${JSON.stringify(reasons)}`);
  }
});

test("eval-long-decode: sentences are distinct, one gender, in order, up to the target", () => {
  const row = (sentenceId, gender, sec) => ({ sentenceId, gender, numSamples: sec * 16000, raw: sentenceId, file: `${sentenceId}.wav` });
  const rows = [row("a", "FEMALE", 10), row("a", "FEMALE", 10), row("b", "MALE", 10), row("c", "FEMALE", 10), row("d", "FEMALE", 10)];
  assert.deepStrictEqual(pickSentences(rows, 15).map((r) => r.sentenceId), ["a", "c"]);
  assert.deepStrictEqual(pickSentences(rows, 1000).map((r) => r.sentenceId), ["a", "c", "d"]);
});

test("eval-long-decode: score counts words after normalisation", () => {
  const s = score("One two, three four.", "one two three");
  assert.strictEqual(s.refWords, 4);
  assert.strictEqual(s.ratio, 0.75);
  assert.strictEqual(s.wer, 0.25);
});

test("eval-long-decode: arguments default to the shipped cap and parse lists", () => {
  const d = parseArgs([]);
  assert.deepStrictEqual(d.caps, [20]);
  assert.strictEqual(d.pauses, true);
  assert.strictEqual(parseArgs(["--no-pauses"]).pauses, false);
  assert.deepStrictEqual(d.targets, [120, 180, 300]);
  const o = parseArgs(["--caps", "20,30,45,60", "--single", "--targets=180", "--no-sandbox"]);
  assert.deepStrictEqual(o.caps, [20, 30, 45, 60]);
  assert.deepStrictEqual(o.targets, [180]);
  assert.strictEqual(o.single, true);
  assert.throws(() => parseArgs(["--caps", "0"]), /positive/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("eval-long-decode: requiring it for its helpers never starts a run", () => {
  // Loaded under plain Node from a test, the module must just export.
  const mod = require("../scripts/eval-long-decode");
  assert.strictEqual(typeof mod.judgePieces, "function");
});

test("eval-long-decode: each recording is held to its own sentences' short-clip baseline", () => {
  // The 120 s recording's sentences are a prefix of the 300 s one's; holding
  // both to the longer set's WER would apply a ceiling measured on different
  // sentences (review A:testing-2).
  const clip = (errors, ref, hypWords) => ({ counts: { errors, ref }, hypWords });
  const scores = [clip(0, 10, 10), clip(0, 10, 10), clip(6, 10, 7), clip(6, 10, 7)];
  const short = prefixBaseline(scores, 2);
  const long = prefixBaseline(scores, 4);
  assert.deepStrictEqual(short, { clips: 2, wer: 0, ratio: 1 });
  assert.deepStrictEqual(long, { clips: 4, wer: 0.3, ratio: 0.85 });
  // The same run passes against its own baseline and fails against the other's.
  const run = { hypWords: 20, ratio: 0.97, wer: 0.3, maxPieceSec: 10, failedPieces: 0, alive: true };
  assert.deepStrictEqual(judgePieces(run, { ...GATE, shortWer: long.wer }), []);
  assert.ok(judgePieces(run, { ...GATE, shortWer: short.wer }).some((r) => /WER/.test(r)));
  assert.throws(() => prefixBaseline(scores, 5), /only 4 clips/);
});
