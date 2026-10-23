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
const { DEMO_SETTINGS, createDemoProfile, isDemoProfile, removeAfterExit } = require("../scripts/demo-profile");

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
// (#295): scripts/demo-profile.js seeds it, and screenshots.js must point
// userData and logs at it before anything reads them, and have it removed
// however the run exits.

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-demo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for the contributor's real profile, with settings unlike the demo.
function sentinelProfile(root, name, hotkey) {
  const dir = path.join(root, name, "earheart");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ hotkey, audio: { deviceId: `${name}-usb-mic` } }));
  return { dir, file, before: fs.readFileSync(file, "utf8"), entries: fs.readdirSync(dir) };
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
  profile.remove(); // idempotent: a second exit path finds nothing to remove
});

test("demo profile: two different real profiles stage the same demo, and neither is touched", (t) => {
  const root = tempRoot(t);
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const staged = [];
  for (const [name, hotkey] of [["alice", "Alt+F1"], ["bob", "CommandOrControl+Alt+J"]]) {
    const real = sentinelProfile(root, name, hotkey);
    process.env.HOME = process.env.XDG_CONFIG_HOME = process.env.APPDATA = path.dirname(real.dir);
    const profile = createDemoProfile({ root });
    staged.push(fs.readFileSync(path.join(profile.dir, "settings.json"), "utf8"));
    profile.remove();
    strict.equal(fs.readFileSync(real.file, "utf8"), real.before, `${name}'s settings changed`);
    strict.deepEqual(fs.readdirSync(real.dir), real.entries, `${name}'s profile gained files`);
  }
  strict.equal(staged[0], staged[1]);
});

test("screenshots: the demo profile is in place before anything reads userData or logs", () => {
    const userData = source.indexOf('app.setPath("userData", profile.dir)');
  const logs = source.indexOf('app.setPath("logs", profile.logs)');
  strict.ok(userData > 0 && logs > 0, "screenshots.js must set userData and logs to the demo profile");
  // Every project module (main/ and the other scripts) loads after both.
  const firstLocal = Math.min(
    ...[...source.matchAll(/require\((?!"electron"|"node:|"\.\/demo-profile")[^)]*\)/g)].map((m) => m.index)
  );
  strict.ok(firstLocal > Math.max(userData, logs), "a module loads before the demo profile is set");
  // Removal is armed at once, so every exit path (a crash included) cleans up.
  const armed = source.indexOf("removeAfterExit(profile.dir)");
  strict.ok(armed > logs && armed < firstLocal, "the demo profile's removal must be armed before anything runs");
});

test("demo profile: removed once the process that used it exits", async (t) => {
  const root = tempRoot(t);
  const profile = createDemoProfile({ root });
  // Stand in for Electron: a process that writes into the profile until it
  // exits, as Chromium does while shutting down.
  const owner = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(profile.dir, "Local State"))}, "{}"); }, 300);
    setTimeout(() => {}, 400);
  `], { stdio: "ignore" });
  removeAfterExit(profile.dir, owner.pid, root);
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
  strict.throws(() => removeAfterExit(other, process.pid, root), /not a demo profile/);
  strict.equal(fs.existsSync(other), true);
});
