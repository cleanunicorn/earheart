// deliver() on macOS with Accessibility off: the transcript must stay on the
// clipboard, the keystroke must never be attempted, and the permission repair
// must run once per launch, not on every dictation. Electron and the child
// process are stubbed; nothing here touches the real clipboard or TCC.

const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const {
  explainMacPasteError,
  fixPastePermissions,
  checkPastePermissions,
  repairPastePermissions,
  shouldRepairAtStartup,
  automationStatus,
  resetMacPermission,
  MAC_BUNDLE_ID,
} = require("../main/output/deliver");
const { permissionFixStatus, permissionCheckStatus } = require("../renderer/permission-status");

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
  for (const request of [file, "../main/output/mac-permissions", "../main/util/exec-file"]) {
    delete require.cache[require.resolve(request)];
  }
  try {
    return { ...require(file), state, electron };
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

test("startup repair and skipped paste share the once-per-launch permission state", async (t) => {
  onMac(t);
  const { deliver, repairPastePermissions, state } = loadDeliver({ trusted: false });
  assert.strictEqual(await repairPastePermissions(), "already-repaired");
  assert.strictEqual(state.prompts, 1);

  const result = await deliver("after startup", { mode: "paste-copy", pasteDelayMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(result.method, "clipboard");
  assert.strictEqual(state.clip.text, "after startup");
  assert.strictEqual(state.prompts, 1);
  assert.deepStrictEqual(state.execs, []);
});

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

test("a dictation inside the restore window leaves a newer copy alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: { text: "old" } });
  const screenshot = { isEmpty: () => false, kind: "newer" };

  await pasteWithRestore(t, deliver, "first");
  state.clip = { image: screenshot }; // another app copied meanwhile
  // Settling the first restore must not put "old" back over the screenshot;
  // the second dictation snapshots the screenshot instead and restores it.
  await pasteWithRestore(t, deliver, "second");
  assert.deepStrictEqual(state.clip, { text: "second" });
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { image: screenshot });
});

test("a file copy that also carries an image keeps the image", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({
    trusted: true,
    clip: { image: PNG, "text/uri-list": URI_LIST },
  });

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  // The two cannot be written together; the richer representation wins.
  assert.strictEqual(state.clip.image, PNG);
  assert.strictEqual(state.clip["text/uri-list"], undefined);
});

test("cancelling before the keystroke puts a screenshot back", async () => {
  const { deliver, state } = loadDeliver({ trusted: true, clip: { image: PNG } });
  const controller = new AbortController();
  const pending = deliver(
    "new transcript",
    { mode: "paste", restoreClipboard: true, pasteDelayMs: DELAY },
    controller.signal
  );
  controller.abort();

  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clip.image, PNG);
  assert.strictEqual(state.clip.text, undefined);
});

test("advertised but empty formats restore nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  // The clipboard lists an image and a file list, but both read back empty.
  const { deliver, state } = loadDeliver({
    trusted: true,
    clip: { image: EMPTY_IMAGE, "text/uri-list": Buffer.alloc(0) },
  });

  await pasteWithRestore(t, deliver, "hello");
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { text: "hello" }, "no junk is written over the transcript");
});

test("an explicit copy survives a pending restore even when its text is unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onMac(t);
  const { deliver, state } = loadDeliver({ trusted: true, clip: { image: PNG } });
  await pasteWithRestore(t, deliver, "corrected prompt");
  const keystrokes = state.execs.length;
  assert.strictEqual((await deliver("corrected prompt", { mode: "clipboard" })).method, "clipboard");
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(state.clip, { text: "corrected prompt" });
  assert.strictEqual(state.execs.length, keystrokes, "explicit copy never simulates a paste");
});

