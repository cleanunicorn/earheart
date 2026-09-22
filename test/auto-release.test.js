const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const releaseNotes = require("../main/services/release-notes");

const {
  TITLE_RE,
  bumpFor,
  releasedPrNumbers,
  pendingReleases,
} = require("../scripts/auto-release");

const BOUNDARY_CHANGELOG = "## v1.0.0\n\n- Boundary (#100)\n";
const AUTO_RELEASE_SCRIPT = path.join(__dirname, "..", "scripts", "auto-release.js");

function runCli(...args) {
  return spawnSync(process.execPath, [AUTO_RELEASE_SCRIPT, ...args], { encoding: "utf8" });
}

function withMergeTitles(prs) {
  return prs.map((pr) => ({ titleAtMerge: pr.title, ...pr }));
}

function pendingNumbers(prs) {
  return pendingReleases({ prs: withMergeTitles(prs), changelog: BOUNDARY_CHANGELOG }).releases.map(
    (release) => release.number,
  );
}

test("release title regex matches the PR-title contract", () => {
  assert.equal(
    TITLE_RE.source,
    "^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?!?: .+",
  );
});

test("bumpFor validates before sizing a release", () => {
  const cases = [
    ["wip!: x", "", "invalid"],
    ["feat:x", "", "invalid"],
    ["feat(): x", "", "invalid"],
    ["fix:x", "", "invalid"],
    ["Fix: x", "", "invalid"],
    ["feat: ok", "minor", "release"],
    ["fix(scope)!: x", "major", "release"],
    ["feat(a:b)!: x", "major", "release"],
    ["fix(a:b): x", "patch", "release"],
    ["refactor: x", "patch", "release"],
    ["ci: x", "", "no-release"],
    ["feat: y [skip release]", "", "skip"],
    ["fix: y [SKIP RELEASE]", "", "skip"],
    ["feat: .", "", "empty"],
  ];

  for (const [title, bump, reason] of cases) {
    assert.deepStrictEqual(bumpFor(title), { bump, reason }, title);
  }
});

test("releasedPrNumbers reads only exact trailing PR markers", () => {
  const changelog = `# Changelog

## v1.2.0 — 2026-09-22

- Add the thing (#170)

## v1.1.0 — 2026-09-21

- Fix one (#17)
- Mention (#99) in the middle, not a release marker
`;

  assert.deepStrictEqual([...releasedPrNumbers(changelog)], [170, 17]);
});

test("releasedPrNumbers reads markers written by the changelog producer", () => {
  const entry = releaseNotes.entryFromPullRequest({
    version: "1.2.0",
    title: "fix: keep every release",
    number: 172,
    date: "2026-09-22",
  });
  const changelog = releaseNotes.withEntry(releaseNotes.CHANGELOG_HEADER, entry);

  assert.deepStrictEqual([...releasedPrNumbers(changelog)], [172]);
});

