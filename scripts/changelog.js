#!/usr/bin/env node
// Writes one release's entry into CHANGELOG.md, from the pull request that cut
// it. Run by .github/workflows/auto-release.yml right after the version bump,
// before the release commit — a release is always exactly one merged PR there,
// so its title is the release note.
//
//   node scripts/changelog.js --version 0.25.0 --title "feat: …" --pr 88 \
//     --date 2026-08-04
//
// Re-running for a version already in the file replaces that entry instead of
// stacking a second one, so a re-run of the job is a no-op. Exits 0 without
// touching the file when the title has no readable text left (nothing to say),
// so a release never fails over its notes.

const fs = require("node:fs");
const path = require("node:path");

const notes = require("../main/services/release-notes");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "CHANGELOG.md");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]] = m[2] !== undefined ? m[2] : argv[++i] || "";
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.version) {
  console.error("changelog: --version is required");
  process.exit(2);
}

const entry = notes.entryFromPullRequest({
  version: args.version,
  title: args.title,
  number: args.pr,
  date: args.date,
});
if (!entry) {
  console.log(`changelog: nothing to record for v${args.version} (empty title)`);
  process.exit(0);
}

const existing = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : notes.CHANGELOG_HEADER;
fs.writeFileSync(FILE, notes.withEntry(existing, entry), "utf8");
console.log(`changelog: v${entry.version} — ${entry.items[0].text}`);
