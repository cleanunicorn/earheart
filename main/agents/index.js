// The adapters Earheart knows about, and lazy detection of what is installed.
// Nothing here runs at startup: detection spawns `--version` only when the
// agent features are enabled and the user opens them.

const { spawn } = require("node:child_process");
const { resolveBinary } = require("./common");

const ADAPTERS = [require("./codex"), require("./claude")];

function get(id, adapters = ADAPTERS) {
  return adapters.find((adapter) => adapter.id === id) || null;
}

function version(file, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(file, ["--version"], { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim().split("\n")[0].slice(0, 80) || null); });
  });
}

// { id, label, models, available, path?, version?, reason? } per adapter.
async function detectAll(binaries = {}, adapters = ADAPTERS) {
  return Promise.all(
    adapters.map(async (adapter) => {
      const base = { id: adapter.id, label: adapter.label, models: adapter.models };
      const found = resolveBinary(adapter.binary, binaries[adapter.id] || "");
      if (!found.ok) return { ...base, available: false, reason: found.reason };
      return { ...base, available: true, path: found.path, version: await version(found.path) };
    })
  );
}

module.exports = { ADAPTERS, get, detectAll };
