# Send a reviewed brief to a coding agent

Settings → History → **Send transcripts to coding agents** (off by default).
With it on, each History entry gets a **Send to agent…** button. It opens a
review form on that entry: edit the brief, pick the agent (Codex or Claude
Code, whichever is installed), optionally a model, and the project folder, then
press **Send**. Nothing is sent before that press, and ordinary dictation and
pasting are unchanged. Issue #345.

> **Privacy.** Speech recognition can stay on this computer, but the brief you
> send goes to the agent, and the agent's provider processes it off-device
> under that agent's own terms and sign-in. Earheart has no account or billing
> of its own for this.

## What you can do with a task

The **Agent tasks** list (above History) tracks each task Earheart started:

- **Status and progress:** Starting → Running (with the latest step) →
  Completed, Failed, Cancelled or Interrupted. A system notification names the
  agent and project when a task finishes or fails; it never contains the brief.
- **Cancel** stops the process Earheart started for that task.
- **Reply** continues the *same* agent session (not a new task) once the
  current turn has finished. A reply while the agent is still working is
  refused, and your text stays in the box.
- **Copy resume command** copies `cd <project> && <agent resume …>`, to continue
  in the agent's own terminal UI. Earheart does not launch a terminal.
- **Remove** forgets a finished task.

Tasks and replies survive closing the Settings window and restarting Earheart.
A task still running when Earheart quit is shown as **Interrupted** (the agent
may have finished; check it there) — Earheart no longer owns that process.

## Safety

| | |
| --- | --- |
| Launch | `spawn(binary, [argv…], { shell: false })`. The brief goes on stdin, never into a command line or shell string. The renderer cannot supply argv or a binary path. |
| Binary | Found on `PATH` in the main process, or an absolute path you set in Settings. Windows `.cmd` shims are refused; point Settings at the agent's `.exe`. |
| Project | Resolved with `realpath` in the main process; must be an existing directory. |
| Permissions | **Edit files in the project** (Codex `workspace-write`, Claude Code `acceptEdits`) or **Read only** (Codex `read-only`, Claude Code `plan`). There is no bypass or full-access option. |
| Double send | Each review form carries one idempotency key, stored with the task *before* the process is spawned. A repeated press, a replayed request, or a retry after a crash finds the existing task. |
| Failure | An auth or launch failure leaves the task `Failed` with the brief intact. |
| Storage | `agent-tasks.json` in the user data directory, mode 0600, at most 50 tasks, 8,000 characters of output each. Clear history deletes finished tasks (and cancels running ones); deleting a History entry deletes its tasks. Brief text is never logged. |

## Agent interfaces

Verified against Codex CLI 0.167 and Claude Code 2.1.319 (`--help`):

| | Start | Continue | Session id |
| --- | --- | --- | --- |
| Codex | `codex exec --json -C <dir> -s <sandbox> [-m model] -` | `codex exec resume --json -c sandbox_mode="…" <id> -` | read from the first `thread.started` event; no confirmation within 30 s fails the task and kills the process |
| Claude Code | `claude -p --output-format stream-json --verbose --permission-mode <mode> --session-id <uuid> [--model m]` | `… --resume <uuid>` | chosen by Earheart before launch |

The event shapes are pinned by `test/fixtures/agents/*.jsonl` and re-checked
against the real CLIs by the opt-in test below. A CLI that changes its output
format fails that check instead of silently mis-tracking tasks.

## Tests

- `node --test test/agent-tasks.test.js` — lifecycle with a fake agent process:
  success, auth failure, launch error, start timeout, cancel (including while
  starting and past an ignored SIGTERM), restart and idempotency, reply and
  resume, path and allowlist validation, retention.
- `node --test test/agents.test.js` — argv shapes (no brief in argv, no bypass
  flags), event fixtures, binary resolution.
- `node --test test/agent-api.test.js` — inert when disabled, lazy start,
  sender restrictions, no argv from the renderer.
- Real agents (opt-in; uses your sign-in and makes one tiny request):
  `EARHEART_REAL_AGENT=codex node --test test/agent-real.test.js`, or `=claude`.
