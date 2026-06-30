// File logger for the main process. Errors and warnings are appended to a log
// file under Electron's standard logs directory, so a failure is recoverable
// after the fact — in a packaged app there is no console to watch. Everything is
// mirrored to the console too, so `npm start` still shows it inline.
//
// Logging is strictly best-effort: a failure to open or write the file must
// never throw into a caller or crash startup.

const fs = require("node:fs");
const path = require("node:path");

let logPath = null;
let ready = false;
let handlersInstalled = false;

// Keep the file bounded without pulling in a rotation dependency: when it has
// grown past this at startup, the previous log is rolled to `.1` (one
// generation kept) before a fresh stream is opened.
const MAX_BYTES = 5 * 1024 * 1024;

// app.getPath("logs") is the platform's conventional logs location
// (~/.config/<app>/logs on Linux, ~/Library/Logs/<app> on macOS,
// %APPDATA%\<app>\logs on Windows). Fall back to userData, then cwd, so the
// logger degrades gracefully if a path can't be resolved.
function resolveDir() {
  try {
    const { app } = require("electron");
    try {
      return app.getPath("logs");
    } catch {
      return app.getPath("userData");
    }
  } catch {
    return process.cwd();
  }
}

function rotateIfLarge(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // No existing file, or the rename failed — not worth blocking startup on.
  }
}

function fmt(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, args) {
  const body = args.map(fmt).join(" ");
  // Mirror to the console (dev visibility), preserving the existing prefix.
  const console_ =
    level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  console_(`[earheart] ${body}`);
  // Best-effort append to the file. Synchronous so an error is on disk before
  // the next line runs — a crash right after logging still keeps the record.
  try {
    if (ready) fs.appendFileSync(logPath, `${new Date().toISOString()} [${level}] ${body}\n`);
  } catch {
    // Never let logging throw into the caller.
  }
}

// Open the log file and start capturing escaped errors. Safe to call more than
// once; only the first call has any effect. Call after the app is ready so the
// logs path resolves.
function init() {
  if (!ready) {
    try {
      const dir = resolveDir();
      fs.mkdirSync(dir, { recursive: true });
      logPath = path.join(dir, "earheart.log");
      rotateIfLarge(logPath);
      ready = true;
    } catch (err) {
      console.warn(`[earheart] file logging unavailable: ${err.message}`);
    }
  }
  if (!handlersInstalled) {
    handlersInstalled = true;
    // Catch anything that escapes a try/catch. We log rather than exit: this is
    // a tray app, and silently dropping the user into a dead state is worse than
    // recording the fault and staying up.
    process.on("uncaughtException", (err) => write("ERROR", ["uncaughtException:", err]));
    process.on("unhandledRejection", (reason) =>
      write("ERROR", ["unhandledRejection:", reason])
    );
  }
  if (logPath) write("INFO", [`logging to ${logPath}`]);
  return logPath;
}

module.exports = {
  init,
  error: (...args) => write("ERROR", args),
  warn: (...args) => write("WARN", args),
  info: (...args) => write("INFO", args),
  getLogPath: () => logPath,
};
