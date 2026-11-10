// Validation for user-configured MCP servers. A hand-edited tools.json is
// untrusted input: everything is re-validated on load, not just on save.
// No shell is ever involved: `command` is spawned directly with `args`.

const fs = require("node:fs");
const path = require("node:path");

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Variables that make a child load attacker-chosen code or alter its
// resolution: refused outright rather than passed through.
const BLOCKED_ENV = /^(LD_.*|DYLD_.*|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|ELECTRON_RUN_AS_NODE|BASH_ENV|ENV|PATH)$/i;
const MAX_ARGS = 64;
const MAX_STR = 4096;
const MAX_ENV = 32;
const MAX_SERVERS = 16;
const WINDOWS_SHIM = /\.(cmd|bat)$/i;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cleanString = (s) => typeof s === "string" && !s.includes("\0") && s.length <= MAX_STR;

// Normalize one server entry. Returns { server } or { errors }.
// Env entries are { value, secret }. Secret values are held in memory only
// here; store.js decides how they reach disk.
function validateServer(raw, { platform = process.platform, exists = defaultExists } = {}) {
  const errors = [];
  if (!isPlain(raw)) return { errors: ["server must be an object"] };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!ID.test(id)) errors.push("id must be 1-40 lowercase letters, digits or dashes");
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
  if (!name) errors.push("name is required");
  const command = raw.command;
  if (!cleanString(command) || command.trim() === "") errors.push("command is required");
  else if (platform === "win32" && WINDOWS_SHIM.test(command.trim())) {
    errors.push("point at the real executable (node, python, an .exe), not a .cmd/.bat shim such as npx.cmd");
  }
  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every(cleanString)) errors.push("args must be a list of up to 64 strings without NUL bytes");
  const cwd = raw.cwd ?? "";
  if (cwd !== "") {
    if (!cleanString(cwd) || !path.isAbsolute(cwd)) errors.push("cwd must be an absolute path");
    else if (!exists(cwd, "dir")) errors.push("cwd must be an existing directory");
  }
  const env = {};
  const rawEnv = raw.env ?? {};
  if (!isPlain(rawEnv)) errors.push("env must be an object");
  else {
    const keys = Object.keys(rawEnv);
    if (keys.length > MAX_ENV) errors.push("too many environment variables");
    for (const key of keys) {
      const entry = rawEnv[key];
      if (!ENV_KEY.test(key)) { errors.push(`env key "${key.slice(0, 40)}" is invalid`); continue; }
      if (BLOCKED_ENV.test(key)) { errors.push(`env key ${key} is not allowed`); continue; }
      const value = isPlain(entry) ? entry.value : entry;
      const secret = isPlain(entry) ? entry.secret === true : false;
      if (typeof value !== "string" || value.includes("\0") || value.length > MAX_STR) { errors.push(`env ${key} must be a string`); continue; }
      env[key] = { value, secret };
    }
  }
  if (errors.length) return { errors };
  return {
    server: { id, name, enabled: raw.enabled === true, command: command.trim(), args: [...args], cwd, env },
  };
}

function defaultExists(p, kind) {
  try {
    const st = fs.statSync(p);
    return kind === "dir" ? st.isDirectory() : st.isFile();
  } catch {
    return false;
  }
}

// Validate a list: invalid and duplicate entries are dropped with a reason.
function validateServers(list, opts) {
  const servers = [];
  const rejected = [];
  const seen = new Set();
  if (!Array.isArray(list)) return { servers, rejected: [] };
  for (const raw of list.slice(0, MAX_SERVERS)) {
    const res = validateServer(raw, opts);
    if (res.errors) rejected.push({ id: typeof raw?.id === "string" ? raw.id.slice(0, 40) : "", errors: res.errors });
    else if (seen.has(res.server.id)) rejected.push({ id: res.server.id, errors: ["duplicate id"] });
    else { seen.add(res.server.id); servers.push(res.server); }
  }
  return { servers, rejected };
}

// What the renderer may see: secret values never leave main.
function publicServer(server) {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
    env: Object.fromEntries(
      Object.entries(server.env).map(([k, e]) => [k, e.secret ? { secret: true, set: e.value !== "" } : { secret: false, value: e.value }])
    ),
  };
}

// Replace secret values in text with a marker (for errors that quote stderr).
function redact(text, server) {
  let out = String(text);
  for (const e of Object.values(server?.env ?? {})) {
    if (e.secret && e.value.length >= 4) out = out.split(e.value).join("[redacted]");
  }
  return out;
}

module.exports = { validateServer, validateServers, publicServer, redact, MAX_SERVERS };
