// Fetch updater metadata with a finite deadline. Kept separate from the
// updater state machine so the network and file-feed paths are unit-testable.

const fsp = require("node:fs/promises");
const { fileURLToPath } = require("node:url");

const DEFAULT_TIMEOUT_MS = 15000;

/** Fetch a URL as text; supports file:// so local update feeds keep working. */
async function fetchUpdateText(
  url,
  { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}
) {
  if (url.startsWith("file://")) {
    return fsp.readFile(fileURLToPath(url), "utf8");
  }
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "text/plain, */*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) throw new Error("No release feed found");
    if (!res.ok) throw new Error(`Update server returned HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error("Update server timed out");
    }
    if (/^(No release feed|Update server returned)/.test(err.message)) throw err;
    throw new Error(`Could not reach the update server: ${err.message}`);
  }
}

module.exports = { fetchUpdateText };
