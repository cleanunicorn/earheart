// Deterministic stumble removal — the safety net behind the cleanup model.
//
// Small local models (Gemma 3 1B/4B) follow "remove the fillers, collapse the
// repeats" unreliably: they punctuate the transcript beautifully and leave
// every "um" and every "the the" in place. The prompt directive stays the
// primary lever, but for the two stumble shapes that are mechanically
// recognisable, a regex is simply correct where a 4B model is a coin flip.
//
// Both passes are deliberately narrow, because never losing the user's words
// outranks a tidier transcript:
//   - fillers: the "um" / "uh" / "erm" families only, never words that can
//     be meaningful ("like", "you know", "so", "right");
//   - repeats: an immediately re-spoken word only, and never one whose
//     doubling can be deliberate ("had had", "very very", "two two").
// Everything subtler stays the model's job.

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
  // `tail` is the sentence-ending punctuation the filler was sitting in front
  // of, which decides who the fencing comma really belonged to.
  let out = marked.replace(
    new RegExp(`(\\s*,)?[^\\S\\n]*${CUT}[^\\S\\n]*(?:,[^\\S\\n]*)?([.!?]+)?`, "g"),
    (m, before, tail, offset, whole) => {
      // Opening a sentence? The next word has to take over the capital.
      // (":" and ";" continue a sentence, so they are not boundaries here.)
      const head = whole.slice(0, offset);
      const opensSentence = /(?:^|[.!?\n]["')\]]?\s*)$/.test(head);
      if (tail) {
        // A "sentence" that was nothing but the filler takes its punctuation
        // with it — the clause before it already ended with its own ("Do it.
        // Um! Really?" -> "Do it. Really?"). Anywhere else the punctuation ends
        // the running clause and stays, without the comma that fenced the
        // filler off ("that's it, um." -> "that's it.").
        return opensSentence ? "" : tail;
      }
      if (before) return ", ";
      if (!opensSentence) return " ";
      // At the very start of a line there is nothing to separate from.
      return head === "" || head.endsWith("\n") ? CAP : ` ${CAP}`;
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

// Words whose doubling is ordinary English, not a stutter. Collapsing these
// changes the sentence, so they are left exactly as spoken.
const KEEP_DOUBLED = new Set([
  "had", "that", "very", "really", "so", "no", "yes", "yeah", "ha", "hah",
  "bye", "night", "sorry", "hey", "well", "much", "many", "long", "far",
  "more", "less", "big", "little", "good", "bad", "again",
]);

// Digits and number words: a repeat is data ("two two three" is a phone
// number, not a stumble), never a stutter.
const NUMBER_WORD = new Set([
  "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
  "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
  "million", "billion", "double", "triple",
]);

// A word followed by itself, separated by spaces only — punctuation between
// them ("No, no") means the repetition was deliberate. Case-insensitive so
// "The the" is caught; the callback decides on the casing.
const REPEAT =
  /(?<![\p{L}\p{N}'’-])([\p{L}\p{N}][\p{L}\p{N}'’-]*)((?:[^\S\n]+\1)+)(?![\p{L}\p{N}'’-])/giu;

function collapsible(word) {
  const key = word.toLowerCase();
  if (KEEP_DOUBLED.has(key) || NUMBER_WORD.has(key)) return false;
  if (/[\p{N}]/u.test(word)) return false;
  // Single letters are usually spelled out ("V V" in a serial number); "I" and
  // "a" are the two that stutter instead.
  if (word.length === 1 && key !== "i" && key !== "a") return false;
  return true;
}

/**
 * Collapse an immediately re-spoken word ("the the file") into one. Skips
 * deliberate doublings, numbers, and a repeat that keeps its own capital
 * ("Walla Walla") — only a lowercase echo reads as a stutter.
 *
 * @param {string} text
 * @returns {string}
 */
function collapseRepeats(text) {
  if (typeof text !== "string" || text === "") return text;
  const out = text.replace(REPEAT, (m, word, rest) => {
    if (!collapsible(word)) return m;
    const echoes = rest.trim().split(/[^\S\n]+/);
    const stutter = echoes.every(
      (e) => e === e.toLowerCase() || (word === "I" && e === "I")
    );
    return stutter ? word : m;
  });
  return out.length > 0 ? out : text;
}

/**
 * The full deterministic pass: drop fillers, then collapse the repeats —
 * in that order, because removing a filler can leave one behind
 * ("the um the file" -> "the the file" -> "the file").
 *
 * @param {string} text
 * @returns {string}
 */
function stripStumbles(text) {
  return collapseRepeats(stripFillers(text));
}

module.exports = { stripStumbles, stripFillers, collapseRepeats };
