// Discover the model files in a Hugging Face repo, so a user can add a custom
// model by pasting a repo URL (or a bare owner/model) instead of waiting for it
// to be added to the built-in registry. Pure (takes a `fetch`), no Electron
// deps, so it's unit-testable against a stub.
//
// Two discoverers, one per model kind:
//   - listGgufQuants   cleanup GGUFs for node-llama-cpp, grouped by quantization
//   - listSttVariants  sherpa-onnx transducer bundles (encoder/decoder/joiner
//                      .onnx + tokens.txt), grouped by precision (int8/fp16/fp32)
// Both return the same shape ({ repo, commit, recommended, variants }) so the
// IPC layer and the settings UI treat the two kinds identically.
//
// Built-in models are pinned to an immutable commit + sha256 (see
// engines/registry.js). A user repo can't be pre-verified, so custom models are
// downloaded without a checksum — we still pin the resolved commit so the
// download is reproducible, and we surface gated/private/404 errors clearly.

const HF_HOSTS = new Set(["huggingface.co", "hf.co"]);

/**
 * Parse what the user pasted into { owner, repo, ref }. Accepts a bare
 * "owner/model" (what the Hugging Face site shows as the repo name), the repo
 * page URL, /tree/<ref>, /blob/<ref>/<path>, /resolve/<ref>/<path>, the
 * /models/<owner>/<repo> form, and scheme-less "huggingface.co/owner/model".
 * Throws a user-facing error otherwise.
 */
