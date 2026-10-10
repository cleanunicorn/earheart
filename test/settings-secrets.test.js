// API keys at rest (main/secret-store.js + main/settings.js) and the crash
// safety of settings.json: encryption with OS-backed storage, migration of
// plaintext keys, the unavailable/insecure/failing paths, the app-`ready`
// timing safeStorage needs, interrupted writes, malformed files, and what the
// renderer receives from settings:get.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const secretStore = require("../main/secret-store");

// A stand-in for Electron's safeStorage: reversible, and recognisably not the
// plaintext, so a test can tell ciphertext from a key on disk.
function fakeSafeStorage({
  available = true,
  backend = "gnome_libsecret",
  failEncrypt = false,
  failDecrypt = false,
} = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(text) {
      if (failEncrypt) throw new Error("encryption failed");
      return Buffer.from(`enc:${[...text].reverse().join("")}`);
    },
    decryptString(buffer) {
      const text = buffer.toString();
      if (failDecrypt || !text.startsWith("enc:")) throw new Error("decryption failed");
      return [...text.slice(4)].reverse().join("");
    },
  };
}

const ciphertextOf = (key) => fakeSafeStorage().encryptString(key).toString("base64");

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-secrets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stubModules(stubs) {
  const previous = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    previous.set(p, require.cache[p]);
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = exports;
    require.cache[p] = m;
  }
  return () => {
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  };
}

const settingsPath = require.resolve("../main/settings");
const ipcPath = require.resolve("../main/ipc");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(settingsPath)] });

// A fresh main/settings.js (a fresh process, as far as it can tell) over
// `dir`, with `state.ready` deciding app.isReady() and `state.safeStorage`
// standing in for Electron's.
function electronStub(dir, state) {
  return {
    app: {
      getPath: () => dir,
      getVersion: () => "0.0.0",
      isReady: () => state.ready,
    },
    get safeStorage() {
      return state.safeStorage;
    },
    ipcMain: { handle: (channel, fn) => { state.handlers[channel] = fn; }, on() {} },
    shell: {},
  };
}

function commonStubs(dir, state) {
  return {
    [resolveFrom("electron")]: electronStub(dir, state),
    [resolveFrom("./engines/registry")]: {
      DEFAULT_STT_MODEL: "stt-default",
      DEFAULT_CLEANUP_MODEL: "cleanup-default",
    },
    [resolveFrom("./util/logger")]: {
      info: (...args) => state.logs.push(args.join(" ")),
      warn: (...args) => state.warnings.push(args.join(" ")),
      error() {},
    },
  };
}

function loadSettings(t, dir, { ready = true, safeStorage = fakeSafeStorage() } = {}) {
  const state = { ready, safeStorage, warnings: [], logs: [], handlers: {} };
  const restore = stubModules(commonStubs(dir, state));
  delete require.cache[settingsPath];
  try {
    return { settings: require(settingsPath), state };
  } finally {
    delete require.cache[settingsPath];
    restore();
  }
}

// main/ipc.js on top of the real settings module, for the settings:get payload.
function loadIpc(t, dir, options = {}) {
  const state = {
    ready: true,
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
    warnings: [],
    logs: [],
    handlers: {},
  };
  const restore = stubModules({
    ...commonStubs(dir, state),
    [resolveFrom("./engines")]: {
      registry: { setCustomModels() {}, DEFAULT_STT_MODEL: "stt-default", DEFAULT_CLEANUP_MODEL: "cleanup-default" },
      isInstalled: () => false,
    },
    [resolveFrom("./windows")]: { sendToForms() {}, openSettings() {}, closeWizard() {} },
    [resolveFrom("./tray")]: { refresh() {} },
    [resolveFrom("./history")]: { list: () => [], clear() {} },
    [resolveFrom("./services/route")]: {},
    [resolveFrom("./output/deliver")]: {},
    [resolveFrom("./autostart")]: { apply() {}, isEnabled: () => false },
    [resolveFrom("./updates")]: {},
  });
  delete require.cache[settingsPath];
  delete require.cache[ipcPath];
  try {
    const settings = require(settingsPath);
    require(ipcPath).init({
      applyHotkeys: () => ({ hotkey: { ok: true }, pauseHotkey: { ok: true } }),
      onSettingsChanged() {},
    });
    return { settings, handlers: state.handlers, state };
  } finally {
    delete require.cache[settingsPath];
    delete require.cache[ipcPath];
    restore();
  }
}

