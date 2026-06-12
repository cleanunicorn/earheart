// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const { encodeWav, encodeSilenceWav } = require("../main/util/wav");
const { stripThinking } = require("../main/services/cleanup");
const { deepMerge } = require("../main/settings");

test("encodeWav produces a valid RIFF header", () => {
  const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(samples, 16000);
  assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(wav.readUInt32LE(24), 16000); // sample rate
  assert.strictEqual(wav.readUInt16LE(22), 1); // mono
  assert.strictEqual(wav.readUInt32LE(40), samples.length * 2); // data size
  assert.strictEqual(wav.length, 44 + samples.length * 2);
  assert.strictEqual(wav.readInt16LE(44 + 2), 1000);
});

test("encodeSilenceWav has the requested duration", () => {
  const wav = encodeSilenceWav(0.5);
  assert.strictEqual(wav.readUInt32LE(40), 16000 * 0.5 * 2);
});

test("stripThinking removes reasoning blocks", () => {
  assert.strictEqual(
    stripThinking("<think>hmm, let me see</think>Hello world."),
    "Hello world."
  );
  assert.strictEqual(stripThinking("No tags here."), "No tags here.");
  assert.strictEqual(
    stripThinking("<THINK>a</THINK>\n\n  Result  "),
    "Result"
  );
});

test("deepMerge keeps defaults for missing keys and overrides present ones", () => {
  const base = { a: 1, nested: { x: "default", y: 2 }, arr: [1, 2] };
  const override = { nested: { x: "custom" }, arr: [3] };
  const merged = deepMerge(base, override);
  assert.deepStrictEqual(merged, {
    a: 1,
    nested: { x: "custom", y: 2 },
    arr: [3],
  });
});

test("deepMerge ignores null/undefined overrides", () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});
