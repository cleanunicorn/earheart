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

// Sizing the context from the dictation cap. The floor is what an ordinary
// dictation needs; the ceiling is where the KV cache stops being worth it (a
// context costs memory for every dictation, including the short ones). Past the
// ceiling the budget check refuses the turn and the raw transcript is delivered
// — correct, just not cleaned.
const CLEAN_CONTEXT_MIN = 4096;
const CLEAN_CONTEXT_MAX = 16384;
// Dictation is speech, not prose: ~150 words a minute, and Gemma spends a bit
// over a token a word. Both are deliberately generous — under-sizing costs the
// user their cleanup, over-sizing costs some memory.
const WORDS_PER_SECOND = 2.5;
const TOKENS_PER_WORD = 1.35;
// The rules prompt, with headroom for the style directive and a dictionary.
const CLEAN_PROMPT_TOKENS = 700;

/**
 * Context size for a user who may dictate for `maxRecordingSeconds`. Doubling
 * steps rather than an exact fit: llama.cpp allocates the KV cache from this,
 * and a handful of sizes keeps that allocation predictable.
 * @param {number} maxRecordingSeconds `audio.maxRecordingSeconds`
 * @returns {number} tokens, within [CLEAN_CONTEXT_MIN, CLEAN_CONTEXT_MAX]
 */
function cleanContextFor(maxRecordingSeconds) {
  const seconds = Number.isFinite(maxRecordingSeconds) ? Math.max(0, maxRecordingSeconds) : 0;
  const transcriptTokens = Math.ceil(seconds * WORDS_PER_SECOND * TOKENS_PER_WORD);
  const needed = cleanContextNeed(CLEAN_PROMPT_TOKENS + transcriptTokens, transcriptTokens);
  let size = CLEAN_CONTEXT_MIN;
  while (size < needed && size < CLEAN_CONTEXT_MAX) size *= 2;
  return size;
}

module.exports = {
  CLEAN_CONTEXT_SLACK_TOKENS,
  CLEAN_CONTEXT_MIN,
  CLEAN_CONTEXT_MAX,
  cleanContextNeed,
  cleanContextFor,
  cleanBudgetMessage,
};
