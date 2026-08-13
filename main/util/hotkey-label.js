// Turn a stored Electron accelerator into something a person reads.
//
// Settings and the wizard show the accelerator verbatim ("CommandOrControl+
// Shift+Space") because that is what gets registered, but a notification is
// prose: it has to name the keys the way the platform's own menus do.
//
// Pure string work, kept out of main.js so it can be tested directly —
// main.js binds Electron at module scope and cannot be required from a test.

// Modifier spellings per platform. Electron accepts several aliases for the
// same modifier (CommandOrControl/CmdOrCtrl, Command/Cmd, Control/Ctrl,
// Alt/Option, Super/Meta), so every alias maps here — a hand-edited
// settings.json is as valid an input as one the capture field wrote.
const MODIFIERS = {
  commandorcontrol: { darwin: "Cmd", win32: "Ctrl", linux: "Ctrl" },
  cmdorctrl: { darwin: "Cmd", win32: "Ctrl", linux: "Ctrl" },
  command: { darwin: "Cmd", win32: "Cmd", linux: "Cmd" },
  cmd: { darwin: "Cmd", win32: "Cmd", linux: "Cmd" },
  control: { darwin: "Control", win32: "Ctrl", linux: "Ctrl" },
  ctrl: { darwin: "Control", win32: "Ctrl", linux: "Ctrl" },
  alt: { darwin: "Option", win32: "Alt", linux: "Alt" },
  option: { darwin: "Option", win32: "Alt", linux: "Alt" },
  altgr: { darwin: "AltGr", win32: "AltGr", linux: "AltGr" },
  shift: { darwin: "Shift", win32: "Shift", linux: "Shift" },
  super: { darwin: "Cmd", win32: "Win", linux: "Super" },
  meta: { darwin: "Cmd", win32: "Win", linux: "Super" },
};

/**
 * Human-readable form of an Electron accelerator.
 * @param {string} accelerator e.g. "CommandOrControl+Shift+Space"
 * @param {string} [platform] process.platform value; defaults to this machine
 * @returns {string} e.g. "Ctrl+Shift+Space" ("" for an unbound hotkey)
 */
function prettyHotkey(accelerator, platform = process.platform) {
  if (!accelerator) return "";
  // Unknown parts (the key itself: "Space", "K", "Up") pass through as typed.
  return accelerator
    .split("+")
    .map((part) => {
      const mod = MODIFIERS[part.trim().toLowerCase()];
      return mod ? mod[platform] || mod.linux : part.trim();
    })
    .join("+");
}

module.exports = { prettyHotkey };
