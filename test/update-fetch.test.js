const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { fetchUpdateText } = require("../main/services/update-fetch");

test("update metadata fetch times out when the server never responds", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/latest-linux.yml`;
  try {
    await assert.rejects(
      () => fetchUpdateText(url, { timeoutMs: 20 }),
      /Update server timed out/
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("local file update feeds remain supported", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earheart-feed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "latest.yml");
  fs.writeFileSync(file, "version: 1.2.3\n");
  assert.strictEqual(
    await fetchUpdateText(pathToFileURL(file).href),
    "version: 1.2.3\n"
  );
});

test("update metadata fetch times out when the body stalls after headers", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("version: 1.2");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/latest-linux.yml`;
  try {
    await assert.rejects(
      () => fetchUpdateText(url, { timeoutMs: 50 }),
      /Update server timed out/
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

const respond = (status, body = "") => async () => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => body,
});

test("update metadata fetch returns the body of a successful response", async () => {
  assert.strictEqual(
    await fetchUpdateText("https://example.test/latest.yml", {
      fetchImpl: respond(200, "version: 1.2.3\n"),
    }),
    "version: 1.2.3\n"
  );
});

test("update metadata fetch reports a missing feed", async () => {
  await assert.rejects(
    () => fetchUpdateText("https://example.test/latest.yml", { fetchImpl: respond(404) }),
    /^Error: No release feed found$/
  );
});

test("update metadata fetch reports other HTTP failures verbatim", async () => {
  await assert.rejects(
    () => fetchUpdateText("https://example.test/latest.yml", { fetchImpl: respond(503) }),
    /^Error: Update server returned HTTP 503$/
  );
});

test("update metadata fetch wraps transport failures", async () => {
  await assert.rejects(
    () =>
      fetchUpdateText("https://example.test/latest.yml", {
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    /^Error: Could not reach the update server: fetch failed$/
  );
});
