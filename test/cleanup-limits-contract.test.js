// The engines facade reads no settings (#204): the builtin cleanup context is
// sized from `audio.maxRecordingSeconds`, which every caller passes as an
// option (main/engines/index.js cleanupModel). A call that drops it still
// works, just with the context for an unset limit, so no behavioural test of
// one call site catches a new one. This guards the coupling at the source:
// every reference to a cleanup entry point in main/ must be a call that
// passes the limit. A bare reference (an injected dependency, a destructured
// alias) fails too: wrap it so the limit is read per call.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "main");
// The facade itself, and the router that forwards its options unchanged.
const EXEMPT = [path.join(MAIN, "engines") + path.sep, path.join(MAIN, "services", "route.js")];
const ENTRY = /\b(route|engines)\s*\.\s*(clean|primeCleanup|ensureCleanup)\b/g;
const CARRIES_LIMIT = /\bcleanupLimits\s*\(\s*\)|\bmaxRecordingSeconds\b/;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// The text between a call's parentheses, or null when `index` isn't a call.
function callArgs(text, index) {
  let i = index;
  while (/\s/.test(text[i])) i++;
  if (text[i] !== "(") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")" && --depth === 0) return text.slice(i + 1, j);
  }
  return null;
}

// Every cleanup reference in `text` that would reach the facade without the limit.
function missingLimits(text) {
  const missing = [];
  for (const match of text.matchAll(ENTRY)) {
    const args = callArgs(text, match.index + match[0].length);
    if (args === null || !CARRIES_LIMIT.test(args)) missing.push({ ref: match[0], line: lineOf(text, match.index) });
  }
  return missing;
}

test("every cleanup call in main/ passes the max dictation length", () => {
  const files = sources(MAIN).filter((file) => !EXEMPT.some((e) => file === e || file.startsWith(e)));
  const missing = [];
  let calls = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    calls += [...text.matchAll(ENTRY)].length;
    for (const m of missingLimits(text)) missing.push(`${path.relative(MAIN, file)}:${m.line} ${m.ref}`);
  }
  assert.deepStrictEqual(missing, [], "pass cleanupLimits() (main/pipeline.js) or { maxRecordingSeconds }");
  // The guard is live: the pipeline's and IPC's cleanup calls are all seen.
  assert.ok(calls >= 5, `expected the known cleanup call sites, saw ${calls}`);
});

test("the cleanup entry points are reached only through route and engines", () => {
  // A destructured or renamed import would slip past the reference check above.
  const files = sources(MAIN).filter((file) => !EXEMPT.some((e) => file === e || file.startsWith(e)));
  const imports = /^(.*)require\(\s*["']([./]*(?:services\/route|engines(?:\/index)?))["']\s*\)/gm;
  const odd = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, lhs, spec] of text.matchAll(imports)) {
      const name = spec.includes("route") ? "route" : "engines";
      if (!new RegExp(`^\\s*const ${name}\\s*=\\s*$`).test(lhs)) odd.push(`${path.relative(MAIN, file)}: ${lhs.trim()} ${spec}`);
    }
  }
  assert.deepStrictEqual(odd, []);
});

test("the contract flags a bare reference and a call that drops the limit", () => {
  // The two shapes that would regress silently: the live preview's injected
  // dependency (#204 plan review) and a new call without options.
  assert.deepStrictEqual(missingLimits("deps({ runCleanup: route.clean });").map((m) => m.ref), ["route.clean"]);
  assert.deepStrictEqual(missingLimits("await route.clean(raw, cfg, signal);").map((m) => m.ref), ["route.clean"]);
  assert.deepStrictEqual(missingLimits("engines.primeCleanup(cfg, prefix).catch(() => {});").map((m) => m.ref), ["engines.primeCleanup"]);
  assert.deepStrictEqual(missingLimits("route.clean(raw, cfg, signal, { ...cleanupLimits(), onProgress });"), []);
  assert.deepStrictEqual(missingLimits("route.clean(s, cfg, undefined, {\n  maxRecordingSeconds: 1,\n});"), []);
});
