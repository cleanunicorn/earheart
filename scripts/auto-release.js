#!/usr/bin/env node

const fs = require("node:fs");

const releaseNotes = require("../main/services/release-notes");

const TITLE_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

function bumpFor(title) {
  const value = String(title || "");
  if (value.includes("[skip release]")) return { bump: "", reason: "skip" };
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

function releasedPrNumbers(changelog) {
  const numbers = new Set();
  for (const entry of releaseNotes.parseChangelog(changelog)) {
    for (const item of entry.items) {
      const number = markerFromText(item.text);
      if (number !== null) numbers.add(number);
    }
  }
  return numbers;
}

function newestReleasePrNumber(changelog) {
  for (const entry of releaseNotes.parseChangelog(changelog)) {
    for (const item of entry.items) {
      const number = markerFromText(item.text);
      if (number !== null) return number;
    }
  }
  return null;
}

function compareMergeOrder(left, right) {
  const byTime = left.mergedAt.localeCompare(right.mergedAt);
  return byTime || left.number - right.number;
}

function pendingReleases({ prs, changelog }) {
  const boundaryNumber = newestReleasePrNumber(changelog);
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

  const released = releasedPrNumbers(changelog);
  const releases = [];
  const warnings = [];
  for (const pr of merged) {
    if (compareMergeOrder(pr, boundary) <= 0 || released.has(pr.number)) continue;
    const { bump, reason } = bumpFor(pr.title);
    if (reason === "invalid") {
      warnings.push(
        `PR #${pr.number} has an invalid Conventional Commits title; no release was created`,
      );
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
    args[match[1]] = match[2] === undefined ? argv[++index] || "" : match[2];
  }
  return args;
}

function workflowMessage(message) {
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
      console.error(`::warning title=No release::${workflowMessage(warning)}`);
    }
    for (const release of result.releases) console.log(JSON.stringify(release));
    return 0;
  } catch (error) {
    console.error(`::error title=Auto release::${workflowMessage(error.message)}`);
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
