// Fail a release upload whose update feed names a file that isn't there (#174).
//
// release.yml builds each platform with `--publish never`, verifies the
// packaged app, then uploads the installers and their feed (latest*.yml)
// itself. The in-app updater downloads exactly the `url`/`path` the feed
// names, so a feed pointing at a file under another name — a space where the
// published name has a dash — would ship a release no installed copy can
// update to. Run as: node scripts/check-release-feed.js dist/latest.yml

const fs = require("node:fs");
const path = require("node:path");

// Every file a feed points at: the `url:` entries under `files:` and the
// top-level `path:`. electron-builder writes these as plain scalars, one per
// line; quotes are allowed but optional.
function feedFiles(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:-\s*)?(?:url|path):\s*["']?([^"'#]+?)["']?\s*$/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

function missingFiles(feedPath) {
  const dir = path.dirname(feedPath);
  const names = feedFiles(fs.readFileSync(feedPath, "utf8"));
  if (names.length === 0) return { names, missing: ["(the feed names no files)"] };
  return { names, missing: names.filter((name) => !fs.existsSync(path.join(dir, name))) };
}

if (require.main === module) {
  const feed = process.argv[2];
  if (!feed) {
    console.error("usage: node scripts/check-release-feed.js <dist/latest*.yml>");
    process.exit(2);
  }
  const { names, missing } = missingFiles(feed);
  if (missing.length) {
    console.error(`${feed} names files that are not in ${path.dirname(feed)}: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`${feed}: ${names.join(", ")} present`);
}

module.exports = { feedFiles, missingFiles };
