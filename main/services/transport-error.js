// Plain copy for a remote service that never answered. fetch() reports these as
// "fetch failed" or "The operation was aborted due to timeout", which reach the
// overlay, the notification and the Settings Test result verbatim. The
// original error rides along as `cause`, so the log keeps the technical detail.
//
// Used by every client of a user-configured OpenAI-compatible service: stt.js,
// cleanup.js and models-remote.js. hf-models.js and update-fetch.js keep their
// own wrapping on purpose: they take an injected fetch and talk to fixed hosts
// (Hugging Face, the update feed, file:// in tests), not a service the user set up.

// Each failure carries a `code` (or, for an HTTP error, its `status`) so the
// pipeline can tell a passing failure it should retry (util/retry.js) from one
// a retry would only repeat; the message stays the user-facing copy.
function coded(err, code) {
  err.code = code;
  return err;
}

/**
 * @param {Error} err - what fetch() or the body read threw
 * @param {string} url - the request URL (its host names the unreachable server)
 * @param {{service: string, timeoutS: number}} opts
 * @returns {Error} the error to throw
 */
function transportError(err, url, { service, timeoutS }) {
  // The caller cancelled: that is not a failure to describe, and the pipeline
  // tells a cancel apart by its name.
  if (err?.name === "AbortError") return err;
  if (err?.name === "TimeoutError") {
    return coded(new Error(`${service} didn't answer within ${timeoutS} s`, { cause: err }), "SERVICE_TIMEOUT");
  }
  return coded(new Error(`Couldn't reach ${new URL(url).host}`, { cause: err }), "SERVICE_UNREACHABLE");
}

// The deadline covers the body too: a server that sends headers and then stalls
// is a timeout, not a malformed reply. A JSON parse failure (SyntaxError) means
// the reply wasn't JSON; its error is not kept as the cause, because its
// message quotes the start of the body, and providers echo keys and dictated
// text there. Anything else (undici's "terminated") is the connection dropping
// mid-reply.
async function readJson(res, url, opts) {
  try {
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      throw transportError(err, url, opts);
    }
    if (err?.name === "SyntaxError") {
      throw coded(new Error(`${opts.service} returned a response that isn't JSON`), "SERVICE_BAD_REPLY");
    }
    throw coded(
      new Error(`${opts.service} dropped the connection before finishing its reply`, { cause: err }),
      "SERVICE_DROPPED"
    );
  }
}

// Unauthorized and forbidden almost always mean the key, so say where it lives.
function statusError(service, status) {
  const hint = status === 401 || status === 403 ? " — check the API key in Settings" : "";
  return Object.assign(new Error(`${service} error ${status}${hint}`), { status });
}

/**
 * One request to an OpenAI-compatible service, with its deadline covering the
 * reply's body too, and every failure in the plain copy above.
 * @param {string} url
 * @param {RequestInit} init - method, headers, body (no signal)
 * @param {{service: string, timeoutMs: number, signal?: AbortSignal}} opts
 * @returns {Promise<any>} the parsed JSON reply
 */
async function requestJson(url, init, { service, timeoutMs, signal }) {
  const failure = { service, timeoutS: timeoutMs / 1000 };
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    throw transportError(err, url, failure);
  }
  if (!res.ok) throw statusError(service, res.status);
  return readJson(res, url, failure);
}

module.exports = { transportError, statusError, readJson, requestJson };
