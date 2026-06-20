// Pure helper for the overlay's two-layer live transcript: given the latest raw
// and cleaned partial transcripts, work out what to paint on each layer.
//
// The cleaned text is authoritative for whatever it covers; the raw "tail" is
// the words heard since cleanup last ran — what's been spoken but not yet
// cleaned — shown faintly after the cleaned line.
//
// We can't align the two by literal prefix or by word count: cleanup fixes
// capitalization and punctuation AND removes filler words / false starts, so the
// cleaned text is neither a character-prefix of the raw text nor the same length.
// A plain word-count offset would re-show words the cleaned line already covers
// whenever cleanup dropped a filler word ("um the the quick" → clean "The quick"
// → a count offset of 2 would wrongly tail "the quick" again).
//
// Instead we ANCHOR on the cleaned line's last content word: find where that word
// last appears in the raw token stream and tail from just after it. Matching by
// content (normalized to lowercase, punctuation stripped) survives cleanup's
// capitalization/punctuation edits and filler removal. If the anchor isn't found
// (cleanup reworded the ending) we show the cleaned line alone rather than guess.
// If cleanup hasn't run yet, the whole raw text is the tail.
//
// Loaded as a plain <script> in the overlay (exposing `reconcileTranscript` as a
// global) and required directly in unit tests; the module.exports guard lets the
// same file serve both without a bundler.

// Lowercase, strip surrounding punctuation, for content comparison.
function normToken(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function reconcileTranscript(rawText, cleanText) {
  const raw = (rawText || "").trim();
  const clean = (cleanText || "").trim();

  let tail = "";
  if (!clean) {
    tail = raw;
  } else if (raw) {
    const rawWords = raw.split(/\s+/);
    const cleanTokens = clean.split(/\s+/).map(normToken).filter(Boolean);
    const anchor = cleanTokens[cleanTokens.length - 1];
    const rawTokens = rawWords.map(normToken);
    // Find the LAST raw word matching the cleaned line's final word; the tail is
    // everything spoken after it. Last (not first) so a repeated word doesn't
    // anchor too early.
    let idx = -1;
    if (anchor) {
      for (let i = rawTokens.length - 1; i >= 0; i--) {
        if (rawTokens[i] === anchor) {
          idx = i;
          break;
        }
      }
    }
    if (idx >= 0 && idx < rawWords.length - 1) {
      tail = rawWords.slice(idx + 1).join(" ");
    }
    // idx not found, or it's the last raw word: nothing fresh to show (cleanup
    // has caught up, or reworded the ending) — show the cleaned line alone.
  }

  // Keep a space between the cleaned line and the faint tail when both present.
  if (clean && tail) tail = ` ${tail}`;

  return { clean, tail, hasText: Boolean(clean || tail.trim()) };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { reconcileTranscript };
}