const fileOf = (dir) => path.join(dir, "settings.json");
const readRaw = (dir) => fs.readFileSync(fileOf(dir), "utf8");
const readFile = (dir) => JSON.parse(readRaw(dir));
const writeFile = (dir, value) =>
  fs.writeFileSync(fileOf(dir), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const strays = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

function assertPrivate(file) {
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, file);
}

function withKeys(settings, stt, cleanup) {
  const cur = settings.get();
  return { ...cur, stt: { ...cur.stt, apiKey: stt }, cleanup: { ...cur.cleanup, apiKey: cleanup } };
}

/* ---------- secret-store helpers ---------- */

test("storageStatus treats only OS-backed storage as secure", () => {
  const cases = [
    ["linux", fakeSafeStorage({ backend: "gnome_libsecret" }), true],
    ["linux", fakeSafeStorage({ backend: "kwallet6" }), true],
    // Chromium's fallback: a hardcoded password, i.e. not protection.
    ["linux", fakeSafeStorage({ backend: "basic_text" }), false],
    ["linux", fakeSafeStorage({ backend: "unknown" }), false],
    ["linux", fakeSafeStorage({ available: false }), false],
    ["darwin", fakeSafeStorage({ backend: undefined }), true],
    ["win32", fakeSafeStorage({ available: false }), false],
    ["linux", null, false],
    ["darwin", { isEncryptionAvailable: () => { throw new Error("boom"); } }, false],
  ];
  for (const [platform, safeStorage, secure] of cases) {
    assert.strictEqual(
      secretStore.storageStatus(safeStorage, platform).secure,
      secure,
      `${platform} ${safeStorage?.getSelectedStorageBackend?.()}`
    );
  }
  assert.strictEqual(secretStore.storageStatus(fakeSafeStorage({ backend: "basic_text" }), "linux").backend, "basic_text");
});

test("encodeSecrets and decodeSecrets round-trip keys and never leave both forms", () => {
  const safeStorage = fakeSafeStorage();
  const settings = { hotkey: "H", stt: { apiKey: "sk-stt", model: "m" }, cleanup: { apiKey: "" } };
  const { disk, encrypted } = secretStore.encodeSecrets(settings, { status: { secure: true }, safeStorage });

  assert.deepStrictEqual(encrypted, ["stt"]);
  assert.strictEqual(disk.stt.apiKey, "");
  assert.strictEqual(disk.stt.apiKeyEncrypted, ciphertextOf("sk-stt"));
  assert.ok(!("apiKeyEncrypted" in disk.cleanup), "an empty key stores no ciphertext");
  assert.strictEqual(settings.stt.apiKey, "sk-stt", "the input is not modified");

  const decoded = secretStore.decodeSecrets(disk, safeStorage);
  assert.deepStrictEqual(decoded.stored.stt, { apiKey: "sk-stt", model: "m" });
  assert.deepStrictEqual(decoded.unreadable, {});
  assert.strictEqual(decoded.stored.hotkey, "H");
});

test("encodeSecrets drops a ciphertext field smuggled in with the settings", () => {
  const { disk } = secretStore.encodeSecrets(
    { stt: { apiKey: "", apiKeyEncrypted: "Zm9yZ2Vk" } },
    { status: { secure: true }, safeStorage: fakeSafeStorage() }
  );
  assert.deepStrictEqual(disk.stt, { apiKey: "" });
});

/* ---------- settings.js: encryption ---------- */

