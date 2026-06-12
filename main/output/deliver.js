// Output delivery: put text into the app the user is working in.
//
// "paste" mode writes the text to the clipboard and simulates the platform
// paste keystroke (Cmd+V / Ctrl+V) in the focused application, optionally
// restoring the previous clipboard contents afterwards.
// "clipboard" mode only copies, leaving pasting to the user.
//
// Keystroke simulation per platform:
//   macOS   - osascript (System Events); needs Accessibility permission
//   Windows - PowerShell SendKeys
//   Linux   - wtype or ydotool on Wayland, xdotool on X11; if none of those
//             tools exist we degrade to clipboard-only and tell the caller.

const { clipboard } = require("electron");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function simulatePasteLinux() {
  // Each candidate either succeeds or we move on to the next one.
  const candidates = [];
  if (isWayland()) {
    // wtype: works on wlroots compositors (Sway, Hyprland, ...)
    candidates.push(["wtype", ["-M", "ctrl", "-k", "v", "-m", "ctrl"]]);
    // ydotool: works anywhere its daemon runs (29 = LeftCtrl, 47 = V)
    candidates.push(["ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]]);
    // XWayland apps can still be reachable via xdotool
    candidates.push(["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);
  } else {
    candidates.push(["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]);
  }

  const available = candidates.filter(([cmd]) => commandExists(cmd));
  if (available.length === 0) {
    throw new Error(
      "No keystroke tool found (install wtype, ydotool or xdotool)"
    );
  }
  let lastErr = null;
  for (const [cmd, args] of available) {
    try {
      await execFileAsync(cmd, args);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function simulatePaste() {
  if (process.platform === "darwin") {
    await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  } else if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    ]);
  } else {
    await simulatePasteLinux();
  }
}

let pendingRestore = null;

/**
 * Deliver text to the user.
 * @param {string} text
 * @param {object} cfg - settings.output slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<{method: "paste"|"clipboard"|"cancelled", note?: string}>}
 */
async function deliver(text, cfg, signal) {
  if (signal?.aborted) return { method: "cancelled" };
  // A restore scheduled by a previous dictation must not clobber this one.
  if (pendingRestore) {
    clearTimeout(pendingRestore);
    pendingRestore = null;
  }
  const previous = cfg.restoreClipboard ? clipboard.readText() : null;
  clipboard.writeText(text);

  if (cfg.mode !== "paste") {
    return { method: "clipboard" };
  }

  // Give the target app a moment to be focused (the overlay never takes
  // focus, but the clipboard write itself can need a beat on some systems).
  await sleep(cfg.pasteDelayMs ?? 150);
  if (signal?.aborted) return { method: "cancelled" };
  try {
    await simulatePaste();
  } catch (err) {
    // Text is already on the clipboard, so the user can paste manually.
    return { method: "clipboard", note: `Auto-paste failed: ${err.message}` };
  }

  if (previous !== null) {
    // Wait for the target app to consume the clipboard before restoring it,
    // and only restore if nothing else has written to it since.
    pendingRestore = setTimeout(() => {
      pendingRestore = null;
      if (clipboard.readText() === text) clipboard.writeText(previous);
    }, 1000);
  }
  return { method: "paste" };
}

module.exports = { deliver };