// #291: another app replaces the clipboard during the paste delay (another
// copy, a clipboard manager). Pasting then would type ITS content into the
// target; nothing may be pasted, and the newer copy must be left alone.
for (const mode of ["paste", "paste-copy"]) {
  test(`${mode}: a clipboard taken over before the keystroke pastes nothing and keeps the newer copy`, async (t) => {
    onLinuxX11(t);
    const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
    const pending = deliver("Dictated agent prompt", { mode, restoreClipboard: true, pasteDelayMs: 30 });
    setTimeout(() => { state.clip = { text: "Unrelated text copied during paste delay" }; }, 5);
    const result = await pending;
    assert.strictEqual(result.method, "clipboard-changed");
    assert.match(result.hint, /nothing was pasted/);
    assert.deepStrictEqual(state.execs, [], "no keystroke");
    assert.strictEqual(state.clip.text, "Unrelated text copied during paste delay");
    // Nor does a later restore put anything over it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await deliver("next", { mode: "clipboard" });
    assert.strictEqual(state.clip.text, "next");
  });
}

test("a clipboard taken over by an image (no text) is not pasted either", async (t) => {
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  const pending = deliver("Dictated agent prompt", { mode: "paste", restoreClipboard: true, pasteDelayMs: 30 });
  setTimeout(() => { state.clip = { image: { isEmpty: () => false, toPNG: () => Buffer.from("png") } }; }, 5);
  assert.strictEqual((await pending).method, "clipboard-changed");
  assert.deepStrictEqual(state.execs, []);
});

test("a clipboard that reads as empty is no evidence: the paste goes ahead", async (t) => {
  // Some sessions can't read the clipboard from an unfocused window; refusing
  // every paste there would break auto-paste outright.
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  const pending = deliver("Dictated agent prompt", { mode: "paste-copy", pasteDelayMs: 30 });
  setTimeout(() => { state.clip = {}; }, 5);
  assert.strictEqual((await pending).method, "paste-copy");
  assert.deepStrictEqual(state.execs, ["xdotool"]);
});

test("an unchanged clipboard still pastes", async (t) => {
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  assert.strictEqual((await deliver("hi", { mode: "paste", restoreClipboard: true, pasteDelayMs: 5 })).method, "paste");
  assert.deepStrictEqual(state.execs, ["xdotool"]);
});

test("a clipboard handing back CRLF for a multi-line transcript is still ours", async (t) => {
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  const pending = deliver("first line\nsecond line", { mode: "paste-copy", pasteDelayMs: 30 });
  setTimeout(() => { state.clip = { text: "first line\r\nsecond line" }; }, 5);
  assert.strictEqual((await pending).method, "paste-copy");
  assert.deepStrictEqual(state.execs, ["xdotool"]);
});

test("an empty read with only text formats is an unreadable clipboard, not a takeover", async (t) => {
  // Windows answers "" while another app holds the clipboard open, yet still
  // lists text/plain; refusing to paste then would be a false alarm.
  onLinuxX11(t);
  const { deliver, state, electron } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  const pending = deliver("Dictated agent prompt", { mode: "paste-copy", pasteDelayMs: 30 });
  setTimeout(() => {
    electron.clipboard.readText = () => "";
  }, 5);
  assert.strictEqual((await pending).method, "paste-copy");
  assert.deepStrictEqual(state.execs, ["xdotool"]);
});

test("on Wayland the takeover check stands aside: an unfocused read can be stale", async (t) => {
  onPlatform(t, "linux");
  const saved = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE, PATH: process.env.PATH };
  process.env.WAYLAND_DISPLAY = "wayland-0";
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.PATH = "/earheart-test-bin";
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["wtype"] });
  const pending = deliver("Dictated agent prompt", { mode: "paste-copy", pasteDelayMs: 30 });
  setTimeout(() => { state.clip = { text: "what a stale read might show" }; }, 5);
  assert.strictEqual((await pending).method, "paste-copy");
  assert.deepStrictEqual(state.execs, ["wtype"], "the paste went ahead, through wtype");
});

