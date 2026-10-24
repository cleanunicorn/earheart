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

const os = require("node:os");
const { spawn } = require("node:child_process");
const strict = require("node:assert/strict");
const { DEMO_SETTINGS, createDemoProfile, isDemoProfile, removeAfterExit, assertIsolated } = require("../scripts/demo-profile");

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

// The capture runs in a throwaway demo profile, never the contributor's own
// (#295): scripts/demo-profile.js seeds it, and each staging script must point
// userData and logs at it before anything reads them and have it removed
// however the run exits. Whether a real profile stays untouched needs Electron
// itself, so it is checked by hand (see the PR); these pin what makes it so.

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-demo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("demo profile: seeded with the demo settings, nothing else", (t) => {
  const root = tempRoot(t);
  const profile = createDemoProfile({ root });
  strict.ok(profile.dir.startsWith(root));
  strict.deepEqual(fs.readdirSync(profile.dir), ["settings.json"]);
  strict.deepEqual(JSON.parse(fs.readFileSync(path.join(profile.dir, "settings.json"), "utf8")), DEMO_SETTINGS);
  strict.equal(profile.logs, path.join(profile.dir, "logs"));
  profile.remove();
  strict.equal(fs.existsSync(profile.dir), false);
  profile.remove(); // idempotent
  strict.throws(() => createDemoProfile({ root, prefix: "my-" }), /unknown demo profile prefix/);
});

for (const script of ["screenshots.js", "overlay-smoke.js"]) {
  test(`${script}: isolated before any project module loads, and checked once ready`, () => {
    const text = fs.readFileSync(path.join(__dirname, "..", "scripts", script), "utf8");
    const isolated = text.search(/const profile = isolateProfile\(app(, \{ prefix: "[^"]+" \})?\);/);
    strict.ok(isolated > 0, `${script} must call isolateProfile(app)`);
    const firstLocal = Math.min(
      ...[...text.matchAll(/require\((?!"electron"|"node:|"\.\/demo-profile")[^)]*\)/g)].map((m) => m.index)
    );
    strict.ok(firstLocal > isolated, `${script} loads a module before its profile is isolated`);
    const ready = text.indexOf("assertIsolated(app, profile)");
    strict.ok(ready > firstLocal, `${script} must check the isolation once ready`);
  });
}

test("screenshots.js: start on boot shows the demo's value, not the OS login item", () => {
  const init = source.indexOf("ipc.init(");
  for (const stub of ["autostart.isEnabled = () => false", "autostart.apply = () => {}"]) {
    const at = source.indexOf(stub);
    strict.ok(at > 0 && at < init, `${stub} before ipc.init`);
  }
});

test("demo profile: assertIsolated rejects a path outside the profile", (t) => {
  const root = tempRoot(t);
  const profile = createDemoProfile({ root });
  const paths = { userData: profile.dir, sessionData: profile.dir, logs: profile.logs, crashDumps: path.join(profile.dir, "Crashpad") };
  const app = { getPath: (name) => paths[name] };
  strict.doesNotThrow(() => assertIsolated(app, profile));
  paths.logs = path.join(root, "Logs", "Electron");
  strict.throws(() => assertIsolated(app, profile), /logs is .* outside the demo profile/);
  paths.logs = `${profile.dir}-sibling`;
  strict.throws(() => assertIsolated(app, profile), /outside the demo profile/);
});

test("demo profile: removed only after the process that used it exits", async (t) => {
  const root = tempRoot(t);
  const profile = createDemoProfile({ root });
  const marker = path.join(profile.dir, "Local State");
  // Stand in for Electron: until it exits, it keeps the profile alive and
  // written, as Chromium does while shutting down. A delete before the exit
  // would be undone by the next write and fail the check below.
  const owner = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const timer = setInterval(() => {
      fs.mkdirSync(${JSON.stringify(profile.dir)}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(marker)}, "{}");
    }, 20);
    setTimeout(() => clearInterval(timer), 600);
  `], { stdio: "ignore" });
  removeAfterExit(profile.dir, { pid: owner.pid, root });
  await new Promise((resolve) => setTimeout(resolve, 300));
  strict.equal(fs.existsSync(profile.dir), true, "deleted while its owner was still running");
  await new Promise((resolve) => owner.on("exit", resolve));
  for (let i = 0; i < 50 && fs.existsSync(profile.dir); i++) await new Promise((r) => setTimeout(r, 100));
  strict.equal(fs.existsSync(profile.dir), false, "the profile outlived its owner");
});

test("demo profile: removal refuses anything that isn't a demo profile", (t) => {
  const root = tempRoot(t);
  const other = path.join(root, "my-settings");
  fs.mkdirSync(other);
  strict.equal(isDemoProfile(other, root), false);
  strict.equal(isDemoProfile(path.join(root, "nested", "earheart-screenshots-x"), root), false);
  strict.equal(isDemoProfile(path.join(root, "earheart-screenshots-x"), root), true);
  strict.equal(isDemoProfile(path.join(root, "earheart-overlay-smoke-x") + path.sep, root), true);
  strict.throws(() => removeAfterExit(other, { pid: process.pid, root }), /not a demo profile/);
  strict.equal(fs.existsSync(other), true);
});
