const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ALIAS_HEARD_MAX,
  aliasKey,
  normalizeAliases,
  mergeAliases,
  rememberAlias,
  formatAliases,
  parseAliases,
  aliasTerms,
  applyAliases,
} = require("../renderer/aliases");

const EARHEART = [{ term: "Earheart", heard: ["air heart", "ear heart"] }];

test("applyAliases replaces whole heard words, any case, with the term as written", () => {
  assert.equal(applyAliases("I use air heart daily.", EARHEART), "I use Earheart daily.");
  assert.equal(applyAliases("AIR HEART! Ear Heart?", EARHEART), "Earheart! Earheart?");
  assert.equal(applyAliases("air heart's logo", EARHEART), "Earheart's logo");
  assert.equal(applyAliases("air\n  heart", EARHEART), "Earheart", "any whitespace run inside a heard form");
});

test("applyAliases leaves unrelated substrings alone", () => {
  for (const text of ["fair heart", "air hearted", "chair heart", "airheart", "air_heart", "air heart2", "air", "heart"]) {
    assert.equal(applyAliases(text, EARHEART), text);
  }
});

test("applyAliases returns its input untouched when nothing is replaced", () => {
  const nfd = "Cafe\u0301 au lait";
  assert.equal(applyAliases(nfd, EARHEART), nfd, "no NFC rewrite without a replacement");
  assert.equal(applyAliases("Earheart", [{ term: "Earheart", heard: ["earheart"] }]), "Earheart");
  assert.equal(applyAliases("", EARHEART), "");
  assert.equal(applyAliases("air heart", []), "air heart");
  assert.equal(applyAliases("air heart", undefined), "air heart");
  assert.equal(applyAliases(undefined, EARHEART), undefined);
});

test("applyAliases matches across Unicode normalization and scripts", () => {
  const records = [
    { term: "Zoë", heard: ["zoe e"] },
    { term: "Ångström", heard: ["ong strom"] },
    { term: "Привет", heard: ["прив ет"] },
    { term: "東京", heard: ["とうきょう"] },
  ];
  assert.equal(applyAliases("Hi zoe e!", records), "Hi Zoë!");
  assert.equal(applyAliases("ONG STROM units", records), "Ångström units");
  assert.equal(applyAliases("ПРИВ ЕТ мир", records), "Привет мир");
  assert.equal(applyAliases("行くとうきょう", records), "行くとうきょう", "a letter before it is not a word boundary");
  assert.equal(applyAliases("行く とうきょう", records), "行く 東京");
  // An NFD heard form and NFD text both match after NFC.
  const decomposed = [{ term: "Renée", heard: ["rene\u0301e"] }];
  assert.equal(applyAliases("hi rene\u0301e", decomposed), "hi Renée");
  assert.equal(applyAliases("hi renée", decomposed), "hi Renée");
  // A combining mark after the heard form is part of the word.
  assert.equal(applyAliases("air hearte\u0301", EARHEART), "air hearte\u0301");
});

test("applyAliases never chains: replaced text is not scanned again", () => {
  const records = [
    { term: "beta", heard: ["alpha"] },
    { term: "gamma", heard: ["beta x"] },
  ];
  // normalizeAliases keeps both: "beta" is a term, "beta x" a different heard form.
  assert.equal(applyAliases("alpha x", records), "beta x");
  assert.equal(applyAliases("beta x alpha", records), "gamma beta");
});

test("applyAliases prefers the longest heard form at a position and does not overlap", () => {
  const records = [
    { term: "New York", heard: ["new york"] },
    { term: "New York City", heard: ["new york city"] },
    { term: "Yorkshire", heard: ["york shire"] },
  ];
  assert.equal(applyAliases("new york city", records), "New York City");
  assert.equal(applyAliases("new york shire", records), "New York shire", "leftmost match wins; no overlap");
  assert.equal(applyAliases("in york shire", records), "in Yorkshire");
});

test("applyAliases protects code, paths and URLs", () => {
  const cases = [
    "run `air heart` now",
    "```\nair heart\n```",
    "open /home/air heart",
    "see https://example.com/air heart",
    "C:\\air heart",
    "www.air heart",
    "~/air heart",
  ];
  for (const text of cases) assert.equal(applyAliases(text, EARHEART), text, text);
  assert.equal(applyAliases("`x` air heart `y`", EARHEART), "`x` Earheart `y`");
  assert.equal(applyAliases("```js\ncode\n``` then air heart", EARHEART), "```js\ncode\n``` then Earheart");
});

test("aliasKey folds case, NFC and whitespace", () => {
  assert.equal(aliasKey("  Air \t HEART "), "air heart");
  assert.equal(aliasKey("Rene\u0301e"), aliasKey("renée"));
});

