// Tests for the update-feed logic behind the in-app updater. Pure module,
// exercised against verbatim copies of the latest*.yml files electron-builder
// publishes with each GitHub release.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_FEED_BASE,
  feedFileFor,
  parseLatestYml,
  compareVersions,
  assetUrl,
  detectInstallKind,
} = require("../main/services/update-feed");

const MAC_YML = `version: 0.12.1
files:
  - url: Earheart-0.12.1-arm64-mac.zip
    sha512: KJ9kKheSxLn+kO3v1p2q4r5s6t7u8v9w0x1y2z3A4B5C6D7E8F9G0H1I2J3K4L5M6N7O8P9Q0R==
    size: 171973146
path: Earheart-0.12.1-arm64-mac.zip
sha512: KJ9kKheSxLn+kO3v1p2q4r5s6t7u8v9w0x1y2z3A4B5C6D7E8F9G0H1I2J3K4L5M6N7O8P9Q0R==
releaseDate: '2026-07-01T10:08:06.116Z'
`;

const WIN_YML = `version: 0.12.1
files:
  - url: Earheart-Setup-0.12.1.exe
    sha512: winsetuphash==
    size: 98765432
path: Earheart-Setup-0.12.1.exe
sha512: winsetuphash==
releaseDate: '2026-07-01T10:08:06.116Z'
`;

const LINUX_YML = `version: 0.12.1
files:
  - url: Earheart-0.12.1.AppImage
    sha512: appimagehash==
    size: 123456789
  - url: earheart_0.12.1_amd64.deb
    sha512: debhash==
    size: 87654321
path: Earheart-0.12.1.AppImage
sha512: appimagehash==
releaseDate: '2026-07-01T10:08:06.116Z'
`;

test("feedFileFor picks the platform feed", () => {
  assert.strictEqual(feedFileFor("darwin"), "latest-mac.yml");
  assert.strictEqual(feedFileFor("linux"), "latest-linux.yml");
  assert.strictEqual(feedFileFor("win32"), "latest.yml");
});

test("parseLatestYml reads the mac feed", () => {
  const info = parseLatestYml(MAC_YML);
  assert.strictEqual(info.version, "0.12.1");
  assert.strictEqual(info.path, "Earheart-0.12.1-arm64-mac.zip");
  assert.ok(info.sha512.startsWith("KJ9kKheSxLn"));
  assert.strictEqual(info.size, 171973146);
});

test("parseLatestYml picks the top-level path, not the second files entry", () => {
  const info = parseLatestYml(LINUX_YML);
  assert.strictEqual(info.path, "Earheart-0.12.1.AppImage");
  assert.strictEqual(info.sha512, "appimagehash==");
  assert.strictEqual(info.size, 123456789);
});

test("parseLatestYml reads the windows feed", () => {
  const info = parseLatestYml(WIN_YML);
  assert.strictEqual(info.path, "Earheart-Setup-0.12.1.exe");
  assert.strictEqual(info.size, 98765432);
});

test("parseLatestYml rejects a feed missing required keys", () => {
  assert.throws(() => parseLatestYml("version: 1.0.0\n"), /missing/);
  assert.throws(() => parseLatestYml(""), /missing/);
  assert.throws(
    () => parseLatestYml("path: a.zip\nsha512: x==\n"),
    /missing/
  );
});

test("compareVersions orders releases", () => {
  assert.strictEqual(compareVersions("0.12.1", "0.12.1"), 0);
  assert.strictEqual(compareVersions("0.12.1", "0.13.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", "0.99.9"), 1);
  assert.strictEqual(compareVersions("0.12.1", "0.12.10"), -1);
  assert.strictEqual(compareVersions("v0.12.1", "0.12.1"), 0);
  assert.strictEqual(compareVersions("0.12", "0.12.0"), 0);
  assert.strictEqual(compareVersions("0.13.0-beta.1", "0.13.0"), -1);
  assert.strictEqual(compareVersions("0.13.0", "0.13.0-beta.1"), 1);
});

test("assetUrl pins to the release tag by default", () => {
  assert.strictEqual(
    assetUrl(DEFAULT_FEED_BASE, "0.13.0", "Earheart-0.13.0-arm64-mac.zip"),
    "https://github.com/cleanunicorn/earheart/releases/download/v0.13.0/Earheart-0.13.0-arm64-mac.zip"
  );
});

test("assetUrl resolves against the feed base when overridden", () => {
  assert.strictEqual(
    assetUrl("http://127.0.0.1:8099/", "0.99.0", "Earheart-0.99.0.AppImage", {
      overridden: true,
    }),
    "http://127.0.0.1:8099/Earheart-0.99.0.AppImage"
  );
  assert.strictEqual(
    assetUrl("file:///tmp/dist", "0.99.0", "Earheart Setup 0.99.0.exe", {
      overridden: true,
    }),
    "file:///tmp/dist/Earheart%20Setup%200.99.0.exe"
  );
});

test("detectInstallKind covers every install shape", () => {
  const base = { isPackaged: true, execPath: "/opt/Earheart/earheart", env: {} };
  assert.strictEqual(detectInstallKind({ ...base, isPackaged: false, platform: "linux" }), "dev");
  assert.strictEqual(
    detectInstallKind({ ...base, platform: "win32", execPath: "C:\\Users\\u\\AppData\\Local\\Programs\\earheart\\Earheart.exe" }),
    "nsis"
  );
  assert.strictEqual(
    detectInstallKind({
      ...base,
      platform: "win32",
      env: { PORTABLE_EXECUTABLE_FILE: "C:\\Downloads\\Earheart 0.12.1.exe" },
    }),
    "win-portable"
  );
  assert.strictEqual(
    detectInstallKind({
      ...base,
      platform: "darwin",
      execPath: "/Applications/Earheart.app/Contents/MacOS/Earheart",
    }),
    "mac-app"
  );
  assert.strictEqual(
    detectInstallKind({
      ...base,
      platform: "darwin",
      execPath:
        "/private/var/folders/ab/xyz/T/AppTranslocation/1234-5678/d/Earheart.app/Contents/MacOS/Earheart",
    }),
    "mac-translocated"
  );
  assert.strictEqual(
    detectInstallKind({
      ...base,
      platform: "linux",
      env: { APPIMAGE: "/home/u/Apps/Earheart.AppImage" },
    }),
    "appimage"
  );
  assert.strictEqual(detectInstallKind({ ...base, platform: "linux" }), "linux-pkg");
});
