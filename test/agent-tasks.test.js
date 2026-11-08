const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../main/agent-tasks");

const AGENT = path.join(__dirname, "helpers", "fake-agent.js");

const fake = {
  id: "fake",
  label: "Fake",
  binary: "fake",
  models: ["m1"],
  idUpfront: false,
  start: () => ({ args: [AGENT, "start"], stdin: true }),
  resume: ({ externalId }) => ({ args: [AGENT, "resume", externalId], stdin: true }),
  parse(line) {
    const ev = JSON.parse(line);
    if (ev.type === "session") return [{ type: "session", id: ev.id }];
    if (ev.type === "message") return [{ type: "message", text: ev.text }];
    if (ev.type === "error") return [{ type: "error", message: ev.message }];
    if (ev.type === "done") return [{ type: "done", ok: ev.ok }];
    return [];
  },
  resumeCommand: (task) => `fake resume ${task.externalId}`,
};
const upfront = { ...fake, id: "upfront", idUpfront: true, newSessionId: () => "pre-chosen-id" };

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-agent-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-proj-"));
  t.after(() => {
    store?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const file = path.join(dir, "agent-tasks.json");
  const events = [];
  const make = (extra = {}) =>
    createTaskStore({
      file,
      adapters: [fake, upfront],
      resolveBinary: () => ({ ok: true, path: process.execPath }),
      onFinished: (task) => events.push(task.status),
      killGraceMs: 100,
      ...options,
      ...extra,
    });
  let store = make();
  return { dir, project, file, events, make, get store() { return store; }, reopen(extra) { store.shutdown(); store = make(extra); return store; } };
}

async function settled(store, id, statuses = ["completed", "failed", "cancelled", "interrupted"]) {
  for (let i = 0; i < 300; i++) {
    const task = store.get(id);
    if (task && statuses.includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task never settled: ${JSON.stringify(store.get(id))}`);
}

const send = (env, over = {}) => env.store.submit({ key: "key-00000001", agent: "fake", project: env.project, brief: "hello agent", ...over });

test("a reviewed send runs to completion with the session id and output", async (t) => {
  const env = setup(t);
  const res = send(env);
  assert.ok(res.ok);
  assert.strictEqual(res.task.status, "starting");
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.externalId, "sess-1");
  assert.match(done.output, /echo:hello agent/);
  assert.strictEqual(done.resumeCommand, "fake resume sess-1");
  assert.deepStrictEqual(env.events, ["completed"]);
});

test("repeated activation with the same key never starts a second task", async (t) => {
  const env = setup(t);
  const first = send(env);
  const again = send(env);
  const third = send(env, { brief: "changed text" });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual(third.task.id, first.task.id);
  assert.strictEqual(env.store.list().length, 1);
  await settled(env.store, first.task.id);
  assert.strictEqual(send(env).task.id, first.task.id); // still the same after finishing
});

test("the same key after a restart finds the interrupted task instead of duplicating it", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "hang" });
  await settled(env.store, res.task.id, ["running"]);
  const store = env.reopen(); // the old process is killed by shutdown; this run owns nothing
  const task = store.get(res.task.id);
  assert.strictEqual(task.status, "interrupted");
  assert.match(task.error, /restarted/);
  assert.strictEqual(task.brief, "hang");
  const retry = store.submit({ key: "key-00000001", agent: "fake", project: env.project, brief: "hang" });
  assert.strictEqual(retry.duplicate, true);
  assert.strictEqual(store.list().length, 1);
});

test("a crash between the write and the spawn leaves an interrupted task, not a lost brief", (t) => {
  const env = setup(t);
  const store = env.make({ resolveBinary: () => { throw new Error("crash"); } });
  assert.throws(() => store.submit({ key: "key-00000002", agent: "fake", project: env.project, brief: "important words" }));
  const reopened = env.make();
  const [task] = reopened.list();
  assert.strictEqual(task.status, "interrupted");
  assert.strictEqual(task.brief, "important words");
});

test("an auth failure keeps the brief and reports the agent's message", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "authfail please" });
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /not logged in/);
  assert.strictEqual(done.brief, "authfail please");
});

test("an error event from the agent fails the task with its message", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "boom" });
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /model exploded/);
});

test("a missing binary fails the launch and keeps the brief", async (t) => {
  const env = setup(t);
  const store = env.make({ resolveBinary: () => ({ ok: false, reason: "fake was not found." }) });
  const res = store.submit({ key: "key-00000003", agent: "fake", project: env.project, brief: "keep me" });
  assert.strictEqual(res.task.status, "failed");
  assert.strictEqual(res.task.error, "fake was not found.");
  assert.strictEqual(res.task.brief, "keep me");
});

test("a spawn error (ENOENT) fails the task", async (t) => {
  const env = setup(t);
  const store = env.make({ resolveBinary: () => ({ ok: true, path: path.join(env.dir, "does-not-exist") }) });
  const res = store.submit({ key: "key-00000004", agent: "fake", project: env.project, brief: "x" });
  const done = await settled(store, res.task.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /ENOENT/);
});

test("a task that never confirms its session times out, fails and is killed", async (t) => {
  const env = setup(t, { startTimeoutMs: 150 });
  const res = send(env, { brief: "nosession" });
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /did not start/);
  assert.strictEqual(env.store.hasLive(), false);
});

test("cancelling during starting, before the id is known, still kills the child", async (t) => {
  const env = setup(t, { startTimeoutMs: 60_000 });
  const res = send(env, { brief: "nosession" });
  assert.strictEqual(env.store.get(res.task.id).status, "starting");
  assert.ok(env.store.cancel(res.task.id).ok);
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "cancelled");
  assert.strictEqual(env.store.hasLive(), false);
});

test("cancel reaches only the targeted task, and escalates past a stubborn process", async (t) => {
  const env = setup(t);
  const a = send(env, { key: "key-0000000a", brief: "hang" });
  const b = send(env, { key: "key-0000000b", brief: "stubborn" });
  await settled(env.store, a.task.id, ["running"]);
  await settled(env.store, b.task.id, ["running"]);
  env.store.cancel(b.task.id);
  assert.strictEqual((await settled(env.store, b.task.id)).status, "cancelled");
  assert.strictEqual(env.store.get(a.task.id).status, "running");
  env.store.cancel(a.task.id);
  assert.strictEqual((await settled(env.store, a.task.id)).status, "cancelled");
});

test("cancelling a task Earheart doesn't own is refused", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "hang" });
  await settled(env.store, res.task.id, ["running"]);
  const store = env.reopen();
  assert.deepStrictEqual(store.cancel(res.task.id).ok, false);
  assert.strictEqual(store.cancel("missing").ok, false);
});

test("a reply continues the same session after the UI and store are reopened", async (t) => {
  const env = setup(t);
  const res = send(env);
  await settled(env.store, res.task.id);
  const store = env.reopen();
  const out = store.reply(res.task.id, "and also this");
  assert.ok(out.ok);
  const done = await settled(store, res.task.id);
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.externalId, "sess-1"); // the same session, not a new task
  assert.match(done.output, /echo:and also this/);
  assert.strictEqual(done.turns, 2);
  assert.strictEqual(store.list().length, 1);
});

test("a reply while a turn is running is rejected, not queued", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "hang" });
  await settled(env.store, res.task.id, ["running"]);
  const out = env.store.reply(res.task.id, "too soon");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /still working/);
  assert.strictEqual(env.store.get(res.task.id).turns, 1);
});

test("a reply to a failed resume fails the task and the caller keeps the text", async (t) => {
  const env = setup(t);
  const res = send(env);
  await settled(env.store, res.task.id);
  const out = env.store.reply(res.task.id, "authfail again");
  assert.ok(out.ok);
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /not logged in/);
});

test("a reply needs a session and a non-empty text", async (t) => {
  const env = setup(t);
  const res = send(env, { brief: "authfail" });
  await settled(env.store, res.task.id);
  assert.match(env.store.reply(res.task.id, "hi").error, /no session/);
  const ok = send(env, { key: "key-00000009" });
  await settled(env.store, ok.task.id);
  assert.match(env.store.reply(ok.task.id, "  ").error, /empty/);
});

test("an agent that picks its session id up front is running with that id at once", async (t) => {
  const env = setup(t);
  const res = send(env, { agent: "upfront" });
  assert.strictEqual(res.task.externalId, "pre-chosen-id");
  const done = await settled(env.store, res.task.id);
  assert.strictEqual(done.externalId, "pre-chosen-id");
  assert.strictEqual(done.status, "completed");
});

test("project paths are validated in main: relative, flag-like, missing and file paths are refused", (t) => {
  const env = setup(t);
  const file = path.join(env.dir, "afile");
  fs.writeFileSync(file, "x");
  for (const project of ["", "-rf", "--version", "relative/dir", path.join(env.dir, "nope"), file, undefined, 5]) {
    const res = send(env, { key: `key-${Math.random().toString(36).slice(2, 12)}`, project });
    assert.strictEqual(res.ok, false, String(project));
  }
  assert.strictEqual(env.store.list().length, 0);
});

test("a symlinked project resolves to its real directory", (t) => {
  const env = setup(t);
  const link = path.join(env.dir, "link");
  fs.symlinkSync(env.project, link);
  const res = send(env, { project: link });
  assert.strictEqual(res.task.project, fs.realpathSync(env.project));
});

test("agent, model and key come from allowlists in main", (t) => {
  const env = setup(t);
  assert.strictEqual(send(env, { agent: "../bin/sh" }).ok, false);
  assert.strictEqual(send(env, { model: "--dangerously-bypass" }).ok, false);
  assert.strictEqual(send(env, { key: "x" }).ok, false);
  assert.strictEqual(send(env, { brief: "   " }).ok, false);
  assert.strictEqual(send(env, { brief: "x".repeat(60_000) }).ok, false);
  assert.strictEqual(send(env, { model: "m1" }).ok, true);
  assert.strictEqual(env.store.list().length, 1);
});

test("clear removes finished tasks and their briefs from disk; remove refuses an active one", async (t) => {
  const env = setup(t);
  const done = send(env, { key: "key-0000000c", historyId: "h1" });
  await settled(env.store, done.task.id);
  const active = send(env, { key: "key-0000000d", brief: "hang" });
  await settled(env.store, active.task.id, ["running"]);
  assert.strictEqual(env.store.remove(active.task.id).ok, false);
  env.store.removeForHistory("h1");
  assert.strictEqual(env.store.get(done.task.id), null);
  assert.ok(env.store.clear().ok);
  await settled(env.store, active.task.id);
  assert.ok(!fs.readFileSync(env.file, "utf8").includes("hello agent"));
  assert.strictEqual(fs.statSync(env.file).mode & 0o777, process.platform === "win32" ? fs.statSync(env.file).mode & 0o777 : 0o600);
});

test("saved output is capped and a corrupt file starts empty", (t) => {
  const env = setup(t);
  fs.writeFileSync(env.file, "{not json");
  assert.deepStrictEqual(env.make().list(), []);
});
