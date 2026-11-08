const { test } = require("node:test");
const assert = require("node:assert");
const { createBroker } = require("../main/tools/broker");

const info = (extra = {}) => ({ serverId: "s", serverName: "S", tool: "t", description: "d", args: { a: 1 }, argsHash: "h1", ...extra });

test("only an explicit allow approves; the id is single-use", async () => {
  const b = createBroker();
  const p = b.request(info());
  const { id } = b.current();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(b.decide(id, "allow"));
  assert.deepStrictEqual(await p, { approved: true, argsHash: "h1" });
  assert.strictEqual(b.decide(id, "allow"), false, "a consumed id cannot approve again");
  for (const bad of ["yes", "ALLOW", true, undefined, null, {}]) {
    const q = b.request(info());
    b.decide(b.current().id, bad);
    assert.strictEqual((await q).approved, false, String(bad));
  }
});

test("deny and unknown ids", async () => {
  const b = createBroker();
  const p = b.request(info());
  assert.strictEqual(b.decide("deadbeef", "allow"), false);
  assert.strictEqual(b.size(), 1);
  b.decide(b.current().id, "deny");
  assert.deepStrictEqual(await p, { approved: false, reason: "denied by user" });
});

test("an expired approval cannot authorize anything later", async () => {
  let t = 1000;
  const b = createBroker({ ttlMs: 50, now: () => t });
  const p = b.request(info());
  const { id } = b.current();
  await new Promise((r) => setTimeout(r, 90));
  assert.deepStrictEqual(await p, { approved: false, reason: "approval expired" });
  assert.strictEqual(b.decide(id, "allow"), false);
  assert.strictEqual(b.size(), 0);
  // Even if the timer were late, a decision past expiresAt is refused.
  const late = b.request(info());
  const lateId = b.current().id;
  t += 10_000;
  assert.strictEqual(b.decide(lateId, "allow"), false);
  assert.strictEqual((await late).approved, false);
});

test("requests queue one at a time and ids differ per request", async () => {
  const b = createBroker();
  const a = b.request(info({ tool: "first" }));
  const c = b.request(info({ tool: "second" }));
  const firstId = b.current().id;
  assert.strictEqual(b.current().tool, "first");
  b.decide(firstId, "allow");
  await a;
  assert.strictEqual(b.current().tool, "second");
  assert.notStrictEqual(b.current().id, firstId);
  assert.strictEqual(b.decide(firstId, "allow"), false, "the first id cannot approve the second request");
  b.cancelAll("quit");
  assert.deepStrictEqual(await c, { approved: false, reason: "quit" });
});

test("cancelServer settles only that server's requests", async () => {
  const b = createBroker();
  const x = b.request(info({ serverId: "x" }));
  const y = b.request(info({ serverId: "y" }));
  b.cancelServer("x");
  assert.strictEqual((await x).approved, false);
  assert.strictEqual(b.size(), 1);
  b.decide(b.current().id, "allow");
  assert.strictEqual((await y).approved, true);
});

test("displayed strings are bounded plain text", () => {
  const b = createBroker();
  b.request(info({ serverName: "\u001b[31mevil\u001b[0m".repeat(50), args: { x: "y".repeat(10000) } }));
  const v = b.current();
  assert.ok(!v.server.includes("\u001b"));
  assert.ok(v.server.length <= 61);
  assert.ok(v.args.length < 4100);
  b.cancelAll();
});
