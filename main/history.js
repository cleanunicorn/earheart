// Transcription history: a small JSON file with the most recent dictations,
// so a transcript is never lost if a paste goes to the wrong window.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const logger = require("./util/logger");

let cached = null;

function historyPath() {
  return path.join(app.getPath("userData"), "history.json");
}

function validEntries(value) {
  if (!Array.isArray(value)) return [];
  // A manually edited, partially recovered, or older history file may contain
  // nulls or other JSON values. Only records with transcript text can satisfy
  // the renderer/tray contract; ignore bad rows without hiding valid ones.
  return value.filter(
    (entry) => entry && typeof entry === "object" && typeof entry.text === "string"
  );
}

function load() {
  if (cached) return cached;
  const file = historyPath();
  let corrupt = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) cached = validEntries(parsed);
    else {
      cached = [];
      corrupt = true;
    }
  } catch (err) {
    cached = [];
    corrupt = err instanceof SyntaxError;
  }
  if (corrupt) {
    let backup = `${file}.corrupt-${Date.now()}-${process.pid}`;
    let suffix = 0;
    while (fs.existsSync(backup)) {
      backup = `${file}.corrupt-${Date.now()}-${process.pid}-${++suffix}`;
    }
    try {
      fs.renameSync(file, backup);
      logger.warn("corrupt history preserved at", backup);
    } catch (renameErr) {
      logger.warn("corrupt history backup failed:", renameErr.message);
    }
  }
  return cached;
}

// Persistence is deferred one event-loop turn and coalesced: add() returns
// immediately (the disk write used to sit between delivery and the pipeline's
// "done" status), a burst of adds writes once, and the flush still runs
// within milliseconds — before any later quit event can be processed — so an
// entry is durably on disk by the time the user could exit. The write itself
// goes through a temp file + rename (same pattern as model-manager/updates),
// so a crash mid-write can never leave a truncated history.json behind; if an
// older write did leave one, load() preserves it before starting fresh.
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    if (!flushScheduled) return; // superseded by clear()
    flushScheduled = false;
    const file = historyPath();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The write may have failed before the temp file was created.
      }
      logger.warn("history write failed:", err.message);
    }
  });
}

function add(entry, cfg) {
  if (!cfg.enabled) return;
  const items = load();
  items.unshift({ ...entry, at: new Date().toISOString() });
  items.length = Math.min(items.length, cfg.limit || 100);
  cached = items;
  scheduleFlush();
}

function list() {
  return load();
}

function clear() {
  cached = [];
  // Cancel any pending flush so it can't recreate the file after the delete.
  flushScheduled = false;
  try {
    fs.unlinkSync(historyPath());
  } catch (err) {
    // ENOENT just means there was nothing to delete; anything else (EPERM,
    // EBUSY — an AV scanner holding the file) means the transcripts are still
    // on disk after the UI said they're gone, which deserves a trace.
    if (err.code !== "ENOENT") logger.warn("history clear failed:", err.message);
  }
}

module.exports = { add, list, clear, validEntries };
