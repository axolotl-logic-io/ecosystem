// @ts-check
// A session that fails with a transport error (a connection reset or
// refusal, a timeout reading from the provider, ECONNRESET, ETIMEDOUT,
// EAI_AGAIN or a socket hang-up, alone or in a provider's `api_error`, in any
// letter case) defers its issue as a rate limit does (`rate-limit-defers`,
// #385), run as real stage jobs through rate-limit-test-kit.mjs: released at
// its stage with no stop, and job.json's outcome rate-limited for the
// orchestrator's backoff. A provider's other `api_error`s and the session's
// own timeout still stop, with the full error in the stop request.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedSessionJob,
  requestsOf,
  SERVER_ERROR,
  SOCKET_RESET,
  TIMED_OUT,
} from "./rate-limit-test-kit.mjs";

const RATE_LIMITED = { kind: "finished", end: "deferred", rateLimited: true };

// The transport failures that defer, each named for its test, with the
// stage whose session meets it.
/** @type {readonly (readonly [string, "author" | "implement", { ok: boolean, error: string }])[]} */
const TRANSPORT_FAILURES = [["ECONNRESET", "implement", SOCKET_RESET]];

for (const [name, stage, failure] of TRANSPORT_FAILURES) {
  test(`an ${stage} session that fails with ${name} leaves the issue at ${stage}, rate-limited, with no stop`, () => {
    const { place, line, ops, outcome } = failedSessionJob(stage, failure);
    assert.equal(ops.includes("stop"), false);
    assert.equal(line.end, "deferred");
    const [release] = requestsOf(place, "release");
    assert.equal(release.state.stage, stage);
    assert.deepEqual(release.state.counts, { conflictFixes: 0, syncs: 0 });
    assert.deepEqual(outcome, RATE_LIMITED);
  });
}

// The failures that stop, with the stage whose session meets it and the
// stop's reason.
/** @type {readonly (readonly [string, "author" | "implement", { ok: boolean, error: string }, string])[]} */
const STOPPING_FAILURES = [
  [
    "another api_error",
    "implement",
    SERVER_ERROR,
    `the developer's session failed: ${SERVER_ERROR.error}`,
  ],
  [
    "the session's own timeout",
    "author",
    TIMED_OUT,
    `the author's session failed: ${TIMED_OUT.error}`,
  ],
];

for (const [name, stage, failure, reason] of STOPPING_FAILURES) {
  test(`an ${stage} session that fails with ${name} still stops, with the full error in the stop request`, () => {
    const { place, line, ops, outcome } = failedSessionJob(stage, failure);
    assert.equal(line.end, "stop");
    const [stop] = requestsOf(place, "stop");
    assert.deepEqual([stop.code, stop.reason], ["error", reason]);
    assert.equal(ops.includes("release"), false);
    assert.equal(outcome.rateLimited, false);
  });
}
