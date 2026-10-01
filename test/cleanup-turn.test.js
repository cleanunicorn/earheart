// Tests for the cleanup turn — the exact text and sampling options the
// built-in engine sends the model for one clean.
//
// The engine worker and the cleanup benchmark (scripts/bench-cleanup.mjs) both
// build their turn from this module, so a benchmark number describes what the
// app actually sends. The strings are pinned byte for byte: a stray newline or
// a renamed cue changes model behavior, and every recorded measurement with it.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_CLEANUP_TEMPERATURE,
  cleanupTurnPrefix,
  cleanupUserTurn,
  cleanupSamplingOptions,
  cleanupChatWrapperOptions,
  cleanupChatWrapper,
} = require("../main/util/cleanup-turn");

test("cleanupUserTurn labels the transcript as data and ends on the cue", () => {
  assert.strictEqual(
    cleanupUserTurn("RULES", "so um hello"),
    "RULES\n\nTranscript:\nso um hello\n\nCleaned transcript:"
  );
});

test("cleanupUserTurn keeps the prompt and transcript verbatim", () => {
  const prompt = "Line one.\n\nEditing style: keep it.";
  const transcript = "  spaced  \nand multi-line ";
  assert.strictEqual(
    cleanupUserTurn(prompt, transcript),
    `${prompt}\n\nTranscript:\n${transcript}\n\nCleaned transcript:`
  );
});

test("cleanupSamplingOptions forwards every active knob", () => {
  assert.deepStrictEqual(
    cleanupSamplingOptions({ temperature: 0.4, topP: 0.9, topK: 40, minP: 0.02 }),
    { temperature: 0.4, topP: 0.9, topK: 40, minP: 0.02 }
  );
});

test("cleanupSamplingOptions drops topK and minP at 0 (disabled)", () => {
  assert.deepStrictEqual(
    cleanupSamplingOptions({ temperature: 0.2, topP: 1, topK: 0, minP: 0 }),
    { temperature: 0.2, topP: 1 }
  );
});

test("cleanupSamplingOptions falls back to the engine's default temperature", () => {
  assert.strictEqual(DEFAULT_CLEANUP_TEMPERATURE, 0.2);
  assert.deepStrictEqual(cleanupSamplingOptions(undefined), { temperature: 0.2 });
  assert.deepStrictEqual(cleanupSamplingOptions({}), { temperature: 0.2 });
});

test("cleanupSamplingOptions keeps an explicit temperature of 0", () => {
  assert.deepStrictEqual(cleanupSamplingOptions({ temperature: 0 }), { temperature: 0 });
});

test("the prefill prefix is a strict string prefix of the full turn", () => {
  // primeCleanup evaluates the prefix ahead of time; clean() then reuses that
  // KV state only if its turn starts with exactly the same text.
  const prompt = "RULES\n\nEditing style: tidy.";
  const committed = "so um I wanted";
  const full = cleanupUserTurn(prompt, `${committed} to ask about the pipeline`);
  const prefix = cleanupTurnPrefix(prompt, committed);
  assert.ok(full.startsWith(prefix), `${JSON.stringify(prefix)} is not a prefix of the turn`);
  assert.ok(full.startsWith(cleanupTurnPrefix(prompt, "")));
  assert.strictEqual(cleanupTurnPrefix("RULES", "abc"), "RULES\n\nTranscript:\nabc");
});

test("cleanupChatWrapperOptions requests no reasoning through supported wrappers", () => {
  // Wrapper-specific supported controls retain automatic resolution.
  assert.deepStrictEqual(cleanupChatWrapperOptions(), {
    customWrapperSettings: { gemma4: { reasoning: false }, jinjaTemplate: { reasoning: false }, qwen: { thoughts: "discourage" }, seed: { thinkingBudget: 0 } },
  });
  // A fresh object each call, so a caller can't mutate the shared setting.
  assert.notStrictEqual(cleanupChatWrapperOptions(), cleanupChatWrapperOptions());
});

