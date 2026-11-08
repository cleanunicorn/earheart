// main/commands/index.js (#344): the session wired to the pipeline, the router,
// the card window, delivery and the global hotkey, with Electron and the main
// process neighbours faked.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { withStubs } = require("./helpers/stub-modules");

const indexPath = require.resolve("../main/commands/index");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.join(path.dirname(indexPath), "..")] });
const FRESH = ["../main/commands/index", "../main/commands/platform", "../main/commands/ipc", "../main/commands/session", "../main/commands/selection"]
  .map((p) => require.resolve(p));

function load({ commands = {}, cleanup = {}, occupied = [], readiness = { ok: true }, pipelineState = "idle" } = {}) {
  const log = { registered: new Map(), unregistered: [], routed: [], deliveries: [], opened: 0, closed: 0, handlers: {}, started: [], sent: [] };
  const cfg = {
    commands: { hotkey: "", engine: "builtin", baseUrl: "", apiKey: "", model: "", timeoutMs: 5000, maxOutputTokens: 512, allowApply: true, ...commands },
    cleanup: { builtin: { model: "cleanup-model" }, baseUrl: "https://cleanup.example/v1", apiKey: "cleanup-key", engine: "remote", ...cleanup },
    output: { pasteDelayMs: 77, mode: "clipboard" },
    audio: { maxRecordingSeconds: 300 },
  };
  let state = pipelineState;
  const listeners = [];
  const pipeline = {
    getState: () => state,
    onStateChange: (fn) => listeners.push(fn),
    startCommandRecording: (handlers) => { log.started.push(handlers); return 5; },
    stopRecording() {},
    cancel() {},
  };
  const stubs = {
    [resolveFrom("electron")]: {
      clipboard: { readText: () => "", writeText() {}, clear() {}, availableFormats: () => [] },
      ipcMain: { handle: (channel, fn) => { log.handlers[channel] = fn; } },
      globalShortcut: {
        register(accelerator, fn) {
          if (occupied.includes(accelerator)) return false;
          log.registered.set(accelerator, fn);
          return true;
        },
        unregister(accelerator) { log.unregistered.push(accelerator); log.registered.delete(accelerator); },
      },
    },
    [resolveFrom("./settings")]: { get: () => cfg },
    [resolveFrom("./windows")]: {
      openCommand: () => { log.opened++; },
      closeCommand: () => { log.closed++; },
      sendToCommand: (channel, payload) => log.sent.push([channel, payload]),
      isCommandSender: () => false,
    },
    [resolveFrom("./services/route")]: {
      transform: async (request, config, signal, opts) => { log.routed.push({ request, config, opts }); return "OUT"; },
    },
    [resolveFrom("./engines")]: { getCleanupReadiness: () => readiness },
    [resolveFrom("./output/deliver")]: {
      deliver: async (text, config) => { log.deliveries.push({ text, config }); return { method: "paste" }; },
      snapshotClipboard: () => null,
      restoreSnapshot() {},
      commandExists: () => true,
      isWayland: () => false,
      accessibilityTrusted: () => true,
    },
    [resolveFrom("./util/logger")]: { info() {}, warn() {}, error() {} },
  };
  const commandsModule = withStubs(stubs, FRESH, () => require(indexPath));
  return { commandsModule, pipeline, log, cfg, setState: (s) => { state = s; listeners.forEach((fn) => fn(s)); } };
}

test("init binds the configured hotkey and routes it to a command", async () => {
  const t = load({ commands: { hotkey: "CommandOrControl+Alt+K" } });
  t.commandsModule.init({ pipeline: t.pipeline });
  assert.ok(t.log.registered.has("CommandOrControl+Alt+K"));
  assert.deepStrictEqual(t.commandsModule.getHotkeyStatus(), { ok: true, accelerator: "CommandOrControl+Alt+K" });
  assert.ok(["command:get", "command:apply", "command:copy"].every((c) => c in t.log.handlers));
});

test("a hotkey that can't be registered is reported, not thrown", () => {
  const t = load({ commands: { hotkey: "Ctrl+Shift+K" }, occupied: ["Ctrl+Shift+K"] });
  t.commandsModule.init({ pipeline: t.pipeline });
  const status = t.commandsModule.getHotkeyStatus();
  assert.strictEqual(status.ok, false);
  assert.match(status.error, /Could not register/);
  assert.strictEqual(status.accelerator, "Ctrl+Shift+K");
});

