// Discover the model files in a Hugging Face repo, so a user can add a custom
// model by pasting a repo URL (or a bare owner/model) instead of waiting for it
// to be added to the built-in registry. Pure (takes a `fetch`), no Electron
// deps, so it's unit-testable against a stub.
//
// Two discoverers, one per model kind:
//   - listGgufQuants   cleanup GGUFs for node-llama-cpp, grouped by quantization
//   - listSttVariants  sherpa-onnx transducer bundles (encoder/decoder/joiner
//                      .onnx + tokens.txt), grouped by precision (int8/fp16/…)
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
  const SAFE_SEGMENT = /^[\w.-]+$/;
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) {
    throw new Error("Invalid owner or repository name in URL");
  }
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

/* ---------------- STT: sherpa-onnx model bundles ---------------- */

// The in-process STT engine runs two sherpa-onnx offline model families:
//   - transducer  encoder/decoder/joiner .onnx + tokens.txt — the shape of the
//                 csukuangfj/sherpa-onnx-* bundles the built-in Parakeet
//                 models come from
//   - whisper     encoder/decoder .onnx + tokens.txt, no joiner — the
//                 csukuangfj/sherpa-onnx-whisper-* exports
// A missing joiner is what tells them apart; the engine picks the matching
// sherpa model config from the `sherpa` map each variant carries.
//
// Repos often ship several precisions of the same model side by side
// ("encoder.onnx" and "encoder.int8.onnx"), so group the files by precision
// the way GGUF repos group by quantization.
//
// Layouts vary. sherpa's own bundles keep everything at the top level and put
// the precision in the file name; the onnx-community/* conversions nest their
// weights under "onnx/" and use a suffix ("encoder_model_fp16.onnx"); others
// use a directory per precision ("int8/encoder.onnx"). So we consider .onnx
// files at any depth and read the precision off the whole path.

const ONNX_RE = /\.onnx$/i;

// Precision/quantization labels seen in the wild, matched as whole
// "/", "." , "-" or "_"-delimited path segments. Beyond sherpa's own int8/fp16,
// this covers the transformers.js-style quantizations the onnx-community
// conversions ship, so files that differ only by quantization don't collapse
// into one entry (and get an accurate label instead of a wrong "fp32").
const PRECISION_TOKENS = new Set([
  "int8", "uint8", "uint8f16", "q4", "q4f16", "q8", "q8f16",
  "bnb4", "quantized", "fp16", "half", "fp32",
]);
const PRECISION_ALIASES = { half: "fp16" };

// Recommended-first. int8 is what sherpa's bundles ship and what the built-in
// Parakeet models use. Labels missing here (q4, uint8, bnb4 …) are still
// offered, they just never become the default — sherpa's transducer runtime
// usually can't load them.
const PRECISION_RANK = ["int8", "quantized", "q8", "uint8", "fp16", "fp32"];

function precisionOf(filePath) {
  const segments = filePath.replace(ONNX_RE, "").toLowerCase().split(/[/.\-_]+/);
  // Last match wins, so the file name beats the directory it sits in.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (PRECISION_TOKENS.has(segments[i])) {
      return PRECISION_ALIASES[segments[i]] || segments[i];
    }
  }
  return "fp32";
}

function precisionPriority(label) {
  const i = PRECISION_RANK.indexOf(label);
  return i === -1 ? PRECISION_RANK.length : i;
}

// Deliberately reads the role off the file name and not the full path: the
// download manager writes every file of a variant into one flat directory, and
// distinct role names are what keeps those on-disk names from colliding.
function componentOf(name) {
  if (!ONNX_RE.test(name)) return null;
  const m = name.match(/encoder|decoder|joiner/i);
  return m ? m[0].toLowerCase() : null;
}

function dirOf(filePath) {
  return filePath.slice(0, filePath.lastIndexOf("/") + 1);
}

// sherpa's Whisper exports prefix every file of a bundle with the model name
// ("tiny.en-encoder.onnx", "tiny.en-tokens.txt"), so the symbol table can only
// be matched by that shared prefix rather than a fixed "tokens.txt".
const TOKENS_RE = /(^|[-_.])tokens\.txt$/i;

