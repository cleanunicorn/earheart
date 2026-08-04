// "What's new" logic: the text half of the updater. Pure (no Electron deps),
// so it's unit-testable — and shared by the app and the release scripts, which
// is what keeps the file CI writes and the file the app reads in the same
// shape.
//
// The pipeline, end to end:
//
//   PR title  ──auto-release.yml──>  CHANGELOG.md  ──release.yml──>  release-notes.json
//   "feat: paginate the history"     "## v0.24.0"                    release asset,
//                                    "- Paginate the history (#84)"  next to latest*.yml
//
// The app reads it from both ends: the JSON asset from the feed to say what's
// coming in the version it just found, and the CHANGELOG.md shipped inside its
// own bundle to say what changed in the version it's now running (no network
// needed for that one — the build carries its own notes).
//
// Titles are conventional-commit prefixed because auto-release.yml sizes the
// version bump from that prefix; the prefix is machinery, not news, so it's
// stripped for display and only its meaning (feature / fix) survives.

const { compareVersions } = require("./update-feed");

const REPO_SLUG = "cleanunicorn/earheart";
const CHANGELOG_HEADER = `# Changelog

Written by the release workflow from the title of the pull request that cut
each version (see .github/workflows/auto-release.yml). Earheart reads it twice:
release.yml turns it into the \`release-notes.json\` asset the in-app updater
shows before you update, and the app ships this file so it can show what
changed right after it updates.
`;

// How many versions the published feed carries. Enough that someone who skipped
// a few releases still sees everything they missed, small enough that the asset
// stays a couple of KB.
const FEED_VERSIONS = 12;

// Types that describe a user-visible change, and the word for it. Anything else
// (chore, docs, ci, test, style, build) never cuts a release in the first
// place — see auto-release.yml — so it never reaches a changelog entry.
const KINDS = {
  feat: "feature",
  fix: "fix",
  perf: "fix",
  refactor: "change",
};

/**
 * Turn a conventional-commit PR title into a sentence a user can read:
 * strips the `type(scope)!:` prefix, the trailing period and any
 * `[skip release]` marker, and capitalises the first letter.
 * Returns "" for a title with nothing left in it.
 */
function titleToItem(title) {
  let text = String(title || "")
    .replace(/\[skip release\]/gi, "")
    .trim()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim();
  if (!text) return "";
  return text[0].toUpperCase() + text.slice(1);
}

/** The kind word for a conventional-commit title ("feature" / "fix" / "change"). */
function titleToKind(title) {
  const m = String(title || "").match(/^([a-z]+)(\([^)]*\))?!?:/i);
  return (m && KINDS[m[1].toLowerCase()]) || "change";
}

/**
 * Build the changelog entry for a release cut from one merged pull request.
 * `date` is passed in (never read from the clock) so callers stay testable.
 * Returns null when the title carries no readable text.
 */
function entryFromPullRequest({ version, title, number, date }) {
  const text = titleToItem(title);
  if (!version || !text) return null;
  const suffix = number ? ` (#${number})` : "";
  return {
    version: String(version).replace(/^v/i, ""),
    date: String(date || "").slice(0, 10),
    items: [{ text: `${text}${suffix}`, kind: titleToKind(title) }],
  };
}

/** One `## v0.24.0 — 2026-07-30` block, items as `- text` bullets. */
function renderEntry(entry) {
  const head = entry.date ? `## v${entry.version} — ${entry.date}` : `## v${entry.version}`;
  const bullets = entry.items.map((i) => `- ${i.text}`).join("\n");
  return `${head}\n\n${bullets}\n`;
}

/** The whole file: header, then entries newest first. */
function renderChangelog(entries) {
  return [CHANGELOG_HEADER, ...entries.map(renderEntry)].join("\n");
}

