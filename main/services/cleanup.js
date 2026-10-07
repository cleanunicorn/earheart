// Transcript cleanup client. Speaks the OpenAI-compatible chat completions
// contract (`POST {baseUrl}/chat/completions`), so it works with Ollama,
// llama.cpp, LM Studio, vLLM, OpenRouter, OpenAI, or anything else compatible.

const { resolveCleanup, remoteSamplingBody } = require("../cleanup-styles");
const { CLEAN_RUNAWAY_MESSAGE } = require("../util/clean-budget");
const { serviceUrl } = require("./service-url");
const { transportError, statusError, readJson } = require("./transport-error");

// Reasoning models may emit <think>...</think> blocks; strip them.
function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // A response can hit its token/time limit before the closing tag. Treat
    // everything after an unmatched opener as reasoning too; clean() will
    // reject it when that leaves no answer; the pipeline preserves raw text.
    .replace(/<think>[\s\S]*$/i, "")
    // R1-style chat templates put the opener in the prompt, so the reply starts
    // mid-reasoning and only the closer arrives — sometimes more than once.
    // Everything up to the last closer is reasoning. Runs last, so a closer that
    // a paired block already consumed can't take an answer with it.
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();
}

/**
 * @param {string} transcript - raw transcription text
 * @param {object} cfg - settings.cleanup slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} cleaned text
 */
async function clean(transcript, cfg, signal) {
  const url = serviceUrl(cfg?.baseUrl, "/chat/completions");
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  // The selected style supplies the system prompt (base + its directive) and
  // the sampling profile; remoteSamplingBody emits only the portable fields.
  const { systemPrompt, sampling } = resolveCleanup(cfg);

  const timeoutMs = cfg.timeoutMs || 60000;
  const failure = { service: "Cleanup service", timeoutS: timeoutMs / 1000 };
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, {
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
  } catch (err) {
    throw transportError(err, url, failure);
  }
  if (!res.ok) throw statusError("Cleanup service", res.status);
  const data = await readJson(res, url, failure);
  const choice = data.choices?.[0];
  // The server cut the answer off at its token limit. A half-cleaned
  // transcript is not a cleanup result; throwing sends the pipeline down the
  // same raw-transcript fallback the in-process engine uses for a runaway.
  if (choice?.finish_reason === "length") throw new Error(CLEAN_RUNAWAY_MESSAGE);
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Cleanup service returned no message content");
  }
  const cleaned = stripThinking(content);
  if (cleaned.length === 0) throw new Error("Cleanup returned no usable text");
  return cleaned;
}

module.exports = { clean, stripThinking };
