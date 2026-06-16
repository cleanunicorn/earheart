// List the models an OpenAI-compatible service offers, via `GET {baseUrl}/models`.
// Works with OpenAI, Ollama, llama.cpp, LM Studio, vLLM, OpenRouter, etc. Used
// by Settings so the user can pick a model from a list instead of typing its id.

function joinUrl(baseUrl, route) {
  return baseUrl.replace(/\/+$/, "") + route;
}

/**
 * Fetch available model ids from an OpenAI-compatible endpoint.
 * @param {{ baseUrl: string, apiKey?: string }} cfg
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string[]>} sorted, de-duplicated model ids
 */
async function listRemoteModels(cfg, { signal } = {}) {
  if (!cfg || !cfg.baseUrl) throw new Error("Base URL is required");
  const url = joinUrl(cfg.baseUrl, "/models");
  // Only fetch over HTTP(S). The base URL is user-supplied and reaches here
  // from the renderer, so reject file:/other schemes rather than letting fetch
  // read the local filesystem or a non-network resource.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid base URL: ${cfg.baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Base URL must use http or https, got ${parsed.protocol}`);
  }
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let res;
  try {
    res = await fetch(url, { headers, signal });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${url} did not return JSON`);
  }

  // OpenAI shape: { data: [{ id }, ...] }. Some servers return a bare array.
  const list = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(list)) {
    throw new Error(`Unexpected /models response from ${url}`);
  }
  const ids = list
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter((id) => typeof id === "string" && id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

module.exports = { listRemoteModels };