test("cleanupChatWrapper resolves the model's wrapper with the cleanup options", () => {
  const calls = [];
  const wrapper = { name: "Gemma4ChatWrapper" };
  const mod = {
    resolveChatWrapper(model, options) {
      calls.push({ model, options });
      return wrapper;
    },
  };
  const model = { id: "loaded model" };
  assert.strictEqual(cleanupChatWrapper(mod, model), wrapper);
  assert.deepStrictEqual(calls, [{ model, options: cleanupChatWrapperOptions() }]);
});

// Against the installed node-llama-cpp's own resolver: importing it loads JS
// only (no native backend, no model, no network). The app passes a LlamaModel,
// whose overload forwards customWrapperSettings to this options overload.
async function llamaCpp() {
  return import("node-llama-cpp");
}

// What the wrapper would send for one user turn, before the model replies.
function contextFor(wrapper) {
  const chatHistory = [{ type: "user", text: "Hello" }, { type: "model", response: [] }];
  return wrapper.generateContextState({ chatHistory }).contextText.toString();
}

test("the installed resolver builds Gemma 4's wrapper with reasoning off", async () => {
  const mod = await llamaCpp();
  const auto = mod.resolveChatWrapper({ architecture: "gemma4" });
  const cleanup = mod.resolveChatWrapper({ architecture: "gemma4", ...cleanupChatWrapperOptions() });
  assert.ok(cleanup instanceof mod.Gemma4ChatWrapper);
  // The default reasons, and asks the model to think via a <|think|> marker.
  assert.strictEqual(auto.reasoning, true);
  assert.ok(contextFor(auto).includes("<|think|>"));
  assert.strictEqual(cleanup.reasoning, false);
  assert.ok(!contextFor(cleanup).includes("<|think|>"), contextFor(cleanup));
});

test("the cleanup options leave every other chat wrapper exactly as auto resolves it", async () => {
  const mod = await llamaCpp();
  const others = mod.specializedChatWrapperTypeNames.filter((type) => !["gemma4", "qwen", "seed"].includes(type));
  assert.ok(others.length > 10, `only ${others.length} wrapper types`);
  for (const type of others) {
    const auto = mod.resolveChatWrapper({ type });
    const cleanup = mod.resolveChatWrapper({ type, ...cleanupChatWrapperOptions() });
    assert.strictEqual(cleanup.constructor, auto.constructor, type);
    assert.strictEqual(contextFor(cleanup), contextFor(auto), type);
  }
});

test("metadata-based Jinja cleanup disables its optional reasoning branch", async () => {
  const mod = await llamaCpp();
  const template = "{{ bos_token }}{% if enable_thinking %}REASONING_ON{% else %}REASONING_OFF{% endif %}{% for message in messages %}{{ message['role'] }}:{{ message['content'] }}\n{% endfor %}{% if add_generation_prompt %}assistant:{% if enable_thinking %}<think>{% else %}<think></think>{% endif %}{% endif %}";
  const fileInfo = { metadata: { tokenizer: { chat_template: template } } };
  const auto = mod.resolveChatWrapper({ architecture: "gemma4", fileInfo });
  const cleanup = mod.resolveChatWrapper({ architecture: "gemma4", fileInfo, ...cleanupChatWrapperOptions() });
  assert.ok(cleanup instanceof mod.JinjaTemplateChatWrapper);
  assert.ok(contextFor(auto).includes("REASONING_ON"));
  assert.strictEqual(cleanup.reasoning, false);
  assert.ok(contextFor(cleanup).includes("REASONING_OFF"), contextFor(cleanup));
});

test("Qwen and Seed cleanup request no reasoning using their supported controls", async () => {
  const mod = await llamaCpp();
  for (const variation of ["3", "3.5"]) {
    const options = cleanupChatWrapperOptions();
    options.customWrapperSettings.qwen.variation = variation;
    const wrapper = mod.resolveChatWrapper({ type: "qwen", ...options });
    assert.strictEqual(wrapper.thoughts, "discourage");
    assert.match(contextFor(wrapper), /<think>\s*<\/think>/);
  }
  const seed = mod.resolveChatWrapper({ type: "seed", ...cleanupChatWrapperOptions() });
  assert.strictEqual(seed.thinkingBudget, 0);
  assert.ok(contextFor(seed).includes("0"), contextFor(seed));
});
