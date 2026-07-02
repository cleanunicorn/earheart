// Tests for the Hugging Face model discovery used by the custom-model feature
// (cleanup GGUFs and sherpa-onnx STT bundles). Pure module, exercised against
// a stub fetch.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  parseRepoInput,
  listGgufQuants,
  listSttVariants,
  recommendedVariant,
  buildCleanupModel,
  buildSttModel,
  quantOf,
} = require("../main/services/hf-models");

// A fetch stub that routes by URL substring. Routes are tried in order, so put
// more specific matches (e.g. "/tree/") first.
function stubFetch(routes) {
  return async (url) => {
    for (const [match, payload] of routes) {
      if (url.includes(match)) {
        const status = payload.status || 200;
        return { ok: status < 400, status, async json() { return payload.body; } };
      }
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

test("parseRepoInput accepts a repo page URL", () => {
  assert.deepStrictEqual(parseRepoInput("https://huggingface.co/unsloth/gemma-3-1b-it-GGUF"), {
    owner: "unsloth",
    repo: "gemma-3-1b-it-GGUF",
    ref: undefined,
  });
});

test("parseRepoInput accepts a bare owner/model", () => {
  assert.deepStrictEqual(parseRepoInput("unsloth/gemma-3-1b-it-GGUF"), {
    owner: "unsloth",
    repo: "gemma-3-1b-it-GGUF",
    ref: undefined,
  });
  assert.deepStrictEqual(parseRepoInput("  csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2 "), {
    owner: "csukuangfj",
    repo: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2",
    ref: undefined,
  });
});

test("parseRepoInput accepts scheme-less and hf.co URLs", () => {
  assert.strictEqual(parseRepoInput("huggingface.co/owner/repo").owner, "owner");
  assert.strictEqual(parseRepoInput("https://hf.co/owner/repo").repo, "repo");
  assert.strictEqual(parseRepoInput("hf.co/owner/repo/tree/v1.0").ref, "v1.0");
});

test("parseRepoInput extracts the ref from blob/tree/resolve URLs", () => {
  assert.strictEqual(
    parseRepoInput("https://huggingface.co/owner/repo/blob/main/model-Q4_K_M.gguf").ref,
    "main"
  );
  assert.strictEqual(parseRepoInput("https://huggingface.co/owner/repo/tree/v1.0").ref, "v1.0");
  assert.strictEqual(parseRepoInput("https://huggingface.co/models/owner/repo").repo, "repo");
});

test("parseRepoInput rejects non-Hugging-Face and malformed input", () => {
  assert.throws(() => parseRepoInput("https://example.com/owner/repo"), /huggingface\.co/);
  assert.throws(() => parseRepoInput("https://huggingface.co/owner"), /model repo/);
  assert.throws(() => parseRepoInput("not a url"), /Not a Hugging Face URL or owner\/model/);
  assert.throws(() => parseRepoInput(""), /Paste a Hugging Face/);
});

test("quantOf reads the quantization token from a filename", () => {
  assert.strictEqual(quantOf("gemma-3-1b-it-Q4_K_M.gguf"), "Q4_K_M");
  assert.strictEqual(quantOf("model.IQ4_XS.gguf"), "IQ4_XS");
  assert.strictEqual(quantOf("model-BF16.gguf"), "BF16");
});

test("listGgufQuants groups quants, pins the commit, and recommends Q4", async () => {
  const fetchImpl = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "gemma-3-1b-it-Q4_K_M.gguf", size: 800 },
      { type: "file", path: "gemma-3-1b-it-Q8_0.gguf", size: 1600 },
      { type: "file", path: "gemma-3-1b-it-Q2_K.gguf", size: 400 },
      { type: "file", path: "README.md", size: 10 },
    ] }],
    ["/api/models/", { body: { sha: "deadbeefcommit", gated: false } }],
  ]);

  const out = await listGgufQuants({ owner: "u", repo: "r" }, fetchImpl);

  assert.strictEqual(out.repo, "u/r");
  assert.strictEqual(out.commit, "deadbeefcommit");
  assert.strictEqual(out.recommended, "Q4_K_M");
  assert.deepStrictEqual(out.variants.map((v) => v.label), ["Q4_K_M", "Q8_0", "Q2_K"]);
  // README is excluded; each quant is one file with a commit-pinned resolve URL.
  const q4 = out.variants[0];
  assert.strictEqual(q4.totalBytes, 800);
  assert.strictEqual(q4.files.length, 1);
  assert.strictEqual(
    q4.files[0].url,
    "https://huggingface.co/u/r/resolve/deadbeefcommit/gemma-3-1b-it-Q4_K_M.gguf"
  );
});

