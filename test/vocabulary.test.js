const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rememberVocabulary, mergeVocabulary, addVocabulary, dictionaryProblem, VOCAB_LIMITS } = require("../renderer/vocabulary");

test("remember trims and deduplicates exact spellings without conflating identifiers", () => {
  assert.deepEqual(rememberVocabulary(["kubectl", "getUser"], " kubectl "), ["kubectl", "getUser"]);
  assert.deepEqual(rememberVocabulary(["Foo"], "foo"), ["Foo", "foo"]);
  assert.deepEqual(rememberVocabulary([], "Visual Studio Code"), ["Visual Studio Code"]);
});
test("remember rejects blank, control characters and unbounded dictionary growth", () => {
  for (const term of [null, " ", "hello\nworld", "a".repeat(121)]) assert.throws(() => rememberVocabulary([], term));
  assert.throws(() => rememberVocabulary(Array.from({ length: 256 }, (_, i) => `word${i}`), "new"), /full/);
  assert.throws(() => rememberVocabulary(Array.from({ length: 80 }, (_, i) => "a".repeat(110) + i), "new"), /full/);
});
test("concurrent form edits retain new remembered words and intentional removals", () => {
  assert.deepEqual(mergeVocabulary(["old", "remove"], ["old", "typed"], ["old", "remove", "remembered"]), ["old", "remembered", "typed"]);
  assert.deepEqual(mergeVocabulary(["old"], ["old"], ["new"]), ["new"]);
  assert.deepEqual(mergeVocabulary([], [], ["kubectl"]), ["kubectl"]);
});

test("live vocabulary merge preserves blank lines, spaces and unfinished form text", () => {
  const { mergeVocabularyText } = require("../renderer/vocabulary");
  assert.equal(mergeVocabularyText(["old"], " old \n\nnew draft\n", ["old", "kubectl"]), " old \n\nnew draft\n\nkubectl");
  assert.equal(mergeVocabularyText(["old"], "old\nkeep", ["kubectl"]), "keep\nkubectl");
});

test("addVocabulary merges a batch up to the term and character limits and reports the rest", () => {
  const first = addVocabulary(["kubectl"], [" kubectl ", "pnpm", "bad\nterm", "x".repeat(121), "Vitest"]);
  assert.deepEqual(first.terms, ["kubectl", "pnpm", "Vitest"]);
  assert.deepEqual(first.added, ["pnpm", "Vitest"]);
  assert.ok(first.skipped.includes("x".repeat(121)));
  const full = Array.from({ length: VOCAB_LIMITS.terms - 1 }, (_, i) => `word${i}`);
  const filled = addVocabulary(full, ["one", "two", "three"]);
  assert.equal(filled.terms.length, VOCAB_LIMITS.terms);
  assert.deepEqual(filled.added, ["one"]);
  assert.deepEqual(filled.skipped, ["two", "three"]);
  const wide = addVocabulary(Array.from({ length: 72 }, (_, i) => "a".repeat(110) + i), ["a".repeat(110) + "x", "a".repeat(110) + "y"]);
  assert.ok(wide.terms.join("\n").length <= VOCAB_LIMITS.chars);
  assert.ok(wide.skipped.length >= 1);
});

test("dictionaryProblem names an over-limit list so Save can refuse it", () => {
  assert.equal(dictionaryProblem(["kubectl", "pnpm"]), "");
  assert.match(dictionaryProblem(Array.from({ length: VOCAB_LIMITS.terms + 5 }, (_, i) => `w${i}`)), /limit is 256\. Remove 5/);
  assert.match(dictionaryProblem(Array.from({ length: 80 }, (_, i) => "a".repeat(110) + i)), /8192/);
  assert.match(dictionaryProblem(["a".repeat(121)]), /not a valid term/);
});
