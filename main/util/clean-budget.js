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
// tested directly, without a model: engine-worker.js runs inside an Electron
// utilityProcess and binds `process.parentPort` at module scope, so its tests
// (test/cleanup-worker.test.js) have to fake that port and node-llama-cpp.

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
 * The generation cap for one cleanup turn — exactly the output the context
 * above was sized to hold, and not a token more.
 *
 * Two things make this worth capping. Small models loop: Gemma 1B on a
 * 150-word dictation re-emitted its last two sentences over and over, and with
 * nothing to stop it, it ran until the context filled — minutes of compute for
 * a result that repeats itself. And the generation that overruns is the one
 * that triggers the context shift this module exists to prevent, silently
 * costing the user the start of their dictation.
 *
 * Deriving the cap from the same numbers as cleanContextNeed makes the overrun
 * arrive as an explicit stop (the maxTokens stop reason in
 * main/engines/engine-worker.js clean) rather than as quiet truncation, and the
 * caller answers it by keeping the raw transcript.
 * @param {number} transcriptTokens tokens in the transcript alone
 * @returns {number}
 */
function cleanMaxTokens(transcriptTokens) {
  return transcriptTokens + CLEAN_CONTEXT_SLACK_TOKENS;
}

/**
 * The message for a turn that doesn't fit. It reaches the user verbatim (the
 * pipeline shows a cleanup-failed notification with the error text), so it says
 * what happened in whole words and carries the numbers that explain it. When
 * the instructions (rules, style, dictionary) outgrow the allowance an ordinary
 * prompt gets, they are the part the user can change, so it names them (#297).
 * @param {number} needed
 * @param {number} available
 * @param {number} [instructionTokens] tokens in the instructions alone
 * @returns {string}
 */
function cleanBudgetMessage(needed, available, instructionTokens = 0) {
  if (instructionTokens > CLEAN_PROMPT_TOKENS) {
    return (
      `Cleanup instructions and dictionary too long to clean up this transcript ` +
      `(needs ~${needed} tokens of context, have ${available}; the instructions and dictionary ` +
      `use ~${instructionTokens}). Remove dictionary words or shorten the custom prompt.`
    );
  }
  return `Transcript too long to clean up in one pass (needs ~${needed} tokens of context, have ${available})`;
}

// Reaches the user the same way — it is the body of the cleanup-failed
// notification — so it says what happened rather than naming a token count. The
// title already says the raw transcript was used; repeating it here doubled it.
const CLEAN_RUNAWAY_MESSAGE = "Cleanup reached its output token limit before finishing";

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
// The allowance for the instructions — rules prompt, style directive and a
// dictionary — when their real size isn't known yet (main has no tokenizer).
// The worker measures the real ones and grows the context past this when a
// dictionary or custom prompt needs it (cleanContextSize, #297).
const CLEAN_PROMPT_TOKENS = 700;

/**
 * The longest transcript, in tokens, a user who may dictate for
 * `maxRecordingSeconds` can produce.
 * @param {number} maxRecordingSeconds `audio.maxRecordingSeconds`
 * @returns {number}
 */
function cleanTranscriptBudget(maxRecordingSeconds) {
  const seconds = Number.isFinite(maxRecordingSeconds) ? Math.max(0, maxRecordingSeconds) : 0;
  return Math.ceil(seconds * WORDS_PER_SECOND * TOKENS_PER_WORD);
}

/**
 * Context size for instructions of `instructionTokens` and a transcript of up
 * to `transcriptTokens`. Doubling steps rather than an exact fit: llama.cpp
 * allocates the KV cache from this, and a handful of sizes keeps that
 * allocation predictable.
 * @param {number} instructionTokens tokens in the instructions alone
 * @param {number} transcriptTokens the transcript budget
 * @returns {number} tokens, within [CLEAN_CONTEXT_MIN, CLEAN_CONTEXT_MAX]
 */
function cleanContextSize(instructionTokens, transcriptTokens) {
  const needed = cleanContextNeed(instructionTokens + transcriptTokens, transcriptTokens);
  let size = CLEAN_CONTEXT_MIN;
  while (size < needed && size < CLEAN_CONTEXT_MAX) size *= 2;
  return size;
}

/**
 * Context size for a user who may dictate for `maxRecordingSeconds`, with the
 * instructions at their allowance. Main sizes the context from this before
 * the instructions are measured; the worker never goes below it.
 * @param {number} maxRecordingSeconds `audio.maxRecordingSeconds`
 * @returns {number} tokens, within [CLEAN_CONTEXT_MIN, CLEAN_CONTEXT_MAX]
 */
function cleanContextFor(maxRecordingSeconds) {
  return cleanContextSize(CLEAN_PROMPT_TOKENS, cleanTranscriptBudget(maxRecordingSeconds));
}

module.exports = {
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
};
