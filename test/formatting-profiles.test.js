// Destination-aware formatting (#336): host normalization, exact matching,
// precedence, stored-config sanitizing, the prompt block and the code-safe guard.

const { test } = require("node:test");
const assert = require("node:assert");

const fp = require("../main/formatting-profiles");
const { resolveCleanup, STYLES } = require("../main/cleanup-styles");
const { DEFAULTS } = require("../main/settings");

test("normalizeHost reduces URLs and hosts to one comparable form", () => {
  const cases = {
    "github.com": "github.com",
    "GitHub.COM": "github.com",
    "www.github.com": "github.com",
    "WWW.GitHub.com": "github.com",
    "https://www.github.com/org/repo?x=1#top": "github.com",
    "https://user:pw@github.com:8443/a": "github.com",
    "github.com.": "github.com",
    "  mail.example.com  ": "mail.example.com",
    "bücher.example": "xn--bcher-kva.example",
    "localhost": "localhost",
  };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(fp.normalizeHost(input), want, input);
});

test("normalizeHost rejects anything that is not a plain host", () => {
  for (const bad of ["", "   ", "*.github.com", "git hub.com", "[::1]", "a..b", "-bad.com", "github.com\\evil", "%67ithub.com", null, undefined, 42, "a".repeat(300) + ".com"]) {
    assert.strictEqual(fp.normalizeHost(bad), "", String(bad).slice(0, 20));
  }
});

const rules = (...list) => ({ defaultStyle: "standard", rules: list });
const host = (value, style, id = value) => ({ id, scope: { type: "host", value }, style });
const app = (value, style, id = value) => ({ id, scope: { type: "app", value }, style });

test("lookalike domains never match a host rule", () => {
  const cfg = rules(host("github.com", "code-safe"));
  for (const lookalike of ["notgithub.com", "github.com.evil.example", "evil-github.com", "gist.github.com", "github.co", "githubcom", "github.com.", "xn--gthub-bsa.com"]) {
    const got = fp.resolveFormatting(cfg, { host: lookalike });
    const expectMatch = lookalike === "github.com.";
    assert.strictEqual(got.source === "host", expectMatch, lookalike);
  }
  assert.strictEqual(fp.resolveFormatting(cfg, { host: "WWW.GITHUB.COM" }).styleId, "code-safe");
});

test("precedence: host rule, then application rule, then default", () => {
  const cfg = { defaultStyle: "chat", rules: [host("github.com", "code-safe", "h"), app("com.google.chrome", "email", "a")] };
  const chrome = { id: "com.google.Chrome", name: "Chrome" };
  assert.deepStrictEqual(
    fp.resolveFormatting(cfg, { app: chrome, host: "github.com" }),
    { styleId: "code-safe", source: "host", ruleId: "h", label: "github.com" }
  );
  assert.deepStrictEqual(
    fp.resolveFormatting(cfg, { app: chrome, host: "other.example" }),
    { styleId: "email", source: "app", ruleId: "a", label: "Chrome" }
  );
  assert.strictEqual(fp.resolveFormatting(cfg, { app: { id: "com.other.app" }, host: null }).styleId, "chat");
});

test("unavailable context resolves to the default style, never throws", () => {
  for (const ctx of [undefined, null, {}, { host: 5 }, { app: "x" }, { supported: false, app: null, host: null }]) {
    const got = fp.resolveFormatting({ defaultStyle: "chat", rules: [host("github.com", "email")] }, ctx);
    assert.deepStrictEqual([got.styleId, got.source], ["chat", "default"]);
  }
  assert.strictEqual(fp.resolveFormatting(undefined, null).styleId, "standard");
});

test("a host rule is not matched by an application id and vice versa", () => {
  const cfg = rules(host("github.com", "chat"), app("github.com", "email"));
  assert.strictEqual(fp.resolveFormatting(cfg, { app: { id: "github.com" } }).styleId, "email");
});

