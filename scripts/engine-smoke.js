// Boots the engine utilityProcess worker and round-trips a `ping`, proving the
// worker forks and the parent<->worker IPC works. It does not download a model
// or load the native runtimes (the `ping` handler touches neither), so it is a
// fast, deterministic guard against the worker failing to start or the message
// plumbing regressing. Run under Electron:
//
//   xvfb-run -a npx electron scripts/engine-smoke.js --no-sandbox   # Linux
//   npx electron scripts/engine-smoke.js                            # macOS/Win

const { app } = require("electron");
const host = require("../main/engines/host");

app.whenReady().then(async () => {
  try {
    const res = await host.request("ping", {}, [], 30000);
    if (!res || res.pong !== true) {
      throw new Error(`unexpected ping reply: ${JSON.stringify(res)}`);
    }
    console.log("[engine-smoke] worker ping ok");
    host.stop();
    app.exit(0);
  } catch (err) {
    console.error("[engine-smoke] failed:", (err && err.message) || err);
    host.stop();
    app.exit(1);
  }
});
