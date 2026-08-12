// Transcription history: a small JSON file with the most recent dictations,
// so a transcript is never lost if a paste goes to the wrong window.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./util/logger");

let cached = null;

// Persist writes are async (they sit right before the pipeline's "done"
// status, so a sync write would hold up the overlay) and chained so two adds
// can never interleave their writes to the file. Reads are served from
// `cached`, so callers never observe the write lag.
let writeChain = Promise.resolve();

function persist(json) {
  writeChain = writeChain
    .then(() => fs.promises.writeFile(historyPath(), json))
    .catch((err) => logger.warn("history write failed:", err.message));
}

function historyPath() {
  return path.join(app.getPath("userData"), "history.json");
}

function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    if (!Array.isArray(cached)) cached = [];
  } catch {
    cached = [];
  }
  return cached;
}

function add(entry, cfg) {
  if (!cfg.enabled) return;
  const items = load();
  items.unshift({ ...entry, at: new Date().toISOString() });
  items.length = Math.min(items.length, cfg.limit || 100);
  cached = items;
  persist(JSON.stringify(items, null, 2));
}

function list() {
  return load();
}

function clear() {
  cached = [];
  // Through the chain, so a persist still in flight can't recreate the file
  // after it was deleted.
  writeChain = writeChain
    .then(() => fs.promises.unlink(historyPath()))
    .catch(() => {
      // Already gone.
    });
}

module.exports = { add, list, clear };
