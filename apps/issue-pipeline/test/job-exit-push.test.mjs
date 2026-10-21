// @ts-check
// A stage job's exit push (src/job/exit-push.ts) on a fake op runner: a
// writer pushes its commits through exit-push, only its wiki through
// `push {wikiOnly}` once the code is merged, and nothing before its claim
// won; the reviewer's job, whose hardening commits, is a writer; a reader or
// merger never pushes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

// The pipeline root and home are temporary before any module reads them.
const tmp = fs.mkdtempSync("/tmp/issue-pipeline-exit-push-");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const TEMPORARY_ROOT = path.join(tmp, "root");
Object.assign(
  process.env,
  Object.fromEntries([
    ["ISSUE_PIPELINE_ROOT", TEMPORARY_ROOT],
    ["HOME", path.join(tmp, "home")],
  ]),
);
const { ROOT } = await import("../src/pipeline-root.ts");
const { exitPushOf } = await import("../src/job/exit-push.ts");
const { stateAt } = await import("./job-fixtures.mjs");

const CODE_MERGED = { pr: 42, sha: "c0ffee" };

// A fake op runner whose every op succeeds, logging every call.
function fakeOps() {
  /** @type {{ op: string, payload: object }[]} */
  const calls = [];
  /** @param {string} op @param {object} payload @returns {Promise<import("../src/job/ops-request.ts").OpsReply>} */
  function runOp(op, payload) {
    calls.push({ op, payload });
    return Promise.resolve({ ok: true, reply: {} });
  }
  return { calls, runOp };
}

test("the exit push's pipeline root is a temporary one", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
});

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
