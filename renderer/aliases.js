// Dictionary aliases (#335): explicit "when you hear X, write Y" rules, applied
// to every delivered transcript whether cleanup runs or not. Shared by main
// (settings load, the pipeline, IPC) and the settings and correction windows
// (classic-script globals there, like vocabulary.js).
//
// Stored as cleanup.aliases: [{ term: "Earheart", heard: ["air heart"] }], one
// record per canonical term, beside cleanup.dictionary (which is unchanged).
//
// Matching rules, all in applyAliases:
// - One pass, left to right; at each position the longest heard form wins.
//   Replaced text is never scanned again, so replacements never chain.
// - Case-insensitive (Unicode simple case folding); the canonical term is
//   written exactly as stored.
// - Whole words only: no letter, mark, digit or underscore on either side.
// - Whitespace inside a heard form matches any run of whitespace.
// - The text is compared in NFC; when nothing is replaced it is returned as it
//   came in, byte for byte.
// - Backtick code (inline and fenced), URLs and path-like tokens are left
//   alone, as is any match touching one.

const ALIAS_TEXT_MAX = 120;
const ALIAS_HEARD_MAX = 256;

// A heard form's identity: what two spellings must share to be the same alias.
function aliasKey(text) {
  return String(text).normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function cleanPhrase(text) {
  return String(text).normalize("NFC").trim().replace(/\s+/gu, " ");
}

// Why `text` can't be a term or heard form, or "" when it can.
function phraseProblem(text, what) {
  if (typeof text !== "string" || !text.trim()) return `Enter ${what}.`;
  if (/[\x00-\x1f\x7f]/.test(text.trim())) return `Use ${what} on one line.`;
  const phrase = cleanPhrase(text);
  if (phrase.length > ALIAS_TEXT_MAX) return `Use ${what} of up to ${ALIAS_TEXT_MAX} characters.`;
  if (!/[\p{L}\p{N}]/u.test(phrase)) return `Use ${what} with at least one letter or digit.`;
  return "";
}

// Throwing validation of one heard → term rule against existing records. Used
// for everything a user adds; `records` are already normalized.
function checkAlias(records, heard, term) {
  const termProblem = phraseProblem(term, "a spelling");
  if (termProblem) throw new Error(termProblem);
  const heardProblem = phraseProblem(heard, "the words you heard");
  if (heardProblem) throw new Error(heardProblem);
  const key = aliasKey(heard);
  const canonical = cleanPhrase(term);
  if (key.includes("`")) throw new Error("Heard words can't contain backticks.");
  if (heard.includes("->") || heard.includes("→") || heard.includes(",")) {
    throw new Error("Heard words can't contain commas or arrows.");
  }
  // The arrow separates the two halves of a Settings line, so a spelling
  // holding one could be saved here but never parsed back from Settings.
  if (canonical.includes("->") || canonical.includes("→")) {
    throw new Error("A spelling for Always replace can't contain an arrow.");
  }
  for (const record of records) {
    if (record.term === canonical) continue;
    if (record.heard.some((h) => aliasKey(h) === key)) {
      throw new Error(`“${cleanPhrase(heard)}” already becomes “${record.term}”. Remove it there first.`);
    }
    if (aliasKey(record.term) === key) {
      throw new Error(`“${cleanPhrase(heard)}” can't become “${canonical}”: other words already become “${record.term}”.`);
    }
    // The other direction: a spelling that is itself replaced would undo
    // the user's own correction the next time they say it right.
    if (record.heard.some((h) => aliasKey(h) === aliasKey(canonical))) {
      throw new Error(`“${canonical}” is already replaced with “${record.term}”. Remove that first.`);
    }
  }
  return { key, heard: cleanPhrase(heard), term: canonical };
}

// The records as stored, made valid without ever throwing: what settings.json
// holds may be hand-edited or written by another version. Invalid entries are
// dropped; a heard form claimed twice stays with the first record that has it.
// `onDrop(reason)` reports each dropped entry. Idempotent: normalizing the
// output again returns an equal value.
function normalizeAliases(value, onDrop = () => {}) {
  const records = [];
  const byTerm = new Map();
  const owned = new Map();
  let count = 0;
  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== "object" || phraseProblem(entry.term, "a spelling")) {
      onDrop("an alias record without a valid spelling");
      continue;
    }
    const term = cleanPhrase(entry.term);
    let record = byTerm.get(term);
    if (!record) {
      record = { term, heard: [] };
      byTerm.set(term, record);
      records.push(record);
    }
    for (const heard of Array.isArray(entry.heard) ? entry.heard : []) {
      let checked;
      try {
        checked = checkAlias(records, heard, term);
      } catch (err) {
        onDrop(err.message);
        continue;
      }
      if (owned.has(checked.key)) {
        if (owned.get(checked.key) !== term) onDrop(`a heard form already owned by “${owned.get(checked.key)}”`);
        continue;
      }
      if (count >= ALIAS_HEARD_MAX) {
        onDrop("an alias past the limit");
        continue;
      }
      owned.set(checked.key, term);
      record.heard.push(checked.heard);
      count += 1;
    }
  }
  // A term whose heard forms were all dropped has nothing left to say, and an
  // empty record would come back as a blank line in Settings.
  return records.filter((record) => record.heard.length > 0);
}

// Flat heard → term pairs keyed by aliasKey, in stored order.
function aliasPairs(records) {
  const pairs = new Map();
  for (const record of normalizeAliases(records)) {
    for (const heard of record.heard) pairs.set(aliasKey(heard), { heard, term: record.term });
  }
  return pairs;
}

