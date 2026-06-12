// Optional convenience: spawn the local STT server (or any command) when the
// app starts, and stop it on quit. Most setups will run the server separately
// (or use a remote service), so this is off by default.

const { spawn } = require("node:child_process");

let child = null;

function start(cfg) {
  if (!cfg.autoStart || !cfg.command || child) return;
  // The command is user-provided configuration (like a shell alias), so run
  // it through the shell to support arguments and PATH lookup.
  child = spawn(cfg.command, {
    shell: true,
    stdio: "ignore",
    detached: false,
  });
  child.on("exit", (code) => {
    console.log(`[earheart] STT server process exited (code ${code})`);
    child = null;
  });
  child.on("error", (err) => {
    console.error(`[earheart] failed to start STT server: ${err.message}`);
    child = null;
  });
}

function stop() {
  if (!child) return;
  try {
    child.kill();
  } catch {
    // Process already gone.
  }
  child = null;
}

function isRunning() {
  return child !== null;
}

module.exports = { start, stop, isRunning };
