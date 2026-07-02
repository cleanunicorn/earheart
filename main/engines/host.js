// Parent side of an engine worker. Each host owns one utilityProcess, lazily
// forks it, routes request/reply messages by id, and restarts the worker if it
// dies. All of the Electron-specific plumbing lives here so the rest of the app
// talks to plain async functions.
//
// `createHost({ serviceName })` returns an independent host instance. The app
// runs two of them — one for STT, one for cleanup — so a long inference or a
// native crash in one engine never blocks or takes down the other. They share
// the same engine-worker.js code; each instance is only ever sent the request
// types for its engine.

const path = require("node:path");

// Default per-request ceiling: model loads and long transcriptions can take a
// while, but a wedged worker should never hang a caller forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

function createHost({ serviceName = "earheart-engines" } = {}) {
  let child = null;
  let nextId = 1;
  const pending = new Map();
  // Notified whenever the worker process goes away, so callers can drop any
  // state they were caching about what the (now gone) worker had loaded.
  const exitListeners = new Set();

  function onExit(fn) {
    exitListeners.add(fn);
  }

  function spawn() {
    if (child) return child;
    // Required lazily so this module can be loaded in non-Electron unit tests.
    const { utilityProcess } = require("electron");
    child = utilityProcess.fork(path.join(__dirname, "engine-worker.js"), [], {
      serviceName,
      stdio: "inherit",
    });
    child.on("message", (msg) => {
      const entry = msg && pending.get(msg.id);
      if (!entry) return; // late progress/reply for a finished request: drop
      if (msg.progress !== undefined) {
        // Interim progress: the request is still in flight. The protocol
        // promises a finite number; anything else is dropped like an unknown
        // id — a malformed message must not extend the deadline or reach the
        // caller. Valid progress proves the worker is alive, so push the
        // inactivity deadline out.
        if (typeof msg.progress !== "number" || !Number.isFinite(msg.progress)) return;
        entry.touch();
        if (entry.onProgress) entry.onProgress(msg.progress);
        return;
      }
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
   * Send a request to the worker and await its reply. Message payloads are
   * structured-cloned across the process boundary; Electron's utilityProcess
   * has no transfer list for plain buffers (only MessagePortMain), so callers
   * pass any binary data as ordinary fields.
   *
   * The worker may post interim `{ id, progress }` messages before its reply;
   * they invoke `onProgress` without settling the promise, and each one resets
   * the timeout — the ceiling bounds *silence*, not total duration, so a slow
   * but visibly progressing inference is never cut off.
   * @param {string} type
   * @param {object} [args]
   * @param {{timeoutMs?: number, onProgress?: (progress: any) => void}} [opts]
   */
  function request(type, args = {}, opts = {}) {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, onProgress } = opts;
    const child = spawn();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`engine request '${type}' timed out`));
          }
        }, timeoutMs);
      };
      arm();
      pending.set(id, {
        onProgress,
        touch: arm,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.postMessage({ id, type, ...args });
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

  return { request, stop, onExit };
}

module.exports = { createHost };
