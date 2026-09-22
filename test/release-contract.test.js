const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { TITLE_RE } = require("../scripts/auto-release");

const ROOT = path.join(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "auto-release.yml"),
  "utf8",
);
const titleWorkflow = fs.readFileSync(
  path.join(ROOT, ".github", "workflows", "pr-title.yml"),
  "utf8",
);

test("release sizing uses exactly the PR-title workflow regex", () => {
  const match = titleWorkflow.match(/^\s*title_re='([^']+)'$/m);
  assert.ok(match, "pr-title.yml should define title_re");
  assert.equal(TITLE_RE.source, match[1]);
  assert.doesNotMatch(workflow, /^\s*(major|minor|patch)_re=/m);
  assert.match(workflow, /node scripts\/auto-release\.js pending/);
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
  assert.match(workflow, /gh api --paginate/);
  assert.match(workflow, /pulls\?state=closed&base=main/);
  assert.match(workflow, /select\(\.merged_at != null\)/);
});

test("every release attempt refreshes main and pushes its exact tag atomically", () => {
  assert.match(workflow, /for attempt in 1 2 3/);
  const fetchAt = workflow.indexOf("git fetch origin main");
  const resetAt = workflow.indexOf("git reset --hard origin/main");
  const bumpAt = workflow.indexOf('npm version "$bump" --no-git-tag-version');
  assert.ok(fetchAt >= 0 && fetchAt < resetAt && resetAt < bumpAt);
  assert.match(
    workflow,
    /git push --atomic origin HEAD:main "refs\/tags\/v\$version:refs\/tags\/v\$version"/,
  );
  assert.doesNotMatch(workflow, /git push origin main/);
  assert.match(workflow, /git tag -d "v\$version"/);
});

test("each pushed tag gets a bounded release-build dispatch", () => {
  assert.match(workflow, /for dispatch_attempt in 1 2 3/);
  assert.match(workflow, /gh workflow run release\.yml --ref "v\$version"/);
  assert.match(workflow, /Release build dispatch failed for v\$version/);
});
