// Tests for the cleanup context budget — the arithmetic that decides whether a
// dictation can be cleaned in one pass, or must be delivered raw instead.
//
// This is the guard against the failure it exists to prevent: an overflow makes
// llama.cpp shift the context and drop the START of the dictation, returning a
// cleaned transcript missing words with nothing reported. A budget that reads
// one token too generous puts those words back at risk, so the boundary is
// pinned exactly.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  CLEAN_CONTEXT_SLACK_TOKENS,
  CLEAN_CONTEXT_MIN,
  CLEAN_CONTEXT_MAX,
  CLEAN_RUNAWAY_MESSAGE,
  cleanContextNeed,
  cleanContextFor,
  cleanMaxTokens,
  cleanBudgetMessage,
} = require("../main/util/clean-budget");

test("clean budget: the turn costs the prompt, the output and the slack", () => {
  // The prompt already contains the transcript; the transcript is counted a
  // second time as the output budget, since cleanup rewrites it end to end.
  assert.strictEqual(
    cleanContextNeed(600, 400),
    600 + 400 + CLEAN_CONTEXT_SLACK_TOKENS
  );
  assert.strictEqual(cleanContextNeed(0, 0), CLEAN_CONTEXT_SLACK_TOKENS);
});

test("clean budget: need grows at twice the rate of the dictation", () => {
  // A transcript token costs twice — once inside the prompt, once as output —
  // which is what makes the ceiling arrive at half the context, not all of it.
  const short = cleanContextNeed(500 + 100, 100);
  const long = cleanContextNeed(500 + 200, 200);
  assert.strictEqual(long - short, 200);
});

test("clean budget: fits exactly at the context size, not one token past", () => {
  // The pipeline compares `needed > available`, so a turn that lands exactly on
  // the context still runs. Pin both sides of that boundary.
  const available = 4096;
  const exact = available - CLEAN_CONTEXT_SLACK_TOKENS; // prompt + output
  assert.strictEqual(cleanContextNeed(exact, 0), available);
  assert.ok(!(cleanContextNeed(exact, 0) > available), "exact fit must not be refused");
  assert.ok(cleanContextNeed(exact, 1) > available, "one token past must be refused");
});

test("clean cap: the generation is capped at the output the context reserves", () => {
  // The whole point of deriving the cap from the same numbers as the budget: a
  // turn that passed cleanContextNeed can generate right up to its cap and
  // still fit, so the cap fires on a runaway rather than on an honest cleanup.
  const transcriptTokens = 400;
  const promptTokens = 700 + transcriptTokens;
  const available = cleanContextNeed(promptTokens, transcriptTokens);
  assert.ok(
    promptTokens + cleanMaxTokens(transcriptTokens) <= available,
    "a generation that runs to the cap must still fit the sized context"
  );
});

test("clean cap: scales with the transcript and never reaches zero", () => {
  // A one-word dictation still needs room for punctuation and casing, so the
  // cap floors at the slack rather than at the transcript's own length.
  assert.ok(cleanMaxTokens(1000) > cleanMaxTokens(100));
  assert.strictEqual(cleanMaxTokens(1000) - cleanMaxTokens(100), 900);
  assert.ok(cleanMaxTokens(0) > 0);
});

test("clean cap: the runaway message says what happened to the text", () => {
  // It reaches the user verbatim in the cleanup-failed notification, so it has
  // to say the raw transcript was kept — not leave them wondering what landed.
  assert.match(CLEAN_RUNAWAY_MESSAGE, /raw transcript/i);
  assert.match(CLEAN_RUNAWAY_MESSAGE, /repeat/i);
});

test("clean budget: the refusal message names both numbers", () => {
  // It reaches the user verbatim in the cleanup-failed notification.
  const message = cleanBudgetMessage(5000, 4096);
  assert.match(message, /5000/);
  assert.match(message, /4096/);
  assert.match(message, /too long/i);
});

test("clean budget: 4096 covers the default recording cap", () => {
  // 300s of speech at ~150 wpm is ~750 words; Gemma runs ~1.35 tokens a word,
  // and the rules prompt is ~490 tokens. If this ever stops fitting, the
  // default context has to move with it — the raw fallback is correct but the
  // user loses cleanup on an ordinary dictation.
  const transcriptTokens = Math.round(750 * 1.35);
  const needed = cleanContextNeed(490 + transcriptTokens, transcriptTokens);
  assert.ok(needed <= 4096, `default-cap dictation needs ${needed} tokens`);
});

test("clean context: a default-length dictation keeps the smallest context", () => {
  // 300s is the shipped cap. Nobody who hasn't changed it should pay for a
  // bigger KV cache than a 5-minute dictation needs.
  assert.strictEqual(cleanContextFor(300), CLEAN_CONTEXT_MIN);
  assert.strictEqual(cleanContextFor(10), CLEAN_CONTEXT_MIN);
  assert.strictEqual(cleanContextFor(0), CLEAN_CONTEXT_MIN);
});

test("clean context: grows with the cap the user set", () => {
  // The point of deriving it: raising Max dictation length has to raise the
  // context too, or cleanup starts refusing exactly the long dictations the
  // setting was raised for.
  assert.ok(cleanContextFor(900) > cleanContextFor(300));
  assert.ok(cleanContextFor(1800) >= cleanContextFor(900));
  // Doubling steps, so every size is a power of two.
  for (const seconds of [300, 600, 900, 1800, 3600]) {
    const size = cleanContextFor(seconds);
    assert.strictEqual(size & (size - 1), 0, `${size} is not a power of two`);
  }
});

test("clean context: the size it returns actually fits that dictation", () => {
  // The contract that matters — for every cap up to where the ceiling bites,
  // a full-length dictation must pass the budget check, not just come close.
  for (let seconds = 60; cleanContextFor(seconds) < CLEAN_CONTEXT_MAX; seconds += 60) {
    const transcriptTokens = Math.ceil(seconds * 2.5 * 1.35);
    const needed = cleanContextNeed(700 + transcriptTokens, transcriptTokens);
    assert.ok(
      needed <= cleanContextFor(seconds),
      `${seconds}s needs ${needed} but gets ${cleanContextFor(seconds)}`
    );
  }
});

test("clean context: stays within the ceiling for any cap", () => {
  // 3600s is the largest the settings field allows. Beyond the ceiling the
  // budget check refuses the turn and the raw transcript is delivered — the
  // memory of an ever-growing KV cache is the worse trade.
  assert.strictEqual(cleanContextFor(3600), CLEAN_CONTEXT_MAX);
  assert.strictEqual(cleanContextFor(100000), CLEAN_CONTEXT_MAX);
  assert.strictEqual(cleanContextFor(undefined), CLEAN_CONTEXT_MIN);
  assert.strictEqual(cleanContextFor(-5), CLEAN_CONTEXT_MIN);
});
