// Opt-in check against the real CLI: EARHEART_REAL_AGENT=codex|claude. It uses
// your own sign-in, sends one tiny read-only request, and then continues the
// same session. Skipped (not failed) otherwise, so CI never needs an account.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskStore } = require("../main/agent-tasks");
const agents = require("../main/agents");
const common = require("../main/agents/common");

const which = process.env.EARHEART_REAL_AGENT;
const adapter = agents.get(which);

test(`real ${which || "agent"}: start, track, and continue the same session`, { skip: !adapter && "set EARHEART_REAL_AGENT=codex|claude", timeout: 240_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-real-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-real-proj-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); });
  const store = createTaskStore({
    file: path.join(dir, "agent-tasks.json"),
    adapters: agents.ADAPTERS,
    resolveBinary: (a) => common.resolveBinary(a.binary),
    getPermission: () => "read",
    startTimeoutMs: 60_000,
  });
  t.after(() => store.shutdown());
  const wait = async (id) => {
    for (let i = 0; i < 2000; i++) {
      const task = store.get(id);
      if (!["starting", "running"].includes(task.status)) return task;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out");
  };
  const sent = store.submit({ key: "realcheck-0001", agent: which, project, brief: "Reply with exactly the single word PONG. Do not use any tools." });
  assert.ok(sent.ok, sent.error);
  const first = await wait(sent.task.id);
  assert.strictEqual(first.status, "completed", first.error);
  assert.ok(first.externalId, "the session id was captured");
  assert.match(first.output, /PONG/i);
  const again = store.reply(first.id, "Now reply with exactly the single word PING. Do not use any tools.");
  assert.ok(again.ok, again.error);
  const second = await wait(first.id);
  assert.strictEqual(second.status, "completed", second.error);
  assert.strictEqual(second.externalId, first.externalId, "the reply continued the same session");
  assert.match(second.output, /PING/i);
});