test("plain paste still restores a clipboard read back with CRLF", async (t) => {
  onLinuxX11(t);
  const { deliver, state } = loadDeliver({ trusted: true, tools: ["xdotool"] });
  const controller = new AbortController();
  const pending = deliver("one\ntwo", { mode: "paste", restoreClipboard: true, pasteDelayMs: 20 }, controller.signal);
  state.clip = { text: "one\r\ntwo" };
  controller.abort();
  assert.deepStrictEqual(await pending, { method: "cancelled" });
  assert.strictEqual(state.clip.text, "old", "the previous clipboard came back");
});

for (const mode of ["paste", "paste-copy"]) {
  test(`untrusted ${mode}: clipboard takeover still offers transcript recovery`, async (t) => {
    onMac(t);
    const { deliver, state } = loadDeliver({ trusted: false });
    const pending = deliver("Dictated prompt", { mode, restoreClipboard: true, pasteDelayMs: 0 });
    // The write is synchronous; replace it while delivery awaits its delay.
    state.clip = { text: "Newer copy" };
    const result = await pending;
    assert.deepStrictEqual(result, {
      method: "clipboard-changed",
      note: "Copy it from the tray menu",
      hint: "Another app changed the clipboard before Earheart could paste, so nothing was pasted and that copy was left as it was. " +
        "Copy the transcript from the tray menu (Copy last transcription).",
    });
    assert.deepStrictEqual(state.clip, { text: "Newer copy" });
    assert.deepStrictEqual(state.execs, [], "no keystroke");
  });
}

// macOS reports the auto-paste permission failures with unrelated wording; each
// must map to the toggle the user has to flip, with a note short enough for the
// overlay, and anything else must pass through untouched so the log still shows
// the real cause.
test("explainMacPasteError names the macOS permission that blocked the paste", () => {
  const automation = explainMacPasteError(
    new Error("execution error: Not authorized to send Apple events to System Events. (-1743)")
  );
  assert.match(automation.note, /Automation/);
  assert.match(automation.hint, /Privacy & Security ▸ Automation/);

  const accessibility = explainMacPasteError(
    new Error(
      "execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)"
    )
  );
  assert.match(accessibility.note, /Accessibility/);
  assert.match(accessibility.hint, /Settings ▸ General ▸ Fix auto-paste permission/);
  // The usual cause is an update invalidating the old grant; the hint says so,
  // because the toggle in System Settings still looks on.
  assert.match(accessibility.hint, /update/);

  // Our timeout killed osascript: stderr is empty and the message is the
  // command line, which must not be what the user reads.
  const killed = Object.assign(new Error("Command failed: osascript -e tell application"), {
    killed: true,
  });
  const timedOut = explainMacPasteError(killed);
  assert.match(timedOut.note, /prompt/i);
  assert.doesNotMatch(timedOut.note, /osascript/);

  const other = explainMacPasteError(new Error("Command failed: osascript"));
  // An unrecognised failure gets plain copy; the raw tool output is for the log.
  assert.doesNotMatch(other.note, /osascript|Command failed/);
  assert.doesNotMatch(other.hint, /osascript|Command failed/);
  assert.match(other.hint, /⌘V/);

  // Every note fits the overlay's single detail row.
  for (const r of [automation, accessibility, timedOut, other]) assert.ok(r.note.length <= 32, r.note);
});

// The permission reset clears TCC decisions by bundle identifier; if it drifts
// from the appId the packaged app is built with, the reset silently clears
// nothing and the stale grant stays.
test("the TCC bundle id matches the packaged appId", () => {
  const yml = fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8");
  assert.strictEqual(yml.match(/^appId:\s*(\S+)/m)?.[1], MAC_BUNDLE_ID);
});

