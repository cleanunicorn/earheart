const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const codex = require("../main/agents/codex");
const claude = require("../main/agents/claude");
const common = require("../main/agents/common");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "agents", name), "utf8").split("\n").filter(Boolean);
const parseAll = (adapter, lines) => lines.flatMap((line) => adapter.parse(line));

test("Codex start uses an argv array, the project via -C, a workspace-write sandbox and stdin for the brief", () => {
  const plan = codex.start({ prompt: "rm -rf / ; $(whoami)", cwd: "/work/proj", model: "", permission: "edit" });
  assert.deepStrictEqual(plan.args, ["exec", "--json", "-C", "/work/proj", "-s", "workspace-write", "-"]);
  assert.ok(plan.stdin);
  assert.ok(!plan.args.some((arg) => arg.includes("rm -rf")), "the brief never enters argv");
  assert.ok(codex.start({ cwd: "/p", permission: "read" }).args.includes("read-only"));
  assert.deepStrictEqual(codex.start({ cwd: "/p", model: "gpt-x" }).args.slice(-3), ["-m", "gpt-x", "-"]);
});

test("Codex resume targets the stored session and keeps the sandbox", () => {
  const plan = codex.resume({ externalId: "abc-123", permission: "read" });
  assert.deepStrictEqual(plan.args, ["exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', "abc-123", "-"]);
});

test("Claude start picks the session id, a non-bypass permission mode and stdin", () => {
  const plan = claude.start({ cwd: "/p", model: "sonnet", permission: "edit", sessionId: "sid-1" });
  assert.deepStrictEqual(plan.args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--model", "sonnet", "--session-id", "sid-1"]);
  assert.ok(plan.stdin);
  assert.ok(claude.start({ cwd: "/p", permission: "read", sessionId: "s" }).args.includes("plan"));
  assert.deepStrictEqual(claude.resume({ externalId: "sid-1", permission: "edit" }).args.slice(-2), ["--resume", "sid-1"]);
  assert.match(claude.newSessionId(), /^[0-9a-f-]{36}$/);
});

test("no adapter can ask for a bypass or full-access mode", () => {
  const source = ["codex.js", "claude.js"].map((f) => fs.readFileSync(path.join(__dirname, "..", "main", "agents", f), "utf8").replace(/\/\/.*$/gm, "")).join("\n");
  assert.ok(!/danger|bypass|full-access/i.test(source));
});

test("the Codex event schema fixture parses to session, progress, message and done", () => {
  const events = parseAll(codex, fixture("codex.jsonl"));
  assert.deepStrictEqual(events, [
    { type: "session", id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { type: "progress", text: "Ran ls" },
    { type: "message", text: "Done: added the test." },
    { type: "done", ok: true },
  ]);
  assert.strictEqual(codex.resumeCommand({ externalId: "x1" }), "codex exec resume x1");
  assert.strictEqual(codex.resumeCommand({}), "");
});

test("the Claude Code event schema fixture parses to session, progress, message and done", () => {
  const events = parseAll(claude, fixture("claude.jsonl"));
  assert.deepStrictEqual(events, [
    { type: "session", id: "6f1d2c0e-1111-4222-8333-444455556666" },
    { type: "progress", text: "Using Read" },
    { type: "message", text: "Done: added the test." },
    { type: "done", ok: true },
  ]);
  assert.strictEqual(claude.resumeCommand({ externalId: "s9" }), "claude --resume s9");
});

test("error events and malformed lines are handled", () => {
  assert.deepStrictEqual(codex.parse("not json"), []);
  assert.deepStrictEqual(codex.parse("42"), []);
  assert.deepStrictEqual(codex.parse(JSON.stringify({ type: "turn.failed", error: { message: "nope" } })), [
    { type: "error", message: "nope" },
    { type: "done", ok: false },
  ]);
  assert.deepStrictEqual(claude.parse(JSON.stringify({ type: "result", is_error: true, result: "auth" })), [
    { type: "error", message: "auth" },
    { type: "done", ok: false },
  ]);
});

test("resolveBinary prefers an explicit absolute path and refuses relative ones", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, process.platform === "win32" ? "tool.exe" : "tool");
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
  assert.deepStrictEqual(common.resolveBinary("tool", exe), { ok: true, path: exe });
  assert.strictEqual(common.resolveBinary("tool", "tool").ok, false);
  assert.strictEqual(common.resolveBinary("tool", "", { PATH: dir, PATHEXT: ".EXE" }).path, exe);
  assert.strictEqual(common.resolveBinary("missing", "", { PATH: dir }).ok, false);
});

test("a Windows .cmd shim is refused rather than run through a shell", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, "agent.cmd");
  fs.writeFileSync(shim, "@echo off\n", { mode: 0o755 });
  const res = common.resolveBinary("agent", shim);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /\.cmd/);
});

test("isToken rejects flag-like and path-like values", () => {
  assert.ok(common.isToken("sonnet"));
  assert.ok(!common.isToken("--model"));
  assert.ok(!common.isToken("a b"));
  assert.ok(!common.isToken(""));
});
