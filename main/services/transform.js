// Voice-command transform client (#344). Speaks the OpenAI-compatible chat
// completions contract like cleanup.js and shares its transport and error
// handling (requestJson / transport-error). It only ever talks to the service
// the user configured under Settings → Commands: there is no fallback to the
// cleanup or STT endpoints, because the selected text it sends is private.
//
// Unlike cleanup, a reply cut off at the token limit is a failure and so is an
// empty one: half a rewrite pasted over a selection is worse than none.

const { serviceUrl, authHeaders } = require("./service-url");
const { requestJson } = require("./transport-error");
const { stripThinking } = require("./cleanup");
const {
  transformMessages,
  transformMaxTokens,
  TRANSFORM_TEMPERATURE,
  TRANSFORM_TRUNCATED_MESSAGE,
  TRANSFORM_EMPTY_MESSAGE,
} = require("../util/transform-turn");

/**
 * @param {{instruction: string, selection?: string}} request
 * @param {object} cfg - settings.commands slice (remote fields)
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} the transformed text
 */
async function transform({ instruction, selection = "" }, cfg, signal) {
  if (!cfg?.baseUrl || !cfg?.model) {
    throw new Error("The command service isn't set up: add its URL and model in Settings → Commands");
  }
  const url = serviceUrl(cfg.baseUrl, "/chat/completions");
  const { system, user } = transformMessages({ instruction, selection });
  const data = await requestJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg.apiKey) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: TRANSFORM_TEMPERATURE,
        max_tokens: transformMaxTokens(cfg.maxOutputTokens),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    { service: "Command service", timeoutMs: cfg.timeoutMs || 120000, signal }
  );
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error(TRANSFORM_TRUNCATED_MESSAGE);
  const content = choice?.message?.content;
  if (typeof content !== "string") throw new Error("Command service returned no message content");
  const text = stripThinking(content);
  if (text.length === 0) throw new Error(TRANSFORM_EMPTY_MESSAGE);
  return text;
}

module.exports = { transform };
