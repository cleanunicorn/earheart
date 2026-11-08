// Shared helpers for agent adapters (#345): resolving a binary in main, and
// validating a project directory. Plain Node — no electron import.
//
// An adapter describes one installed coding agent CLI. It never sees a shell:
// it returns an argv array and the prompt text, and the task store spawns the
// binary with { shell: false } and writes the prompt to stdin.
//
// Adapter contract:
//   id, label            stable id ("codex", "claude") and display name
//   binary               default executable name looked up on PATH
//   models               allowlist of model ids the UI may offer ([] = the
//                        agent's own default only)
//   idUpfront            true when the session id is chosen before launch
//   newSessionId()       (idUpfront only) a fresh id
//   start({ prompt, cwd, model, permission, sessionId }) -> { args, input }
//   resume({ externalId, prompt, cwd, model, permission }) -> { args, input }
//   parse(line)          one stdout line -> events: { type: "session", id } |
//                        { type: "progress", text } | { type: "message", text } |
//                        { type: "error", message } | { type: "done", ok }
//   resumeCommand(task)  a command line the user can run themselves

const fs = require("node:fs");
const path = require("node:path");

const MAX_BRIEF = 50_000;

// An agent id or model string from the renderer must be a plain token, never
// something that could read as a flag.
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

function isToken(value) {
  return typeof value === "string" && TOKEN.test(value);
}

// Resolve a project directory: absolute, real, existing, a directory. A path
// whose first character is "-" is rejected outright — it is never absolute,
// and must never reach a CLI as if it were a flag.
function validateProject(input) {
  if (typeof input !== "string" || !input || input.includes("\0") || input.startsWith("-")) {
    return { ok: false, error: "Choose a project folder." };
  }
  if (!path.isAbsolute(input)) return { ok: false, error: "The project folder must be an absolute path." };
  let real;
  try {
    real = fs.realpathSync(input);
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: "The project path is not a folder." };
  } catch {
    return { ok: false, error: "The project folder does not exist." };
  }
  return { ok: true, path: real };
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Find the executable for `name`: the user's own absolute path if set (from
// Settings, never from a task request), else PATH. Windows .cmd/.bat shims are
// refused: running one needs a shell, and the brief must never reach one.
function resolveBinary(name, userPath = "", env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  let candidates;
  if (userPath) {
    if (!path.isAbsolute(userPath)) return { ok: false, reason: "The agent path must be absolute." };
    candidates = [userPath];
  } else {
    const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
    candidates = dirs.flatMap((dir) => exts.map((ext) => path.join(dir, name + ext.toLowerCase())));
  }
  for (const file of candidates) {
    if (!isExecutable(file)) continue;
    if (/\.(cmd|bat)$/i.test(file)) {
      return { ok: false, reason: "Windows .cmd shims can't be launched safely. Set the path to the agent's .exe in Settings." };
    }
    return { ok: true, path: file };
  }
  return { ok: false, reason: `${name} was not found.` };
}

function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

module.exports = { MAX_BRIEF, isToken, validateProject, resolveBinary, parseJson };
