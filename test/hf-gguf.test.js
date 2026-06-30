// Tests for the Hugging Face GGUF discovery used by the custom-model feature.
// Pure module, exercised against a stub fetch.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  parseRepoUrl,
  listGgufQuants,
  recommendedQuant,
  buildCleanupModel,
  quantOf,
} = require("../main/services/hf-gguf");

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

test("parseRepoUrl accepts a repo page URL", () => {
  assert.deepStrictEqual(parseRepoUrl("https://huggingface.co/unsloth/gemma-3-1b-it-GGUF"), {
    owner: "unsloth",
    repo: "gemma-3-1b-it-GGUF",
    ref: undefined,
  });
});

test("parseRepoUrl extracts the ref from blob/tree/resolve URLs", () => {
  assert.strictEqual(
    parseRepoUrl("https://huggingface.co/owner/repo/blob/main/model-Q4_K_M.gguf").ref,
    "main"
  );
  assert.strictEqual(parseRepoUrl("https://huggingface.co/owner/repo/tree/v1.0").ref, "v1.0");
  assert.strictEqual(parseRepoUrl("https://huggingface.co/models/owner/repo").repo, "repo");
});

test("parseRepoUrl rejects non-Hugging-Face and malformed URLs", () => {
  assert.throws(() => parseRepoUrl("https://example.com/owner/repo"), /huggingface\.co/);
  assert.throws(() => parseRepoUrl("https://huggingface.co/owner"), /model repo/);
  assert.throws(() => parseRepoUrl("not a url"), /valid URL/);
  assert.throws(() => parseRepoUrl(""), /Paste a Hugging Face/);
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
  assert.deepStrictEqual(out.quants.map((q) => q.label), ["Q4_K_M", "Q8_0", "Q2_K"]);
  // README is excluded; each quant is one file with a commit-pinned resolve URL.
  const q4 = out.quants[0];
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
  assert.strictEqual(out.quants.length, 1);
  assert.strictEqual(out.quants[0].label, "Q4_K_M");
  assert.strictEqual(out.quants[0].totalBytes, 100);
  // Shards are ordered so the first part comes first (what the loader opens).
  assert.deepStrictEqual(out.quants[0].files.map((f) => f.name), [
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

test("recommendedQuant picks the first (best-sorted) entry", () => {
  assert.strictEqual(recommendedQuant([{ label: "Q4_K_M" }, { label: "Q8_0" }]), "Q4_K_M");
  assert.strictEqual(recommendedQuant([]), null);
});

test("buildCleanupModel produces a registry-shaped custom entry", () => {
  const quant = {
    label: "Q4_K_M",
    totalBytes: 800_000_000,
    files: [{ name: "gemma-Q4_K_M.gguf", url: "https://hf/x.gguf", bytes: 800_000_000 }],
  };
  const model = buildCleanupModel("unsloth/gemma-3-1b-it-GGUF", quant);
  assert.strictEqual(model.kind, "cleanup");
  assert.strictEqual(model.engine, "llama-gguf");
  assert.strictEqual(model.custom, true);
  assert.strictEqual(model.gguf.file, "gemma-Q4_K_M.gguf");
  assert.strictEqual(model.id, "custom-unsloth-gemma-3-1b-it-gguf-q4-k-m");
  assert.match(model.note, /not checksum-verified/);
  assert.strictEqual(model.files.length, 1);
});
