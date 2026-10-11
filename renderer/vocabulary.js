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

function rememberVocabulary(terms, spelling) {
  if (typeof spelling !== "string" || !spelling.trim()) throw new Error("Enter a spelling to remember.");
  const term = spelling.trim();
  if (term.length > 120 || /[\r\n\x00-\x1f\x7f]/.test(term)) {
    throw new Error("Use a word or phrase of up to 120 characters on one line.");
  }
  const dictionary = vocabularyTerms(terms);
  if (dictionary.includes(term)) return dictionary;
  dictionary.push(term);
  if (dictionary.length > 256 || dictionary.join("\n").length > 8192) {
    throw new Error("The dictionary is full. Remove some words in Settings before adding another.");
  }
  return dictionary;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { vocabularyTerms, mergeVocabulary, rememberVocabulary };
}
