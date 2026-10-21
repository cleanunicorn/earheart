const { test } = require("node:test");
const assert = require("node:assert/strict");
const ModelSave = require("../renderer/model-save");

const status = {
  stt: [
    { id: "parakeet", label: "Parakeet", installed: true },
    { id: "parakeet-int8", label: "Parakeet int8", installed: false },
    { id: "custom-whisper", label: "Whisper (custom)", custom: true, installed: false },
  ],
  cleanup: [
    { id: "granite", label: "Granite", installed: true },
    { id: "gemma", label: "Gemma", installed: false },
  ],
};
const cfg = ({ stt = "parakeet", sttEngine = "builtin", cleanup = "granite", cleanupEngine = "builtin", enabled = true } = {}) => ({
  stt: { engine: sttEngine, builtin: { model: stt } },
  cleanup: { enabled, engine: cleanupEngine, builtin: { model: cleanup } },
});

test("installed selections need no download", () => {
  assert.deepEqual(ModelSave.missing(cfg(), status), []);
});

test("used lists only the built-in engines the settings would run", () => {
  assert.deepEqual(ModelSave.used(cfg()), [["stt", "parakeet"], ["cleanup", "granite"]]);
  assert.deepEqual(ModelSave.used(cfg({ sttEngine: "remote", enabled: false })), []);
  assert.deepEqual(ModelSave.used(cfg({ cleanupEngine: "remote" })), [["stt", "parakeet"]]);
});

test("a missing speech, cleanup or custom model is listed, speech first", () => {
  assert.deepEqual(ModelSave.missing(cfg({ stt: "parakeet-int8", cleanup: "gemma" }), status), [
    { kind: "stt", modelId: "parakeet-int8", label: "Parakeet int8" },
    { kind: "cleanup", modelId: "gemma", label: "Gemma" },
  ]);
  assert.deepEqual(ModelSave.missing(cfg({ stt: "custom-whisper" }), status), [
    { kind: "stt", modelId: "custom-whisper", label: "Whisper (custom)" },
  ]);
});

test("remote engines and disabled cleanup never download", () => {
  const remote = cfg({ stt: "parakeet-int8", sttEngine: "remote", cleanup: "gemma", cleanupEngine: "remote" });
  assert.deepEqual(ModelSave.missing(remote, status), []);
  assert.deepEqual(ModelSave.missing(cfg({ cleanup: "gemma", enabled: false }), status), []);
  assert.deepEqual(ModelSave.missing(cfg({ stt: "parakeet-int8", sttEngine: "remote", cleanup: "gemma" }), status), [
    { kind: "cleanup", modelId: "gemma", label: "Gemma" },
  ]);
});

test("a selection the model list lacks is an error, never treated as installed", () => {
  assert.throws(() => ModelSave.missing(cfg({ stt: "gone" }), status), /Unknown speech-to-text model: gone/);
  assert.throws(() => ModelSave.missing(cfg({ cleanup: "" }), status), /Unknown cleanup model: \(none\)/);
  // An unknown model behind a remote engine or disabled cleanup is not used.
  assert.deepEqual(ModelSave.missing(cfg({ cleanup: "gone", enabled: false }), status), []);
});
