const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  VOCAB_PACKS, PACK_IDS, PACK_TERMS_MAX, PROMPT_TERMS_MAX, packTerms, mergePromptTerms, normalizePackIds,
} = require("../renderer/vocab-packs");
const { resolveCleanup } = require("../main/cleanup-styles");
const { DEFAULTS } = require("../main/settings");

test("every pack is within its cap, with unique single-line terms", () => {
  assert.deepEqual(PACK_IDS, ["coding-agents", "js-web", "cloud-k8s", "python-data"]);
  for (const pack of VOCAB_PACKS) {
    assert.ok(pack.terms.length <= PACK_TERMS_MAX, `${pack.id} has ${pack.terms.length} terms`);
    assert.equal(new Set(pack.terms).size, pack.terms.length, `${pack.id} repeats a term`);
    for (const term of pack.terms) assert.match(term, /^[^\r\n]{1,120}$/);
  }
  // All four packs together stay well inside the prompt cap.
  assert.ok(packTerms(PACK_IDS).length <= 4 * PACK_TERMS_MAX);
});

test("packs are off by default and unknown ids are ignored, not errors", () => {
  assert.deepEqual(DEFAULTS.cleanup.vocabPacks, []);
  assert.deepEqual(packTerms(undefined), []);
  assert.deepEqual(packTerms(["gone", 7, null]), []);
  assert.deepEqual(normalizePackIds(["js-web", "gone", "js-web", 3]), ["js-web"]);
  assert.doesNotThrow(() => resolveCleanup({ systemPrompt: "B.", style: "custom", custom: {}, vocabPacks: ["gone"] }));
});

test("enabled pack terms follow the user's, once each, and a pack never alters the dictionary", () => {
  const dictionary = ["Earheart", "kubectl"];
  const cfg = { systemPrompt: "B.", style: "custom", custom: {}, dictionary, vocabPacks: ["cloud-k8s"] };
  const lines = resolveCleanup(cfg).systemPrompt.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines.slice(0, 2), ["- Earheart", "- kubectl"]);
  assert.equal(lines.filter((l) => l === "- kubectl").length, 1);
  assert.ok(lines.includes("- Terraform"));
  assert.deepEqual(dictionary, ["Earheart", "kubectl"]);
  // Switching the pack off removes exactly its terms.
  const off = resolveCleanup({ ...cfg, vocabPacks: [] }).systemPrompt;
  assert.doesNotMatch(off, /- Terraform/);
  assert.match(off, /- kubectl/);
});

test("pack terms stop at the prompt cap but the user's own terms are never dropped", () => {
  const some = Array.from({ length: PROMPT_TERMS_MAX - 5 }, (_, i) => `term${i}`);
  assert.equal(mergePromptTerms(some, PACK_IDS).length, PROMPT_TERMS_MAX);
  const over = Array.from({ length: PROMPT_TERMS_MAX + 20 }, (_, i) => `term${i}`);
  assert.deepEqual(mergePromptTerms(over, PACK_IDS), over);
});

test("the never-force-in guard still ships with the biggest prompt", () => {
  const prompt = resolveCleanup({ systemPrompt: "B.", style: "clean", dictionary: [], vocabPacks: PACK_IDS }).systemPrompt;
  assert.match(prompt, /Never force a term in where the speaker clearly said something else\./);
});