// A fake of the macOS permission primitives fixPastePermissions drives, with a
// call log so each test can check what was reset, prompted and opened.
// `reset` is a boolean for every service, or a {service: boolean} map.
function fakeMacPermissions({ trusted = true, automation = ["granted"], reset = true, openFails = false } = {}) {
  const calls = [];
  const statuses = [...automation];
  return {
    calls,
    accessibilityTrusted: (prompt = false) => {
      calls.push(prompt ? "prompt" : "check");
      return trusted;
    },
    automationStatus: async () => {
      calls.push("probe");
      return statuses.length > 1 ? statuses.shift() : statuses[0];
    },
    resetMacPermission: async (service) => {
      calls.push(`reset:${service}`);
      return typeof reset === "object" ? reset[service] : reset;
    },
    openAccessibilitySettings: async () => {
      calls.push("open:accessibility");
      if (openFails) throw new Error("no");
    },
    openAutomationSettings: async () => {
      calls.push("open:automation");
      if (openFails) throw new Error("no");
    },
  };
}

test("fixPastePermissions clears a stale Accessibility grant (and Automation's) before re-prompting", async () => {
  const p = fakeMacPermissions({ trusted: false });
  const result = await fixPastePermissions(p);
  assert.deepStrictEqual(result, { granted: false, pane: "accessibility", reset: true, opened: true });
  assert.deepStrictEqual(p.calls, [
    "check",
    "reset:Accessibility",
    "reset:AppleEvents",
    "prompt",
    "open:accessibility",
  ]);
  // A failed reset leaves Automation alone and still opens the pane.
  const failed = fakeMacPermissions({ trusted: false, reset: false });
  assert.strictEqual((await fixPastePermissions(failed)).reset, false);
  assert.ok(!failed.calls.includes("reset:AppleEvents"));
});

test("fixPastePermissions resets Automation only for a recorded denial", async () => {
  const allowed = fakeMacPermissions({ automation: ["denied", "granted"] });
  assert.deepStrictEqual(await fixPastePermissions(allowed), { granted: true });
  assert.deepStrictEqual(allowed.calls, ["check", "probe", "reset:AppleEvents", "probe"]);

  const stillDenied = fakeMacPermissions({ automation: ["denied"], reset: false });
  assert.deepStrictEqual(await fixPastePermissions(stillDenied), {
    granted: false,
    pane: "automation",
    reset: false,
    automation: "denied",
    opened: true,
  });

  // A timed-out probe is a prompt still waiting: nothing to clear.
  const pending = fakeMacPermissions({ automation: ["pending"] });
  assert.strictEqual((await fixPastePermissions(pending)).automation, "pending");
  assert.ok(!pending.calls.some((c) => c.startsWith("reset:")));

  const granted = fakeMacPermissions();
  assert.deepStrictEqual(await fixPastePermissions(granted), { granted: true });

  const noPane = fakeMacPermissions({ trusted: false, openFails: true });
  assert.strictEqual((await fixPastePermissions(noPane)).opened, false);
});

// The Automation pane has no +/−, and a prompt that is still waiting has no
// entry to toggle: each result must send the user somewhere that exists.
test("permissionFixStatus gives instructions that match the pane", () => {
  assert.strictEqual(permissionFixStatus({ granted: true }).cls, "status ok");

  const accReset = permissionFixStatus({ granted: false, pane: "accessibility", reset: true, opened: true });
  assert.doesNotMatch(accReset.text, /−/);
  const accStale = permissionFixStatus({ granted: false, pane: "accessibility", reset: false, opened: true });
  assert.match(accStale.text, /remove it with −/);

  for (const reset of [true, false]) {
    for (const automation of ["denied", "pending", "error"]) {
      const { text } = permissionFixStatus({ granted: false, pane: "automation", reset, opened: true, automation });
      assert.doesNotMatch(text, /−/, `${automation}/${reset}`);
    }
  }
  assert.match(permissionFixStatus({ granted: false, pane: "automation", opened: true, automation: "pending" }).text, /Allow/);
  assert.match(permissionFixStatus({ granted: false, pane: "automation", opened: true, automation: "denied" }).text, /System Events on/);

  for (const pane of ["accessibility", "automation"]) {
    const closed = permissionFixStatus({ granted: false, pane, opened: false });
    assert.strictEqual(closed.cls, "status err");
    assert.match(closed.text, /manually/);
  }
  // Pane didn't open and the stale entry wasn't cleared: removing it by hand is
  // still the instruction that matters — but never for Automation.
  assert.match(permissionFixStatus({ granted: false, pane: "accessibility", reset: false, opened: false }).text, /remove it with −/);
  assert.doesNotMatch(permissionFixStatus({ granted: false, pane: "automation", reset: false, opened: false }).text, /−/);
});

