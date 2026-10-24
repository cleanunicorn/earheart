// A throwaway, deterministic profile for Electron scripts that stage the real
// windows: the README screenshots and the overlay smoke (#295).
//
// scripts/screenshots.js used Electron's default profile, so the shots showed
// the contributor's own hotkeys, microphone and setup, and running it reached
// the real settings migration. isolateProfile makes a fresh profile in a temp
// dir, seeded with fixed demo settings, points userData and logs at it before
// anything reads either, and has it deleted once the process exits. Nothing
// here reads or writes the real profile.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Every profile this module makes is named with one of these, and only those
// are ever deleted (isDemoProfile).
const PREFIXES = ["earheart-screenshots-", "earheart-overlay-smoke-"];

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
 * @param {{ root?: string, prefix?: string }} [options]
 * @returns {{ dir: string, logs: string, remove: () => void }}
 */
function createDemoProfile({ root = os.tmpdir(), prefix = PREFIXES[0] } = {}) {
  if (!PREFIXES.includes(prefix)) throw new Error(`unknown demo profile prefix ${prefix}`);
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(DEMO_SETTINGS, null, 2), { mode: 0o600 });
  return {
    dir,
    logs: path.join(dir, "logs"),
    remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

// Only ever a profile this module made: a direct child of a temp root, named
// with a known prefix. Guards the recursive delete against a wrong path.
function isDemoProfile(dir, root = os.tmpdir()) {
  const resolved = path.resolve(dir);
  const name = path.basename(resolved);
  return path.dirname(resolved) === path.resolve(root) && PREFIXES.some((prefix) => name.startsWith(prefix));
}

// Polls for `pid` to exit, then deletes the profile. A run still alive after
// the deadline (a hung capture) keeps its profile: deleting under a live
// owner is never right, and the temp dir is the OS's to reap. Retries cover
// Chromium's helper processes letting go of files a moment after the main one.
const CLEANER = `
const fs = require("node:fs");
const [dir, pid] = process.argv.slice(-2);
const deadline = Date.now() + 10 * 60 * 1000;
(function wait() {
  try {
    process.kill(Number(pid), 0);
    if (Date.now() < deadline) setTimeout(wait, 200);
    return;
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
})();
`;

/**
 * Delete the profile once process `pid` has exited. Chromium writes its own
 * state (Local State, Preferences, caches) into userData while it shuts down,
 * after any code of ours can run, and Windows keeps those files locked until
 * the process ends — so the delete runs in a small detached process (the same
 * binary, as plain Node) that outlives this one.
 * @param {string} dir a directory createDemoProfile made
 * @param {{ pid?: number, root?: string, onError?: (err: Error) => void }} [options]
 */
function removeAfterExit(dir, { pid = process.pid, root = os.tmpdir(), onError = () => {} } = {}) {
  if (!isDemoProfile(dir, root)) throw new Error(`refusing to remove ${dir}: not a demo profile`);
  const child = spawn(process.execPath, ["-e", CLEANER, dir, String(pid)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // Not the checkout: Windows won't remove a directory a process sits in.
    cwd: os.tmpdir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", onError);
  child.unref();
}

/**
 * Run this Electron process in a fresh demo profile. Call before requiring
 * anything that reads userData or logs (settings, history, models, the
 * logger), and before `ready`.
 * @param {import("electron").App} app
 * @param {{ prefix?: string }} [options]
 * @returns {{ dir: string, logs: string, remove: () => void }}
 */
function isolateProfile(app, { prefix } = {}) {
  const profile = createDemoProfile({ prefix });
  app.setPath("userData", profile.dir);
  app.setPath("logs", profile.logs);
  removeAfterExit(profile.dir, {
    // No cleaner (the spawn was refused): remove what we can as the app quits.
    onError: () => app.once("will-quit", () => {
      try {
        profile.remove();
      } catch {
        // Best effort; the profile is in the temp dir.
      }
    }),
  });
  return profile;
}

/**
 * After `ready`: throw unless every profile path Electron resolved sits in the
 * demo profile — the runtime half of what the source-order test pins.
 * @param {import("electron").App} app
 * @param {{ dir: string }} profile
 */
function assertIsolated(app, profile) {
  for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
    const resolved = path.resolve(app.getPath(name));
    if (resolved !== profile.dir && !resolved.startsWith(profile.dir + path.sep)) {
      throw new Error(`${name} is ${resolved}, outside the demo profile ${profile.dir}`);
    }
  }
}

module.exports = {
  DEMO_SETTINGS,
  createDemoProfile,
  isDemoProfile,
  removeAfterExit,
  isolateProfile,
  assertIsolated,
};
