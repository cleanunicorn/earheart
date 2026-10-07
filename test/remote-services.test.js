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
        assert.strictEqual(err.message, "STT service error 401 — check the API key in Settings");
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

test("remote cleanup rejects blank and thought-only responses but accepts unchanged text", async () => {
  for (const content of ["", "  ", "<think>reasoning only</think>", "<think>unfinished"]) {
    await withErrorServer(200, JSON.stringify({ choices: [{ message: { content } }] }), async (baseUrl) => {
      await assert.rejects(clean("Hello.", { baseUrl }), /no usable text/i);
    });
  }
  await withErrorServer(200, JSON.stringify({ choices: [{ message: { content: "Hello." } }] }), async (baseUrl) => {
    assert.strictEqual(await clean("Hello.", { baseUrl }), "Hello.");
  });
});

// A server whose handler the test writes, for the shapes withErrorServer can't
// make: a hang, a stalled body.
async function withServer(handler, run) {
  const server = require("node:http").createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// A port nothing listens on: bind one, then let it go.
async function closedPortUrl() {
  const server = require("node:http").createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

const clients = [
  { name: "STT", service: "STT service", call: (cfg, signal) => transcribe(Buffer.alloc(0), cfg, signal) },
  { name: "cleanup", service: "Cleanup service", call: (cfg, signal) => clean("my private words", { model: "m", ...cfg }, signal) },
];

test("remote STT returns trimmed text and rejects a reply without it", async () => {
  await withErrorServer(200, JSON.stringify({ text: " hi " }), async (baseUrl) => {
    assert.strictEqual(await transcribe(Buffer.alloc(0), { baseUrl }), "hi");
  });
  await withErrorServer(200, "{}", async (baseUrl) => {
    await assert.rejects(transcribe(Buffer.alloc(0), { baseUrl }), /no `text`/);
  });
  await withErrorServer(500, JSON.stringify({ error: { message: "secret-token-123" } }), async (baseUrl) => {
    await assert.rejects(transcribe(Buffer.alloc(0), { baseUrl }), (err) => {
      assert.strictEqual(err.message, "STT service error 500");
      assert.strictEqual(err.cause, undefined);
      return true;
    });
  });
});

test("remote cleanup reports a server error and a reply with no content", async () => {
  await withErrorServer(503, JSON.stringify({ error: { message: "my private words" } }), async (baseUrl) => {
    await assert.rejects(clean("my private words", { baseUrl, model: "m" }), (err) => {
      assert.strictEqual(err.message, "Cleanup service error 503");
      assert.strictEqual(err.cause, undefined);
      return true;
    });
  });
  await withErrorServer(200, JSON.stringify({ choices: [{ message: {} }] }), async (baseUrl) => {
    await assert.rejects(clean("Hello.", { baseUrl }), /no message content/);
  });
});

for (const { name, service, call } of clients) {
  test(`remote ${name}: 401 and 403 point at the API key, never at the body`, async () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided: sk-secret-value my private words" } });
    for (const status of [401, 403]) {
      await withErrorServer(status, body, async (baseUrl) => {
        await assert.rejects(call({ baseUrl, apiKey: "sk-client-secret" }), (err) => {
          assert.strictEqual(err.message, `${service} error ${status} — check the API key in Settings`);
          assert.doesNotMatch(err.message, /sk-secret-value|sk-client-secret|private words/);
          // The body is never read, so nothing from it can ride along either.
          assert.strictEqual(err.cause, undefined);
          return true;
        });
      });
    }
  });

  test(`remote ${name}: an unreachable host reads as plain copy`, async () => {
    const baseUrl = await closedPortUrl();
    const host = new URL(baseUrl).host;
    await assert.rejects(call({ baseUrl }), (err) => {
      assert.strictEqual(err.message, `Couldn't reach ${host}`);
      assert.doesNotMatch(err.message, /fetch failed/);
      // The technical reason stays attached for the log.
      assert.ok(err.cause, "the original error is kept as the cause");
      return true;
    });
  });

  test(`remote ${name}: a server that never answers times out in plain copy`, async () => {
    await withServer(() => {}, async (baseUrl) => {
      await assert.rejects(call({ baseUrl, timeoutMs: 50 }), (err) => {
        assert.strictEqual(err.message, `${service} didn't answer within 0.05 s`);
        assert.strictEqual(err.cause?.name, "TimeoutError");
        return true;
      });
    });
  });

  test(`remote ${name}: a body that stalls after the headers times out in plain copy`, async () => {
    const handler = (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"te');
    };
    await withServer(handler, async (baseUrl) => {
      await assert.rejects(call({ baseUrl, timeoutMs: 100 }), (err) => {
        assert.strictEqual(err.message, `${service} didn't answer within 0.1 s`);
        return true;
      });
    });
  });

  test(`remote ${name}: a reply that isn't JSON says so, without echoing it`, async () => {
    await withErrorServer(200, "<html>secret-token-123</html>", async (baseUrl) => {
      await assert.rejects(call({ baseUrl }), (err) => {
        assert.strictEqual(err.message, `${service} returned a response that isn't JSON`);
        // The parse error quotes the body, so it must not ride along to the log.
        assert.strictEqual(err.cause, undefined);
        return true;
      });
    });
  });

  test(`remote ${name}: a connection dropped mid-reply says so, not "isn't JSON"`, async () => {
    const handler = (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"te');
      setTimeout(() => res.socket.destroy(), 20);
    };
    await withServer(handler, async (baseUrl) => {
      await assert.rejects(call({ baseUrl }), (err) => {
        assert.strictEqual(err.message, `${service} dropped the connection before finishing its reply`);
        assert.ok(err.cause, "the transport error is kept for the log");
        return true;
      });
    });
  });

  test(`remote ${name}: a cancel while the reply streams in stays a cancel`, async () => {
    const controller = new AbortController();
    const handler = (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"te');
      setTimeout(() => controller.abort(), 20);
    };
    await withServer(handler, async (baseUrl) => {
      await assert.rejects(call({ baseUrl }, controller.signal), (err) => {
        assert.strictEqual(err.name, "AbortError");
        return true;
      });
    });
  });

  test(`remote ${name}: a cancel stays a cancel`, async () => {
    await withServer(() => {}, async (baseUrl) => {
      const controller = new AbortController();
      const pending = call({ baseUrl }, controller.signal);
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, (err) => {
        assert.strictEqual(err.name, "AbortError");
        assert.doesNotMatch(err.message, /Couldn't reach/);
        return true;
      });
    });
  });
}

test("remote clients report the default timeout in whole seconds", async () => {
  const { transportError } = require("../main/services/transport-error");
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  assert.strictEqual(
    transportError(timeout, "http://h:1/v1", { service: "STT service", timeoutS: 120 }).message,
    "STT service didn't answer within 120 s"
  );
});