function bundlePrefix(name) {
  const m = name.match(/^(.*?)[-_.]?(?:encoder|decoder|joiner)/i);
  return m ? m[1].toLowerCase() : "";
}

function tokensPrefix(name) {
  return name.replace(/[-_.]?tokens\.txt$/i, "").toLowerCase();
}

// The symbol table belonging to a given encoder: same prefix first, then an
// unprefixed tokens.txt, then whatever the repo has. Candidates arrive
// shallowest-first, so the fallbacks stay deterministic.
function tokensFor(candidates, encoder) {
  const prefix = bundlePrefix(encoder.name);
  return (
    candidates.find((f) => tokensPrefix(f.name) === prefix) ||
    candidates.find((f) => tokensPrefix(f.name) === "") ||
    candidates[0]
  );
}

// Name a few of the files we did find, so "this isn't a model Earheart can
// run" never reads as "your repo is empty" when it plainly isn't.
function samplePaths(files, limit = 3) {
  return files.slice(0, limit).map((f) => f.path).join(", ") + (files.length > limit ? ", …" : "");
}

/**
 * List the precisions (int8 / fp16 / fp32 / …) available in a sherpa-onnx
 * transducer or Whisper repo. Same return shape as listGgufQuants; each variant
 * additionally carries the `sherpa` file map the engine wires together — with a
 * `joiner` for transducers and without one for Whisper.
 * @returns {Promise<{repo,commit,recommended,variants:Array<{label,totalBytes,files,sherpa}>}>}
 */
