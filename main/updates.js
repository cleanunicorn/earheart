// In-app updater: checks the GitHub release feed, downloads the new build,
// verifies its checksum and installs it — per platform:
//
//   Windows (NSIS install)  run the new setup silently and relaunch
//   macOS (.app bundle)     swap the bundle via a detached script, strip the
//                           com.apple.quarantine attribute (the app ships
//                           unsigned, so this is what prevents Gatekeeper's
//                           "Earheart is damaged" dialog), relaunch
//   Linux (AppImage)        replace the AppImage in place and relaunch
//
// Portable/deb/translocated installs can't be updated in place; those get a
// "download it yourself" path to the releases page instead.
//
// electron-updater is deliberately not used: its macOS half requires a signed
// app. The feed it would read (latest*.yml, published by CI with every
// release) is consumed directly instead — see services/update-feed.js.
//
// Set EARHEART_UPDATE_FEED to a directory URL (http(s):// or file://) that
// contains latest*.yml + assets to test the whole flow against a local build;
// in dev (unpackaged) the install step is a dry-run log.

const { app, Notification, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const { pipeline: streamPipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");

const feed = require("./services/update-feed");
const settings = require("./settings");
const windows = require("./windows");
const dictation = require("./pipeline");
const logger = require("./util/logger");

const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

let state = {
  status: "idle", // idle | checking | available | downloading | ready | installing | error
  current: "",
  latest: null,
  progress: null, // { received, total, fraction } while downloading
  error: null,
  method: "none", // install | open-releases | none
  hint: null,
};

let installKind = "dev";
let onStateChange = null;
let startupTimer = null;
let intervalTimer = null;
let downloadController = null;
let notifiedVersion = null;
let pendingInfo = null; // parsed feed entry for `latest`
let downloadedPath = null; // verified asset waiting to be installed

// The overlay update prompt: a banner on the always-on-top card (an OS toast
// alone proved far too easy to miss). `promptShowing` means the banner is up
// and the overlay is pinned open for it; `promptPending` means it's queued —
// an update found mid-dictation waits and attaches under the result card once
// the text has landed, so the prompt never interrupts someone mid-sentence.
// `promptSolo` means the card came up for the prompt alone (no dictation
// behind it), so the renderer hides its recording controls.
let promptShowing = false;
let promptPending = false;
let promptSolo = false;
// The version the banner has already had its say about this run: dismissing it
// (or starting another dictation) must not make it pop back on the next poll.
let promptedVersion = null;
let remindWasOn = true;

const feedBase = () => process.env.EARHEART_UPDATE_FEED || feed.DEFAULT_FEED_BASE;
const feedOverridden = () => Boolean(process.env.EARHEART_UPDATE_FEED);

function setState(patch) {
  state = { ...state, ...patch };
  try {
    windows.broadcast("updates:state", state);
  } catch {
    /* windows may be gone during quit */
  }
  if (onStateChange) onStateChange(state);
  // Keep a showing banner in step with the state machine: it narrates the
  // download, the "restart to finish" hold and any failure. Only "idle" (the
  // update went away — skipped, or no longer newer) takes it down; "checking"
  // deliberately doesn't, so a background poll can't blank the banner the user
  // is reading.
  if (promptShowing) {
    if (state.status === "idle") hidePrompt();
    else sendPrompt();
  }
}

function getState() {
  return { ...state };
}

const HINTS = {
  "mac-translocated":
    "macOS is running Earheart from a temporary location. Move Earheart.app to " +
    "/Applications and run `xattr -cr /Applications/Earheart.app` once — " +
    "after that, in-app updates handle it automatically.",
  "win-portable":
    "This is the portable build — download the new version from the releases page.",
  "linux-pkg":
    "Earheart was installed as a package — download the new .deb from the releases page.",
};

function init(callbacks = {}) {
  onStateChange = callbacks.onStateChange || null;
  installKind = feed.detectInstallKind({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    env: process.env,
  });
  const canInstall = ["nsis", "mac-app", "appimage", "dev"].includes(installKind);
  setState({
    current: app.getVersion(),
    method: canInstall ? "install" : "open-releases",
    hint: HINTS[installKind] || null,
  });

  sweepLeftovers().catch((err) => logger.warn(`update sweep failed: ${err.message}`));

  remindWasOn = settings.get().updates.remind !== false;

  // A prompt deferred because the user was mid-dictation surfaces once the
  // pipeline returns to idle — on the result card they're already looking at.
  dictation.onStateChange(onDictationState);

  // In dev only run automatic checks when a test feed is set, so `npm start`
  // stays network-free by default.
  if (installKind === "dev" && !feedOverridden()) return;
  armTimers();
}

function armTimers() {
  disarmTimers();
  if (settings.get().updates.autoCheck === false) return;
  startupTimer = setTimeout(() => check().catch(() => {}), CHECK_DELAY_MS);
  intervalTimer = setInterval(() => check().catch(() => {}), CHECK_INTERVAL_MS);
}

function disarmTimers() {
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = intervalTimer = null;
}

function onSettingsChanged() {
  // Turning reminders back on re-arms the prompt for the version the user
  // silenced, so the next check can surface it again.
  const remindOn = settings.get().updates.remind !== false;
  if (remindOn && !remindWasOn) promptedVersion = null;
  remindWasOn = remindOn;
  if (installKind === "dev" && !feedOverridden()) return;
  armTimers();
}

function dispose() {
  disarmTimers();
  if (downloadController) downloadController.abort();
}

/** Fetch a URL as text; supports file:// so tests can use a local dist dir. */
async function fetchText(url) {
  if (url.startsWith("file://")) {
    return fsp.readFile(fileURLToPath(url), "utf8");
  }
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "text/plain, */*" } });
  } catch (err) {
    throw new Error(`Could not reach the update server: ${err.message}`);
  }
  if (res.status === 404) throw new Error("No release feed found");
  if (!res.ok) throw new Error(`Update server returned HTTP ${res.status}`);
  return res.text();
}

