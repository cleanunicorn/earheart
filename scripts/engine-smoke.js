// Boots the engine utilityProcess worker and round-trips two requests:
//
//   ping       — proves the worker forks and parent<->worker IPC works.
//   loadcheck  — require/import both native addons (sherpa-onnx-node and
//                node-llama-cpp) without loading any model, proving the
//                prebuilt .node binaries link against this Electron's ABI. A
//                major Electron bump moves the N-API/V8 surface, so this is the
//                guard that catches an addon that no longer loads — a failure
//                that would otherwise only surface the first time a user
//                dictates. No model download needed, so it stays fast and
//                deterministic. Run under Electron:
//
//   xvfb-run -a npx electron scripts/engine-smoke.js --no-sandbox   # Linux
//   npx electron scripts/engine-smoke.js                            # macOS/Win

const { app } = require("electron");
const { createHost } = require("../main/engines/host");

// One worker is enough to prove the addons load; the app runs two of these
// (STT + cleanup) but they fork the same engine-worker.js.
const host = createHost({ serviceName: "earheart-engine-smoke" });

app.whenReady().then(async () => {
  try {
    const ping = await host.request("ping", {}, { timeoutMs: 30000 });
    if (!ping || ping.pong !== true) {
      throw new Error(`unexpected ping reply: ${JSON.stringify(ping)}`);
    }
    console.log("[engine-smoke] worker ping ok");

    const engines = await host.request("loadcheck", {}, { timeoutMs: 30000 });
    if (!engines || engines.stt !== true || engines.cleanup !== true) {
      throw new Error(
        `native addon load failed: ${JSON.stringify(engines)}`
      );
    }
    console.log("[engine-smoke] native engines load ok (stt + cleanup)");

    host.stop();
    app.exit(0);
  } catch (err) {
    console.error("[engine-smoke] failed:", (err && err.message) || err);
    host.stop();
    app.exit(1);
  }
});
