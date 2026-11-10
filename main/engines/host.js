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
const logger = require("../util/logger");

// Default silence deadline: a request is rejected after this long with no
// reply AND no progress. Interim progress messages re-arm it (see request()),
// so this bounds a wedged worker, not a slow-but-progressing one — model loads
// and long transcriptions emit nothing and must still fit under it. Missing it
// is treated as a wedge: the worker is retired, so a silent phase that runs
// past it also fails the worker's other requests (they fall back as
// ENGINE_EXITED).
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

// Deadline for the "loadcheck" request (scripts/engine-smoke.js and the
// packaged app's --engine-check). On Apple Silicon it initializes the Metal
// backend, and llama.cpp v0.5.0 compiles all its embedded Metal shader
// libraries then: 34.9 s on the macos-latest runner's paravirtual GPU, 33.7 s
// of it compiling (CI run 36778391767). 120 s leaves ~3.4x headroom.
const LOADCHECK_TIMEOUT_MS = 120000;

// Failures that mean the worker itself is gone or wedged — as opposed to an
// error the worker replied with. Callers branch on these codes (the final
// transcription retries a piece on a fresh worker), never on message text.
function engineError(message, code, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

// A native crash on Windows exits with an NTSTATUS value (0xC0000005 is an
// access violation), which reads as a meaningless 3221225477 in decimal.
function hexExitCode(code) {
  return Number.isInteger(code) ? `0x${(code >>> 0).toString(16).toUpperCase()}` : undefined;
}

// `describe` is an optional callback returning a small, payload-free object
// (which model the engine had loaded) that is added to the exit log. It runs
// when the worker dies, so it must not throw or touch the worker.
function createHost({ serviceName = "earheart-engines", describe } = {}) {
  let child = null;
  let startedAt = 0;
  // The most recent request, kept for the exit log only: a worker that dies
  // between requests is usually dying from the last one it ran.
  let lastRequest = null;
  let nextId = 1;
  const pending = new Map();
  // Notified whenever the worker process goes away, so callers can drop any
  // state they were caching about what the (now gone) worker had loaded.
  const exitListeners = new Set();

  function onExit(fn) {
    exitListeners.add(fn);
  }

  // Drop every in-flight request and tell callers the worker is gone. Called
  // both from the child's own "exit" event and synchronously from stop(), so a
  // deliberate kill resets our state immediately rather than one tick later —
  // by which time a new request may already have forked a successor.
  // `exitCode` is the process's own (undefined for a deliberate stop()): the
  // only trace a native abort leaves, so it rides along on the error.
  function handleGone(exitCode) {
    // Fail anything still in flight so callers fall back instead of hanging.
    for (const entry of pending.values()) {
      entry.reject(engineError("engine process exited", "ENGINE_EXITED", { exitCode }));
    }
    pending.clear();
    // A fresh worker has nothing loaded; let callers reset their caches so the
    // next request re-loads the model instead of assuming it is still resident.
    for (const fn of exitListeners) fn();
  }

  function spawn() {
    if (child) return child;
    // Required lazily so this module can be loaded in non-Electron unit tests.
    const { utilityProcess } = require("electron");
    // Bound to `proc`, not to `child`: stop() (idle eviction) can retire this
    // worker and a new request can fork its successor before this one's async
    // "exit" lands. Every handler below checks it is still the current worker,
    // so a dying process can never clear the successor's state.
    const proc = utilityProcess.fork(path.join(__dirname, "engine-worker.js"), [], {
      serviceName,
      stdio: "inherit",
    });
    child = proc;
    startedAt = Date.now();
    proc.on("message", (msg) => {
      // An error that escaped the worker, sent just before it exits (the
      // worker has no file logger of its own). Log it even from a superseded
      // worker: it is the only record of why that process died.
      if (msg && msg.fatal) {
        logger.error("engine worker fatal error:", {
          serviceName, kind: msg.fatal.kind, message: msg.fatal.message,
        }, msg.fatal.stack || "");
        return;
      }
      if (child !== proc) return; // superseded worker: ignore its late messages
      const entry = msg && pending.get(msg.id);
      if (!entry) return; // late progress/reply for a finished request: drop
      if (msg.progress !== undefined) {
        // Interim progress: the request is still in flight. The protocol
        // promises a finite number; anything else is dropped like an unknown
        // id — a malformed message must not extend the deadline or reach the
        // caller. Valid progress proves the worker is alive, so push the
        // inactivity deadline out.
        if (!Number.isFinite(msg.progress)) return;
        entry.touch();
        if (entry.onProgress) entry.onProgress(msg.progress);
        return;
      }
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "engine error"));
    });
    proc.on("exit", (code) => {
      if (child !== proc) return; // stop() already handled this one
      let context;
      try {
        context = describe?.();
      } catch {
        // diagnostics only; never let them mask the exit
      }
      logger.error("engine worker exited:", {
        serviceName, exitCode: code, exitCodeHex: hexExitCode(code),
        uptimeMs: Date.now() - startedAt,
        lastRequest: lastRequest && { type: lastRequest.type, ageMs: Date.now() - lastRequest.at },
        requests: [...pending.values()].map((entry) => entry.type),
        ...context,
      });
      child = null;
      handleGone(code);
    });
    return proc;
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
   * but visibly progressing inference is never cut off. A request that misses
   * it rejects with ENGINE_TIMEOUT and retires the worker: its other requests
   * reject with ENGINE_EXITED, and the next request forks a fresh one.
   * @param {string} type
   * @param {object} [args]
   * @param {{timeoutMs?: number, onProgress?: (progress: number) => void}} [opts]
   */
  function request(type, args = {}, opts = {}) {
    const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, onProgress } = opts;
    const child = spawn();
    const id = nextId++;
    lastRequest = { type, at: Date.now() };
    return new Promise((resolve, reject) => {
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending.has(id)) {
            logger.warn("engine worker timed out:", { serviceName, type, timeoutMs });
            pending.delete(id);
            reject(engineError(`engine request '${type}' timed out`, "ENGINE_TIMEOUT"));
            // Silence this long means the worker is wedged (a native call that
            // never returns), and every later request would queue behind it.
            // Retire it: its other requests fail as ENGINE_EXITED so their
            // callers fall back, and the next request forks a fresh worker.
            // This request was removed above, so it keeps ENGINE_TIMEOUT.
            stop();
          }
        }, timeoutMs);
      };
      arm();
      pending.set(id, {
        type,
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

  /** True while any request is in flight, i.e. the worker must not be killed. */
  function busy() {
    return pending.size > 0;
  }

  // Kill the worker process. This is how memory actually goes back to the OS —
  // the engines' native allocators hold on to their pages for the life of the
  // process (see unloadIdle in ../index.js) — so it is used for idle eviction,
  // not just for quitting. The next request() forks a fresh worker.
  function stop() {
    if (!child) return;
    const proc = child;
    child = null; // any request from here on forks a successor
    try {
      proc.kill();
    } catch {
      // already gone
    }
    handleGone(); // now, so the async "exit" can't land on the successor
  }

  return { request, stop, busy, onExit };
}

module.exports = { createHost, LOADCHECK_TIMEOUT_MS };
