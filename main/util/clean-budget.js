// How much model context one cleanup turn needs, and what to say when it
// doesn't fit.
//
// A cleanup turn holds three things in the context AT ONCE: the rules prompt,
// the transcript (embedded in that same prompt), and the generated output —
// which runs about as long as the transcript again, because cleanup rewrites it
// end to end and the prompt forbids the result from being longer than the
// input. So the need is prompt + transcript + a little slack, and it grows at
// twice the rate of the dictation.
//
// Getting this wrong is not a graceful failure: llama.cpp answers an overflow
// by shifting the context, which drops the OLDEST tokens — the start of the
// dictation — and returns a cleaned transcript missing words with nothing
// reported. Refusing the turn instead is what keeps the raw transcript, and
// with it the user's words.
//
// Pure arithmetic, kept here rather than in the engine worker so it can be
// tested directly: engine-worker.js runs inside an Electron utilityProcess and
// binds `process.parentPort` at module scope, so it cannot be required from a
// test at all.

// Slack for the chat template's own wrapper tokens on top of prompt + output.
const CLEAN_CONTEXT_SLACK_TOKENS = 64;

/**
 * Context tokens one cleanup turn needs.
 * @param {number} promptTokens tokens in the full user turn (rules + transcript)
 * @param {number} transcriptTokens tokens in the transcript alone — the output budget
 * @returns {number}
 */
function cleanContextNeed(promptTokens, transcriptTokens) {
  return promptTokens + transcriptTokens + CLEAN_CONTEXT_SLACK_TOKENS;
}

/**
 * The message for a turn that doesn't fit. It reaches the user verbatim (the
 * pipeline shows a cleanup-failed notification with the error text), so it says
 * what happened in whole words and carries the two numbers that explain it.
 * @param {number} needed
 * @param {number} available
 * @returns {string}
 */
function cleanBudgetMessage(needed, available) {
  return `Transcript too long to clean up in one pass (needs ~${needed} tokens of context, have ${available})`;
}

module.exports = {
  CLEAN_CONTEXT_SLACK_TOKENS,
  cleanContextNeed,
  cleanBudgetMessage,
};
