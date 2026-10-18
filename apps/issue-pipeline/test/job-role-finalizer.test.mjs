// @ts-check
// `job.mjs --stage merge` runs the finalizer role (#416) as a merger stage,
// not the sweep: a clean merge saves the issue at done, and the merge op is
// asked at the verified head, in merge order, with the queue the
// orchestrator passed in --merge-queue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { logOf, repliesAt, runJob, setUp } from "./job-test-kit.mjs";
import { claimAt } from "./workflow-stages-fixtures.mjs";

const VERIFIED = "aaaaaaa";
const AHEAD = 3;
const NEXT = 5;
// The claim at merge: a verified head on PR #42, with no wiki checkout.
const CLAIM = claimAt("merge", {
  pr: 42,
  headSha: VERIFIED,
  verifiedSha: VERIFIED,
  verifySummary: "tests pass",
});
// The merge op's reply: merged, with the wiki published.
const MERGE_OPS = { merge: { ok: true, merged: true, published: true } };

/** @returns {import("./job-test-kit.mjs").Place} issue #7 claimed at merge */
function mergePlace() {
  const claim = { ...CLAIM, paths: { ...CLAIM.paths, wiki: null } };
  return setUp({ ...repliesAt("merge"), claim, ...MERGE_OPS }, {});
}

test("a merge stage job runs the finalizer: the merge at the verified head with the queue, saved at done", () => {
  const place = mergePlace();
  const queue = `${AHEAD},${NEXT}`;
  const r = runJob(place, ["--stage", "merge", "--merge-queue", queue]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    issue: 7,
    stage: "merge",
    end: { kind: "saved", stage: "done" },
  });
  const ops = logOf(place, "ops.log");
  assert.deepEqual(
    ops.filter(({ op }) => op === "sweep"),
    [],
  );
  const merges = ops.filter(({ op }) => op === "merge");
  assert.equal(merges.length, 1);
  const [{ expectedSha, mergeOrder, mergeQueue }] = merges;
  assert.equal(expectedSha, VERIFIED);
  assert.equal(mergeOrder, true);
  assert.deepEqual(mergeQueue, [AHEAD, NEXT]);
  const last = ops.filter(({ op }) => op === "save-state").at(-1)?.state;
  assert.equal(last?.stage, "done");
});
