// The orchestrator's merge queue (#234) on its way to the merge op: the stage
// job's --merge-queue, the sweep's args.mergeQueue, then the merge request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobArgsOf } from "../src/job/args.ts";
import { finishRun, SECURED } from "./workflow-finish-run-kit.mjs";

const RUN_ARGS = ["--config", "c.json", "--issue", "7", "--stage", "merge"];
const BAD_QUEUE = /--merge-queue must list issue numbers/u;
const MERGED = { ok: true, merged: true };
const AHEAD = 9;
const ISSUE = 7;
const BEHIND = 12;

// The merge op's request in a run of #7's merge stage with `args`.
/**
 * @param {object} args
 * @returns {Promise<{ mergeQueue?: number[], mergeOrder?: boolean }>}
 */
async function mergeRequest(args) {
  const { trace } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { merge: MERGED },
    args,
  });
  const merge = trace.find((entry) => entry.key === "i7-merge-3");
  if (merge === undefined) {
    throw new Error("the run made no merge request");
  }
  return /** @type {{ mergeQueue?: number[], mergeOrder?: boolean }} */ (
    merge.request ?? {}
  );
}

test("--merge-queue reads as issue numbers, and is unset without the flag", () => {
  const queue = [AHEAD, ISSUE, BEHIND];
  const queued = jobArgsOf([...RUN_ARGS, "--merge-queue", queue.join(",")]);
  assert.deepEqual(queued.kind === "run" && queued.mergeQueue, queue);
  const plain = jobArgsOf(RUN_ARGS);
  assert.equal(plain.kind === "run" && plain.mergeQueue, undefined);
  assert.throws(() => jobArgsOf([...RUN_ARGS, "--merge-queue", "9,x"]), {
    message: BAD_QUEUE,
  });
});

test("args.mergeQueue reaches the merge request; without it the request has none", async () => {
  const queue = [AHEAD, ISSUE];
  const queued = await mergeRequest({ mergeQueue: queue });
  assert.deepEqual(queued.mergeQueue, queue);
  assert.equal(queued.mergeOrder, true);
  const plain = await mergeRequest({});
  assert.equal("mergeQueue" in plain, false);
});
