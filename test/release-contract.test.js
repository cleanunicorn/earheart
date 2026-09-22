const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { TITLE_RE } = require("../scripts/auto-release");

const ROOT = path.join(__dirname, "..");

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function readText(...parts) {
  return normalizeNewlines(fs.readFileSync(path.join(ROOT, ...parts), "utf8"));
}

const workflow = readText(".github", "workflows", "auto-release.yml");
const titleWorkflow = readText(".github", "workflows", "pr-title.yml");
const autoReleaseScript = readText("scripts", "auto-release.js");
const releaseNotesSource = readText("main", "services", "release-notes.js");
const makefile = readText("Makefile");
const contributing = readText("CONTRIBUTING.md");
const agents = readText("AGENTS.md");

function markdownUnder(directory) {
  let text = "";
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) text += markdownUnder(location);
    else if (entry.name.endsWith(".md")) {
      text += normalizeNewlines(fs.readFileSync(location, "utf8"));
    }
  }
  return text;
}

test("release sizing uses exactly the PR-title workflow regex", () => {
  const match = titleWorkflow.match(/^\s*title_re='([^']+)'$/m);
  assert.ok(match, "pr-title.yml should define title_re");
  assert.equal(TITLE_RE.source, match[1]);
  assert.doesNotMatch(workflow, /^\s*(major|minor|patch)_re=/m);
  assert.match(workflow, /node scripts\/auto-release\.js select/);
  assert.match(workflow, /node scripts\/auto-release\.js pending/);
});

test("release sizing comments name the helper that owns the policy", () => {
  assert.match(titleWorkflow, /scripts\/auto-release\.js reads its conventional-commit/);
  assert.match(titleWorkflow, /because scripts\/auto-release\.js\n\s+turns its prefix/);
  assert.doesNotMatch(titleWorkflow, /same reason as auto-release\.yml/);
  assert.match(releaseNotesSource, /scripts\/auto-release\.js sizes the/);
  assert.match(releaseNotesSource, /see scripts\/auto-release\.js/);
});

test("the release selector documents its command and stream contract", () => {
  assert.match(autoReleaseScript, /Usage: auto-release\.js select --prs <file> --changelog <file>/);
  assert.match(autoReleaseScript, /auto-release\.js pending --prs <file>/);
  assert.match(autoReleaseScript, /standard output.*JSON Lines/i);
  assert.match(autoReleaseScript, /standard error[^]*workflow warnings and errors/i);
});

test("exported release helpers document their contracts", () => {
  assert.match(autoReleaseScript, /\/\*\*[^]*PR-title contract[^]*\*\/\nconst TITLE_RE/);
  assert.match(autoReleaseScript, /\/\*\*[^]*reason[^]*\*\/\nfunction bumpFor/);
  assert.match(autoReleaseScript, /\/\*\*[^]*trailing[^]*\*\/\nfunction releasedPrNumbers/);
  assert.match(autoReleaseScript, /\/\*\*[^]*throws[^]*\*\/\nfunction pendingReleases/);
  assert.match(
    autoReleaseScript,
    /\/\*\*[^]*GitHub Actions workflow command[^]*\*\/\nfunction escapeWorkflowCommandData/,
  );
});

test("release selection parses changelog markers through one shared traversal", () => {
  assert.equal(autoReleaseScript.match(/releaseNotes\.parseChangelog/g)?.length, 1);
});

test("contract sources normalize Windows checkout newlines", () => {
  assert.equal(normalizeNewlines("first\r\nsecond\r\n"), "first\nsecond\n");
  assert.doesNotMatch(workflow, /\r/);
});

