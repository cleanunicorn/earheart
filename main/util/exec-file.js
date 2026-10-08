// Run a platform tool, preserving timeout and abort information on failure.
const { execFile } = require("node:child_process");

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...options }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // Prefer the tool's own stderr, but keep the raw error underneath so a
      // caller can tell a timeout or abort apart from a real failure.
      const wrapped = new Error(stderr?.trim() || err.message, { cause: err });
      wrapped.killed = !!err.killed;
      wrapped.aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
      reject(wrapped);
    });
  });
}

module.exports = { execFileAsync };
