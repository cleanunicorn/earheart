// Held-out vocabulary smoke evaluation, using the shipped cleanup prompt,
// wrapper, sampling and final postprocessing. No speech recognition is measured.
// node scripts/eval-vocabulary.mjs /path/to/model.gguf /tmp/vocabulary.json
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");
const { resolveCleanup } = require("../main/cleanup-styles");
const { cleanupUserTurn, cleanupSamplingOptions, cleanupChatWrapper } = require("../main/util/cleanup-turn");
const { cleanMaxTokens } = require("../main/util/clean-budget");
const { stripThinking } = require("../main/services/cleanup");
const { stripStumbles } = require("../main/util/stumble-strip");
const { PACK_IDS, packTerms } = require("../renderer/vocab-packs");

export const dictionary = ["kubectl", "pnpm", "useEffect", "getUserById", "Earheart", "Vitest"];
// The remembered words come from different utterances than these test prompts.
export const cases = [
  ["List the pods with cube cuddle before changing the deployment.", "kubectl"],
  ["Run cube cuddle against the staging namespace and show the events.", "kubectl"],
  ["Install the dependencies with pee en pee em and run the tests.", "pnpm"],
  ["Use pee en pee em to update only the lockfile.", "pnpm"],
  ["Move the subscription into use effect and return a cleanup function.", "useEffect"],
  ["The use effect dependency list is missing the project identifier.", "useEffect"],
  ["Call get user by id before rendering the profile.", "getUserById"],
  ["Add a test for get user by id when the user is missing.", "getUserById"],
  ["Add a keyboard shortcut to air heart for correcting the last prompt.", "Earheart"],
  ["Check that air heart keeps the original transcript.", "Earheart"],
  ["Use vee test to cover the cancellation path.", "Vitest"],
  ["Run the vee test suite after updating the parser.", "Vitest"],
  ["The cube has a blue face and rounded edges.", null],
  ["Explain the effect of this change on existing users.", null],
  ["Get the user by their email address before sending the reminder.", null],
  ["Test the new validation rule with an empty input.", null],
  ["Keep the heart icon aligned with the heading.", null],
  ["Install dependencies and rebuild the application.", null],
];
// Never-force-in controls for the starter packs (#72): each says an ordinary
// word that is also a pack term in another casing or sense. All packs enabled
// plus the dictionary must leave every one of these alone.
export const packControls = [
  ["Move the cursor to the end of the line before typing.", null],
  ["Open the window and let some fresh air in.", null],
  ["Write a lambda expression that sorts the list by length.", null],
  ["The claude of the old clock needs a new spring.", null],
  ["Keep the opus number in the file name of the score.", null],
  ["Put the ingress door on the left side of the building.", null],
];
// Every arm's dictionary: "packs" is the user's list plus every starter pack.
export function armTerms(arm) {
  if (arm === "packs") return [...new Set([...dictionary, ...packTerms(PACK_IDS)])];
  return arm === "remembered" ? dictionary : [];
}
function hasTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
}
function sha256(text) { return createHash("sha256").update(text).digest("hex"); }
export function summarize(rows, terms = dictionary) {
  const targets = rows.filter((row) => row.expected);
  const controls = rows.filter((row) => !row.expected);
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    exactTerms: targets.filter((row) => hasTerm(row.output, row.expected)).length,
    targetCases: targets.length,
    falseSubstitutions: controls.filter((row) => terms.some((term) => hasTerm(row.output, term))).length,
    controlCases: controls.length,
    medianMs: Math.round((times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2),
  };
}
async function main(modelPath, out) {
  if (!modelPath || !out) throw new Error("usage: node scripts/eval-vocabulary.mjs <model.gguf> <output.json>");
  const mod = await import("node-llama-cpp");
  const llama = await mod.getLlama({ gpu: false });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 4096 });
  const sequence = context.getSequence();
  const session = new mod.LlamaChatSession({ contextSequence: sequence, chatWrapper: cleanupChatWrapper(mod, model) });
  const rows = [];
  async function clean(input, words) {
    session.resetChatHistory();
    await sequence.clearHistory();
    const cfg = resolveCleanup({ ...DEFAULTS.cleanup, style: "clean", dictionary: words });
    const started = performance.now();
    const result = await session.promptWithMeta(cleanupUserTurn(cfg.systemPrompt, input), {
      ...cleanupSamplingOptions(cfg.sampling), seed: 17,
      maxTokens: cleanMaxTokens(model.tokenize(input).length, cfg.outputRatio),
    });
    if (result.stopReason === "maxTokens") throw new Error("Evaluation exhausted output budget");
    return { output: stripStumbles(stripThinking(result.responseText)), ms: performance.now() - started };
  }
  try {
    await clean("Check the parser and run the tests.", []);
    // Alternate order to avoid consistently charging one arm for machine drift.
    const everything = [...cases.map((c) => [...c, "core"]), ...packControls.map((c) => [...c, "pack"])];
    const orders = [["baseline", "remembered", "packs"], ["remembered", "packs", "baseline"], ["packs", "baseline", "remembered"]];
    for (const [index, [input, expected, set]] of everything.entries()) {
      for (const arm of orders[index % 3]) {
        const result = await clean(input, armTerms(arm));
        rows.push({ index, input, expected, set, arm, ...result });
        console.error(`${rows.length}/${everything.length * 3} ${arm}: ${result.output}`);
      }
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(modelPath)) hash.update(chunk);
    const report = {
      modelSha256: hash.digest("hex"), cpu: os.cpus()[0].model, backend: "cpu", seed: 17,
      style: "clean", dictionary,
      // What a rerun must match to be comparable: the exact prompt each arm sent.
      promptSha256: Object.fromEntries(["baseline", "remembered", "packs"].map((arm) => [arm,
        sha256(resolveCleanup({ ...DEFAULTS.cleanup, style: "clean", dictionary: armTerms(arm) }).systemPrompt)])),
      packsTermCount: armTerms("packs").length,
      // baseline and remembered cover the original 18 prompts, as before.
      baseline: summarize(rows.filter((row) => row.arm === "baseline" && row.set === "core"), armTerms("remembered")),
      remembered: summarize(rows.filter((row) => row.arm === "remembered" && row.set === "core")),
      // The large-dictionary arm over the 18 prompts and the pack controls.
      packs: summarize(rows.filter((row) => row.arm === "packs"), armTerms("packs")),
      packsOnCore: summarize(rows.filter((row) => row.arm === "packs" && row.set === "core"), armTerms("packs")),
      rows,
    };
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ baseline: report.baseline, remembered: report.remembered, packs: report.packs }));
    if (report.packs.falseSubstitutions > 0) { console.error("Large dictionary forced a term in: lower the caps or tighten the directive."); process.exitCode = 2; }
  } finally { session.dispose(); await context.dispose(); await model.dispose(); await llama.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3]).catch((err) => { console.error(err); process.exitCode = 1; });
}
