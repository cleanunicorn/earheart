// Execute the actual worker dispatch and lifecycle with deferred native calls.
// Only its ESM import is substituted; no models, Electron, or native backend.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const drain = () => new Promise((resolve) => setImmediate(resolve));

function worker({ loadGate, promptGate, promptStarted } = {}) {
  const events = [];
  const runtime = {
    async getLlama() {
      return {
        async loadModel({ modelPath }) {
          events.push(`load:${modelPath}`);
          if (loadGate) await loadGate.promise;
          if (modelPath === "bad") throw new Error("bad model");
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
        return { responseText: this.modelPath, stopReason: "eogToken" };
      }
      async preloadPrompt(text, { signal }) {
        assert.equal(signal.aborted, false);
        events.push(`prime:${this.modelPath}`);
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
      env: { EARHEART_LLAMA_GPU: "off" },
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
  return { send, events };
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
