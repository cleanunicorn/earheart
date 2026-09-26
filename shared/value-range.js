// Shared numeric settings validation. Invalid input falls back; finite input is
// clamped and optionally rounded so UI and persisted values stay in range.

function clampNumber(value, min, max, fallback, round = true) {
  if (value === "" || value == null || (typeof value === "string" && !value.trim())) {
    return clampFallback(min, max, fallback, round);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clampFallback(min, max, fallback, round);
  const bounded = Math.min(max, Math.max(min, parsed));
  return round ? Math.round(bounded) : bounded;
}

function clampFallback(min, max, fallback, round) {
  if (typeof fallback !== "number" || !Number.isFinite(fallback)) return min;
  const bounded = Math.min(max, Math.max(min, fallback));
  return round ? Math.round(bounded) : bounded;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { clampNumber };
}
