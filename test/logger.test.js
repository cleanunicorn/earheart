const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { rotateIfLarge } = require("../main/util/logger");

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
