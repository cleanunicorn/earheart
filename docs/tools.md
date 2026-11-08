# Local tool servers (MCP client)

Earheart can act as a client of **local MCP servers over stdio** that you
configure yourself (issue #346). This is the opposite direction from an
Earheart MCP server: Earheart calls your tools, it does not expose itself to
agents.

> **Status.** The client, policy, approval window and Settings card ship now.
> **Nothing calls these tools from your voice yet:** that needs voice command
> mode (#344), which is not merged. Until then the only way to run a tool is the
> internal `tools.host` seam (`main/tools/index.js`), used by tests and the
> smoke check. The Settings card says so too.

## Add a server

Settings → Advanced → **Tools**.

| Field | Meaning |
| --- | --- |
| Command | An executable, run directly. **No shell**: no pipes, quotes or `&&`. |
| Arguments | One per line. |
| Working directory | Optional, absolute, must exist. |
| Environment | `KEY=value` per line. Start a line with `!` to store the value as a secret. |

Example (a server you wrote or installed yourself):

```
Command:    node
Arguments:  /home/me/tools/my-mcp-server/index.js
```

On **Windows** use the real executable (`node`, `python`, an `.exe`). `.cmd` and
`.bat` shims such as `npx.cmd` are rejected: modern Node refuses to spawn them
without a shell, and Earheart never falls back to one.

Then press **Discover tools**. This **starts the program you configured**, runs
the MCP handshake and lists its tools. Servers are never started at app launch;
they start on Discover or on the first call (a call, or listing the catalog, discovers an enabled server that hasn't been listed since the app started), and stop after five idle minutes or
when you quit.

## Per-tool control

Every discovered tool starts **disabled** with policy **Ask each time**.

- **Enabled** off → the tool is absent from what a model may be offered, and
  can never run.
- **Deny** always wins over enabled.
- **Ask each time** → an approval window appears for that exact call, showing
  the server, tool and arguments. Approval is single-use, bound to those
  arguments, and expires after 60 seconds. Closing the window, quitting, or
  removing/editing the server denies it.
- **Always allow** → runs without asking (arguments are still schema-checked).

Policies are keyed by server + tool name + a hash of the tool's input schema. If
a server changes a tool's schema, the tool returns to disabled/ask until you
re-enable it. Policy is re-checked after approval, right before the call.

Text in the approval window (server, tool, description, arguments) is supplied
by the server and is labelled as such; Earheart cannot verify it.

## Limits and safety

- Startup, list and call each have timeouts (10 s / 10 s / 30 s); a timeout or
  abort sends `notifications/cancelled`. At most 4 calls are in flight.
- The child gets a **minimal environment** (PATH, HOME, temp dirs, locale) plus
  only the variables you configured. `LD_*`, `DYLD_*`, `NODE_OPTIONS`,
  `PYTHONPATH`, `PATH` and similar loader variables are rejected in the form.
- On quit, owned processes (and their process group / tree) are killed with a
  2.5 s deadline. A server that crashes three times in a minute is paused.
- Arguments are validated against the tool's JSON Schema before anything is
  shown or sent. Only a small subset is understood (types, enum, required,
  properties, items, min/max, additionalProperties). A tool whose schema uses
  anything else (`$ref`, `oneOf`, `pattern`, …) is **unavailable**, not
  guessed at. Arguments over 64 KB, or with `__proto__`-style keys, are refused.
- Tool results are treated as **untrusted data**: control characters and ANSI
  are stripped, text is capped at 8,000 characters, non-text content is
  omitted, and the text a model would see is wrapped as quoted data.
- Secret environment values are never sent to the Settings page (it sees only
  "set"), never written to logs, and redacted from error text. They are encrypted
  with the OS secure storage where it exists (same rule as API keys); otherwise
  they sit in `tools.json` (owner-only) and Settings says so.
- `tools.json` lives beside `settings.json` and is treated as untrusted on load:
  invalid servers are dropped.

## Not in this version

Remote (HTTP) transports, resources/prompts/sampling, bundled web/research
servers, and scaffold/import helpers. A server's sampling, roots and elicitation
requests are refused with a JSON-RPC error.

## Why no MCP SDK

`@modelcontextprotocol/sdk` pulls in a large transitive tree (schema,
HTTP/express, auth) for a feature that needs `initialize`, `tools/list`,
`tools/call` and cancellation over newline-delimited stdio. Earheart keeps two
runtime dependencies, so the client in `main/tools/client.js` is ~250 lines.

## Real-OS acceptance

Unit tests and `make approval-smoke` run on every CI platform. The test that a
server's child process dies with it asserts on POSIX (process-group kill:
Linux, macOS) and is skipped on Windows, where `taskkill /T /F` needs a manual
check with a server that spawns children.
