// Tests for the pure half of scripts/e2e-latency.js: its flag parser and the
// --models resolution. The measurement itself needs Electron, a WAV and the
// models; what is pinned here is the argument handling that the audit found
// wrong (#181): a bare --debug-chunks was silently dropped, a relative
// --models dangled, and an empty --models= linked the cwd in.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { parseArgs, resolveModels } = require("../scripts/e2e-latency");

test("e2e-latency parseArgs: --k=v, bare flags, and Electron passthrough", () => {
  const argv = parseArgs([
    "electron",
    "scripts/e2e-latency.js",
    "--no-sandbox",
    "--wav=/a b/c.wav",
    "--debug-chunks",
    "--config=a=b",
    "--talk=30",
  ]);
  assert.deepStrictEqual(argv, {
    "no-sandbox": true,
    wav: "/a b/c.wav",
    "debug-chunks": true,
    config: "a=b", // only the first "=" splits
    talk: "30",
  });
  // An explicit empty value stays an empty string (so a caller can reject it).
  assert.deepStrictEqual(parseArgs(["--models="]), { models: "" });
  assert.deepStrictEqual(parseArgs([]), {});
});

test("e2e-latency resolveModels: relative paths resolve against the cwd", () => {
  const exists = (p) => p === path.resolve("/work", "models");
  assert.deepStrictEqual(resolveModels("models", "/work", exists), { dir: path.resolve("/work", "models") });
  assert.deepStrictEqual(resolveModels(path.resolve("/work", "models"), "/elsewhere", exists), {
    dir: path.resolve("/work", "models"),
  });
  // Not given: nothing to link.
  assert.deepStrictEqual(resolveModels(undefined, "/work", exists), { dir: undefined });
});

test("e2e-latency resolveModels: missing, empty and bare values are errors, never the cwd", () => {
  const exists = () => true;
  assert.match(resolveModels("", "/work", exists).error, /must name an existing models directory \(got ""\)/);
  assert.match(resolveModels(true, "/work", exists).error, /must name an existing models directory/);
  assert.match(resolveModels("nope", "/work", () => false).error, /--models=nope does not exist/);
  for (const bad of ["", true]) assert.strictEqual(resolveModels(bad, "/work", exists).dir, undefined);
});
