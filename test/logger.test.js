const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const { rotateIfLarge } = require("../main/util/logger");

function loadLogger(logsDir) {
  const loggerPath = require.resolve("../main/util/logger");
  const electronPath = require.resolve("electron");
  const savedElectron = require.cache[electronPath];
  const savedLogger = require.cache[loggerPath];
  const electron = new Module(electronPath, null);
  electron.filename = electronPath;
  electron.loaded = true;
  electron.exports = { app: { getPath: () => logsDir } };
  require.cache[electronPath] = electron;
  delete require.cache[loggerPath];
  const logger = require(loggerPath);
  logger.init();
  delete require.cache[loggerPath];
  if (savedLogger) require.cache[loggerPath] = savedLogger;
  if (savedElectron) require.cache[electronPath] = savedElectron;
  else delete require.cache[electronPath];
  return logger;
}

test("log rotation replaces the previous backup generation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-logger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "earheart.log");
  fs.writeFileSync(file, "new-current-log");
  fs.writeFileSync(`${file}.1`, "old-backup");

  rotateIfLarge(file, 4);

  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "new-current-log");
});

test("log rotation leaves a file within the limit untouched", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-logger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "earheart.log");
  fs.writeFileSync(file, "short");

  rotateIfLarge(file, 5);

  assert.strictEqual(fs.readFileSync(file, "utf8"), "short");
  assert.strictEqual(fs.existsSync(`${file}.1`), false);
});

test("logging rotates an oversized file while the app is running", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-logger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = loadLogger(dir);
  const file = path.join(dir, "earheart.log");
  fs.writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));

  logger.info("after rotation");

  assert.strictEqual(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(5 * 1024 * 1024 + 1));
  assert.match(fs.readFileSync(file, "utf8"), /after rotation/);
});

test("an error's cause chain reaches the log", (t) => {
  // A wrapped error keeps the technical reason in `cause` (transport-error.js:
  // "Couldn't reach <host>" over undici's "fetch failed" over ECONNREFUSED); a
  // stack alone leaves it out.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-logger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = loadLogger(dir);
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
  const err = new Error("Couldn't reach 127.0.0.1:9", { cause: new TypeError("fetch failed", { cause: refused }) });

  logger.error("pipeline failed:", err);

  const text = fs.readFileSync(path.join(dir, "earheart.log"), "utf8");
  assert.match(text, /Couldn't reach 127\.0\.0\.1:9/);
  assert.match(text, /Caused by: TypeError: fetch failed/);
  assert.match(text, /Caused by: Error: connect ECONNREFUSED 127\.0\.0\.1:9/);
});

test("a self-referencing cause chain is cut off, not followed forever", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-logger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = loadLogger(dir);
  const err = new Error("loop");
  err.cause = err;

  logger.error(err);

  const text = fs.readFileSync(path.join(dir, "earheart.log"), "utf8");
  assert.ok((text.match(/Caused by/g) || []).length <= 3, text);
});
