// Logs Electron's `child-process-gone` for the engine workers. The host's own
// exit log (host.js) says that a worker died and with what code; Chromium also
// knows WHY — crashed, ran out of memory, failed to launch — which the exit
// code alone can't tell apart.
//
// Reasons that are not logged: "clean-exit" is a normal exit, and "killed" is
// what an idle eviction or app quit looks like (host.stop()). Logging those
// would write a line every idle window. A worker killed from outside still
// gets host.js's exit line.

const WORKER_PREFIX = "earheart-";
const IGNORED_REASONS = new Set(["clean-exit", "killed"]);

// Hex as well as decimal: a Windows native crash is an NTSTATUS value.
function hexExitCode(code) {
  return Number.isInteger(code) ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined;
}

function isEngineWorker(details) {
  const names = [details?.serviceName, details?.name];
  return details?.type === "Utility" && names.some((n) => typeof n === "string" && n.startsWith(WORKER_PREFIX));
}

function logChildGone(logger, details) {
  if (!isEngineWorker(details) || IGNORED_REASONS.has(details.reason)) return;
  logger.error("engine worker process gone:", {
    serviceName: details.serviceName ?? details.name,
    reason: details.reason,
    exitCode: details.exitCode,
    exitCodeHex: hexExitCode(details.exitCode),
  });
}

function install(app, logger) {
  app.on("child-process-gone", (_event, details) => logChildGone(logger, details));
}

module.exports = { install, logChildGone };
