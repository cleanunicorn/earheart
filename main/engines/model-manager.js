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
// is present and a `.complete` marker has been written; see isInstalled() for
// how the marker's sizes and definition identity are checked.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const { totalBytes, assertPathSegment } = require("./registry");

const MARKER = ".complete";

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

// Identity of a definition's files. A custom model keeps its id across
// upstream re-uploads (the id has no commit), so this, not the id, tells
// whether the bytes on disk belong to the current definition. A file with a
// checksum is identified by its name and checksum alone, so re-pinning a
// built-in to a new commit with byte-identical files keeps its install; a file
// without one falls back to its URL (which pins the resolved commit) and size.
// Labels and notes are left out so a copy edit never invalidates a multi-GB
// install, and files are taken in name order because a re-listing may return
// the same files in another order.
function definitionFingerprint(model) {
  const files = (model.files || [])
    .map((f) =>
      f.sha256
        ? { name: f.name, sha256: f.sha256 }
        : { name: f.name, url: f.url ?? null, bytes: f.bytes ?? null }
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

// Read the completion marker. Returns { sizes, fingerprint }: the recorded
// {name: size} map (empty for a legacy pre-size marker) and the definition
// fingerprint (undefined for a marker written before fingerprints), or null
// when no marker is present.
function readMarker(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, MARKER), "utf8");
  } catch {
    return null; // no marker: not installed
  }
  if (!raw) return { sizes: {} }; // legacy empty marker: presence-only
  try {
    const parsed = JSON.parse(raw);
    return {
      sizes: (parsed && parsed.files) || {},
      fingerprint: typeof parsed?.fingerprint === "string" ? parsed.fingerprint : undefined,
    };
  } catch {
    return { sizes: {} };
  }
}

/**
 * True once the completion marker exists and every file is on disk at the size
 * recorded when it was downloaded (including custom files without a configured
 * `bytes` value). A finished file that was later truncated is not installed.
 * A marker that records a definition fingerprint must match the current
 * definition; one written before
 * fingerprints existed is trusted, so upgrading never forces a re-download.
 */
function isInstalled(baseDir, model) {
  // A model whose id or filenames can't name a path inside the managed
  // directory is never installed; answer false rather than throwing so one
  // bad entry can't take down a whole model listing.
  let dir;
  try {
    dir = modelDir(baseDir, model);
  } catch {
    return false;
  }
  const marker = readMarker(dir);
  if (marker === null) return false;
  if (marker.fingerprint !== undefined && marker.fingerprint !== definitionFingerprint(model)) {
    return false; // bytes from a different revision of this id
  }
  const sizes = marker.sizes;
  return model.files.every((f) => {
    let p;
    try {
      p = filePath(baseDir, model, f);
    } catch {
      return false;
    }
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

// The validators recorded in a partial's metadata, or null where absent or
// not a string (the metadata file is untrusted on-disk JSON).
function validators(metadata) {
  return {
    etag: typeof metadata.etag === "string" ? metadata.etag : null,
    lastModified: typeof metadata.lastModified === "string" ? metadata.lastModified : null,
  };
}

function ifRangeValue(metadata) {
  // RFC 9110 forbids weak entity tags in If-Range. Last-Modified is the next
  // best validator; with neither, the final SHA-256 still prevents installation
  // of bytes combined from incompatible representations.
  const { etag, lastModified } = validators(metadata);
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

  const { etag: oldEtag, lastModified: oldModified } = validators(partial.metadata);
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

function httpError(file, res) {
  return new Error(`Download failed for ${file.name}: HTTP ${res.status}`);
}

async function installPart(paths, dest) {
  await fsp.rename(paths.part, dest); // atomic: only a verified file lands in place
  await fsp.rm(paths.meta, { force: true });
}

async function fetchFull(file, signal) {
  const res = await fetch(file.url, { signal });
  if (res.status !== 200 || !res.body) throw httpError(file, res);
  return res;
}

// A crash can happen after the last byte lands but before verification and
// rename. Finish that work locally instead of issuing an unsatisfiable range.
// Returns { installed } when the partial was the whole verified file, else the
// partial still worth resuming (null once a corrupted one is discarded).
async function finalizePartial(paths, dest, file, partial, signal) {
  if (!(partial && file.bytes && partial.size === file.bytes)) return { partial };
  if (await verifyFile(paths.part, file, signal)) {
    signal?.throwIfAborted();
    await installPart(paths, dest);
    return { installed: true };
  }
  await discardPartial(paths);
  return { partial: null };
}

// Request the rest of a partial (Range + If-Range), or the whole file when
// there is none or the server cannot honour the range. Returns the response
// and the byte offset its body starts at (0 means it replaces the partial).
async function openResumableFetch(paths, file, partial, signal) {
  if (!partial) return { res: await fetchFull(file, signal), offset: 0 };

  const headers = { Range: `bytes=${partial.size}-` };
  const validator = ifRangeValue(partial.metadata);
  if (validator) headers["If-Range"] = validator;
  const res = await fetch(file.url, { headers, signal });

  if (res.status === 206 && resumedResponseIsCompatible(res, partial, file)) {
    return { res, offset: partial.size };
  } else if (res.status === 200 && res.body) {
    // The host ignored Range or If-Range detected changed content. The body
    // is already a complete representation, so safely truncate rather than
    // append (and avoid wasting it on a second request).
    return { res, offset: 0 };
  } else if (res.status === 206 || res.status === 416) {
    // Malformed ranges, 416, or a changed validator on a non-compliant 206
    // invalidate the partial. Cancel that body and explicitly fetch afresh.
    await res.body?.cancel().catch(() => {});
    await discardPartial(paths);
    return { res: await fetchFull(file, signal), offset: 0 };
  } else {
    // A temporary HTTP error says nothing about the partial's validity. Keep
    // it for the next attempt just as we do for a dropped connection.
    await res.body?.cancel().catch(() => {});
    throw httpError(file, res);
  }
}

// Stream the response into the .part file (appending at a non-zero offset),
// then check the whole file's size and checksum. `hash` already holds the
// partial's prefix; a full response starts it over. Bad bytes are discarded.
async function streamAndVerify(paths, file, { res, offset, hash, onSize, signal }) {
  if (!res.body) throw httpError(file, res);
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
}

async function downloadFile(baseDir, model, file, { partial, onSize, signal }) {
  const dir = modelDir(baseDir, model);
  await fsp.mkdir(dir, { recursive: true });
  const dest = filePath(baseDir, model, file);
  const paths = partialPaths(dest);

  const finalized = await finalizePartial(paths, dest, file, partial, signal);
  if (finalized.installed) return;
  partial = finalized.partial;

  const hash = file.sha256 ? crypto.createHash("sha256") : null;
  if (hash && partial) await updateHashFromFile(paths.part, hash, signal);

  const { res, offset } = await openResumableFetch(paths, file, partial, signal);
  await streamAndVerify(paths, file, { res, offset, hash, onSize, signal });
  await installPart(paths, dest);
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
  // Catalog sizes are exact; custom files may omit size metadata. Clamp below
  // 100% until every file has been verified and the completion marker written.
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

  // Save verified sizes and definition identity for isInstalled().
  const sizes = {};
  for (const file of model.files) {
    sizes[file.name] = fs.statSync(filePath(baseDir, model, file)).size;
  }
  signal?.throwIfAborted();
  const marker = path.join(modelDir(baseDir, model), MARKER);
  await fsp.writeFile(
    marker,
    JSON.stringify({ files: sizes, fingerprint: definitionFingerprint(model) })
  );
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
  definitionFingerprint,
  remove,
  download,
  MARKER,
};