async function check({ manual = false } = {}) {
  // "ready" is also off-limits: a background poll must not clobber an update
  // that's downloaded and waiting for the user to restart.
  if (["checking", "downloading", "ready", "installing"].includes(state.status)) return;
  setState({ status: "checking", error: null });
  try {
    const url = `${feedBase().replace(/\/$/, "")}/${feed.feedFileFor(process.platform)}`;
    const info = feed.parseLatestYml(await fetchText(url));
    if (feed.compareVersions(info.version, state.current) <= 0) {
      pendingInfo = null;
      setState({ status: "idle", latest: null, progress: null });
      return;
    }
    const skipped = settings.get().updates.skippedVersion;
    if (!manual && skipped && feed.compareVersions(info.version, skipped) === 0) {
      logger.info(`update ${info.version} available but skipped by user`);
      pendingInfo = null;
      setState({ status: "idle", latest: null });
      return;
    }
    pendingInfo = info;
    setState({ status: "available", latest: info.version, error: null });
    // A manual check is answered where it was asked (Settings shows the update
    // inline) — no toast, and no card popping up over the window the user is
    // already looking at.
    if (manual) return;
    if (notifiedVersion !== info.version) {
      notifiedVersion = info.version;
      notifyAvailable(info.version);
    }
    maybePrompt();
  } catch (err) {
    logger.warn(`update check failed: ${err.message}`);
    pendingInfo = null;
    // Don't alarm the user over a failed background poll; surface errors only
    // for a check they asked for.
    if (manual) setState({ status: "error", error: err.message });
    else setState({ status: "idle" });
  }
}

function notifyAvailable(version) {
  if (settings.get().updates.remind === false) return;
  try {
    const note = new Notification({
      title: `Earheart ${version} is available`,
      body:
        state.method === "install"
          ? "Update from the prompt on screen, the tray menu, or Settings → Advanced."
          : "Download it from the releases page (see Settings → Advanced).",
    });
    note.on("click", () => windows.openSettings());
    note.show();
  } catch (err) {
    logger.warn(`update notification failed: ${err.message}`);
  }
}

// --- the overlay prompt ---------------------------------------------------

function sendPrompt() {
  windows.sendToOverlay("updates:prompt", {
    version: state.latest || "",
    current: state.current,
    status: state.status,
    method: state.method,
    progress: state.progress,
    error: state.error,
    solo: promptSolo,
  });
}

