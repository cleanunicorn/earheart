const { test } = require("node:test");
const assert = require("node:assert");

const { serviceUrl } = require("../main/services/service-url");
const { serviceErrorSummary } = require("../main/services/error-summary");
const { transcribe } = require("../main/services/stt");
const { clean } = require("../main/services/cleanup");

async function withErrorServer(status, body, run) {
  const server = require("node:http").createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

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

test("service error summaries ignore raw bodies and redact credentials", () => {
  assert.strictEqual(serviceErrorSummary("not JSON with sk-secret-value"), "");
  assert.strictEqual(
    serviceErrorSummary('{"error":{"message":"bad key sk-123456789012345678901234"}}'),
    "bad key [redacted API key]"
  );
  assert.strictEqual(serviceErrorSummary('{"error":{"message":"authorization Bearer abc123"}}'), "authorization Bearer [redacted]");
  assert.strictEqual(serviceErrorSummary('{"message":"not an error object"}'), "");
  assert.strictEqual(serviceErrorSummary('{"error":{"message":"settings key sk-short"}}'), "settings key sk-short");
});

test("remote STT errors never include raw response bodies or API keys", async () => {
  const body = JSON.stringify({
    error: {
      message: "Incorrect API key: sk-123456789012345678901234",
      type: "invalid_request_error",
      private: "extra",
    },
  });
  await withErrorServer(401, body, async (baseUrl) => {
    await assert.rejects(
      transcribe(Buffer.alloc(0), { baseUrl, apiKey: "sk-client-secret" }),
      (err) => {
        assert.strictEqual(err.message, "STT service error 401: Incorrect API key: [redacted API key]");
        assert.doesNotMatch(err.message, /sk-secret|private|invalid_request/);
        return true;
      }
    );
  });
});

test("remote cleanup errors never include echoed dictated text", async () => {
  const body = JSON.stringify({ error: { message: "content rejected: private dictated sentence" } });
  await withErrorServer(400, body, async (baseUrl) => {
    await assert.rejects(
      clean("private dictated sentence", { baseUrl, apiKey: "sk-client-secret", model: "m" }),
      (err) => {
        assert.strictEqual(err.message, "Cleanup service error 400: content rejected: private dictated sentence");
        return true;
      }
    );
  });
});
