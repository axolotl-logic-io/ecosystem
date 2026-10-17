// Which session errors count as a model provider's rate limit or overload,
// which a stage defers on instead of stopping (`rate-limit-defers`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isRateLimitError } from "../src/workflow/stages/rate-limit.ts";

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
