// Validate a user-supplied OpenAI-compatible service base before appending an
// endpoint. Keep the base path (for example `/v1`) rather than using URL
// resolution, which would replace it when the endpoint starts with a slash.
function serviceUrl(baseUrl, route) {
  const base = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!base) throw new Error("Base URL is required");

  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    // Echo what the user typed so a typo is visible, but not a query or
    // fragment: some providers take the API key there.
    throw new Error(`Invalid base URL: ${base.replace(/[?#][\s\S]*$/, "")}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must use http or https, got ${parsed.protocol}`);
  }
  return base.replace(/\/+$/, "") + route;
}

// Default deadline for a short metadata request (a model list, an update feed).
// Transcription and cleanup take their own, longer, per-service timeout.
const HTTP_TIMEOUT_MS = 15000;

// The Bearer header OpenAI-compatible services expect, or none without a key,
// so a keyless local server never sees an empty `Authorization`.
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

module.exports = { serviceUrl, authHeaders, HTTP_TIMEOUT_MS };
