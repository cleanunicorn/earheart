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
  return settings.onChanged(({ current }) => registry.setCustomModels(current.customModels || []));
}

module.exports = { bindCustomModels };