function parseRepoInput(input) {
  let raw = (input || "").trim();
  if (!raw) throw new Error("Paste a Hugging Face URL or owner/model");
  // Bare "owner/model" — exactly two path segments, no host, no scheme.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    const [owner, repo] = raw.split("/");
    return { owner, repo, ref: undefined };
  }
  // "huggingface.co/owner/model" pasted without the scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a Hugging Face URL or owner/model: ${input.trim()}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL must start with https://");
  }
  if (!HF_HOSTS.has(url.hostname.replace(/^www\./, ""))) {
    throw new Error("Only huggingface.co URLs (or a bare owner/model) are supported");
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

// Fetch a repo's file listing pinned to an immutable commit, so the files we
// download match what we listed even if the repo is updated in between.
// Returns { commit, files: [{ path, name, bytes }] }.
async function repoTree({ owner, repo, ref }, fetchImpl, signal) {
  const base = `https://huggingface.co/api/models/${owner}/${repo}`;
  const info = await hfJson(
    fetchImpl,
    ref ? `${base}/revision/${encodeURIComponent(ref)}` : base,
    signal
  );
  if (info.gated) {
    throw new Error("This repository is gated — Earheart can only download public models");
  }
  const commit = info.sha || ref || "main";
  const tree = await hfJson(
    fetchImpl,
    `${base}/tree/${encodeURIComponent(commit)}?recursive=true`,
    signal
  );
  const files = (Array.isArray(tree) ? tree : [])
    .filter((e) => e && e.type === "file")
    .map((e) => ({
      path: e.path,
      name: e.path.split("/").pop(),
      bytes: e.size || (e.lfs && e.lfs.size) || 0,
    }));
  return { commit, files };
}

function resolveUrl(owner, repo, commit, filePath) {
  return `https://huggingface.co/${owner}/${repo}/resolve/${encodeURIComponent(commit)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/* ---------------- cleanup: GGUF quantizations ---------------- */

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

/** The recommended (default-selected) variant for a sorted variants list. */
function recommendedVariant(variants) {
  return variants.length ? variants[0].label : null;
}

/**
 * List the GGUF quantizations available in a model repo.
 * @returns {Promise<{repo,commit,recommended,variants:Array<{label,totalBytes,files:Array<{name,url,bytes}>}>}>}
 */
async function listGgufQuants({ owner, repo, ref }, fetchImpl, { signal } = {}) {
  const { commit, files } = await repoTree({ owner, repo, ref }, fetchImpl, signal);
  const ggufs = files.filter((f) => /\.gguf$/i.test(f.path));
  if (ggufs.length === 0) throw new Error("No GGUF files found in this repository");

  // Group by quantization. Sharded quants ("...-00001-of-00003.gguf") collapse
  // into one entry whose files are all the shards in name order; node-llama-cpp
  // loads the rest once pointed at the first shard.
  const groups = new Map();
  for (const f of ggufs) {
    const label = quantOf(f.name);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(f);
  }

  const variants = [...groups.entries()].map(([label, group]) => {
    group.sort((a, b) => a.name.localeCompare(b.name));
    return {
      label,
      totalBytes: group.reduce((s, f) => s + (f.bytes || 0), 0),
      files: group.map((f) => ({
        name: f.name,
        bytes: f.bytes || undefined,
        url: resolveUrl(owner, repo, commit, f.path),
      })),
    };
  });
  // Best-first by quant rank, then smallest download, so variants[0] is the
  // recommended default and unlabeled repos fall back to the smallest file.
  variants.sort(
    (a, b) => quantPriority(a.label) - quantPriority(b.label) || a.totalBytes - b.totalBytes
  );

  return { repo: `${owner}/${repo}`, commit, recommended: recommendedVariant(variants), variants };
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function humanGb(totalBytes) {
  if (!totalBytes) return null;
  return (totalBytes / 1e9).toFixed(totalBytes < 1e9 ? 2 : 1);
}

function customNote(repoFull, variant) {
  const gb = humanGb(variant.totalBytes);
  return (
    `Runs on this computer · Hugging Face · ${repoFull} · ${variant.label}` +
    (gb ? ` · ~${gb} GB` : "") +
    " · not checksum-verified"
  );
}

/**
 * Build a registry-shaped cleanup model entry from a chosen quantization, so
 * the download manager / engines / IPC treat it exactly like a built-in (minus
 * the sha256 we can't know).
 */
function buildCleanupModel(repoFull, variant) {
  const repoName = repoFull.split("/")[1] || repoFull;
  return {
    id: `custom-${slug(repoFull)}-${slug(variant.label)}`,
    kind: "cleanup",
    label: `${repoName} · ${variant.label}`,
    note: customNote(repoFull, variant),
    engine: "llama-gguf",
    custom: true,
    source: { repo: repoFull, quant: variant.label },
    files: variant.files.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes })),
    gguf: { file: variant.files[0].name },
  };
}

/* ---------------- STT: sherpa-onnx transducer bundles ---------------- */

// The in-process STT engine runs sherpa-onnx offline transducers: an
// encoder/decoder/joiner .onnx trio plus a tokens.txt — the shape of the
// csukuangfj/sherpa-onnx-* bundles the built-in Parakeet models come from.
// Repos often ship several precisions of the same model side by side
// ("encoder.onnx" and "encoder.int8.onnx"), so group the files by precision
// the way GGUF repos group by quantization.

const STT_PRECISIONS = ["int8", "fp16", "fp32"]; // recommended-first (int8 = smallest, fastest)

function precisionOf(name) {
  if (/(^|[.\-_])int8[.\-_]/i.test(name)) return "int8";
  if (/(^|[.\-_])(fp16|half)[.\-_]/i.test(name)) return "fp16";
  return "fp32";
}

function componentOf(name) {
  if (!/\.onnx$/i.test(name)) return null;
  const m = name.match(/encoder|decoder|joiner/i);
  return m ? m[0].toLowerCase() : null;
}

/**
 * List the transducer precisions (int8 / fp16 / fp32) available in a
 * sherpa-onnx model repo. Same return shape as listGgufQuants; each variant
 * additionally carries the `sherpa` file map the engine wires together.
 * @returns {Promise<{repo,commit,recommended,variants:Array<{label,totalBytes,files,sherpa}>}>}
 */
async function listSttVariants({ owner, repo, ref }, fetchImpl, { signal } = {}) {
  const { commit, files } = await repoTree({ owner, repo, ref }, fetchImpl, signal);

  // Shallowest path wins when the same file name appears twice (files land in
  // one flat directory on disk), so flat bundles keep their top-level files.
  const byDepth = [...files].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  );

  const onnx = byDepth.filter((f) => componentOf(f.name));
  if (onnx.length === 0) {
    throw new Error("No ONNX model files found in this repository");
  }
  const tokens = byDepth.find((f) => f.name === "tokens.txt");
  if (!tokens) {
    throw new Error("No tokens.txt found — this doesn't look like a sherpa-onnx model repo");
  }

  // First (shallowest) file per component+precision.
  const component = new Map(); // "encoder:int8" -> file
  for (const f of onnx) {
    const key = `${componentOf(f.name)}:${precisionOf(f.name)}`;
    if (!component.has(key)) component.set(key, f);
  }
  // Quantized bundles often keep the small decoder/joiner at full precision;
  // fall back per component so an int8 encoder still forms a variant.
  const pick = (part, precision) =>
    component.get(`${part}:${precision}`) || component.get(`${part}:fp32`);

  // sherpa-onnx needs to know the transducer flavor; the NeMo bundles (the
  // Parakeet family this feature targets) say so in their repo names.
  const modelType = /nemo|parakeet/i.test(`${owner}/${repo}`) ? "nemo_transducer" : "transducer";

  const toFile = (f) => ({
    name: f.name,
    bytes: f.bytes || undefined,
    url: resolveUrl(owner, repo, commit, f.path),
  });

  const variants = [];
  for (const precision of STT_PRECISIONS) {
    const encoder = component.get(`encoder:${precision}`);
    if (!encoder) continue;
    const decoder = pick("decoder", precision);
    const joiner = pick("joiner", precision);
    if (!decoder || !joiner) continue;
    const parts = [encoder, decoder, joiner];
    // External-data sidecars (e.g. the fp32 Parakeet's "encoder.weights") must
    // sit next to their .onnx for the loader to find them.
    const stems = parts.map((f) => f.name.replace(/\.onnx$/i, ""));
    const sidecars = byDepth.filter(
      (f) =>
        /\.(weights|data|onnx_data)$/i.test(f.name) &&
        stems.some((stem) => f.name.startsWith(stem))
    );
    const all = [...parts, ...sidecars, tokens];
    variants.push({
      label: precision,
      totalBytes: all.reduce((s, f) => s + (f.bytes || 0), 0),
      files: all.map(toFile),
      sherpa: {
        encoder: encoder.name,
        decoder: decoder.name,
        joiner: joiner.name,
        tokens: tokens.name,
        modelType,
      },
    });
  }
  if (variants.length === 0) {
    throw new Error(
      "Could not find a complete transducer (encoder, decoder, joiner) — Earheart can only run sherpa-onnx transducer bundles"
    );
  }

  return { repo: `${owner}/${repo}`, commit, recommended: recommendedVariant(variants), variants };
}

/**
 * Build a registry-shaped STT model entry from a chosen precision variant,
 * mirroring buildCleanupModel.
 */
function buildSttModel(repoFull, variant) {
  const repoName = repoFull.split("/")[1] || repoFull;
  return {
    id: `custom-${slug(repoFull)}-${slug(variant.label)}`,
    kind: "stt",
    label: `${repoName} · ${variant.label}`,
    note: customNote(repoFull, variant),
    engine: "sherpa-parakeet",
    custom: true,
    source: { repo: repoFull, variant: variant.label },
    files: variant.files.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes })),
    sherpa: variant.sherpa,
  };
}

module.exports = {
  parseRepoInput,
  listGgufQuants,
  listSttVariants,
  recommendedVariant,
  buildCleanupModel,
  buildSttModel,
  quantOf,
};