test("rememberAlias adds, dedupes and refuses a second owner", () => {
  const one = rememberAlias([], "air heart", "Earheart");
  assert.deepEqual(one, [{ term: "Earheart", heard: ["air heart"] }]);
  assert.deepEqual(rememberAlias(one, " AIR  heart ", "Earheart"), one, "same rule again is a no-op");
  assert.deepEqual(rememberAlias(one, "ear heart", "Earheart"), EARHEART);
  assert.throws(() => rememberAlias(one, "Air Heart", "Airheart"), /already becomes “Earheart”/);
  assert.throws(() => rememberAlias(one, "earheart", "Other"), /can't become “Other”: other words already become “Earheart”/);
  assert.throws(() => rememberAlias(one, "x", "air heart"), /is already replaced with “Earheart”/);
  assert.deepEqual(rememberAlias(one, "earheart", "Earheart")[0].heard, ["air heart", "earheart"],
    "a case fix of the term itself is allowed");
});

test("rememberAlias validates sizes and characters", () => {
  assert.throws(() => rememberAlias([], "", "Earheart"), /Enter the words you heard/);
  assert.throws(() => rememberAlias([], "air", ""), /Enter a spelling/);
  assert.throws(() => rememberAlias([], "a".repeat(121), "x"), /up to 120 characters/);
  assert.throws(() => rememberAlias([], "air\nheart", "x"), /one line/);
  assert.throws(() => rememberAlias([], "...", "x"), /letter or digit/);
  assert.throws(() => rememberAlias([], "a, b", "x"), /commas or arrows/);
  assert.throws(() => rememberAlias([], "`a`", "x"), /backticks/);
  const full = [{ term: "T", heard: Array.from({ length: ALIAS_HEARD_MAX }, (_, i) => `w${i}`) }];
  assert.throws(() => rememberAlias(full, "one more", "T"), /full/);
});

test("normalizeAliases keeps one owner per heard form, drops junk, and is idempotent", () => {
  const dropped = [];
  const stored = [
    { term: " Earheart ", heard: ["air heart", "AIR HEART", 7, ""] },
    { term: "Airheart", heard: ["air heart", "airhart"] },
    { term: "", heard: ["x"] },
    null,
    "legacy",
    { term: "Earheart", heard: ["ear heart"] },
    { term: "Empty", heard: [] },
  ];
  const once = normalizeAliases(stored, (reason) => dropped.push(reason));
  assert.deepEqual(once, [
    { term: "Earheart", heard: ["air heart", "ear heart"] },
    { term: "Airheart", heard: ["airhart"] },
  ]);
  assert.ok(dropped.some((r) => /already becomes “Earheart”/.test(r)), "the second owner is reported");
  assert.deepEqual(normalizeAliases(once), once);
  assert.deepEqual(normalizeAliases(undefined), []);
  assert.deepEqual(normalizeAliases({ term: "x" }), []);
});

test("normalizeAliases caps the total number of heard forms", () => {
  const many = [{ term: "T", heard: Array.from({ length: ALIAS_HEARD_MAX + 5 }, (_, i) => `w${i}`) }];
  assert.equal(normalizeAliases(many)[0].heard.length, ALIAS_HEARD_MAX);
});

test("formatAliases and parseAliases round-trip", () => {
  const records = [...EARHEART, { term: "Kubernetes", heard: ["cooper netties"] }];
  const text = formatAliases(records);
  assert.equal(text, "air heart, ear heart -> Earheart\ncooper netties -> Kubernetes");
  assert.deepEqual(parseAliases(text), records);
  assert.deepEqual(parseAliases("air heart → Earheart\n\n  ear heart ->  Earheart  "), EARHEART,
    "the arrow glyph, blank lines and a term split over two lines");
  assert.deepEqual(parseAliases(""), []);
});

test("parseAliases names the line and never drops a conflicting alias", () => {
  assert.throws(() => parseAliases("air heart -> Earheart\nair heart -> Airheart"), /line 2: “air heart” already becomes “Earheart”/);
  assert.throws(() => parseAliases("Earheart"), /line 1: write it as/);
  assert.throws(() => parseAliases("a -> b -> c"), /line 1: write it as/);
  assert.throws(() => parseAliases(" , -> Earheart"), /line 1: add the words you heard/);
  assert.throws(() => parseAliases("air heart -> "), /line 1: Enter a spelling/);
});

test("mergeAliases keeps another window's additions and the form's own edits", () => {
  const baseline = [{ term: "Earheart", heard: ["air heart", "old"] }];
  // The correction window added "cube cuddle -> kubectl" meanwhile.
  const live = [...baseline, { term: "kubectl", heard: ["cube cuddle"] }];
  // The form removed "old" and added "ear heart".
  const edited = [{ term: "Earheart", heard: ["air heart", "ear heart"] }];
  assert.deepEqual(mergeAliases(baseline, edited, live), [
    { term: "Earheart", heard: ["air heart", "ear heart"] },
    { term: "kubectl", heard: ["cube cuddle"] },
  ]);
  // The form moving a heard form to another term is an explicit choice: it wins.
  const moved = [{ term: "Earhart", heard: ["air heart"] }, { term: "Earheart", heard: ["old"] }];
  const merged = mergeAliases(baseline, moved, baseline);
  assert.deepEqual(merged.find((r) => r.term === "Earhart").heard, ["air heart"]);
  assert.ok(!merged.find((r) => r.term === "Earheart").heard.includes("air heart"));
  // An unchanged form leaves live alone.
  assert.deepEqual(mergeAliases(baseline, baseline, live), live);
});

test("aliasTerms lists each canonical term once", () => {
  assert.deepEqual(aliasTerms([...EARHEART, { term: "Earheart", heard: ["earhart"] }, { term: "K8s", heard: ["kates"] }]), ["Earheart", "K8s"]);
});

test("mergeAliases refuses a conflicting or overflowing merge instead of dropping a saved alias", () => {
  // Settings (stale) adds air heart -> Earheart while Correct… saved Earheart -> Other.
  assert.throws(
    () => mergeAliases([], [{ term: "Earheart", heard: ["air heart"] }], [{ term: "Other", heard: ["Earheart"] }]),
    /Always replace was not saved: .*Earheart/
  );
  const full = [{ term: "T", heard: Array.from({ length: ALIAS_HEARD_MAX }, (_, i) => `h${i}`) }];
  assert.throws(() => mergeAliases([], [{ term: "T", heard: ["new heard"] }], full), /Always replace was not saved/);
});
