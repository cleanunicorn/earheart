// Execute the actual worker dispatch and lifecycle with deferred native calls.
// Only its ESM import is substituted; no models, Electron, or native backend.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { CLEAN_RUNAWAY_MESSAGE } = require("../main/util/clean-budget");
const { createRequire } = require("node:module");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));

// Options beyond the gates: `env` replaces the worker's process.env (CPU-only
// by default, so the GPU attempt is skipped), `gpuFails` makes a model load on
// a GPU-mode runtime throw, and `stopReason` is what generation reports.
function worker({
  loadGate, promptGate, promptStarted, preloadGate, preloadStarted,
  env = { EARHEART_LLAMA_GPU: "off" }, gpuFails = false, stopReason = "eogToken",
  contextFailsAbove = Infinity, trainContextSize,
} = {}) {
  const events = [];
  // Kept apart from `events`, whose exact sequence the older tests pin.
  const contextEvents = [];
  const getLlamaCalls = [];
  const runtime = {
    async getLlama(options) {
      // Normalized: the worker builds this object in its own vm realm.
      getLlamaCalls.push(JSON.parse(JSON.stringify(options)));
      const gpu = options?.gpu !== false;
      return {
        async loadModel({ modelPath }) {
          events.push(`load:${modelPath}`);
          if (loadGate) await loadGate.promise;
          if (modelPath === "bad") throw new Error("bad model");
          if (gpu && gpuFails) throw new Error("out of VRAM");
          return {
            tokenize: (text) => text.split(/\s+/),
            trainContextSize,
            async createContext({ contextSize }) {
              contextEvents.push(`context:${modelPath}:${contextSize}`);
              if (contextSize > contextFailsAbove) throw new Error("out of memory");
              return {
                contextSize,
                getSequence: () => ({ modelPath }),
                dispose: async () => events.push(`dispose-context:${modelPath}`),
              };
            },
            dispose: async () => events.push(`dispose-model:${modelPath}`),
          };
        },
      };
    },
    resolveChatWrapper: () => ({}),
    LlamaChatSession: class {
      constructor({ contextSequence }) { this.modelPath = contextSequence.modelPath; }
      resetChatHistory() {}
      dispose() { events.push(`dispose-session:${this.modelPath}`); }
      async promptWithMeta(text, { signal }) {
        events.push(`prompt:${this.modelPath}`);
        promptStarted?.resolve();
        if (promptGate) await promptGate.promise;
        if (signal.aborted) throw new Error("cleanup cancelled");
        return { responseText: this.modelPath, stopReason };
      }
      async preloadPrompt(text, { signal }) {
        assert.equal(signal.aborted, false);
        events.push(`prime:${this.modelPath}`);
        preloadStarted?.resolve();
        if (preloadGate) await preloadGate.promise;
        if (signal.aborted) throw new Error("cleanup cancelled");
        events.push(`primed:${this.modelPath}`);
      }
    },
  };
  let onMessage;
  let nextId = 0;
  const pending = new Map();
  const workerPath = require.resolve("../main/engines/engine-worker");
  const source = fs.readFileSync(workerPath, "utf8");
  // The CommonJS worker's sole ESM dependency is an import expression. Replace
  // that expression in the test copy, retaining every real handler and queue.
  const injected = source.replaceAll('import("node-llama-cpp")', "loadRuntime()");
  assert.notEqual(injected, source);
  vm.runInNewContext(injected, {
    require: createRequire(workerPath),
    process: {
      env,
      platform: process.platform,
      arch: process.arch,
      parentPort: {
        on: (event, fn) => { if (event === "message") onMessage = fn; },
        postMessage(msg) {
          if (typeof msg.progress !== "number") {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        },
      },
    },
    console,
    AbortController,
    Buffer,
    loadRuntime: async () => runtime,
  }, { filename: workerPath });
  function send(type, args = {}) {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      onMessage({ data: { id, type, ...args } });
    });
  }
  return { send, events, contextEvents, getLlamaCalls };
}
const model = (modelPath) => ({ modelPath, contextSize: 4096, cpuOnly: true });
const turn = (modelPath) => ({ model: model(modelPath), transcript: "hello", systemPrompt: "rules" });

