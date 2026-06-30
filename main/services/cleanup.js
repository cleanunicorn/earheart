// Transcript cleanup client. Speaks the OpenAI-compatible chat completions
// contract (`POST {baseUrl}/chat/completions`), so it works with Ollama,
// llama.cpp, LM Studio, vLLM, OpenRouter, OpenAI, or anything else compatible.

const { resolveCleanup, remoteSamplingBody } = require("../cleanup-styles");

function joinUrl(baseUrl, route) {
  return baseUrl.replace(/\/+$/, "") + route;
}

// Reasoning models may emit <think>...</think> blocks; strip them.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * @param {string} transcript - raw transcription text
 * @param {object} cfg - settings.cleanup slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} cleaned text
 */
async function clean(transcript, cfg, signal) {
  const url = joinUrl(cfg.baseUrl, "/chat/completions");
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  // The selected style supplies the system prompt (base + its directive) and
  // the sampling profile; remoteSamplingBody emits only the portable fields.
  const { systemPrompt, sampling } = resolveCleanup(cfg);

  const timeout = AbortSignal.timeout(cfg.timeoutMs || 60000);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      ...remoteSamplingBody(sampling),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cleanup service error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Cleanup service returned no message content");
  }
  const cleaned = stripThinking(content);
  // An empty cleanup result should never eat the user's words.
  return cleaned.length > 0 ? cleaned : transcript;
}

module.exports = { clean, stripThinking };
