// Claude Code adapter (#345): `claude -p --output-format stream-json`. Verified
// against Claude Code 2.1.319. The session id is chosen up front with
// --session-id, so a task's identity is known before launch.

const crypto = require("node:crypto");
const { parseJson } = require("./common");

// Permission modes map to Claude Code's. bypassPermissions is never used.
const MODE = { edit: "acceptEdits", read: "plan" };

function common({ model, permission }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", MODE[permission] || MODE.edit];
  if (model) args.push("--model", model);
  return args;
}

module.exports = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  models: ["opus", "sonnet", "haiku"],
  idUpfront: true,
  newSessionId: () => crypto.randomUUID(),

  // The prompt is the stdin; claude -p reads it when no prompt argument is given.
  start({ model, permission, sessionId }) {
    return { args: [...common({ model, permission }), "--session-id", sessionId], stdin: true };
  },

  resume({ externalId, model, permission }) {
    return { args: [...common({ model, permission }), "--resume", externalId], stdin: true };
  },

  parse(line) {
    const ev = parseJson(line);
    if (!ev) return [];
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      return [{ type: "session", id: ev.session_id }];
    }
    if (ev.type === "assistant") {
      const parts = Array.isArray(ev.message?.content) ? ev.message.content : [];
      const out = [];
      for (const part of parts) {
        if (part?.type === "text" && typeof part.text === "string") out.push({ type: "message", text: part.text });
        else if (part?.type === "tool_use") out.push({ type: "progress", text: `Using ${String(part.name || "a tool").slice(0, 60)}` });
      }
      return out;
    }
    if (ev.type === "result") {
      if (ev.is_error) {
        return [{ type: "error", message: typeof ev.result === "string" ? ev.result : "The agent reported an error." }, { type: "done", ok: false }];
      }
      return [{ type: "done", ok: true }];
    }
    return [];
  },

  resumeCommand(task) {
    return task.externalId ? `claude --resume ${task.externalId}` : "";
  },
};
