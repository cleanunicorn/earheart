// Preload bridge: the renderer gets a narrow, whitelisted IPC surface.

const { contextBridge, ipcRenderer } = require("electron");

const LISTEN = new Set([
  "record:start",
  "record:stop",
  "record:cancel",
  "pipeline:status",
  "history:changed",
]);

const SEND = new Set([
  "audio:captured",
  "record:cancelled",
  "record:error",
  "pipeline:toggle",
  "pipeline:cancel",
  "open-external",
]);

const INVOKE = new Set([
  "settings:get",
  "settings:save",
  "stt:test",
  "cleanup:test",
  "history:list",
  "history:clear",
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