/** Put the banner up now, or queue it if the user is mid-dictation. */
function maybePrompt() {
  if (state.status !== "available" || !state.latest) return;
  if (settings.get().updates.remind === false) return;
  if (promptedVersion === state.latest) return;
  promptedVersion = state.latest;
  if (dictation.getState() !== "idle") {
    // Mid-dictation: the card belongs to the words being spoken. Wait for the
    // text to land and attach the prompt to the result they're already reading.
    promptPending = true;
    return;
  }
  showPrompt();
}

function showPrompt() {
  promptPending = false;
  promptShowing = true;
  // Solo when nothing else is on the card: the overlay comes up for the prompt
  // alone (this is what the user sees shortly after launch). Otherwise it
  // attaches under a dictation that has just finished.
  promptSolo = !windows.isOverlayVisible();
  // Pin first: the pipeline's post-dictation auto-hide is already ticking, and
  // it must not fade the card out from under the banner.
  windows.setOverlayPinned(true);
  if (promptSolo) windows.showOverlay();
  sendPrompt();
}

function hidePrompt() {
  promptPending = false;
  if (!promptShowing) return;
  promptShowing = false;
  promptSolo = false;
  windows.sendToOverlay("updates:prompt", null);
  windows.setOverlayPinned(false);
  // The card only existed for the prompt (or its dictation is long finished and
  // its auto-hide fired while we held it open), so take it down. A dictation
  // that's starting or running keeps it — that's whose card it is now.
  if (dictation.getState() === "idle") windows.hideOverlay();
}

function onDictationState(next) {
  // A new dictation takes the card back. The banner has had its say; the tray
  // and Settings still carry the update.
  if (next !== "idle") hidePrompt();
  else if (promptPending) showPrompt();
}

/** "Later": gone for this run, asked again on the next launch. */
function dismissPrompt() {
  hidePrompt();
}

/**
 * "Don't remind me": no more banners, no more toasts. Checks keep running, so
 * the tray and Settings still offer the update — this silences the
 * interruption, it doesn't hide the update.
 */
function stopReminding() {
  const cfg = settings.get();
  cfg.updates.remind = false;
  settings.save(cfg);
  remindWasOn = false;
  hidePrompt();
}

/**
 * The one-click path: download (unless already downloaded), verify, install.
 * For installs we can't perform (portable/deb/translocated) this opens the
 * releases page instead.
 */
async function startUpdate() {
  if (state.method === "open-releases") {
    shell.openExternal(feed.RELEASES_PAGE);
    hidePrompt(); // the browser has it from here
    return;
  }
  if (state.status === "ready") return installNow();
  if (state.status !== "available" && state.status !== "error") return;
  if (!pendingInfo) {
    await check({ manual: true });
    if (!pendingInfo) return;
  }
  const info = pendingInfo;

  setState({ status: "downloading", progress: { received: 0, total: info.size, fraction: 0 } });
  downloadController = new AbortController();
  let file;
  try {
    file = await downloadAsset(info, downloadController.signal);
  } catch (err) {
    const aborted = downloadController.signal.aborted;
    downloadController = null;
    setState(
      aborted
        ? { status: "available", progress: null }
        : { status: "error", error: err.message, progress: null }
    );
    if (!aborted) logger.error(`update download failed: ${err.message}`);
    return;
  }
  downloadController = null;
  downloadedPath = file;
  setState({ status: "ready", progress: null });

  // Don't yank the app out from under a dictation in progress: hold at
  // "Restart to update" and let the user (or the tray item) finish the job.
  if (dictation.getState() !== "idle") {
    logger.info("update downloaded; waiting for dictation to finish");
    return;
  }
  installNow();
}

function cancel() {
  if (downloadController) downloadController.abort();
}

function skipVersion() {
  if (!state.latest) return;
  const cfg = settings.get();
  cfg.updates.skippedVersion = state.latest;
  settings.save(cfg);
  pendingInfo = null;
  setState({ status: "idle", latest: null });
}

/**
 * Stream the release asset to the temp dir, verifying its sha512 in the same
 * pass. A verified file from an earlier attempt is reused as-is.
 */
