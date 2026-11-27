// Where Earheart's icon menu lives, for copy that sends people there: the
// tray (Windows, Linux), or on macOS the menu bar. One place decides, so every
// notice and note names the same spot. Read per call, never at load time,
// so tests can stand in for another platform.

/**
 * @param {{ tray: T, menuBar: T }} choices what to say for each
 * @param {string} [platform] process.platform value; defaults to this machine
 * @returns {T}
 * @template T
 */
function trayOrMenuBar({ tray, menuBar }, platform = process.platform) {
  return platform === "darwin" ? menuBar : tray;
}

module.exports = { trayOrMenuBar };
