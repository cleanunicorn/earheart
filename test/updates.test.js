// Download, verify and install flow of main/updates.js against a real
// file:// feed (EARHEART_UPDATE_FEED).
//
// #186: updates were staged in the shared /tmp/earheart-update, written
// through planted symlinks, and installed without re-checking the sha512, so
// another local user could swap in their own binary. This loads the real
// updates.js, update-feed.js and update-fetch.js with Electron and the
// window/pipeline neighbours stubbed (the require.cache pattern of
// updates-init.test.js). child_process is patched around the require, so the
// installers' detached scripts and setup.exe are recorded, never run.

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");
const childProcess = require("node:child_process");

const updatesPath = require.resolve("../main/updates");
const settingsPath = require.resolve("../main/settings");
const resolveFrom = (spec) => require.resolve(spec, { paths: [path.dirname(updatesPath)] });
const feed = require("../main/services/update-feed");

const POSIX = { skip: process.platform === "win32" && "POSIX permissions and symlinks" };
const LATEST = "0.36.0";
const ASSET_BYTES = Buffer.from("verified update payload\n");
const sha512 = (buf) => crypto.createHash("sha512").update(buf).digest("base64");

// Pretend to be another OS for the rest of this test: the install kind and the
// feed file both follow process.platform/arch.
function overrideProcess(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { value, configurable: true, writable: true });
    t.after(() => Object.defineProperty(process, key, before));
  }
}

function assetNameFor(platform) {
  if (platform === "darwin") return `Earheart-${LATEST}-arm64-mac.zip`;
  if (platform === "win32") return `Earheart-Setup-${LATEST}.exe`;
  return `Earheart-${LATEST}.AppImage`;
}

function writeFeed(dir, { bytes = ASSET_BYTES, sha = sha512(bytes) } = {}) {
  const name = assetNameFor(process.platform);
  fs.writeFileSync(path.join(dir, name), bytes);
  fs.writeFileSync(
    path.join(dir, feed.feedFileFor(process.platform, process.arch)),
    [
      `version: ${LATEST}`,
      "files:",
      `  - url: ${name}`,
      `    sha512: ${sha}`,
      `    size: ${bytes.length}`,
      `path: ${name}`,
      `sha512: ${sha}`,
      "",
    ].join("\n")
  );
  return name;
}

function loadUpdates(t, { stored, isPackaged = false, dictation = "recording", feedOpts, spawnSyncImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-updates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "userData");
  const temp = path.join(root, "temp");
  const appPath = path.join(root, "app");
  const feedDir = path.join(root, "feed");
  for (const dir of [userData, temp, appPath, feedDir]) fs.mkdirSync(dir);
  if (stored) fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(stored));
  const assetName = writeFeed(feedDir, feedOpts);

  const calls = { spawn: [], spawnSync: [], quit: 0 };
  const logs = { warn: [], error: [] };
  const stubs = {
    [resolveFrom("electron")]: {
      app: {
        getPath: (name) => (name === "userData" ? userData : name === "temp" ? temp : root),
        getVersion: () => "0.35.1",
        getAppPath: () => appPath,
        isPackaged,
        quit: () => calls.quit++,
      },
      Notification: class {
        on() {}
        show() {}
      },
      shell: {},
    },
    [resolveFrom("./windows")]: {
      broadcast() {},
      sendToOverlay() {},
      setOverlayPinned() {},
      hideOverlay() {},
      showOverlay() {},
      openSettings() {},
    },
    [resolveFrom("./pipeline")]: { onStateChange() {}, getState: () => dictation },
    [resolveFrom("./util/mac-signature")]: { ensureMacSignature() {} },
    [resolveFrom("./engines/registry")]: {
      DEFAULT_STT_MODEL: "stt-default",
      DEFAULT_CLEANUP_MODEL: "cleanup-default",
    },
    [resolveFrom("./util/logger")]: {
      info() {},
      warn: (...args) => logs.warn.push(args.join(" ")),
      error: (...args) => logs.error.push(args.join(" ")),
    },
  };

  const previous = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    previous.set(p, require.cache[p]);
    const m = new Module(p, null);
    m.filename = p;
    m.loaded = true;
    m.exports = exports;
    require.cache[p] = m;
  }
  // updates.js destructures spawn/spawnSync at load, so the fakes stick.
  const { spawn, spawnSync } = childProcess;
  childProcess.spawn = (...args) => {
    calls.spawn.push(args);
    return { unref() {} };
  };
  childProcess.spawnSync = (...args) => {
    calls.spawnSync.push(args);
    return spawnSyncImpl ? spawnSyncImpl(...args) : { status: 0 };
  };
  delete require.cache[updatesPath];
  delete require.cache[settingsPath];
  let updates;
  try {
    require(settingsPath);
    updates = require(updatesPath);
  } finally {
    childProcess.spawn = spawn;
    childProcess.spawnSync = spawnSync;
    delete require.cache[updatesPath];
    delete require.cache[settingsPath];
    for (const [p, old] of previous) {
      if (old) require.cache[p] = old;
      else delete require.cache[p];
    }
  }
  const feedEnv = process.env.EARHEART_UPDATE_FEED;
  process.env.EARHEART_UPDATE_FEED = pathToFileURL(feedDir).href;
  t.after(() => {
    updates.dispose();
    if (feedEnv === undefined) delete process.env.EARHEART_UPDATE_FEED;
    else process.env.EARHEART_UPDATE_FEED = feedEnv;
  });
  const stagingDir = path.join(userData, "updates");
  return {
    updates,
    root,
    userData,
    temp,
    stagingDir,
    staged: path.join(stagingDir, assetName),
    calls,
    logs,
  };
}