test("a key saved with secure storage is ciphertext on disk and plaintext in memory", (t) => {
  const dir = makeDir(t);
  const { settings } = loadSettings(t, dir);
  settings.save(withKeys(settings, "sk-stt-secret", "sk-cleanup-secret"));

  const raw = readRaw(dir);
  assert.doesNotMatch(raw, /sk-stt-secret|sk-cleanup-secret/);
  assert.strictEqual(readFile(dir).stt.apiKeyEncrypted, ciphertextOf("sk-stt-secret"));
  assert.strictEqual(readFile(dir).cleanup.apiKeyEncrypted, ciphertextOf("sk-cleanup-secret"));
  assertPrivate(fileOf(dir));
  assert.deepStrictEqual(strays(dir), []);

  assert.strictEqual(settings.get().stt.apiKey, "sk-stt-secret");
  assert.ok(!("apiKeyEncrypted" in settings.get().stt));
  assert.deepStrictEqual(settings.keyStorage(), { secure: true, backend: process.platform === "linux" ? "gnome_libsecret" : null, unreadable: [] });

  // Reload after save: a new process decrypts the same keys.
  const reloaded = loadSettings(t, dir).settings.get();
  assert.strictEqual(reloaded.stt.apiKey, "sk-stt-secret");
  assert.strictEqual(reloaded.cleanup.apiKey, "sk-cleanup-secret");
  assert.ok(!("apiKeyEncrypted" in reloaded.stt) && !("apiKeyEncrypted" in reloaded.cleanup));
});

test("plaintext keys from an older version are encrypted on load without losing anything", (t) => {
  const dir = makeDir(t);
  const legacy = {
    hotkey: "Control+Alt+D",
    stt: { engine: "remote", baseUrl: "https://stt.example/v1", apiKey: "sk-old-stt" },
    cleanup: { engine: "remote", apiKey: "sk-old-cleanup", systemPrompt: "My prompt", dictionary: ["Earheart"] },
    customModels: [{ id: "custom-acme", kind: "cleanup" }],
  };
  writeFile(dir, legacy);
  fs.chmodSync(fileOf(dir), 0o644);
  const { settings, state } = loadSettings(t, dir);

  const cfg = settings.get();
  assert.strictEqual(cfg.stt.apiKey, "sk-old-stt");
  assert.strictEqual(cfg.cleanup.apiKey, "sk-old-cleanup");

  const disk = readFile(dir);
  assert.doesNotMatch(readRaw(dir), /sk-old-/);
  assert.strictEqual(disk.stt.apiKeyEncrypted, ciphertextOf("sk-old-stt"));
  assert.strictEqual(disk.hotkey, "Control+Alt+D");
  assert.strictEqual(disk.stt.baseUrl, "https://stt.example/v1");
  assert.strictEqual(disk.cleanup.systemPrompt, "My prompt");
  assert.deepStrictEqual(disk.cleanup.dictionary, ["Earheart"]);
  assert.deepStrictEqual(disk.customModels, legacy.customModels);
  assertPrivate(fileOf(dir));
  assert.ok(state.logs.some((line) => /encrypted the saved API keys/.test(line)));

  // And it comes back the same after a restart.
  assert.strictEqual(loadSettings(t, dir).settings.get().cleanup.apiKey, "sk-old-cleanup");
});

test("without secure storage keys stay plaintext, keep working, and the status says so", (t) => {
  const dir = makeDir(t);
  const raw = JSON.stringify({ stt: { engine: "remote", apiKey: "sk-plain" } });
  writeFile(dir, raw);
  const { settings } = loadSettings(t, dir, { safeStorage: fakeSafeStorage({ available: false }) });

  assert.strictEqual(settings.get().stt.apiKey, "sk-plain");
  assert.strictEqual(readRaw(dir), raw, "nothing to migrate to: the file is left alone");
  assert.strictEqual(settings.keyStorage().secure, false);

  settings.save(withKeys(settings, "sk-new", ""));
  assert.strictEqual(readFile(dir).stt.apiKey, "sk-new");
  assert.ok(!("apiKeyEncrypted" in readFile(dir).stt));
  assertPrivate(fileOf(dir));
  assert.strictEqual(loadSettings(t, dir, { safeStorage: null }).settings.get().stt.apiKey, "sk-new");
});

