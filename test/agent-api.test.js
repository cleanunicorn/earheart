const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentApi, DISABLED } = require("../main/agent-api");
const { validateProject } = require("../main/agents/common");

function setup(t, agents = { enabled: true }) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-api-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const calls = { stores: 0, detect: 0, copied: [] };
  const tasks = [];
  const store = {
    list: () => tasks,
    submit: (req) => { tasks.push({ id: "t1", project: req.project, resumeCommand: "agent resume x" }); return { ok: true, task: tasks[0], req }; },
    get: (id) => tasks.find((task) => task.id === id) || null,
    cancel: (id) => ({ ok: true, id }),
    reply: (id, text) => ({ ok: true, id, text }),
    remove: () => ({ ok: true }),
    clear: () => ({ ok: true }),
    removeForHistory() {},
    shutdown() {},
  };
  const api = createAgentApi({
    getSettings: () => ({ agents }),
    createStore: () => { calls.stores++; return store; },
    detectAll: async () => { calls.detect++; return [{ id: "codex", available: true, models: [] }]; },
    pickFolder: async () => project,
    copyText: (text) => calls.copied.push(text),
    validateProject,
  });
  return { api, calls, project };
}

test("with the setting off every handler is inert: no store, no detection, no process", async (t) => {
  const { api, calls, project } = setup(t, { enabled: false });
  for (const result of [
    await api.state(), await api.send({}, { key: "k".repeat(10), project }),
    await api.reply({}, { id: "t1", text: "x" }), await api.copyResume({}, "t1"), await api.pickProject(),
  ]) assert.deepStrictEqual(result, DISABLED);
  assert.strictEqual(calls.stores, 0);
  assert.strictEqual(calls.detect, 0);
  assert.strictEqual(api.started(), false);
});

test("clearing History and deleting an entry reach saved tasks even when the feature is off", (t) => {
  const { api, calls } = setup(t, { enabled: false });
  const seen = [];
  const stub = createAgentApi({
    getSettings: () => ({ agents: { enabled: false } }),
    createStore: () => ({ clear: () => { seen.push("clear"); return { ok: true }; }, removeForHistory: (id) => seen.push(id) }),
    detectAll: async () => [], pickFolder: async () => null, copyText() {}, validateProject,
  });
  assert.deepStrictEqual(stub.clearTasks(), { ok: true });
  stub.removeForHistory("h1");
  assert.deepStrictEqual(seen, ["clear", "h1"]);
  assert.strictEqual(calls.detect, 0);
  assert.ok(api);
});

test("a running task can still be cancelled or removed after the setting is turned off", async (t) => {
  const { api } = setup(t, { enabled: false });
  assert.deepStrictEqual(await api.cancel({}, "t1"), { ok: true, id: "t1" });
  assert.deepStrictEqual(await api.remove({}, "t1"), { ok: true });
});

test("a non-string binary path in settings is ignored, not thrown", async (t) => {
  const seen = [];
  const api = createAgentApi({
    getSettings: () => ({ agents: { enabled: true, binaries: { codex: 5, claude: "/x/claude" } } }),
    createStore: ({ getConfig }) => { seen.push(getConfig().binaries); return { list: () => [] }; },
    detectAll: async (b) => { seen.push(b); return []; }, pickFolder: async () => null, copyText() {}, validateProject,
  });
  await api.state();
  assert.deepStrictEqual(seen, [{ claude: "/x/claude" }, { claude: "/x/claude" }]);
});

test("state lazily detects once (cached) and reports tasks and the permission", async (t) => {
  const { api, calls } = setup(t, { enabled: true, permission: "read" });
  assert.strictEqual(api.started(), false);
  const first = await api.state();
  await api.state();
  assert.strictEqual(first.permission, "read");
  assert.strictEqual(calls.detect, 1);
  assert.strictEqual(calls.stores, 1);
});

test("an unknown permission falls back to the sandboxed default; no full-access value exists", async (t) => {
  const { api } = setup(t, { enabled: true, permission: "danger-full-access" });
  assert.strictEqual((await api.state()).permission, "edit");
});

test("send forwards only the allowed fields, never argv or a binary", async (t) => {
  const { api, project } = setup(t);
  const out = await api.send({}, { key: "abcdefgh12", agent: "codex", project, brief: "hi", model: "", historyId: "h", args: ["--bad"], bin: "/bin/sh", argv: ["x"] });
  assert.deepStrictEqual(Object.keys(out.req).sort(), ["agent", "brief", "historyId", "key", "model", "project"]);
  assert.strictEqual((await api.send({}, null)).ok, false);
});

test("copyResume copies a command with the project quoted and never runs it", async (t) => {
  const { api, calls, project } = setup(t);
  await api.send({}, { key: "abcdefgh12", agent: "codex", project, brief: "hi" });
  assert.deepStrictEqual(await api.copyResume({}, "t1"), { ok: true });
  assert.match(calls.copied[0], /^cd .+ && agent resume x$/);
  assert.strictEqual((await api.copyResume({}, "missing")).ok, false);
});

test("pickProject validates the picked folder in main", async (t) => {
  const { api, project } = setup(t);
  const picked = await api.pickProject();
  assert.strictEqual(picked.path, fs.realpathSync(project));
});

test("main wires agent:* only for the Settings window and clears tasks with History", () => {
  const ipc = fs.readFileSync(path.join(__dirname, "..", "main", "ipc.js"), "utf8");
  const channels = [...ipc.matchAll(/ipcMain\.handle\("(agent:[a-z-]+)", fromSettings\(/g)].map((m) => m[1]);
  assert.deepStrictEqual(channels.sort(), ["agent:cancel", "agent:copy-resume", "agent:pick-project", "agent:remove", "agent:reply", "agent:send", "agent:state"]);
  assert.ok(!/ipcMain\.handle\("agent:[a-z-]+",\s*agentApi/.test(ipc), "no agent handler skips the sender check");
  assert.match(ipc, /isSettingsContents\(event\.sender\)/);
  assert.match(ipc, /agentApi\.clearTasks\(\)/);
  assert.match(ipc, /agentApi\.removeForHistory\(id\)/);
});

test("startup creates nothing for agents: the store is built lazily and detection never runs at launch", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main", "main.js"), "utf8");
  assert.ok(!/agents\.detectAll\(/.test(main.replace(/detectAll: \(binaries\) => agents\.detectAll\(binaries\)/, "")));
  assert.ok(!/createTaskStore\(/.test(main.split("function main()")[1]), "no task store is built inside main()");
});

test("the Settings agent UI builds every node with textContent", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "renderer", "settings.js"), "utf8");
  const start = js.indexOf("/* ---------- agents (#345) ---------- */");
  const section = js.slice(start, js.indexOf("/* ---------- ", start + 1));
  assert.ok(section.length > 500);
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) assert.ok(!section.includes(sink), sink);
  assert.match(section, /brief\.textContent = task\.brief/);
  assert.match(section, /const key = agentNewKey\(\)/, "one review form, one idempotency key");
});
