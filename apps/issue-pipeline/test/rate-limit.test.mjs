// Which session errors count as a model provider's rate limit or overload,
// and which as a transient provider error (a rate limit or a transport
// error), which a stage defers on instead of stopping (`rate-limit-defers`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRateLimitError,
  isTransientSessionError,
} from "../src/workflow/stages/rate-limit.ts";

const RATE_LIMITED = [
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}',
  '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  "HTTP 429: Too Many Requests",
  "request failed with status 529",
  "All credentials for model claude-opus-5-5 are cooling down",
];

const NOT_RATE_LIMITED = [
  "the session timed out",
  "the session gave no structured output",
  "gh exited 1: HTTP 503: Service Unavailable",
  "1429 tests passed, 3 failed",
  "",
  null,
];

// Transport errors, in any letter case, alone or inside a provider's
// `api_error` (#369's implementer failed with the first).
const TRANSPORT = [
  '{"type":"error","error":{"type":"api_error","message":"read tcp 10.0.0.5:51234->1.2.3.4:443: read: connection reset by peer"}}',
  "api_error: read tcp 10.0.0.5:51234->1.2.3.4:443: read: Connection Reset by peer",
  "dial tcp 1.2.3.4:443: connect: connection refused",
  "CONNECTION REFUSED",
  "api_error: timeout reading from the provider",
  "Timed out reading the provider's response",
  "Error: read ECONNRESET",
  "connect ETIMEDOUT 1.2.3.4:443",
  "getaddrinfo EAI_AGAIN api.anthropic.com",
  "Error: socket hang up",
];

// Errors that aren't transient: a provider's other `api_error`s, the
// session's own timeout and the pipeline's own waits.
const NOT_TRANSIENT = [
  '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
  "api_error",
  "the session timed out",
  "timed out waiting for the clone lock",
  "the session gave no structured output",
  "1429 tests passed, 3 failed",
  "",
  null,
];

test("rate limits and overloads are rate-limit errors", () => {
  for (const text of RATE_LIMITED) {
    assert.equal(isRateLimitError(text), true, text);
  }
});

test("other session errors, and no error, are not", () => {
  for (const text of NOT_RATE_LIMITED) {
    assert.equal(isRateLimitError(text), false, String(text));
  }
});

test("rate limits, overloads and transport errors in any case are transient", () => {
  for (const text of [...RATE_LIMITED, ...TRANSPORT]) {
    assert.equal(isTransientSessionError(text), true, text);
  }
});

test("other api errors, timeouts that aren't reads, and no error, are not transient", () => {
  for (const text of NOT_TRANSIENT) {
    assert.equal(isTransientSessionError(text), false, String(text));
  }
});
