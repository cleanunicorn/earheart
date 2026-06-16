// Downloads and tracks the in-process models (STT + cleanup).
//
// Everything is keyed off a base directory (Electron's userData/models in the
// app; a temp dir in tests) so this module has no Electron dependency and is
// unit-testable against a local HTTP server.
//
// Each file is streamed to `<name>.part`, optionally checksum-verified, then
// renamed into place — so a half-finished download never looks complete. A
// model counts as installed once every file is present and a `.complete`
// marker has been written. The marker records each file's size as actually
// written, so `isInstalled` can reject a model whose files were later truncated
// (e.g. a disk filling up) rather than trusting mere file presence.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { totalBytes } = require("./registry");

const MARKER = ".complete";

function modelDir(baseDir, model) {
  return path.join(baseDir, model.kind, model.id);
}

function filePath(baseDir, model, file) {
  return path.join(modelDir(baseDir, model), file.name);
}

// Read the completion marker. Returns the recorded {name: size} map, an empty
// map for a legacy (pre-size) marker, or null when no marker is present.
function readMarker(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, MARKER), "utf8");
  } catch {
    return null; // no marker: not installed
  }
  if (!raw) return {}; // legacy empty marker: presence-only
  try {
    const parsed = JSON.parse(raw);
    return (parsed && parsed.files) || {};
  } catch {
    return {};
  }
}

/**
 * True once the completion marker exists and every file is on disk at the size
 * recorded when it was downloaded. The recorded sizes (not the registry's
 * approximate `bytes`) are the source of truth, so a finished file that was
 * later truncated is treated as not installed.
 */
function isInstalled(baseDir, model) {
  const dir = modelDir(baseDir, model);
  const sizes = readMarker(dir);
  if (sizes === null) return false;
  return model.files.every((f) => {
    const p = path.join(dir, f.name);
    const expected = sizes[f.name];
    if (expected === undefined) return fs.existsSync(p); // legacy marker
    try {
      return fs.statSync(p).size === expected;
    } catch {
      return false; // missing or unreadable
    }
  });
}

/** Free a model's disk space. */
async function remove(baseDir, model) {
  await fsp.rm(modelDir(baseDir, model), { recursive: true, force: true });
}

// A pass-through stream that counts bytes and (optionally) hashes them, so we
// can report progress and verify integrity in a single pass over the data.
function makeMeter(onChunk, hash) {
  return new Transform({
    transform(chunk, _enc, cb) {
      if (hash) hash.update(chunk);
      onChunk(chunk.length);
      cb(null, chunk);
    },
  });
}

async function downloadFile(baseDir, model, file, { onBytes, signal }) {
  const dir = modelDir(baseDir, model);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, file.name);
  const part = `${dest}.part`;

  // No HTTP range/resume: a failed or cancelled transfer discards the `.part`
  // and the next attempt re-fetches the whole file from the start. Completed
  // files are still skipped (below), so only the in-flight file is repeated.
  const res = await fetch(file.url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed for ${file.name}: HTTP ${res.status}`);
  }

  const hash = file.sha256 ? crypto.createHash("sha256") : null;
  await pipeline(
    Readable.fromWeb(res.body),
    makeMeter(onBytes, hash),
    fs.createWriteStream(part),
    { signal }
  );

  if (hash) {
    const got = hash.digest("hex");
    if (got !== file.sha256) {
      await fsp.rm(part, { force: true });
      throw new Error(`Checksum mismatch for ${file.name}`);
    }
  }
  await fsp.rename(part, dest); // atomic: only a verified file lands in place
}

/**
 * Download every file of a model, reporting aggregate progress.
 *
 * @param {string} baseDir
 * @param {object} model - a registry entry
 * @param {object} [opts]
 * @param {(p: {received:number,total:number,fraction:number,file:string}) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
async function download(baseDir, model, { onProgress, signal } = {}) {
  // Denominator for the progress bar. Registry sizes are approximate, so clamp
  // the reported fraction to <=1 and let the final event snap to 100%.
  const total = totalBytes(model) || 1;
  let received = 0;
  const report = (file) =>
    onProgress?.({
      received,
      total,
      fraction: Math.min(received / total, 0.999),
      file,
    });

  for (const file of model.files) {
    const dest = filePath(baseDir, model, file);
    // Skip files already pulled in by an earlier (interrupted) run. Count the
    // real on-disk size, not the registry's approximate `bytes`, so the
    // aggregate progress stays monotonic when a resumed download mixes
    // already-present files with freshly streamed ones.
    if (fs.existsSync(dest)) {
      received += fs.statSync(dest).size;
      report(file.name);
      continue;
    }
    await downloadFile(baseDir, model, file, {
      signal,
      onBytes: (n) => {
        received += n;
        report(file.name);
      },
    });
  }

  // Record each file's actual on-disk size in the marker, so a later integrity
  // check can catch truncation without relying on the registry's approximate
  // sizes.
  const sizes = {};
  for (const file of model.files) {
    sizes[file.name] = fs.statSync(filePath(baseDir, model, file)).size;
  }
  await fsp.writeFile(
    path.join(modelDir(baseDir, model), MARKER),
    JSON.stringify({ files: sizes })
  );
  onProgress?.({ received: total, total, fraction: 1, file: null });
}

module.exports = {
  modelDir,
  filePath,
  isInstalled,
  remove,
  download,
  MARKER,
};
