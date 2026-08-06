// Small child-process helpers shared by the modules that shell out to
// platform tools (output delivery, focus capture/restore). Pure Node — no
// Electron imports — so the modules built on top stay unit-testable.

const { execFile } = require("node:child_process");
const fs = require("node:fs");

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout);
    });
  });
}

function commandExists(cmd) {
  const dirs = (process.env.PATH || "").split(":");
  return dirs.some((dir) => {
    try {
      fs.accessSync(`${dir}/${cmd}`, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function isWayland() {
  return (
    process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY
  );
}

module.exports = { execFileAsync, commandExists, isWayland };