test("the refocus check moves on to Automation once Accessibility is on", async () => {
  assert.deepStrictEqual(await checkPastePermissions(fakeMacPermissions({ trusted: false })), {
    granted: false,
    accessibility: false,
  });
  const pending = fakeMacPermissions({ automation: ["pending"] });
  assert.deepStrictEqual(await checkPastePermissions(pending), {
    granted: false,
    accessibility: true,
    automation: "pending",
  });
  // Passive: no reset, no prompt, no pane.
  assert.deepStrictEqual(pending.calls, ["check", "probe"]);

  assert.strictEqual(permissionCheckStatus({ granted: false, accessibility: false }), null);
  assert.strictEqual(permissionCheckStatus({ granted: true }).cls, "status ok");
  assert.match(permissionCheckStatus({ granted: false, accessibility: true, automation: "pending" }).text, /Allow/);
  assert.match(permissionCheckStatus({ granted: false, accessibility: true, automation: "denied" }).text, /Automation/);
  assert.strictEqual(permissionCheckStatus({ granted: false, accessibility: true, automation: "error" }).cls, "status err");
});

function fakeMarker(value = "") {
  return {
    value,
    read() {
      return this.value;
    },
    write(v) {
      this.value = v;
    },
  };
}

test("repairPastePermissions clears stale grants once per build, and retries a failed reset", async () => {
  const env = { platform: "darwin", packaged: true, version: "0.32.0" };

  const p = fakeMacPermissions({ trusted: false });
  const marker = fakeMarker("0.31.1");
  assert.strictEqual(await repairPastePermissions({ p, marker, ...env }), "repaired");
  assert.deepStrictEqual(p.calls, ["check", "reset:Accessibility", "reset:AppleEvents", "prompt"]);
  assert.strictEqual(marker.value, "0.32.0");

  // Same build, still untrusted (the user dismissed the prompt): no second
  // reset, just the prompt offer.
  const again = fakeMacPermissions({ trusted: false });
  assert.strictEqual(await repairPastePermissions({ p: again, marker, ...env }), "already-repaired");
  assert.deepStrictEqual(again.calls, ["check", "prompt"]);

  // A failed reset is not recorded, so the next launch tries again.
  const failing = fakeMacPermissions({ trusted: false, reset: false });
  const unrecorded = fakeMarker("0.31.1");
  assert.strictEqual(await repairPastePermissions({ p: failing, marker: unrecorded, ...env }), "reset-failed");
  assert.strictEqual(unrecorded.value, "0.31.1");

  // Accessibility cleared but Automation didn't: not recorded, so a launch
  // that is still untrusted retries both.
  const split = fakeMacPermissions({ trusted: false, reset: { Accessibility: true, AppleEvents: false } });
  const splitMarker = fakeMarker("0.31.1");
  assert.strictEqual(await repairPastePermissions({ p: split, marker: splitMarker, ...env }), "reset-failed");
  assert.strictEqual(splitMarker.value, "0.31.1");
  // Once Accessibility is trusted, never reset blind: that could revoke a
  // grant the user just gave.
  const grantedSince = fakeMacPermissions();
  assert.strictEqual(await repairPastePermissions({ p: grantedSince, marker: splitMarker, ...env }), "not-needed");
  assert.deepStrictEqual(grantedSince.calls, ["check"]);

  // Trusted or not macOS: nothing to do and nothing recorded.
  for (const [over, trusted] of [[{}, true], [{ platform: "linux" }, false]]) {
    const q = fakeMacPermissions({ trusted });
    const m = fakeMarker();
    assert.strictEqual(await repairPastePermissions({ p: q, marker: m, ...env, ...over }), "not-needed");
    assert.ok(!q.calls.some((c) => c.startsWith("reset:")));
    assert.strictEqual(m.value, "");
  }
  // Unpackaged: nothing of ours to reset, but still prompt.
  const dev = fakeMacPermissions({ trusted: false });
  const devMarker = fakeMarker();
  assert.strictEqual(await repairPastePermissions({ p: dev, marker: devMarker, ...env, packaged: false }), "already-repaired");
  assert.deepStrictEqual(dev.calls, ["check", "prompt"]);
  assert.strictEqual(devMarker.value, "");
});

