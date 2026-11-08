// Snippet records, validation, merging and tags (#334): renderer/snippets.js.
const { test } = require("node:test");
const assert = require("node:assert");
const S = require("../renderer/snippets");

const rec = (id, triggers, content = "text") => ({ id, triggers, content });

test("normalizeSnippets cleans, drops invalid records and is idempotent", () => {
  const dropped = [];
  const out = S.normalizeSnippets([
    rec("snp_a", ["  My   Address "], "line1\r\nline2"),
    rec("snp_b", ["my address", "Home"], "second"), // "my address" already owned by snp_a
    rec("snp_c", [], "no triggers"),
    rec("bad id", ["x1"], "t"),
    rec("snp_d", ["ok1"], "   "),
    rec("snp_a", ["other"], "duplicate id"),
    null,
  ], (r) => dropped.push(r));
  assert.deepStrictEqual(out, [rec("snp_a", ["My Address"], "line1\nline2"), rec("snp_b", ["Home"], "second")]);
  assert.ok(dropped.length >= 5);
  assert.deepStrictEqual(S.normalizeSnippets(out), out);
  assert.deepStrictEqual(S.normalizeSnippets("nope"), []);
});

test("stored snippets with an unknown tag load; saving one is refused", () => {
  const stored = [rec("snp_a", ["note"], "see {{nope}}")];
  assert.deepStrictEqual(S.normalizeSnippets(stored), stored);
  assert.throws(() => S.validateSnippets(stored), /Unknown tag {{nope}}/);
  // Unchanged from what is on disk is accepted, so an old file never blocks a save.
  assert.deepStrictEqual(S.validateSnippets(stored, { trusted: stored }), stored);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["note"], "x {{ }}")]), /Empty tag/);
  assert.doesNotThrow(() => S.validateSnippets([rec("snp_a", ["note"], "{{ Clipboard }} {{DATE}} {{time}} {{timezone}}")]));
});

test("validateSnippets enforces triggers, content and limits", () => {
  assert.throws(() => S.validateSnippets([rec("snp_a", [], "t")]), /at least one trigger/);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["!!!"], "t")]), /letter or digit/);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["a\nb"], "t")]), /one line/);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["a1"], "")]), /text to insert/);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["a1"], "x".repeat(S.SNIPPET_CONTENT_MAX + 1))]), /up to/);
  assert.throws(() => S.validateSnippets([rec("snp_a", ["a1"], "x\u0000")]), /control characters/);
  assert.throws(() => S.validateSnippets([rec("snp_a", Array.from({ length: 9 }, (_, i) => `t${i}`))]), /up to 8/);
  assert.throws(
    () => S.validateSnippets(Array.from({ length: S.SNIPPET_MAX + 1 }, (_, i) => rec(`snp_${i}`, [`t${i}`]))),
    /up to 100/
  );
  assert.throws(() => S.validateSnippets([rec("snp_a", ["Café"]), rec("snp_b", ["CAFÉ"])]), /already inserts/);
  // Kept exactly: surrounding whitespace and blank lines.
  const body = "  a\n\n b  \n";
  assert.strictEqual(S.validateSnippets([rec("snp_a", ["x1"], body)])[0].content, body);
});

test("mergeSnippets keeps independent edits per id and fails on a trigger clash", () => {
  const base = [rec("snp_a", ["alpha"], "A")];
  // Two windows each add a different snippet: both survive.
  const live = [...base, rec("snp_b", ["bravo"], "B")];
  const edited = [...base, rec("snp_c", ["charlie"], "C")];
  assert.deepStrictEqual(S.mergeSnippets(base, edited, live).map((r) => r.id), ["snp_a", "snp_c", "snp_b"]);
  // The form's edit of A beats the live copy; a live edit of an untouched one stays.
  const base2 = [rec("snp_a", ["alpha"], "A"), rec("snp_b", ["bravo"], "B")];
  const merged = S.mergeSnippets(base2, [rec("snp_a", ["alpha"], "A2"), base2[1]], [base2[0], rec("snp_b", ["bravo"], "B2")]);
  assert.deepStrictEqual(merged.map((r) => r.content), ["A2", "B2"]);
  // A delete in the form removes an untouched snippet, but not one edited elsewhere.
  assert.deepStrictEqual(S.mergeSnippets(base2, [base2[0]], base2), [base2[0]]);
  assert.deepStrictEqual(S.mergeSnippets(base2, [base2[0]], [base2[0], rec("snp_b", ["bravo"], "B2")]).map((r) => r.id), ["snp_a", "snp_b"]);
  // Deleted elsewhere and untouched here stays deleted.
  assert.deepStrictEqual(S.mergeSnippets(base2, base2, [base2[0]]), [base2[0]]);
  // Same trigger on two different snippets from two windows: the save fails.
  assert.throws(
    () => S.mergeSnippets(base, [...base, rec("snp_c", ["Delta"], "C")], [...base, rec("snp_b", ["delta"], "B")]),
    /already inserts/
  );
});

test("renderSnippet fills the four tags in one pass", () => {
  const now = new Date("2026-11-08T23:30:00Z");
  const ctx = { clipboard: "{{date}} and {{clipboard}}", now, timeZone: "Asia/Tokyo" };
  assert.strictEqual(S.renderSnippet("[{{clipboard}}]", ctx), "[{{date}} and {{clipboard}}]");
  assert.strictEqual(S.renderSnippet("{{date}} {{time}} {{timezone}}", ctx), "2026-11-09 08:30 Asia/Tokyo");
  assert.strictEqual(S.renderSnippet("{{ DATE }}", ctx), "2026-11-09");
  assert.strictEqual(
    S.renderSnippet("{{date}} {{time}}", { now, timeZone: "America/New_York" }),
    "2026-11-08 18:30"
  );
  // Unknown and empty tags are left as typed; lone braces too.
  assert.strictEqual(S.renderSnippet("{{nope}} {{}} {{ }} {{date", ctx), "{{nope}} {{}} {{ }} {{date");
  // Multiline text without tags is returned untouched.
  assert.strictEqual(S.renderSnippet("a\n\n  b ", ctx), "a\n\n  b ");
  // A bad zone falls back instead of throwing; no clipboard reads as empty.
  assert.match(S.renderSnippet("{{date}}", { now, timeZone: "Not/AZone" }), /^2026-11-0[89]$/);
  assert.strictEqual(S.renderSnippet("<{{clipboard}}>", {}), "<>");
  assert.strictEqual(S.renderSnippet("{{clipboard}}", { clipboard: "x".repeat(S.CLIPBOARD_MAX + 5) }).length, S.CLIPBOARD_MAX);
});

test("usesClipboard looks for the tag in any snippet", () => {
  assert.strictEqual(S.usesClipboard([rec("snp_a", ["a1"], "{{date}}")]), false);
  assert.strictEqual(S.usesClipboard([rec("snp_a", ["a1"], "x {{ Clipboard }}")]), true);
  assert.strictEqual(S.usesClipboard(undefined), false);
});

test("newSnippetId makes valid, distinct ids", () => {
  const a = S.newSnippetId();
  assert.match(a, /^snp_[0-9a-f]{16}$/);
  assert.notStrictEqual(a, S.newSnippetId());
  assert.doesNotThrow(() => S.validateSnippets([rec(a, ["x1"])]));
});
