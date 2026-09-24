// Error responses may echo credentials or user text. Keep only a short,
// structured message and redact common credential forms.
function serviceErrorSummary(body) {
  let message;
  try {
    const candidate = JSON.parse(body)?.error?.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    return "";
  }
  if (!message) return "";
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted API key]")
    .slice(0, 200);
}

module.exports = { serviceErrorSummary };
