// Speech-to-text client. Speaks the OpenAI-compatible audio transcription
// contract (`POST {baseUrl}/audio/transcriptions`, multipart form data), so it
// works against the bundled Parakeet server, OpenAI, Groq, speaches, or any
// other compatible service — switching is just a base URL change.

function joinUrl(baseUrl, route) {
  return baseUrl.replace(/\/+$/, "") + route;
}

/**
 * @param {Buffer|ArrayBuffer} wav - WAV audio (16 kHz mono PCM16 expected)
 * @param {object} cfg - settings.stt slice
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} transcribed text
 */
async function transcribe(wav, cfg, signal) {
  const url = joinUrl(cfg.baseUrl, "/audio/transcriptions");
  const form = new FormData();
  const bytes = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "audio.wav");
  if (cfg.model) form.append("model", cfg.model);
  if (cfg.language) form.append("language", cfg.language);
  form.append("response_format", "json");

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const timeout = AbortSignal.timeout(cfg.timeoutMs || 120000);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`STT service error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (typeof data.text !== "string") {
    throw new Error("STT service returned no `text` field");
  }
  return data.text.trim();
}

module.exports = { transcribe };
