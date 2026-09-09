// Downloads and tracks the in-process models (STT + cleanup).
//
// Everything is keyed off a base directory (Electron's userData/models in the
// app; a temp dir in tests) so this module has no Electron dependency and is
// unit-testable against a local HTTP server.
//
// Each file is streamed to `<name>.part`, with resume metadata in
// `<name>.part.json`, then validated against its configured size and optional
// SHA-256 checksum before being renamed into place — so a half-finished
// download never looks complete. A model counts as installed once every file
// is present and a `.complete` marker has been written. The marker records each
// file's size as actually written, so `isInstalled` can reject a model whose
// files were later truncated
// (e.g. a disk filling up) rather than trusting mere file presence.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { totalBytes } = require("./registry");

const MARKER = ".complete";

function assertPathSegment(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid model ${label}`);
  }
  return value;
}

function modelDir(baseDir, model) {
  const kind = assertPathSegment(model.kind, "kind");
  const id = assertPathSegment(model.id, "id");
  return path.join(baseDir, kind, id);
}

function filePath(baseDir, model, file) {
  return path.join(
    modelDir(baseDir, model),
    assertPathSegment(file.name, "filename")
  );
}

function partialPaths(dest) {
  const part = `${dest}.part`;
  return { part, meta: `${part}.json` };
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
    const p = filePath(baseDir, model, f);
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

// A pass-through stream that counts and hashes bytes as they are written.
function makeMeter(onChunk, hash) {
  return new Transform({
    transform(chunk, _enc, cb) {
      hash?.update(chunk);
      onChunk(chunk.length);
      cb(null, chunk);
    },
  });
}

async function updateHashFromFile(filename, hash, signal) {
  signal?.throwIfAborted();
  for await (const chunk of fs.createReadStream(filename)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  signal?.throwIfAborted();
}

async function hashFile(filename, signal) {
  const hash = crypto.createHash("sha256");
  await updateHashFromFile(filename, hash, signal);
  return hash.digest("hex");
}

async function verifyFile(filename, file, signal) {
  let stat;
  try {
    stat = await fsp.stat(filename);
  } catch {
    return false;
  }
  if (file.bytes && stat.size !== file.bytes) return false;
  if (file.sha256 && (await hashFile(filename, signal)) !== file.sha256) return false;
  return true;
}

async function discardPartial(paths) {
  await Promise.all([
    fsp.rm(paths.part, { force: true }),
    fsp.rm(paths.meta, { force: true }),
  ]);
}

async function readPartial(dest, file) {
  const paths = partialPaths(dest);
  let stat;
  let meta;
  try {
    [stat, meta] = await Promise.all([
      fsp.stat(paths.part),
      fsp.readFile(paths.meta, "utf8").then(JSON.parse),
    ]);
  } catch {
    await discardPartial(paths);
    return null;
  }
  const expectedBytes = file.bytes || null;
  if (
    !meta ||
    meta.url !== file.url ||
    meta.expectedBytes !== expectedBytes ||
    stat.size <= 0 ||
    (expectedBytes && stat.size > expectedBytes) ||
    (!file.sha256 && !ifRangeValue(meta))
  ) {
    await discardPartial(paths);
    return null;
  }
  return { ...paths, size: stat.size, metadata: meta };
}

function responseMetadata(res, file, totalBytesHint) {
  return {
    url: file.url,
    expectedBytes: file.bytes || null,
    etag: res.headers.get("etag") || null,
    lastModified: res.headers.get("last-modified") || null,
    totalBytes: file.bytes || totalBytesHint || null,
  };
}

function ifRangeValue(metadata) {
  // RFC 9110 forbids weak entity tags in If-Range. Last-Modified is the next
  // best validator; with neither, the final SHA-256 still prevents installation
  // of bytes combined from incompatible representations.
  const etag = typeof metadata.etag === "string" ? metadata.etag : null;
  const lastModified = typeof metadata.lastModified === "string"
    ? metadata.lastModified
    : null;
  if (etag && !etag.startsWith("W/")) return etag;
  return lastModified;
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || "");
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function resumedResponseIsCompatible(res, partial, file) {
  const range = parseContentRange(res.headers.get("content-range"));
  if (!range || range.start !== partial.size || range.end < range.start) return false;
  if (file.bytes && range.total !== file.bytes) return false;
  if (partial.metadata.totalBytes && range.total !== partial.metadata.totalBytes) return false;

  const oldEtag = typeof partial.metadata.etag === "string"
    ? partial.metadata.etag
    : null;
  const oldModified = typeof partial.metadata.lastModified === "string"
    ? partial.metadata.lastModified
    : null;
  const strongEtag = oldEtag && !oldEtag.startsWith("W/");
  if (strongEtag && res.headers.get("etag") !== oldEtag) return false;
  if (!strongEtag && oldModified && res.headers.get("last-modified") !== oldModified) {
    return false;
  }
  // A weak ETag cannot go in If-Range, but it is still useful as a consistency
  // check when Last-Modified is unavailable.
  if (!strongEtag && !oldModified && oldEtag && res.headers.get("etag") !== oldEtag) {
    return false;
  }
  return true;
}

async function fetchFull(file, signal) {
  const res = await fetch(file.url, { signal });
  if (res.status !== 200 || !res.body) {
    throw new Error(`Download failed for ${file.name}: HTTP ${res.status}`);
  }
  return res;
}

async function downloadFile(baseDir, model, file, { partial, onSize, signal }) {
  const dir = modelDir(baseDir, model);
  await fsp.mkdir(dir, { recursive: true });
  const dest = filePath(baseDir, model, file);
  const paths = partialPaths(dest);

  // A crash can happen after the last byte lands but before verification and
  // rename. Finish that work locally instead of issuing an unsatisfiable range.
  if (partial && file.bytes && partial.size === file.bytes) {
    if (await verifyFile(paths.part, file, signal)) {
      signal?.throwIfAborted();
      await fsp.rename(paths.part, dest);
      await fsp.rm(paths.meta, { force: true });
      return;
    }
    await discardPartial(paths);
    partial = null;
  }

  let hash = file.sha256 ? crypto.createHash("sha256") : null;
  if (hash && partial) await updateHashFromFile(paths.part, hash, signal);

  let res;
  let offset = 0;
  if (partial) {
    const headers = { Range: `bytes=${partial.size}-` };
    const validator = ifRangeValue(partial.metadata);
    if (validator) headers["If-Range"] = validator;
    res = await fetch(file.url, { headers, signal });

    if (res.status === 206 && resumedResponseIsCompatible(res, partial, file)) {
      offset = partial.size;
    } else if (res.status === 200 && res.body) {
      // The host ignored Range or If-Range detected changed content. The body
      // is already a complete representation, so safely truncate rather than
      // append (and avoid wasting it on a second request).
      offset = 0;
    } else if (res.status === 206 || res.status === 416) {
      // Malformed ranges, 416, or a changed validator on a non-compliant 206
      // invalidate the partial. Cancel that body and explicitly fetch afresh.
      await res.body?.cancel().catch(() => {});
      await discardPartial(paths);
      partial = null;
      res = await fetchFull(file, signal);
    } else {
      // A temporary HTTP error says nothing about the partial's validity. Keep
      // it for the next attempt just as we do for a dropped connection.
      await res.body?.cancel().catch(() => {});
      throw new Error(`Download failed for ${file.name}: HTTP ${res.status}`);
    }
  } else {
    res = await fetchFull(file, signal);
  }

  if (!res.body) throw new Error(`Download failed for ${file.name}: HTTP ${res.status}`);
  // A full response replaces, rather than extends, any previously hashed prefix.
  if (!offset && hash) hash = crypto.createHash("sha256");
  const range = offset ? parseContentRange(res.headers.get("content-range")) : null;
  const contentLength = Number(res.headers.get("content-length")) || 0;
  const responseTotal = range?.total || contentLength || null;
  await fsp.writeFile(paths.meta, JSON.stringify(responseMetadata(res, file, responseTotal)));

  let streamed = 0;
  await pipeline(
    Readable.fromWeb(res.body),
    makeMeter((n) => {
      streamed += n;
      onSize(offset + streamed);
    }, hash),
    fs.createWriteStream(paths.part, { flags: offset ? "a" : "w" }),
    { signal }
  );

  const actualSize = (await fsp.stat(paths.part)).size;
  if (file.bytes && actualSize !== file.bytes) {
    await discardPartial(paths);
    throw new Error(`Size mismatch for ${file.name}`);
  }
  signal?.throwIfAborted();
  if (hash && hash.digest("hex") !== file.sha256) {
    await discardPartial(paths);
    throw new Error(`Checksum mismatch for ${file.name}`);
  }
  signal?.throwIfAborted();
  await fsp.rename(paths.part, dest); // atomic: only a verified file lands in place
  await fsp.rm(paths.meta, { force: true });
}

/**
 * Download every file of a model, reporting aggregate progress.
 *
 * Failed or cancelled transfers leave valid partial state for the next retry;
 * incompatible state is discarded and downloaded afresh. Progress credits all
 * reusable on-disk bytes in its first event and never moves backward. Files are
 * installed only after their exact size and configured checksum are verified.
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

  // Validate and credit everything reusable before the first progress event.
  // This makes a resumed setup open at its real on-disk byte count rather than
  // briefly flashing zero. Credits are high-water marks: if a server forces a
  // safe restart, fresh bytes do not make aggregate progress move backward.
  const reusable = [];
  for (const file of model.files) {
    const dest = filePath(baseDir, model, file);
    if (fs.existsSync(dest)) {
      if (await verifyFile(dest, file, signal)) {
        const size = fs.statSync(dest).size;
        reusable.push({ complete: true, partial: null, credit: size });
        received += size;
        continue;
      }
      await fsp.rm(dest, { force: true });
    }
    const partial = await readPartial(dest, file);
    const credit = partial?.size || 0;
    reusable.push({ complete: false, partial, credit });
    received += credit;
  }
  if (received) report(model.files.find((_, i) => !reusable[i].complete)?.name || null);

  for (let i = 0; i < model.files.length; i++) {
    const file = model.files[i];
    const state = reusable[i];
    if (state.complete) continue;
    await downloadFile(baseDir, model, file, {
      signal,
      partial: state.partial,
      onSize: (size) => {
        if (size <= state.credit) return;
        received += size - state.credit;
        state.credit = size;
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
  signal?.throwIfAborted();
  const marker = path.join(modelDir(baseDir, model), MARKER);
  await fsp.writeFile(marker, JSON.stringify({ files: sizes }));
  if (signal?.aborted) {
    await fsp.rm(marker, { force: true });
    signal.throwIfAborted();
  }
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
