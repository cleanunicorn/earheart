const { test } = require("node:test");
const assert = require("node:assert");

const { serviceUrl } = require("../main/services/service-url");
const { transcribe } = require("../main/services/stt");
const { clean } = require("../main/services/cleanup");

test("serviceUrl preserves base paths and removes trailing slashes", () => {
  assert.strictEqual(
    serviceUrl(" https://api.example.test/v1/// ", "/models"),
    "https://api.example.test/v1/models"
  );
});

test("serviceUrl rejects missing, invalid and non-network bases", () => {
  assert.throws(() => serviceUrl("", "/models"), /required/);
  assert.throws(() => serviceUrl("localhost:8080", "/models"), /http or https/);
  assert.throws(() => serviceUrl("file:///tmp/service", "/models"), /http or https/);
});

test("remote STT rejects an unsafe service URL before making a request", async () => {
  await assert.rejects(
    transcribe(Buffer.alloc(0), { baseUrl: "file:///tmp/transcribe" }),
    /http or https/
  );
});

test("remote cleanup rejects an unsafe service URL before making a request", async () => {
  await assert.rejects(clean("keep my words", { baseUrl: "data:text/plain,no" }), /http or https/);
});