test("a failed encryption saves the key in plaintext rather than dropping it", (t) => {
  const dir = makeDir(t);
  const { settings, state } = loadSettings(t, dir, { safeStorage: fakeSafeStorage({ failEncrypt: true }) });

  settings.save(withKeys(settings, "sk-keep-me", ""));

  assert.strictEqual(readFile(dir).stt.apiKey, "sk-keep-me");
  assert.strictEqual(settings.get().stt.apiKey, "sk-keep-me");
  assert.ok(state.warnings.some((line) => /could not encrypt the stt API key/.test(line)));
});

test("a key that can't be decrypted is kept on disk, never shown as the key, and replaced only by a new one", (t) => {
  const dir = makeDir(t);
  const blob = ciphertextOf("sk-locked");
  writeFile(dir, { hotkey: "H", stt: { engine: "remote", apiKey: "", apiKeyEncrypted: blob } });
  const { settings, state } = loadSettings(t, dir, { safeStorage: fakeSafeStorage({ failDecrypt: true }) });

  assert.strictEqual(settings.get().stt.apiKey, "");
  assert.ok(!JSON.stringify(settings.get()).includes(blob));
  assert.deepStrictEqual(settings.keyStorage().unreadable, ["stt"]);
  assert.ok(state.warnings.some((line) => /stt API key could not be decrypted/.test(line)));

  // An unrelated save keeps the ciphertext: a keyring unlocked later recovers it.
  settings.save({ ...settings.get(), hotkey: "Other" });
  assert.strictEqual(readFile(dir).stt.apiKeyEncrypted, blob);
  assert.strictEqual(loadSettings(t, dir).settings.get().stt.apiKey, "sk-locked");

  // Entering a key replaces it.
  settings.save(withKeys(settings, "sk-fresh", ""));
  assert.deepStrictEqual(settings.keyStorage().unreadable, []);
  assert.strictEqual(loadSettings(t, dir).settings.get().stt.apiKey, "sk-fresh");
});

/* ---------- settings.js: app `ready` ---------- */

test("before app ready keys are not decrypted, not cached, and saving is refused", (t) => {
  const dir = makeDir(t);
  writeFile(dir, {
    hotkey: "H",
    stt: { apiKey: "", apiKeyEncrypted: ciphertextOf("sk-after-ready") },
    cleanup: { apiKey: "sk-plain-cleanup" },
  });
  const before = readRaw(dir);
  const { settings, state } = loadSettings(t, dir, { ready: false });

  const early = settings.get();
  assert.strictEqual(early.stt.apiKey, "", "the ciphertext is never handed out as the key");
  assert.ok(!("apiKeyEncrypted" in early.stt));
  assert.strictEqual(early.cleanup.apiKey, "sk-plain-cleanup");
  assert.throws(() => settings.save(early), /before the app is ready/);
  assert.strictEqual(readRaw(dir), before, "nothing is written before ready");

  state.ready = true;
  assert.strictEqual(settings.get().stt.apiKey, "sk-after-ready");
  assert.doesNotMatch(readRaw(dir), /sk-plain-cleanup/, "the plaintext key migrates once ready");
});

/* ---------- settings.js: crash safety ---------- */

test("an interrupted write leaves the previous settings intact and no temp file", (t) => {
  const dir = makeDir(t);
  const { settings } = loadSettings(t, dir);
  settings.save(withKeys(settings, "sk-before", ""));
  const before = readRaw(dir);

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (target, data, ...rest) => {
    // Half the bytes reach the temp file, then the disk fills up.
    originalWrite(target, String(data).slice(0, 20), ...rest);
    throw new Error("ENOSPC: simulated disk full");
  };
  try {
    assert.throws(() => settings.save({ ...withKeys(settings, "sk-after", ""), hotkey: "New" }), /ENOSPC/);
  } finally {
    fs.writeFileSync = originalWrite;
  }

  assert.strictEqual(readRaw(dir), before);
  assert.deepStrictEqual(strays(dir), []);
  assert.strictEqual(settings.get().stt.apiKey, "sk-before");
  assert.strictEqual(loadSettings(t, dir).settings.get().stt.apiKey, "sk-before");
});