test("cleanup worker: model switches wait for active inference and each turn owns its model", async () => {
  const promptGate = deferred();
  const promptStarted = deferred();
  const w = worker({ promptGate, promptStarted });
  await w.send("load-cleanup", model("A"));
  const first = w.send("clean", turn("A"));
  await promptStarted.promise;
  const loadB = w.send("load-cleanup", model("B"));
  const selectedA = w.send("clean", turn("A"));
  const second = w.send("clean", turn("B"));
  await drain();
  assert.equal(w.events.some((event) => event.startsWith("dispose-")), false, w.events.join(","));
  promptGate.resolve();
  assert.equal((await first).result, "A");
  assert.equal((await loadB).ok, true);
  assert.equal((await selectedA).result, "A");
  assert.equal((await second).result, "B");
});

test("cleanup worker: cold overlapping prime/clean loads once and recovers after failed selection", async () => {
  const w = worker();
  const prime = w.send("prime-cleanup", { model: model("A"), text: "rules" });
  const clean = w.send("clean", turn("A"));
  assert.equal((await prime).ok, true);
  assert.equal((await clean).result, "A");
  assert.equal(w.events.filter((event) => event === "load:A").length, 1);
  assert.equal((await w.send("clean", turn("bad"))).ok, false);
  assert.equal((await w.send("clean", turn("B"))).result, "B");
});

test("cleanup worker: cancellation during cold load skips previews and permits final cleanup", async () => {
  const loadGate = deferred();
  const w = worker({ loadGate });
  const preview = w.send("clean", turn("A"));
  const prime = w.send("prime-cleanup", { model: model("A"), text: "rules" });
  await drain();
  const cancelled = await w.send("cancel-clean");
  assert.equal(cancelled.result.cancelled, 2);
  const final = w.send("clean", turn("B"));
  loadGate.resolve();
  assert.equal((await preview).ok, false);
  assert.equal((await prime).ok, false);
  assert.equal((await final).result, "B");
  assert.deepEqual(w.events.filter((event) => event.startsWith("prompt:")), ["prompt:B"]);
});


test("cleanup worker: a targeted abort during load leaves another caller's turn runnable", async () => {
  const loadGate = deferred();
  const w = worker({ loadGate });
  const first = w.send("clean", { ...turn("A"), operationId: 7 });
  const second = w.send("clean", { ...turn("B"), operationId: 8 });
  await drain();
  assert.equal((await w.send("cancel-clean", { operationId: 7 })).result.cancelled, 1);
  loadGate.resolve();
  assert.equal((await first).ok, false);
  assert.equal((await second).result, "B");
  assert.deepEqual(w.events.filter((event) => event.startsWith("prompt:")), ["prompt:B"]);
});

test("cleanup worker: targeted cancellation reaches active generation and releases the queue", async () => {
  const promptGate = deferred();
  const promptStarted = deferred();
  const w = worker({ promptGate, promptStarted });
  const active = w.send("clean", { ...turn("A"), operationId: 7 });
  await promptStarted.promise;
  const next = w.send("clean", { ...turn("B"), operationId: 8 });
  assert.equal((await w.send("cancel-clean", { operationId: 7 })).result.cancelled, 1);
  promptGate.resolve();
  const cancelled = await active;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cleanup cancelled/);
  assert.equal((await next).result, "B");
  assert.deepEqual(w.events.filter((event) => event.startsWith("prompt:")), ["prompt:A", "prompt:B"]);
});

test("cleanup worker: model switches wait for active prefill to finish", async () => {
  const preloadGate = deferred();
  const preloadStarted = deferred();
  const w = worker({ preloadGate, preloadStarted });
  const prime = w.send("prime-cleanup", { model: model("A"), text: "rules" });
  await preloadStarted.promise;
  const loadB = w.send("load-cleanup", model("B"));
  const cleanB = w.send("clean", turn("B"));
  await drain();
  assert.deepEqual(w.events, ["load:A", "prime:A"]);
  preloadGate.resolve();
  assert.equal((await prime).ok, true);
  assert.equal((await loadB).ok, true);
  assert.equal((await cleanB).result, "B");
  assert.ok(w.events.indexOf("primed:A") < w.events.indexOf("dispose-context:A"));
  assert.ok(w.events.indexOf("dispose-context:A") < w.events.indexOf("load:B"));
});

