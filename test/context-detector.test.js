// The destination detector (#336): bounded, never throws, and returns the
// hostname only. A fake `exec` stands in for osascript, so this proves the
// control flow, not what macOS does — that needs a real-OS check.

const { test } = require("node:test");
const assert = require("node:assert");
const { withStubs } = require("./helpers/stub-modules");

const detectorPath = require.resolve("../main/context-detector");
const loggerPath = require.resolve("../main/util/logger");

function load() {
  const logs = [];
  const mod = withStubs(
    { [loggerPath]: { info() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) } },
    [detectorPath],
    () => require(detectorPath)
  );
  return { ...mod, logs };
}

function fakeExec(frontmost, urls = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    const script = args[1];
    calls.push(script);
    if (script.includes("System Events")) return `${frontmost}\n`;
    const m = script.match(/application id "([^"]+)"/);
    const out = urls[m?.[1]];
    if (out instanceof Error) throw out;
    return `${out}\n`;
  };
  return { exec, calls };
}

test("not macOS: unsupported, and nothing is executed", async () => {
  const { createContextDetector } = load();
  let ran = false;
  const d = createContextDetector({ platform: "linux", exec: async () => { ran = true; return ""; } });
  assert.strictEqual(d.supported, false);
  assert.deepStrictEqual(await d.detect(), { supported: false, app: null, host: null });
  assert.strictEqual(ran, false);
});

test("a frontmost browser yields its bundle id and only the host", async () => {
  const { createContextDetector, logs } = load();
  const { exec, calls } = fakeExec("com.google.Chrome, Google Chrome", {
    "com.google.Chrome": "https://user:pw@www.GitHub.com/org/private-repo/issues/1?token=secret#x",
  });
  const out = await createContextDetector({ platform: "darwin", exec }).detect();
  assert.deepStrictEqual(out, { supported: true, app: { id: "com.google.Chrome", name: "Google Chrome" }, host: "github.com" });
  assert.ok(!JSON.stringify(out).includes("secret"));
  assert.ok(calls[1].includes("active tab"));
  assert.ok(logs.every((l) => !/secret|private-repo/.test(l)));
});

test("Safari is asked with its own tab term", async () => {
  const { createContextDetector } = load();
  const { exec, calls } = fakeExec("com.apple.Safari, Safari", { "com.apple.Safari": "https://example.com/" });
  const out = await createContextDetector({ platform: "darwin", exec }).detect();
  assert.strictEqual(out.host, "example.com");
  assert.ok(calls[1].includes("current tab"));
});

test("a non-browser frontmost app is never asked for a URL, and no browser is touched", async () => {
  const { createContextDetector } = load();
  const { exec, calls } = fakeExec("com.apple.Terminal, Terminal");
  const out = await createContextDetector({ platform: "darwin", exec }).detect();
  assert.deepStrictEqual(out, { supported: true, app: { id: "com.apple.Terminal", name: "Terminal" }, host: null });
  assert.strictEqual(calls.length, 1, "only the frontmost-app query ran");
});

test("browser automation denied: app stays known, host unavailable, URL never logged", async () => {
  const { createContextDetector, logs } = load();
  const { exec } = fakeExec("com.brave.Browser, Brave", {
    "com.brave.Browser": new Error("Not authorized to send Apple events to Brave (https://secret.example/path)"),
  });
  const out = await createContextDetector({ platform: "darwin", exec }).detect();
  assert.deepStrictEqual([out.app.id, out.host], ["com.brave.Browser", null]);
  assert.ok(logs.length > 0 && logs.every((l) => !l.includes("secret.example")));
});

test("a page that is not a website (about:blank, file:) gives no host", async () => {
  const { createContextDetector } = load();
  for (const url of ["about:blank", "file:///Users/me/doc.html", "missing value"]) {
    const { exec } = fakeExec("com.apple.Safari, Safari", { "com.apple.Safari": url });
    assert.strictEqual((await createContextDetector({ platform: "darwin", exec }).detect()).host, null, url);
  }
});

test("a failing or hanging osascript is unavailable and bounded, never a rejection", async () => {
  const { createContextDetector } = load();
  const failing = createContextDetector({ platform: "darwin", exec: async () => { throw new Error("boom"); } });
  assert.deepStrictEqual(await failing.detect(), { supported: false, app: null, host: null });
  const hung = createContextDetector({ platform: "darwin", timeoutMs: 20, exec: () => new Promise(() => {}) });
  const started = Date.now();
  assert.deepStrictEqual(await hung.detect(), { supported: false, app: null, host: null });
  assert.ok(Date.now() - started < 1000);
});
