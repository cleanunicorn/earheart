// Text snippets (#334): "when you say X, type this saved block". Records,
// validation, merging and the placeholder tags. Shared by main (settings load,
// IPC, the pipeline) and the Settings window and wizard, like aliases.js is
// (classic-script globals there, so everything sits in one IIFE).
//
// Stored as a top-level `snippets` setting (it must work with cleanup off):
//   [{ id: "snp_k3j2h1", triggers: ["my address"], content: "1 Main St\nTown" }]
//
// - `id` is stable: edits keep it, so concurrent windows merge per snippet.
// - A trigger is a short spoken phrase; two snippets can never share one
//   (compared the way aliases compare heard forms: NFC, case-folded, runs of
//   whitespace collapsed).
// - `content` is inserted byte for byte (line endings are stored as "\n"),
//   except for the four tags below.
//
// Tags, written {{name}}: clipboard, date, time, timezone. A tag with another
// name, or none, is not an error at expansion time: it stays as typed. Saving
// from Settings refuses one, so a typo is caught where it is made. Rendering is
// a single pass: what a tag inserts (the clipboard above all) is never scanned
// for tags again.

const SnippetsLib = (() => {
  const aliasKeyOf = typeof require === "function" ? require("./aliases").aliasKey : aliasKey;

  const SNIPPET_MAX = 100;
  const SNIPPET_TRIGGERS_MAX = 8;
  const SNIPPET_TRIGGER_MAX = 120;
  const SNIPPET_CONTENT_MAX = 8000;
  const CLIPBOARD_MAX = 20000;
  const SNIPPET_TAGS = ["clipboard", "date", "time", "timezone"];

  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  const TAG_PATTERN = /\{\{([^{}]*)\}\}/g;

  function newSnippetId() {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return `snp_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  const cleanTrigger = (text) => String(text).normalize("NFC").trim().replace(/\s+/gu, " ");

  // Why `text` can't be a trigger, or "" when it can.
  function triggerProblem(text) {
    if (typeof text !== "string" || !text.trim()) return "Enter a trigger phrase.";
    if (/[\x00-\x1f\x7f]/.test(text.trim())) return "Use a trigger phrase on one line.";
    const phrase = cleanTrigger(text);
    if (phrase.length > SNIPPET_TRIGGER_MAX) return `Use a trigger phrase of up to ${SNIPPET_TRIGGER_MAX} characters.`;
    if (!/[\p{L}\p{N}]/u.test(phrase)) return "Use a trigger phrase with at least one letter or digit.";
    return "";
  }

  // `{{...}}` spans whose name is not one of the tags, as typed.
  function unknownTags(content) {
    const bad = [];
    for (const m of String(content).matchAll(TAG_PATTERN)) {
      if (!SNIPPET_TAGS.includes(m[1].trim().toLowerCase())) bad.push(m[0]);
    }
    return bad;
  }

  // Why `content` can't be a snippet body, or "". Unknown tags only count
  // when `strictTags`: stored files are read leniently.
  function contentProblem(content, strictTags) {
    if (typeof content !== "string" || !content.trim()) return "Enter the text to insert.";
    if (content.length > SNIPPET_CONTENT_MAX) return `Use text of up to ${SNIPPET_CONTENT_MAX} characters.`;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) return "The text can't contain control characters.";
    if (strictTags) {
      const bad = unknownTags(content);
      if (bad.length) {
        return bad[0].slice(2, -2).trim() === ""
          ? "Empty tag {{}}. Use {{clipboard}}, {{date}}, {{time}} or {{timezone}}."
          : `Unknown tag ${bad[0]}. Use {{clipboard}}, {{date}}, {{time}} or {{timezone}}.`;
      }
    }
    return "";
  }

  const normalizeContent = (content) => content.replace(/\r\n?/g, "\n");

  // One record made valid, or the reason it can't be. Triggers are cleaned and
  // deduplicated within the record; the cross-record rules are the callers'.
  function cleanRecord(entry, strictTags) {
    if (!entry || typeof entry !== "object") return { problem: "a snippet that is not an object" };
    if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) return { problem: "a snippet without a valid id" };
    const content = typeof entry.content === "string" ? normalizeContent(entry.content) : entry.content;
    const problem = contentProblem(content, strictTags);
    if (problem) return { problem };
    const triggers = [];
    const seen = new Set();
    for (const raw of Array.isArray(entry.triggers) ? entry.triggers : []) {
      const bad = triggerProblem(raw);
      if (bad) return { problem: bad, trigger: true };
      const key = aliasKeyOf(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      triggers.push(cleanTrigger(raw));
    }
    if (triggers.length === 0) return { problem: "Add at least one trigger phrase.", trigger: true };
    if (triggers.length > SNIPPET_TRIGGERS_MAX) {
      return { problem: `Use up to ${SNIPPET_TRIGGERS_MAX} trigger phrases per snippet.`, trigger: true };
    }
    return { record: { id: entry.id, triggers, content } };
  }

  // The records as stored, made valid without ever throwing: settings.json may
  // be hand-edited or written by another version. Invalid snippets are
  // dropped; a trigger claimed twice stays with the first snippet that has it.
  // Idempotent. `onDrop(reason)` reports each dropped entry.
  function normalizeSnippets(value, onDrop = () => {}) {
    const records = [];
    const ids = new Set();
    const owned = new Set();
    for (const entry of Array.isArray(value) ? value : []) {
      const { record, problem } = cleanRecord(entry, false);
      if (!record) {
        onDrop(problem);
        continue;
      }
      if (ids.has(record.id)) {
        onDrop(`a second snippet with id ${record.id}`);
        continue;
      }
      if (records.length >= SNIPPET_MAX) {
        onDrop("a snippet past the limit");
        continue;
      }
      const triggers = record.triggers.filter((t) => !owned.has(aliasKeyOf(t)));
      if (triggers.length !== record.triggers.length) onDrop(`a trigger already owned by another snippet (${record.id})`);
      if (triggers.length === 0) continue;
      for (const t of triggers) owned.add(aliasKeyOf(t));
      ids.add(record.id);
      records.push({ ...record, triggers });
    }
    return records;
  }

  // Strict, throwing validation of what a user is saving. Returns the
  // normalized records. `trusted` is the snippets already on disk: one of them
  // that has not changed is accepted even if it holds a tag a newer version
  // would refuse, so an old file can never block saving something else.
  function validateSnippets(value, { trusted = [] } = {}) {
    if (!Array.isArray(value)) throw new Error("Snippets were not saved: the list is not valid.");
    if (value.length > SNIPPET_MAX) throw new Error(`Snippets hold up to ${SNIPPET_MAX} entries.`);
    const same = new Map(trusted.map((r) => [r?.id, JSON.stringify(r)]));
    const out = [];
    const ids = new Set();
    const owners = new Map();
    value.forEach((entry, index) => {
      const unchanged = same.get(entry?.id) === JSON.stringify(entry);
      const { record, problem } = cleanRecord(entry, !unchanged);
      const where = `Snippet ${index + 1}${record?.triggers ? ` (“${record.triggers[0]}”)` : ""}:`;
      if (!record) throw new Error(`${where} ${problem}`);
      if (ids.has(record.id)) throw new Error(`${where} duplicate snippet id.`);
      ids.add(record.id);
      for (const trigger of record.triggers) {
        const key = aliasKeyOf(trigger);
        if (owners.has(key)) {
          throw new Error(`${where} “${trigger}” already inserts another snippet (“${owners.get(key)}”). Change one of them.`);
        }
        owners.set(key, record.triggers[0]);
      }
      out.push(record);
    });
    return out;
  }

  // Merge a form's edits into what main has saved since, by intent and per
  // snippet id (like mergeAliases): a snippet the form deleted goes, one it
  // added or edited comes in whole, and snippets another window added or
  // edited while the form was open stay. Throws (so the save fails and the
  // live list is untouched) when the union breaks a rule, e.g. two windows
  // each gave a different snippet the same trigger.
  function mergeSnippets(baseline, edited, live) {
    const key = (list) => new Map(normalizeSnippets(list).map((r) => [r.id, r]));
    const before = key(baseline);
    const wanted = key(edited);
    const current = key(live);
    const result = new Map();
    for (const [id, record] of wanted) {
      const touched = JSON.stringify(before.get(id)) !== JSON.stringify(record);
      if (touched) result.set(id, record);
      else if (current.has(id)) result.set(id, current.get(id));
      // untouched here and gone from live: deleted elsewhere, stays deleted
    }
    for (const [id, record] of current) {
      if (result.has(id)) continue;
      // The form deleted it, unless it was changed elsewhere in the meantime
      // (then the newer edit is kept); one the form never saw stays.
      if (!wanted.has(id) && before.has(id) && JSON.stringify(before.get(id)) === JSON.stringify(record)) continue;
      result.set(id, record);
    }
    return validateSnippets([...result.values()], { trusted: [...current.values()] });
  }

  // The trigger identity, exposed for the matcher and the Settings search.
  const triggerKey = aliasKeyOf;

  // ---- tags ----

  // Calendar parts of `now` in `timeZone` (an IANA name). A name the runtime
  // doesn't know falls back to the system zone, never throws.
  function zoneParts(now, timeZone) {
    const build = (zone) => {
      const f = new Intl.DateTimeFormat("en-CA", {
        ...(zone ? { timeZone: zone } : {}),
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      });
      const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
      return { parts, zone: zone || f.resolvedOptions().timeZone };
    };
    let built;
    try {
      built = build(timeZone);
    } catch {
      built = build(undefined);
    }
    const { parts, zone } = built;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
      timezone: zone,
    };
  }

  // Replace the tags in `content`. `context`: { clipboard, now, timeZone }.
  // One pass over the original text, so inserted text is never re-read.
  function renderSnippet(content, context = {}) {
    if (typeof content !== "string" || !content.includes("{{")) return content;
    let when = null;
    const values = {
      clipboard: () => String(context.clipboard ?? "").slice(0, CLIPBOARD_MAX),
      date: () => (when ??= zoneParts(context.now ?? new Date(), context.timeZone)).date,
      time: () => (when ??= zoneParts(context.now ?? new Date(), context.timeZone)).time,
      timezone: () => (when ??= zoneParts(context.now ?? new Date(), context.timeZone)).timezone,
    };
    return content.replace(TAG_PATTERN, (whole, name) => {
      const tag = name.trim().toLowerCase();
      return SNIPPET_TAGS.includes(tag) ? values[tag]() : whole;
    });
  }

  const usesClipboard = (records) =>
    (Array.isArray(records) ? records : []).some(
      (r) => typeof r?.content === "string" && [...r.content.matchAll(TAG_PATTERN)].some((m) => m[1].trim().toLowerCase() === "clipboard")
    );

  return {
    SNIPPET_MAX, SNIPPET_TRIGGERS_MAX, SNIPPET_TRIGGER_MAX, SNIPPET_CONTENT_MAX, CLIPBOARD_MAX, SNIPPET_TAGS,
    newSnippetId, cleanTrigger, triggerProblem, contentProblem, unknownTags,
    normalizeSnippets, validateSnippets, mergeSnippets, triggerKey, renderSnippet, usesClipboard,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = SnippetsLib;
}
