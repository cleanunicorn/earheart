const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { register } = require("../main/tools");
const { createManager } = require("../main/tools/manager");
const { createStore } = require("../main/tools/store");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.js");

function harness() {
  const handlers = new Map();
  const settingsSender = { id: "settings" }, approvalSender = { id: "approval" }, stranger = { id: "other" };
  const windows = { isSettingsSender: (s) => s === settingsSender, isApprovalSender: (s) => s === approvalSender };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-ipc-"));
  const store = createStore({ file: path.join(dir, "tools.json"), secure: () => false });
  const manager = createManager({ store, clientOptions: { killGraceMs: 300 } });
  register({ ipcMain: { handle: (c, h) => handlers.set(c, h) }, windows, manager, store, logger: { info() {}, warn() {} } });
  const call = (channel, sender, payload) => handlers.get(channel)({ sender }, payload);
  return { call, manager, settingsSender, approvalSender, stranger, handlers };
}

test("every tools:* handler is Settings-only and every approval:* handler approval-window-only", async () => {
  const h = harness();
  try {
    for (const channel of ["tools:list", "tools:save-server", "tools:remove-server", "tools:discover", "tools:set-policy"]) {
      for (const sender of [h.stranger, h.approvalSender]) {
        const res = await h.call(channel, sender, {});
        assert.strictEqual(res.ok, false, `${channel} from a foreign window`);
      }
    }
    assert.strictEqual(await h.call("approval:get", h.settingsSender), null);
    assert.deepStrictEqual(await h.call("approval:decide", h.settingsSender, { id: "x", decision: "allow" }), { ok: false });
    assert.deepStrictEqual(await h.call("approval:decide", h.stranger, { id: "x", decision: "allow" }), { ok: false });
    assert.ok((await h.call("tools:list", h.settingsSender)).ok);
  } finally { await h.manager.shutdown(); }
});

test("only the approval window resolves a request, and only the literal allow approves", async () => {
  const h = harness();
  try {
    await h.call("tools:save-server", h.settingsSender, { id: "fx", name: "F", enabled: true, command: process.execPath, args: [FIXTURE] });
    await h.call("tools:discover", h.settingsSender, "fx");
    const echo = h.manager.view()[0].tools.find((t) => t.name === "echo");
    assert.ok((await h.call("tools:set-policy", h.settingsSender, { serverId: "fx", tool: "echo", schemaHash: echo.schemaHash, enabled: true, policy: "ask" })).ok);

    const run = (message) => h.manager.execute({ serverId: "fx", tool: "echo", args: { message } });
    let p = run("a");
    await new Promise((r) => setTimeout(r, 30));
    const id = (await h.call("approval:get", h.approvalSender)).id;
    assert.deepStrictEqual(await h.call("approval:decide", h.settingsSender, { id, decision: "allow" }), { ok: false });
    assert.strictEqual(h.manager.broker.size(), 1, "a foreign window did not consume the request");
    await h.call("approval:decide", h.approvalSender, { id, decision: "yes please" });
    assert.strictEqual((await p).ok, false);

    p = run("b");
    await new Promise((r) => setTimeout(r, 30));
    const id2 = (await h.call("approval:get", h.approvalSender)).id;
    assert.strictEqual((await h.call("approval:decide", h.approvalSender, { id: id, decision: "allow" })).ok, false, "an old id cannot approve a new request");
    assert.ok((await h.call("approval:decide", h.approvalSender, { id: id2, decision: "allow" })).ok);
    assert.ok((await p).ok);
    assert.strictEqual((await h.call("approval:decide", h.approvalSender, { id: id2, decision: "allow" })).ok, false, "replay refused");
  } finally { await h.manager.shutdown(); }
});

test("malformed IPC payloads are refused, not thrown", async () => {
  const h = harness();
  try {
    assert.strictEqual((await h.call("tools:save-server", h.settingsSender, null)).ok, false);
    assert.strictEqual((await h.call("tools:save-server", h.settingsSender, "x")).ok, false);
    assert.strictEqual((await h.call("tools:remove-server", h.settingsSender, { a: 1 })).ok, false);
    assert.strictEqual((await h.call("tools:discover", h.settingsSender, 5)).ok, false);
    assert.strictEqual((await h.call("tools:set-policy", h.settingsSender, { serverId: 1 })).ok, false);
    assert.deepStrictEqual(await h.call("approval:decide", h.approvalSender, null), { ok: false });
    const bad = await h.call("tools:save-server", h.settingsSender, { id: "x", name: "x", command: "node", env: { LD_PRELOAD: "x" } });
    assert.match(bad.errors.join(), /not allowed/);
  } finally { await h.manager.shutdown(); }
});

test("a hand-edited tools.json is untrusted: invalid servers are dropped on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-load-"));
  const file = path.join(dir, "tools.json");
  fs.writeFileSync(file, JSON.stringify({ servers: [
    { id: "good", name: "Good", command: "node", args: [], env: {} },
    { id: "bad id", name: "x", command: "node" },
    { id: "nocmd", name: "x", command: "" },
    { id: "ld", name: "x", command: "node", env: { LD_PRELOAD: { value: "x", secret: false } } },
    "junk", null,
  ], policies: "nonsense" }));
  const warnings = [];
  const { servers, policies } = createStore({ file, secure: () => false, onWarn: (m) => warnings.push(m) }).load();
  assert.deepStrictEqual(servers.map((s) => s.id), ["good"]);
  assert.deepStrictEqual(policies, []);
  assert.ok(warnings.length >= 3);
  fs.writeFileSync(file, "{not json");
  assert.deepStrictEqual(createStore({ file, secure: () => false, onWarn() {} }).load(), { servers: [], policies: [] });
});

test("secrets are encrypted at rest when secure storage exists, and kept on a failed decrypt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-enc-"));
  const file = path.join(dir, "tools.json");
  let locked = false;
  const safeStorage = {
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => { if (locked) throw new Error("locked"); return b.toString().replace(/^enc:/, ""); },
  };
  const store = createStore({ file, safeStorage, secure: () => true, onWarn() {} });
  const server = { id: "a", name: "A", enabled: false, command: "node", args: [], cwd: "", env: { TOKEN: { value: "top-secret", secret: true }, MODE: { value: "x", secret: false } } };
  store.save({ servers: [server], policies: [] });
  const disk = fs.readFileSync(file, "utf8");
  assert.ok(!disk.includes("top-secret"));
  assert.strictEqual(store.load().servers[0].env.TOKEN.value, "top-secret");
  locked = true;
  const loaded = store.load();
  assert.strictEqual(loaded.servers[0].env.TOKEN.value, "");
  store.save({ servers: loaded.servers, policies: [] });
  locked = false;
  assert.strictEqual(store.load().servers[0].env.TOKEN.value, "top-secret", "a locked keyring did not cost the stored secret");
});
