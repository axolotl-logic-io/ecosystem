// Hippy's Sync task through the built ops (#184): revision R and exact
// target T in, R′ containing T out, with the landing account's attempt and
// result. Real git origin, stateful fake GitHub, fresh ops processes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { originContains, syncWorld } from "./sync-task-test-kit.ts";
import {
  callMark,
  digest,
  plantComment,
  recordAttempt,
  recordKindsOn,
  recordResult,
  runId,
  stateText,
  statusOf,
  v2State,
  writesSince,
} from "./task-results-test-kit.ts";

const ISSUE = 7;
const FEATURE = { file: "feature.txt", bytes: "the issue's feature\n" };
const SHA_LENGTH = 40;
const NOT_ON_TARGET = "f".repeat(SHA_LENGTH);
const LAND_BLOCKS = /Land run .* is armed or uncertain/u;
const NOT_WRITABLE = /the code is not writable/u;
const STALE_POLICY = /policy is not the current policy/u;
const STALE_INPUTS = /trusted inputs are not the current inputs/u;
const OFF_TARGET = /is not on integration/u;
const MOVED = /are not both at revision/u;

test("Sync turns R into a new R′ containing exactly T, and only R′'s later tasks are missing", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { flow, revision } = world;
  // A passed Integration of R before the Sync: it stays bound to R.
  const integrationOfR = { ...world.binding(world.start), task: "Integration" };
  const checked = runId();
  recordAttempt(flow, ISSUE, integrationOfR, { id: checked, previous: null });
  recordResult(flow, ISSUE, integrationOfR, {
    run: checked,
    verdict: "passed",
    summary: "R on its old target",
  });
  const target = world.advanceTarget("base.txt", "the target moved\n");
  const bound = world.binding(target);
  const mark = callMark(flow.ghDir);
  const reply = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: null },
  });
  assert.equal(reply.verdict, "passed", JSON.stringify(reply));
  const produced = String(reply.produced);
  assert.notEqual(produced, revision);
  assert.equal(world.remoteBranch(), produced);
  assert.ok(
    originContains(flow.origin, target, produced),
    "R′ contains exactly T",
  );
  assert.ok(originContains(flow.origin, revision, revision));
  assert.equal(world.remoteTarget(), target, "Sync never writes the target");
  // GitHub saw only the landing account's attempt and result: no PR write.
  assert.deepEqual(
    writesSince(flow.ghDir, mark).map((args) =>
      args.filter((arg) => arg.startsWith("repos/")),
    ),
    [
      [`repos/o/r/issues/${ISSUE}/comments`],
      [`repos/o/r/issues/${ISSUE}/comments`],
    ],
  );
  assert.deepEqual(recordKindsOn(flow.ghDir, ISSUE).slice(-2), [
    "attempt",
    "result",
  ]);
  assert.partialDeepStrictEqual(statusOf(flow, ISSUE, bound), {
    status: "passed",
    result: { receipt: { produced: { code: produced } } },
  });
  // R′ is a new revision: Hardening, Integration and Security start over,
  // while the old Integration pass stays bound to R alone.
  for (const task of ["Hardening", "Integration", "Security"]) {
    const later = {
      ...bound,
      task,
      revision: { ...bound.revision, code: produced },
    };
    assert.equal(statusOf(flow, ISSUE, later).status, "missing", task);
  }
  assert.equal(statusOf(flow, ISSUE, integrationOfR).status, "passed");
});

test("Sync of an R that already contains T isn't ready: no attempt, no push", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const mark = callMark(world.flow.ghDir);
  const reply = world.sync("sync-task", {
    binding: world.binding(world.start),
    run: { id: runId(), previous: null },
  });
  assert.equal(reply.ready, false);
  assert.deepEqual(writesSince(world.flow.ghDir, mark), []);
  assert.equal(world.remoteBranch(), world.revision);
});

test("an armed or uncertain Land, a stale binding or a moved revision starts no writer", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { flow } = world;
  const target = world.advanceTarget("base.txt", "the target moved\n");
  const bound = world.binding(target);
  const land = { ...bound, task: "Land" };
  const cases = [
    {
      binding: {
        ...bound,
        revision: { ...bound.revision, policy: digest("old policy") },
      },
      why: STALE_POLICY,
    },
    {
      binding: {
        ...bound,
        revision: { ...bound.revision, inputs: digest("old inputs") },
      },
      why: STALE_INPUTS,
    },
    {
      binding: { ...bound, target: { ...bound.target, commit: NOT_ON_TARGET } },
      why: OFF_TARGET,
    },
    { binding: world.binding(target, world.start), why: MOVED },
  ];
  for (const { binding, why } of cases) {
    const mark = callMark(flow.ghDir);
    const reply = world.sync("sync-task", {
      binding,
      run: { id: runId(), previous: null },
    });
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), why);
    assert.deepEqual(writesSince(flow.ghDir, mark), []);
    assert.equal(world.remoteBranch(), world.revision);
  }
  // A Land attempt with no settled verdict blocks every writer, Sync included.
  recordAttempt(flow, ISSUE, land, { id: runId(), previous: null });
  const mark = callMark(flow.ghDir);
  const blocked = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: null },
  });
  assert.match(String(blocked.error), LAND_BLOCKS);
  assert.deepEqual(writesSince(flow.ghDir, mark), []);
  assert.equal(world.remoteBranch(), world.revision);
  assert.equal(statusOf(flow, ISSUE, bound).status, "missing");
});

test("a saved merge attempt or Security rejection makes the code unwritable: no Sync starts", () => {
  const world = syncWorld(ISSUE, FEATURE);
  const { flow } = world;
  const target = world.advanceTarget("base.txt", "the target moved\n");
  const bound = world.binding(target);
  const { revision } = bound;
  const { branch } = world;
  const saved = [
    {
      mergeAttempt: {
        repo: "o/r",
        pr: 1,
        target: "integration",
        branch,
        authorized: revision,
        hardened: revision,
        integration: null,
        result: null,
        reads: 0,
      },
    },
    {
      security: {
        revision,
        commentId: 5,
        finding: { category: "user-harm", reason: "leaks addresses" },
      },
    },
  ];
  for (const extra of saved) {
    plantComment(
      flow.ghDir,
      ISSUE,
      "bot",
      stateText(v2State(ISSUE, { stage: "merge", branch, ...extra })),
    );
    const mark = callMark(flow.ghDir);
    const reply = world.sync("sync-task", {
      binding: bound,
      run: { id: runId(), previous: null },
    });
    assert.match(String(reply.error), NOT_WRITABLE, JSON.stringify(extra));
    assert.deepEqual(writesSince(flow.ghDir, mark), []);
    assert.equal(world.remoteBranch(), world.revision);
  }
});
