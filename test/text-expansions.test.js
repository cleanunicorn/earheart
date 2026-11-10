// The matcher and orchestration for spoken snippets (#334).
const { test } = require("node:test");
const assert = require("node:assert");
const { planExpansion, expandTranscript, MAX_EXPANSIONS } = require("../main/text-expansions");

const rec = (id, triggers, content) => ({ id, triggers, content });
const text = (plan) => plan.segments.map((s) => (s.type === "text" ? `~${s.text}` : `[${s.id}]`)).join("");

test("no snippets or no trigger means no match", () => {
  assert.deepStrictEqual(planExpansion("hello", []), { matched: false });
  assert.deepStrictEqual(planExpansion("hello", [rec("a", ["my address"], "X")]), { matched: false });
  assert.deepStrictEqual(planExpansion("", [rec("a", ["x1"], "X")]), { matched: false });
  assert.deepStrictEqual(planExpansion(null, [rec("a", ["x1"], "X")]), { matched: false });
});

test("case-insensitive, whole words only, any run of whitespace", () => {
  const snippets = [rec("a", ["my address"], "X")];
  assert.strictEqual(text(planExpansion("send My   ADDRESS now", snippets)), "~send [a]~ now");
  assert.strictEqual(planExpansion("my addresses", snippets).matched, false);
  assert.strictEqual(planExpansion("army address", snippets).matched, false);
  assert.strictEqual(planExpansion("my_address", snippets).matched, false);
  assert.strictEqual(text(planExpansion("Say, my address, please", snippets)), "~Say, [a]~, please");
});

test("overlap: leftmost wins, then the longest trigger at that spot", () => {
  const snippets = [rec("short", ["my"], "S"), rec("mid", ["my address"], "M"), rec("long", ["my address book"], "L"), rec("tail", ["address book"], "T")];
  assert.strictEqual(text(planExpansion("my address book", snippets)), "[long]");
  assert.strictEqual(text(planExpansion("my address", snippets)), "[mid]");
  assert.strictEqual(text(planExpansion("my cat", snippets)), "[short]~ cat");
  // A longer trigger that fails its boundary falls back to the shorter one.
  assert.strictEqual(text(planExpansion("my addressbook", snippets)), "[short]~ addressbook");
  // Matches never overlap: "address book" cannot reuse the "address" in "my address".
  assert.strictEqual(text(planExpansion("my address then address book", [rec("mid", ["my address"], "M"), rec("tail", ["address book"], "T")])), "[mid]~ then [tail]");
});

test("Unicode: NFC/NFD, case folding and non-Latin boundaries", () => {
  const snippets = [rec("a", ["café"], "X"), rec("b", ["Straße"], "Y"), rec("c", ["пример"], "Z")];
  assert.strictEqual(text(planExpansion("un café noir", snippets)), "~un [a]~ noir");
  assert.strictEqual(text(planExpansion("STRASSE".toLowerCase() + " STRAßE", snippets)), "~strasse [b]");
  assert.strictEqual(text(planExpansion("ПРИМЕР тут", snippets)), "[c]~ тут");
  assert.strictEqual(planExpansion("cafés", snippets).matched, false, "a letter after the trigger is not a boundary");
  assert.strictEqual(planExpansion("naïve café́", snippets).matched, false, "a combining mark continues the word");
});

test("expansion never cascades: a snippet body is not scanned", () => {
  const snippets = [rec("a", ["one"], "say two"), rec("b", ["two"], "second")];
  const plan = planExpansion("one", snippets);
  assert.strictEqual(text(plan), "[a]");
  return expandTranscript("one", snippets).then((r) => assert.strictEqual(r.text, "say two"));
});

test("the ends of the utterance: surrounding space and trailing punctuation go", () => {
  const snippets = [rec("a", ["my address"], "X")];
  assert.strictEqual(text(planExpansion("  My address.  ", snippets)), "[a]");
  assert.strictEqual(text(planExpansion("My address…", snippets)), "[a]");
  assert.strictEqual(text(planExpansion("My address. Thanks.", snippets)), "[a]~. Thanks.");
});

test("at most MAX_EXPANSIONS snippets per utterance; later triggers stay words", () => {
  const snippets = [rec("a", ["go"], "X")];
  const plan = planExpansion(Array.from({ length: MAX_EXPANSIONS + 3 }, () => "go").join(" "), snippets);
  assert.strictEqual(plan.segments.filter((s) => s.type === "snippet").length, MAX_EXPANSIONS);
});

test("expandTranscript: exact bodies, only the words between are cleaned and finished", async () => {
  const body = "L1\n  L2 {{nope}}\n\n";
  const snippets = [rec("a", ["my address"], body)];
  const cleaned = [];
  const out = await expandTranscript("um send my address air heart ok", snippets, {
    clean: async (words) => { cleaned.push(words); return { text: `<${words}>`, cleaned: true }; },
    finish: (words) => words.replace("air heart", "Earheart"),
  });
  assert.deepStrictEqual(cleaned, ["um send", "air heart ok"]);
  assert.deepStrictEqual(out, { text: `<um send> ${body} <Earheart ok>`, cleaned: true });
});

test("expandTranscript: a lone trigger bypasses cleanup entirely", async () => {
  let calls = 0;
  const out = await expandTranscript("My Address.", [rec("a", ["my address"], "X\nY")], {
    clean: async () => { calls += 1; return { text: "", cleaned: true }; },
  });
  assert.deepStrictEqual(out, { text: "X\nY", cleaned: false });
  assert.strictEqual(calls, 0);
});

test("expandTranscript: returns null when nothing matches, and reports staleness", async () => {
  assert.strictEqual(await expandTranscript("hello", [rec("a", ["my address"], "X")]), null);
  const out = await expandTranscript("hi my address", [rec("a", ["my address"], "X")], {
    clean: async () => ({ text: "hi", cleaned: true }),
    stale: () => true,
  });
  assert.deepStrictEqual(out, { stale: true });
});

test("expandTranscript: the first failed cleanup leaves the remaining words raw", async () => {
  let calls = 0;
  const out = await expandTranscript("a1 go b2 go c3", [rec("g", ["go"], "G")], {
    clean: async (words) => { calls += 1; return { text: words, cleaned: false }; },
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(out, { text: "a1 G b2 G c3", cleaned: false });
});

test("expandTranscript: cleanup that empties a segment leaves one space between snippets, none at the ends", async () => {
  const snippets = [rec("g", ["go"], "G")];
  const clean = async () => ({ text: "", cleaned: true });
  assert.strictEqual((await expandTranscript("um go um go um", snippets, { clean })).text, "G G");
});

test("expandTranscript: clipboard text is inserted once and not expanded", async () => {
  const snippets = [rec("q", ["quote"], "> {{clipboard}}"), rec("d", ["dee"], "D")];
  const out = await expandTranscript("quote", snippets, { context: { clipboard: "dee {{clipboard}} {{date}}" } });
  assert.strictEqual(out.text, "> dee {{clipboard}} {{date}}");
});
