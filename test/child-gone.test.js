// The child-process-gone log for engine workers: which events are written and
// which are deliberately skipped.

const { test } = require("node:test");
const assert = require("node:assert");
const { install, logChildGone } = require("../main/engines/child-gone");

function capture() {
  const errors = [];
  return { errors, logger: { error: (...args) => errors.push(args) } };
}

test("child-gone: a crashed engine worker is logged with reason and hex exit code", () => {
  const { errors, logger } = capture();
  logChildGone(logger, {
    type: "Utility", reason: "crashed", exitCode: 3221225477, serviceName: "earheart-stt",
  });
  assert.deepStrictEqual(errors, [["engine worker process gone:", {
    serviceName: "earheart-stt", reason: "crashed", exitCode: 3221225477, exitCodeHex: "0xC0000005",
  }]]);
});

test("child-gone: the worker is recognised by name as well as serviceName", () => {
  const { errors, logger } = capture();
  logChildGone(logger, { type: "Utility", reason: "oom", exitCode: 1, name: "earheart-cleanup" });
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0][1].reason, "oom");
});

test("child-gone: deliberate kills, clean exits and other processes are not logged", () => {
  const { errors, logger } = capture();
  logChildGone(logger, { type: "Utility", reason: "killed", exitCode: 1, serviceName: "earheart-stt" });
  logChildGone(logger, { type: "Utility", reason: "clean-exit", exitCode: 0, serviceName: "earheart-stt" });
  logChildGone(logger, { type: "Utility", reason: "crashed", exitCode: 1, name: "Network Service" });
  logChildGone(logger, { type: "GPU", reason: "crashed", exitCode: 1 });
  logChildGone(logger, undefined);
  assert.deepStrictEqual(errors, []);
});

test("child-gone: install listens on the app's child-process-gone event", () => {
  const { errors, logger } = capture();
  const handlers = {};
  install({ on: (event, fn) => { handlers[event] = fn; } }, logger);
  handlers["child-process-gone"]({}, { type: "Utility", reason: "launch-failed", exitCode: 1, serviceName: "earheart-stt" });
  assert.strictEqual(errors.length, 1);
});
