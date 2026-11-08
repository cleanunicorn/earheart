// Shared by the settings form and main: merge concurrent dictionary edits by
// intent, retaining additions made in the correction window while a form is open.
function vocabularyTerms(terms) {
  return [...new Set((Array.isArray(terms) ? terms : [])
    .filter((term) => typeof term === "string").map((term) => term.trim()).filter(Boolean))];
}

function mergeVocabulary(baseline, edited, live) {
  const before = new Set(vocabularyTerms(baseline));
  const wanted = vocabularyTerms(edited);
  const removed = new Set([...before].filter((term) => !wanted.includes(term)));
  return vocabularyTerms([...vocabularyTerms(live).filter((term) => !removed.has(term)),
    ...wanted.filter((term) => !before.has(term))]);
}

// Keep the form's line formatting while adding/removing concurrent terms.
// A blank line the user is currently typing on must not vanish on an update.
function mergeVocabularyText(baseline, text, live) {
  const merged = new Set(mergeVocabulary(baseline, text.split("\n"), live));
  const lines = text.split("\n").filter((line) => !line.trim() || merged.has(line.trim()));
  const represented = new Set(vocabularyTerms(lines));
  return [...lines, ...[...merged].filter((term) => !represented.has(term))].join("\n");
}

// Limits on the user's own dictionary. They apply to every way a term arrives
// that is not typed straight into the Settings textarea: a remembered spelling
// and a batch learned from a folder (addVocabulary).
const VOCAB_LIMITS = { termChars: 120, terms: 256, chars: 8192 };

function validTerm(term) {
  return typeof term === "string" && term.length > 0 && term.length <= VOCAB_LIMITS.termChars &&
    !/[\r\n\x00-\x1f\x7f]/.test(term);
}

// Add `additions` to `terms` until a limit would be crossed. Returns the new
// list, the terms that went in and the ones left out (invalid, duplicate or
// over a limit), so a review UI can say what it skipped.
function addVocabulary(terms, additions) {
  const dictionary = vocabularyTerms(terms);
  const have = new Set(dictionary);
  let chars = dictionary.join("\n").length;
  const added = [];
  const skipped = [];
  for (const raw of vocabularyTerms(additions)) {
    const grown = chars + (dictionary.length ? 1 : 0) + raw.length;
    if (have.has(raw)) continue;
    if (!validTerm(raw) || dictionary.length >= VOCAB_LIMITS.terms || grown > VOCAB_LIMITS.chars) {
      skipped.push(raw);
      continue;
    }
    dictionary.push(raw);
    have.add(raw);
    chars = grown;
    added.push(raw);
  }
  return { terms: dictionary, added, skipped };
}

function rememberVocabulary(terms, spelling) {
  if (typeof spelling !== "string" || !spelling.trim()) throw new Error("Enter a spelling to remember.");
  const term = spelling.trim();
  if (!validTerm(term)) {
    throw new Error("Use a word or phrase of up to 120 characters on one line.");
  }
  const dictionary = vocabularyTerms(terms);
  if (dictionary.includes(term)) return dictionary;
  dictionary.push(term);
  if (dictionary.length > VOCAB_LIMITS.terms || dictionary.join("\n").length > VOCAB_LIMITS.chars) {
    throw new Error("The dictionary is full. Remove some words in Settings before adding another.");
  }
  return dictionary;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    vocabularyTerms, mergeVocabulary, mergeVocabularyText, rememberVocabulary, addVocabulary, VOCAB_LIMITS,
  };
}
