// Tests for the cleanup turn — the exact text and sampling options the
// built-in engine sends the model for one clean.
//
// The engine worker and the cleanup benchmark (scripts/bench-cleanup.mjs) both
// build their turn from this module, so a benchmark number describes what the
// app actually sends. The strings are pinned byte for byte: a stray newline or
// a renamed cue changes model behavior, and every recorded measurement with it.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_CLEANUP_TEMPERATURE,
  cleanupTurnPrefix,
  cleanupUserTurn,
  cleanupSamplingOptions,
} = require("../main/util/cleanup-turn");

test("cleanupUserTurn labels the transcript as data and ends on the cue", () => {
  assert.strictEqual(
    cleanupUserTurn("RULES", "so um hello"),
    "RULES\n\nTranscript:\nso um hello\n\nCleaned transcript:"
  );
});

test("cleanupUserTurn keeps the prompt and transcript verbatim", () => {
  const prompt = "Line one.\n\nEditing style: keep it.";
  const transcript = "  spaced  \nand multi-line ";
  assert.strictEqual(
    cleanupUserTurn(prompt, transcript),
    `${prompt}\n\nTranscript:\n${transcript}\n\nCleaned transcript:`
  );
});

test("cleanupSamplingOptions forwards every active knob", () => {
  assert.deepStrictEqual(
    cleanupSamplingOptions({ temperature: 0.4, topP: 0.9, topK: 40, minP: 0.02 }),
    { temperature: 0.4, topP: 0.9, topK: 40, minP: 0.02 }
  );
});

test("cleanupSamplingOptions drops topK and minP at 0 (disabled)", () => {
  assert.deepStrictEqual(
    cleanupSamplingOptions({ temperature: 0.2, topP: 1, topK: 0, minP: 0 }),
    { temperature: 0.2, topP: 1 }
  );
});

test("cleanupSamplingOptions falls back to the engine's default temperature", () => {
  assert.strictEqual(DEFAULT_CLEANUP_TEMPERATURE, 0.2);
  assert.deepStrictEqual(cleanupSamplingOptions(undefined), { temperature: 0.2 });
  assert.deepStrictEqual(cleanupSamplingOptions({}), { temperature: 0.2 });
});

test("cleanupSamplingOptions keeps an explicit temperature of 0", () => {
  assert.deepStrictEqual(cleanupSamplingOptions({ temperature: 0 }), { temperature: 0 });
});

test("the prefill prefix is a strict string prefix of the full turn", () => {
  // primeCleanup evaluates the prefix ahead of time; clean() then reuses that
  // KV state only if its turn starts with exactly the same text.
  const prompt = "RULES\n\nEditing style: tidy.";
  const committed = "so um I wanted";
  const full = cleanupUserTurn(prompt, `${committed} to ask about the pipeline`);
  const prefix = cleanupTurnPrefix(prompt, committed);
  assert.ok(full.startsWith(prefix), `${JSON.stringify(prefix)} is not a prefix of the turn`);
  assert.ok(full.startsWith(cleanupTurnPrefix(prompt, "")));
  assert.strictEqual(cleanupTurnPrefix("RULES", "abc"), "RULES\n\nTranscript:\nabc");
});
