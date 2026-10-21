// @ts-check
// A stage job's exit push (src/job/exit-push.ts) on a fake op runner: a
// writer pushes its commits through exit-push, nothing once the code is
// merged, and nothing before its claim won; the reviewer's job, whose
// hardening commits, is a writer; a reader or merger never pushes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeOps } from "./role-job-test-kit.mjs";

const { exitPushOf } = await import("../../src/job/exit-push.ts");
const { stateAt } = await import("../job-fixtures.mjs");

const CODE_MERGED = { pr: 42, sha: "c0ffee" };

/** @param {any} state @param {"implement" | "review"} [stage] */
async function exitPushAt(state, stage = "implement") {
  const { calls, runOp } = fakeOps();
  const push = exitPushOf(stage, runOp, () => state);
  if (push === null) {
    throw new Error("a writer's job has no exit push");
  }
  await push();
  return calls;
}

test("a writer's exit push pushes nothing once the code is merged", async () => {
  const merged = stateAt("implement", { codeMerged: CODE_MERGED });
  assert.deepEqual(await exitPushAt(merged), []);
  assert.deepEqual(await exitPushAt(stateAt("implement")), [
    { op: "exit-push", payload: {} },
  ]);
});

test("a reviewer job interrupted mid-hardening pushes its commits as it exits", async () => {
  assert.deepEqual(await exitPushAt(stateAt("review"), "review"), [
    { op: "exit-push", payload: {} },
  ]);
});

test("a writer that never claimed pushes nothing, and a reader or merger never pushes", async () => {
  assert.deepEqual(await exitPushAt(null), []);
  const { runOp } = fakeOps();
  assert.equal(
    exitPushOf("author", runOp, () => null),
    null,
  );
  assert.equal(
    exitPushOf("merge", runOp, () => null),
    null,
  );
});
