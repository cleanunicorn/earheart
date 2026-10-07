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
} = {}) {
  const events = [];
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
            async createContext({ contextSize }) {
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
  return { send, events, getLlamaCalls };
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