async function downloadAsset(info, signal) {
  const dir = path.join(app.getPath("temp"), "earheart-update");
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(info.path));

  if (await isVerified(dest, info.sha512)) return dest;

  const part = `${dest}.part`;
  const url = feed.assetUrl(feedBase(), info.version, info.path, {
    overridden: feedOverridden(),
  });

  let body;
  if (url.startsWith("file://")) {
    body = fs.createReadStream(fileURLToPath(url));
  } else {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    body = Readable.fromWeb(res.body);
  }

  const hash = crypto.createHash("sha512");
  let received = 0;
  let lastFraction = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      received += chunk.length;
      const total = info.size || 0;
      const fraction = total ? received / total : 0;
      // Chunk-rate updates would rebuild the tray menu constantly; 1% steps
      // are plenty for a progress bar.
      if (fraction - lastFraction >= 0.01 || received === total) {
        lastFraction = fraction;
        setState({ progress: { received, total, fraction } });
      }
      cb(null, chunk);
    },
  });

  try {
    await streamPipeline(body, meter, fs.createWriteStream(part), { signal });
    const got = hash.digest("base64");
    if (got !== info.sha512) throw new Error("Checksum mismatch — download corrupted");
    await fsp.rename(part, dest);
  } catch (err) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  }
  return dest;
}

async function isVerified(file, sha512) {
  try {
    const hash = crypto.createHash("sha512");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return hash.digest("base64") === sha512;
  } catch {
    return false;
  }
}

/** Hand off to the platform installer and quit. */
function installNow() {
  if (state.status !== "ready" || !downloadedPath) return;
  setState({ status: "installing" });
  try {
    if (installKind === "nsis") installWindows(downloadedPath);
    else if (installKind === "mac-app") installMac(downloadedPath);
    else if (installKind === "appimage") installLinux(downloadedPath);
    else {
      logger.info(`dry-run: would install ${downloadedPath} (${installKind})`);
      setState({ status: "ready" });
    }
  } catch (err) {
    logger.error(`update install failed: ${err.message}`);
    setState({ status: "error", error: err.message });
  }
}

// --- Windows -----------------------------------------------------------

