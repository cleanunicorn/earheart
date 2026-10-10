// Preload bridge: each window gets a narrow, whitelisted IPC surface — only
// the channels its own page uses.
//
// The window's role comes from main (main/windows.js passes it through
// webPreferences.additionalArguments), so it sits on this renderer's command
// line. The page can't touch it: with context isolation the page never sees
// this script's `process`, and the navigation guard keeps foreign pages out of
// the window. A missing, unknown or repeated role gets no channels at all.

const { contextBridge, ipcRenderer } = require("electron");

// Per role: LISTEN (main → page pushes), SEND (fire-and-forget to main),
// INVOKE (request/response). test/ipc-contract.test.js holds each list equal
// to what that window's scripts actually use.
const ROLES = {
  overlay: {
    LISTEN: [
      "record:start",
      "record:stop",
      "record:cancel",
      "record:pause-toggle",
      "record:discard",
      "pipeline:status",
      "pipeline:partial",
      "pipeline:progress",
      "overlay:show",
      "overlay:hide",
      "updates:prompt",
    ],
    SEND: [
      "audio:captured",
      "audio:partial",
      "record:cancelled",
      "record:error",
      "pipeline:cancel",
      "overlay:drag-start",
      "overlay:drag",
      "overlay:drag-end",
      "overlay:resize",
    ],
    INVOKE: [
      "updates:apply",
      "updates:install",
      "updates:cancel",
      "updates:skip",
      "updates:dismiss",
      "updates:remind-off",
    ],
  },
  settings: {
    LISTEN: [
      "history:changed",
      "models:progress",
      "models:done",
      "updates:state",
      "settings:changed",
    ],
    SEND: [],
    INVOKE: [
      "settings:get",
      "settings:save",
      "settings:close",
      "wizard:open",
      "permissions:accessibility-check",
      "permissions:accessibility-fix",
      "stt:test",
      "cleanup:test",
      "models:list-remote",
      "models:hf-variants",
      "models:browse-hf",
      "models:add-custom",
      "models:remove-custom",
      "history:list",
      "history:clear",
      "models:status",
      "models:download",
      "models:cancel",
      "models:remove",
      "updates:get",
      "updates:check",
      "updates:apply",
      "updates:install",
      "updates:cancel",
      "updates:skip",
      "logs:open",
    ],
  },
  wizard: {
    LISTEN: ["models:progress", "settings:changed"],
    SEND: [],
    INVOKE: [
      "settings:get",
      "wizard:complete",
      "wizard:skip",
      "models:status",
      "models:download",
      "models:cancel",
    ],
  },
};

const NO_CHANNELS = { LISTEN: [], SEND: [], INVOKE: [] };

function roleFromArgv(argv) {
  const PREFIX = "--earheart-role=";
  const given = argv.filter((arg) => typeof arg === "string" && arg.startsWith(PREFIX));
  if (given.length !== 1) return null;
  const role = given[0].slice(PREFIX.length);
  return Object.hasOwn(ROLES, role) ? role : null;
}

const role = roleFromArgv(process.argv);
const allowed = role ? ROLES[role] : NO_CHANNELS;
const LISTEN = new Set(allowed.LISTEN);
const SEND = new Set(allowed.SEND);
const INVOKE = new Set(allowed.INVOKE);

function check(set, channel) {
  if (!set.has(channel)) {
    throw new Error(`Unknown channel: ${channel} (not allowed in the ${role ?? "unknown"} window)`);
  }
}

contextBridge.exposeInMainWorld("earheart", {
  on(channel, callback) {
    check(LISTEN, channel);
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  send(channel, payload) {
    check(SEND, channel);
    ipcRenderer.send(channel, payload);
  },
  invoke(channel, payload) {
    check(INVOKE, channel);
    return ipcRenderer.invoke(channel, payload);
  },
});
