// Remote API keys at rest. settings.json holds each remote service's key
// (`stt.apiKey`, `cleanup.apiKey`); where the OS offers real secret storage,
// the file holds an Electron safeStorage ciphertext instead (`apiKeyEncrypted`,
// base64) and the plaintext only ever lives in memory.
//
// "Real" is the point: on Linux without a Secret Service (GNOME Keyring,
// KWallet), safeStorage still "encrypts" with a password hardcoded into
// Chromium (backend "basic_text"). That is obfuscation, not protection, so it
// counts as unavailable here: keys stay plaintext (in a 0600 file) and Settings
// says so, instead of implying a protection that isn't there.
//
// Pure helpers over a safeStorage-shaped object, so they can be tested without
// Electron. safeStorage only answers after app `ready`; main/settings.js owns
// that timing and passes `null` before it.

// The settings sections that carry a remote API key.
const SECRET_SECTIONS = ["stt", "cleanup"];
const ENCRYPTED_FIELD = "apiKeyEncrypted";

// Linux backends that are not OS-backed secret storage. "unknown" is what
// Electron reports before `ready` or when it couldn't pick one.
const INSECURE_LINUX_BACKENDS = new Set(["basic_text", "unknown"]);

// Whether keys can be encrypted at rest: `{ secure, backend }`. `backend` is
// the Linux storage backend name (null elsewhere); a reason for the UI is
// derived from it (see renderer/settings.js renderKeyStorage).
function storageStatus(safeStorage, platform) {
  let available = false;
  try {
    available = Boolean(safeStorage?.isEncryptionAvailable());
  } catch {
    // An exception means the same as "no": keep keys usable in plaintext.
  }
  if (platform !== "linux") return { secure: available, backend: null };
  let backend = null;
  try {
    backend = safeStorage?.getSelectedStorageBackend?.() ?? null;
  } catch {
    // Treated like "unknown" below.
  }
  const secure = available && Boolean(backend) && !INSECURE_LINUX_BACKENDS.has(backend);
  return { secure, backend };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Turn the stored file's secrets into plaintext keys. Returns a copy of
// `stored` whose sections carry `apiKey` (decrypted) and never the ciphertext
// field — so nothing downstream, the renderer included, can mistake a blob for
// a key — plus `unreadable`: section → ciphertext that could not be decrypted
// (no safeStorage yet, keyring locked or replaced, file from another machine).
// An unreadable section's key is "" in memory; encodeSecrets() writes its
// ciphertext back until the user enters a new key, so a temporarily locked
// keyring never costs them the stored key.
function decodeSecrets(stored, safeStorage) {
  const unreadable = {};
  if (!isObject(stored)) return { stored, unreadable };
  const out = { ...stored };
  for (const section of SECRET_SECTIONS) {
    if (!isObject(out[section]) || !Object.hasOwn(out[section], ENCRYPTED_FIELD)) continue;
    const { [ENCRYPTED_FIELD]: blob, ...rest } = out[section];
    out[section] = rest;
    if (typeof blob !== "string" || blob === "") continue;
    try {
      if (!safeStorage) throw new Error("secure storage not ready");
      rest.apiKey = safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      rest.apiKey = "";
      unreadable[section] = blob;
    }
  }
  return { stored: out, unreadable };
}

// The on-disk form of `settings` (plaintext keys in memory). With secure
// storage each non-empty key becomes ciphertext; otherwise, or if encrypting
// fails, it stays plaintext — the key keeps working either way. An empty key
// whose stored ciphertext was unreadable keeps that ciphertext (see
// decodeSecrets). Returns `{ disk, encrypted }`, `encrypted` listing the
// sections written as ciphertext.
function encodeSecrets(settings, { status, safeStorage, unreadable = {}, onError } = {}) {
  const disk = { ...settings };
  const encrypted = [];
  for (const section of SECRET_SECTIONS) {
    if (!isObject(disk[section])) continue;
    const { [ENCRYPTED_FIELD]: _ignored, ...rest } = disk[section];
    disk[section] = rest;
    const key = typeof rest.apiKey === "string" ? rest.apiKey : "";
    if (key === "") {
      if (unreadable[section]) {
        rest.apiKey = "";
        rest[ENCRYPTED_FIELD] = unreadable[section];
        encrypted.push(section);
      }
      continue;
    }
    if (!status?.secure || !safeStorage) continue;
    try {
      const blob = safeStorage.encryptString(key).toString("base64");
      rest.apiKey = "";
      rest[ENCRYPTED_FIELD] = blob;
      encrypted.push(section);
    } catch (err) {
      onError?.(section, err);
    }
  }
  return { disk, encrypted };
}

// True when the stored file holds a key in plaintext — what a load with secure
// storage available migrates to ciphertext.
function hasPlaintextSecrets(stored) {
  if (!isObject(stored)) return false;
  return SECRET_SECTIONS.some(
    (section) => typeof stored[section]?.apiKey === "string" && stored[section].apiKey !== ""
  );
}

module.exports = {
  SECRET_SECTIONS,
  ENCRYPTED_FIELD,
  storageStatus,
  decodeSecrets,
  encodeSecrets,
  hasPlaintextSecrets,
};
