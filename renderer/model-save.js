// Which built-in models a settings object would use but are not downloaded,
// speech first. Settings' Save downloads these before it persists anything.
const ModelSave = (() => {
  const KIND_LABELS = { stt: "speech-to-text", cleanup: "cleanup" };
  // [kind, modelId] for each built-in engine the settings would run.
  const used = (cfg) => [
    ...(cfg.stt.engine === "builtin" ? [["stt", cfg.stt.builtin.model]] : []),
    ...(cfg.cleanup.enabled && cfg.cleanup.engine === "builtin" ? [["cleanup", cfg.cleanup.builtin.model]] : []),
  ];
  const missing = (cfg, status) =>
    used(cfg).flatMap(([kind, modelId]) => {
      const info = status[kind].find((m) => m.id === modelId);
      // Never guess "installed" for a model the main process doesn't list.
      if (!info) throw new Error(`Unknown ${KIND_LABELS[kind]} model: ${modelId || "(none)"}`);
      return info.installed ? [] : [{ kind, modelId, label: info.label }];
    });
  return { used, missing };
})();
if (typeof module !== "undefined") module.exports = ModelSave;