test("pendingReleases catches up a burst in merge order", () => {
  const changelog = `# Changelog

## v1.0.0 — 2026-09-20

- Existing release (#100)
`;
  const prs = [
    { number: 103, title: "fix: third", mergedAt: "2026-09-22T10:02:00Z" },
    { number: 100, title: "feat: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 102, title: "feat: second", mergedAt: "2026-09-22T10:01:00Z" },
    { number: 101, title: "fix: first", mergedAt: "2026-09-22T10:00:30Z" },
  ];

  assert.deepStrictEqual(pendingReleases({ prs: withMergeTitles(prs), changelog }), {
    boundary: { number: 100, mergedAt: "2026-09-22T10:00:00Z" },
    releases: [
      { number: 101, title: "fix: first", bump: "patch" },
      { number: 102, title: "feat: second", bump: "minor" },
      { number: 103, title: "fix: third", bump: "patch" },
    ],
    warnings: [],
  });
});

test("pendingReleases skips released and valid no-release PRs and warns on invalid titles", () => {
  const changelog = `# Changelog

## v1.1.0 — 2026-09-22

- Already released (#102)

## v1.0.0 — 2026-09-20

- Boundary (#100)
`;
  const prs = [
    { number: 100, title: "feat: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 101, title: "docs: explain it", mergedAt: "2026-09-22T10:01:00Z" },
    { number: 102, title: "fix: already done", mergedAt: "2026-09-22T10:02:00Z" },
    { number: 103, title: "wip!: invalid", mergedAt: "2026-09-22T10:03:00Z" },
    { number: 104, title: "fix: pending", mergedAt: "2026-09-22T10:04:00Z" },
    { number: 105, title: "feat: .", mergedAt: "2026-09-22T10:05:00Z" },
  ];

  const result = pendingReleases({ prs: withMergeTitles(prs), changelog });
  assert.deepStrictEqual(result.releases, [
    { number: 104, title: "fix: pending", bump: "patch" },
  ]);
  assert.deepStrictEqual(result.warnings, [
    "PR #103 has an invalid Conventional Commits title; no release was created",
    "PR #105 has no readable release note; no release was created",
  ]);
});

test("pendingReleases uses PR number to break equal mergedAt ties", () => {
  const prs = [
    { number: 102, title: "fix: later number", mergedAt: "2026-09-22T10:01:00Z" },
    { number: 100, title: "fix: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 101, title: "fix: earlier number", mergedAt: "2026-09-22T10:01:00Z" },
  ];

  assert.deepStrictEqual(pendingNumbers(prs), [101, 102]);
});

test("pendingReleases orders equivalent ISO timestamps chronologically", () => {
  const prs = [
    { number: 101, title: "fix: fractional", mergedAt: "2026-09-22T10:00:00.100Z" },
    { number: 100, title: "fix: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 102, title: "fix: tied", mergedAt: "2026-09-22T10:00:00Z" },
  ];

  assert.deepStrictEqual(pendingNumbers(prs), [102, 101]);
});

test("pendingReleases excludes candidates before the released boundary", () => {
  const prs = [
    { number: 99, title: "fix: historical gap", mergedAt: "2026-09-21T10:00:00Z" },
    { number: 100, title: "feat: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 101, title: "fix: current", mergedAt: "2026-09-22T11:00:00Z" },
  ];

  assert.deepStrictEqual(pendingNumbers(prs), [101]);
});

test("pendingReleases uses the latest merge in a multi-item newest entry", () => {
  const changelog = `## v1.2.0

- Listed first but merged earlier (#102)
- Listed second but merged later (#104)

## v1.0.0

- Old boundary (#100)
`;
  const prs = withMergeTitles([
    { number: 100, title: "fix: old boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 102, title: "fix: earlier release", mergedAt: "2026-09-22T10:02:00Z" },
    { number: 103, title: "fix: between markers", mergedAt: "2026-09-22T10:03:00Z" },
    { number: 104, title: "fix: latest release", mergedAt: "2026-09-22T10:04:00Z" },
    { number: 105, title: "fix: actually pending", mergedAt: "2026-09-22T10:05:00Z" },
  ]);

  assert.deepStrictEqual(
    pendingReleases({ prs, changelog }).releases.map((release) => release.number),
    [105],
  );
});

test("pendingReleases fails visibly when the changelog boundary cannot be resolved", () => {
  assert.throws(
    () =>
      pendingReleases({
        prs: [{ number: 101, title: "fix: current", mergedAt: "2026-09-22T11:00:00Z" }],
        changelog: BOUNDARY_CHANGELOG,
      }),
    /boundary PR #100 was not found/,
  );
  assert.throws(
    () => pendingReleases({ prs: [], changelog: "# Changelog\n" }),
    /no numbered release boundary/,
  );
  assert.throws(
    () =>
      pendingReleases({
        prs: withMergeTitles([
          { number: 102, title: "fix: one marker", mergedAt: "2026-09-22T10:02:00Z" },
        ]),
        changelog: "## v1.2.0\n\n- One (#102)\n- Missing (#104)\n",
      }),
    /boundary PR #104 was not found/,
  );
  assert.throws(
    () =>
      pendingReleases({
        prs: [
          { number: 100, title: "fix: old boundary", mergedAt: "2026-09-21T10:00:00Z" },
        ],
        changelog: "## v1.1.0\n\n- Manual entry\n\n## v1.0.0\n\n- Old boundary (#100)\n",
      }),
    /no numbered release boundary/,
  );
});

test("pendingReleases sizes retitled PRs from their titles at merge", () => {
  const prs = [
    {
      number: 100,
      title: "fix: boundary",
      titleAtMerge: "fix: boundary",
      mergedAt: "2026-09-22T10:00:00Z",
    },
    {
      number: 101,
      title: "feat!: unreviewed major",
      mergedAt: "2026-09-22T10:01:00Z",
      events: [
        {
          event: "renamed",
          created_at: "2026-09-22T10:02:00Z",
          rename: { from: "chore: reviewed title", to: "feat!: unreviewed major" },
        },
      ],
    },
    {
      number: 102,
      title: "chore: hide the release",
      titleAtMerge: "fix: reviewed fix",
      mergedAt: "2026-09-22T10:03:00Z",
    },
  ];

  assert.deepStrictEqual(pendingReleases({ prs, changelog: BOUNDARY_CHANGELOG }).releases, [
    { number: 102, title: "fix: reviewed fix", bump: "patch" },
  ]);
});

test("pendingReleases fails visibly without merge-title provenance", () => {
  const prs = [
    {
      number: 100,
      title: "fix: boundary",
      titleAtMerge: "fix: boundary",
      mergedAt: "2026-09-22T10:00:00Z",
    },
    { number: 101, title: "fix: current", mergedAt: "2026-09-22T10:01:00Z" },
  ];

  assert.throws(
    () => pendingReleases({ prs, changelog: BOUNDARY_CHANGELOG }),
    /PR #101 is missing merge-title provenance/,
  );
});

test("auto-release CLI keeps candidates and releases as JSONL and warnings on stderr", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-release-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prsFile = path.join(directory, "prs.json");
  const changelogFile = path.join(directory, "CHANGELOG.md");
  const candidatesFile = path.join(directory, "candidates.json");
  const prs = withMergeTitles([
    { number: 100, title: "fix: boundary", mergedAt: "2026-09-22T10:00:00Z" },
    { number: 101, title: "wip!: invalid", mergedAt: "2026-09-22T10:01:00Z" },
    { number: 102, title: "fix: pending", mergedAt: "2026-09-22T10:02:00Z" },
  ]);
  fs.writeFileSync(prsFile, JSON.stringify(prs));
  fs.writeFileSync(changelogFile, BOUNDARY_CHANGELOG);

  const selected = runCli("select", "--prs", prsFile, "--changelog", changelogFile);
  assert.equal(selected.status, 0);
  assert.equal(selected.stderr, "");
  const candidates = selected.stdout.trim().split("\n").map(JSON.parse);
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.number),
    [101, 102],
  );
  fs.writeFileSync(candidatesFile, JSON.stringify(candidates));

  const pending = runCli("pending", "--prs", candidatesFile);
  assert.equal(pending.status, 0);
  assert.deepStrictEqual(pending.stdout.trim().split("\n").map(JSON.parse), [
    { number: 102, title: "fix: pending", bump: "patch" },
  ]);
  assert.match(pending.stderr, /^::warning title=No release::PR #101 /);
});

test("auto-release CLI fails visibly for usage and input errors", () => {
  const usage = runCli("pending");
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /^usage: auto-release\.js select/);

  const missing = runCli("pending", "--prs", "/missing/release-prs.json");
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^::error title=Auto release::/);
});
