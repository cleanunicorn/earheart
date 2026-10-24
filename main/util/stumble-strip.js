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
//     doubling can be deliberate ("had had", "very very", "two two",
//     "dot dot slash").
// Everything subtler stays the model's job. Which models still need this net
// is a catalog fact (`stumbleBackstop` in main/engines/registry.js), applied
// in main/services/route.js.

// Interjections as STT writes them: um, umm, uh, uhh, uhm, erm. The lookarounds
// (rather than \b) also keep "uh-huh" and "uh-oh" intact.
const FILLER = /(?<![\p{L}\p{N}_-])(?:u[mh]+|erm+)(?![\p{L}\p{N}_-])/giu;

// "UM" / "UH" in caps reads as an acronym, not a stumble, so it stays.
function isStrippableFiller(match) {
  return match !== match.toUpperCase();
}

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
    if (!isStrippableFiller(m)) return m;
    hit = true;
    return CUT;
  });
  if (!hit) return text;

  // Take the filler with the comma that only existed to fence it off. A comma
  // BEFORE the filler belongs to the preceding clause ("So, um, we" -> "So,
  // we"); one that only follows is the filler's own ("is uh, for" -> "is for").
  // `tail` is the sentence-ending punctuation the filler was sitting in front
  // of, which decides who the fencing comma really belonged to.
  //
  // A run of fillers ("um, uh") is one cut, so the seam is repaired once. The
  // match eats the horizontal whitespace on both sides of it and the callback
  // returns the join already correct — spacing anywhere else in the text is
  // the user's, and is never reflowed.
  let out = marked.replace(
    new RegExp(`([^\\S\\n]*,)?[^\\S\\n]*(?:${CUT}[^\\S\\n]*(?:,[^\\S\\n]*)?)+([.!?]+[^\\S\\n]*)?`, "g"),
    (m, before, tail, offset, whole) => {
      // Opening a sentence? The next word has to take over the capital.
      // (":" and ";" continue a sentence, so they are not boundaries here.)
      const head = whole.slice(0, offset);
      const opensSentence = /(?:^|[.!?\n]["'”’)\]]?\s*)$/.test(head);
      // At the start of a line there is nothing to separate from; at the end of
      // one there is nothing left to separate.
      const startsLine = head === "" || head.endsWith("\n");
      const next = whole[offset + m.length];
      const endsLine = next === undefined || next === "\n";

      if (tail) {
        // `tail` is the punctuation plus the spacing that followed it, so
        // whichever side keeps it keeps the seam intact.
        if (!opensSentence) {
          // The punctuation ends the running clause and stays, without the
          // comma that fenced the filler off ("that's it, um." -> "that's
          // it.").
          return endsLine ? tail.replace(/[^\S\n]+$/, "") : tail;
        }
        // A "sentence" that was nothing but the filler takes its punctuation
        // with it — the clause before it already ended with its own ("Do it.
        // Um! Really?" -> "Do it. Really?") — and the next word takes over the
        // capital it was holding ("Um... okay" -> "Okay").
        if (endsLine) return "";
        return startsLine ? CAP : ` ${CAP}`;
      }
      if (before) {
        // A comma with nothing left to fence off on either side goes too.
        if (startsLine) return "";
        // The clause keeps its comma, but not a second one and not a space in
        // front of punctuation that follows.
        if (endsLine || next === ",") return endsLine ? "," : "";
        return /[.;:!?]/.test(next) ? "," : ", ";
      }
      if (endsLine) return "";
      if (startsLine) return CAP;
      if (opensSentence) return ` ${CAP}`;
      // No space in front of the punctuation the filler was hiding.
      return /[,.;:!?]/.test(next) ? "" : " ";
    }
  );

  out = out
    .replace(new RegExp(`${CAP}(\\p{Ll})`, "gu"), (m, ch) => ch.toUpperCase())
    .split(CAP)
    .join("");

  return out.length > 0 ? out : text;
}

// Common doubled words that are grammatical in ordinary speech, not stutters.
// Collapsing these changes the sentence, so they are left exactly as spoken.
const KEEP_DOUBLED = new Set([
  "had", "that", "very", "really", "so", "no", "yes", "yeah", "ha", "hah",
  "bye", "night", "sorry", "hey", "well", "much", "many", "long", "far",
  "more", "less", "big", "little", "good", "bad", "again",
  "nous", "vous", "dat", "die", "der", "das", "den", "dem", "que",
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

// Spoken symbols: code dictation doubles them on purpose ("dot dot slash" is
// ../, "equals equals" is ==, "dash dash force" is --force). When the model
// leaves them as words, collapsing one changes the code; it is never a
// stutter worth the risk. Measured on the technical corpus
// (docs/cleanup-models.md): every symbol this backstop broke was one of these,
// and exempting them kept every filler it removed.
const SYMBOL_WORD = new Set([
  "dot", "dash", "hyphen", "slash", "backslash", "equals", "underscore",
  "star", "asterisk", "pipe", "ampersand", "plus", "minus", "colon",
  "semicolon", "hash", "pound", "bang", "tilde", "caret", "percent", "dollar",
  "backtick",
]);

function collapsible(word) {
  const key = word.toLowerCase();
  if (KEEP_DOUBLED.has(key) || NUMBER_WORD.has(key) || SYMBOL_WORD.has(key)) return false;
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

// Literal text both passes must leave alone (#290). The cleanup model was told
// to reproduce commands, paths and quoted strings exactly, and this backstop
// runs after it: `echo echo` is a command and its argument, not a stutter;
// "um" in src/um/parser.js is a directory; "um" in quotes is the string.
//   - spans: fenced and inline code, and quoted strings — double quotes, and
//     single quotes only at word edges, so "don't" is not a quote;
//   - tokens: a path or file name (src/um, parser.js, ./x, ~/x, /etc), a flag
//     (--force, -v), or a code identifier (camelCase, snake_case).
// A repeat that is NOT marked ("run echo echo") can't be told from a stutter
// and is still collapsed: marking it is what keeps it.
// A leading elision ('cause, 'tis, 'em) opens no quote: paired with a later
// possessive (dogs') it would shield the prose between them.
const ELISION = "(?!(?:cause|cos|tis|twas|til|em|n|bout|round|kay)\\b)";
const LITERAL_SPAN = new RegExp(
  [
    "```[\\s\\S]*?```",
    "`[^`\\n]+`",
    '"[^"\\n]*"',
    "“[^”\\n]*”",
    `(?<![\\p{L}\\p{N}])'${ELISION}[^'\\n]*'(?![\\p{L}\\p{N}])`,
    `(?<![\\p{L}\\p{N}])‘${ELISION}[^’\\n]*’(?![\\p{L}\\p{N}])`,
  ].join("|"),
  "giu"
);
// A quote's own closing punctuation ("stop.") stays outside the mask, so the
// sentence it ends still ends for the filler pass.
const QUOTE_CLOSE = /([.!?]+["”'’])$/u;
const LITERAL_TOKEN = /[^\s]+/gu;
// What surrounds a token without being part of it: sentence punctuation stays
// outside, so a path ending a sentence still ends it for the filler pass.
const TOKEN_EDGES = /^([(\[{<]*)([\s\S]*?)([.,;:!?)\]}>]*)$/u;

function isLiteralToken(t) {
  return (
    /[\p{L}\p{N}_][./\\_][\p{L}\p{N}_]/u.test(t) ||
    /^(?:\.{1,2}|~)?\/[\p{L}\p{N}_]/u.test(t) ||
    /^--?[A-Za-z]/.test(t) ||
    /\p{Ll}\p{Lu}/u.test(t)
  );
}

// Private-use characters stand in for the literals while the passes run: no
// letter or digit, so neither regex reads into or across them.
const PUA = /[\uE000-\uF8FF]/;

/**
 * Swap literal text for placeholders. Returns null when the text already
 * holds private-use characters, which a placeholder could be confused with.
 * @param {string} text
 * @returns {{ masked: string, unmask: (s: string) => string } | null}
 */
function maskLiterals(text) {
  if (PUA.test(text)) return null;
  const saved = [];
  // 6400 placeholders (U+E000–U+F8FF); past that a placeholder would be a
  // real character that can't be put back, so the text is left alone.
  let overflow = false;
  const hold = (literal) => {
    if (saved.length >= 0x1900) {
      overflow = true;
      return literal;
    }
    saved.push(literal);
    return String.fromCharCode(0xe000 + saved.length - 1);
  };
  let masked = text.replace(LITERAL_SPAN, (span) => {
    const close = span.startsWith("`") ? null : span.match(QUOTE_CLOSE);
    return close ? hold(span.slice(0, -close[1].length)) + close[1] : hold(span);
  });
  masked = masked.replace(LITERAL_TOKEN, (token) => {
    if (PUA.test(token)) return token;
    const [, open, core, close] = token.match(TOKEN_EDGES);
    return core && isLiteralToken(core) ? `${open}${hold(core)}${close}` : token;
  });
  if (overflow) return null;
  return {
    masked,
    unmask: (s) => s.replace(/[\uE000-\uF8FF]/g, (ch) => saved[ch.charCodeAt(0) - 0xe000]),
  };
}

/**
 * The full deterministic pass: drop fillers, then collapse the repeats —
 * in that order, because removing a filler can leave one behind
 * ("the um the file" -> "the the file" -> "the file"). Literal text (code,
 * quoted strings, paths, flags, identifiers) is never touched; a text that
 * can't be masked safely is returned as it came.
 *
 * @param {string} text
 * @returns {string}
 */
function stripStumbles(text) {
  if (typeof text !== "string" || text === "") return text;
  const literals = maskLiterals(text);
  if (!literals) return text;
  return literals.unmask(collapseRepeats(stripFillers(literals.masked)));
}

// FILLER, REPEAT and isStrippableFiller are exported for the cleanup
// benchmark (scripts/cleanup-metrics.js), which counts exactly what this
// backstop strips and so must use the same rules, not a copy of them.
module.exports = { stripStumbles, stripFillers, collapseRepeats, maskLiterals, FILLER, REPEAT, isStrippableFiller };
