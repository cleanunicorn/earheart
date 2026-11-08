// Spoken trigger phrases → saved text snippets (#334). Pure: no Electron, no
// I/O. The pipeline hands in the settings, the clipboard snapshot and a clean
// function; this module decides what is a snippet and what is speech.
//
// Matching (planExpansion), over the recognized text in NFC:
// - Case-insensitive (Unicode simple case folding, like aliases), whole words
//   only: no letter, mark, digit or underscore on either side. Whitespace in a
//   trigger matches any run of whitespace.
// - One pass, left to right. Where triggers overlap, the leftmost match wins,
//   and at one position the longest trigger. "my address" beats "my" at the
//   same spot; "my address book" (if saved) beats both.
// - Matches never overlap, and the text a snippet inserts is never scanned
//   again, so a snippet cannot trigger another: expansion does not cascade.
// - At most MAX_EXPANSIONS snippets per utterance; later matches stay words.
// - Whitespace at both ends of the utterance, and the punctuation the speech
//   engine puts after a trigger that ends it ("my address."), are dropped, so
//   saying only a trigger inserts exactly the snippet.
//
// Cleanup runs on the words between snippets, never on a snippet (expandTranscript).

const { renderSnippet, triggerKey } = require("../renderer/snippets");

const MAX_EXPANSIONS = 16;
const WORD = "[\\p{L}\\p{M}\\p{N}_]";
const TRAILING_PUNCTUATION = /^[\s.,!?;:…]*$/u;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compiled matchers are cached per snippets array identity: settings.get()
// hands out one array until the next save.
const matchers = new WeakMap();

function buildMatcher(snippets) {
  const triggers = [];
  for (const record of snippets) {
    for (const trigger of record.triggers || []) triggers.push({ trigger, key: triggerKey(trigger), record });
  }
  if (triggers.length === 0) return null;
  // Longest first, so at one position the longest trigger is tried first.
  triggers.sort((a, b) => b.trigger.length - a.trigger.length || (a.key < b.key ? -1 : 1));
  const alternatives = triggers.map((t) => `(${t.trigger.split(" ").map(escapeRegExp).join("\\s+")})`);
  return { triggers, pattern: new RegExp(`(?<!${WORD})(?:${alternatives.join("|")})(?!${WORD})`, "giu") };
}

function matcherFor(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  if (!matchers.has(snippets)) matchers.set(snippets, buildMatcher(snippets));
  return matchers.get(snippets);
}

// Split `raw` into [{ type: "text", text } | { type: "snippet", id, content }].
// Resolves to { matched: false } when no trigger is spoken, so the caller's
// ordinary path runs untouched. Never throws.
function planExpansion(raw, snippets) {
  try {
    if (typeof raw !== "string" || !raw) return { matched: false };
    const matcher = matcherFor(snippets);
    if (!matcher) return { matched: false };
    const source = raw.normalize("NFC").trim();
    const segments = [];
    let last = 0;
    let count = 0;
    for (const m of source.matchAll(matcher.pattern)) {
      if (count >= MAX_EXPANSIONS) break;
      const hit = matcher.triggers[m.findIndex((group, i) => i > 0 && group !== undefined) - 1];
      if (m.index > last) segments.push({ type: "text", text: source.slice(last, m.index) });
      segments.push({ type: "snippet", id: hit.record.id, content: hit.record.content });
      last = m.index + m[0].length;
      count += 1;
    }
    if (count === 0) return { matched: false };
    const rest = source.slice(last);
    if (rest && !TRAILING_PUNCTUATION.test(rest)) segments.push({ type: "text", text: rest });
    return { matched: true, segments };
  } catch {
    return { matched: false };
  }
}

const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

/**
 * Expand the snippets spoken in `raw`. Resolves to null when nothing matched
 * (the caller then runs its normal cleanup path), to { stale: true } when
 * `stale()` turned true while waiting, else to { text, cleaned }.
 *
 *   context  { clipboard, now, timeZone } for the tags, fixed by the caller
 *            once per dictation
 *   clean    async (words) => ({ text, cleaned }); omit for no cleanup. After
 *            the first segment it reports as not cleaned (it fell back to the
 *            raw words) the rest are left raw too, so one outage is one notice.
 *   finish   (words) => words, applied to every non-snippet piece (aliases);
 *            never to a snippet's text
 *   stale    () => boolean
 */
async function expandTranscript(raw, snippets, { context = {}, clean = null, finish = (t) => t, stale = () => false } = {}) {
  const plan = planExpansion(raw, snippets);
  if (!plan.matched) return null;
  const parts = [];
  let cleaned = false;
  let cleaning = typeof clean === "function";
  for (const [index, segment] of plan.segments.entries()) {
    if (segment.type === "snippet") {
      let body = segment.content;
      try {
        body = renderSnippet(segment.content, context);
      } catch {
        // Tags are a convenience: the unrendered text still goes out.
      }
      parts.push(body);
      continue;
    }
    const core = segment.text.trim();
    // Whitespace, and punctuation alone, between two snippets are kept as said.
    if (!hasWords(core)) {
      parts.push(segment.text);
      continue;
    }
    const lead = segment.text.slice(0, segment.text.length - segment.text.trimStart().length);
    const trail = segment.text.slice(segment.text.trimEnd().length);
    let words = core;
    if (cleaning) {
      const result = await clean(core);
      if (stale()) return { stale: true };
      if (result?.cleaned) {
        cleaned = true;
        words = String(result.text ?? "").trim();
      } else {
        cleaning = false;
      }
    }
    words = finish(words);
    // Cleanup can legitimately leave nothing (a lone "um"): keep one space
    // between two snippets, and nothing at either end of the text.
    const between = index > 0 && index < plan.segments.length - 1;
    parts.push(words ? lead + words + trail : between ? " " : "");
  }
  return { text: parts.join(""), cleaned };
}

module.exports = { MAX_EXPANSIONS, planExpansion, expandTranscript };
