// A minimal MCP client over stdio (tools only): newline-delimited JSON-RPC 2.0.
// One instance owns one child process. Hand-rolled on purpose (see
// docs/tools.md): the official SDK would triple the runtime dependency tree.
//
// Safety properties, each covered by test/tools-client.test.js:
//   - spawn(command, args, { shell: false }) with a minimal environment
//   - strict response matching (unknown/duplicate ids ignored)
//   - bounded line length, stderr tail, pending calls, call and startup time
//   - server-initiated requests are refused (-32601), notifications ignored
//   - timeout/abort sends notifications/cancelled and rejects promptly
//   - close() kills the whole process group/tree, bounded

const { spawn: nodeSpawn, execFile } = require("node:child_process");

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_LINE = 1024 * 1024;
const MAX_STDERR = 4096;
const MAX_TOOLS = 200;
const MAX_PAGES = 10;
const BASE_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA", "USER", "LOGNAME"];

const DEFAULTS = { startupMs: 10000, callMs: 30000, listMs: 10000, maxPending: 4, killGraceMs: 1500 };

class ToolError extends Error {
  constructor(code, message) { super(message); this.name = "ToolError"; this.code = code; }
}

function minimalEnv(server, base = process.env) {
  const env = {};
  for (const key of BASE_ENV_KEYS) if (typeof base[key] === "string") env[key] = base[key];
  for (const [key, entry] of Object.entries(server.env ?? {})) env[key] = entry.value;
  return env;
}

