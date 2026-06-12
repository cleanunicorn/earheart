// Global hotkey registration.
//
// Electron's globalShortcut works on Windows, macOS and Linux/X11. On some
// Wayland desktops (notably GNOME) apps cannot grab global keys; for those,
// bind a system shortcut to `earheart --toggle` instead — the second instance
// forwards the toggle to the running app and exits (see main.js).

const { globalShortcut } = require("electron");

let current = null;

/**
 * (Re)register the dictation hotkey.
 * @param {string} accelerator - Electron accelerator string
 * @param {() => void} onTrigger
 * @returns {{ok: boolean, error?: string}}
 */
function register(accelerator, onTrigger) {
  if (current) {
    globalShortcut.unregister(current);
    current = null;
  }
  if (!accelerator) return { ok: false, error: "No hotkey configured" };
  try {
    const ok = globalShortcut.register(accelerator, onTrigger);
    if (!ok) {
      return {
        ok: false,
        error: `Could not register "${accelerator}" (already in use, or your desktop blocks global shortcuts — see the Wayland note in Settings).`,
      };
    }
    current = accelerator;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Invalid hotkey "${accelerator}": ${err.message}` };
  }
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  current = null;
}

module.exports = { register, unregisterAll };
