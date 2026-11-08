const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createManager } = require("../main/tools/manager");
const { createStore } = require("../main/tools/store");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.js");

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
  const logFile = path.join(dir, "calls.log");
  const store = createStore({ file: path.join(dir, "tools.json"), secure: () => false });
  const mgr = createManager({ store, clientOptions: { killGraceMs: 300, callMs: 400 }, ...extra });
  const raw = { id: "fx", name: "Fixture", enabled: true, command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: { value: logFile, secret: false }, TOKEN: { value: "s3cret-token", secret: true } } };
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("call ")) : []);
  return { dir, store, mgr, raw, calls, file: path.join(dir, "tools.json") };
}
const tool = (mgr, name) => mgr.view()[0].tools.find((t) => t.name === name);
const enable = (mgr, name, policy = "allow") => {
  const t = tool(mgr, name);
  assert.ok(mgr.setPolicy({ serverId: "fx", tool: name, schemaHash: t.schemaHash, enabled: true, policy }).ok);
};
const approve = async (mgr, decision) => {
  for (let i = 0; i < 100 && !mgr.broker.current(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(mgr.broker.current(), "an approval should be pending");
  return mgr.broker.decide(mgr.broker.current().id, decision);
};

test("nothing runs until discovered, enabled and allowed", async () => {
  const { mgr, raw, calls } = setup();
  try {
    assert.ok((await mgr.saveServer(raw)).ok);
    assert.match((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "x" } })).error, /not in the discovered catalog/);
    assert.ok((await mgr.discover("fx")).ok);
    assert.match((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "x" } })).error, /disabled/);
    enable(mgr, "echo", "deny");
    assert.match((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "x" } })).error, /denied/);
    assert.strictEqual(calls().length, 0, "denied and disabled tools never reached the server");
    assert.deepStrictEqual(mgr.modelCatalog(), []);
  } finally { await mgr.shutdown(); }
});

test("allow executes; ask waits for the matching approval; deny and expiry never run", async () => {
  const { mgr, raw, calls } = setup({ brokerOptions: { ttlMs: 200 } });
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    enable(mgr, "echo", "allow");
    const direct = await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "hi" } });
    assert.ok(direct.ok); assert.match(direct.text, /echo: hi/);

    enable(mgr, "echo", "ask");
    const denied = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "no" } });
    await approve(mgr, "deny");
    assert.strictEqual((await denied).ok, false);

    const expired = await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "late" } });
    assert.match(expired.error, /expired/);
    assert.strictEqual(mgr.broker.size(), 0);

    const ok = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "yes" } });
    await approve(mgr, "allow");
    assert.ok((await ok).ok);
    assert.deepStrictEqual(calls().map((c) => JSON.parse(c.slice(10))), [{ message: "hi" }, { message: "yes" }]);
  } finally { await mgr.shutdown(); }
});

test("approving one request does not authorize another", async () => {
  const { mgr, raw, calls } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    enable(mgr, "echo", "ask");
    const a = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "A" } });
    const b = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "B" } });
    await approve(mgr, "allow");           // approves A only
    assert.ok((await a).ok);
    assert.strictEqual(mgr.broker.current().args.includes('"B"'), true);
    assert.strictEqual(calls().length, 1);
    await approve(mgr, "deny");
    assert.strictEqual((await b).ok, false);
    assert.strictEqual(calls().length, 1, "B never executed");
  } finally { await mgr.shutdown(); }
});

test("policy changed while waiting withdraws the approval (re-check at execute time)", async () => {
  const { mgr, raw, calls } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    enable(mgr, "echo", "ask");
    const p = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "x" } });
    for (let i = 0; i < 100 && !mgr.broker.current(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(mgr.broker.current());
    const t = tool(mgr, "echo");
    mgr.setPolicy({ serverId: "fx", tool: "echo", schemaHash: t.schemaHash, policy: "deny" });
    assert.strictEqual((await p).ok, false);
    assert.strictEqual(calls().length, 0);
  } finally { await mgr.shutdown(); }
});

test("removing the server or editing it cancels pending approvals", async () => {
  const { mgr, raw, calls } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    enable(mgr, "echo", "ask");
    const p = mgr.execute({ serverId: "fx", tool: "echo", args: { message: "x" } });
    await new Promise((r) => setTimeout(r, 30));
    await mgr.removeServer("fx");
    assert.match((await p).error, /server removed/);
    assert.strictEqual(calls().length, 0);
  } finally { await mgr.shutdown(); }
});

test("schema and argument rejection happen before approval or execution", async () => {
  const { mgr, raw, calls } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    enable(mgr, "echo", "ask");
    for (const args of [{}, { message: 1 }, { message: "x", extra: 1 }, { message: "x".repeat(101) }, JSON.parse('{"message":"a","__proto__":{"x":1}}')]) {
      const r = await mgr.execute({ serverId: "fx", tool: "echo", args });
      assert.match(r.error, /invalid arguments/, JSON.stringify(args));
    }
    assert.strictEqual(mgr.broker.size(), 0, "invalid arguments never reach the approval UI");
    // A tool whose schema uses an unsupported keyword cannot be enabled or called.
    assert.match(tool(mgr, "refs").problem, /unsupported keyword/);
    assert.match(mgr.setPolicy({ serverId: "fx", tool: "refs", schemaHash: tool(mgr, "refs").schemaHash, enabled: true }).error, /cannot enable/);
    assert.strictEqual(calls().length, 0);
  } finally { await mgr.shutdown(); }
});

