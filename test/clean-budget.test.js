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
  CLEAN_PROMPT_TOKENS,
  cleanContextNeed,
  cleanContextSize,
  cleanContextFor,
  cleanTranscriptBudget,
  cleanMaxTokens,
  cleanBudgetMessage,
} = require("../main/util/clean-budget");
const { DEFAULTS } = require("../main/settings");

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

test("clean cap: the runaway message says what happened, once", () => {
  // It is the body of the cleanup-failed notification, whose title already
  // says the raw transcript was used — repeating that here doubled the clause.
  assert.strictEqual(CLEAN_RUNAWAY_MESSAGE, "Cleanup reached its output token limit before finishing");
});

test("clean budget: the refusal message names both numbers", () => {
  // It reaches the user verbatim in the cleanup-failed notification.
  const message = cleanBudgetMessage(5000, 4096);
  assert.match(message, /5000/);
  assert.match(message, /4096/);
  assert.match(message, /too long/i);
});

test("clean budget: the default recording cap's context fits a fast speaker", () => {
  // 600 s is the shipped cap. Sized at ~150 wpm, but a fast dictation runs
  // ~200 wpm: 2,000 words at ~1.35 tokens a word, with the ~700-token rules
  // prompt (style directive and dictionary included). The prompt, the
  // transcript and an equally long cleaned answer must all fit, or the user
  // loses cleanup on an ordinary full-length dictation.
  const size = cleanContextFor(DEFAULTS.audio.maxRecordingSeconds);
  const transcriptTokens = Math.ceil(2000 * 1.35);
  const needed = cleanContextNeed(700 + transcriptTokens, transcriptTokens);
  assert.ok(needed <= size, `fast default-cap dictation needs ${needed}, context is ${size}`);
  // ...and the generation cap leaves room for the whole cleaned answer.
  assert.ok(cleanMaxTokens(transcriptTokens) >= transcriptTokens);
});

test("clean context: a default-length dictation pays for no more than it needs", () => {
  // A 10-minute cap needs 8192; nobody who hasn't changed it should pay for
  // a bigger KV cache than that. Short caps keep the smallest context.
  assert.strictEqual(cleanContextFor(DEFAULTS.audio.maxRecordingSeconds), 8192);
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

// #297: measured on Qwen3 4B Instruct 2507 Q4_K_M with the shipped default
// prompt and a valid 256-term identifier dictionary (7,679 characters): the
// user turn for "Run the test suite." (5 tokens) is 6,921 tokens. The fixed
// allowance sized a 60 s cap's context at 4,096; the turn needs 6,990.
test("clean context: sized from the real instructions, a token-dense dictionary fits", () => {
  const turnTokens = 6921;
  const transcriptTokens = 5;
  const needed = cleanContextNeed(turnTokens, transcriptTokens);
  assert.strictEqual(needed, 6990);
  assert.ok(needed > cleanContextFor(60), "the fixed allowance was the bug");
  const size = cleanContextSize(turnTokens - transcriptTokens, cleanTranscriptBudget(60));
  assert.ok(needed <= size, `needs ${needed}, sized ${size}`);
  assert.strictEqual(size, 8192);
});

test("clean context: the allowance-based size is the measured size at the allowance", () => {
  for (const seconds of [0, 60, 300, 600, 1800, 3600]) {
    assert.strictEqual(cleanContextFor(seconds), cleanContextSize(CLEAN_PROMPT_TOKENS, cleanTranscriptBudget(seconds)));
  }
});

test("clean context: real instructions still stop at the memory ceiling", () => {
  assert.strictEqual(cleanContextSize(100000, cleanTranscriptBudget(60)), CLEAN_CONTEXT_MAX);
  assert.strictEqual(cleanContextSize(0, 0), CLEAN_CONTEXT_MIN);
});

test("clean budget: a refusal caused by the instructions says what to shorten", () => {
  const message = cleanBudgetMessage(17000, 16384, 16500);
  assert.match(message, /instructions and dictionary use ~16500/);
  assert.match(message, /Remove dictionary words or shorten the custom prompt/);
  // Instructions over the allowance, but the transcript overflowed anyway:
  // shortening the dictionary wouldn't have helped, so don't say it would.
  assert.match(cleanBudgetMessage(20000, 16384, 800), /^Transcript too long/);
  // An ordinary prompt keeps the transcript-length message.
  assert.match(cleanBudgetMessage(17000, 16384, CLEAN_PROMPT_TOKENS), /^Transcript too long/);
  assert.match(cleanBudgetMessage(17000, 16384), /^Transcript too long/);
});
