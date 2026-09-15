// deliver() on macOS with Accessibility off: the transcript must stay on the
// clipboard, the keystroke must never be attempted, and the permission repair
// must run once per launch, not on every dictation. Electron and the child
// process are stubbed; nothing here touches the real clipboard or TCC.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function loadDeliver({ trusted }) {
  const state = { clipboard: "old", prompts: 0, execs: [] };
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
      cb(null, "", "");
    },
  };
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") return electron;
    if (request === "node:child_process") return childProcess;
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

function onMac(t) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", original));
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
