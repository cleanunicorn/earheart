// Turn a stored Electron accelerator into something a person reads.
//
// Electron stores cross-platform notation ("CommandOrControl+Shift+Space"),
// but people read the keys the way the platform's own menus name them.
// Notifications and hotkey errors use this (see hotkeys.js); Settings and the
// wizard use displayHotkey in renderer/hotkey-capture.js. Both read the one
// table in renderer/hotkey-names.js.
//
// Pure string work, kept out of main.js so it can be tested directly —
// main.js binds Electron at module scope and cannot be required from a test.

const { isWaylandSession } = require("./session");
const { formatHotkey } = require("../../renderer/hotkey-names");

/**
 * Human-readable form of an Electron accelerator (renderer/hotkey-names.js
 * holds the table, shared with the Settings and wizard capture fields).
 * @param {string} accelerator e.g. "CommandOrControl+Shift+Space"
 * @param {string} [platform] process.platform value; defaults to this machine
 * @returns {string} e.g. "Ctrl+Shift+Space" ("" for an unbound hotkey)
 */
function prettyHotkey(accelerator, platform = process.platform) {
  return formatHotkey(accelerator, platform);
}

/**
 * Why a hotkey may have failed to register, pointing only at help the user can
 * find here: Settings shows its Wayland note only in a Linux Wayland session.
 * @param {string} [platform] process.platform value; defaults to this machine
 * @param {boolean} [wayland] a Wayland session; defaults to this machine's
 * @returns {string} a clause to put inside parentheses after the error
 */
function registrationHint(platform = process.platform, wayland = isWaylandSession()) {
  return platform === "linux" && wayland
    ? "already in use, or your desktop blocks global shortcuts — see the Wayland note in Settings"
    : "already in use by another app";
}

module.exports = { prettyHotkey, registrationHint };
