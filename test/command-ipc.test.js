// The voice command IPC (main/commands/ipc.js, #344): every handler checks that
// the sender is the command card's own page and that the payload names a
// command, before the session sees anything. The other windows (overlay,
// Settings, correction, wizard) share the app's preload machinery but must get
// nothing here, and neither may a stale card.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { registerCommandIpc, REJECTED, INVALID } = require("../main/commands/ipc");

const CHANNELS = ["command:get", "command:stop", "command:cancel", "command:retry", "command:restart", "command:apply", "command:copy", "command:close"];

function rig() {
  const handlers = {};
  const calls = [];
  const card = { name: "command card" };
  const record = (name, result = { ok: true }) => (...args) => { calls.push([name, ...args]); return result; };
  const session = {
    peek: record("peek", { id: 7 }),
    stop: record("stop"),
    cancel: record("cancel"),
    retry: record("retry"),
    restart: record("restart"),
    apply: record("apply"),
    copy: record("copy"),
  };
  let closed = 0;
  registerCommandIpc({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    session,
    isCommandSender: (sender) => sender === card,
    closeWindow: () => { closed++; },
  });
  return { handlers, calls, card, closed: () => closed };
}

const call = (r, channel, sender, payload) => r.handlers[channel]({ sender }, payload);

test("every command channel is registered, and only those", () => {
  const r = rig();
  assert.deepStrictEqual(Object.keys(r.handlers).sort(), [...CHANNELS].sort());
});

test("senders that aren't the command card are rejected on every channel, without touching the session", async () => {
  const r = rig();
  const windows = { overlay: { name: "overlay" }, settings: { name: "settings" }, correction: { name: "correction" }, wizard: { name: "wizard" }, none: undefined };
  for (const channel of CHANNELS) {
    for (const [name, sender] of Object.entries(windows)) {
      const result = await call(r, channel, sender, { id: 1 });
      assert.deepStrictEqual(result, REJECTED, `${channel} from ${name}`);
    }
  }
  assert.deepStrictEqual(r.calls, []);
  assert.strictEqual(r.closed(), 0, "a foreign window can't close the card either");
});

test("an event with no sender at all is rejected", async () => {
  const r = rig();
  assert.deepStrictEqual(await r.handlers["command:apply"](undefined, { id: 1 }), REJECTED);
  assert.deepStrictEqual(await r.handlers["command:apply"]({}, { id: 1 }), REJECTED);
});

test("the card must name a command id for every action", async () => {
  const r = rig();
  for (const channel of ["command:stop", "command:cancel", "command:retry", "command:restart", "command:apply", "command:copy"]) {
    for (const payload of [undefined, null, {}, { id: "1" }, { id: 0 }, { id: -3 }, { id: 1.5 }, { id: NaN }, { id: {} }, "1", 1]) {
      assert.deepStrictEqual(await call(r, channel, r.card, payload), INVALID, `${channel} ${JSON.stringify(payload)}`);
    }
  }
  assert.deepStrictEqual(r.calls, []);
});

test("a valid request reaches the session with just the id", async () => {
  const r = rig();
  await call(r, "command:apply", r.card, { id: 7, output: "attacker text", target: "other window" });
  await call(r, "command:copy", r.card, { id: 7, text: "attacker text" });
  await call(r, "command:retry", r.card, { id: 7 });
  await call(r, "command:stop", r.card, { id: 7 });
  await call(r, "command:restart", r.card, { id: 7 });
  assert.deepStrictEqual(r.calls, [["apply", 7], ["copy", 7], ["retry", 7], ["stop", 7], ["restart", 7]],
    "the card can't supply the text to apply or the target to apply it to");
});

test("cancel and close both end the command and close the card", async () => {
  const r = rig();
  await call(r, "command:cancel", r.card, { id: 7 });
  assert.deepStrictEqual(r.calls, [["cancel", 7]]);
  assert.strictEqual(r.closed(), 1);
  await call(r, "command:close", r.card, { id: 9 });
  await call(r, "command:close", r.card, {});
  assert.strictEqual(r.closed(), 3, "Close always closes, even for a stale or missing id");
  assert.deepStrictEqual(r.calls, [["cancel", 7], ["cancel", 9]]);
});

test("get returns the current command to the card only", async () => {
  const r = rig();
  assert.deepStrictEqual(await call(r, "command:get", r.card, {}), { ok: true, view: { id: 7 } });
  assert.deepStrictEqual(await call(r, "command:get", { name: "overlay" }, {}), REJECTED);
});

test("a throwing session answers with a plain failure and doesn't leak the error", async () => {
  const handlers = {};
  registerCommandIpc({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    session: { apply: () => { throw new Error("SECRET internal detail"); } },
    isCommandSender: () => true,
    closeWindow() {},
  });
  assert.deepStrictEqual(await handlers["command:apply"]({ sender: {} }, { id: 1 }), { ok: false, error: "The command failed" });
});

test("no handler is added without the sender check (source pin)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main", "commands", "ipc.js"), "utf8");
  const handles = source.split("ipcMain.handle(").slice(1);
  assert.strictEqual(handles.length, CHANNELS.length);
  for (const body of handles) {
    const handler = body.slice(0, body.indexOf("\n  ipcMain.handle(") === -1 ? body.length : body.indexOf("\n  ipcMain.handle("));
    assert.ok(/guarded\(|isCommandSender\(/.test(handler), `unguarded handler: ${handler.slice(0, 60)}`);
  }
});

test("the preload gives the command card exactly the command channels and nothing of the other windows'", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const block = preload.match(/\n  command: \{([\s\S]*?)\n  \},\n/)[1];
  const invoked = [...block.matchAll(/"(command:[a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(invoked.sort(), ["command:state", ...CHANNELS].sort());
  assert.ok(!/settings:|history:|models:|updates:|logs:/.test(block));
  // And no other window can reach the command channels.
  const others = preload.replace(block, "");
  assert.ok(!/"command:(get|apply|copy|cancel|retry|restart|stop|close)"/.test(others));
});