async function download(updates) {
  await updates.check({ manual: true });
  assert.strictEqual(updates.getState().status, "available");
  await updates.startUpdate();
}

async function waitFor(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Linux AppImage install: APPIMAGE points at the user's (victim) AppImage.
function asAppImage(t) {
  overrideProcess(t, { platform: "linux" });
  const before = process.env.APPIMAGE;
  t.after(() => {
    if (before === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = before;
  });
  return (root) => {
    const target = path.join(root, "Earheart.AppImage");
    fs.writeFileSync(target, "old app\n");
    process.env.APPIMAGE = target;
    return target;
  };
}

// --- AC4: download and verify against a real file:// feed -----------------

test("a wrong sha512 fails with Checksum mismatch and leaves nothing staged", async (t) => {
  const ctx = loadUpdates(t, { feedOpts: { sha: sha512(Buffer.from("something else")) } });
  ctx.updates.init({});

  await download(ctx.updates);

  const s = ctx.updates.getState();
  assert.strictEqual(s.status, "error");
  assert.match(s.error, /Checksum mismatch/);
  assert.deepStrictEqual(fs.readdirSync(ctx.stagingDir), []);
});

test("the right sha512 stages the exact bytes and reaches ready", async (t) => {
  const ctx = loadUpdates(t);
  ctx.updates.init({});

  await download(ctx.updates);

  assert.strictEqual(ctx.updates.getState().status, "ready");
  assert.deepStrictEqual(fs.readFileSync(ctx.staged), ASSET_BYTES);
  assert.ok(!fs.existsSync(path.join(ctx.temp, "earheart-update")), "nothing staged in temp");
});

test("a skipped version stays idle on an automatic check and shows on a manual one", async (t) => {
  const ctx = loadUpdates(t, { stored: { updates: { skippedVersion: LATEST } } });
  ctx.updates.init({});

  await ctx.updates.check();
  assert.strictEqual(ctx.updates.getState().status, "idle");
  assert.strictEqual(ctx.updates.getState().latest, null);

  await ctx.updates.check({ manual: true });
  assert.strictEqual(ctx.updates.getState().status, "available");
  assert.strictEqual(ctx.updates.getState().latest, LATEST);
});

test("check() while ready is a no-op", async (t) => {
  const ctx = loadUpdates(t);
  ctx.updates.init({});
  await download(ctx.updates);
  const before = ctx.updates.getState();
  assert.strictEqual(before.status, "ready");

  await ctx.updates.check({ manual: true });

  assert.deepStrictEqual(ctx.updates.getState(), before);
});

// --- AC1: a private, per-user staging dir ---------------------------------

test("the staging dir is private even when it already exists world-writable", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  fs.mkdirSync(ctx.stagingDir);
  fs.chmodSync(ctx.stagingDir, 0o777);
  fs.writeFileSync(path.join(ctx.stagingDir, "planted"), "x");
  ctx.updates.init({});

  await download(ctx.updates);

  assert.strictEqual(ctx.updates.getState().status, "ready");
  assert.strictEqual(fs.statSync(ctx.stagingDir).mode & 0o777, 0o700);
  assert.ok(!fs.existsSync(path.join(ctx.stagingDir, "planted")), "loose dir was replaced");
});

test("a symlink planted as the staging dir is replaced, not followed", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  const elsewhere = path.join(ctx.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, ctx.stagingDir);
  ctx.updates.init({});

  await download(ctx.updates);

  assert.strictEqual(ctx.updates.getState().status, "ready");
  const st = fs.lstatSync(ctx.stagingDir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.strictEqual(st.mode & 0o777, 0o700);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test("a staging dir owned by another user is replaced", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  fs.mkdirSync(ctx.stagingDir, { mode: 0o700 });
  fs.writeFileSync(path.join(ctx.stagingDir, "theirs"), "x");
  ctx.updates.init({});
  await ctx.updates.check({ manual: true });

  const realLstat = fs.lstatSync;
  let faked = 0;
  fs.lstatSync = (p, ...rest) => {
    const st = realLstat(p, ...rest);
    if (p === ctx.stagingDir && !faked++) {
      return { isDirectory: () => true, uid: process.getuid() + 1, mode: st.mode };
    }
    return st;
  };
  try {
    await ctx.updates.startUpdate();
  } finally {
    fs.lstatSync = realLstat;
  }

  assert.strictEqual(faked, 1);
  assert.strictEqual(ctx.updates.getState().status, "ready");
  assert.ok(!fs.existsSync(path.join(ctx.stagingDir, "theirs")), "foreign dir was replaced");
});

// --- AC2: planted symlinks are never followed -----------------------------

test("a symlink planted at the .part path is not written through", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  const victim = path.join(ctx.root, "victim-bashrc");
  fs.writeFileSync(victim, "precious\n");
  fs.mkdirSync(ctx.stagingDir, { mode: 0o700 });
  fs.symlinkSync(victim, `${ctx.staged}.part`);
  ctx.updates.init({});

  await download(ctx.updates);

  assert.strictEqual(ctx.updates.getState().status, "ready");
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "precious\n");
  assert.deepStrictEqual(fs.readFileSync(ctx.staged), ASSET_BYTES);
  assert.ok(!fs.lstatSync(ctx.staged).isSymbolicLink());
});

