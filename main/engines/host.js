// Parent side of the engine worker. Lazily forks the utilityProcess, routes
// request/reply messages by id, and restarts the worker if it dies. All of the
// Electron-specific plumbing lives here so the rest of the app talks to plain
// async functions.

const path = require("node:path");

let child = null;
let nextId = 1;
const pending = new Map();
// Notified whenever the worker process goes away, so callers can drop any
// state they were caching about what the (now gone) worker had loaded.
const exitListeners = new Set();

function onExit(fn) {
  exitListeners.add(fn);
  return fn;
}

function spawn() {
  if (child) return child;
  // Required lazily so this module can be loaded in non-Electron unit tests.
  const { utilityProcess } = require("electron");
  child = utilityProcess.fork(path.join(__dirname, "engine-worker.js"), [], {
    serviceName: "earheart-engines",
    stdio: "inherit",
  });
  child.on("message", (msg) => {
    const entry = msg && pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || "engine error"));
  });
  child.on("exit", () => {
    child = null;
    // Fail anything still in flight so callers fall back instead of hanging.
    for (const entry of pending.values()) {
      entry.reject(new Error("engine process exited"));
    }
    pending.clear();
    // A fresh worker has nothing loaded; let callers reset their caches so the
    // next request re-loads the model instead of assuming it is still resident.
    for (const fn of exitListeners) fn();
  });
  return child;
}

/**
 * Send a request to the worker and await its reply.
 * @param {string} type
 * @param {object} [args]
 * @param {ArrayBuffer[]} [transfer] - buffers to move (not copy)
 * @param {number} [timeoutMs]
 */
function request(type, args = {}, transfer = [], timeoutMs = 180000) {
  const proc = spawn();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`engine request '${type}' timed out`));
      }
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    proc.postMessage({ id, type, ...args }, transfer);
  });
}

function stop() {
  if (child) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    child = null;
  }
}

module.exports = { request, stop, onExit };
