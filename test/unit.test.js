// Unit tests for the pure (non-Electron) parts of the main process.
// Run with: npm test

const { test } = require("node:test");
const assert = require("node:assert");

const http = require("node:http");

const { encodeWav, encodeSilenceWav, wavToFloat32 } = require("../main/util/wav");
const { stripThinking } = require("../main/services/cleanup");
const { deepMerge, migrateLegacy, DEFAULTS } = require("../main/settings");
const { listRemoteModels } = require("../main/services/models-remote");

test("encodeWav produces a valid RIFF header", () => {
  const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWav(samples, 16000);
  assert.strictEqual(wav.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(wav.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(wav.readUInt32LE(24), 16000); // sample rate
  assert.strictEqual(wav.readUInt16LE(22), 1); // mono
  assert.strictEqual(wav.readUInt32LE(40), samples.length * 2); // data size
  assert.strictEqual(wav.length, 44 + samples.length * 2);
  assert.strictEqual(wav.readInt16LE(44 + 2), 1000);
});

test("encodeSilenceWav has the requested duration", () => {
  const wav = encodeSilenceWav(0.5);
  assert.strictEqual(wav.readUInt32LE(40), 16000 * 0.5 * 2);
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
});

test("deepMerge keeps defaults for missing keys and overrides present ones", () => {
  const base = { a: 1, nested: { x: "default", y: 2 }, arr: [1, 2] };
  const override = { nested: { x: "custom" }, arr: [3] };
  const merged = deepMerge(base, override);
  assert.deepStrictEqual(merged, {
    a: 1,
    nested: { x: "custom", y: 2 },
    arr: [3],
  });
});

test("deepMerge ignores null/undefined overrides", () => {
  assert.deepStrictEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});

test("wavToFloat32 round-trips PCM16 samples to [-1, 1]", () => {
  const wav = encodeWav(new Int16Array([0, 16384, -16384, 32767, -32768]));
  const { samples, sampleRate } = wavToFloat32(wav);
  assert.strictEqual(sampleRate, 16000);
  assert.strictEqual(samples.length, 5);
  assert.strictEqual(samples[0], 0);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-4);
  assert.ok(samples[3] <= 1 && samples[3] > 0.99);
  assert.strictEqual(samples[4], -1);
});

test("wavToFloat32 rejects non-WAV input", () => {
  assert.throws(() => wavToFloat32(Buffer.from("not a wav at all!!")));
});

test("migrateLegacy maps pre-engine settings onto external engines", () => {
  // The old local autostart server has been removed; a config that used it
  // folds into "remote" and the stale sttServer key is dropped.
  const autostart = migrateLegacy({
    stt: { baseUrl: "http://x" },
    cleanup: { enabled: true },
    sttServer: { autoStart: true },
  });
  assert.strictEqual(autostart.stt.engine, "remote");
  assert.strictEqual(autostart.cleanup.engine, "remote");
  assert.ok(!("sttServer" in autostart));

  // No engine field -> "remote".
  const remote = migrateLegacy({ stt: {}, cleanup: {}, sttServer: {} });
  assert.strictEqual(remote.stt.engine, "remote");
  assert.ok(!("sttServer" in remote));

  // A config already carrying the removed "server" engine is rewritten too.
  const legacyServer = migrateLegacy({ stt: { engine: "server" }, cleanup: {} });
  assert.strictEqual(legacyServer.stt.engine, "remote");
});

test("migrateLegacy leaves fresh and already-migrated configs untouched", () => {
  assert.deepStrictEqual(migrateLegacy({}), {}); // fresh install
  const modern = { stt: { engine: "builtin" }, cleanup: { engine: "builtin" } };
  assert.deepStrictEqual(migrateLegacy(modern), modern);
});

test("new installs default to in-process engines", () => {
  assert.strictEqual(DEFAULTS.stt.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.engine, "builtin");
  assert.strictEqual(DEFAULTS.cleanup.enabled, true);
  assert.ok(DEFAULTS.stt.builtin.model);
  assert.ok(DEFAULTS.cleanup.builtin.model);
});

/* ---------------- remote model listing ---------------- */

function serveJson(handler) {
  const server = http.createServer((req, res) => {
    const { status, body } = handler(req);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

test("listRemoteModels parses OpenAI shape, sorts and de-dupes", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.url, "/v1/models");
    assert.strictEqual(req.headers.authorization, "Bearer secret");
    return {
      status: 200,
      body: { data: [{ id: "gpt-z" }, { id: "gpt-a" }, { id: "gpt-a" }] },
    };
  });
  try {
    const models = await listRemoteModels({ baseUrl: base, apiKey: "secret" });
    assert.deepStrictEqual(models, ["gpt-a", "gpt-z"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels accepts a bare array and omits the auth header without a key", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.headers.authorization, undefined);
    return { status: 200, body: ["b", "a"] };
  });
  try {
    const models = await listRemoteModels({ baseUrl: base });
    assert.deepStrictEqual(models, ["a", "b"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels surfaces HTTP errors", async () => {
  const { server, base } = await serveJson(() => ({ status: 401, body: { error: "nope" } }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /HTTP 401/);
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
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /did not return JSON/);
  } finally {
    server.close();
  }
});

test("listRemoteModels rejects an unexpected JSON shape", async () => {
  const { server, base } = await serveJson(() => ({ status: 200, body: { notdata: 1 } }));
  try {
    await assert.rejects(() => listRemoteModels({ baseUrl: base }), /Unexpected/);
  } finally {
    server.close();
  }
});

test("listRemoteModels strips a trailing slash before appending /models", async () => {
  const { server, base } = await serveJson((req) => {
    assert.strictEqual(req.url, "/v1/models"); // not /v1//models
    return { status: 200, body: { data: [{ id: "m" }] } };
  });
  try {
    // base already ends in /v1; add another slash so joinUrl has to strip it.
    assert.deepStrictEqual(await listRemoteModels({ baseUrl: `${base}/` }), ["m"]);
  } finally {
    server.close();
  }
});

test("listRemoteModels wraps a network failure with the URL", async () => {
  // Port 1 is not listenable, so the fetch rejects at the connection stage.
  await assert.rejects(
    () => listRemoteModels({ baseUrl: "http://127.0.0.1:1/v1" }),
    /Could not reach/
  );
});

test("idle model unload defaults to a finite window and is overridable", () => {
  // Sensible default: unload after a couple of idle minutes.
  assert.strictEqual(DEFAULTS.engines.idleUnloadMinutes, 2);
  // A stored 0 (never unload) must survive the merge, not be reset to default.
  const never = deepMerge(DEFAULTS, { engines: { idleUnloadMinutes: 0 } });
  assert.strictEqual(never.engines.idleUnloadMinutes, 0);
  // A stored custom window survives too.
  const custom = deepMerge(DEFAULTS, { engines: { idleUnloadMinutes: 10 } });
  assert.strictEqual(custom.engines.idleUnloadMinutes, 10);
});