test("installLinux replaces the AppImage without following planted symlinks", POSIX, async (t) => {
  const appImage = asAppImage(t);
  const ctx = loadUpdates(t, { isPackaged: true });
  const target = appImage(ctx.root);
  const victim = path.join(ctx.root, "victim-bashrc");
  const victim2 = path.join(ctx.root, "victim-profile");
  fs.writeFileSync(victim, "precious\n");
  fs.writeFileSync(victim2, "precious too\n");
  fs.mkdirSync(ctx.stagingDir, { mode: 0o700 });
  fs.symlinkSync(victim, path.join(ctx.stagingDir, "relaunch.sh"));
  fs.symlinkSync(victim2, `${target}.update.part`);
  ctx.updates.init({});
  await download(ctx.updates);

  await ctx.updates.installNow();

  assert.strictEqual(ctx.updates.getState().status, "installing");
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "precious\n");
  assert.strictEqual(fs.readFileSync(victim2, "utf8"), "precious too\n");
  assert.deepStrictEqual(fs.readFileSync(target), ASSET_BYTES);
  assert.strictEqual(fs.statSync(target).mode & 0o777, 0o755);
  const script = path.join(ctx.stagingDir, "relaunch.sh");
  assert.ok(!fs.lstatSync(script).isSymbolicLink());
  assert.strictEqual(fs.statSync(script).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(script, "utf8"), /earheart update relaunch/);
  assert.strictEqual(ctx.calls.spawn.length, 1);
  const [cmd, args, opts] = ctx.calls.spawn[0];
  assert.strictEqual(cmd, "/bin/sh");
  assert.deepStrictEqual(args, [script, String(process.pid), target]);
  assert.strictEqual(opts.detached, true);
  assert.strictEqual(ctx.calls.quit, 1);
});

