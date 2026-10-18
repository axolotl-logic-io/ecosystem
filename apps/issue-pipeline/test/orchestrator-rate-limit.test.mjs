// @ts-check
// The orchestrator's backoff after a transient provider or transport error
// (`rate-limit-defers`): a job of this pipeline that ended deferred holds
// every start for rateLimitBackoffMinutes, and the starts resume after it.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  loggedFor,
  MINUTE_MS,
  NOW,
  openWith,
  resetRuns,
  tickOver,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

/** @import { OpenIssue } from "./orchestrator-world-test-kit.mjs" */

const DEAD_PID = 4343;
// The backoff's default length.
const BACKOFF_MINUTES = 5;

beforeEach(resetRuns);

/** @type {OpenIssue[]} */
const QUEUE = [
  { number: 1, state: { version: 2, number: 1, stage: "implement" } },
  { number: 2 },
];

test("a rate-limited end holds every start until the backoff passes", () => {
  writeJob({
    issue: 1,
    stage: "implement",
    pid: DEAD_PID,
    outcome: { kind: "finished", rateLimited: true },
    endedAt: NOW.toISOString(),
  });
  openWith(QUEUE);
  assert.deepEqual(tickOver().spawned, []);
  assert.deepEqual(loggedFor(2), ["author held rate-limited"]);
  openWith(QUEUE);
  const later = new Date(NOW.getTime() + BACKOFF_MINUTES * MINUTE_MS);
  assert.equal(tickOver({ at: later }).spawned.length, 2);
});
