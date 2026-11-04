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
// Where each entry point takes its options (main/engines/index.js):
// ensureCleanup(modelId, opts), primeCleanup(cfg, prefix, opts),
// clean(transcript, cfg, signal, opts) — route.clean forwards the same shape.
const OPTIONS_ARG = { ensureCleanup: 1, primeCleanup: 2, clean: 3 };
const CARRIES_LIMIT = /\bcleanupLimits\s*\(\s*\)|\bmaxRecordingSeconds\b/;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// The top-level arguments of the call opening at `index`, with comments
// dropped and string contents blanked (so a "(" or a "maxRecordingSeconds" in
// a string or comment counts for nothing), or null when `index` isn't a call.
// Enough JavaScript for this repo's call shapes: strings, template literals
// (an interpolation is blanked with its literal), comments, nesting. A regex
// literal holding a bracket would confuse it; none appears in a cleanup call.
function callArgs(text, index) {
  let i = index;
  while (/\s/.test(text[i])) i++;
  if (text[i] !== "(") return null;
  const args = [];
  let current = "";
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "/" && text[j + 1] === "/") {
      j = text.indexOf("\n", j);
      if (j === -1) return null;
      current += "\n";
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      j = text.indexOf("*/", j + 2) + 1;
      if (j === 0) return null;
      current += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let k = j + 1;
      while (k < text.length && text[k] !== c) k += text[k] === "\\" ? 2 : 1;
      if (k >= text.length) return null;
      current += c + c;
      j = k;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (depth++ === 0) continue;
    } else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) {
        if (current.trim() || args.length) args.push(current.trim());
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  return null;
}

// Every cleanup reference in `text` that would reach the facade without the
// limit in its options argument.
function missingLimits(text) {
  const missing = [];
  for (const match of text.matchAll(ENTRY)) {
    const args = callArgs(text, match.index + match[0].length);
    const options = args?.[OPTIONS_ARG[match[2]]];
    if (!options || !CARRIES_LIMIT.test(options)) missing.push({ ref: match[0], line: lineOf(text, match.index) });
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
  assert.deepStrictEqual(missingLimits("engines.ensureCleanup(id, cleanupLimits());"), []);
  assert.deepStrictEqual(missingLimits("engines.primeCleanup(cfg, \"\", cleanupLimits());"), []);
});

test("the contract reads the options argument, not just any text in the call", () => {
  const refs = (src) => missingLimits(src).map((m) => m.ref);
  // The limit in the wrong position: primeCleanup would take it as the prefix.
  assert.deepStrictEqual(refs("engines.primeCleanup(cfg, { maxRecordingSeconds: 900 });"), ["engines.primeCleanup"]);
  assert.deepStrictEqual(refs("route.clean(raw, cfg, { maxRecordingSeconds: 900 });"), ["route.clean"]);
  assert.deepStrictEqual(refs("engines.ensureCleanup(cleanupLimits().id);"), ["engines.ensureCleanup"]);
  // Only in a comment or a string.
  assert.deepStrictEqual(refs("route.clean(raw, cfg, signal /* maxRecordingSeconds */);"), ["route.clean"]);
  assert.deepStrictEqual(refs("route.clean(raw, cfg, signal, // maxRecordingSeconds\n);"), ["route.clean"]);
  assert.deepStrictEqual(refs("route.clean(raw, cfg, signal, { label: 'maxRecordingSeconds' });"), ["route.clean"]);
  // Brackets and commas inside strings, templates and nested calls don't count.
  assert.deepStrictEqual(refs("route.clean(\"(\", cfg, signal, { maxRecordingSeconds: 900 });"), []);
  assert.deepStrictEqual(refs("route.clean(`a, (${x}`, f(a, b), [s, t], { ...cleanupLimits() });"), []);
  assert.deepStrictEqual(refs("route.clean('it\\'s (', cfg, signal, cleanupLimits());"), []);
});