// --- AC3: install re-verifies the staged file -----------------------------

test("installNow refuses a staged file tampered with after download", POSIX, async (t) => {
  const appImage = asAppImage(t);
  const ctx = loadUpdates(t, { isPackaged: true });
  const target = appImage(ctx.root);
  ctx.updates.init({});
  await download(ctx.updates);
  assert.strictEqual(ctx.updates.getState().status, "ready");

  fs.writeFileSync(ctx.staged, "#!/bin/sh\necho ATTACKER PAYLOAD\n");
  await ctx.updates.installNow();

  const s = ctx.updates.getState();
  assert.strictEqual(s.status, "error");
  assert.match(s.error, /checksum/i);
  assert.strictEqual(fs.readFileSync(target, "utf8"), "old app\n");
  assert.ok(!fs.existsSync(ctx.staged), "tampered file discarded");
  assert.strictEqual(ctx.calls.spawn.length, 0);
  assert.strictEqual(ctx.calls.quit, 0);
  assert.strictEqual(ctx.logs.error.length, 1);

  // The offer survives: a retry downloads a fresh, verified copy.
  await ctx.updates.startUpdate();
  assert.strictEqual(ctx.updates.getState().status, "ready");
  assert.deepStrictEqual(fs.readFileSync(ctx.staged), ASSET_BYTES);
});

test("installNow refuses a staged file swapped for a symlink, even to the right bytes", POSIX, async (t) => {
  const appImage = asAppImage(t);
  const ctx = loadUpdates(t, { isPackaged: true });
  const target = appImage(ctx.root);
  ctx.updates.init({});
  await download(ctx.updates);

  const lookalike = path.join(ctx.root, "lookalike");
  fs.writeFileSync(lookalike, ASSET_BYTES);
  fs.rmSync(ctx.staged);
  fs.symlinkSync(lookalike, ctx.staged);
  await ctx.updates.installNow();

  assert.strictEqual(ctx.updates.getState().status, "error");
  assert.strictEqual(fs.readFileSync(target, "utf8"), "old app\n");
  assert.deepStrictEqual(fs.readFileSync(lookalike), ASSET_BYTES);
  assert.strictEqual(ctx.calls.spawn.length, 0);
});

// --- AC5: macOS and Windows install flows are unchanged ----------------------

test("installWindows runs the verified setup silently and quits", async (t) => {
  overrideProcess(t, { platform: "win32" });
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  t.after(() => {
    if (portable !== undefined) process.env.PORTABLE_EXECUTABLE_FILE = portable;
  });
  const ctx = loadUpdates(t, { isPackaged: true });
  ctx.updates.init({});
  await download(ctx.updates);

  await ctx.updates.installNow();

  assert.strictEqual(ctx.calls.spawn.length, 1);
  const [cmd, args, opts] = ctx.calls.spawn[0];
  assert.strictEqual(cmd, ctx.staged);
  assert.deepStrictEqual(args, ["/S", "--force-run"]);
  assert.deepStrictEqual(opts, { detached: true, stdio: "ignore" });
  assert.strictEqual(ctx.calls.quit, 1);
});

