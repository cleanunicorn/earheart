#!/usr/bin/env node

// Selects merged pull requests that still need releases.
// Usage: auto-release.js pending --prs <file> --changelog <file>
// Standard output is JSON Lines for the workflow loop; standard error carries
// workflow warnings and errors.

const fs = require("node:fs");

const releaseNotes = require("../main/services/release-notes");

/** The Conventional Commits PR-title contract shared with pr-title.yml. */
const TITLE_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

/**
 * Returns the semantic bump and a reason: release, skip, invalid, empty, or no-release.
 */
function bumpFor(title) {
  const value = String(title || "");
  if (/\[skip release\]/i.test(value)) return { bump: "", reason: "skip" };
  if (!TITLE_RE.test(value)) return { bump: "", reason: "invalid" };
  if (!releaseNotes.titleToItem(value)) return { bump: "", reason: "empty" };

  const [, type, , bang] = value.match(/^([a-z]+)(\([^)]+\))?(!)?: /);
  if (bang) return { bump: "major", reason: "release" };
  if (type === "feat") return { bump: "minor", reason: "release" };
  if (["fix", "perf", "refactor"].includes(type)) {
    return { bump: "patch", reason: "release" };
  }
  return { bump: "", reason: "no-release" };
}

function markerFromText(text) {
  const match = String(text || "").match(/\(#(\d+)\)$/);
  return match ? Number(match[1]) : null;
}

function releaseState(changelog) {
  const markersByEntry = releaseNotes.parseChangelog(changelog).map((entry) =>
    entry.items.map((item) => markerFromText(item.text)).filter((number) => number !== null),
  );
  return {
    boundaryNumber: markersByEntry[0]?.[0] ?? null,
    released: new Set(markersByEntry.flat()),
  };
}

/** Returns the PR numbers from exact trailing `(#N)` changelog markers. */
function releasedPrNumbers(changelog) {
  return releaseState(changelog).released;
}

function compareMergeOrder(left, right) {
  const byTime = Date.parse(left.mergedAt) - Date.parse(right.mergedAt);
  return byTime || left.number - right.number;
}

/**
 * Returns `{ boundary, releases, warnings }` for merged PRs after the latest release.
 * @throws When the latest boundary is unnumbered or absent from merged PR history.
 */
function pendingReleases({ prs, changelog }) {
  const { boundaryNumber, released } = releaseState(changelog);
  if (boundaryNumber === null) {
    throw new Error("no numbered release boundary was found in CHANGELOG.md");
  }

  const merged = prs
    .filter((pr) => pr && pr.mergedAt)
    .map((pr) => ({
      number: Number(pr.number),
      title: String(pr.title || ""),
      mergedAt: String(pr.mergedAt),
    }))
    .sort(compareMergeOrder);
  const boundary = merged.find((pr) => pr.number === boundaryNumber);
  if (!boundary) {
    throw new Error(`boundary PR #${boundaryNumber} was not found in merged PR history`);
  }

  const releases = [];
  const warnings = [];
  for (const pr of merged) {
    if (compareMergeOrder(pr, boundary) <= 0 || released.has(pr.number)) continue;
    const { bump, reason } = bumpFor(pr.title);
    if (reason === "invalid") {
      warnings.push(
        `PR #${pr.number} has an invalid Conventional Commits title; no release was created`,
      );
    } else if (reason === "empty") {
      warnings.push(`PR #${pr.number} has no readable release note; no release was created`);
    }
    if (bump) releases.push({ number: pr.number, title: pr.title, bump });
  }

  return {
    boundary: { number: boundary.number, mergedAt: boundary.mergedAt },
    releases,
    warnings,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const match = argv[index].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) continue;
    if (match[2] !== undefined) {
      args[match[1]] = match[2];
      continue;
    }
    index++;
    args[match[1]] = argv[index] || "";
  }
  return args;
}

function escapeWorkflowCommandData(message) {
  return String(message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command !== "pending" || !args.prs || !args.changelog) {
    console.error("usage: auto-release.js pending --prs <file> --changelog <file>");
    return 2;
  }

  try {
    const result = pendingReleases({
      prs: JSON.parse(fs.readFileSync(args.prs, "utf8")),
      changelog: fs.readFileSync(args.changelog, "utf8"),
    });
    for (const warning of result.warnings) {
      console.error(`::warning title=No release::${escapeWorkflowCommandData(warning)}`);
    }
    for (const release of result.releases) console.log(JSON.stringify(release));
    return 0;
  } catch (error) {
    console.error(`::error title=Auto release::${escapeWorkflowCommandData(error.message)}`);
    return 1;
  }
}

module.exports = {
  TITLE_RE,
  bumpFor,
  releasedPrNumbers,
  pendingReleases,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
