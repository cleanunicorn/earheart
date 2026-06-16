// Downloads and locates the models that power Earheart's in-app engines.
//
// - Speech-to-text models (sherpa-onnx / Parakeet) are a handful of static
//   files, fetched here directly from Hugging Face with streamed progress and
//   resume so a dropped connection doesn't restart a 660 MB download.
// - The cleanup model (GGUF) is downloaded by node-llama-cpp, which already
//   does HF resolution, resume and progress; we just wrap it and normalize the
//   progress shape.
//
// Everything lands under <userData>/models so uninstalling the app is a clean
// sweep, and so the same code path works on every platform. The directory can
// be overridden with EARHEART_MODELS_DIR (handy for tests and power users).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { once } = require("node:events");

const catalog = require("./model-catalog");

let dirOverride = null;

// Resolve the models root lazily so this module can be required (and unit
// tested) without Electron present.
function modelsDir() {
  if (dirOverride) return dirOverride;
  if (process.env.EARHEART_MODELS_DIR) return process.env.EARHEART_MODELS_DIR;
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "models");
}

// Test seam.
function setModelsDir(dir) {
  dirOverride = dir;
}

function sttModelDir(id) {
  return path.join(modelsDir(), "stt", id);
}
function cleanupModelDir() {
  return path.join(modelsDir(), "cleanup");
}

function hfUrl(repo, revision, file) {
  return `https://huggingface.co/${repo}/resolve/${revision || "main"}/${file}`;
}

/**
 * Stream one file to disk with progress and resume support.
 *
 * If a partial ".part" file exists we ask the server to continue from where we
 * left off (HTTP Range). Servers that ignore Range reply 200 with the whole
 * body, so we detect that and restart cleanly instead of corrupting the file.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(p: {received:number,total:number}) => void} [opts.onProgress]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 */
async function downloadFile(url, destPath, opts = {}) {
  const { signal, onProgress, fetchImpl = fetch } = opts;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".part";

  let resumeAt = 0;
  try {
    resumeAt = (await fsp.stat(tmp)).size;
  } catch {
    // No partial file yet.
  }

  const headers = {};
  if (resumeAt > 0) headers.Range = `bytes=${resumeAt}-`;

  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }

  // 206 = server honored our Range and is appending; anything else means we
  // got the full body, so discard whatever partial we had.
  const appending = res.status === 206 && resumeAt > 0;
  if (!appending) resumeAt = 0;

  const contentLen = Number(res.headers.get("content-length")) || 0;
  const total = appending ? resumeAt + contentLen : contentLen;

  const out = fs.createWriteStream(tmp, { flags: appending ? "a" : "w" });
  let received = resumeAt;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await once(out, "drain");
      onProgress?.({ received, total });
    }
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    throw err;
  }

  await fsp.rename(tmp, destPath);
  return { bytes: received };
}

// ---------------------------------------------------------------------------
// Speech-to-text models
// ---------------------------------------------------------------------------

function isSttInstalled(id) {
  const spec = catalog.getSttModel(id);
  const dir = sttModelDir(spec.id);
  return spec.files.every((f) => fs.existsSync(path.join(dir, f.name)));
}

/**
 * Resolve the on-disk paths a recognizer needs, keyed by role
 * (encoder/decoder/joiner/tokens). Throws if the model isn't installed.
 */
function sttModelPaths(id) {
  const spec = catalog.getSttModel(id);
  const dir = sttModelDir(spec.id);
  const paths = { dir, modelType: spec.modelType };
  for (const f of spec.files) {
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) {
      throw new Error(`STT model "${spec.id}" is not downloaded yet`);
    }
    paths[f.role] = p;
  }
  return paths;
}

/**
 * Download every file of an STT model, reporting combined progress across the
 * whole set so the UI can show one bar.
 */
async function downloadStt(id, opts = {}) {
  const { signal, onProgress, fetchImpl } = opts;
  const spec = catalog.getSttModel(id);
  const dir = sttModelDir(spec.id);

  const totalApprox = spec.approxBytes || 0;
  const perFileReceived = new Array(spec.files.length).fill(0);
  let knownTotal = 0; // sum of content-lengths we've actually seen

  for (let i = 0; i < spec.files.length; i++) {
    const f = spec.files[i];
    const url = hfUrl(spec.repo, spec.revision, f.name);
    await downloadFile(url, path.join(dir, f.name), {
      signal,
      fetchImpl,
      onProgress: ({ received, total }) => {
        perFileReceived[i] = received;
        const got = perFileReceived.reduce((a, b) => a + b, 0);
        // Prefer the real total once known; fall back to the catalog estimate
        // so the bar still moves before headers arrive.
        knownTotal = Math.max(knownTotal, got, total ? knownTotal : 0);
        onProgress?.({ received: got, total: totalApprox || total });
      },
    });
  }
  return { dir };
}

// ---------------------------------------------------------------------------
// Cleanup model (GGUF via node-llama-cpp)
// ---------------------------------------------------------------------------

function cleanupModelFilePath(spec) {
  // node-llama-cpp names the file after the GGUF; we keep the basename of the
  // URI so install detection and loading agree.
  const uri = spec.uri || "";
  const base = uri.split("/").pop() || `${spec.id}.gguf`;
  return path.join(cleanupModelDir(), base);
}

function isCleanupInstalled(id, customUri) {
  const spec = catalog.getCleanupModel(id, customUri);
  if (!spec.uri) return false;
  return fs.existsSync(cleanupModelFilePath(spec));
}

/**
 * Download a cleanup GGUF via node-llama-cpp's downloader (HF resolution,
 * resume and progress all handled by the library).
 */
async function downloadCleanup(id, customUri, opts = {}) {
  const { signal, onProgress } = opts;
  const spec = catalog.getCleanupModel(id, customUri);
  if (!spec.uri) throw new Error("No cleanup model URI configured");

  const dir = cleanupModelDir();
  await fsp.mkdir(dir, { recursive: true });

  const { createModelDownloader } = await import("node-llama-cpp");
  const downloader = await createModelDownloader({
    modelUri: spec.uri,
    dirPath: dir,
    // Keep the basename predictable so isCleanupInstalled() can find it.
    fileName: cleanupModelFilePath(spec).split(path.sep).pop(),
    onProgress: ({ downloadedSize, totalSize }) =>
      onProgress?.({ received: downloadedSize, total: totalSize }),
  });

  if (signal) {
    if (signal.aborted) throw new Error("aborted");
    signal.addEventListener("abort", () => downloader.cancel(), { once: true });
  }

  const filePath = await downloader.download();
  return { filePath };
}

module.exports = {
  modelsDir,
  setModelsDir,
  sttModelDir,
  cleanupModelDir,
  cleanupModelFilePath,
  hfUrl,
  downloadFile,
  isSttInstalled,
  sttModelPaths,
  downloadStt,
  isCleanupInstalled,
  downloadCleanup,
};
