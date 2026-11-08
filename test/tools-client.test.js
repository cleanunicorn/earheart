const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createClient } = require("../main/tools/client");
const { validateServer } = require("../main/tools/config");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.js");
const server = (extra = {}) => ({ id: "fx", name: "fixture", command: process.execPath, args: [FIXTURE], cwd: "", env: {}, ...extra });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const withClient = async (opts, fn, srv = server()) => {
  const c = createClient(srv, { killGraceMs: 300, ...opts });
  try { return await fn(c); } finally { await c.close(); }
};

test("lists tools (with pagination) and calls one", async () => {
  await withClient({}, async (c) => {
    const tools = await c.listTools();
    assert.ok(tools.find((t) => t.name === "echo"));
    const res = await c.callTool("echo", { message: "hi" });
    assert.strictEqual(res.content[0].text, "echo: hi");
  });
  await withClient({}, async (c) => {
    assert.strictEqual((await c.listTools()).length, 10);
  }, server({ env: { FIXTURE_PAGED: { value: "1", secret: false } } }));
});

test("rejects an unsupported protocol version and cleans up", async () => {
  const c = createClient(server({ env: { FIXTURE_BAD_VERSION: { value: "1", secret: false } } }), { killGraceMs: 300 });
  await assert.rejects(c.listTools(), /unsupported protocol version/);
  assert.strictEqual(c.pid, null);
});

test("times out a slow call, sends notifications/cancelled and stays usable", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-")), "log");
  await withClient({}, async (c) => {
    await assert.rejects(c.callTool("slow", {}, { timeoutMs: 150 }), (e) => e.code === "timeout");
    assert.strictEqual((await c.callTool("echo", { message: "after" })).content[0].text, "echo: after");
    await new Promise((r) => setTimeout(r, 100));
    assert.match(fs.readFileSync(log, "utf8"), /cancelled \d+/);
  }, server({ env: { FIXTURE_LOG: { value: log, secret: false } } }));
});

test("an abort signal cancels an in-flight call", async () => {
  await withClient({}, async (c) => {
    await c.start();
    const ac = new AbortController();
    const p = c.callTool("slow", {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e) => e.code === "cancelled");
  });
});

test("a crash mid-call rejects with a bounded error and frees the process", async () => {
  const c = createClient(server(), { killGraceMs: 300 });
  await c.start();
  const pid = c.pid;
  await assert.rejects(c.callTool("crash", {}), /exited with code 3/);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(pid));
  await c.close();
});

test("ignores unknown and duplicate response ids and refuses server requests", async () => {
  await withClient({}, async (c) => {
    assert.strictEqual((await c.callTool("dup", {})).content[0].text, "first");
    assert.strictEqual((await c.callTool("ask", {})).content[0].text, "asked");
    assert.ok(c.stats.ignoredResponses >= 2, JSON.stringify(c.stats));
    assert.strictEqual(c.stats.refusedRequests, 1);
  });
});

test("an oversized message kills the server instead of buffering forever", async () => {
  await withClient({}, async (c) => {
    // "huge" returns ~2 MB on one line, over the 1 MiB line limit.
    await assert.rejects(c.callTool("huge", {}), (e) => e.code === "protocol");
  });
});

test("close() kills the process and its children; no orphan survives", async () => {
  const child = path.join(os.tmpdir(), `grand-${process.pid}.js`);
  fs.writeFileSync(child, `
    const { spawn } = require("child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    require("fs").writeFileSync(process.argv[2], String(g.pid));
    require(${JSON.stringify(FIXTURE)});`);
  const pidFile = `${child}.pid`;
  const c = createClient(server({ args: [child, pidFile] }), { killGraceMs: 300 });
  await c.start();
  const grand = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(alive(grand));
  await c.close();
  await new Promise((r) => setTimeout(r, 300));
  if (process.platform !== "win32") assert.ok(!alive(grand), "grandchild survived close()");
  assert.strictEqual(c.pid, null);
});

test("spawn failure and missing command give a useful error", async () => {
  const c = createClient(server({ command: "/nonexistent/binary-xyz" }));
  await assert.rejects(c.listTools(), /command not found|exited|closed/);
  await c.close();
});

test("the child gets a minimal environment plus configured keys, not the parent's", async () => {
  process.env.EARHEART_TEST_LEAK = "leak";
  try {
    await withClient({}, async (c) => {
      assert.strictEqual((await c.callTool("secret", { name: "EARHEART_TEST_LEAK" })).content[0].text, "EARHEART_TEST_LEAK=(unset)");
      assert.strictEqual((await c.callTool("secret", { name: "TOKEN" })).content[0].text, "TOKEN=abc");
    }, server({ env: { TOKEN: { value: "abc", secret: true } } }));
  } finally { delete process.env.EARHEART_TEST_LEAK; }
});

test("config validation rejects hostile entries", () => {
  const ok = { id: "a", name: "A", command: "node", args: ["x"], env: { K: "v" } };
  assert.ok(validateServer(ok).server);
  const bad = (patch, re, opts) => assert.match(validateServer({ ...ok, ...patch }, opts).errors?.join(";") ?? "OK", re);
  bad({ command: "" }, /command is required/);
  bad({ command: "no\0nul" }, /command is required/);
  bad({ args: [1] }, /args must be/);
  bad({ cwd: "relative" }, /absolute/);
  bad({ cwd: "/definitely/not/here" }, /existing directory/);
  bad({ env: { "BAD KEY": "x" } }, /invalid/);
  bad({ env: { LD_PRELOAD: "/x.so" } }, /not allowed/);
  bad({ env: { DYLD_INSERT_LIBRARIES: "x" } }, /not allowed/);
  bad({ env: { NODE_OPTIONS: "--require x" } }, /not allowed/);
  bad({ id: "Bad Id" }, /id must be/);
  bad({ command: "C:\\tools\\npx.cmd" }, /real executable/, { platform: "win32" });
});
