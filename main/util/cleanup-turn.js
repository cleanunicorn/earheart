// The one user turn the built-in cleanup engine sends the model, and the
// sampling options it sends with it.
//
// Kept here rather than in the engine worker so every caller shares one
// definition: the worker (main/engines/engine-worker.js), its prefill-ahead
// (main/engines/index.js), and the cleanup scripts (scripts/bench-cleanup.mjs,
// scripts/eval-cleanup.mjs), whose numbers only describe the app if they
// prompt exactly as the app does. The worker runs inside an Electron
// utilityProcess and binds `process.parentPort` at module scope, so a script or
// a test cannot require it.

const DEFAULT_CLEANUP_TEMPERATURE = 0.2;

// The start of the turn: the rules, then the transcript labelled as data.
// Prefill-ahead (primeCleanup in main/engines/index.js) evaluates this with the
// transcript known so far, and the KV reuse only hits while it stays a strict
// string prefix of the full turn below, so both are built here.
function cleanupTurnPrefix(systemPrompt, transcriptPrefix) {
  return `${systemPrompt}\n\nTranscript:\n${transcriptPrefix}`;
}

// The transcript is followed by a cue, so the model continues with the cleaned
// text rather than a reply to its content.
function cleanupUserTurn(systemPrompt, transcript) {
  return `${cleanupTurnPrefix(systemPrompt, transcript)}\n\nCleaned transcript:`;
}

// Map a resolved cleanup sampling profile onto node-llama-cpp prompt options.
// topK 0 and minP 0 mean "disabled", so they're only forwarded when active;
// temperature always has a value (falls back to the engine default).
function cleanupSamplingOptions(sampling) {
  const s = sampling || {};
  const opts = { temperature: s.temperature ?? DEFAULT_CLEANUP_TEMPERATURE };
  if (s.topP != null) opts.topP = s.topP;
  if (s.topK != null && s.topK > 0) opts.topK = s.topK;
  if (s.minP != null && s.minP > 0) opts.minP = s.minP;
  return opts;
}

module.exports = {
  DEFAULT_CLEANUP_TEMPERATURE,
  cleanupTurnPrefix,
  cleanupUserTurn,
  cleanupSamplingOptions,
};
