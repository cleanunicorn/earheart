// Persistence for tool servers and policies: <userData>/tools.json, a 0600
// file written atomically. Kept apart from settings.json on purpose: settings
// are handed to the Settings renderer wholesale, and server environment
// variables may be secrets. Secret env values are encrypted with
// safeStorage where the OS offers real secret storage (same rule as API keys,
// see main/secret-store.js) and otherwise stay plaintext in this 0600 file —
// Settings says which. The file is untrusted on load.

const fs = require("node:fs");
const path = require("node:path");
const { validateServers } = require("./config");

function createStore({ file, safeStorage, secure, onWarn = () => {} }) {
  const canEncrypt = () => Boolean(secure?.() && safeStorage);

  function load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) {
      if (err.code !== "ENOENT") onWarn(`tools.json unreadable, starting empty: ${err.message}`);
      return { servers: [], policies: [] };
    }
    const decoded = (Array.isArray(raw?.servers) ? raw.servers : []).map((s) => {
      if (!s || typeof s !== "object") return s;
      const env = {};
      for (const [k, e] of Object.entries(s.env && typeof s.env === "object" ? s.env : {})) {
        if (e && typeof e === "object" && typeof e.valueEncrypted === "string") {
          let value = "";
          let blob = e.valueEncrypted;
          try { value = safeStorage.decryptString(Buffer.from(e.valueEncrypted, "base64")); blob = undefined; } catch { onWarn(`could not decrypt ${s.id}.${k}`); }
          env[k] = { value, secret: true, ...(blob ? { blob } : {}) };
        } else env[k] = e;
      }
      return { ...s, env };
    });
    const { servers, rejected } = validateServers(decoded);
    for (const r of rejected) onWarn(`ignored tool server "${r.id}": ${r.errors.join("; ")}`);
    // validateServers drops the blob; restore it for unreadable secrets so a
    // temporarily locked keyring never costs the user the stored value.
    for (const s of servers) {
      const src = decoded.find((d) => d?.id === s.id);
      for (const [k, e] of Object.entries(s.env)) if (src?.env?.[k]?.blob) e.blob = src.env[k].blob;
    }
    return { servers, policies: Array.isArray(raw?.policies) ? raw.policies : [] };
  }

  function save({ servers, policies }) {
    const disk = {
      version: 1,
      servers: servers.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, command: s.command, args: s.args, cwd: s.cwd,
        env: Object.fromEntries(Object.entries(s.env).map(([k, e]) => {
          if (!e.secret) return [k, { value: e.value, secret: false }];
          if (e.value === "" && e.blob) return [k, { secret: true, valueEncrypted: e.blob }];
          if (canEncrypt() && e.value !== "") {
            try { return [k, { secret: true, valueEncrypted: safeStorage.encryptString(e.value).toString("base64") }]; } catch (err) { onWarn(`could not encrypt ${s.id}.${k}: ${err.message}`); }
          }
          return [k, { secret: true, value: e.value }];
        })),
      })),
      policies,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      fs.rmSync(tmp, { force: true });
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(disk, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      throw err;
    }
  }

  return { load, save, encrypts: canEncrypt };
}

module.exports = { createStore };
