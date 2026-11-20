// Exercise a downloaded catalog model through Earheart's real utilityProcess.
// xvfb-run -a npx electron scripts/stt-model-smoke.js --no-sandbox \
//   <models-directory> <model-id> <speech.wav> [expected text fragment]
// Downloads are deliberately separate: use model-manager.download first.
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHost } = require("../main/engines/host");
const registry = require("../main/engines/registry");
const manager = require("../main/engines/model-manager");

app.whenReady().then(async () => {
  const host = createHost({ serviceName: "earheart-stt-model-smoke" });
  try {
    const [base, modelId, audio, expected] = process.argv.slice(2).filter(a => a !== "--no-sandbox");
    assert.ok(base && modelId && audio, "Expected models directory, model id, and speech WAV path");
    const model = registry.getModel("stt", modelId);
    assert.ok(model, `Unknown model: ${modelId}`);
    const baseDir = path.resolve(base);
    assert.ok(manager.isInstalled(baseDir, model), "Download and verify the model first");
    const runtime = await host.request("load-stt", {
      dir: manager.modelDir(baseDir, model), sherpa: model.sherpa, modelId,
    }, { timeoutMs: 120000 });
    const result = await host.request("transcribe", {
      wav: fs.readFileSync(audio),
    }, { timeoutMs: 120000 });
    assert.ok(result.text.trim(), "Expected a nonempty speech transcript");
    if (expected) assert.ok(result.text.toLowerCase().includes(expected.toLowerCase()), result.text);
    console.log(JSON.stringify({ modelId, runtime, ...result }, null, 2));
    host.stop();
    app.exit(0);
  } catch (error) {
    console.error(error);
    host.stop();
    app.exit(1);
  }
});
