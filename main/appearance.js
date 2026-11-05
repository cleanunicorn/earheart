// Appearance (#348): the light / dark / system palette every window wears.
//
// The setting maps 1:1 onto Electron's nativeTheme.themeSource. Chromium then
// resolves `prefers-color-scheme` in every renderer from it, so the pages pick
// the matching block of renderer/tokens.css on their first paint and re-theme
// live — on a Save, or on an OS flip in "system" mode — without a reload, so
// nothing a window holds (unsaved Settings edits included) is touched. Native
// dialogs, menus and scrollbars follow the same source.
//
// Main's only part beyond that is the framed windows' native background
// (main/windows.js inkColor), repainted whenever nativeTheme reports a change.

const { nativeTheme } = require("electron");
const settings = require("./settings");
const windows = require("./windows");

// Electron's themeSource values, which the setting uses as-is (main/settings.js
// normalizes to the same list; test/appearance.test.js pins both).
const APPEARANCES = ["system", "light", "dark"];

// The themeSource for a stored value; anything unknown follows the OS.
function themeSourceFor(value) {
  return APPEARANCES.includes(value) ? value : "system";
}

function apply(value) {
  const source = themeSourceFor(value);
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}

let started = false;

// Call before the first window is created, so its ink and first paint already
// match. Idempotent.
function init() {
  if (started) return;
  started = true;
  apply(settings.get().appearance);
  settings.onChanged(({ current }) => apply(current.appearance));
  nativeTheme.on("updated", () => windows.refreshInk());
}

module.exports = { init, themeSourceFor, APPEARANCES };
