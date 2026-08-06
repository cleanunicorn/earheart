// The review-before-send gate: should this dictation stop on the overlay for
// an edit pass instead of being pasted immediately? Pure so the truth table
// is unit-testable; the pipeline owns everything that happens next.

function needsReview(reviewCfg, text) {
  if (!reviewCfg || !text) return false;
  if (reviewCfg.mode === "always") return true;
  if (reviewCfg.mode === "length") {
    return text.length >= (reviewCfg.minChars ?? 400);
  }
  return false; // "off" and unknown values paste straight through
}

module.exports = { needsReview };
