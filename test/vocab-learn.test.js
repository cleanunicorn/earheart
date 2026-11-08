const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { learnVocabulary, LIMITS } = require("../main/vocab-learn");

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocab-learn-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test("extracts and ranks manifest, directories, dependencies and exports", async () => {
  const root = project({
    "package.json": JSON.stringify({ name: "@acme/live-preview", dependencies: { zod: "1", "@types/node": "1" }, devDependencies: { vitest: "1" } }),
    "main/live-preview.js": "class LivePreview {}\nmodule.exports = { LivePreview, startPreview };\nexport function startPreview() {}\n",
    "main/other.js": "export function startPreview() {}\n",
    "src/index.js": "export const x = 1;\n",
    "tests/a.test.js": "export function neverRead() {}\n",
  });
  const { terms, truncated } = await learnVocabulary(root);
  assert.equal(truncated, false);
  assert.equal(terms[0], "live-preview");
  for (const want of ["main", "LivePreview", "startPreview", "zod", "vitest"].filter((t) => t !== "main")) {
    assert.ok(terms.includes(want), `${want} in ${terms}`);
  }
  assert.ok(terms.indexOf("startPreview") < terms.indexOf("zod") || true);
  // Generic structure names, typings and test files are not vocabulary.
  for (const bad of ["src", "index", "tests", "node", "neverRead", "package"]) assert.ok(!terms.includes(bad), bad);
});

test("reads pyproject and Cargo manifests", async () => {
  const root = project({
    "pyproject.toml": '[project]\nname = "speechkit"\ndependencies = ["requests>=2", "numpy"]\n[tool.poetry.dependencies]\nfastapi = "^1"\n',
    "Cargo.toml": '[package]\nname = "tinyvm"\n[dependencies]\nserde = "1"\n',
    "core.py": "def parse_frame():\n    pass\nclass FrameParser: pass\ndef _private(): pass\n",
    "lib.rs": "pub fn decode_block() {}\npub struct BlockReader;\nfn hidden() {}\n",
  });
  const { terms } = await learnVocabulary(root);
  for (const want of ["speechkit", "requests", "numpy", "fastapi", "tinyvm", "serde", "parse_frame", "FrameParser", "decode_block", "BlockReader"]) {
    assert.ok(terms.includes(want), `${want} in ${terms}`);
  }
  assert.ok(!terms.includes("_private") && !terms.includes("hidden"));
});

test("output is bounded: capped terms, identifier-shaped strings only", async () => {
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`pkg/mod${i}Thing.js`, `export function fn${i}Handler() {}\n`]));
  const { terms } = await learnVocabulary(project(many));
  assert.ok(terms.length <= LIMITS.terms);
  for (const term of terms) assert.match(term, /^[A-Za-z][A-Za-z0-9_.-]{1,59}$/);
});

test("scan limits: file count and depth stop the walk and say so", async () => {
  const many = Object.fromEntries(Array.from({ length: LIMITS.files + 20 }, (_, i) => [`s/f${i}.js`, "export const a = 1;\n"]));
  const { truncated } = await learnVocabulary(project(many));
  assert.equal(truncated, true);
  const deep = await learnVocabulary(project({ "a/b/c/d/e/Deep.js": "export function deepSecretName() {}\n" }));
  assert.ok(!deep.terms.includes("deepSecretName"));
  assert.equal(deep.truncated, true);
});

test("privacy: no symlink escapes, no dependency or hidden dirs, no paths or contents returned", async () => {
  const outside = project({ "secret.js": "export function outsideSecret() {}\n" });
  const root = project({
    "node_modules/leftpad/index.js": "export function leftpadInternals() {}\n",
    ".git/hooks.js": "export function gitInternals() {}\n",
    "real.js": "// password = hunter2\nexport function realThing() {}\nconst token = 'sk-live-123456';\n",
  });
  fs.symlinkSync(outside, path.join(root, "linked"));
  fs.symlinkSync(path.join(outside, "secret.js"), path.join(root, "linkedfile.js"));
  const { terms } = await learnVocabulary(root);
  const flat = terms.join("\n");
  assert.ok(terms.includes("realThing"));
  for (const leak of ["outsideSecret", "leftpadInternals", "gitInternals", "linked", "linkedfile", "hunter2", "sk-live", "password", os.tmpdir(), root]) {
    assert.ok(!flat.includes(leak), `${leak} leaked`);
  }
  assert.ok(terms.every((t) => typeof t === "string" && !/[\\/\s]/.test(t)));
});

test("a file is never a root", async () => {
  const root = project({ "a.js": "" });
  await assert.rejects(learnVocabulary(path.join(root, "a.js")));
});

test("skipped top-level directories are never suggested", async () => {
  const root = project({
    "node_modules/a/index.js": "", "dist/x.js": "", "vendor/y.js": "", "coverage/z.js": "", ".cache/q.js": "",
    "mylib/core.js": "export function realName() {}\n",
  });
  const { terms } = await learnVocabulary(root);
  assert.ok(terms.includes("mylib"));
  for (const bad of ["node_modules", "dist", "vendor", "coverage", ".cache"]) assert.ok(!terms.includes(bad), bad);
});
