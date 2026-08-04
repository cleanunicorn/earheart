// Tests for the "what's new" pipeline: PR title → CHANGELOG.md →
// release-notes.json → the list the app shows. Pure module, no Electron.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  titleToItem,
  titleToKind,
  entryFromPullRequest,
  renderChangelog,
  parseChangelog,
  withEntry,
  toFeed,
  parseFeed,
  displayEntries,
  notesBetween,
  summarize,
} = require("../main/services/release-notes");

test("titleToItem strips the conventional-commit machinery", () => {
  assert.equal(titleToItem("feat: paginate the settings history list"), "Paginate the settings history list");
  assert.equal(titleToItem("fix(overlay): revive the dead button."), "Revive the dead button");
  assert.equal(titleToItem("feat!: drop the legacy hotkey"), "Drop the legacy hotkey");
  assert.equal(titleToItem("perf(engines): reuse the warm model"), "Reuse the warm model");
  // A free-form title (no prefix) is left alone apart from the capital.
  assert.equal(titleToItem("make the tray menu quieter"), "Make the tray menu quieter");
  assert.equal(titleToItem("chore: bump deps [skip release]"), "Bump deps");
  assert.equal(titleToItem("   "), "");
});

test("titleToKind maps the prefix to a user-facing word", () => {
  assert.equal(titleToKind("feat: x"), "feature");
  assert.equal(titleToKind("fix(ui): x"), "fix");
  assert.equal(titleToKind("perf: x"), "fix");
  assert.equal(titleToKind("refactor: x"), "change");
  assert.equal(titleToKind("whatever"), "change");
});

test("entryFromPullRequest links the PR and keeps the date to a day", () => {
  const entry = entryFromPullRequest({
    version: "v0.25.0",
    title: "feat: show what's new before updating",
    number: 88,
    date: "2026-08-04T11:22:33Z",
  });
  assert.deepStrictEqual(entry, {
    version: "0.25.0",
    date: "2026-08-04",
    items: [{ text: "Show what's new before updating (#88)", kind: "feature" }],
  });
  assert.equal(entryFromPullRequest({ version: "0.1.0", title: "chore:" }), null);
});

test("a rendered changelog parses back to the same entries", () => {
  const entries = [
    { version: "0.25.0", date: "2026-08-04", items: [{ text: "Show what's new (#88)", kind: "feature" }] },
    { version: "0.24.1", date: "2026-07-30", items: [{ text: "Settle the settings residuals (#86)", kind: "fix" }] },
  ];
  const parsed = parseChangelog(renderChangelog(entries));
  assert.deepStrictEqual(
    parsed.map((e) => ({ version: e.version, date: e.date, items: e.items.map((i) => i.text) })),
    entries.map((e) => ({ version: e.version, date: e.date, items: e.items.map((i) => i.text) }))
  );
});

test("parseChangelog reads a prerelease heading without eating the suffix", () => {
  const [entry] = parseChangelog("## v0.13.0-beta.1 — 2026-01-02\n\n- Try the new engine\n");
  assert.equal(entry.version, "0.13.0-beta.1");
  assert.equal(entry.date, "2026-01-02");
});

test("parseChangelog ignores prose and empty releases", () => {
  const md = "# Changelog\n\nSome preamble.\n\n## v0.2.0\n\n## v0.1.0 — 2026-01-01\n\n- First cut\n";
  assert.deepStrictEqual(
    parseChangelog(md).map((e) => e.version),
    ["0.1.0"]
  );
});

test("withEntry inserts newest-first and re-releasing replaces", () => {
  let md = renderChangelog([
    { version: "0.24.0", date: "2026-07-20", items: [{ text: "Old news (#80)" }] },
  ]);
  md = withEntry(md, {
    version: "0.25.0",
    date: "2026-08-04",
    items: [{ text: "New news (#88)" }],
  });
  assert.deepStrictEqual(
    parseChangelog(md).map((e) => e.version),
    ["0.25.0", "0.24.0"]
  );

  const again = withEntry(md, {
    version: "0.25.0",
    date: "2026-08-05",
    items: [{ text: "Corrected news (#88)" }],
  });
  const entries = parseChangelog(again);
  assert.equal(entries.length, 2);
  assert.deepStrictEqual(entries[0], {
    version: "0.25.0",
    date: "2026-08-05",
    items: [{ text: "Corrected news (#88)", kind: "change" }],
  });
  assert.ok(again.startsWith("# Changelog"), "the header survives a rewrite");
});