test("sanitizeFormatting tolerates old and malformed files", () => {
  assert.deepStrictEqual(fp.sanitizeFormatting(undefined), { defaultStyle: "standard", rules: [] });
  assert.deepStrictEqual(fp.sanitizeFormatting("nope"), { defaultStyle: "standard", rules: [] });
  assert.deepStrictEqual(fp.sanitizeFormatting({ defaultStyle: "wat", rules: "x" }), { defaultStyle: "standard", rules: [] });
  const dropped = [];
  const out = fp.sanitizeFormatting(
    {
      defaultStyle: "chat",
      rules: [
        null, 7, {}, { scope: { type: "host", value: "*.evil.com" }, style: "chat" },
        { scope: { type: "host", value: "a.com" }, style: "nonsense" },
        { scope: { type: "other", value: "a.com" }, style: "chat" },
        host("www.GitHub.com", "chat", "one"),
        host("github.com", "email", "two"), // duplicate after normalization
        host("https://mail.example.com/inbox", "email", "one"), // repeated id
      ],
    },
    (reason) => dropped.push(reason)
  );
  assert.deepStrictEqual(out.rules.map((r) => [r.scope.value, r.style]), [["github.com", "chat"], ["mail.example.com", "email"]]);
  assert.strictEqual(new Set(out.rules.map((r) => r.id)).size, 2, "ids are unique");
  assert.strictEqual(out.defaultStyle, "chat");
  assert.ok(dropped.includes("duplicate scope"));
  assert.ok(dropped.every((r) => !/evil|github/.test(r)), "reasons carry no user text");
});

test("sanitizeFormatting caps the rule count", () => {
  const many = Array.from({ length: fp.MAX_RULES + 20 }, (_, i) => host(`site${i}.example`, "chat"));
  assert.strictEqual(fp.sanitizeFormatting({ rules: many }).rules.length, fp.MAX_RULES);
  assert.strictEqual(fp.normalizeHost("a".repeat(fp.MAX_HOST_LENGTH) + ".com"), "");
});

test("freezeFormatting captures the directive and is immutable", () => {
  const frozen = fp.freezeFormatting(fp.resolveFormatting(rules(host("github.com", "code-safe")), { host: "github.com" }));
  assert.ok(Object.isFrozen(frozen));
  assert.strictEqual(frozen.directive, fp.formattingStyleById("code-safe").directive);
  assert.strictEqual(fp.freezeFormatting({ styleId: "bogus" }).styleId, "standard");
});

test("default settings carry an empty standard formatting section", () => {
  assert.deepStrictEqual(DEFAULTS.formatting, { defaultStyle: "standard", rules: [] });
});

test("standard formatting leaves every cleanup prompt byte-identical", () => {
  const base = { systemPrompt: DEFAULTS.cleanup.systemPrompt, dictionary: ["Kubernetes"], aliases: [], custom: { temperature: 0.3 } };
  for (const style of [...STYLES.map((s) => s.id), "custom"]) {
    const plain = resolveCleanup({ ...base, style });
    assert.deepStrictEqual(resolveCleanup({ ...base, style, formattingStyle: "standard" }), plain, style);
    assert.deepStrictEqual(resolveCleanup({ ...base, style, formattingStyle: "unknown-id" }), plain, style);
  }
});

test("a formatting style adds its own block, independent of the cleanup intensity (custom too)", () => {
  const base = { systemPrompt: "BASE", dictionary: [], aliases: [], custom: { temperature: 0.3 } };
  for (const style of [...STYLES.map((s) => s.id), "custom"]) {
    const out = resolveCleanup({ ...base, style, formattingStyle: "chat" });
    assert.ok(out.systemPrompt.includes(`Formatting: ${fp.formattingStyleById("chat").directive}`), style);
    assert.deepStrictEqual(out.sampling, resolveCleanup({ ...base, style }).sampling, "sampling is untouched");
  }
});

test("the code-safe directive names the protected classes", () => {
  const text = fp.formattingStyleById("code-safe").directive;
  for (const word of ["paths", "flags", "snake_case", "camelCase", "numbers"]) assert.ok(text.includes(word), word);
});

test("code-safe guard keeps cleaned text only when every protected token survives", () => {
  const raw = "run npm test with --watch in ./src/main_loop.js version 1.2.3 then call getUserName";
  assert.ok(fp.protectedTokens(raw).length >= 5, fp.protectedTokens(raw).join(","));
  const good = "Run npm test with --watch in ./src/main_loop.js, version 1.2.3, then call getUserName";
  assert.strictEqual(fp.guardCleaned("code-safe", raw, good), good);
  for (const broken of [good.replace("--watch", "watch"), good.replace("main_loop", "main loop"), good.replace("1.2.3", "1.2"), good.replace("getUserName", "get user name"), good.replace("./src", "src")]) {
    assert.strictEqual(fp.guardCleaned("code-safe", raw, broken), raw, broken);
  }
});

test("the guard never touches other styles", () => {
  assert.strictEqual(fp.guardCleaned("chat", "use --flag", "use flag"), "use flag");
  assert.strictEqual(fp.guardCleaned("standard", "use --flag", "use flag"), "use flag");
});
