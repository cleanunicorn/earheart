// Destination-aware formatting (#336): which capitalization/punctuation style a
// dictation gets, chosen by WHERE it will land — a website host or an
// application — instead of one global style.
//
// Pure and dependency-free (Node built-ins only). Three separate concerns live
// elsewhere or here, on purpose:
//   - cleanup intensity (Verbatim / Clean / Polished): main/cleanup-styles.js
//   - formatting style (this file): how the text is cased and punctuated
//   - the destination (this file + main/context-detector.js): what picks it
//
// Precedence, most specific first:  website host  >  application  >  default.
// A rule is an exact, normalized match; there are no wildcards or suffix
// matches, so `github.com.evil.example` or `notgithub.com` never match a
// `github.com` rule, and `gist.github.com` is its own host.

const { domainToASCII } = require("node:url");

const DEFAULT_FORMATTING_STYLE = "standard";

// Limits for the stored rule list (hand-edited files, other versions).
const MAX_RULES = 50;
const MAX_HOST_LENGTH = 253; // DNS name limit
const MAX_APP_ID_LENGTH = 200;

// `directive` is appended to the cleanup prompt as an independent "Formatting"
// block. `standard` adds nothing, so the default prompt is byte-identical to
// what it was before this feature.
const FORMATTING_STYLES = [
  {
    id: "standard",
    label: "Standard",
    hint: "No special formatting — the cleanup style decides",
    directive: "",
  },
  {
    id: "email",
    label: "Email / documents",
    hint: "Full sentences, capitalized, ending punctuation",
    directive:
      "Write complete, correctly capitalized sentences with normal ending " +
      "punctuation, as in an email or a document.",
  },
  {
    id: "chat",
    label: "Chat",
    hint: "Casual: no capital at the start, no final period",
    directive:
      "Format as a casual chat message: start with a lowercase letter unless " +
      "the first word is a name, 'I' or an acronym, and leave off the final " +
      "period. Keep question marks and exclamation marks. Commas stay.",
  },
  {
    id: "code-safe",
    label: "Code-safe",
    hint: "Leave identifiers, paths, flags and numbers exactly as spoken",
    directive:
      "The text may be typed into a terminal, editor or coding agent. Never " +
      "change the spelling or casing of file paths, command names, flags " +
      "(like --verbose or -x), snake_case or camelCase identifiers, version " +
      "numbers, URLs or other numbers, and do not add punctuation inside or " +
      "directly after them. Do not add a final period.",
  },
];

function formattingStyleById(id) {
  return FORMATTING_STYLES.find((s) => s.id === id) || FORMATTING_STYLES[0];
}

function isFormattingStyle(id) {
  return FORMATTING_STYLES.some((s) => s.id === id);
}

// The prompt block for a style id; "" for standard and for anything unknown.
function formattingDirective(id) {
  const text = formattingStyleById(id).directive;
  return text ? `\n\nFormatting: ${text}` : "";
}

// ---- host normalization -------------------------------------------------

// A hostname from a bare host or a URL, in the one form rules compare:
// lowercase ASCII (IDNs as punycode), no scheme / userinfo / port / path /
// trailing dot, one leading "www." removed. "" for anything that is not a
// plain host — wildcards, spaces, IP literals with brackets, over-long names.
function normalizeHost(input) {
  if (typeof input !== "string") return "";
  let s = input.trim().toLowerCase();
  if (!s || s.length > 2048) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.replace(/[/?#].*$/, ""); // path, query, fragment
  s = s.replace(/^[^@]*@/, ""); // userinfo
  if (s.startsWith("[")) return ""; // IPv6 literal: not a website scope
  s = s.replace(/:\d*$/, ""); // port
  s = s.replace(/\.+$/, ""); // trailing dot(s)
  if (!s || /[\s*%\\]/.test(s)) return "";
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > MAX_HOST_LENGTH) return "";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(ascii)) return "";
  return ascii.replace(/^www\./, "") || "";
}

// An application scope is an opaque id the detector reports (the macOS bundle
// identifier). Compared case-insensitively, as macOS treats them.
function normalizeAppId(input) {
  if (typeof input !== "string") return "";
  const s = input.trim().toLowerCase();
  if (!s || s.length > MAX_APP_ID_LENGTH || !/^[a-z0-9._-]+$/.test(s)) return "";
  return s;
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== "object") return null;
  if (scope.type === "host") {
    const value = normalizeHost(scope.value);
    return value ? { type: "host", value } : null;
  }
  if (scope.type === "app") {
    const value = normalizeAppId(scope.value);
    return value ? { type: "app", value } : null;
  }
  return null;
}

// ---- stored config ------------------------------------------------------