test("toFeed publishes newest-first, capped, as plain strings", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    version: `0.${i + 1}.0`,
    date: "2026-01-01",
    items: [{ text: `Change ${i + 1}`, kind: "fix" }],
  }));
  const feed = toFeed(entries, { limit: 3 });
  assert.equal(feed.schema, 1);
  assert.deepStrictEqual(
    feed.versions.map((v) => v.version),
    ["0.20.0", "0.19.0", "0.18.0"]
  );
  assert.deepStrictEqual(feed.versions[0].items, ["Change 20"]);
});

test("parseFeed round-trips what toFeed writes", () => {
  const entries = [
    { version: "0.25.0", date: "2026-08-04", items: [{ text: "Show what's new" }] },
  ];
  const parsed = parseFeed(JSON.stringify(toFeed(entries)));
  assert.deepStrictEqual(parsed, [
    { version: "0.25.0", date: "2026-08-04", items: ["Show what's new"] },
  ]);
});

test("parseFeed never throws on garbage — notes are optional", () => {
  assert.deepStrictEqual(parseFeed("not json at all"), []);
  assert.deepStrictEqual(parseFeed("{}"), []);
  assert.deepStrictEqual(parseFeed('{"versions":"nope"}'), []);
  assert.deepStrictEqual(parseFeed('{"versions":[{"version":"0.1.0"}]}'), []);
  assert.deepStrictEqual(parseFeed('{"versions":[{"version":"v0.1.0","items":["  x  ",""]}]}'), [
    { version: "0.1.0", date: "", items: ["x"] },
  ]);
});

test("displayEntries flattens changelog items to the feed's shape", () => {
  // The card renders whatever comes out of here as text: a {text, kind} item
  // that slipped through would paint "[object Object]" on the overlay.
  const parsed = parseChangelog("## v0.25.0 — 2026-08-04\n\n- Show what's new\n");
  assert.deepStrictEqual(displayEntries(parsed), [
    { version: "0.25.0", date: "2026-08-04", items: ["Show what's new"] },
  ]);
  // Already-flat entries (the feed) pass through unchanged.
  const flat = [{ version: "0.1.0", date: "", items: ["Plain"] }];
  assert.deepStrictEqual(displayEntries(flat), flat);
});

test("summarize takes flattened entries from either source", () => {
  const local = displayEntries(
    parseChangelog("## v0.25.0\n\n- One\n- Two\n\n## v0.24.0\n\n- Three\n")
  );
  assert.deepStrictEqual(summarize(local, 2), { items: ["One", "Two"], more: 1 });
});

test("notesBetween covers every version skipped, newest first", () => {
  const entries = parseFeed(
    JSON.stringify({
      versions: [
        { version: "0.26.0", items: ["Not out yet"] },
        { version: "0.25.0", items: ["Newest"] },
        { version: "0.24.1", items: ["Middle"] },
        { version: "0.24.0", items: ["Older"] },
        { version: "0.23.0", items: ["Already running this"] },
      ],
    })
  );
  assert.deepStrictEqual(
    notesBetween(entries, "0.23.0", "0.25.0").map((e) => e.version),
    ["0.25.0", "0.24.1", "0.24.0"]
  );
  // No `to` cap: everything newer than what's installed.
  assert.equal(notesBetween(entries, "0.25.0").length, 1);
  // Nothing to catch up on: up to date, or a fresh install with no history.
  assert.deepStrictEqual(notesBetween(entries, "0.26.0"), []);
  assert.deepStrictEqual(notesBetween(entries, ""), []);
});

test("summarize caps the flattened list and counts the rest", () => {
  const entries = [
    { version: "0.25.0", date: "", items: ["a", "b"] },
    { version: "0.24.0", date: "", items: ["c", "d"] },
  ];
  assert.deepStrictEqual(summarize(entries, 3), { items: ["a", "b", "c"], more: 1 });
  assert.deepStrictEqual(summarize(entries, 9), { items: ["a", "b", "c", "d"], more: 0 });
  assert.deepStrictEqual(summarize([], 3), { items: [], more: 0 });
});
