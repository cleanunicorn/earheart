// OpenAI Codex CLI adapter (#345): `codex exec --json` and `codex exec resume`.
// Verified against codex-cli 0.167. The session id is only known from the
// first `thread.started` event; the task stays "starting" until then. The
// event shapes are pinned by test/fixtures/agents and the opt-in real-agent
// check (test/agent-real.test.js).

const { parseJson } = require("./common");

// Permission modes map to Codex sandboxes. There is deliberately no
// danger-full-access option, and approvals are never bypassed.
const SANDBOX = { edit: "workspace-write", read: "read-only" };

module.exports = {
  id: "codex",
  label: "Codex",
  binary: "codex",
  models: [],
  idUpfront: false,

  start({ cwd, model, permission }) {
    const args = ["exec", "--json", "-C", cwd, "-s", SANDBOX[permission] || SANDBOX.edit];
    if (model) args.push("-m", model);
    // "-" makes Codex read the brief from stdin: never an argv string.
    args.push("-");
    return { args, stdin: true };
  },

  resume({ externalId, model, permission }) {
    // `resume` has no -s/-C: the sandbox goes through -c, the directory
    // through the spawn cwd.
    const args = ["exec", "resume", "--json", "-c", `sandbox_mode="${SANDBOX[permission] || SANDBOX.edit}"`];
    if (model) args.push("-m", model);
    args.push(externalId, "-");
    return { args, stdin: true };
  },

  parse(line) {
    const ev = parseJson(line);
    if (!ev) return [];
    switch (ev.type) {
      case "thread.started":
        return typeof ev.thread_id === "string" ? [{ type: "session", id: ev.thread_id }] : [];
      case "item.completed": {
        const item = ev.item || {};
        if (item.type === "agent_message" && typeof item.text === "string") return [{ type: "message", text: item.text }];
        if (item.type === "command_execution") return [{ type: "progress", text: `Ran ${String(item.command || "a command").slice(0, 120)}` }];
        if (item.type === "file_change") return [{ type: "progress", text: "Edited files" }];
        return [];
      }
      case "turn.completed":
        return [{ type: "done", ok: true }];
      case "turn.failed":
        return [{ type: "error", message: ev.error?.message || "The turn failed." }, { type: "done", ok: false }];
      case "error":
        return [{ type: "error", message: typeof ev.message === "string" ? ev.message : "The agent reported an error." }];
      default:
        return [];
    }
  },

  resumeCommand(task) {
    return task.externalId ? `codex exec resume ${task.externalId}` : "";
  },
};