test("changing the hotkey keeps the old one when the new one is refused, and clearing unbinds it", () => {
  const t = load({ commands: { hotkey: "Ctrl+Alt+1" }, occupied: ["Ctrl+Alt+2"] });
  t.commandsModule.init({ pipeline: t.pipeline });
  assert.strictEqual(t.commandsModule.applyHotkey("Ctrl+Alt+2").ok, false);
  assert.ok(t.log.registered.has("Ctrl+Alt+1"), "the working binding survives a refused change");
  assert.strictEqual(t.commandsModule.applyHotkey("Ctrl+Alt+3").ok, true);
  assert.ok(!t.log.registered.has("Ctrl+Alt+1") && t.log.registered.has("Ctrl+Alt+3"));
  assert.deepStrictEqual(t.commandsModule.applyHotkey(""), { ok: true, empty: true });
  assert.strictEqual(t.log.registered.size, 0);
});

test("suspending releases the hotkey while a Settings field captures a combination, and restores it", () => {
  const t = load({ commands: { hotkey: "Ctrl+Alt+1" } });
  t.commandsModule.init({ pipeline: t.pipeline });
  t.commandsModule.suspend(true);
  assert.strictEqual(t.log.registered.size, 0);
  t.commandsModule.suspend(false);
  assert.ok(t.log.registered.has("Ctrl+Alt+1"));
});

test("a command doesn't start while a dictation is running", async () => {
  const t = load({ pipelineState: "processing" });
  t.commandsModule.init({ pipeline: t.pipeline });
  assert.deepStrictEqual(await t.commandsModule.begin(), { ok: false, busy: true });
  assert.strictEqual(t.log.opened, 0);
  assert.strictEqual(t.log.started.length, 0);
});

test("the local engine borrows the cleanup model and the dictation context size, with the command's own budget", async () => {
  const t = load({ commands: { maxOutputTokens: 512 } });
  t.commandsModule.init({ pipeline: t.pipeline });
  const out = await t.commandsModule.transform({ instruction: "shorten", selection: "text" }, new AbortController().signal);
  assert.strictEqual(out, "OUT");
  const [{ request, config, opts }] = t.log.routed;
  assert.deepStrictEqual(request, { instruction: "shorten", selection: "text" });
  assert.strictEqual(config.engine, "builtin");
  assert.strictEqual(config.maxOutputTokens, 512);
  assert.deepStrictEqual(opts, { cleanupModelId: "cleanup-model", maxRecordingSeconds: 300 });
});

test("the local engine says plainly when its model isn't downloaded, without starting a worker", async () => {
  const t = load({ readiness: { ok: false, reason: "missing", modelId: "cleanup-model" } });
  t.commandsModule.init({ pipeline: t.pipeline });
  await assert.rejects(
    t.commandsModule.transform({ instruction: "x" }, new AbortController().signal),
    /local text model isn't downloaded yet.*Settings → Cleanup/
  );
  assert.deepStrictEqual(t.log.routed, []);
});

test("the remote engine is given only the command service's own address and key, never the cleanup service's", async () => {
  const t = load({ commands: { engine: "remote", baseUrl: "https://commands.example/v1", apiKey: "cmd-key", model: "cmd-model" } });
  t.commandsModule.init({ pipeline: t.pipeline });
  await t.commandsModule.transform({ instruction: "x", selection: "y" }, new AbortController().signal);
  const { config } = t.log.routed[0];
  assert.strictEqual(config.engine, "remote");
  assert.strictEqual(config.baseUrl, "https://commands.example/v1");
  assert.strictEqual(config.apiKey, "cmd-key");
  assert.ok(!JSON.stringify(config).includes("cleanup.example") && !JSON.stringify(config).includes("cleanup-key"));
});

test("a remote engine with nothing configured fails closed instead of using the cleanup service", async () => {
  const t = load({ commands: { engine: "remote" } });
  t.commandsModule.init({ pipeline: t.pipeline });
  await t.commandsModule.transform({ instruction: "x" }, new AbortController().signal);
  const { config } = t.log.routed[0];
  assert.strictEqual(config.baseUrl, "", "main routes with an empty address; the client refuses it (see remote-services tests)");
});

test("Apply pastes in paste mode with the clipboard restored, whatever the dictation output mode is", async () => {
  const t = load();
  t.commandsModule.init({ pipeline: t.pipeline });
  const signal = new AbortController().signal;
  await t.commandsModule.paste("final text", signal);
  assert.deepStrictEqual(t.log.deliveries, [{ text: "final text", config: { mode: "paste", restoreClipboard: true, pasteDelayMs: 77 } }]);
});

test("commandConfig runs anything but an explicit remote engine locally", () => {
  for (const engine of ["builtin", "", undefined, "server", "REMOTE", 7]) {
    const t = load({ commands: { engine } });
    t.commandsModule.init({ pipeline: t.pipeline });
    assert.strictEqual(t.commandsModule.commandConfig().engine, "builtin", String(engine));
  }
  const remote = load({ commands: { engine: "remote" } });
  remote.commandsModule.init({ pipeline: remote.pipeline });
  assert.strictEqual(remote.commandsModule.commandConfig().engine, "remote");
});
