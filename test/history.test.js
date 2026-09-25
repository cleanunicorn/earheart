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
