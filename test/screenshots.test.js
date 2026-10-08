// Guards the one thing scripts/screenshots.js must keep doing that no gate
// runs: fail loudly. Its body used to run as an uncaught whenReady callback,
// so any rejection left Electron alive and `make screenshots` hung until
// killed (#181). The script needs a display and rewrites tracked PNGs, so it
// stays out of the gate; this reads the file as text, like
// test/ipc-contract.test.js, and pins the catch → app.exit(1) wiring.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "screenshots.js"), "utf8");

test("screenshots.js runs its body through a catch that exits non-zero", () => {
  assert.match(source, /^async function main\(\) \{/m, "the body is a named main()");
  const wiring = source.match(/app\.whenReady\(\)\.then\(main\)\.catch\(\(err\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(wiring, "whenReady runs main with a catch");
  assert.match(wiring[1], /console\.error\(/, "the catch prints the error");
  assert.match(wiring[1], /app\.exit\(1\)/, "the catch exits 1");
  // No stray uncaught whenReady callback crept back in.
  assert.strictEqual((source.match(/whenReady\(\)/g) || []).length, 1);
});
