const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { serviceUrl, authHeaders, HTTP_TIMEOUT_MS } = require("../main/services/service-url");
const { transcribe } = require("../main/services/stt");
const { clean, stripThinking } = require("../main/services/cleanup");
const { CLEAN_RUNAWAY_MESSAGE } = require("../main/util/clean-budget");
const { listRemoteModels } = require("../main/services/models-remote");

// A local server whose handler the test writes: a hang, a stalled or dropped
// body, a canned reply.
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

// A canned reply, sent once the request body is drained (STT posts a
// multipart upload; answering before it is read can reset the connection).
function withErrorServer(status, body, run) {
  return withServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  }, run);
}

test("serviceUrl preserves base paths and removes trailing slashes", () => {
  assert.strictEqual(
    serviceUrl(" https://api.example.test/v1/// ", "/models"),
    "https://api.example.test/v1/models"
  );
});

test("serviceUrl doesn't echo a query or fragment from an invalid base", () => {
  // A key pasted into the URL would otherwise reach the overlay and the log.
  assert.throws(
    () => serviceUrl("http//api.example.test/v1?key=sk-in-url#frag", "/models"),
    (err) => {
      assert.strictEqual(err.message, "Invalid base URL: http//api.example.test/v1");
      return true;
    }
  );
});

test("serviceUrl rejects missing, invalid and non-network bases", () => {
  assert.throws(() => serviceUrl("", "/models"), /required/);
  assert.throws(() => serviceUrl("localhost:8080", "/models"), /http or https/);
  assert.throws(() => serviceUrl("file:///tmp/service", "/models"), /http or https/);
});

test("serviceUrl rejects a non-string base as missing", () => {
  for (const base of [undefined, null, 123, {}]) {
    assert.throws(() => serviceUrl(base, "/models"), /^Error: Base URL is required$/);
  }
});

test("authHeaders sends a Bearer key and nothing without one", () => {
  assert.deepStrictEqual(authHeaders("sk-test"), { Authorization: "Bearer sk-test" });
  for (const key of [undefined, null, ""]) assert.deepStrictEqual(authHeaders(key), {});
});

test("HTTP_TIMEOUT_MS is the shared 15 s metadata deadline", () => {
  assert.strictEqual(HTTP_TIMEOUT_MS, 15000);
});

// Record each request's auth and content-type headers; assert in the test body.
function withHeaderServer(reply, run) {
  const seen = [];
  return withServer((req, res) => {
    seen.push({ auth: req.headers.authorization, type: req.headers["content-type"] });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  }, (baseUrl) => run(baseUrl, seen));
}

test("remote STT sends the API key as a Bearer header, and none without a key", async () => {
  await withHeaderServer({ text: "hi" }, async (baseUrl, seen) => {
    await transcribe(Buffer.alloc(0), { baseUrl, apiKey: "sk-stt" });
    await transcribe(Buffer.alloc(0), { baseUrl });
    assert.deepStrictEqual(seen.map((s) => s.auth), ["Bearer sk-stt", undefined]);
    assert.match(seen[0].type, /^multipart\/form-data/);
  });
});

