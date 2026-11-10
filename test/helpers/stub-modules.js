// Load a module against stubbed dependencies by planting fake entries in
// require.cache, then put the cache back the way it was.
//
// Node's default `node --test` glob also runs this file (it matches
// `**/test/**/*.js`); it defines no tests, so that run is a no-op.

const Module = require("node:module");

// Install `stubs` ({ absolutePath: exports }) in require.cache. Returns a
// restore() that puts each path back to its previous entry, or removes it.
// Use this directly when the stubs must outlive the require (a module that
// requires its dependency lazily, or a stub kept for a whole file).
function stubModules(stubs) {
  const previous = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    previous.set(p, require.cache[p]);
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = exports;
    require.cache[p] = m;
  }
  return () => {
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  };
}

// Install `stubs`, drop the `fresh` paths from require.cache so load()
// requires them anew against the stubs, and return what load() returns.
// Afterwards — also when load() throws — the fresh paths are dropped again
// and every stubbed path is restored.
function withStubs(stubs, fresh, load) {
  const restore = stubModules(stubs);
  // A path that is both stubbed and "fresh" would have its stub thrown away
  // and the real module loaded (on Windows, real PowerShell). The stub wins.
  const dropped = fresh.filter((p) => !Object.prototype.hasOwnProperty.call(stubs, p));
  for (const p of dropped) delete require.cache[p];
  try {
    return load();
  } finally {
    for (const p of dropped) delete require.cache[p];
    restore();
  }
}

module.exports = { stubModules, withStubs };
