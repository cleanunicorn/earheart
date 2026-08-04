#!/usr/bin/env node
// Turns CHANGELOG.md into the release-notes.json asset the in-app updater
// reads. Run by .github/workflows/release.yml and uploaded to the GitHub
// release next to latest*.yml, so the app can fetch it from the same feed base
// (including an EARHEART_UPDATE_FEED test feed).
//
//   node scripts/release-notes.js --out release-notes.json
//
// Only the newest handful of versions ship (see FEED_VERSIONS) — enough for
// someone who skipped a few releases, small enough to stay a couple of KB.

const fs = require("node:fs");
const path = require("node:path");

const notes = require("../main/services/release-notes");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "CHANGELOG.md");

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out"));
const out = outArg ? outArg.split("=")[1] || process.argv[process.argv.indexOf(outArg) + 1] : null;
const dest = path.resolve(ROOT, out || "release-notes.json");

const md = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
const feed = notes.toFeed(notes.parseChangelog(md));
fs.writeFileSync(dest, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
console.log(`release-notes: ${feed.versions.length} versions → ${dest}`);
