// How a stored Electron accelerator reads on a given OS: the platform's own
// key names, never Electron's cross-platform notation. "CommandOrControl+Shift+
// Space" reads "Ctrl+Shift+Space" on Linux and Windows, "Cmd+Shift+Space" on
// macOS. Display only; what gets registered stays the stored accelerator.
//
// The one table for every place a hotkey is shown: main's notifications and
// hotkey errors (main/util/hotkey-label.js, CommonJS) and the Settings and
// wizard capture fields (renderer/hotkey-capture.js, classic-script global
// `EarheartHotkeyNames`), like renderer/i18n.js. No dependencies.
(function (root) {
  // Electron accepts several aliases for the same modifier (CommandOrControl/
  // CmdOrCtrl, Command/Cmd, Control/Ctrl, Alt/Option, Super/Meta), so every
  // alias maps here: a hand-edited settings.json is as valid an input as one
  // the capture field wrote.
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

  const KEYS = {
    num0: "Numpad 0", num1: "Numpad 1", num2: "Numpad 2", num3: "Numpad 3", num4: "Numpad 4",
    num5: "Numpad 5", num6: "Numpad 6", num7: "Numpad 7", num8: "Numpad 8", num9: "Numpad 9",
    numdec: "Numpad Decimal", numadd: "Numpad +", numsub: "Numpad -", nummult: "Numpad *", numdiv: "Numpad /",
  };

  /**
   * @param {string} accelerator e.g. "CommandOrControl+Shift+Space"
   * @param {string} platform a process.platform value; unknown ones read as Linux
   * @returns {string} e.g. "Ctrl+Shift+Space" ("" for an unbound hotkey)
   */
  function formatHotkey(accelerator, platform) {
    if (!accelerator) return "";
    // Unknown parts (the key itself: "Space", "K", "Up") pass through as typed.
    return String(accelerator)
      .split("+")
      .map((part) => {
        const name = part.trim().toLowerCase();
        const mod = Object.hasOwn(MODIFIERS, name) ? MODIFIERS[name] : null;
        if (mod) return mod[platform] || mod.linux;
        return Object.hasOwn(KEYS, name) ? KEYS[name] : part.trim();
      })
      .join("+");
  }

  const api = { formatHotkey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EarheartHotkeyNames = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