// Group pairs back into records. A pair that wouldn't survive normalization
// (a second owner, a spelling that is itself replaced, past the limit) throws
// instead of being dropped: this builds what a user is saving, never repairs
// a stored file.
function recordsFromPairs(pairs) {
  const byTerm = new Map();
  for (const { heard, term } of pairs) {
    if (!byTerm.has(term)) byTerm.set(term, { term, heard: [] });
    byTerm.get(term).heard.push(heard);
  }
  return normalizeAliases([...byTerm.values()], (reason) => {
    throw new Error(`Always replace was not saved: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`);
  });
}

// Merge a form's edits into what main has saved since, by intent and per heard
// form, like mergeVocabulary: a pair the form removed goes, a pair it added or
// changed comes in (the later, explicit choice of owner wins), and pairs
// another window added while the form was open stay.
function mergeAliases(baseline, edited, live) {
  const before = aliasPairs(baseline);
  const wanted = aliasPairs(edited);
  const current = aliasPairs(live);
  // In the form's order first, so the saved list reads like the form, then
  // what only main has.
  const result = new Map();
  for (const [key, pair] of wanted) {
    const untouched = before.get(key)?.term === pair.term;
    if (!untouched) result.set(key, pair);
    else if (current.has(key)) result.set(key, current.get(key));
  }
  for (const [key, pair] of current) {
    if (result.has(key)) continue;
    if (!wanted.has(key) && before.get(key)?.term === pair.term) continue;
    result.set(key, pair);
  }
  // A term the form added a heard form for can clash with a term that became
  // a heard form elsewhere, or the two can overflow the limit together:
  // recordsFromPairs throws then, so the save fails and live is kept intact.
  return recordsFromPairs(result.values());
}

// Add one heard → term rule (Replace & remember with "Always replace"). Throws
// a message fit for the correction window on a conflict or a full list.
function rememberAlias(records, heard, term) {
  const current = normalizeAliases(records);
  const checked = checkAlias(current, heard, term);
  const pairs = aliasPairs(current);
  if (pairs.get(checked.key)?.term === checked.term) return current;
  if (pairs.size >= ALIAS_HEARD_MAX) {
    throw new Error("The alias list is full. Remove some in Settings before adding another.");
  }
  pairs.set(checked.key, { heard: checked.heard, term: checked.term });
  return recordsFromPairs(pairs.values());
}

// The Settings textarea: one canonical term per line, its heard forms first.
//   air heart, ear heart -> Earheart
function formatAliases(records) {
  return normalizeAliases(records).map((r) => `${r.heard.join(", ")} -> ${r.term}`).join("\n");
}

// Parse the textarea back into records. Throws, naming the line, on anything
// that isn't a valid rule or that would give one heard form two owners: an
// alias is never dropped behind the user's back.
function parseAliases(text) {
  const records = [];
  const lines = String(text).split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const where = `Always replace, line ${index + 1}:`;
    const parts = line.split(/->|→/);
    if (parts.length !== 2) throw new Error(`${where} write it as “heard words -> spelling”.`);
    const term = parts[1];
    const heardList = parts[0].split(",").filter((h) => h.trim());
    if (heardList.length === 0) throw new Error(`${where} add the words you heard before the arrow.`);
    let record = records.find((r) => r.term === cleanPhrase(term));
    for (const heard of heardList) {
      let checked;
      try {
        checked = checkAlias(records, heard, term);
      } catch (err) {
        throw new Error(`${where} ${err.message}`);
      }
      if (!record) {
        record = { term: checked.term, heard: [] };
        records.push(record);
      }
      if (!record.heard.some((h) => aliasKey(h) === checked.key)) record.heard.push(checked.heard);
    }
  });
  const count = records.reduce((n, r) => n + r.heard.length, 0);
  if (count > ALIAS_HEARD_MAX) throw new Error(`Always replace holds up to ${ALIAS_HEARD_MAX} heard forms.`);
  return records;
}

// Canonical terms, for the cleanup prompt's preferred-vocabulary block.
function aliasTerms(records) {
  return normalizeAliases(records).map((r) => r.term);
}

const WORD = "[\\p{L}\\p{M}\\p{N}_]";
// Spans no alias may touch: fenced and inline code, URLs, and tokens that
// look like paths (anything with a slash or backslash, or starting with ~).
const PROTECTED = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+|[^\s`]*[\\/][^\s`]*|~[^\s`]*/giu;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace every heard form in `text` with its canonical term. Pure and total:
// any string in, a string out; anything that isn't one comes back unchanged.
function applyAliases(text, records) {
  if (typeof text !== "string" || !text) return text;
  const pairs = [...aliasPairs(records).values()];
  if (pairs.length === 0) return text;
  const source = text.normalize("NFC");
  const byKey = new Map(pairs.map((p) => [aliasKey(p.heard), p.term]));
  const alternatives = pairs
    .map((p) => p.heard)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .map((heard) => heard.split(" ").map(escapeRegExp).join("\\s+"));
  const pattern = new RegExp(`(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`, "giu");
  const guarded = [];
  for (const m of source.matchAll(PROTECTED)) {
    if (m[0]) guarded.push([m.index, m.index + m[0].length]);
  }
  let replaced = false;
  const out = source.replace(pattern, (match, offset) => {
    const end = offset + match.length;
    if (guarded.some(([a, b]) => offset < b && end > a)) return match;
    const term = byKey.get(aliasKey(match));
    if (term === undefined) return match;
    if (term !== match) replaced = true;
    return term;
  });
  return replaced ? out : text;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ALIAS_TEXT_MAX,
    ALIAS_HEARD_MAX,
    aliasKey,
    normalizeAliases,
    mergeAliases,
    rememberAlias,
    formatAliases,
    parseAliases,
    aliasTerms,
    applyAliases,
  };
}
