// Global hotkey registration.
//
// Electron's globalShortcut works on Windows, macOS and Linux/X11. On some
// Wayland desktops (notably GNOME) apps cannot grab global keys; for those,
// bind a system shortcut to `earheart --toggle` (and `earheart --pause`)
// instead — the second instance forwards the action to the running app and
// exits (see main.js).

const { globalShortcut } = require("electron");

// Named slots ("record", "pause"), each holding at most one accelerator.
const registered = new Map();

/**
 * (Re)register a named global hotkey slot.
 *
 * An empty accelerator unregisters the slot and reports `{ok, empty}`: for an
 * optional hotkey that is a valid resting state; callers that require a
 * binding (the record hotkey) turn `empty` into their own error.
 *
 * @param {string} name - slot name, used in collision messages
 * @param {string} accelerator - Electron accelerator string ("" = unbound)
 * @param {() => void} onTrigger
 * @returns {{ok: boolean, empty?: boolean, error?: string}}
 */
function register(name, accelerator, onTrigger) {
  const prev = registered.get(name);
  if (prev) {
    globalShortcut.unregister(prev);
    registered.delete(name);
  }
  if (!accelerator) return { ok: true, empty: true };
  // Two slots on one combo would silently shadow each other; refuse up front
  // with a clearer message than globalShortcut's generic failure.
  for (const [otherName, otherAccelerator] of registered) {
    if (otherAccelerator === accelerator) {
      return {
        ok: false,
        error: `"${accelerator}" is already used by the ${otherName} hotkey`,
      };
    }
  }
  try {
    const ok = globalShortcut.register(accelerator, onTrigger);
    if (!ok) {
      return {
        ok: false,
        error: `Could not register "${accelerator}" (already in use, or your desktop blocks global shortcuts — see the Wayland note in Settings).`,
      };
    }
    registered.set(name, accelerator);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Invalid hotkey "${accelerator}": ${err.message}` };
  }
}

function unregisterAll() {
  globalShortcut.unregisterAll();
  registered.clear();
}

module.exports = { register, unregisterAll };
