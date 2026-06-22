// Preload bridge: the renderer gets a narrow, whitelisted IPC surface.

const { contextBridge, ipcRenderer } = require("electron");

const LISTEN = new Set([
  "record:start",
  "record:stop",
  "record:cancel",
  "pipeline:status",
  "pipeline:partial",
  "history:changed",
  "overlay:show",
  "overlay:hide",
  "models:progress",
]);

const SEND = new Set([
  "audio:captured",
  "audio:partial",
  "record:cancelled",
  "record:error",
  "pipeline:cancel",
  "overlay:drag-start",
  "overlay:drag",
  "overlay:resize",
]);

const INVOKE = new Set([
  "settings:get",
  "settings:save",
  "settings:close",
  "wizard:complete",
  "wizard:skip",
  "wizard:open",
  "permissions:accessibility-check",
  "permissions:accessibility-fix",
  "stt:test",
  "cleanup:test",
  "models:list-remote",
  "history:list",
  "history:clear",
  "models:status",
  "models:download",
  "models:cancel",
  "models:remove",
]);

contextBridge.exposeInMainWorld("earheart", {
  on(channel, callback) {
    if (!LISTEN.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  send(channel, payload) {
    if (!SEND.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
});
