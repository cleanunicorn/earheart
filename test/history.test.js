const { test } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function loadHistory() {
  const historyPath = require.resolve("../main/history");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = { app: { getPath: () => "/unused" } };
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
