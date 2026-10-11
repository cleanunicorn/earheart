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