test("only merged pull-request jobs enter the static release concurrency group", () => {
  assert.match(workflow, /^on:\n  pull_request:\n    types: \[closed\]\n    branches: \[main\]/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(
    workflow,
    /jobs:\n  release:\n    if: github\.event\.pull_request\.merged == true\n    concurrency:\n      group: auto-release\n      cancel-in-progress: false/,
  );
});

test("catch-up reads every merged PR with the explicit token permission", () => {
  assert.match(workflow, /^  pull-requests: read$/m);
  assert.match(workflow, /^  issues: read$/m);
  assert.match(workflow, /gh api --paginate/);
  assert.match(workflow, /pulls\?state=closed&base=main/);
  assert.match(workflow, /sort=created&direction=desc/);
  assert.doesNotMatch(workflow, /sort=updated/);
  assert.match(workflow, /select\(\.merged_at != null\)/);
});

test("catch-up API reads retry transient failures and then fail visibly", () => {
  assert.equal(workflow.match(/if gh api --paginate/g)?.length, 2);
  assert.equal(
    workflow.match(
      /for \(\(api_attempt = 1; api_attempt <= max_attempts; api_attempt\+\+\)\); do/g,
    )?.length,
    2,
  );
  assert.match(workflow, /::warning title=Pull list retry::/);
  assert.match(workflow, /Could not load merged PRs after \$max_attempts attempts/);
  assert.match(workflow, /::warning title=PR event retry::/);
  assert.match(workflow, /Could not load events for PR #\$number after \$max_attempts attempts/);
});

test("catch-up freezes titles from the trigger payload or post-merge rename events", () => {
  assert.match(workflow, /TRIGGER_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/);
  assert.match(workflow, /issues\/\$number\/events\?per_page=100/);
  assert.match(workflow, /\. \+ \{titleAtMerge: \$titleAtMerge\}/);
  assert.match(workflow, /\. \+ \{events: \$events\[0\]\}/);
});

test("every release attempt refreshes main and pushes its exact tag atomically", () => {
  assert.match(workflow, /max_attempts=3/);
  assert.match(workflow, /for \(\(attempt = 1; attempt <= max_attempts; attempt\+\+\)\); do/);
  assert.match(
    workflow,
    /if ! git fetch origin main; then\n\s+echo "::warning title=Release fetch retry::PR #\$number fetch attempt \$attempt failed"\n\s+continue\n\s+fi/,
  );
  const fetchAt = workflow.indexOf("git fetch origin main");
  const resetAt = workflow.indexOf("git reset --hard origin/main");
  const bumpAt = workflow.indexOf('npm version "$bump" --no-git-tag-version');
  assert.ok(fetchAt >= 0 && fetchAt < resetAt && resetAt < bumpAt);
  assert.match(workflow, /tag="v\$version"/);
  assert.match(
    workflow,
    /git push --atomic origin HEAD:main "refs\/tags\/\$tag:refs\/tags\/\$tag"/,
  );
  assert.doesNotMatch(workflow, new RegExp("git push origin " + "main"));
  assert.match(workflow, /git tag -d "\$tag"/);
});

test("release retries recognize only exact trailing PR markers", () => {
  assert.match(
    workflow,
    /grep -qE "\\\\\(#\$number\\\\\)\[\[:space:\]\]\*\$" CHANGELOG\.md/,
  );
  assert.doesNotMatch(workflow, /grep -qF "\(#\$number\)" CHANGELOG\.md/);
});

test("each pushed tag gets a bounded release-build dispatch", () => {
  assert.match(
    workflow,
    /for \(\(dispatch_attempt = 1; dispatch_attempt <= max_attempts; dispatch_attempt\+\+\)\); do/,
  );
  assert.match(workflow, /gh workflow run release\.yml --ref "\$tag"/);
  assert.match(workflow, /after \$max_attempts attempts/);
  assert.match(workflow, /Release build dispatch failed for \$tag/);
  assert.doesNotMatch(workflow, /in 1 2 3/);
});

test("the unsafe manual release target and its documentation are gone", () => {
  assert.doesNotMatch(makefile, new RegExp("^\\.PHONY: " + "release$", "m"));
  assert.doesNotMatch(makefile, new RegExp("^release" + ":", "m"));

  const releaseDocs = [
    readText("README.md"),
    contributing,
    agents,
    markdownUnder(path.join(ROOT, "docs")),
  ].join("\n");
  assert.doesNotMatch(releaseDocs, new RegExp("make " + "release"));
});

test("contributor and agent guides explain serialized catch-up releases", () => {
  for (const [name, guide] of [
    ["CONTRIBUTING.md", contributing],
    ["AGENTS.md", agents],
  ]) {
    assert.match(guide, /serializ/i, `${name} should explain serialization`);
    assert.match(guide, /catch(?:es)? up/i, `${name} should explain catch-up`);
    assert.match(guide, /invalid\s+title/i, `${name} should explain invalid titles`);
    assert.match(guide, /title at merge time/i, `${name} should explain title provenance`);
    assert.match(
      guide,
      /editing it after merge\s+does not change the\s+release/i,
      `${name} should explain post-merge edits`,
    );
  }
});