// The same flags electron-updater passes to the NSIS installer: silent
// upgrade over the existing install, relaunch when done.
function installWindows(setupExe) {
  spawn(setupExe, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
  app.quit();
}

// --- macOS -------------------------------------------------------------

// Replace the running .app bundle. The swap itself happens in a detached
// shell script after this process exits; the script also strips the
// quarantine attribute so the updated (unsigned) app opens without the
// "Earheart is damaged" Gatekeeper dialog — that's the whole reason updates
// from inside the app work while a manual download needs `xattr -cr` once.
const MAC_SWAP_SCRIPT = `#!/bin/sh
# earheart update swap: $1=pid $2=old-bundle $3=new-bundle
PID="$1"; OLD="$2"; NEW="$3"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 60 ] && echo "timed out waiting for app exit" && exit 1
  sleep 0.5
done
rm -rf "$OLD.update-old"
mv "$OLD" "$OLD.update-old" || exit 1
if mv "$NEW" "$OLD"; then
  rm -rf "$OLD.update-old"
else
  mv "$OLD.update-old" "$OLD"
  echo "swap failed, rolled back" && exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$OLD" 2>/dev/null || true
open "$OLD"
`;

// Apple Silicon refuses to exec an arm64 binary that has no valid code
// signature — the kernel kills it before our JS ever runs, so a bundle that
// arrives unsigned (or with a signature the extract/move invalidated) launches
// to nothing: "the update installed but the app won't open." A fresh install
// dodges this only because the shipped bundle happens to be signed; the
// self-update must not assume that. Verify the extracted bundle and, only when
// the seal is missing or broken, repair it with an ad-hoc signature (`-`). A
// bundle that already verifies — including a real Developer ID signature, if we
// ever ship one — is left untouched so we never downgrade a good signature to
// ad-hoc. Throwing here aborts the update before the swap, leaving the working
// old app in place, rather than swapping in a bundle that can't start.
function ensureMacSignature(bundle) {
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  if (verify.status === 0) return;
  logger.warn("updated app has no valid signature; re-signing ad-hoc so it can launch");
  const sign = spawnSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
  if (sign.status !== 0) {
    throw new Error(
      `Could not sign the updated app: ${(sign.stderr || sign.status || "").toString().trim()}`
    );
  }
}

function installMac(zipPath) {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) {
    throw new Error(`Not running from an app bundle (${bundle})`);
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    throw new Error(
      `Can't write to ${path.dirname(bundle)} — download the update manually from the releases page`
    );
  }

  const staging = path.join(path.dirname(zipPath), "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const ditto = spawnSync("/usr/bin/ditto", ["-xk", zipPath, staging]);
  if (ditto.status !== 0) {
    throw new Error(`Could not extract the update: ${ditto.stderr || ditto.status}`);
  }
  const newBundle = path.join(staging, path.basename(bundle));
  if (!fs.existsSync(path.join(newBundle, "Contents", "MacOS"))) {
    throw new Error("Update archive did not contain the app bundle");
  }
  const plist = fs.readFileSync(path.join(newBundle, "Contents", "Info.plist"), "utf8");
  const version = plist.match(
    /CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
  );
  if (!version || version[1] !== state.latest) {
    throw new Error(
      `Downloaded app reports version ${version ? version[1] : "unknown"}, expected ${state.latest}`
    );
  }

  // Make sure the bundle will actually launch on Apple Silicon (a valid
  // signature is mandatory there) before we commit to swapping it in.
  ensureMacSignature(newBundle);

  // Our own download carries no quarantine flag (Electron doesn't opt into
  // LSFileQuarantineEnabled), but stripping it here costs nothing.
  spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newBundle]);

  const script = path.join(path.dirname(zipPath), "swap.sh");
  fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
  const log = fs.openSync(path.join(app.getPath("userData"), "update.log"), "a");
  spawn("/bin/sh", [script, String(process.pid), bundle, newBundle], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
  fs.closeSync(log);
  app.quit();
}

// --- Linux (AppImage) ----------------------------------------------------

// Keep the user's chosen path/filename (launcher shortcuts and the XDG
// autostart entry point at it) and rename over the running file — the
// process keeps its open inode, so this is safe on Linux. Relaunching must
// wait for this process to exit or it would just hit the single-instance
// lock, so a tiny detached script does the waiting.
const LINUX_RELAUNCH_SCRIPT = `#!/bin/sh
# earheart update relaunch: $1=pid $2=appimage
PID="$1"; APP="$2"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 60 ] && exit 1
  sleep 0.5
done
exec "$APP"
`;

function installLinux(newAppImage) {
  const target = process.env.APPIMAGE;
  if (!target) throw new Error("APPIMAGE is not set");
  const part = `${target}.update.part`;
  try {
    fs.copyFileSync(newAppImage, part);
    fs.chmodSync(part, 0o755);
    fs.renameSync(part, target);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw new Error(
      `Can't replace ${target} (${err.message}) — download the update manually from the releases page`
    );
  }

  const script = path.join(path.dirname(newAppImage), "relaunch.sh");
  fs.writeFileSync(script, LINUX_RELAUNCH_SCRIPT, { mode: 0o755 });
  const log = fs.openSync(path.join(app.getPath("userData"), "update.log"), "a");
  spawn("/bin/sh", [script, String(process.pid), target], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
  fs.closeSync(log);
  app.quit();
}

// --- housekeeping ---------------------------------------------------------

// Clear droppings from a previous update: the extraction staging dir and, on
// macOS, a leftover .update-old bundle if the swap script's own cleanup lost
// a race with shutdown.
async function sweepLeftovers() {
  const dir = path.join(app.getPath("temp"), "earheart-update");
  await fsp.rm(path.join(dir, "staging"), { recursive: true, force: true });
  if (installKind === "mac-app") {
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    await fsp.rm(`${bundle}.update-old`, { recursive: true, force: true });
  }
}

module.exports = {
  init,
  getState,
  check,
  startUpdate,
  installNow,
  cancel,
  skipVersion,
  dismissPrompt,
  stopReminding,
  onSettingsChanged,
  dispose,
};