async function listSttVariants({ owner, repo, ref }, fetchImpl, { signal } = {}) {
  const { commit, files } = await repoTree({ owner, repo, ref }, fetchImpl, signal);

  // Shallowest path wins when the same file name appears twice (files land in
  // one flat directory on disk), so flat bundles keep their top-level files.
  const byDepth = [...files].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  );

  const allOnnx = byDepth.filter((f) => ONNX_RE.test(f.name));
  if (allOnnx.length === 0) {
    throw new Error(
      "No .onnx files found in this repository — Earheart needs a sherpa-onnx transducer " +
        "bundle (encoder, decoder, joiner) or Whisper export (encoder, decoder), plus tokens.txt"
    );
  }
  const onnx = byDepth.filter((f) => componentOf(f.name));
  if (onnx.length === 0) {
    throw new Error(
      `Found ${allOnnx.length} .onnx file${allOnnx.length === 1 ? "" : "s"} ` +
        `(${samplePaths(allOnnx)}), but none of them is an encoder, decoder or joiner — ` +
        "Earheart can only run sherpa-onnx transducer bundles and Whisper exports for " +
        "speech-to-text, not single-file ONNX models"
    );
  }
  // Which roles the repo has at all, before worrying about precisions or the
  // symbol table. Encoder + decoder with no joiner is the encoder-decoder
  // (seq2seq) shape sherpa loads as Whisper; anything else is a model family
  // the engine has no config for, and saying which part is missing beats
  // complaining about a tokens.txt that was never the real problem.
  const has = (part) => onnx.some((f) => componentOf(f.name) === part);
  const family = has("joiner") ? "transducer" : "whisper";
  const missing = ["encoder", "decoder", ...(family === "transducer" ? ["joiner"] : [])].filter(
    (part) => !has(part)
  );
  if (missing.length) {
    throw new Error(
      `Found ${onnx.length} .onnx file${onnx.length === 1 ? "" : "s"} ` +
        `(${samplePaths(onnx)}), but no ${missing.join(" or ")} — Earheart can only run ` +
        "sherpa-onnx transducer bundles (encoder, decoder, joiner) and Whisper exports " +
        "(encoder, decoder), plus tokens.txt"
    );
  }
  // sherpa's Whisper exports name it "<model>-tokens.txt"; transducer bundles
  // use a plain "tokens.txt". Match either, and pair one to each encoder below.
  const tokensFiles = byDepth.filter((f) => TOKENS_RE.test(f.name));
  if (tokensFiles.length === 0) {
    throw new Error(
      `Found the ${family === "whisper" ? "encoder and decoder" : "encoder, decoder and joiner"} ` +
        ".onnx files, but no tokens.txt — sherpa-onnx needs the bundle's symbol table. " +
        "Hugging Face / optimum ONNX exports keep the vocabulary in tokenizer.json instead; " +
        "look for a sherpa-onnx conversion of the same model (csukuangfj/sherpa-onnx-…)"
    );
  }

  // First (shallowest) file per component+precision.
  const component = new Map(); // "encoder:int8" -> file
  for (const f of onnx) {
    const key = `${componentOf(f.name)}:${precisionOf(f.path)}`;
    if (!component.has(key)) component.set(key, f);
  }
  // Quantized bundles often keep the small decoder/joiner at full precision;
  // fall back per component so an int8 encoder still forms a variant.
  const pick = (part, precision) =>
    component.get(`${part}:${precision}`) || component.get(`${part}:fp32`);

  // sherpa-onnx needs to know the model flavor; for transducers the NeMo
  // bundles (the Parakeet family this feature targets) say so in their repo
  // names.
  const modelType =
    family === "whisper"
      ? "whisper"
      : /nemo|parakeet/i.test(`${owner}/${repo}`)
        ? "nemo_transducer"
        : "transducer";

  const toFile = (f) => ({
    name: f.name,
    bytes: f.bytes || undefined,
    url: resolveUrl(owner, repo, commit, f.path),
  });

  // One variant per precision that actually has an encoder, rather than a fixed
  // int8/fp16/fp32 list, so repos shipping other quantizations still show up.
  const precisions = [...new Set(onnx.map((f) => precisionOf(f.path)))];

  const variants = [];
  for (const precision of precisions) {
    const encoder = component.get(`encoder:${precision}`);
    if (!encoder) continue;
    const decoder = pick("decoder", precision);
    if (!decoder) continue;
    const joiner = family === "transducer" ? pick("joiner", precision) : null;
    if (family === "transducer" && !joiner) continue;
    const parts = joiner ? [encoder, decoder, joiner] : [encoder, decoder];
    // External-data sidecars (e.g. the fp32 Parakeet's "encoder.weights") must
    // sit next to their .onnx for the loader to find them. Match within the
    // .onnx's own directory so a nested layout can't pull in a same-named
    // sidecar belonging to a different copy of the model.
    const sidecars = byDepth.filter(
      (f) =>
        /\.(weights|data|onnx_data)$/i.test(f.name) &&
        parts.some(
          (p) =>
            dirOf(f.path) === dirOf(p.path) && f.name.startsWith(p.name.replace(ONNX_RE, ""))
        )
    );
    const tokens = tokensFor(tokensFiles, encoder);
    const all = [...parts, ...sidecars, tokens];
    variants.push({
      label: precision,
      totalBytes: all.reduce((s, f) => s + (f.bytes || 0), 0),
      files: all.map(toFile),
      sherpa: {
        encoder: encoder.name,
        decoder: decoder.name,
        // Omitted for Whisper — its absence is what selects the engine's
        // whisper model config over the transducer one.
        ...(joiner ? { joiner: joiner.name } : {}),
        tokens: tokens.name,
        modelType,
      },
    });
  }
  // Every role the family needs is present by here, so the only way to reach
  // this is a precision that never lines up (e.g. an fp16 encoder whose joiner
  // ships int8-only, with no fp32 of either to fall back to).
  if (variants.length === 0) {
    const roles = family === "whisper" ? "encoder and decoder" : "encoder, decoder and joiner";
    throw new Error(
      `Could not assemble a complete model from this repository — ${roles} never share a ` +
        `precision (${samplePaths(onnx)})`
    );
  }
  // Best-first by precision rank, then smallest download, so variants[0] is the
  // recommended default and unranked quantizations sort last.
  variants.sort(
    (a, b) =>
      precisionPriority(a.label) - precisionPriority(b.label) || a.totalBytes - b.totalBytes
  );

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
