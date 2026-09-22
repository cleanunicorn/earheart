// Shared numeric settings validation. Invalid input falls back; finite input is
// rounded and clamped so renderer values stay within the settings contract.

function clampNumber(value, min, max, fallback) {
  if (value === "" || value == null || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { clampNumber };
}
