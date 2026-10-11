const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rememberVocabulary, mergeVocabulary } = require("../renderer/vocabulary");

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