// The real adapters, with the child process faked: never touch live TCC.
test("automationStatus and resetMacPermission drive osascript and tccutil correctly", async () => {
  const fail = (props) => async () => {
    throw Object.assign(new Error(props.message ?? ""), props);
  };
  const mac = { platform: "darwin" };
  assert.strictEqual(await automationStatus({ ...mac, run: async () => "System Events" }), "granted");
  assert.strictEqual(await automationStatus({ ...mac, run: fail({ killed: true }) }), "pending");
  assert.strictEqual(
    await automationStatus({ ...mac, run: fail({ message: "Not authorized to send Apple events to System Events. (-1743)" }) }),
    "denied"
  );
  assert.strictEqual(await automationStatus({ ...mac, run: fail({ message: "boom" }) }), "error");
  assert.strictEqual(await automationStatus({ platform: "linux", run: fail({ message: "unused" }) }), "granted");

  const runs = [];
  const run = async (cmd, args) => runs.push([cmd, ...args]);
  assert.strictEqual(await resetMacPermission("Accessibility", { ...mac, packaged: true, run }), true);
  // Scoped to our bundle id: without it tccutil resets the service for every app.
  assert.deepStrictEqual(runs, [["/usr/bin/tccutil", "reset", "Accessibility", MAC_BUNDLE_ID]]);
  assert.strictEqual(await resetMacPermission("Accessibility", { ...mac, packaged: false, run }), false);
  assert.strictEqual(await resetMacPermission("Accessibility", { platform: "linux", packaged: true, run }), false);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(await resetMacPermission("AppleEvents", { ...mac, packaged: true, run: fail({ message: "no" }) }), false);
});

test("overlapping repair requests share one run", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const p = fakeMacPermissions({ trusted: false });
  const resetOnce = p.resetMacPermission;
  p.resetMacPermission = async (service) => {
    await gate;
    return resetOnce(service);
  };
  const marker = fakeMarker();
  let writes = 0;
  const countingMarker = { read: () => marker.read(), write: (v) => (writes++, marker.write(v)) };
  const env = { p, marker: countingMarker, platform: "darwin", packaged: true, version: "0.32.0" };
  const first = repairPastePermissions(env);
  const second = repairPastePermissions(env);
  release();
  assert.deepStrictEqual(await Promise.all([first, second]), ["repaired", "repaired"]);
  assert.deepStrictEqual(p.calls.filter((c) => c !== "check"), ["reset:Accessibility", "reset:AppleEvents", "prompt"]);
  assert.strictEqual(writes, 1);
});

test("startup repairs only on a returning user's visible launch in a paste mode", () => {
  const base = { smokeTest: false, firstRun: false, hidden: false, mode: "paste" };
  assert.strictEqual(shouldRepairAtStartup(base), true);
  assert.strictEqual(shouldRepairAtStartup({ ...base, mode: "paste-copy" }), true);
  for (const over of [{ smokeTest: true }, { firstRun: true }, { hidden: true }, { mode: "clipboard" }]) {
    assert.strictEqual(shouldRepairAtStartup({ ...base, ...over }), false, JSON.stringify(over));
  }
});