test("a temp file left by a crash neither loads nor loosens the new file's permissions", (t) => {
  const dir = makeDir(t);
  writeFile(dir, { hotkey: "Saved" });
  // A crash of another process mid-write, and one that reused our pid.
  fs.writeFileSync(path.join(dir, "settings.json.99999.tmp"), '{"hotkey":"Torn');
  const ownTmp = path.join(dir, `settings.json.${process.pid}.tmp`);
  fs.writeFileSync(ownTmp, "{", { mode: 0o644 });
  fs.chmodSync(ownTmp, 0o644);
  const { settings } = loadSettings(t, dir);

  assert.strictEqual(settings.get().hotkey, "Saved");
  settings.save({ ...settings.get(), hotkey: "Next" });
  assert.strictEqual(readFile(dir).hotkey, "Next");
  assertPrivate(fileOf(dir));
  assert.ok(!fs.existsSync(ownTmp));
});

test("a malformed settings file is preserved as a backup before defaults are used", (t) => {
  for (const content of ['{"hotkey":"Mine","stt":{"apiKey":"sk-x"', "", "[]", "null", "42"]) {
    const dir = makeDir(t);
    writeFile(dir, content);
    fs.chmodSync(fileOf(dir), 0o644);
    const { settings, state } = loadSettings(t, dir);

    assert.strictEqual(settings.get().hotkey, settings.DEFAULTS.hotkey, JSON.stringify(content));
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith("settings.json.corrupt-"));
    assert.strictEqual(backups.length, 1, JSON.stringify(content));
    assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), "utf8"), content);
    assertPrivate(path.join(dir, backups[0]));
    assert.ok(state.warnings.some((line) => line.includes(backups[0])));

    // A later save writes a fresh file and leaves the backup alone.
    settings.save(settings.get());
    assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), "utf8"), content);
  }
});

test("a missing settings file is a first run, not a corrupt one", (t) => {
  const dir = makeDir(t);
  const { settings } = loadSettings(t, dir);
  assert.strictEqual(settings.get().hotkey, settings.DEFAULTS.hotkey);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(settings.isFirstRun(), true);
});

/* ---------- what the renderer gets ---------- */

test("settings:get hands the renderer the usable key and a status, never ciphertext", (t) => {
  const dir = makeDir(t);
  const blob = ciphertextOf("sk-for-the-form");
  writeFile(dir, { stt: { engine: "remote", apiKey: "", apiKeyEncrypted: blob } });
  const { handlers } = loadIpc(t, dir);

  const payload = handlers["settings:get"]();
  assert.strictEqual(payload.settings.stt.apiKey, "sk-for-the-form");
  assert.ok(!JSON.stringify(payload).includes("apiKeyEncrypted"));
  assert.ok(!JSON.stringify(payload).includes(blob));
  assert.deepStrictEqual(payload.keyStorage, {
    secure: true,
    backend: process.platform === "linux" ? "gnome_libsecret" : null,
    unreadable: [],
  });
});

test("settings:get reports an undecryptable key as empty and unreadable", (t) => {
  const dir = makeDir(t);
  const blob = ciphertextOf("sk-locked");
  writeFile(dir, { cleanup: { engine: "remote", apiKey: "", apiKeyEncrypted: blob } });
  const { handlers } = loadIpc(t, dir, { safeStorage: fakeSafeStorage({ failDecrypt: true }) });

  const payload = handlers["settings:get"]();
  assert.strictEqual(payload.settings.cleanup.apiKey, "");
  assert.ok(!JSON.stringify(payload).includes(blob));
  assert.deepStrictEqual(payload.keyStorage.unreadable, ["cleanup"]);
});
