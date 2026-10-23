// Delivering a transcript as one line, for agents in a terminal (#68).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { joinLines, deliverText } = require("../main/output/single-line");
const { DEFAULTS } = require("../main/settings");

const words = (s) => s.split(/\s+/).filter(Boolean);

test("every kind of line break becomes one space", () => {
  assert.strictEqual(
    joinLines("First paragraph.\n\nSecond paragraph.\r\nThird  \n   line.\rFourth fifth sixth"),
    "First paragraph. Second paragraph. Third line. Fourth fifth sixth"
  );
});

test("no word is lost, and only whitespace changes", () => {
  const text = "Refactor `LivePreview` in main/live-preview.js.\n\n- keep the API\n- add a test\n\nThanks";
  const joined = joinLines(text);
  assert.ok(!/[\r\n]/.test(joined));
  assert.deepStrictEqual(words(joined), words(text));
});

test("a single line is left exactly as it was", () => {
  for (const text of ["one line", "  spaced  out  ", ""]) assert.strictEqual(joinLines(text), text);
});

test("breaks at the start or end leave no stray space", () => {
  assert.strictEqual(joinLines("\n\nhello\n\n"), "hello");
});

test("the setting is off by default, so an email keeps its paragraphs", () => {
  assert.strictEqual(DEFAULTS.output.singleLine, false);
});

test("deliverText joins only when the setting is explicitly on", () => {
  const text = "a\nb";
  assert.strictEqual(deliverText(text, { singleLine: true }), "a b");
  for (const output of [{ singleLine: false }, { singleLine: "yes" }, {}, undefined]) {
    assert.strictEqual(deliverText(text, output), text, JSON.stringify(output));
  }
});