test("installMac swaps in the extracted bundle through the swap script", async (t) => {
  const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "earheart-mac-")), "Earheart.app");
  t.after(() => fs.rmSync(path.dirname(bundle), { recursive: true, force: true }));
  overrideProcess(t, {
    platform: "darwin",
    arch: "arm64",
    execPath: path.join(bundle, "Contents", "MacOS", "Earheart"),
  });
  // Stand-in for ditto: "extract" a bundle reporting the expected version.
  const spawnSyncImpl = (cmd, args) => {
    if (cmd === "/usr/bin/ditto") {
      const contents = path.join(args[2], "Earheart.app", "Contents");
      fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
      fs.writeFileSync(
        path.join(contents, "Info.plist"),
        `<key>CFBundleShortVersionString</key>\n<string>${LATEST}</string>`
      );
    }
    return { status: 0 };
  };
  const ctx = loadUpdates(t, { isPackaged: true, spawnSyncImpl });
  ctx.updates.init({});
  await download(ctx.updates);

  await ctx.updates.installNow();

  assert.strictEqual(ctx.updates.getState().error, null);
  assert.strictEqual(ctx.calls.spawnSync[0][0], "/usr/bin/ditto");
  assert.deepStrictEqual(ctx.calls.spawnSync[0][1], ["-xk", ctx.staged, path.join(ctx.stagingDir, "staging")]);
  assert.strictEqual(ctx.calls.spawn.length, 1);
  const [cmd, args] = ctx.calls.spawn[0];
  const script = path.join(ctx.stagingDir, "swap.sh");
  assert.strictEqual(cmd, "/bin/sh");
  assert.deepStrictEqual(args, [
    script,
    String(process.pid),
    bundle,
    path.join(ctx.stagingDir, "staging", "Earheart.app"),
  ]);
  assert.match(fs.readFileSync(script, "utf8"), /earheart update swap/);
  assert.strictEqual(ctx.calls.quit, 1);
});

// --- AC5: leftover sweep follows the staging dir --------------------------

test("init sweeps the extraction dir but keeps a verified download", async (t) => {
  const ctx = loadUpdates(t);
  fs.mkdirSync(path.join(ctx.stagingDir, "staging", "Earheart.app"), { recursive: true });
  fs.writeFileSync(ctx.staged, ASSET_BYTES);

  ctx.updates.init({});

  await waitFor(() => !fs.existsSync(path.join(ctx.stagingDir, "staging")), "staging sweep");
  assert.deepStrictEqual(fs.readFileSync(ctx.staged), ASSET_BYTES);
});

test("init removes our old shared temp staging dir", async (t) => {
  const ctx = loadUpdates(t);
  const legacy = path.join(ctx.temp, "earheart-update");
  fs.mkdirSync(path.join(legacy, "staging"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "Earheart-0.35.0.AppImage"), "old");

  ctx.updates.init({});

  await waitFor(() => !fs.existsSync(legacy), "legacy sweep");
});

test("init removes a symlink at the old temp path without following it", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  const victimDir = path.join(ctx.root, "victim-dir");
  fs.mkdirSync(path.join(victimDir, "staging"), { recursive: true });
  fs.writeFileSync(path.join(victimDir, "keep"), "precious");
  const legacy = path.join(ctx.temp, "earheart-update");
  fs.symlinkSync(victimDir, legacy);

  ctx.updates.init({});

  await waitFor(() => !fs.existsSync(legacy), "legacy link removal");
  assert.strictEqual(fs.readFileSync(path.join(victimDir, "keep"), "utf8"), "precious");
  assert.ok(fs.existsSync(path.join(victimDir, "staging")));
});

test("init leaves another user's old temp staging dir alone", POSIX, async (t) => {
  const ctx = loadUpdates(t);
  const legacy = path.join(ctx.temp, "earheart-update");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "theirs"), "x");
  const realLstat = fsp.lstat;
  fsp.lstat = async (p, ...rest) => {
    const st = await realLstat(p, ...rest);
    if (p !== legacy) return st;
    return { isSymbolicLink: () => false, isDirectory: () => true, uid: process.getuid() + 1 };
  };
  t.after(() => {
    fsp.lstat = realLstat;
  });

  ctx.updates.init({});

  await waitFor(() => ctx.logs.warn.some((w) => /another user/.test(w)), "foreign-dir warning");
  assert.ok(fs.existsSync(path.join(legacy, "theirs")));
});

test("init clears a leftover .update-old bundle on macOS", async (t) => {
  const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "earheart-mac-")), "Earheart.app");
  t.after(() => fs.rmSync(path.dirname(bundle), { recursive: true, force: true }));
  fs.mkdirSync(`${bundle}.update-old`, { recursive: true });
  overrideProcess(t, {
    platform: "darwin",
    arch: "arm64",
    execPath: path.join(bundle, "Contents", "MacOS", "Earheart"),
  });
  const ctx = loadUpdates(t, { isPackaged: true });

  ctx.updates.init({});

  await waitFor(() => !fs.existsSync(`${bundle}.update-old`), ".update-old sweep");
});
