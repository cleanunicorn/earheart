// User-facing text for an error, formatted in the UI language where it is shown
// (#349). Only a stable key and allowlisted scalar parameters ever reach the
// formatter: an error that carries `i18n: { key, params }` (transport-error.js)
// is translated; anything else — an arbitrary exception, a native error, a
// response body quoted in a message — gets the generic text. The raw message is
// for the log, never for interpolation.

const { t } = require("./i18n");

const KEYS = new Set([
  "error.serviceTimeout",
  "error.serviceUnreachable",
  "error.serviceBadReply",
  "error.serviceDropped",
  "error.serviceAuth",
  "error.serviceStatus",
]);

function describeError(err) {
  const i18n = err?.i18n;
  if (i18n && KEYS.has(i18n.key)) {
    const params = {};
    for (const [name, value] of Object.entries(i18n.params || {})) {
      if (typeof value === "string" || typeof value === "number") params[name] = String(value).slice(0, 80);
    }
    return t(i18n.key, params);
  }
  return t("error.generic");
}

module.exports = { describeError };
