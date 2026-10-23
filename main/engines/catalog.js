// Keeps the model registry's custom models in step with the settings (#204).
//
// Custom models live in settings.json (`customModels`); the registry is what
// resolves a model id to its files. They used to be synced only inside the
// IPC layer — at ipc.init() and after its own add/remove handlers — so
// anything that resolved a custom model before ipc.init(), or outside it (a
// script, a test, any other writer of settings), saw only the built-in
// models. Bound once at the composition root (main/main.js), the registry
// takes the saved list at once and every saved change after it, whoever
// saves it.

const registry = require("./registry");

/**
 * @param {{ get: () => object, onChanged: (fn: (change: {current: object}) => void) => () => void }} settings
 * @returns {() => void} unbinds
 */
function bindCustomModels(settings) {
  registry.setCustomModels(settings.get().customModels || []);
  // Most saves (an overlay drag, a tray toggle) leave the list alone: only a
  // changed one is re-registered, so a dropped row isn't re-logged each time.
  return settings.onChanged(({ previous, current }) => {
    if (JSON.stringify(previous?.customModels) === JSON.stringify(current.customModels)) return;
    registry.setCustomModels(current.customModels || []);
  });
}

module.exports = { bindCustomModels };
