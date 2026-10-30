// Which failures are transient: a model provider's rate limit or overload
// (an HTTP 429 or 529 reply, a `rate_limit_error` or `overloaded_error`, or
// credentials "cooling down"), a transport error reaching it (a connection
// reset or refusal, a timeout reading from it, ECONNRESET, ECONNREFUSED,
// ETIMEDOUT, EAI_AGAIN or a socket hang-up, alone or inside an `api_error`),
// and a network failure of an op's gh or git (a DNS failure, a refused, reset
// or timed-out connection, or an HTTP 502, 503 or 504 gateway error). A stage
// defers on such a failure instead of stopping: nothing is counted, and the
// orchestrator runs the issue's next job after its backoff.

// The status at the start of the error, as pi gives a provider's reply
// ("429 {…}"), or after HTTP or status; a 429 elsewhere, such as in a test
// count, isn't one.
const RATE_LIMIT =
  /^(?:HTTP )?[45]29\b|\b(?:HTTP|status)[ :]+[45]29\b|rate_limit_error|overloaded_error|cooling down/iu;

// A transport failure between the session and its provider, in any letter
// case. The pipeline's own session timeout ("the session timed out") and
// other timeouts that aren't reads don't count.
const TRANSPORT_ERROR =
  /\bconnection (?:reset|refused)\b|\b(?:timed out|timeout) (?:while )?reading\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bsocket hang up\b/iu;

// Whether a session's error text, if any, reports a rate limit or overload.
function isRateLimitError(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return RATE_LIMIT.test(text);
}

// Whether a session's error text, if any, reports a transient provider
// failure: a rate limit or overload, or a transport error (#385).
function isTransientSessionError(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return isRateLimitError(text) || TRANSPORT_ERROR.test(text);
}

export { isRateLimitError, isTransientSessionError };