test("listGgufQuants collapses sharded quants into one entry", async () => {
  const fetchImpl = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "model-Q4_K_M-00002-of-00002.gguf", size: 50 },
      { type: "file", path: "model-Q4_K_M-00001-of-00002.gguf", size: 50 },
    ] }],
    ["/api/models/", { body: { sha: "c1" } }],
  ]);

  const out = await listGgufQuants({ owner: "u", repo: "r" }, fetchImpl);
  assert.strictEqual(out.variants.length, 1);
  assert.strictEqual(out.variants[0].label, "Q4_K_M");
  assert.strictEqual(out.variants[0].totalBytes, 100);
  // Shards are ordered so the first part comes first (what the loader opens).
  assert.deepStrictEqual(out.variants[0].files.map((f) => f.name), [
    "model-Q4_K_M-00001-of-00002.gguf",
    "model-Q4_K_M-00002-of-00002.gguf",
  ]);
});

test("listGgufQuants rejects gated repos and repos with no GGUF", async () => {
  const gated = stubFetch([["/api/models/", { body: { sha: "c", gated: "manual" } }]]);
  await assert.rejects(listGgufQuants({ owner: "u", repo: "r" }, gated), /gated/);

  const noGguf = stubFetch([
    ["/tree/", { body: [{ type: "file", path: "README.md", size: 1 }] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);
  await assert.rejects(listGgufQuants({ owner: "u", repo: "r" }, noGguf), /No GGUF files/);
});

test("listGgufQuants surfaces a 401 as a gated/private error", async () => {
  const fetchImpl = stubFetch([["/api/models/", { status: 401, body: {} }]]);
  await assert.rejects(listGgufQuants({ owner: "u", repo: "r" }, fetchImpl), /gated or private/);
});

test("recommendedVariant picks the first (best-sorted) entry", () => {
  assert.strictEqual(recommendedVariant([{ label: "Q4_K_M" }, { label: "Q8_0" }]), "Q4_K_M");
  assert.strictEqual(recommendedVariant([]), null);
});

test("buildCleanupModel produces a registry-shaped custom entry", () => {
  const variant = {
    label: "Q4_K_M",
    totalBytes: 800_000_000,
    files: [{ name: "gemma-Q4_K_M.gguf", url: "https://hf/x.gguf", bytes: 800_000_000 }],
  };
  const model = buildCleanupModel("unsloth/gemma-3-1b-it-GGUF", variant);
  assert.strictEqual(model.kind, "cleanup");
  assert.strictEqual(model.engine, "llama-gguf");
  assert.strictEqual(model.custom, true);
  assert.strictEqual(model.gguf.file, "gemma-Q4_K_M.gguf");
  assert.strictEqual(model.id, "custom-unsloth-gemma-3-1b-it-gguf-q4-k-m");
  assert.match(model.note, /not checksum-verified/);
  assert.strictEqual(model.files.length, 1);
});

/* ---------------- STT: sherpa-onnx transducer bundles ---------------- */

test("listSttVariants finds an int8 transducer bundle and pins the commit", async () => {
  const fetchImpl = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "encoder.int8.onnx", size: 600 },
      { type: "file", path: "decoder.int8.onnx", size: 12 },
      { type: "file", path: "joiner.int8.onnx", size: 6 },
      { type: "file", path: "tokens.txt", size: 1 },
      { type: "file", path: "test_wavs/0.wav", size: 100 },
    ] }],
    ["/api/models/", { body: { sha: "sttcommit" } }],
  ]);

  const out = await listSttVariants(
    { owner: "csukuangfj", repo: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8" },
    fetchImpl
  );
  assert.strictEqual(out.commit, "sttcommit");
  assert.strictEqual(out.recommended, "int8");
  assert.strictEqual(out.variants.length, 1);
  const v = out.variants[0];
  assert.strictEqual(v.label, "int8");
  assert.strictEqual(v.totalBytes, 619);
  assert.deepStrictEqual(v.files.map((f) => f.name), [
    "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt",
  ]);
  assert.strictEqual(
    v.files[0].url,
    "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/sttcommit/encoder.int8.onnx"
  );
  // The NeMo repo name selects the nemo transducer flavor.
  assert.deepStrictEqual(v.sherpa, {
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
    modelType: "nemo_transducer",
  });
});

