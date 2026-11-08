// Owned agent task lifecycle (#345): a reviewed brief is sent to an installed
// coding agent CLI, and Earheart tracks the task it started — status, progress,
// cancellation, and replies that continue the same agent session.
//
// Plain Node (no electron import) so the lifecycle is testable with a fake
// agent process. The caller supplies the file, the adapters and a binary
// resolver.
//
// Guarantees:
//   - One send, one task. Every send carries an idempotency key; the task is
//     written to disk as "starting" BEFORE the process is spawned, so a
//     repeated activation — or a retry after a crash — returns the same task
//     instead of launching a second one.
//   - The brief is always kept on the task record, so a launch or auth
//     failure never loses it.
//   - Processes are spawned with { shell: false } and the brief on stdin.
//   - Tasks left "starting"/"running" by a previous run become "interrupted"
//     when the store loads: Earheart no longer owns a process for them.
//   - Brief text and agent output are never logged.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");
const common = require("./agents/common");

const ACTIVE = new Set(["starting", "running"]);
const MAX_TASKS = 50;
const MAX_OUTPUT = 8_000; // characters of agent output kept per task
const MAX_PROGRESS = 200;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      // Kill the whole tree; argv array, no shell.
      nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore", windowsHide: true });
    } else if (child.pid) {
      process.kill(-child.pid, signal); // the child leads its own process group
    }
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function createTaskStore({
  file,
  adapters,
  resolveBinary = (adapter) => common.resolveBinary(adapter.binary),
  getPermission = () => "edit",
  spawn = nodeSpawn,
  logger = { warn() {} },
  onChange = () => {},
  onFinished = () => {},
  startTimeoutMs = 30_000,
  killGraceMs = 3_000,
  now = () => new Date().toISOString(),
} = {}) {
  let tasks = [];
  const live = new Map(); // task id -> { child, cancelled, timer }

  function adapterFor(id) {
    return adapters.find((adapter) => adapter.id === id) || null;
  }

  /* ---- Persistence ---- */

  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      logger.warn("agent tasks write failed:", err.code || err.message);
      return false;
    }
  }

  function valid(row) {
    return row && typeof row === "object" && typeof row.id === "string" && typeof row.brief === "string" &&
      typeof row.agent === "string" && typeof row.project === "string" && typeof row.status === "string";
  }

  // Load saved tasks. Any that were active belong to a process this run does
  // not own: mark them interrupted, never "running".
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      tasks = Array.isArray(parsed) ? parsed.filter(valid) : [];
    } catch {
      tasks = [];
    }
    let changed = false;
    for (const task of tasks) {
      if (ACTIVE.has(task.status)) {
        task.status = "interrupted";
        task.error = task.externalId
          ? "Earheart restarted while this task was running. It may have finished; check it in the agent."
          : "Earheart restarted before the agent confirmed this task. It may have started; check the agent before sending again.";
        task.updatedAt = now();
        changed = true;
      }
    }
    if (changed) persist();
  }

  function touch(task, patch) {
    Object.assign(task, patch, { updatedAt: now() });
    persist();
    onChange(view(task));
  }

  function view(task) {
    const adapter = adapterFor(task.agent);
    return {
      id: task.id,
      agent: task.agent,
      agentLabel: adapter?.label || task.agent,
      project: task.project,
      brief: task.brief,
      model: task.model || "",
      historyId: task.historyId || null,
      status: task.status,
      error: task.error || "",
      progress: task.progress || "",
      output: task.output || "",
      turns: (task.turns || []).length,
      externalId: task.externalId || "",
      resumeCommand: adapter?.resumeCommand?.(task) || "",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  function prune() {
    if (tasks.length <= MAX_TASKS) return;
    const keep = [];
    let drop = tasks.length - MAX_TASKS;
    // tasks are newest-first: drop the oldest finished ones.
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (drop > 0 && !ACTIVE.has(tasks[i].status)) drop--;
      else keep.unshift(tasks[i]);
    }
    tasks = keep;
  }

  /* ---- Running a turn ---- */

  function clearTimer(entry) {
    if (entry?.timer) clearTimeout(entry.timer);
  }

  function finish(task, status, error = "") {
    const entry = live.get(task.id);
    clearTimer(entry);
    live.delete(task.id);
    touch(task, { status, error, progress: status === "completed" ? "" : task.progress });
    onFinished(view(task));
  }

  function launch(task, adapter, plan, cwdForSpawn) {
    const bin = resolveBinary(adapter, task);
    if (!bin?.ok) {
      finish(task, "failed", bin?.reason || `${adapter.label} was not found.`);
      return;
    }
    let child;
    try {
      child = spawn(bin.path, plan.args, {
        cwd: cwdForSpawn,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      finish(task, "failed", `Could not start ${adapter.label} (${err.code || "error"}).`);
      return;
    }
    const entry = { child, cancelled: false, timer: null, stderr: "", buffer: "", sawDone: false, sawError: "" };
    live.set(task.id, entry);

    // A turn that never confirms its session (Codex waits on thread.started)
    // must not sit in "starting" forever.
    if (!task.externalId) {
      entry.timer = setTimeout(() => {
        if (live.get(task.id) !== entry || task.externalId) return;
        entry.timedOut = true;
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), killGraceMs).unref?.();
        finish(task, "failed", `${adapter.label} did not start within ${Math.round(startTimeoutMs / 1000)} seconds.`);
      }, startTimeoutMs);
      entry.timer.unref?.();
    }

    child.stdin.on("error", () => { /* the process may exit before reading */ });
    if (plan.stdin) child.stdin.end(plan.input);

    const handle = (line) => {
      if (!line.trim() || live.get(task.id) !== entry) return;
      for (const ev of adapter.parse(line)) {
        if (ev.type === "session") {
          clearTimer(entry);
          // A session id chosen up front (Claude) is kept; otherwise adopt it.
          touch(task, { externalId: task.externalId || ev.id, status: "running" });
        } else if (ev.type === "progress") {
          touch(task, { progress: String(ev.text).slice(0, MAX_PROGRESS) });
        } else if (ev.type === "message") {
          touch(task, { output: `${task.output || ""}${task.output ? "\n\n" : ""}${ev.text}`.slice(-MAX_OUTPUT) });
        } else if (ev.type === "error") {
          entry.sawError = String(ev.message).slice(0, 500);
        } else if (ev.type === "done") {
          entry.sawDone = ev.ok;
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      entry.buffer += chunk;
      let i;
      while ((i = entry.buffer.indexOf("\n")) !== -1) {
        handle(entry.buffer.slice(0, i));
        entry.buffer = entry.buffer.slice(i + 1);
      }
      if (entry.buffer.length > 1_000_000) entry.buffer = "";
    });
    child.stderr.on("data", (chunk) => { entry.stderr = (entry.stderr + chunk).slice(-1_000); });
    child.on("error", (err) => {
      if (live.get(task.id) !== entry) return;
      finish(task, "failed", `Could not start ${adapter.label} (${err.code || "error"}).`);
    });
    child.on("close", (code) => {
      if (live.get(task.id) !== entry) return; // already settled (timeout, spawn error)
      handle(entry.buffer);
      if (entry.cancelled) return finish(task, "cancelled");
      if (code === 0 && entry.sawDone !== false && !entry.sawError) return finish(task, "completed");
      const detail = entry.sawError || entry.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
      finish(task, "failed", detail || `${adapter.label} exited with code ${code}.`);
    });
  }

  /* ---- Public API ---- */

  // Start a task. Returns { ok: true, task, duplicate } or { ok: false, error }.
  // A failed validation creates nothing; a failed launch still returns the
  // saved task (status "failed", brief intact).
  function submit({ key, agent, project, brief, model = "", historyId = null }) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return { ok: false, error: "The send request is malformed." };
    const existing = tasks.find((task) => task.key === key);
    if (existing) return { ok: true, task: view(existing), duplicate: true };

    const adapter = adapterFor(agent);
    if (!adapter) return { ok: false, error: "Unknown agent." };
    if (typeof brief !== "string" || !brief.trim()) return { ok: false, error: "The brief is empty." };
    if (brief.length > common.MAX_BRIEF) return { ok: false, error: "The brief is too long to send." };
    if (model && !adapter.models.includes(model)) return { ok: false, error: "That model isn't offered for this agent." };
    const dir = common.validateProject(project);
    if (!dir.ok) return { ok: false, error: dir.error };

    const task = {
      id: crypto.randomUUID(),
      key,
      agent: adapter.id,
      project: dir.path,
      brief,
      model: model || "",
      historyId: typeof historyId === "string" ? historyId : null,
      status: "starting",
      error: "",
      progress: "",
      output: "",
      externalId: adapter.idUpfront ? adapter.newSessionId() : "",
      turns: [{ at: now(), prompt: brief }],
      createdAt: now(),
      updatedAt: now(),
    };
    tasks.unshift(task);
    prune();
    // Written before the spawn: a crash from here on leaves an interrupted
    // task that the same key finds again, never a duplicate launch.
    if (!persist()) {
      tasks = tasks.filter((t) => t !== task);
      return { ok: false, error: "Couldn't save the task, so it was not sent." };
    }
    onChange(view(task));
    const plan = adapter.start({ prompt: brief, cwd: task.project, model: task.model, permission: getPermission(), sessionId: task.externalId });
    launch(task, adapter, { ...plan, input: brief }, task.project);
    return { ok: true, task: view(task), duplicate: false };
  }

  // Continue the same agent session with another message. A reply while a
  // turn is still running is rejected ("busy"), not queued, and the caller
  // keeps the text. Any failure leaves the reply text with the caller.
  function reply(id, text) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { ok: false, error: "That task no longer exists." };
    const adapter = adapterFor(task.agent);
    if (!adapter) return { ok: false, error: "Unknown agent." };
    if (ACTIVE.has(task.status) || live.has(task.id)) return { ok: false, error: "The agent is still working. Reply when this turn finishes." };
    if (!task.externalId) return { ok: false, error: "This task has no session to continue." };
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "The reply is empty." };
    if (text.length > common.MAX_BRIEF) return { ok: false, error: "The reply is too long to send." };
    const dir = common.validateProject(task.project);
    if (!dir.ok) return { ok: false, error: dir.error };
    task.turns = [...(task.turns || []), { at: now(), prompt: text }];
    // The session id is known already, so there is no start timeout.
    touch(task, { status: "running", error: "", progress: "" });
    const plan = adapter.resume({ externalId: task.externalId, prompt: text, cwd: dir.path, model: task.model, permission: getPermission() });
    launch(task, adapter, { ...plan, input: text }, dir.path);
    return { ok: true, task: view(task) };
  }

  // Cancel the process this store owns for the task, including one that has
  // not reported its session id yet.
  function cancel(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { ok: false, error: "That task no longer exists." };
    const entry = live.get(task.id);
    if (!entry) return { ok: false, error: "Earheart isn't running this task." };
    entry.cancelled = true;
    killTree(entry.child, "SIGTERM");
    setTimeout(() => killTree(entry.child, "SIGKILL"), killGraceMs).unref?.();
    // Don't wait on a process that ignores the signal to tell the user.
    return { ok: true, task: view(task) };
  }

  function get(id) {
    const task = tasks.find((t) => t.id === id);
    return task ? view(task) : null;
  }

  function list() {
    return tasks.map(view);
  }

  // Forget one finished task (active ones must be cancelled first).
  function remove(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return { ok: true, removed: false };
    if (ACTIVE.has(task.status)) return { ok: false, error: "Cancel the task before removing it." };
    tasks = tasks.filter((t) => t !== task);
    if (!persist()) return { ok: false, error: "Couldn't update the saved tasks." };
    onChange(null);
    return { ok: true, removed: true };
  }

  // Tasks made from a History entry go with it.
  function removeForHistory(historyId) {
    const ids = tasks.filter((t) => t.historyId === historyId && !ACTIVE.has(t.status)).map((t) => t.id);
    ids.forEach(remove);
  }

  // Clear history also clears finished tasks (their briefs are transcript
  // text). Active tasks are cancelled and removed once they settle.
  function clear() {
    for (const task of tasks) if (ACTIVE.has(task.status)) cancel(task.id);
    tasks = tasks.filter((t) => ACTIVE.has(t.status));
    const ok = persist();
    onChange(null);
    return ok ? { ok: true } : { ok: false, error: "EIO" };
  }

  // Stop everything this store owns (app quit).
  function shutdown() {
    for (const [id, entry] of live) {
      entry.cancelled = true;
      killTree(entry.child, "SIGTERM");
      clearTimer(entry);
    }
  }

  function hasLive() {
    return live.size > 0;
  }

  load();
  return { submit, reply, cancel, get, list, remove, removeForHistory, clear, shutdown, hasLive };
}

module.exports = { createTaskStore, ACTIVE };
