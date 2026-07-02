// Update-feed logic for the in-app updater. Pure (no Electron deps), so it's
// unit-testable: parses electron-builder's latest*.yml metadata that CI
// already publishes with every GitHub release, compares versions, and decides
// how this particular install can be updated.
//
// The yml files are the same feed electron-updater would consume — version,
// asset filename and a base64 sha512 — but we read them ourselves because the
// stock macOS updater requires a signed app and Earheart ships unsigned.

const REPO_SLUG = "cleanunicorn/earheart";
const DEFAULT_FEED_BASE = `https://github.com/${REPO_SLUG}/releases/latest/download`;
const RELEASES_PAGE = `https://github.com/${REPO_SLUG}/releases/latest`;

/** Feed file published by electron-builder for a given process.platform. */
function feedFileFor(platform) {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "linux") return "latest-linux.yml";
  return "latest.yml";
}

/**
 * Parse the flat latest*.yml schema into { version, path, sha512, size }.
 * The top-level `path`/`sha512` always point at the asset we install (NSIS
 * setup, mac zip, AppImage); `size` comes from the matching `files` entry so
 * download progress has a denominator. Throws when required keys are missing
 * so a mangled feed fails loudly instead of installing garbage.
 */
function parseLatestYml(text) {
  const lines = String(text).split(/\r?\n/);
  const top = {};
  const files = [];
  let current = null;
  for (const line of lines) {
    const item = line.match(/^\s+-\s+url:\s*(.+?)\s*$/);
    if (item) {
      current = { url: unquote(item[1]) };
      files.push(current);
      continue;
    }
    const nested = line.match(/^\s+(\w+):\s*(.+?)\s*$/);
    if (nested && current && line.startsWith("    ")) {
      current[nested[1]] = unquote(nested[2]);
      continue;
    }
    const flat = line.match(/^(\w+):\s*(.+?)\s*$/);
    if (flat) {
      top[flat[1]] = unquote(flat[2]);
      current = null;
    }
  }
  const { version, path, sha512 } = top;
  if (!version || !path || !sha512) {
    throw new Error("Update feed is missing version, path or sha512");
  }
  const entry = files.find((f) => f.url === path);
  const size = entry && entry.size ? Number(entry.size) : 0;
  return { version, path, sha512, size };
}

function unquote(value) {
  const m = value.match(/^'(.*)'$/) || value.match(/^"(.*)"$/);
  return m ? m[1] : value;
}

/**
 * Compare two versions: -1, 0 or 1. Strips a leading "v", compares numeric
 * dot-segments (missing segments count as 0), and sorts any prerelease
 * suffix ("0.13.0-beta.1") below the bare release.
 */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, ...pre] = String(v).trim().replace(/^v/i, "").split("-");
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre.join("-") };
  };
  const va = split(a);
  const vb = split(b);
  for (let i = 0; i < Math.max(va.nums.length, vb.nums.length); i++) {
    const na = va.nums[i] || 0;
    const nb = vb.nums[i] || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  if (va.pre !== vb.pre) {
    if (!va.pre) return 1; // release > prerelease
    if (!vb.pre) return -1;
    return va.pre < vb.pre ? -1 : 1;
  }
  return 0;
}

/**
 * Absolute URL for a release asset. Normally tag-pinned so a release
 * published between check and download 404s cleanly instead of silently
 * mixing versions. With `overridden` (EARHEART_UPDATE_FEED test feeds) the
 * asset is served next to the yml, so resolve relative to the feed base.
 */
function assetUrl(feedBase, version, filePath, { overridden = false } = {}) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  if (overridden) return `${feedBase.replace(/\/$/, "")}/${encoded}`;
  return `https://github.com/${REPO_SLUG}/releases/download/v${version}/${encoded}`;
}

/**
 * How this install can be updated. Fed facts instead of reading process
 * globals so every branch is unit-testable:
 *   "nsis"             installed Windows build — silent setup upgrade
 *   "win-portable"     portable exe — no install dir, open releases page
 *   "mac-app"          normal .app bundle — download/swap/xattr
 *   "mac-translocated" Gatekeeper-translocated — user must move to
 *                      /Applications and de-quarantine once
 *   "appimage"         replace the AppImage file in place
 *   "linux-pkg"        deb install — upgrading needs sudo, open releases page
 *   "dev"              unpackaged — dry-run only
 */
function detectInstallKind({ platform, isPackaged, execPath, env }) {
  if (!isPackaged) return "dev";
  if (platform === "win32") {
    return env.PORTABLE_EXECUTABLE_FILE ? "win-portable" : "nsis";
  }
  if (platform === "darwin") {
    if (String(execPath).includes("/AppTranslocation/")) return "mac-translocated";
    return "mac-app";
  }
  return env.APPIMAGE ? "appimage" : "linux-pkg";
}

module.exports = {
  REPO_SLUG,
  DEFAULT_FEED_BASE,
  RELEASES_PAGE,
  feedFileFor,
  parseLatestYml,
  compareVersions,
  assetUrl,
  detectInstallKind,
};
