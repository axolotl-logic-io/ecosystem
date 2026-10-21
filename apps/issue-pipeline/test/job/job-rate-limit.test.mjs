// @ts-check
// A stage job whose session hits a model provider's rate limit or overload
// (`rate-limit-defers`) ends finished, deferred, with `rateLimited` in
// job.json's outcome, which the orchestrator backs off on, and stops
// nothing: the author and the implementor alike release the issue at their
// stage, the implementor's counts unchanged. An op's own network failure
// defers too, but isn't a rate limit, so it sets no backoff.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COOLING_DOWN,
  failedPostJob,
  failedSessionJob,
  OVERLOADED,
  requestsOf,
} from "./rate-limit-test-kit.mjs";

const RATE_LIMITED = { kind: "finished", end: "deferred", rateLimited: true };
const NETWORK = "error connecting to api.github.com";

/** @type {readonly ["author" | "implement", string, { ok: boolean, error: string }][]} */
const RATE_LIMITS = [
  ["author", "the rate limit", COOLING_DOWN],
  ["author", "an overload", OVERLOADED],
  ["implement", "the rate limit", COOLING_DOWN],
  ["implement", "an overload", OVERLOADED],
];

for (const [stage, name, failure] of RATE_LIMITS) {
  test(`an ${stage} job whose session hits ${name} defers, rate-limited, released at ${stage} with no stop`, () => {
    const { place, line, ops, outcome } = failedSessionJob(stage, failure);
    assert.deepEqual(line, {
      issue: 7,
      stage,
      end: "deferred",
      reason: failure.error,
    });
    assert.equal(ops.includes("stop"), false);
    const [release] = requestsOf(place, "release");
    assert.equal(release.state.stage, stage);
    assert.deepEqual(release.state.counts, { conflictFixes: 0, syncs: 0 });
    assert.deepEqual(outcome, RATE_LIMITED);
  });
}

test("the implementor's rate-limited session pushes nothing and readies no PR", () => {
  const { ops } = failedSessionJob("implement", COOLING_DOWN);
  for (const op of ["verify", "open-pr", "push"]) {
    assert.equal(ops.includes(op), false, op);
  }
});

test("an op's network failure defers its issue but isn't rate-limited", () => {
  const { line, ops, outcome } = failedPostJob(NETWORK);
  assert.equal(line.end, "deferred");
  assert.equal(ops.includes("stop"), false);
  assert.deepEqual(outcome, {
    kind: "finished",
    end: "deferred",
    rateLimited: false,
  });
});