/**
 * Parse a changelog back into entries. Kinds aren't stored in the markdown —
 * the bullet text is what a human reads — so they're re-derived only where the
 * writer put them, i.e. nowhere: parsed items come back as plain "change"
 * unless the caller knows better. Unknown lines are ignored, so hand-edits and
 * extra prose between releases can't break a release build.
 */
function parseChangelog(text) {
  const entries = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    // The separator before the date must be followed by a space, so the dash in
    // a prerelease version ("0.13.0-beta.1") can't be read as one.
    const head = line.match(/^##\s+v?(\d\S*)(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (head) {
      current = { version: head[1], date: head[2] || "", items: [] };
      entries.push(current);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+?)\s*$/);
    if (bullet && current) current.items.push({ text: bullet[1], kind: "change" });
  }
  return entries.filter((e) => e.items.length);
}

/**
 * Insert an entry into a changelog, newest first. Re-releasing the same version
 * replaces its entry rather than stacking a second one, so a re-run of the
 * release job is idempotent.
 */
function withEntry(text, entry) {
  const entries = parseChangelog(text).filter((e) => e.version !== entry.version);
  entries.push(entry);
  entries.sort((a, b) => compareVersions(b.version, a.version));
  return renderChangelog(entries);
}

/** The published asset: newest `limit` versions, as JSON. */
function toFeed(entries, { limit = FEED_VERSIONS } = {}) {
  return {
    schema: 1,
    repo: REPO_SLUG,
    versions: entries
      .slice()
      .sort((a, b) => compareVersions(b.version, a.version))
      .slice(0, limit)
      .map((e) => ({
        version: e.version,
        date: e.date || "",
        items: e.items.map((i) => i.text),
      })),
  };
}

/**
 * Read the published asset back. Deliberately forgiving — notes are a nicety,
 * so anything unrecognisable comes back as an empty list and the update flow
 * carries on without them. Never throws.
 */
function parseFeed(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return [];
  }
  const versions = data && Array.isArray(data.versions) ? data.versions : [];
  return versions
    .filter((v) => v && typeof v.version === "string")
    .map((v) => ({
      version: v.version.replace(/^v/i, ""),
      date: typeof v.date === "string" ? v.date : "",
      items: (Array.isArray(v.items) ? v.items : [])
        .map((i) => (typeof i === "string" ? i : i && typeof i.text === "string" ? i.text : ""))
        .map((t) => t.trim())
        .filter(Boolean),
    }))
    .filter((v) => v.items.length);
}

/**
 * Entries as the app shows them: items flattened to plain strings, the shape
 * parseFeed already returns. The changelog side carries a `kind` per item for
 * the writer's benefit; nothing on screen uses it, and one shape downstream
 * means the local (CHANGELOG.md) and remote (release-notes.json) paths can't
 * drift into rendering each other's objects.
 */
function displayEntries(entries) {
  return entries.map((e) => ({
    version: e.version,
    date: e.date || "",
    items: e.items.map((i) => (typeof i === "string" ? i : i.text)),
  }));
}

/**
 * The versions a user moving `from` → `to` has not seen: everything newer than
 * what they're running, up to and including what they'd get. Newest first.
 * With no `from` (a fresh install) there's nothing to catch up on.
 */
function notesBetween(entries, from, to) {
  if (!from) return [];
  return entries
    .filter((e) => compareVersions(e.version, from) > 0)
    .filter((e) => !to || compareVersions(e.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Flatten entries into one capped list for a surface with no room for
 * headings (the overlay card). `more` is how many bullets didn't fit, so the
 * card can say so instead of silently truncating.
 */
function summarize(entries, limit = 3) {
  const items = entries.flatMap((e) => e.items);
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

module.exports = {
  CHANGELOG_HEADER,
  FEED_VERSIONS,
  titleToItem,
  titleToKind,
  entryFromPullRequest,
  renderEntry,
  renderChangelog,
  parseChangelog,
  withEntry,
  toFeed,
  parseFeed,
  displayEntries,
  notesBetween,
  summarize,
};
