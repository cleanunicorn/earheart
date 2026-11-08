// "Learn from a folder" (#72): the words a project is likely to be talked
// about with, pulled from a folder the user picked. Pure and bounded:
//
// - Reads only inside `root`, never follows symlinks, skips dependency, build
//   and hidden directories, and stops at fixed limits (LIMITS below), so a
//   huge monorepo costs a bounded scan and a bounded answer.
// - Returns identifier-shaped strings only. No paths, no file contents, no
//   line text ever leave this module: a name is kept only if it matches
//   NAME_RE, so even a hostile file can't smuggle prose or a path through.
// - Ranked, then capped at LIMITS.terms: a manifest name beats a top-level
//   directory, which beats a dependency, which beats an exported symbol (more
//   exports of the same name rank it higher), which beats a source file name.
//
// The result is a suggestion for the Settings review panel; nothing here
// writes the dictionary.

const fs = require("node:fs/promises");
const path = require("node:path");

const LIMITS = {
  terms: 40, // candidates returned
  files: 300, // source files read
  entries: 300, // directory entries looked at per directory
  depth: 3, // directory levels below the root
  fileBytes: 65536, // read from the start of each file
  termChars: 60,
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  "__pycache__", "venv", "env", "site-packages", "bower_components", "tmp", "temp", "cache"]);
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs"]);

// Names that are structure, not vocabulary: saying them aloud is ordinary
// English the model already gets right, and forcing them in would hurt.
const GENERIC = new Set(["src", "lib", "libs", "app", "apps", "main", "index", "init", "test", "tests",
  "spec", "specs", "docs", "doc", "scripts", "script", "assets", "public", "static", "bin", "dev", "utils",
  "util", "helpers", "common", "shared", "types", "config", "configs", "core", "components", "pages",
  "readme", "license", "licence", "changelog", "contributing", "makefile", "dockerfile", "package",
  "package-lock", "tsconfig", "setup", "default", "name", "version", "data", "test", "mod", "build",
  "dist", "out", "target", "venv", "env", "vendor", "coverage", "fixtures", "examples", "example", "packages", "modules", "services", "models", "views", "styles"]);

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{1,59}$/;

// Weights for the ranking: where a name was found.
const WEIGHT = { manifest: 10, topDir: 6, dependency: 4, export: 3, topFile: 2, sourceFile: 1 };

function usable(name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.length > LIMITS.termChars) return false;
  if (/[._-]$/.test(name)) return false;
  return !GENERIC.has(name.toLowerCase());
}

class Tally {
  constructor() { this.scores = new Map(); }
  add(name, weight) {
    if (!usable(name)) return;
    this.scores.set(name, (this.scores.get(name) || 0) + weight);
  }
  ranked() {
    // The same spelling in two cases is one word to the speaker: keep the
    // higher-scored (then first-seen) spelling.
    const byFold = new Map();
    for (const [name, score] of this.scores) {
      const key = name.toLowerCase();
      const best = byFold.get(key);
      if (!best || score > best.score) byFold.set(key, { name, score });
    }
    return [...byFold.values()]
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1))
      .map((entry) => entry.name);
  }
}

async function readHead(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buf = Buffer.alloc(LIMITS.fileBytes);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

// "@scope/pkg" → "pkg"; "@types/*" is typings, not something said aloud.
function packageWord(name) {
  if (name.startsWith("@types/")) return "";
  return name.startsWith("@") ? name.split("/")[1] || "" : name;
}

function manifestNames(file, text, tally) {
  if (file === "package.json") {
    let json;
    try { json = JSON.parse(text); } catch { return; }
    if (typeof json?.name === "string") tally.add(packageWord(json.name), WEIGHT.manifest);
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = json?.[key];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        for (const dep of Object.keys(deps)) tally.add(packageWord(dep), WEIGHT.dependency);
      }
    }
  } else if (file === "pyproject.toml" || file === "Cargo.toml") {
    // Line scan of the few shapes that carry names; not a TOML parser.
    let section = "";
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) { section = header[1].trim(); continue; }
      if (/^(project|package|tool\.poetry)$/.test(section)) {
        const name = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line);
        if (name) tally.add(name[1], WEIGHT.manifest);
      }
      if (/(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(section)) {
        const key = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*=/.exec(line);
        if (key) tally.add(key[1], WEIGHT.dependency);
      }
      if (section === "project") {
        // dependencies = [ "requests>=2", ... ] on one or many lines
        for (const spec of line.matchAll(/["']([A-Za-z][A-Za-z0-9_.-]*)\s*(?:[<>=!~;\[ ].*?)?["']/g)) {
          if (/dependencies\s*=|^\s*["']/.test(line)) tally.add(spec[1], WEIGHT.dependency);
        }
      }
    }
  }
}

const EXPORT_PATTERNS = {
  js: [
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
  ],
  py: [/^(?:async\s+)?(?:def|class)\s+([A-Za-z][A-Za-z0-9_]*)/gm],
  rs: [/\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait|mod|type)\s+([A-Za-z][A-Za-z0-9_]*)/g],
};

function exportedNames(ext, text, tally) {
  const kind = ext === ".py" ? "py" : ext === ".rs" ? "rs" : "js";
  for (const re of EXPORT_PATTERNS[kind]) {
    for (const match of text.matchAll(re)) tally.add(match[1], WEIGHT.export);
  }
  if (kind === "js") {
    // module.exports = { a, b, c: x } — the keys of the exported object.
    const block = /module\.exports\s*=\s*\{([^}]{0,2000})\}/.exec(text);
    if (block) {
      for (const key of block[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=[,:}\n]|$)/g)) {
        tally.add(key[1], WEIGHT.export);
      }
    }
  }
}

/**
 * Candidate vocabulary for the project at `root` (a directory the caller has
 * already chosen). Returns `{ terms, truncated }` where `terms` is at most
 * LIMITS.terms identifier strings, best first, and `truncated` says a limit
 * stopped the scan early. Throws if `root` isn't a readable directory.
 */
async function learnVocabulary(root) {
  const base = await fs.realpath(root);
  if (!(await fs.stat(base)).isDirectory()) throw new Error("Choose a folder.");
  const tally = new Tally();
  let files = 0;
  let truncated = false;

  async function listDir(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    if (entries.length > LIMITS.entries) { truncated = true; entries = entries.slice(0, LIMITS.entries); }
    return entries;
  }

  async function walk(dir, depth) {
    for (const entry of await listDir(dir)) {
      // Dirent says symlink for links, so neither isFile nor isDirectory
      // matches them: nothing outside the chosen folder is ever reached.
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        if (depth === 0) tally.add(name, WEIGHT.topDir);
        if (depth + 1 < LIMITS.depth) await walk(path.join(dir, name), depth + 1);
        else truncated = true;
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        const stem = path.basename(name, path.extname(name));
        if (depth === 0 && ["package.json", "pyproject.toml", "Cargo.toml"].includes(name)) {
          manifestNames(name, await readHead(path.join(dir, name)), tally);
          continue;
        }
        if (!SOURCE_EXT.has(ext) || name.endsWith(".d.ts") || /\.(test|spec)$/.test(stem)) continue;
        tally.add(stem, depth === 0 ? WEIGHT.topFile : WEIGHT.sourceFile);
        if (files >= LIMITS.files) { truncated = true; continue; }
        files += 1;
        exportedNames(ext, await readHead(path.join(dir, name)), tally);
      }
    }
  }

  await walk(base, 0);
  return { terms: tally.ranked().slice(0, LIMITS.terms), truncated };
}

module.exports = { learnVocabulary, LIMITS };
