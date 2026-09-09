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
