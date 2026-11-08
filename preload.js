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
      "i18n:changed",
      "record:start",
      "record:stop",
      "record:cancel",
      "record:pause-toggle",
      "record:discard",
      "pipeline:status",
      "pipeline:partial",
      "pipeline:progress",
      "pipeline:take-released",
      "overlay:show",
      "overlay:hide",
      "updates:prompt",
    ],
    SEND: [
      "audio:captured",
      "audio:partial",
      "record:cancelled",
      "record:error",
      "record:capture",
      "pipeline:cancel",
      "pipeline:retry",
      "pipeline:discard-take",
      "overlay:drag-start",
      "overlay:drag",
      "overlay:drag-end",
      "overlay:resize",
    ],
    INVOKE: [
      "i18n:get",
      "updates:apply",
      "updates:install",
      "updates:cancel",
      "updates:skip",
      "updates:dismiss",
      "updates:remind-off",
    ],
  },
  palette: {
    LISTEN: [], SEND: [],
    INVOKE: ["palette:query", "palette:execute", "palette:close"],
  },
  settings: {
    LISTEN: [
      "i18n:changed",
      "settings:navigate",
      "history:changed",
      "models:progress",
      "models:done",
      "updates:state",
      "settings:changed",
      "usage:changed",
      "agent:changed",
    ],
    SEND: ["hotkeys:capture"],
    INVOKE: [
      "palette:open",
      "i18n:get",
      "settings:get",
      "settings:save",
      "settings:close",
      "ducking:status",
      "wizard:open",
      "permissions:accessibility-check",
      "permissions:accessibility-fix",
      "stt:test",
      "cleanup:test",
      "cleanup:prompt-offer",
      "models:list-remote",
      "models:hf-variants",
      "models:browse-hf",
      "models:add-custom",
      "models:remove-custom",
      "history:search",
      "history:delete",
      "history:audio-get",
      "history:audio-export",
      "history:retranscribe",
      "agent:state",
      "agent:send",
      "agent:cancel",
      "agent:reply",
      "agent:remove",
      "agent:copy-resume",
      "agent:pick-project",
      "recordings:status",
      "recordings:clear",
      "correction:open",
      "transcript:copy",
      "history:clear",
      "usage:get",
      "usage:reset",
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
      "tools:list",
      "tools:save-server",
      "tools:remove-server",
      "tools:discover",
      "tools:set-policy",
    ],
  },
  // The tool-approval prompt (#346): shows one request, answers allow/deny.
  approval: {
    LISTEN: ["approval:request"],
    SEND: [],
    INVOKE: ["approval:get", "approval:decide"],
  },
  correction: {
    LISTEN: ["correction:notice", "i18n:changed"], SEND: ["correction:dirty"],
    INVOKE: ["i18n:get", "correction:get", "correction:remember", "transcript:copy", "correction:close"],
  },
  wizard: {
    LISTEN: ["models:progress", "models:done", "settings:changed", "i18n:changed"],
    SEND: ["hotkeys:capture"],
    INVOKE: [
      "i18n:get",
      "settings:get",
      "wizard:complete",
      "wizard:skip",
      "models:status",
      "models:download",
      "models:cancel",
      "ducking:status",
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
