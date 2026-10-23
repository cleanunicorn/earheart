const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function loadHistory(userData = "/unused") {
  const historyPath = require.resolve("../main/history");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = { app: { getPath: () => userData } };
  require.cache[electronPath] = electron;
  delete require.cache[historyPath];
  const history = require(historyPath);
  delete require.cache[historyPath];
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  return history;
}

test("history keeps valid transcripts while ignoring malformed rows", () => {
  const { validEntries } = loadHistory();
  const good = { text: "Keep my words", at: "2026-09-10T00:00:00.000Z" };
  assert.deepStrictEqual(
    validEntries([null, 1, "text", {}, { text: 42 }, good]),
    [good]
  );
});

test("history treats a non-array JSON value as empty", () => {
  const { validEntries } = loadHistory();
  assert.deepStrictEqual(validEntries({ text: "not a history list" }), []);
});

test("history preserves a corrupt file before accepting new entries", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, '[{"text":"old words"');
  const history = loadHistory(dir);

  history.add({ text: "new words" }, { enabled: true, limit: 100 });
  await new Promise((resolve) => setImmediate(resolve));

  const backup = fs.readdirSync(dir).find((name) => name.startsWith("history.json.corrupt-"));
  assert.ok(backup, "the unreadable history should be preserved");
  assert.strictEqual(fs.readFileSync(path.join(dir, backup), "utf8"), '[{"text":"old words"');
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].text, "new words");
  assert.match(saved[0].at, /^20\d\d-/);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("history removes a temp file when the replacement fails", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = loadHistory(dir);
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("simulated rename failure");
  };
  try {
    history.add({ text: "not lost" }, { enabled: true, limit: 100 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    fs.renameSync = originalRename;
  }

  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

/* ---- Clear history only clears what it deleted (#287) ---- */

function historyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const CFG = { enabled: true, limit: 100 };

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`a clear that can't delete the file (${code}) says so and keeps the transcripts`, async (t) => {
    const dir = historyDir(t);
    const history = loadHistory(dir);
    history.add({ text: "keep me" }, CFG);
    await flush();
    const original = fs.unlinkSync;
    fs.unlinkSync = () => {
      throw Object.assign(new Error(`${code}: simulated`), { code });
    };
    let result;
    try {
      result = history.clear();
    } finally {
      fs.unlinkSync = original;
    }
    assert.deepStrictEqual(result, { ok: false, error: code }, "the code, not a message with the user's path");
    assert.deepStrictEqual(history.list().map((e) => e.text), ["keep me"], "still shown, for a retry");
    assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["keep me"], "and still on disk");
  });
}

test("a successful clear stays cleared after a restart", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "gone" }, CFG);
  await flush();
  assert.deepStrictEqual(history.clear(), { ok: true });
  assert.deepStrictEqual(history.list(), []);
  assert.deepStrictEqual(loadHistory(dir).list(), []);
});

test("clearing a history that was never written succeeds", (t) => {
  const history = loadHistory(historyDir(t));
  assert.deepStrictEqual(history.clear(), { ok: true });
  assert.deepStrictEqual(history.list(), []);
});

test("a clear cancels the pending write, so it can't bring the entries back", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "never written" }, CFG);
  assert.deepStrictEqual(history.clear(), { ok: true }); // before the flush runs
  await flush();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.deepStrictEqual(loadHistory(dir).list(), []);
});

test("a failed clear keeps the pending write, so the entry still reaches disk", async (t) => {
  const dir = historyDir(t);
  const history = loadHistory(dir);
  history.add({ text: "first" }, CFG);
  await flush();
  history.add({ text: "pending" }, CFG);
  const original = fs.unlinkSync;
  fs.unlinkSync = () => {
    throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
  };
  try {
    assert.strictEqual(history.clear().ok, false);
  } finally {
    fs.unlinkSync = original;
  }
  await flush();
  assert.deepStrictEqual(loadHistory(dir).list().map((e) => e.text), ["pending", "first"]);
});
