// A throwaway, deterministic profile for the README screenshots (#295).
//
// scripts/screenshots.js used Electron's default profile, so the shots showed
// the contributor's own hotkeys, microphone and setup, and running it reached
// the real settings migration. This makes a fresh profile in a temp dir, seeded
// with fixed demo settings; the caller points userData (and logs) at it before
// anything reads either, and removes it when done. Nothing here reads or
// writes the real profile.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PREFIX = "earheart-screenshots-";

// What the staged windows show, stated rather than inherited from defaults a
// later change might move. Everything else comes from main/settings.js
// DEFAULTS, which are code and so the same on every machine. No history file:
// an empty history is deterministic, and no shot lists it.
const DEMO_SETTINGS = Object.freeze({
  hotkey: "CommandOrControl+Shift+Space",
  pauseHotkey: "",
  discardHotkey: "",
  correctHotkey: "",
  startOnBoot: false,
  output: { mode: "paste", restoreClipboard: true },
  audio: { deviceId: "" },
  cleanup: { dictionary: [] },
});

/**
 * Create a seeded demo profile under `root` (the OS temp dir by default).
 * @param {{ root?: string }} [options]
 * @returns {{ dir: string, logs: string, remove: () => void }}
 */
function createDemoProfile({ root = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(root, PREFIX));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(DEMO_SETTINGS, null, 2), { mode: 0o600 });
  return {
    dir,
    logs: path.join(dir, "logs"),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Only ever a profile this module made: a direct child of a temp root, named
// with the prefix. Guards the recursive delete against a wrong path.
function isDemoProfile(dir, root = os.tmpdir()) {
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === path.resolve(root) && path.basename(resolved).startsWith(PREFIX);
}

// Polls for `pid` to exit (up to 2 minutes), then deletes the profile.
const CLEANER = `
const fs = require("node:fs");
const [dir, pid] = process.argv.slice(-2);
const deadline = Date.now() + 120000;
(function wait() {
  try {
    process.kill(Number(pid), 0);
    if (Date.now() < deadline) return setTimeout(wait, 200);
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
})();
`;

/**
 * Delete the profile once process `pid` has exited. Chromium writes its own
 * state (Local State, Preferences, caches) into userData while it shuts down,
 * after any code of ours can run, and Windows keeps those files locked until
 * the process ends — so the delete runs in a small detached process (the same
 * binary, as plain Node) that outlives this one.
 * @param {string} dir a directory createDemoProfile made
 * @param {number} [pid] the process to outlive (this one by default)
 * @param {string} [root] the temp root it was made under
 */
function removeAfterExit(dir, pid = process.pid, root = os.tmpdir()) {
  if (!isDemoProfile(dir, root)) throw new Error(`refusing to remove ${dir}: not a demo profile`);
  const child = spawn(process.execPath, ["-e", CLEANER, dir, String(pid)], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
}

module.exports = { DEMO_SETTINGS, createDemoProfile, isDemoProfile, removeAfterExit };