test("cleanup worker: cancellation reaches active prefill and permits final cleanup", async () => {
  const preloadGate = deferred();
  const preloadStarted = deferred();
  const w = worker({ preloadGate, preloadStarted });
  const prime = w.send("prime-cleanup", { model: model("A"), text: "rules" });
  await preloadStarted.promise;
  assert.equal((await w.send("cancel-clean")).result.cancelled, 1);
  const final = w.send("clean", turn("B"));
  await drain();
  assert.deepEqual(w.events, ["load:A", "prime:A"]);
  preloadGate.resolve();
  const cancelled = await prime;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cleanup cancelled/);
  assert.equal((await final).result, "B");
  assert.equal(w.events.includes("primed:A"), false);
  assert.deepEqual(w.events.filter((event) => event.startsWith("prompt:")), ["prompt:B"]);
});

test("cleanup worker: overlapping cold load-cleanup requests load the model once", async () => {
  // Both requests check for a resident model before the first load finishes.
  // Unserialized, both passed and the second overwrote the first model and
  // context without disposing them; the shared queue makes the second wait
  // and find the first one resident.
  const loadGate = deferred();
  const w = worker({ loadGate });
  const first = w.send("load-cleanup", model("A"));
  const second = w.send("load-cleanup", model("A"));
  await drain();
  loadGate.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(w.events, ["load:A"]);
});

test("cleanup worker: a generation that hits its token cap is refused, not returned", async () => {
  const w = worker({ stopReason: "maxTokens" });
  const reply = await w.send("clean", turn("A"));
  assert.equal(reply.ok, false);
  assert.equal(reply.error, CLEAN_RUNAWAY_MESSAGE);
});

test("cleanup worker: a turn that can't fit the context is refused before generating", async () => {
  const w = worker();
  const tiny = { modelPath: "A", contextSize: 10, cpuOnly: true };
  const reply = await w.send("clean", { model: tiny, transcript: "hello there", systemPrompt: "rules" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /too long/);
  assert.equal(w.events.some((event) => event.startsWith("prompt:")), false, "nothing was generated");
});

test("cleanup worker: a GPU load failure retries once on a CPU-only runtime", async () => {
  const w = worker({ env: {}, gpuFails: true });
  const reply = await w.send("load-cleanup", { modelPath: "A", contextSize: 4096, cpuOnly: false });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(w.getLlamaCalls, [{}, { gpu: false }]);
  assert.deepEqual(w.events, ["load:A", "load:A"]);
  // The CPU runtime is kept: the next clean doesn't probe the GPU again.
  assert.equal((await w.send("clean", turn("A"))).result, "A");
  assert.equal(w.getLlamaCalls.length, 2);
});

// #297: the context is sized from the real instructions, not a fixed
// allowance. The fake tokenizer counts whitespace-separated words, so a prompt
// of N words is N tokens (plus the turn's own "Transcript:" label).
const words = (count, word = "term") => Array.from({ length: count }, (_, i) => `${word}${i}`).join("\n");
const budgeted = (modelPath) => ({ modelPath, contextSize: 4096, transcriptTokens: 203, cpuOnly: true });

test("cleanup worker: a token-dense dictionary grows the context instead of refusing a short turn", async () => {
  const w = worker();
  // ~6,900 instruction tokens: the issue's 256-term dictionary on Qwen3 4B.
  const reply = await w.send("clean", { model: budgeted("A"), transcript: "Run the test suite.", systemPrompt: words(6900) });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192"]);
  assert.deepEqual(w.events.filter((event) => event.startsWith("load:")), ["load:A"], "the model is not reloaded");
});

test("cleanup worker: a long custom prompt past the memory ceiling is refused and names the instructions", async () => {
  const w = worker();
  const reply = await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: words(20000, "rule") });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /instructions and dictionary/);
  assert.match(reply.error, /Remove dictionary words or shorten the custom prompt/);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:16384"], "never past the ceiling");
  assert.equal(w.events.some((event) => event.startsWith("prompt:")), false, "nothing was generated");
});

