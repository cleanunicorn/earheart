// The handlers behind the agent:* IPC channels (#345). Dependencies are
// injected so the behaviour is testable under plain node, and so that nothing
// — no task store, no process, no binary lookup — exists until the user has
// turned "Send to agents" on and uses it.
//
// The renderer only ever supplies: an agent id and model (checked against the
// adapter allowlists in the store), a project path (validated in main), the
// brief text, and task ids. Argv and binary paths are never accepted from it.

const path = require("node:path");

const PERMISSIONS = new Set(["edit", "read"]);
const DETECT_TTL_MS = 60_000;
const DISABLED = { ok: false, error: "Send to agents is turned off in Settings." };

function createAgentApi({ getSettings, createStore, detectAll, pickFolder, copyText, validateProject, now = Date.now }) {
  let store = null;
  let detected = null; // { at, key, value }

  const config = () => {
    const agents = getSettings().agents || {};
    return {
      enabled: agents.enabled === true,
      permission: PERMISSIONS.has(agents.permission) ? agents.permission : "edit",
      binaries: agents.binaries && typeof agents.binaries === "object" ? agents.binaries : {},
    };
  };

  function getStore() {
    if (!store) store = createStore({ getConfig: config });
    return store;
  }

  async function detect() {
    const { binaries } = config();
    const key = JSON.stringify(binaries);
    if (detected && detected.key === key && now() - detected.at < DETECT_TTL_MS) return detected.value;
    const value = await detectAll(binaries);
    detected = { at: now(), key, value };
    return value;
  }

  const guard = (fn) => async (...args) => {
    if (!config().enabled) return DISABLED;
    try {
      return await fn(...args);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  function recentProjects(tasks) {
    const seen = new Set();
    const out = [];
    for (const task of tasks) {
      if (seen.has(task.project)) continue;
      seen.add(task.project);
      if (validateProject(task.project).ok) out.push(task.project);
      if (out.length >= 8) break;
    }
    return out;
  }

  return {
    enabled: () => config().enabled,
    started: () => store !== null,
    shutdown: () => store?.shutdown(),
    clearTasks: () => (store || config().enabled ? getStore().clear() : { ok: true }),
    removeForHistory: (id) => { if (store) store.removeForHistory(id); },

    state: guard(async () => {
      const tasks = getStore().list();
      return {
        ok: true,
        agents: await detect(),
        tasks,
        projects: recentProjects(tasks),
        permission: config().permission,
      };
    }),
    send: guard((event, request) => {
      if (!request || typeof request !== "object") return { ok: false, error: "The send request is malformed." };
      return getStore().submit({
        key: request.key,
        agent: request.agent,
        project: request.project,
        brief: request.brief,
        model: request.model || "",
        historyId: request.historyId,
      });
    }),
    cancel: guard((event, id) => getStore().cancel(id)),
    reply: guard((event, request) => getStore().reply(request?.id, request?.text)),
    remove: guard((event, id) => getStore().remove(id)),
    copyResume: guard((event, id) => {
      const task = getStore().get(id);
      if (!task?.resumeCommand) return { ok: false, error: "This task has no session to resume yet." };
      // A command to run in the project, with the folder quoted for a shell the
      // user pastes it into. It is only copied, never executed by Earheart.
      const quoted = process.platform === "win32" ? `"${task.project.replace(/"/g, "")}"` : `'${task.project.replace(/'/g, `'\\''`)}'`;
      copyText(`cd ${quoted} && ${task.resumeCommand}`);
      return { ok: true };
    }),
    pickProject: guard(async () => {
      const picked = await pickFolder();
      if (!picked) return { ok: true, path: null };
      const check = validateProject(picked);
      return check.ok ? { ok: true, path: check.path, name: path.basename(check.path) } : { ok: false, error: check.error };
    }),
  };
}

module.exports = { createAgentApi, DISABLED };
