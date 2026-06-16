// Downloads and tracks the in-process models (STT + cleanup).
//
// Everything is keyed off a base directory (Electron's userData/models in the
// app; a temp dir in tests) so this module has no Electron dependency and is
// unit-testable against a local HTTP server.
//
// Each file is streamed to `<name>.part`, optionally checksum-verified, then
// renamed into place — so a half-finished download never looks complete. A
// model counts as installed once every file is present and a `.complete`
// marker has been written.

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

/** True once every file is on disk and the completion marker exists. */
function isInstalled(baseDir, model) {
  const dir = modelDir(baseDir, model);
  if (!fs.existsSync(path.join(dir, MARKER))) return false;
  return model.files.every((f) => fs.existsSync(path.join(dir, f.name)));
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
    // Skip files already pulled in by an earlier (interrupted) run.
    if (fs.existsSync(dest)) {
      received += file.bytes || 0;
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

  await fsp.writeFile(path.join(modelDir(baseDir, model), MARKER), "");
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
