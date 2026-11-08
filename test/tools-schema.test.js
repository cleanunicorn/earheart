const { test } = require("node:test");
const assert = require("node:assert");
const { validateArgs, hashSchema, hashArgs } = require("../main/tools/schema");

const schema = {
  type: "object",
  properties: { n: { type: "integer", minimum: 1, maximum: 5 }, s: { type: "string", enum: ["a", "b"] }, list: { type: "array", items: { type: "string" }, maxItems: 2 } },
  required: ["n"],
  additionalProperties: false,
};

test("accepts valid arguments and rejects type, range, enum, required and extra keys", () => {
  assert.ok(validateArgs(schema, { n: 2, s: "a", list: ["x"] }).ok);
  assert.ok(!validateArgs(schema, {}).ok);
  assert.ok(!validateArgs(schema, { n: "2" }).ok);
  assert.ok(!validateArgs(schema, { n: 1.5 }).ok);
  assert.ok(!validateArgs(schema, { n: 9 }).ok);
  assert.ok(!validateArgs(schema, { n: 1, s: "c" }).ok);
  assert.ok(!validateArgs(schema, { n: 1, extra: 1 }).ok);
  assert.ok(!validateArgs(schema, { n: 1, list: ["a", "b", "c"] }).ok);
  assert.ok(!validateArgs(schema, [1]).ok);
  assert.ok(!validateArgs(schema, null).ok);
});

test("fails closed on keywords it does not implement", () => {
  for (const kw of [{ $ref: "#/x" }, { oneOf: [] }, { anyOf: [] }, { allOf: [] }, { pattern: "(a+)+$" }, { not: {} }]) {
    const res = validateArgs({ type: "object", properties: { x: kw } }, { x: "a" });
    assert.ok(!res.ok, JSON.stringify(kw));
    assert.match(res.errors[0], /unsupported keyword/);
  }
});

test("rejects prototype-pollution keys, oversized and non-JSON arguments", () => {
  const polluted = JSON.parse('{"n":1,"__proto__":{"admin":true}}');
  assert.ok(!validateArgs({ type: "object" }, polluted).ok);
  assert.ok(!validateArgs({ type: "object" }, JSON.parse('{"a":{"constructor":1}}')).ok);
  assert.ok(!validateArgs({ type: "object" }, { big: "x".repeat(70 * 1024) }).ok);
  assert.ok(!validateArgs({ type: "object" }, { f: () => 1 }).ok);
  assert.ok(!validateArgs({ type: "object" }, { n: Infinity }).ok);
  let deep = {}; const root = deep;
  for (let i = 0; i < 40; i++) { deep.a = {}; deep = deep.a; }
  assert.ok(!validateArgs({ type: "object" }, root).ok);
});

test("schema and argument hashes are order-independent and change with content", () => {
  assert.strictEqual(hashSchema({ a: 1, b: 2 }), hashSchema({ b: 2, a: 1 }));
  assert.notStrictEqual(hashSchema({ a: 1 }), hashSchema({ a: 2 }));
  assert.strictEqual(hashArgs({ x: 1, y: [1, 2] }), hashArgs({ y: [1, 2], x: 1 }));
  assert.notStrictEqual(hashArgs({ x: 1 }), hashArgs({ x: 2 }));
});
