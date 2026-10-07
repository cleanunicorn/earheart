// Plain copy for a remote service that never answered. fetch() reports these as
// "fetch failed" or "The operation was aborted due to timeout", which reach the
// overlay, the notification and the Settings Test result verbatim. The
// original error rides along as `cause`, so the log keeps the technical detail.

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
    return new Error(`${service} didn't answer within ${timeoutS} s`, { cause: err });
  }
  return new Error(`Couldn't reach ${new URL(url).host}`, { cause: err });
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
      throw new Error(`${opts.service} returned a response that isn't JSON`);
    }
    throw new Error(`${opts.service} dropped the connection before finishing its reply`, { cause: err });
  }
}

// Unauthorized and forbidden almost always mean the key, so say where it lives.
function statusError(service, status) {
  const hint = status === 401 || status === 403 ? " — check the API key in Settings" : "";
  return new Error(`${service} error ${status}${hint}`);
}

module.exports = { transportError, statusError, readJson };
