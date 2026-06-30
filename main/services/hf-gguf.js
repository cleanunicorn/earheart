// Discover the GGUF files in a Hugging Face model repo, so a user can add a
// custom cleanup model by pasting a repo URL instead of waiting for it to be
// added to the built-in registry. Pure (takes a `fetch`), no Electron deps, so
// it's unit-testable against a stub.
//
// Built-in models are pinned to an immutable commit + sha256 (see
// engines/registry.js). A user URL can't be pre-verified, so custom models are
// downloaded without a checksum — we still pin the resolved commit so the
// download is reproducible, and we surface gated/private/404 errors clearly.

const HF_HOST = "huggingface.co";

/**
 * Parse a Hugging Face model URL into { owner, repo, ref }. Accepts the repo
 * page, /tree/<ref>, /blob/<ref>/<path>, /resolve/<ref>/<path>, and the
 * /models/<owner>/<repo> form. Throws a user-facing error otherwise.
 */
function parseRepoUrl(input) {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Paste a Hugging Face model URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL must start with https://");
  }
  if (url.hostname.replace(/^www\./, "") !== HF_HOST) {
    throw new Error("Only huggingface.co URLs are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "models") parts.shift(); // /models/<owner>/<repo>
  if (parts.length < 2) {
    throw new Error("URL must point to a model repo, e.g. huggingface.co/owner/model");
  }
  const [owner, repo] = parts;
  let ref;
  if (["tree", "blob", "resolve"].includes(parts[2]) && parts[3]) {
    ref = decodeURIComponent(parts[3]);
  }
  return { owner, repo, ref };
}

async function hfJson(fetchImpl, url, signal) {
  let res;
  try {
    res = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(`Could not reach Hugging Face: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "This repository is gated or private — Earheart can only download public models"
    );
  }
  if (res.status === 404) throw new Error("Model repository not found on Hugging Face");
  if (!res.ok) throw new Error(`Hugging Face returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("Unexpected response from Hugging Face");
  }
}

// Pull the quantization token out of a GGUF filename: "model-Q4_K_M.gguf" ->
// "Q4_K_M", "model.IQ4_XS.gguf" -> "IQ4_XS". Falls back to the filename minus
// any shard suffix and extension when no known token is present, so unlabeled
// GGUFs still group sensibly.
const QUANT_RE = /\b(IQ\d+[A-Z0-9_]*|Q\d+(?:_[A-Z0-9]+)*|BF16|FP?16|FP?32|MXFP4)\b/i;
const SHARD_RE = /-\d{5}-of-\d{5}\.gguf$/i;

function quantOf(name) {
  const m = name.match(QUANT_RE);
  if (m) return m[1].toUpperCase();
  return name.replace(SHARD_RE, "").replace(/\.gguf$/i, "");
}

// Rank for the "best" default — guides the user toward Q4_K_M, the usual
// quality/size sweet spot for laptops. Lower is better; unknown labels sort
// last and fall back to the smallest download.
const QUANT_RANK = [
  "Q4_K_M", "Q4_K_S", "Q4_0", "Q4_1", "Q4_K",
  "Q5_K_M", "Q5_K_S", "Q5_0", "Q3_K_M", "Q6_K", "Q8_0",
];
function quantPriority(label) {
  const i = QUANT_RANK.indexOf(label.toUpperCase());
  if (i !== -1) return i;
  if (/^Q4/i.test(label)) return QUANT_RANK.length; // any other Q4 variant next
  return QUANT_RANK.length + 1;
}

/** The recommended (default-selected) quant for a sorted quants list. */
function recommendedQuant(quants) {
  return quants.length ? quants[0].label : null;
}

/**
 * List the GGUF quantizations available in a model repo.
 * @returns {Promise<{repo,commit,recommended,quants:Array<{label,totalBytes,files:Array<{name,url,bytes}>}>}>}
 */
async function listGgufQuants({ owner, repo, ref }, fetchImpl, { signal } = {}) {
  const base = `https://huggingface.co/api/models/${owner}/${repo}`;
  const info = await hfJson(
    fetchImpl,
    ref ? `${base}/revision/${encodeURIComponent(ref)}` : base,
    signal
  );
  if (info.gated) {
    throw new Error("This repository is gated — Earheart can only download public models");
  }
  // Pin to an immutable commit so the files we download match what we listed,
  // even if the repo is updated in between.
  const commit = info.sha || ref || "main";

  const tree = await hfJson(
    fetchImpl,
    `${base}/tree/${encodeURIComponent(commit)}?recursive=true`,
    signal
  );
  const ggufs = (Array.isArray(tree) ? tree : []).filter(
    (e) => e && e.type === "file" && /\.gguf$/i.test(e.path)
  );
  if (ggufs.length === 0) throw new Error("No GGUF files found in this repository");

  // Group by quantization. Sharded quants ("...-00001-of-00003.gguf") collapse
  // into one entry whose files are all the shards in name order; node-llama-cpp
  // loads the rest once pointed at the first shard.
  const groups = new Map();
  for (const e of ggufs) {
    const name = e.path.split("/").pop();
    const label = quantOf(name);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({
      name,
      path: e.path,
      bytes: e.size || (e.lfs && e.lfs.size) || 0,
    });
  }

  const quants = [...groups.entries()].map(([label, files]) => {
    files.sort((a, b) => a.name.localeCompare(b.name));
    return {
      label,
      totalBytes: files.reduce((s, f) => s + (f.bytes || 0), 0),
      files: files.map((f) => ({
        name: f.name,
        bytes: f.bytes || undefined,
        url: `https://huggingface.co/${owner}/${repo}/resolve/${encodeURIComponent(commit)}/${f.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      })),
    };
  });
  // Best-first by quant rank, then smallest download, so quants[0] is the
  // recommended default and unlabeled repos fall back to the smallest file.
  quants.sort(
    (a, b) => quantPriority(a.label) - quantPriority(b.label) || a.totalBytes - b.totalBytes
  );

  return { repo: `${owner}/${repo}`, commit, recommended: recommendedQuant(quants), quants };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build a registry-shaped cleanup model entry from a chosen quantization, so
 * the download manager / engines / IPC treat it exactly like a built-in (minus
 * the sha256 we can't know).
 */
function buildCleanupModel(repoFull, quant) {
  const repoName = repoFull.split("/")[1] || repoFull;
  const id = `custom-${slug(repoFull)}-${slug(quant.label)}`;
  const gb = quant.totalBytes ? (quant.totalBytes / 1e9).toFixed(quant.totalBytes < 1e9 ? 2 : 1) : null;
  const note =
    `Runs on this computer · Hugging Face · ${repoFull} · ${quant.label}` +
    (gb ? ` · ~${gb} GB` : "") +
    " · not checksum-verified";
  return {
    id,
    kind: "cleanup",
    label: `${repoName} · ${quant.label}`,
    note,
    engine: "llama-gguf",
    custom: true,
    source: { repo: repoFull, quant: quant.label },
    files: quant.files.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes })),
    gguf: { file: quant.files[0].name },
  };
}

module.exports = {
  parseRepoUrl,
  listGgufQuants,
  recommendedQuant,
  buildCleanupModel,
  quantOf,
};
