// Deterministic filler removal — the safety net behind the cleanup model.
//
// Small local models (Gemma 3 1B/4B) follow "remove the fillers" unreliably:
// they punctuate the transcript beautifully and leave every "um" in place. The
// prompt directive stays the primary lever, but for the handful of pure
// interjections that carry no meaning in any sentence, a regex is simply
// correct where a 4B model is a coin flip.
//
// The scope is deliberately tiny: the "um" / "uh" / "erm" families only, never
// words that can be meaningful ("like", "you know", "so", "right"). Dropping
// those wrongly changes what the speaker said, and never losing the user's
// words outranks a tidier transcript — so they stay the model's job.

// Interjections as STT writes them: um, umm, uh, uhh, uhm, erm. The lookarounds
// (rather than \b) also keep "uh-huh" and "uh-oh" intact.
const FILLER = /(?<![\w-])(?:u[mh]+|erm+)(?![\w-])/gi;

const CUT = "\u0000"; // stands in for a removed filler
const CAP = "\u0001"; // marks a sentence that lost its opening word

/**
 * Remove standalone "um"/"uh"/"erm" fillers and repair the punctuation and
 * spacing their removal leaves behind. Returns the input unchanged when there
 * is nothing to strip (and if stripping somehow emptied the text).
 *
 * @param {string} text
 * @returns {string}
 */
function stripFillers(text) {
  if (typeof text !== "string" || text === "") return text;

  let hit = false;
  const marked = text.replace(FILLER, (m) => {
    // "UM" / "UH" in caps reads as an acronym, not a stumble.
    if (m === m.toUpperCase()) return m;
    hit = true;
    return CUT;
  });
  if (!hit) return text;

  // Take the filler with the comma that only existed to fence it off. A comma
  // BEFORE the filler belongs to the preceding clause ("So, um, we" -> "So,
  // we"); one that only follows is the filler's own ("is uh, for" -> "is for").
  let out = marked.replace(
    new RegExp(`(\\s*,)?[^\\S\\n]*${CUT}[^\\S\\n]*(?:,[^\\S\\n]*)?`, "g"),
    (m, before, offset, whole) => {
      if (before) return ", ";
      // Opening a sentence? The next word has to take over the capital.
      const head = whole.slice(0, offset);
      return /(?:^|[.!?:;\n]["')\]]?\s*)$/.test(head) ? ` ${CAP}` : " ";
    }
  );

  out = out
    .replace(new RegExp(`${CAP}(\\p{Ll})`, "gu"), (m, ch) => ch.toUpperCase())
    .split(CAP)
    .join("")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+([,.;:!?])/g, "$1")
    .replace(/,[^\S\n]*,/g, ",")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/^[^\S\n]*,[^\S\n]*/gm, "")
    .trim();

  return out.length > 0 ? out : text;
}

module.exports = { stripFillers };
