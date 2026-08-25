// Where to cut the current in-progress chunk when the hard cap forces a commit.
//
// A boundary that lands mid-word costs that word twice over: the committed
// chunk decodes its start wrong and the next chunk starts inside it, and the
// committed text is reused verbatim in the FINAL transcript, so the damage is
// permanent (see main/live-preview.js). Measured against the shipped Parakeet
// model, a cut through "so the chunk boundary lands" came back as "so the
// chon." followed by "boundary land somewhere here" — a word lost and another
// mangled.
//
// The soft trigger already waits for a pause, so it cuts in silence. The hard
// cap fires *through* uninterrupted speech, and used to cut at whatever sample
// the tick happened to land on. Instead, look back over the last few seconds
// and cut at the end of the quietest window in there: the calmest moment
// available, even when nothing in it is quiet enough to count as a pause.
//
// Kept in its own file (like transcript.js) so the arithmetic is unit-testable
// without a DOM; overlay.html loads it as a plain script.

// Offset just past the quietest `windowSamples`-long window of `samples`,
// scanning every `hopSamples`. Ties go to the LATEST window, so a forced cut
// stays as late as it can and the least possible audio moves into the next
// chunk. Returns samples.length when the region is too short to hold a window
// (nothing to choose from — cut where the caller already was).
function quietestOffset(samples, windowSamples, hopSamples) {
  if (!(windowSamples > 0) || !(hopSamples > 0)) return samples.length;
  if (samples.length < windowSamples) return samples.length;
  let best = Infinity;
  let bestEnd = samples.length;
  for (let start = 0; start + windowSamples <= samples.length; start += hopSamples) {
    let sum = 0;
    for (let i = start; i < start + windowSamples; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / windowSamples);
    // <= so a later window of equal energy wins (digital silence ties at 0).
    if (rms <= best) {
      best = rms;
      bestEnd = start + windowSamples;
    }
  }
  return bestEnd;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { quietestOffset };
}