test("remote cleanup sends JSON with the API key as a Bearer header, and none without a key", async () => {
  const reply = { choices: [{ message: { content: "Hi." } }] };
  await withHeaderServer(reply, async (baseUrl, seen) => {
    await clean("hi", { baseUrl, apiKey: "sk-clean" });
    await clean("hi", { baseUrl });
    assert.deepStrictEqual(seen.map((s) => s.auth), ["Bearer sk-clean", undefined]);
    assert.deepStrictEqual(seen.map((s) => s.type), ["application/json", "application/json"]);
  });
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
        assert.strictEqual(err.status, 401, "the status rides along for the retry classifier");
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
      assert.strictEqual(err.status, 503);
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
      assert.strictEqual(err.code, "SERVICE_UNREACHABLE", "classified for the pipeline's retry");
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
        assert.strictEqual(err.code, "SERVICE_TIMEOUT");
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
        assert.strictEqual(err.code, "SERVICE_TIMEOUT");
        return true;
      });
    });
  });

  test(`remote ${name}: a reply that isn't JSON says so, without echoing it`, async () => {
    await withErrorServer(200, "<html>secret-token-123</html>", async (baseUrl) => {
      await assert.rejects(call({ baseUrl }), (err) => {
        assert.strictEqual(err.message, `${service} returned a response that isn't JSON`);
        assert.strictEqual(err.code, "SERVICE_BAD_REPLY");
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
        assert.strictEqual(err.code, "SERVICE_DROPPED");
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

test("stripThinking removes reasoning blocks", () => {
  assert.strictEqual(
    stripThinking("<think>hmm, let me see</think>Hello world."),
    "Hello world."
  );
  assert.strictEqual(stripThinking("No tags here."), "No tags here.");
  assert.strictEqual(
    stripThinking("<THINK>a</THINK>\n\n  Result  "),
    "Result"
  );
  assert.strictEqual(stripThinking("<think>unfinished private reasoning"), "");
  assert.strictEqual(
    stripThinking("Answer so far.<think>unfinished private reasoning"),
    "Answer so far."
  );
  // R1-style templates put the opener in the prompt, so the reply starts
  // mid-reasoning and only the closer arrives.
  assert.strictEqual(
    stripThinking("Okay, the user wants me to clean this up.\n</think>\n\nSo this is a test."),
    "So this is a test."
  );
  assert.strictEqual(stripThinking("reasoning only</think>"), "");
  // Reasoning that closes more than once: everything up to the last closer goes,
  // so no reasoning and no stray tag reach the answer.
  assert.strictEqual(stripThinking("first thought</think>\nsecond thought\n</think>\n\nAnswer."), "Answer.");
  // The closer is matched case-insensitively, like the paired rule.
  assert.strictEqual(stripThinking("reasoning</THINK>Answer"), "Answer");
  // A paired block before a lone closer: the order of the rules decides this.
  assert.strictEqual(stripThinking("<think>a</think>more reasoning</think>Answer"), "Answer");
});

test("remote cleanup rejects an answer the server cut off at its token limit", async () => {
  const reply = (finish_reason) =>
    JSON.stringify({ choices: [{ finish_reason, message: { content: "Answer so far." } }] });
  let finish = "length";
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(reply(finish));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "m" };
  try {
    await assert.rejects(() => clean("um hello", cfg), { message: CLEAN_RUNAWAY_MESSAGE });
    finish = "stop";
    assert.strictEqual(await clean("um hello", cfg), "Answer so far.");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/* ---------------- remote model listing ---------------- */

// A one-route JSON server for the remote-listing tests. Each request is
// recorded in `requests` so tests assert on it in their body: an assert that
// throws inside the handler would leave the request unanswered and the file
// alive after the failure.
function serveJson(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const { status, body } = handler(req);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1`, requests });
    });
  });
}

test("listRemoteModels parses OpenAI shape, sorts and de-dupes", async () => {
  const { server, base, requests } = await serveJson(() => ({
    status: 200,
    body: { data: [{ id: "gpt-z" }, { id: "gpt-a" }, { id: "gpt-a" }] },
  }));
  try {
    const models = await listRemoteModels({ baseUrl: base, apiKey: "secret" });
    assert.deepStrictEqual(models, ["gpt-a", "gpt-z"]);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].url, "/v1/models");
    assert.strictEqual(requests[0].headers.authorization, "Bearer secret");
  } finally {
    server.close();
  }
});

test("listRemoteModels accepts a bare array and omits the auth header without a key", async () => {
  const { server, base, requests } = await serveJson(() => ({ status: 200, body: ["b", "a"] }));
  try {
    const models = await listRemoteModels({ baseUrl: base });
    assert.deepStrictEqual(models, ["a", "b"]);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].headers.authorization, undefined);
  } finally {
    server.close();
  }
});

test("listRemoteModels surfaces HTTP errors without the reply or the URL", async () => {
  const { server, base } = await serveJson(() => ({
    status: 401,
    body: { error: { message: "Incorrect API key provided: sk-secret-value" } },
  }));
  try {
    await assert.rejects(
      () => listRemoteModels({ baseUrl: base, apiKey: "sk-client-secret" }),
      (err) => {
        assert.strictEqual(err.message, "Model list service error 401 — check the API key in Settings");
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test("listRemoteModels requires a base URL", async () => {
  await assert.rejects(() => listRemoteModels({}), /Base URL is required/);
});

test("listRemoteModels rejects a non-http(s) base URL", async () => {
  await assert.rejects(
    () => listRemoteModels({ baseUrl: "file:///etc/passwd" }),
    /must use http or https/
  );
});

test("listRemoteModels returns an empty list when the service reports none", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: { data: [] } }));
  try {
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: base }), []);
  } finally {
    server.close();
  }
});

test("listRemoteModels rejects a non-JSON body", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: "not json{" }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /^Error: Model list service returned a response that isn't JSON$/);
  } finally {
    server.close();
  }
});

test("listRemoteModels rejects an unexpected JSON shape", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: { notdata: 1 } }));
  try {
    await assert.rejects(
      () => listRemoteModels({ baseUrl: base }),
      /^Error: Model list service returned an unexpected \/models reply$/
    );
  } finally {
    server.close();
  }
});

test("listRemoteModels strips a trailing slash before appending /models", async () => {
  const { server, base, requests } = await serveJson(() => ({
    status: 200,
    body: { data: [{ id: "m" }] },
  }));
  try {
    // base already ends in /v1; add another slash so serviceUrl has to strip it.
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: `${base}/` }), ["m"]);
    assert.strictEqual(requests[0].url, "/v1/models"); // not /v1//models
  } finally {
    server.close();
  }
});

test("listRemoteModels trims whitespace around the base URL", async () => {
  const { server, base, requests } = await serveJson(() => ({
    status: 200,
    body: { data: [{ id: "m" }] },
  }));
  try {
    // A private joiner once encoded this as /v1%20/models.
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: ` ${base} ` }), ["m"]);
    assert.strictEqual(requests[0].url, "/v1/models");
  } finally {
    server.close();
  }
});

test("listRemoteModels treats a non-string base URL as missing", async () => {
  // A private joiner once threw "b.replace is not a function" here.
  await assert.rejects(() => listRemoteModels({ baseUrl: 123 }), /^Error: Base URL is required$/);
});

test("listRemoteModels names the host it couldn't reach, in plain words", async () => {
  // Port 1 is not listenable, so the fetch rejects at the connection stage.
  await assert.rejects(
    () => listRemoteModels({ baseUrl: "http://127.0.0.1:1/v1" }),
    /^Error: Couldn't reach 127\.0\.0\.1:1$/
  );
});

test("listRemoteModels reports a stalled response body as a timeout", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.write('{"data": [');
    // Never end the response.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await assert.rejects(
      () => listRemoteModels({ baseUrl: base }, { timeoutMs: 50 }),
      /^Error: Model list service didn't answer within 0\.05 s$/
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("listRemoteModels times out when a service never responds", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    await assert.rejects(
      () => listRemoteModels({ baseUrl: base }, { timeoutMs: 20 }),
      /^Error: Model list service didn't answer within 0\.02 s$/
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/* ---------- voice command transform (#344) ---------- */

const { transform: remoteTransform } = require("../main/services/transform");
const { TRANSFORM_TRUNCATED_MESSAGE, TRANSFORM_EMPTY_MESSAGE } = require("../main/util/transform-turn");

const replyWith = (choice) => JSON.stringify({ choices: [choice] });
function withReply(body, run, { status = 200 } = {}) {
  const seen = [];
  return withServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  }, (base) => run(base, seen));
}

test("transform: posts the rules, the delimited selection and its own output cap", async () => {
  await withReply(replyWith({ message: { content: "<think>hmm</think>Shorter." }, finish_reason: "stop" }), async (base, seen) => {
    const text = await remoteTransform(
      { instruction: "shorten it", selection: "A very long sentence indeed." },
      { baseUrl: base, apiKey: "sk-x", model: "m", maxOutputTokens: 300 }
    );
    assert.strictEqual(text, "Shorter.");
    const { url, auth, body } = seen[0];
    assert.strictEqual(url, "/v1/chat/completions");
    assert.strictEqual(auth, "Bearer sk-x");
    assert.strictEqual(body.max_tokens, 300, "the command's budget, not the cleanup ratio");
    assert.strictEqual(body.model, "m");
    assert.match(body.messages[0].content, /ONE instruction/);
    assert.match(body.messages[1].content, /SELECTED TEXT [0-9a-f]{12} BEGIN\nA very long sentence indeed\.\nSELECTED TEXT/);
    assert.match(body.messages[1].content, /Instruction:\nshorten it$/);
  });
});

test("transform: a reply cut off at the token limit is an error, not a partial result", async () => {
  await withReply(replyWith({ message: { content: "Half a rew" }, finish_reason: "length" }), async (base) => {
    await assert.rejects(remoteTransform({ instruction: "x", selection: "y" }, { baseUrl: base, model: "m" }),
      { message: TRANSFORM_TRUNCATED_MESSAGE });
  });
});

test("transform: an empty or reasoning-only reply is an error", async () => {
  for (const content of ["", "   ", "<think>only thoughts</think>"]) {
    await withReply(replyWith({ message: { content }, finish_reason: "stop" }), async (base) => {
      await assert.rejects(remoteTransform({ instruction: "x", selection: "y" }, { baseUrl: base, model: "m" }),
        { message: TRANSFORM_EMPTY_MESSAGE });
    });
  }
  await withReply(replyWith({ message: {}, finish_reason: "stop" }), async (base) => {
    await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: base, model: "m" }), /no message content/);
  });
});

test("transform: transport failures use the shared plain-language errors", async () => {
  await withReply("{}", async (base) => {
    await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: base, model: "m", apiKey: "bad" }),
      (err) => err.status === 401 && /Command service error 401 — check the API key in Settings/.test(err.message));
  }, { status: 401 });
  await withServer(() => { /* never answers */ }, async (base) => {
    await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: base, model: "m", timeoutMs: 100 }),
      (err) => err.code === "SERVICE_TIMEOUT" && /Command service didn't answer/.test(err.message));
  });
  await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: "http://127.0.0.1:1/v1", model: "m" }),
    (err) => err.code === "SERVICE_UNREACHABLE");
});

test("transform: a caller's cancel is an AbortError, not a failure to describe", async () => {
  await withServer(() => { /* never answers */ }, async (base) => {
    const controller = new AbortController();
    const pending = remoteTransform({ instruction: "x" }, { baseUrl: base, model: "m" }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (err) => err.name === "AbortError");
  });
});

test("transform: an unset service is explained, and never falls back to another endpoint", async () => {
  await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: "", model: "" }), /isn't set up: add its URL and model in Settings → Commands/);
  await assert.rejects(remoteTransform({ instruction: "x" }, { baseUrl: "http://127.0.0.1:1/v1", model: "" }), /isn't set up/);
});
