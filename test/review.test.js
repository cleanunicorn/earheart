// Tests for the review-before-send plumbing: the platform command specs of
// focus capture/restore. Pure command-building — no display server needed.

const { test } = require("node:test");
const assert = require("node:assert");

const { captureSpec, restoreSpec } = require("../main/output/focus");
const { needsReview } = require("../main/util/review");
const { deepMerge, DEFAULTS } = require("../main/settings");

test("needsReview truth table", () => {
  assert.strictEqual(needsReview({ mode: "off" }, "hello"), false);
  assert.strictEqual(needsReview({ mode: "always" }, "hello"), true);
  // Boundary: minChars counts as long enough.
  assert.strictEqual(needsReview({ mode: "length", minChars: 5 }, "1234"), false);
  assert.strictEqual(needsReview({ mode: "length", minChars: 5 }, "12345"), true);
  // Missing threshold falls back to the 400 default.
  assert.strictEqual(needsReview({ mode: "length" }, "x".repeat(399)), false);
  assert.strictEqual(needsReview({ mode: "length" }, "x".repeat(400)), true);
  // Degenerate inputs never review.
  assert.strictEqual(needsReview(undefined, "hello"), false);
  assert.strictEqual(needsReview({ mode: "banana" }, "hello"), false);
  assert.strictEqual(needsReview({ mode: "always" }, ""), false);
});

test("review defaults to off with a 400-char threshold", () => {
  const cfg = deepMerge(DEFAULTS, {});
  assert.strictEqual(cfg.review.mode, "off");
  assert.strictEqual(cfg.review.minChars, 400);
});

test("captureSpec darwin queries the frontmost process via System Events", () => {
  const spec = captureSpec("darwin", false);
  assert.strictEqual(spec.cmd, "osascript");
  assert.match(spec.args.join(" "), /System Events/);
  assert.match(spec.args.join(" "), /frontmost/);
  assert.deepStrictEqual(spec.parse("742\nTerminal\n"), {
    kind: "darwin",
    pid: 742,
    name: "Terminal",
  });
  assert.strictEqual(spec.parse("garbage"), null);
  assert.strictEqual(spec.parse(""), null);
});

test("captureSpec win32 reads the foreground HWND", () => {
  const spec = captureSpec("win32", false);
  assert.strictEqual(spec.cmd, "powershell.exe");
  assert.match(spec.args.join(" "), /GetForegroundWindow/);
  assert.deepStrictEqual(spec.parse("132456\r\n"), {
    kind: "win32",
    hwnd: "132456",
  });
  assert.strictEqual(spec.parse("0"), null); // no foreground window
  assert.strictEqual(spec.parse("not-a-number"), null);
});

test("captureSpec linux/X11 uses xdotool; Wayland has no capture", () => {
  const spec = captureSpec("linux", false);
  assert.strictEqual(spec.cmd, "xdotool");
  assert.deepStrictEqual(spec.args, ["getactivewindow"]);
  assert.deepStrictEqual(spec.parse("6291463\n"), {
    kind: "x11",
    windowId: "6291463",
  });
  assert.strictEqual(spec.parse("xdotool: no active window"), null);
  assert.strictEqual(captureSpec("linux", true), null);
});

test("restoreSpec darwin prefers the pid and falls back to the name", () => {
  const spec = restoreSpec({ kind: "darwin", pid: 742, name: "Terminal" });
  assert.strictEqual(spec.cmd, "osascript");
  const script = spec.args.join(" ");
  assert.match(script, /unix id is 742/);
  assert.match(script, /"Terminal"/);
  // A dead pid token still restores by name alone.
  const byName = restoreSpec({ kind: "darwin", pid: NaN, name: "Terminal" });
  assert.match(byName.args.join(" "), /application process "Terminal"/);
});

test("restoreSpec darwin strips quote characters from the app name", () => {
  const spec = restoreSpec({ kind: "darwin", pid: NaN, name: 'Bad"App\\' });
  assert.doesNotMatch(spec.args.join(" "), /Bad"App/);
});

test("restoreSpec win32 guards IsWindow and taps Alt around SetForegroundWindow", () => {
  const spec = restoreSpec({ kind: "win32", hwnd: "132456" });
  assert.strictEqual(spec.cmd, "powershell.exe");
  const script = spec.args.join(" ");
  assert.match(script, /IsWindow/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /keybd_event/);
  assert.match(script, /\[IntPtr\]132456/);
});

test("restoreSpec win32 sanitizes a non-numeric hwnd", () => {
  const spec = restoreSpec({ kind: "win32", hwnd: "12; Remove-Item x" });
  assert.match(spec.args.join(" "), /\[IntPtr\]12\b/);
  assert.doesNotMatch(spec.args.join(" "), /Remove-Item/);
});

test("restoreSpec x11 activates the captured window id", () => {
  const spec = restoreSpec({ kind: "x11", windowId: "6291463" });
  assert.strictEqual(spec.cmd, "xdotool");
  assert.deepStrictEqual(spec.args, ["windowactivate", "--sync", "6291463"]);
});

test("restoreSpec has nothing to run for wayland/missing tokens", () => {
  assert.strictEqual(restoreSpec({ kind: "wayland" }), null);
  assert.strictEqual(restoreSpec(null), null);
  assert.strictEqual(restoreSpec({ kind: "unknown" }), null);
});
