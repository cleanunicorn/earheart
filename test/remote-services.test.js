const { test } = require("node:test");
const assert = require("node:assert");

const { serviceUrl } = require("../main/services/service-url");
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

test("remote STT errors expose only a fixed message and HTTP status", async () => {
  const body = JSON.stringify({ error: { message: "secret-token-123 private transcript" } });
  await withErrorServer(401, body, async (baseUrl) => {
    await assert.rejects(
      transcribe(Buffer.alloc(0), { baseUrl, apiKey: "sk-client-secret" }),
      (err) => {
        assert.strictEqual(err.message, "STT service error 401");
        assert.doesNotMatch(err.message, /secret-token|private transcript|sk-client-secret/);
        return true;
      }
    );
  });
});

test("remote cleanup errors expose only a fixed message and HTTP status", async () => {
  const body = JSON.stringify({ error: { message: "content rejected: private dictated sentence" } });
  await withErrorServer(400, body, async (baseUrl) => {
    await assert.rejects(
      clean("private dictated sentence", { baseUrl, apiKey: "sk-client-secret", model: "m" }),
      (err) => {
        assert.strictEqual(err.message, "Cleanup service error 400");
        assert.doesNotMatch(err.message, /private dictated sentence|content rejected|sk-client-secret/);
        return true;
      }
    );
  });
});

test("remote service errors do not parse malformed or oversized provider messages", async () => {
  const bodies = ["not JSON secret-token-123", JSON.stringify({ error: { message: "x".repeat(10000) } })];
  for (const body of bodies) {
    await withErrorServer(502, body, async (baseUrl) => {
      await assert.rejects(transcribe(Buffer.alloc(0), { baseUrl }), (err) => {
        assert.strictEqual(err.message, "STT service error 502");
        assert.doesNotMatch(err.message, /secret-token|x{20}/);
        return true;
      });
    });
  }
});
