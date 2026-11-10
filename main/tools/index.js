// Wires the tools manager into the app: the persisted config, the approval
// window, and the IPC handlers. `host` is the narrow seam command mode (#344)
// will call; nothing in the app invokes tools from voice yet.
//
//   await host.catalog()      -> tools the model may be offered (enabled, not denied)
//   host.execute({serverId, tool, args, signal}) -> { ok, text, modelText, error }
//
// Every tools:* handler checks that it was called from the Settings window,
// and every approval:* handler that it was called from the approval window.
// The preload allowlist already keeps other roles from sending these
// channels; the sender check is the second, independent lock.

const path = require("node:path");
const { createManager } = require("./manager");
const { createStore } = require("./store");

let manager = null;

function init({ ipcMain, app, safeStorage, secretStorageSecure, windows, logger }) {
  const store = createStore({
    file: path.join(app.getPath("userData"), "tools.json"),
    safeStorage,
    secure: secretStorageSecure,
    onWarn: (m) => logger.warn(m),
  });
  manager = createManager({
    store,
    log: (m) => logger.info(m),
    onApprovalChange: (current) => {
      if (current) {
        windows.openApproval();
        windows.sendToApproval("approval:request", current);
      } else {
        windows.closeApproval();
      }
    },
  });
  // The user closing the prompt denies everything waiting on it.
  windows.onApprovalClosed(() => manager.broker.cancelAll("approval window closed"));
  register({ ipcMain, windows, manager, store, logger });
  return manager;
}

const str = (v, max = 200) => (typeof v === "string" && v.length <= max ? v : null);

function register({ ipcMain, windows, manager, store, logger }) {
  const fromSettings = (event) => windows.isSettingsSender(event.sender);
  const fromApproval = (event) => windows.isApprovalSender(event.sender);
  const refuse = { ok: false, error: "not allowed from this window" };

  ipcMain.handle("tools:list", (event) => {
    if (!fromSettings(event)) return refuse;
    return { ok: true, servers: manager.view(), secureStorage: store.encrypts() };
  });
  ipcMain.handle("tools:save-server", async (event, raw) => {
    if (!fromSettings(event)) return refuse;
    if (raw === null || typeof raw !== "object") return { ok: false, errors: ["invalid request"] };
    return manager.saveServer(raw);
  });
  ipcMain.handle("tools:remove-server", async (event, id) => {
    if (!fromSettings(event)) return refuse;
    return str(id, 40) ? manager.removeServer(id) : { ok: false, errors: ["invalid request"] };
  });
  ipcMain.handle("tools:discover", async (event, id) => {
    if (!fromSettings(event)) return refuse;
    return str(id, 40) ? manager.discover(id) : { ok: false, error: "invalid request" };
  });
  ipcMain.handle("tools:set-policy", (event, req) => {
    if (!fromSettings(event)) return refuse;
    const serverId = str(req?.serverId, 40), tool = str(req?.tool, 128), schemaHash = str(req?.schemaHash, 64);
    if (!serverId || !tool || !schemaHash) return { ok: false, error: "invalid request" };
    return manager.setPolicy({
      serverId, tool, schemaHash,
      enabled: typeof req.enabled === "boolean" ? req.enabled : undefined,
      policy: ["ask", "deny", "allow"].includes(req.policy) ? req.policy : undefined,
    });
  });

  ipcMain.handle("approval:get", (event) => {
    if (!fromApproval(event)) return null;
    return manager.broker.current();
  });
  ipcMain.handle("approval:decide", (event, req) => {
    if (!fromApproval(event)) return { ok: false };
    const id = str(req?.id, 64);
    if (!id) return { ok: false };
    // Only the literal "allow" approves; anything else is a denial.
    const ok = manager.broker.decide(id, req.decision === "allow" ? "allow" : "deny");
    if (!ok) logger.info("tool approval: decision for an unknown or expired request ignored");
    return { ok };
  });
}

const host = {
  // Async: lists enabled servers that haven't been listed yet this session.
  catalog: async () => { if (!manager) return []; await manager.prepare(); return manager.modelCatalog(); },
  execute: (req) => (manager ? manager.execute(req) : Promise.resolve({ ok: false, error: "tools are not available" })),
};

module.exports = { init, register, host, running: () => (manager ? manager.running() : 0), shutdown: (ms) => (manager ? manager.shutdown(ms) : Promise.resolve()) };