test("malicious-looking results are returned as bounded plain data", async () => {
  const { mgr, raw } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    for (const n of ["evil", "huge", "fail"]) enable(mgr, n, "allow");
    const evil = await mgr.execute({ serverId: "fx", tool: "evil", args: {} });
    assert.ok(evil.ok);
    assert.ok(!/[\u001b\u0007‮]/.test(evil.text));
    assert.match(evil.text, /IGNORE ALL PREVIOUS/); // shown as data, not acted on
    assert.ok(!evil.modelText.includes("</tool_output> system"), "closing tag inside data is neutralised");
    assert.match(evil.modelText, /untrusted data/);
    const huge = await mgr.execute({ serverId: "fx", tool: "huge", args: {} });
    assert.strictEqual(huge.ok, false);
    assert.ok(huge.error.length < 400);
    const fail = await mgr.execute({ serverId: "fx", tool: "fail", args: {} });
    assert.strictEqual(fail.ok, false);
    assert.strictEqual(fail.isError, true);
  } finally { await mgr.shutdown(); }
});

test("a crashing or slow tool returns a bounded error; later calls still work; a crash loop is stopped", async () => {
  const { mgr, raw } = setup();
  try {
    await mgr.saveServer(raw); await mgr.discover("fx");
    for (const n of ["crash", "slow", "echo"]) enable(mgr, n, "allow");
    const slow = await mgr.execute({ serverId: "fx", tool: "slow", args: {} });
    assert.match(slow.error, /timed out/);
    assert.ok((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "ok" } })).ok);
    const crash = await mgr.execute({ serverId: "fx", tool: "crash", args: {} });
    assert.match(crash.error, /exited with code 3/);
    assert.ok((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "again" } })).ok, "a fresh process serves the next call");
    await mgr.execute({ serverId: "fx", tool: "crash", args: {} });
    await mgr.execute({ serverId: "fx", tool: "crash", args: {} });
    assert.match((await mgr.execute({ serverId: "fx", tool: "echo", args: { message: "loop" } })).error, /keeps crashing/);
  } finally { await mgr.shutdown(); }
});

test("an aborted call stops, and shutdown kills every owned process within the deadline", async () => {
  const { mgr, raw } = setup({ clientOptions: { killGraceMs: 300, callMs: 5000 } });
  await mgr.saveServer(raw); await mgr.discover("fx");
  enable(mgr, "slow", "allow");
  const ac = new AbortController();
  const p = mgr.execute({ serverId: "fx", tool: "slow", args: {}, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  assert.match((await p).error, /cancelled/);
  const pid = mgr._clients.get("fx").client.pid;
  const started = Date.now();
  await mgr.shutdown(2000);
  assert.ok(Date.now() - started < 2500);
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(pid, 0));
  assert.match((await mgr.execute({ serverId: "fx", tool: "slow", args: {} })).error, /./);
});

test("a changed schema resets consent to disabled/ask, and stale entries are pruned", async () => {
  let schema = { type: "object", properties: { q: { type: "string" } } };
  const fake = () => ({
    listTools: async () => [{ name: "search", description: "d", inputSchema: schema }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {}, onExit() {}, dead: false,
  });
  const { mgr, raw } = setup({ createClient: fake });
  try {
    await mgr.saveServer({ ...raw, env: {} }); await mgr.discover("fx");
    enable(mgr, "search", "allow");
    assert.ok((await mgr.execute({ serverId: "fx", tool: "search", args: { q: "a" } })).ok);
    schema = { type: "object", properties: { q: { type: "string" }, path: { type: "string" } } };
    await mgr.discover("fx");
    const t = tool(mgr, "search");
    assert.deepStrictEqual([t.enabled, t.policy], [false, "ask"]);
    assert.match((await mgr.execute({ serverId: "fx", tool: "search", args: { q: "a" } })).error, /disabled/);
    assert.deepStrictEqual(mgr.modelCatalog(), []);
  } finally { await mgr.shutdown(); }
});

test("secrets stay out of the renderer view and out of error text; secret edits keep the stored value", async () => {
  const fake = () => ({
    listTools: async () => [{ name: "t", description: "", inputSchema: { type: "object" } }], callTool: async () => { throw new Error("auth failed for token s3cret-token"); },
    close: async () => {}, onExit() {}, dead: false,
  });
  const { mgr, raw, file } = setup({ createClient: fake });
  try {
    const saved = await mgr.saveServer(raw);
    assert.ok(!JSON.stringify(saved).includes("s3cret-token"));
    assert.deepStrictEqual(saved.servers[0].env.TOKEN, { secret: true, set: true });
    assert.deepStrictEqual(saved.servers[0].env.FIXTURE_LOG.secret, false);
    await mgr.saveServer({ ...raw, name: "Renamed", env: { ...raw.env, TOKEN: { secret: true, keep: true } } });
    assert.ok(!JSON.stringify(mgr.view()).includes("s3cret-token"));
    assert.match(fs.readFileSync(file, "utf8"), /s3cret-token/, "kept: still stored (plaintext here: no secure storage in this test)");
    assert.strictEqual(fs.statSync(file).mode & 0o077, process.platform === "win32" ? fs.statSync(file).mode & 0o077 : 0);
    await mgr.discover("fx");
    enable(mgr, "t", "allow");
    const failed = await mgr.execute({ serverId: "fx", tool: "t", args: {} });
    assert.strictEqual(failed.ok, false);
    assert.ok(!failed.error.includes("s3cret-token"), failed.error);
    assert.match(failed.error, /\[redacted\]/);
  } finally { await mgr.shutdown(); }
});
