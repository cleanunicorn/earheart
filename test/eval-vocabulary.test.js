const { test } = require("node:test");
const assert = require("node:assert/strict");
test("vocabulary evaluation requires exact casing and counts control substitutions", async () => {
  const { summarize } = await import("../scripts/eval-vocabulary.mjs");
  assert.deepEqual(summarize([
    { expected: "getUserById", output: "getuserbyid", ms: 10 },
    { expected: "kubectl", output: "Run kubectl.", ms: 30 },
    { expected: null, output: "Use kubectl.", ms: 40 },
    { expected: null, output: "Check the cube.", ms: 20 },
  ]), { exactTerms: 1, targetCases: 2, falseSubstitutions: 1, controlCases: 2, medianMs: 25 });
});

test("the large-dictionary arm checks controls against the user's list and every starter pack", async () => {
  const { summarize, armTerms, dictionary, packControls } = await import("../scripts/eval-vocabulary.mjs");
  assert.deepEqual(armTerms("baseline"), []);
  assert.deepEqual(armTerms("remembered"), dictionary);
  const packs = armTerms("packs");
  assert.ok(packs.length > dictionary.length && dictionary.every((t) => packs.includes(t)));
  assert.ok(packs.includes("Terraform"));
  assert.ok(packControls.length >= 5 && packControls.every(([, expected]) => expected === null));
  const rows = [{ expected: null, output: "Run Terraform now.", ms: 1 }, { expected: null, output: "Fine.", ms: 1 }];
  assert.equal(summarize(rows).falseSubstitutions, 0); // not in the six-word list
  assert.equal(summarize(rows, packs).falseSubstitutions, 1);
});
