// List the models an OpenAI-compatible service offers, via `GET {baseUrl}/models`.
// Works with OpenAI, Ollama, llama.cpp, LM Studio, vLLM, OpenRouter, etc. Used
// by Settings so the user can pick a model from a list instead of typing its id.

const { serviceUrl, authHeaders, HTTP_TIMEOUT_MS } = require("./service-url");
const { requestJson } = require("./transport-error");

const SERVICE = "Model list service";

/**
 * Fetch available model ids from an OpenAI-compatible endpoint.
 * @param {{ baseUrl: string, apiKey?: string }} cfg
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts]
 * @returns {Promise<string[]>} sorted, de-duplicated model ids
 */
async function listRemoteModels(cfg, { signal, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  // The base URL is user-supplied and reaches here from the renderer;
  // serviceUrl accepts only http(s), so fetch never reads the local filesystem
  // or a non-network resource. Failures read like the STT and cleanup clients'.
  const url = serviceUrl(cfg?.baseUrl, "/models");
  const body = await requestJson(url, { headers: authHeaders(cfg.apiKey) }, { service: SERVICE, timeoutMs, signal });

  // OpenAI shape: { data: [{ id }, ...] }. Some servers return a bare array.
  const list = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(list)) {
    throw new Error(`${SERVICE} returned an unexpected /models reply`);
  }
  const ids = list
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter((id) => typeof id === "string" && id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

module.exports = { listRemoteModels };
