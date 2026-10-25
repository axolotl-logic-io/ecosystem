// Sync, Integration and Land reread ownership before each write (#169), in
// the full-flow world with a real origin. Each row is the task's own
// success setup, but a successor takes the issue just after the request's
// ownership check, or just after its attempt record, so just before the
// write that matters: the Sync push, Integration's result or Land's push.
// That write never happens, and the refusal names the lost ownership.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ISSUE, integrationWorld } from "./integration-task-test-kit.ts";
import { isCoordinationWrite } from "./pipeline-flow-coordination-test-kit.ts";
import { syncWorld } from "./sync-task-test-kit.ts";
import {
  callMark,
  loseNextOwnership,
  rawOps,
  recordKindsOn,
  runId,
  writesSince,
} from "./task-results-test-kit.ts";

const REFUSED = z.looseObject({ ok: z.literal(false), error: z.string() });
// What the fresh ownership read before a write says once a successor took
// the issue (coordination-records.ts).
const LOST = /execution ownership lost or unconfirmed/u;
const FEATURE = { file: "feature.txt", bytes: "the issue's feature\n" };

// Returns the writes since `mark`, but the successor's records
function taskWrites(dir: string, mark: number): string[][] {
  return writesSince(dir, mark).filter((args) => !isCoordinationWrite(args));
}

test("task records: a successor taking the issue before the attempt is recorded leaves no record", () => {
  const world = integrationWorld();
  const mark = callMark(world.flow.ghDir);
  const before = recordKindsOn(world.flow.ghDir, ISSUE);
  loseNextOwnership(world.flow);
  const refused = REFUSED.parse(
    rawOps(world.flow, {
      op: "record-task-attempt",
      number: ISSUE,
      binding: world.bound("Hardening"),
      run: { id: runId(), previous: null },
    }),
  );
  assert.match(refused.error, LOST);
  assert.deepEqual(taskWrites(world.flow.ghDir, mark), []);
  assert.deepEqual(recordKindsOn(world.flow.ghDir, ISSUE), before);
});

test("Integration: a successor taking the issue after its attempt records no result", () => {
  const world = integrationWorld();
  world.passed("Hardening");
  const kinds = recordKindsOn(world.flow.ghDir, ISSUE);
  loseNextOwnership(world.flow, { afterWrite: true });
  const refused = REFUSED.parse(
    rawOps(world.flow, {
      op: "integration-task",
      number: ISSUE,
      binding: world.bound("Integration"),
      run: { id: runId(), previous: null },
    }),
  );
  assert.match(refused.error, LOST);
  assert.deepEqual(recordKindsOn(world.flow.ghDir, ISSUE), [
    ...kinds,
    "attempt",
  ]);
});

test("Sync: a successor taking the issue after its attempt leaves the branch unpushed", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const target = world.advanceTarget("base.txt", "the target moved\n");
  const branch = world.remoteBranch();
  const kinds = recordKindsOn(world.flow.ghDir, ISSUE);
  loseNextOwnership(world.flow, { afterWrite: true });
  const refused = REFUSED.parse(
    rawOps(world.flow, {
      op: "sync-task",
      number: ISSUE,
      binding: world.binding(target),
      run: { id: runId(), previous: null },
    }),
  );
  assert.match(refused.error, LOST);
  assert.equal(world.remoteBranch(), branch);
  assert.equal(world.remoteTarget(), target);
  assert.deepEqual(recordKindsOn(world.flow.ghDir, ISSUE), [
    ...kinds,
    "attempt",
  ]);
});

// Land's turn (#171) writes a token commit, its request, the epoch ref and
// its confirmation before Land's attempt record.
const TURN_WRITES = 4;

test("Land: a successor taking the issue after its attempt approves nothing and leaves the target unwritten", () => {
  const world = integrationWorld();
  const ready = world.readyToLand();
  for (const task of ["Hardening", "Integration", "Security"]) {
    world.passed(task);
  }
  const target = world.remoteTarget();
  const mark = callMark(world.flow.ghDir);
  loseNextOwnership(world.flow, { afterWrite: TURN_WRITES + 1 });
  const refused = REFUSED.parse(
    rawOps(world.flow, {
      op: "merge",
      number: ISSUE,
      state: ready.state,
      expectedSha: world.revision,
      expectedBase: world.start,
      revision: ready.revision,
      mergeQueue: [ready.pr],
      summary: "Exact Land of R on T.",
      binding: world.bound("Land"),
      landRun: { id: runId(), previous: null },
    }),
  );
  assert.match(refused.error, LOST);
  assert.equal(world.remoteTarget(), target);
  // Only Land's attempt: no approval of the PR, no push of the target.
  assert.equal(taskWrites(world.flow.ghDir, mark).length, 1);
  assert.deepEqual(recordKindsOn(world.flow.ghDir, ISSUE).at(-1), "attempt");
});
