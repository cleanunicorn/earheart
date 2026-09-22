const { test } = require("node:test");
const assert = require("node:assert");
const releaseNotes = require("../main/services/release-notes");

const {
  TITLE_RE,
  bumpFor,
  releasedPrNumbers,
  pendingReleases,
} = require("../scripts/auto-release");

const BOUNDARY_CHANGELOG = "## v1.0.0\n\n- Boundary (#100)\n";

function pendingNumbers(prs) {
  return pendingReleases({ prs, changelog: BOUNDARY_CHANGELOG }).releases.map(
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

  assert.deepStrictEqual(pendingReleases({ prs, changelog }), {
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

  const result = pendingReleases({ prs, changelog });
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
        prs: [
          { number: 100, title: "fix: old boundary", mergedAt: "2026-09-21T10:00:00Z" },
        ],
        changelog: "## v1.1.0\n\n- Manual entry\n\n## v1.0.0\n\n- Old boundary (#100)\n",
      }),
    /no numbered release boundary/,
  );
});
