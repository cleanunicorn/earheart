// The native edges of a voice command (main/commands/platform.js, #344), with
// the platform tools faked: which keystroke is sent per OS, how held modifiers
// and a secure field are read, what counts as a fingerprint of the focused
// window, and which desktops can only Copy.

const { test } = require("node:test");
const assert = require("node:assert");

// Output of the electron stub isn't needed; platform.js pulls deliver for its
// default helpers, which load Electron. Stub Electron so it loads under plain node.
const path = require("node:path");
const { withStubs } = require("./helpers/stub-modules");
const platformPath = require.resolve("../main/commands/platform");
const deliverPath = require.resolve("../main/output/deliver");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(deliverPath)] });
const { createPlatform } = withStubs(
  { [resolveFrom("electron")]: { clipboard: {}, app: {} } },
  [platformPath, deliverPath],
  () => require(platformPath)
);

function make({ platform = "linux", wayland = false, tools = ["xdotool"], answers = {}, trusted = true } = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, answer] of Object.entries(answers)) {
      if (key.includes(pattern)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return "";
  };
  return {
    calls,
    p: createPlatform({ platform, exec, wayland: () => wayland, hasCommand: (c) => tools.includes(c), accessibilityTrusted: () => trusted }),
  };
}

test("X11 copies with xdotool, clearing held modifiers, and fingerprints the active window", async () => {
  const { p, calls } = make({ answers: { getactivewindow: "94371847\n", getwindowname: "notes.txt - Editor\n" } });
  assert.deepStrictEqual(p.captureSupport(), { ok: true });
  assert.deepStrictEqual(p.fingerprintSupport(), { ok: true, grain: "window" });
  await p.sendCopy();
  assert.deepStrictEqual([calls[0].cmd, calls[0].args], ["xdotool", ["key", "--clearmodifiers", "ctrl+c"]]);
  assert.deepStrictEqual(await p.fingerprint(), { id: "x11:94371847", label: "notes.txt - Editor" });
  assert.strictEqual(await p.secureInputActive(), false, "secure fields can't be detected here");
});

test("Wayland can copy through wtype or ydotool but cannot identify a window, so it is Copy-only", async () => {
  const { p, calls } = make({ wayland: true, tools: ["wtype"] });
  assert.deepStrictEqual(p.captureSupport(), { ok: true });
  assert.strictEqual(p.fingerprintSupport().ok, false);
  assert.match(p.fingerprintSupport().reason, /only be copied/);
  assert.strictEqual(await p.fingerprint(), null);
  await p.sendCopy();
  assert.deepStrictEqual([calls[0].cmd, calls[0].args], ["wtype", ["-M", "ctrl", "-k", "c", "-m", "ctrl"]]);

  const fallback = make({ wayland: true, tools: ["wtype", "ydotool"], answers: { wtype: new Error("compositor refused") } });
  await fallback.p.sendCopy();
  assert.deepStrictEqual(fallback.calls.map((c) => c.cmd), ["wtype", "ydotool"]);
});

test("Linux with no keystroke tool can't read a selection and says what to install", async () => {
  const { p } = make({ tools: [] });
  const support = p.captureSupport();
  assert.strictEqual(support.ok, false);
  assert.match(support.reason, /wtype, ydotool or xdotool/);
  await assert.rejects(p.sendCopy(), /No keystroke tool/);
});

test("a missing window name doesn't lose the fingerprint, and an unreadable window is null", async () => {
  const named = make({ answers: { getactivewindow: "55\n", getwindowname: new Error("no name") } });
  assert.deepStrictEqual(await named.p.fingerprint(), { id: "x11:55", label: "" });
  const broken = make({ answers: { getactivewindow: new Error("no display") } });
  assert.strictEqual(await broken.p.fingerprint(), null);
});

test("macOS needs Accessibility, copies with Cmd+C and fingerprints the frontmost app", async () => {
  const off = make({ platform: "darwin", trusted: false });
  assert.strictEqual(off.p.captureSupport().ok, false);
  assert.match(off.p.captureSupport().reason, /Accessibility/);

  const { p, calls } = make({ platform: "darwin", answers: { "unix id of first": "4242|TextEdit\n" } });
  assert.deepStrictEqual(p.captureSupport(), { ok: true });
  assert.deepStrictEqual(p.fingerprintSupport(), { ok: true, grain: "app" }, "app-level only; Apply re-reads the selection to compensate");
  await p.sendCopy();
  assert.match(calls[0].args.join(" "), /keystroke "c" using command down/);
  assert.deepStrictEqual(await p.fingerprint(), { id: "mac:4242", label: "TextEdit" });
});

test("macOS reports a secure input field; a failing probe means 'not known'", async () => {
  assert.strictEqual(await make({ platform: "darwin", answers: { IsSecureEventInputEnabled: "secure\n" } }).p.secureInputActive(), true);
  assert.strictEqual(await make({ platform: "darwin", answers: { IsSecureEventInputEnabled: "open\n" } }).p.secureInputActive(), false);
  assert.strictEqual(await make({ platform: "darwin", answers: { IsSecureEventInputEnabled: new Error("no Carbon") } }).p.secureInputActive(), false);
});

test("Windows copies with SendKeys ^c and fingerprints hwnd+pid; modifiers are polled natively", async () => {
  const { p, calls } = make({ platform: "win32", answers: { "GetForegroundWindow": "394566|8120|notepad\n", "GetAsyncKeyState": "released\n" } });
  assert.deepStrictEqual(p.captureSupport(), { ok: true });
  assert.deepStrictEqual(p.fingerprintSupport(), { ok: true, grain: "window" });
  assert.deepStrictEqual(await p.fingerprint(), { id: "win:394566:8120", label: "notepad" });
  assert.strictEqual(await p.waitForModifiersReleased(500), true);
  await p.sendCopy();
  assert.ok(calls.some((c) => c.args.join(" ").includes("SendWait('^c')")));
});

test("held modifiers are reported when they never come up", async () => {
  for (const platform of ["win32", "darwin"]) {
    const { p } = make({ platform, answers: { GetAsyncKeyState: "held\n", modifierFlags: "held\n" } });
    assert.strictEqual(await p.waitForModifiersReleased(100), false, platform);
  }
});

test("a modifier probe that fails doesn't block the copy; a cancel does", async () => {
  const failing = make({ platform: "win32", answers: { GetAsyncKeyState: new Error("powershell missing") } });
  assert.strictEqual(await failing.p.waitForModifiersReleased(100), true);
  const controller = new AbortController();
  controller.abort();
  const cancelled = make({ platform: "win32", answers: { GetAsyncKeyState: Object.assign(new Error("aborted"), { aborted: true }) } });
  await assert.rejects(cancelled.p.waitForModifiersReleased(100, controller.signal));
});

test("on Linux, where modifiers can't be queried, a short wait stands in", async () => {
  const { p, calls } = make();
  const started = Date.now();
  assert.strictEqual(await p.waitForModifiersReleased(), true);
  assert.ok(Date.now() - started >= 200);
  assert.deepStrictEqual(calls, []);
});
