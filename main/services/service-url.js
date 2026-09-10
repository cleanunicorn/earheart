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
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must use http or https, got ${parsed.protocol}`);
  }
  return base.replace(/\/+$/, "") + route;
}

module.exports = { serviceUrl };
