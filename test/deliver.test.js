// deliver() on macOS with Accessibility off: the transcript must stay on the
// clipboard, the keystroke must never be attempted, and the permission repair
// must run once per launch, not on every dictation. Electron and the child
// process are stubbed; nothing here touches the real clipboard or TCC.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// A clipboard holding one PNG. `isEmpty()` is all deliver.js asks of it.
const PNG = { isEmpty: () => false, kind: "png" };
const EMPTY_IMAGE = { isEmpty: () => true };
const URI_LIST = Buffer.from("file:///home/me/report.pdf\r\n");

// Formats a stub clipboard advertises, by the key that holds the data.
const FORMAT_OF = {
  text: "text/plain",
  html: "text/html",
  rtf: "text/rtf",
  image: "image/png",
  "text/uri-list": "text/uri-list",
};

// `pasteError` makes the keystroke tool fail with that stderr; `tools` lists
// the Linux keystroke tools the PATH lookup finds; `clip` is what the
// clipboard holds before deliver() runs, keyed like clipboard.write()'s Data
// (plus "text/uri-list" for a file copy).
//
// The clipboard model follows the OS (checked against Electron 42 under Xvfb):
// writeText(), writeBuffer() and write() each replace every format with what
// they are given, so a text write over an image clipboard destroys the image.
function loadDeliver({ trusted, pasteError = null, tools = [], clip = { text: "old" } }) {
  const state = { clip: { ...clip }, prompts: 0, execs: [], logs: [] };
  const electron = {
    clipboard: {
      availableFormats: () =>
        Object.keys(state.clip)
          .filter((key) => state.clip[key] !== undefined)
          .map((key) => FORMAT_OF[key]),
      readText: () => state.clip.text ?? "",
      readHTML: () => state.clip.html ?? "",
      readRTF: () => state.clip.rtf ?? "",
      readImage: () => state.clip.image ?? EMPTY_IMAGE,
      readBuffer: (format) => state.clip[format] ?? Buffer.alloc(0),
      writeText: (t) => {
        state.clip = { text: t };
      },
      write: (data) => {
        state.clip = { ...data };
      },
      writeBuffer: (format, buffer) => {
        state.clip = { [format]: buffer };
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
    return { deliver: require(file).deliver, state, electron };
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
    assert.strictEqual(state.clip.text, "hello");
    assert.deepStrictEqual(state.execs, []);

    await deliver("again", cfg);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(state.clip.text, "again");
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
  assert.strictEqual(state.clip.text, "new transcript");
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clip.text, "old");
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
  state.clip = { text: "copied by another app" };
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clip.text, "copied by another app");
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
  assert.strictEqual(state.clip.text, "new transcript");
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
    assert.strictEqual(state.clip.text, "my words");
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
  assert.strictEqual(state.clip.text, "my words");
  assert.ok(result.note.length <= 32, result.note);
  assert.match(result.hint, /wtype, ydotool or xdotool/);
});

// ---------------------------------------------------------------------------
// Clipboard restore keeps every format (#185). A screenshot, rich text or a
// file copy reads as "" through readText(), so a text-only snapshot restores
// "" and destroys them. These drive a trusted macOS paste on mock timers: the
// paste delay and the 1 s restore window are both setTimeouts, and deliver()
// awaits between them, so each tick is followed by a microtask flush
// (setImmediate stays real).

const RICH = { text: "old", html: "<b>old</b>", rtf: "{\\rtf1 old}" };
const DELAY = 10;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Start a restoring paste and run it through the keystroke; returns once
// deliver() has resolved and the restore timer is armed.
async function pasteWithRestore(t, deliver, text) {
  const pending = deliver(text, { mode: "paste", restoreClipboard: true, pasteDelayMs: DELAY });
  t.mock.timers.tick(DELAY);
  await flush();
  return pending;
}

test("restore keeps an image-only clipboard, which reads as no text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: { image: PNG } });

  const result = await pasteWithRestore(t, deliver, "hello");
  assert.strictEqual(result.method, "paste");
  assert.deepStrictEqual(state.clip, { text: "hello" }, "the transcript is pasted from the clipboard");

  t.mock.timers.tick(999);
  assert.deepStrictEqual(state.clip, { text: "hello" }, "the target app gets the full second to paste");
  t.mock.timers.tick(1);
  assert.strictEqual(state.clip.image, PNG, "the screenshot is back");
  assert.strictEqual(state.clip.text, undefined, "no text is invented for it");
});

test("restore round-trips text, HTML and RTF together", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: RICH });

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, RICH);
});

test("cancelling before the keystroke restores every format too", async () => {
  const { deliver, state } = loadDeliver({ trusted: true, clip: RICH });
  const controller = new AbortController();
  const pending = deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: DELAY },
    controller.signal
  );
  assert.deepStrictEqual(state.clip, { text: "new transcript" });
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.deepStrictEqual(state.clip, RICH);
});

test("restore skips a clipboard another app changed meanwhile, even to an image", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: { text: "old" } });
  const screenshot = { isEmpty: () => false, kind: "newer" };

  await pasteWithRestore(t, deliver, "hello");
  state.clip = { image: screenshot }; // readText() is "" now, not the transcript
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { image: screenshot });
});

test("a dictation inside the restore window puts the clipboard back first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: { image: PNG } });

  await pasteWithRestore(t, deliver, "first");
  t.mock.timers.tick(500);
  assert.deepStrictEqual(state.clip, { text: "first" });

  // The second dictation cancels the first restore; the screenshot must
  // survive it all the same.
  await pasteWithRestore(t, deliver, "second");
  assert.deepStrictEqual(state.clip, { text: "second" });
  t.mock.timers.tick(999);
  assert.deepStrictEqual(state.clip, { text: "second" }, "the first timer must not fire under the second paste");
  t.mock.timers.tick(1);
  assert.strictEqual(state.clip.image, PNG);
});

test("restore keeps a file copy's references (text/uri-list)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  // File managers put the paths on the text format as well; Electron can only
  // write the references on their own, and they are what a paste uses.
  const { deliver, state } = loadDeliver({
    trusted: true,
    clip: { text: "/home/me/report.pdf", "text/uri-list": URI_LIST },
  });

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  assert.strictEqual(state.clip["text/uri-list"], URI_LIST);
  assert.strictEqual(state.clip.text, undefined);
});

test("an empty clipboard is left with the transcript, not cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: {} });

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { text: "hello" });
});

test("a text-only clipboard never decodes an image", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state, electron } = loadDeliver({ trusted: true, clip: { text: "old" } });
  let imageReads = 0;
  const { readImage } = electron.clipboard;
  electron.clipboard.readImage = () => {
    imageReads++;
    return readImage();
  };

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { text: "old" });
  assert.strictEqual(imageReads, 0);
});

test("a clipboard restore that throws is logged and never fails the dictation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state, electron } = loadDeliver({ trusted: true, clip: { image: PNG } });
  electron.clipboard.write = () => {
    throw new Error("clipboard owner went away");
  };

  const first = await pasteWithRestore(t, deliver, "first");
  assert.strictEqual(first.method, "paste");
  // Settled by the next dictation: the failing restore must not reject it.
  const second = await pasteWithRestore(t, deliver, "second");
  assert.strictEqual(second.method, "paste");
  assert.deepStrictEqual(state.clip, { text: "second" }, "the new transcript still went out");
  // And on the timer path it is logged, not thrown at the process.
  t.mock.timers.tick(1000);
  assert.strictEqual(state.logs.filter((line) => line.includes("clipboard restore failed")).length, 2);
});
