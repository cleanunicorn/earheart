// Guards the coupling between the local setup (Makefile, package.json) and CI
// (ci.yml). Golden rule 5 says a make target and its CI step change together;
// these tests make a one-sided edit fail instead of relying on review.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function readText(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");
}

const makefile = readText("Makefile");
const ciWorkflow = readText(".github", "workflows", "ci.yml");
const pkg = JSON.parse(readText("package.json"));
const lock = JSON.parse(readText("package-lock.json"));

// The recipe lines of a Makefile target, in order.
function recipe(target) {
  const match = makefile.match(new RegExp(`^${target}:.*\\n((?:\\t.+\\n)+)`, "m"));
  assert.ok(match, `Makefile should define a ${target} target`);
  return match[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

// Every `run:` command in ci.yml, in file order, trailing comments dropped.
const ciRuns = ciWorkflow
  .split("\n")
  .map((line) => /^\s*(?:- )?run: (.+?)(?:\s+#.*)?$/.exec(line))
  .filter(Boolean)
  .map((match) => match[1]);

function hasConsecutive(list, sequence) {
  return list.some((_, i) => sequence.every((item, j) => list[i + j] === item));
}

// "22.12" / "22.12.0" → [22, 12, 0]
function parseVersion(text) {
  const [major, minor = 0, patch = 0] = text.split(".").map(Number);
  return [major, minor, patch];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

test("each check target runs the same command as its CI step", () => {
  // CI runs the underlying commands (Windows runners have no GNU Make). The
  // Linux steps match the recipes exactly, xvfb-run included; only test-stt
  // drops its `cd`, because the stt-server job already runs in stt-server/.
  const targets = [
    "install",
    "test",
    "smoke",
    "engine-smoke",
    "overlay-smoke",
    "settings-smoke",
    "test-stt",
  ];
  for (const target of targets) {
    const commands = recipe(target).map((line) => line.replace(/^cd stt-server && /, ""));
    assert.ok(
      hasConsecutive(ciRuns, commands),
      `ci.yml should run ${JSON.stringify(commands)} as consecutive steps (make ${target})`,
    );
  }
});

test("make install matches CI's lockfile-exact install and fetches Electron", () => {
  assert.deepStrictEqual(recipe("install"), ["npm ci", "npx --no install-electron"]);
  // Every job that installs and then tests must fetch Electron before the
  // tests, or parallel test files race its first-use download.
  const installs = ciRuns.filter((command) => command === "npm ci").length;
  const fetches = ciRuns.filter((command) => command === "npx --no install-electron").length;
  assert.ok(installs >= 2, "the app and node-floor jobs both run npm ci");
  assert.strictEqual(fetches, installs, "each npm ci in ci.yml is followed by the Electron fetch");
});

test("engines.node is a floor every locked package accepts", () => {
  const match = /^>=(\d+(?:\.\d+){0,2})$/.exec(pkg.engines.node);
  // ci.yml's node-floor job reads this same field and needs a plain >=X.Y.
  assert.ok(match, `engines.node should be a plain >=X.Y floor, got ${pkg.engines.node}`);
  const floor = parseVersion(match[1]);
  assert.strictEqual(lock.packages[""].engines.node, pkg.engines.node, "lockfile root engines");

  // Only plain ">= X.Y.Z" requirements; ranges with || allow other majors and
  // are not what pins the floor (Electron and its toolchain are plain floors).
  const tooNew = [];
  for (const [name, meta] of Object.entries(lock.packages)) {
    const required = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(meta.engines?.node || "");
    if (required && compareVersions(floor, parseVersion(required[1])) < 0) {
      tooNew.push(`${name} needs ${meta.engines.node}`);
    }
  }
  assert.deepStrictEqual(tooNew, [], `engines.node ${pkg.engines.node} is below locked packages`);
});

test("CI tests the engines.node floor, not only the .nvmrc version", () => {
  assert.match(ciWorkflow, /^\s+floor=\$\(jq -r '\.engines\.node' package\.json\)$/m);
  assert.match(ciWorkflow, /^\s+node-version: \$\{\{ steps\.floor\.outputs\.version \}\}$/m);
});
