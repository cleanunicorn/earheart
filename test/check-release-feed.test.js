// The release upload refuses a feed naming files it doesn't have (#174).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { feedFiles, missingFiles } = require("../scripts/check-release-feed");

// As electron-builder writes latest.yml for the NSIS installer.
const WIN_FEED = `version: 0.42.0
files:
  - url: Earheart-Setup-0.42.0.exe
    sha512: abc==
    size: 396024928
path: Earheart-Setup-0.42.0.exe
sha512: abc==
releaseDate: '2026-10-22T06:20:41.602Z'
`;

function dist(t, files, feed = WIN_FEED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-feed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  const feedPath = path.join(dir, "latest.yml");
  fs.writeFileSync(feedPath, feed);
  return feedPath;
}

test("feedFiles reads every url and the path, once each", () => {
  assert.deepStrictEqual(feedFiles(WIN_FEED), ["Earheart-Setup-0.42.0.exe"]);
  assert.deepStrictEqual(
    feedFiles("files:\n  - url: 'a b.AppImage'\n  - url: \"c.deb\"\npath: a b.AppImage\r\n"),
    ["a b.AppImage", "c.deb"]
  );
});

test("a feed whose installer is present passes", (t) => {
  assert.deepStrictEqual(missingFiles(dist(t, ["Earheart-Setup-0.42.0.exe"])).missing, []);
});

test("a feed naming a dashed file the build left with spaces fails", (t) => {
  const feed = dist(t, ["Earheart Setup 0.42.0.exe"]);
  assert.deepStrictEqual(missingFiles(feed).missing, ["Earheart-Setup-0.42.0.exe"]);
});

test("a feed naming no files fails rather than passing vacuously", (t) => {
  assert.strictEqual(missingFiles(dist(t, [], "version: 0.42.0\n")).missing.length, 1);
});
