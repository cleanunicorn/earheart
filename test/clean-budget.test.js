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
  cleanContextNeed,
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