function killTree(child, { platform = process.platform, graceMs = DEFAULTS.killGraceMs, exec = execFile } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(hard); resolve(); } };
    child.once("exit", finish);
    const hard = setTimeout(() => {
      try { platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      setTimeout(finish, 200);
    }, graceMs);
    hard.unref?.();
    try {
      if (platform === "win32") exec("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  });
}

function createClient(server, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const spawnFn = opts.spawn ?? nodeSpawn;
  const platform = opts.platform ?? process.platform;

  let child = null;
  let nextId = 1;
  let buffer = "";
  let stderrTail = "";
  let closed = false;
  let ready = false;
  let exitInfo = null;
  let dead = false; // protocol violation or exit: never reuse this process
  const pending = new Map(); // id -> { resolve, reject, timer, method }
  const stats = { ignoredResponses: 0, refusedRequests: 0, protocolErrors: 0 };
  const exitListeners = new Set();

  const failAll = (err) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(err); }
  };

  const write = (msg) => {
    if (!child || !child.stdin.writable) throw new ToolError("closed", "server is not running");
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  const protocolFatal = (why) => {
    stats.protocolErrors++;
    dead = true;
    const err = new ToolError("protocol", why);
    failAll(err);
    killTree(child, { platform, graceMs: opts.killGraceMs });
  };

  function onLine(text) {
    if (text.trim() === "") return;
    let msg;
    try { msg = JSON.parse(text); } catch { stats.protocolErrors++; return; } // stray non-JSON output is ignored
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") { stats.protocolErrors++; return; }
    const hasId = Object.hasOwn(msg, "id");
    if (typeof msg.method === "string") {
      // A request from the server (sampling, roots, elicitation...) is refused;
      // a notification is ignored.
      if (hasId && (typeof msg.id === "number" || typeof msg.id === "string")) {
        stats.refusedRequests++;
        try { write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported by this client" } }); } catch { /* closing */ }
      }
      return;
    }
    if (!hasId || typeof msg.id !== "number") { stats.ignoredResponses++; return; }
    const p = pending.get(msg.id);
    if (!p) { stats.ignoredResponses++; return; } // unknown, late or duplicate
    const hasResult = Object.hasOwn(msg, "result");
    const hasError = Object.hasOwn(msg, "error");
    if (hasResult === hasError) { stats.protocolErrors++; return; } // malformed: keep waiting for the real one
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (hasError) {
      const e = msg.error;
      p.reject(new ToolError("server", typeof e?.message === "string" ? e.message : "server error"));
    } else p.resolve(msg.result);
  }

  function onStdout(chunk) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const text = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (text.length > MAX_LINE) { protocolFatal("server sent an oversized message"); buffer = ""; return; }
      onLine(text);
    }
    if (buffer.length > MAX_LINE) { buffer = ""; protocolFatal("server sent an oversized message"); }
  }

  function request(method, params, { timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (closed || !child || dead) return reject(new ToolError("closed", "server is not running"));
      if (signal?.aborted) return reject(new ToolError("cancelled", "cancelled"));
      if (pending.size >= opts.maxPending && method === "tools/call") return reject(new ToolError("busy", "too many tool calls in flight"));
      const id = nextId++;
      let onAbort = null;
      const settle = (fn) => (v) => { signal?.removeEventListener("abort", onAbort); fn(v); };
      const cancel = (code, message) => {
        if (!pending.has(id)) return;
        const p = pending.get(id);
        pending.delete(id);
        clearTimeout(p.timer);
        try { write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: message } }); } catch { /* closing */ }
        p.reject(new ToolError(code, message));
      };
      const timer = setTimeout(() => cancel("timeout", `${method} timed out after ${timeoutMs} ms`), timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer, method });
      if (signal) { onAbort = () => cancel("cancelled", "cancelled"); signal.addEventListener("abort", onAbort, { once: true }); }
      try { write({ jsonrpc: "2.0", id, method, params }); } catch (err) { cancel("closed", err.message); }
    });
  }

  function spawnChild() {
    child = spawnFn(server.command, server.args, {
      cwd: server.cwd || undefined,
      env: minimalEnv(server, opts.baseEnv),
      shell: false,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-MAX_STDERR); });
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      exitInfo = { code: null, signal: null, spawnError: err.code ?? err.message };
      failAll(new ToolError("spawn", err.code === "ENOENT" ? `command not found: ${server.command}` : `could not start: ${err.code ?? err.message}`));
    });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      ready = false;
      dead = true;
      const err = new ToolError("exited", `server exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ""}`);
      err.stderr = stderrTail;
      failAll(err);
      for (const fn of exitListeners) fn(exitInfo);
    });
  }

  async function start(signal) {
    if (ready) return;
    if (closed) throw new ToolError("closed", "server was shut down");
    if (!child) spawnChild();
    try {
      const result = await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "earheart", version: "1" },
      }, { timeoutMs: opts.startupMs, signal });
      if (typeof result?.protocolVersion !== "string" || !SUPPORTED_VERSIONS.has(result.protocolVersion)) {
        throw new ToolError("protocol", `unsupported protocol version ${String(result?.protocolVersion).slice(0, 20)}`);
      }
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      ready = true;
    } catch (err) {
      await close();
      throw err;
    }
  }

  async function listTools(signal) {
    await start(signal);
    const tools = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await request("tools/list", cursor ? { cursor } : {}, { timeoutMs: opts.listMs, signal });
      for (const t of Array.isArray(res?.tools) ? res.tools : []) {
        if (tools.length >= MAX_TOOLS) break;
        if (typeof t?.name !== "string" || t.name === "" || t.name.length > 128) continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description.slice(0, 1000) : "",
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" },
        });
      }
      cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
      if (!cursor || tools.length >= MAX_TOOLS) break;
    }
    return tools;
  }

  async function callTool(name, args, { signal, timeoutMs } = {}) {
    await start(signal);
    return request("tools/call", { name, arguments: args }, { timeoutMs: timeoutMs ?? opts.callMs, signal });
  }

  async function close() {
    if (closed && !child) return;
    closed = true;
    failAll(new ToolError("closed", "server was shut down"));
    const c = child;
    child = null;
    ready = false;
    try { c?.stdin.end(); } catch { /* ignore */ }
    await killTree(c, { platform, graceMs: opts.killGraceMs });
  }

  return {
    start, listTools, callTool, close,
    get dead() { return dead; },
    get running() { return Boolean(child) && ready; },
    get pid() { return child?.pid ?? null; },
    get stderr() { return stderrTail; },
    get exitInfo() { return exitInfo; },
    stats,
    onExit(fn) { exitListeners.add(fn); return () => exitListeners.delete(fn); },
    // Allow re-use after a crash (manager decides, with backoff).
    reset() { if (!child) { dead = false; closed = false; buffer = ""; stderrTail = ""; exitInfo = null; } },
  };
}

module.exports = { createClient, killTree, minimalEnv, ToolError, PROTOCOL_VERSION };
