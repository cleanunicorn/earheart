const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("../renderer/model-progress");
test("model labels clamp real byte progress and disclose unknown sizes", () => {
  assert.equal(p.bytes(2.55e9), "2.5 GB");
  assert.equal(p.label({ received: 9e9, total: 2e9 }), "100% · 2.0 GB / 2.0 GB");
  assert.equal(p.fraction({ received: -1, total: 20 }), 0);
  assert.equal(p.fraction({ received: 5, total: null }), 0);
  assert.match(p.label({ received: 2e6, total: null }), /2 MB received · total unknown/);
});
