// Pins the model-free parts of scripts/try-cleanup-prompts.mjs: strategy F is
// built from the production prompt modules (not a hand-copied prompt that can
// drift — it had, see #181), and the argument handling fails loudly with no
// per-OS default model path. The runs themselves need a gguf and stay out of
// the suite; the module loads node-llama-cpp only when run as a command.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const { cleanupUserTurn } = require("../main/util/cleanup-turn");

const SCRIPT = path.join(__dirname, "..", "scripts", "try-cleanup-prompts.mjs");
const load = () => import("../scripts/try-cleanup-prompts.mjs");

test("strategy F is exactly the production turn on a fresh profile", async () => {
  const { STRATEGIES } = await load();
  const transcript = "um so the the deploy script fails you know";
  const production = cleanupUserTurn(resolveCleanup(DEFAULTS.cleanup).systemPrompt, transcript);
  assert.strictEqual(STRATEGIES.F.wrap(transcript), production);
  // Production sends no chat system prompt (the rules ride in the user turn).
  assert.strictEqual(STRATEGIES.F.sys, undefined);
  // The composition is the resolved prompt, not the base alone.
  assert.ok(STRATEGIES.F.wrap(transcript).includes("\n\nEditing style: "));
});

test("the script carries no copy of the production prompt and no per-OS model path", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const opening = DEFAULTS.cleanup.systemPrompt.split("\n")[0];
  assert.strictEqual(source.includes(opening), false, "production prompt opening line found inlined");
  assert.strictEqual(source.includes("Library/Application Support"), false);
  assert.strictEqual(source.includes("homedir()"), false);
  // The production modules are imported, so a prompt change reaches F.
  for (const mod of ["../main/settings", "../main/cleanup-styles", "../main/util/cleanup-turn"]) {
    assert.ok(source.includes(`require("${mod}")`), `missing import of ${mod}`);
  }
});

test("parseArgs: positional protocol kept, --model required, failures are usage errors", async () => {
  const { INPUTS, parseArgs, UsageError } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "try-cleanup-prompts-test-"));
  try {
    const model = path.join(dir, "m.gguf");
    fs.writeFileSync(model, "");
    assert.deepStrictEqual(parseArgs(["B", "0", `--model=${model}`]), { name: "B", idx: 0, modelPath: model });
    // Defaults as before: strategy C, every input.
    assert.deepStrictEqual(parseArgs([`--model=${model}`]), { name: "C", idx: -1, modelPath: model });
    // Flag position does not matter.
    assert.strictEqual(parseArgs([`--model=${model}`, "F"]).name, "F");
    // The index is validated before any model loads: last valid, then past the end, non-numeric, negative, fractional.
    assert.strictEqual(parseArgs(["B", String(INPUTS.length - 1), `--model=${model}`]).idx, INPUTS.length - 1);
    for (const bad of [String(INPUTS.length), "abc", "-1", "2.5", "1abc"]) {
      assert.throws(() => parseArgs(["B", bad, `--model=${model}`]), UsageError, `index ${bad}`);
    }
    assert.throws(() => parseArgs(["B"]), UsageError, "missing --model");
    assert.throws(() => parseArgs(["B", "--model"]), UsageError, "bare --model");
    assert.throws(() => parseArgs(["Z", `--model=${model}`]), UsageError, "unknown strategy");
    assert.throws(() => parseArgs(["B", `--model=${path.join(dir, "missing.gguf")}`]), UsageError, "missing file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
