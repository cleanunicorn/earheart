// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const { encodeWav, encodeSilenceWav, wavToFloat32 } = require("../main/util/wav");
const { stripThinking } = require("../main/services/cleanup");
const { deepMerge, migrateLegacy, DEFAULTS } = require("../main/settings");

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

test("wavToFloat32 round-trips PCM16 samples to [-1, 1]", () => {
  const wav = encodeWav(new Int16Array([0, 16384, -16384, 32767, -32768]));
  const { samples, sampleRate } = wavToFloat32(wav);
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(samples.length, 5);
  assert.strictEqual(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-4);
  assert.ok(samples[3] <= 1 && samples[3] > 0.99);
  assert.strictEqual(samples[4], -1);
});

test("wavToFloat32 rejects non-WAV input", () => {
  assert.throws(() => wavToFloat32(Buffer.from("not a wav at all!!")));
});

test("migrateLegacy maps pre-engine settings onto external engines", () => {
  // Local autostart server -> "server".
  const autostart = migrateLegacy({
    stt: { baseUrl: "http://x" },
    cleanup: { enabled: true },
    sttServer: { autoStart: true },
  });
  assert.strictEqual(autostart.stt.engine, "server");
  assert.strictEqual(autostart.cleanup.engine, "remote");

  // No autostart -> "remote".
  const remote = migrateLegacy({ stt: {}, cleanup: {}, sttServer: {} });
  assert.strictEqual(remote.stt.engine, "remote");
});

test("migrateLegacy leaves fresh and already-migrated configs untouched", () => {
  assert.deepStrictEqual(migrateLegacy({}), {}); // fresh install
  const modern = { stt: { engine: "builtin" }, cleanup: { engine: "builtin" } };
  assert.deepStrictEqual(migrateLegacy(modern), modern);
});

test("new installs default to in-process engines", () => {
  assert.strictEqual(DEFAULTS.stt.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.enabled, true);
  assert.ok(DEFAULTS.stt.builtin.model);
  assert.ok(DEFAULTS.cleanup.builtin.model);
});
