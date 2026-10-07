// deliver() on macOS with Accessibility off: the transcript must stay on the
// clipboard, the keystroke must never be attempted, and the permission repair
// must run once per launch, not on every dictation. Electron and the child
// process are stubbed; nothing here touches the real clipboard or TCC.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// `pasteError` makes the keystroke tool fail with that stderr; `tools` lists
// the Linux keystroke tools the PATH lookup finds.
function loadDeliver({ trusted, pasteError = null, tools = [] }) {
  const state = { clipboard: "old", prompts: 0, execs: [], logs: [] };
  const electron = {
    clipboard: {
      readText: () => state.clipboard,
      writeText: (t) => {
        state.clipboard = t;
      },
    },
    systemPreferences: {
      isTrustedAccessibilityClient: (prompt) => {
        if (prompt) state.prompts++;
        return trusted;
      },
    },
    shell: { openExternal: async () => {} },
    // Unpackaged, so the repair never reaches tccutil.
    app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/nonexistent" },
  };
  const childProcess = {
    execFile: (cmd, args, opts, cb) => {
      state.execs.push(cmd);
      if (pasteError) cb(new Error(`Command failed: ${cmd}\n${pasteError}`), "", pasteError);
      else cb(null, "", "");
    },
  };
  const realFs = require("node:fs");
  const fsStub = {
    ...realFs,
    accessSync(p, mode) {
      if (tools.some((tool) => p.endsWith(`/${tool}`))) return;
      return realFs.accessSync(p, mode);
    },
  };
  const logger = {
    info() {},
    warn() {},
    error: (...args) => state.logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")),
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return electron;
    if (request === "node:child_process") return childProcess;
    if (request === "node:fs") return fsStub;
    if (request === "../util/logger") return logger;
    return realLoad.call(this, request, ...rest);
  };
  const file = require.resolve("../main/output/deliver");
  delete require.cache[file];
  try {
    return { deliver: require(file).deliver, state };
  } finally {
    Module._load = realLoad;
  }
}

function onPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  t.after(() => Object.defineProperty(process, "platform", original));
}

function onMac(t) {
  onPlatform(t, "darwin");
}

// An X11 session whose PATH lookup sees only the tools the stub lists.
function onLinuxX11(t) {
  onPlatform(t, "linux");
  const saved = {
    PATH: process.env.PATH,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
  };
  process.env.PATH = "/earheart-test-bin";
  delete process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = "x11";
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

for (const mode of ["paste", "paste-copy"]) {
  test(`untrusted ${mode}: clipboard fallback, no keystroke, one prompt per launch`, async (t) => {
    onMac(t);
    const { deliver, state } = loadDeliver({ trusted: false });
    const cfg = { mode, restoreClipboard: true, pasteDelayMs: 0 };

    const first = await deliver("hello", cfg);
    assert.strictEqual(first.method, "clipboard");
    assert.match(first.note, /Accessibility/);
    assert.match(first.hint, /Fix auto-paste permission/);
    assert.strictEqual(state.clipboard, "hello");
    assert.deepStrictEqual(state.execs, []);

    await deliver("again", cfg);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(state.clipboard, "again");
    assert.deepStrictEqual(state.execs, []);
    assert.strictEqual(state.prompts, 1);
  });
}

test("trusted paste drives the keystroke", async (t) => {
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true });
  const result = await deliver("hi", { mode: "paste-copy", pasteDelayMs: 0 });
  assert.strictEqual(result.method, "paste-copy");
  assert.deepStrictEqual(state.execs, ["osascript"]);
  assert.strictEqual(state.prompts, 0);
});

test("a cancel during the paste delay wins over the permission check", async (t) => {
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: false });
  const controller = new AbortController();
  const pending = deliver("hi", { mode: "paste", pasteDelayMs: 20 }, controller.signal);
  controller.abort();
  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.prompts, 0);
});

test("cancelling before paste restores the previous clipboard", async () => {
  const { deliver, state } = loadDeliver({ trusted: true });
  const controller = new AbortController();
  const pending = deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: 10 },
    controller.signal
  );
  assert.strictEqual(state.clipboard, "new transcript");
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clipboard, "old");
  assert.deepStrictEqual(state.execs, []);
});

test("cancelling does not overwrite a newer clipboard change", async () => {
  const { deliver, state } = loadDeliver({ trusted: true });
  const controller = new AbortController();
  const pending = deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: 10 },
    controller.signal
  );
  state.clipboard = "copied by another app";
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clipboard, "copied by another app");
});

test("cancelling paste-copy keeps the transcript on the clipboard", async () => {
  const { deliver, state } = loadDeliver({ trusted: true });
  const controller = new AbortController();
  const pending = deliver(
    "new transcript",
    { mode: "paste-copy", restoreClipboard: true, pasteDelayMs: 10 },
    controller.signal
  );
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clipboard, "new transcript");
});

// A failed paste leaves the text on the clipboard. The note fits the overlay's
// detail row and the hint says how to paste by hand; the tool's stderr is for
// the log only, never the overlay or the notification.
const STDERR = "xdotool: BadWindow (invalid Window parameter) at 0x3a00007";
// macOS runs through explainPasteError's darwin branch; an osascript error
// with no permission code falls through to the generic copy.
for (const [platform, setup, key] of [
  ["win32", (t) => onPlatform(t, "win32"), "Ctrl+V"],
  ["linux", onLinuxX11, "Ctrl+V"],
  ["darwin", onMac, "⌘V"],
]) {
  test(`${platform}: a failed paste shows short copy and logs the stderr`, async (t) => {
    setup(t);
    const { deliver, state } = loadDeliver({ trusted: true, pasteError: STDERR, tools: ["xdotool"] });
    const result = await deliver("my words", { mode: "paste-copy", pasteDelayMs: 0 });
    assert.strictEqual(result.method, "clipboard");
    assert.strictEqual(state.clipboard, "my words");
    assert.ok(result.note.length <= 32, result.note);
    // The overlay card's title already says auto-paste failed, so the note
    // says what to do instead of repeating it.
    assert.strictEqual(result.note, `Paste it with ${key}`);
    assert.ok(result.hint.includes(key), result.hint);
    // Says where the tool's own words went, by the path Settings shows.
    assert.ok(result.hint.includes("Settings ▸ Advanced ▸ Open error log"), result.hint);
    for (const field of [result.note, result.hint]) {
      assert.doesNotMatch(field, /BadWindow|Command failed|xdotool|powershell|osascript/i);
    }
    assert.ok(state.logs.some((line) => line.includes(STDERR)), state.logs.join("\n"));
  });
}

test("linux: no keystroke tool names the tools to install", async (t) => {
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: [] });
  const result = await deliver("my words", { mode: "paste-copy", pasteDelayMs: 0 });
  assert.strictEqual(result.method, "clipboard");
  assert.strictEqual(state.clipboard, "my words");
  assert.ok(result.note.length <= 32, result.note);
  assert.match(result.hint, /wtype, ydotool or xdotool/);
});