// Make a stored `formatting` section valid whatever the file held: unknown
// default → standard; malformed, unknown-style and duplicate-scope rules
// dropped (the first one claiming a scope wins, so `www.GitHub.com` and
// `github.com` collide); at most MAX_RULES kept. Never throws. `onDrop(reason)`
// is called per dropped rule, with no user text in the reason.
function sanitizeFormatting(raw, onDrop = () => {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const defaultStyle = isFormattingStyle(src.defaultStyle) ? src.defaultStyle : DEFAULT_FORMATTING_STYLE;
  const rules = [];
  const seen = new Set();
  const list = Array.isArray(src.rules) ? src.rules : [];
  for (const entry of list) {
    if (rules.length >= MAX_RULES) {
      onDrop("too many rules");
      break;
    }
    const scope = normalizeScope(entry?.scope);
    if (!scope) {
      onDrop("invalid scope");
      continue;
    }
    if (!isFormattingStyle(entry.style)) {
      onDrop("unknown style");
      continue;
    }
    const key = `${scope.type}:${scope.value}`;
    if (seen.has(key)) {
      onDrop("duplicate scope");
      continue;
    }
    seen.add(key);
    const id = typeof entry.id === "string" && /^[\w-]{1,40}$/.test(entry.id) ? entry.id : `rule-${rules.length + 1}`;
    rules.push({ id, scope, style: entry.style });
  }
  // Ids unique even when a file repeated one.
  const ids = new Set();
  for (const rule of rules) {
    let id = rule.id;
    for (let n = 2; ids.has(id); n++) id = `${rule.id}-${n}`;
    rule.id = id;
    ids.add(id);
  }
  return { defaultStyle, rules };
}

// ---- resolution ---------------------------------------------------------

// What the detector can tell about the destination: `{ app: { id, name } | null,
// host: string | null }`. Anything missing or malformed counts as unavailable.
function normalizeContext(context) {
  const appId = normalizeAppId(context?.app?.id);
  const name = typeof context?.app?.name === "string" ? context.app.name.slice(0, 80) : "";
  return {
    app: appId ? { id: appId, name } : null,
    host: normalizeHost(context?.host) || null,
  };
}

// Pick the formatting style for a destination. Always answers: with no context
// (unsupported platform, permission denied, timeout) it is the default style.
// → { styleId, source: "host" | "app" | "default", ruleId, label }
// `label` is the destination as shown in the overlay (host, else app name).
function resolveFormatting(formatting, context) {
  const cfg = sanitizeFormatting(formatting);
  const ctx = normalizeContext(context);
  const byScope = (type, value) => cfg.rules.find((r) => r.scope.type === type && r.scope.value === value);
  const hostRule = ctx.host ? byScope("host", ctx.host) : undefined;
  if (hostRule) return { styleId: hostRule.style, source: "host", ruleId: hostRule.id, label: ctx.host };
  const appRule = ctx.app ? byScope("app", ctx.app.id) : undefined;
  if (appRule) return { styleId: appRule.style, source: "app", ruleId: appRule.id, label: ctx.app.name || ctx.app.id };
  return { styleId: cfg.defaultStyle, source: "default", ruleId: null, label: "" };
}

// The take's immutable formatting decision: the resolved style id and its
// directive text, so editing rules, presets or the default mid-take cannot
// change live preview, the final pass or a retry of that take.
function freezeFormatting(resolved) {
  const styleId = isFormattingStyle(resolved?.styleId) ? resolved.styleId : DEFAULT_FORMATTING_STYLE;
  return Object.freeze({
    styleId,
    directive: formattingStyleById(styleId).directive,
    source: resolved?.source || "default",
    ruleId: resolved?.ruleId || null,
    label: resolved?.label || "",
  });
}

// ---- code-safe guard ----------------------------------------------------

// Prompts are advisory. For the code-safe style, spoken-text tokens that must
// survive verbatim are checked deterministically after cleanup.
const PROTECTED_PATTERNS = [
  /(?:^|\s)((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)*)/g, // paths
  /(?:^|\s)(--?[A-Za-z][\w-]*)/g, // flags
  /\b([a-z]+(?:_[a-z0-9]+)+)\b/g, // snake_case
  /\b([a-z]+(?:[A-Z][a-z0-9]+)+)\b/g, // camelCase
  /\b(\d+(?:\.\d+)+)\b/g, // versions / decimals
];

function protectedTokens(text) {
  const out = new Set();
  for (const re of PROTECTED_PATTERNS) {
    for (const m of String(text || "").matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// True when every protected token of the raw transcript is still in the
// cleaned text, byte for byte. Only meaningful for code-safe.
function protectedTokensIntact(raw, cleaned) {
  const out = String(cleaned || "");
  return protectedTokens(raw).every((token) => out.includes(token));
}

// Cleanup output to use: for code-safe, the cleaned text only if it kept every
// protected token, else the raw transcript (formatting is not applied to it).
function guardCleaned(styleId, raw, cleaned) {
  if (styleId !== "code-safe") return cleaned;
  return protectedTokensIntact(raw, cleaned) ? cleaned : raw;
}

module.exports = {
  DEFAULT_FORMATTING_STYLE,
  FORMATTING_STYLES,
  MAX_RULES,
  MAX_HOST_LENGTH,
  formattingStyleById,
  isFormattingStyle,
  formattingDirective,
  normalizeHost,
  normalizeAppId,
  sanitizeFormatting,
  resolveFormatting,
  freezeFormatting,
  protectedTokens,
  protectedTokensIntact,
  guardCleaned,
};
