const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { stubModules, withStubs } = require("./helpers/stub-modules");

// A throwaway module pair: target.js requires dep.js and exposes what it got.
function makeModules(t, targetSource = 'module.exports = { dep: require("./dep") };') {
  // require.cache is keyed by real path; macOS's tmpdir sits behind a symlink.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "earheart-stub-modules-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dep = path.join(dir, "dep.js");
  const target = path.join(dir, "target.js");
  fs.writeFileSync(dep, 'module.exports = "real";');
  fs.writeFileSync(target, targetSource);
  return { dep, target };
}

test("withStubs loads the module against the stubs, then restores require.cache", (t) => {
  const { dep, target } = makeModules(t);
  const loaded = withStubs({ [dep]: "stub" }, [target], () => require(target));
  assert.strictEqual(loaded.dep, "stub");
  assert.strictEqual(require.cache[dep], undefined, "a stub over an uncached path is removed");
  assert.strictEqual(require.cache[target], undefined, "the fresh module is dropped");
  assert.strictEqual(require(target).dep, "real");
});

test("withStubs restores require.cache when the load throws", (t) => {
  const { dep, target } = makeModules(t, 'require("./dep"); throw new Error("boom");');
  const real = require(dep);
  const before = require.cache[dep];
  assert.throws(() => withStubs({ [dep]: "stub" }, [target], () => require(target)), /boom/);
  assert.strictEqual(require.cache[dep], before, "the previously cached module is put back");
  assert.strictEqual(require(dep), real);
  assert.strictEqual(require.cache[target], undefined);
});

test("withStubs drops a stale cached copy of the fresh module before loading", (t) => {
  const { dep, target } = makeModules(t);
  assert.strictEqual(require(target).dep, "real");
  assert.strictEqual(withStubs({ [dep]: "stub" }, [target], () => require(target)).dep, "stub");
});

test("stubModules keeps the stubs in place until restore() is called", (t) => {
  const { dep } = makeModules(t);
  const restore = stubModules({ [dep]: "stub" });
  try {
    assert.strictEqual(require(dep), "stub");
    assert.strictEqual(require(dep), "stub", "still stubbed for a later, lazy require");
  } finally {
    restore();
  }
  assert.strictEqual(require.cache[dep], undefined);
  assert.strictEqual(require(dep), "real");
});
