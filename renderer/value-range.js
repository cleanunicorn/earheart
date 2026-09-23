// Shared numeric settings validation. Invalid input falls back; finite input is
// rounded and clamped so renderer values stay within the settings contract.

function clampNumber(value, min, max, fallback) {
  if (value === "" || value == null || (typeof value === "string" && !value.trim())) {
    return clampFallback(min, max, fallback);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clampFallback(min, max, fallback);
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

function clampFallback(min, max, fallback) {
  if (typeof fallback !== "number" || !Number.isFinite(fallback)) return min;
  const parsed = fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { clampNumber };
}
