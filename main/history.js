// Transcription history: a small JSON file with the most recent dictations,
// so a transcript is never lost if a paste goes to the wrong window.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

let cached = null;

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
  fs.writeFileSync(historyPath(), JSON.stringify(items, null, 2));
}

function list() {
  return load();
}

function clear() {
  cached = [];
  try {
    fs.unlinkSync(historyPath());
  } catch {
    // Already gone.
  }
}

module.exports = { add, list, clear };