test("listSttVariants includes external-data sidecars with the fp32 variant only", async () => {
  const fetchImpl = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "encoder.onnx", size: 40 },
      { type: "file", path: "encoder.weights", size: 2400 },
      { type: "file", path: "encoder.int8.onnx", size: 600 },
      { type: "file", path: "decoder.onnx", size: 12 },
      { type: "file", path: "joiner.onnx", size: 6 },
      { type: "file", path: "tokens.txt", size: 1 },
    ] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);

  const out = await listSttVariants({ owner: "u", repo: "parakeet-mixed" }, fetchImpl);
  assert.deepStrictEqual(out.variants.map((v) => v.label), ["int8", "fp32"]);
  assert.strictEqual(out.recommended, "int8");

  // int8 encoder + fp32 decoder/joiner fallback, no weights sidecar.
  const int8 = out.variants[0];
  assert.deepStrictEqual(int8.files.map((f) => f.name), [
    "encoder.int8.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt",
  ]);
  assert.strictEqual(int8.sherpa.decoder, "decoder.onnx");

  // fp32 carries the encoder.weights external-data file.
  const fp32 = out.variants[1];
  assert.deepStrictEqual(fp32.files.map((f) => f.name), [
    "encoder.onnx", "decoder.onnx", "joiner.onnx", "encoder.weights", "tokens.txt",
  ]);
});

test("listSttVariants uses the generic transducer type for non-NeMo repos", async () => {
  const fetchImpl = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "encoder-epoch-99-avg-1.onnx", size: 40 },
      { type: "file", path: "decoder-epoch-99-avg-1.onnx", size: 12 },
      { type: "file", path: "joiner-epoch-99-avg-1.onnx", size: 6 },
      { type: "file", path: "tokens.txt", size: 1 },
    ] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);

  const out = await listSttVariants({ owner: "u", repo: "zipformer-en" }, fetchImpl);
  assert.strictEqual(out.variants[0].sherpa.modelType, "transducer");
});

test("listSttVariants rejects repos that are not transducer bundles", async () => {
  const noOnnx = stubFetch([
    ["/tree/", { body: [{ type: "file", path: "model.gguf", size: 1 }] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);
  await assert.rejects(listSttVariants({ owner: "u", repo: "r" }, noOnnx), /No ONNX/);

  const noTokens = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "encoder.onnx", size: 1 },
      { type: "file", path: "decoder.onnx", size: 1 },
      { type: "file", path: "joiner.onnx", size: 1 },
    ] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);
  await assert.rejects(listSttVariants({ owner: "u", repo: "r" }, noTokens), /tokens\.txt/);

  const incomplete = stubFetch([
    ["/tree/", { body: [
      { type: "file", path: "encoder.onnx", size: 1 },
      { type: "file", path: "tokens.txt", size: 1 },
    ] }],
    ["/api/models/", { body: { sha: "c" } }],
  ]);
  await assert.rejects(
    listSttVariants({ owner: "u", repo: "r" }, incomplete),
    /complete transducer/
  );
});

test("buildSttModel produces a registry-shaped custom entry", () => {
  const variant = {
    label: "int8",
    totalBytes: 670_000_000,
    files: [
      { name: "encoder.int8.onnx", url: "https://hf/e.onnx", bytes: 650_000_000 },
      { name: "decoder.int8.onnx", url: "https://hf/d.onnx", bytes: 12_000_000 },
      { name: "joiner.int8.onnx", url: "https://hf/j.onnx", bytes: 8_000_000 },
      { name: "tokens.txt", url: "https://hf/t.txt", bytes: 100 },
    ],
    sherpa: {
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
      modelType: "nemo_transducer",
    },
  };
  const model = buildSttModel("csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", variant);
  assert.strictEqual(model.kind, "stt");
  assert.strictEqual(model.engine, "sherpa-parakeet");
  assert.strictEqual(model.custom, true);
  assert.strictEqual(
    model.id,
    "custom-csukuangfj-sherpa-onnx-nemo-parakeet-tdt-0-6b-v3-int8-int8"
  );
  assert.deepStrictEqual(model.sherpa, variant.sherpa);
  assert.match(model.note, /not checksum-verified/);
  assert.strictEqual(model.files.length, 4);
});