test("cleanup worker: the context follows dictionary changes after the model is loaded", async () => {
  const w = worker();
  const send = (systemPrompt) => w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt });
  assert.equal((await send("rules")).ok, true);
  assert.equal((await send(words(6900))).ok, true);
  assert.equal((await send(words(6900))).ok, true);
  assert.equal((await send("rules")).ok, true);
  // Grown once, kept while it still fits, back to main's size once it shrinks.
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192", "context:A:4096"]);
  assert.deepEqual(w.events.filter((event) => event.startsWith("load:")), ["load:A"]);
});

test("cleanup worker: a context that can't grow refuses only a turn that doesn't fit, and isn't retried", async () => {
  const w = worker({ contextFailsAbove: 4096 });
  const big = await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: words(6900) });
  assert.equal(big.ok, false);
  assert.match(big.error, /instructions and dictionary/);
  assert.equal(w.events.some((event) => event.startsWith("prompt:")), false, "nothing was generated");
  // The failed size isn't asked for again on the next dictation.
  assert.equal((await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: words(6900) })).ok, false);
  // Main's size is restored, so the next ordinary turn runs without a reload.
  const small = await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: "rules" });
  assert.equal(small.ok, true, small.error);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192", "context:A:4096"]);
  assert.deepEqual(w.events.filter((event) => event.startsWith("load:")), ["load:A"]);
});

test("cleanup worker: a failed grow still cleans a turn that fits main's size", async () => {
  // The grow covers the longest dictation allowed; this one is short. Before
  // #297 it cleaned in main's 8192, and a busy GPU must not change that.
  const w = worker({ contextFailsAbove: 8192 });
  const model = { modelPath: "A", contextSize: 8192, transcriptTokens: 2025, cpuOnly: true };
  const reply = await w.send("clean", { model, transcript: "hello", systemPrompt: words(5000) });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(w.contextEvents, ["context:A:8192", "context:A:16384", "context:A:8192"]);
});

test("cleanup worker: a new floor for the same model rebuilds the context, not the model", async () => {
  const w = worker();
  assert.equal((await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: "rules" })).ok, true);
  const raised = { ...budgeted("A"), contextSize: 8192, transcriptTokens: 2025 };
  assert.equal((await w.send("clean", { model: raised, transcript: "hello", systemPrompt: "rules" })).ok, true);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192"]);
  assert.deepEqual(w.events.filter((event) => event.startsWith("load:")), ["load:A"]);
});

test("cleanup worker: a prime sizes the context as the clean will, so the clean doesn't rebuild it", async () => {
  const w = worker();
  const systemPrompt = words(6900);
  const primed = await w.send("prime-cleanup", { model: budgeted("A"), systemPrompt, text: `${systemPrompt}\n\nTranscript:\n` });
  assert.equal(primed.ok, true, primed.error);
  // Already grown by the prime itself...
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192"]);
  const afterPrime = w.events.length;
  assert.equal((await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt })).ok, true);
  // ...so the clean neither rebuilds nor drops the primed session.
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192"]);
  assert.deepEqual(w.events.slice(afterPrime).filter((event) => event.startsWith("dispose-")), []);
});

test("cleanup worker: after the ceiling fails, the next turn settles one step down and stays there", async () => {
  const w = worker({ contextFailsAbove: 8192 });
  // A 600 s budget sizes 6,000 instruction tokens at 16384; "hello" fits 8192.
  const model = { ...budgeted("A"), transcriptTokens: 2025 };
  const send = () => w.send("clean", { model, transcript: "hello", systemPrompt: words(6000) });
  assert.equal((await send()).ok, false, "16384 failed and 6,000 instruction tokens don't fit 4096");
  assert.equal((await send()).ok, true, "8192 is tried next and fits");
  assert.equal((await send()).ok, true);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:16384", "context:A:4096", "context:A:8192"]);
});

test("cleanup worker: the context never grows past the model's training context", async () => {
  const w = worker({ trainContextSize: 8192 });
  const reply = await w.send("clean", { model: budgeted("A"), transcript: "hello", systemPrompt: words(9000) });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /instructions and dictionary/);
  assert.deepEqual(w.contextEvents, ["context:A:4096", "context:A:8192"]);
});
