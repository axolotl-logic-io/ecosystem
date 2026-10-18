// @ts-check
// startState when the branch's head moved since the review but its changes
// didn't (#394, review-keeps-on-clean-rebase): a restart whose current patch
// id equals the one the review passed keeps the review and continues where
// the issue was, re-verifying a head that moved since verification; any other
// patch id, or none, goes back to review as before.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { State } from "../src/state.ts" */

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { startState } = await import("../src/start-state.ts");

const PR = 50;
// The head the review passed, and the rebased head the branch is at now.
const REVIEWED = "1111111111111111111111111111111111111111";
const REBASED = "2222222222222222222222222222222222222222";
// The patch id the review passed, and that of an edited change.
const PATCH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EDITED = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FINDINGS = [{ id: "f1", status: "resolved" }];
const KEPT = /review kept: changes unchanged since 111111111111/u;
const RESTART_AT = /restarted .*at (?<stage>[a-z-]+)/u;

// The issue stopped at `stage`, reviewed and verified at REVIEWED, its
// changes then PATCH; the branch has since been rebased.
/** @param {string} stage @param {object} [fields] @returns {State} */
function stoppedAt(stage, fields = {}) {
  return {
    version: 1,
    number: 7,
    depth: 0,
    pr: PR,
    headSha: REVIEWED,
    reviewedSha: REVIEWED,
    reviewedPatchId: PATCH,
    verifiedSha: REVIEWED,
    acceptedSha: REVIEWED,
    acceptedPatchId: PATCH,
    stage: "stopped",
    stoppedStage: stage,
    stopCode: "budget",
    stopReason: "the issue's token budget ran out",
    plan: "P",
    spec: "S",
    findings: FINDINGS,
    nextFindingId: 2,
    log: ["a"],
    ...fields,
  };
}

/** @typedef {{ n: number, depth: number, remote: string | null, pr: number | null, hasWork: boolean, keptUnpushed: boolean, patchId: string | null, answered: boolean, now: Date }} Ctx */

// A start on the rebased branch, whose changes are still PATCH.
/** @type {Ctx} */
const ctx = {
  n: 7,
  depth: 0,
  remote: REBASED,
  pr: PR,
  hasWork: true,
  keptUnpushed: false,
  patchId: PATCH,
  answered: false,
  now: new Date("2026-10-17T16:00:00Z"),
};

// The start with `over` in place of ctx's fields.
/** @param {Partial<Ctx>} over @returns {Ctx} */
function startWith(over) {
  return { ...ctx, ...over };
}

// The last line of a state's log.
/** @param {State} state @returns {string} */
function lastLogLine({ log }) {
  return z.string().parse(log?.at(-1));
}

// What a restart kept of the review and acceptance.
/** @param {State} state @returns {object} */
function review(state) {
  const { findings, reviewedSha, reviewedPatchId } = state;
  const { acceptedSha, acceptedPatchId } = state;
  return {
    findings,
    reviewedSha,
    reviewedPatchId,
    acceptedSha,
    acceptedPatchId,
  };
}

const KEPT_REVIEW = {
  findings: FINDINGS,
  reviewedSha: REVIEWED,
  reviewedPatchId: PATCH,
  acceptedSha: REVIEWED,
  acceptedPatchId: PATCH,
};
const DROPPED_REVIEW = {
  findings: [],
  reviewedSha: null,
  reviewedPatchId: null,
  acceptedSha: null,
  acceptedPatchId: null,
};

for (const stage of ["sync", "checks"]) {
  test(`a stop at ${stage} after a clean rebase resumes at ${stage}, keeping the review`, () => {
    const resumed = startState(stoppedAt(stage), ctx);
    assert.deepEqual(
      [resumed.stage, resumed.headSha, review(resumed)],
      [stage, REBASED, KEPT_REVIEW],
    );
    assert.match(lastLogLine(resumed), KEPT);
    const { stage: at } = lastLogLine(resumed).match(RESTART_AT)?.groups ?? {};
    assert.equal(at, stage);
  });
}

for (const stage of ["accept", "security", "merge"]) {
  test(`a stop at ${stage} after a clean rebase re-verifies the new head at checks, keeping the review`, () => {
    const resumed = startState(stoppedAt(stage), ctx);
    assert.deepEqual([resumed.stage, review(resumed)], ["checks", KEPT_REVIEW]);
    assert.match(lastLogLine(resumed), KEPT);
  });
}

test("a stop at accept whose rebased head was already verified resumes at accept", () => {
  const state = stoppedAt("accept", { verifiedSha: REBASED });
  const resumed = startState(state, ctx);
  assert.deepEqual([resumed.stage, review(resumed)], ["accept", KEPT_REVIEW]);
  assert.match(lastLogLine(resumed), KEPT);
});

test("a stop at review or fix after a clean rebase goes on to sync", () => {
  for (const stage of ["review", "fix"]) {
    const resumed = startState(stoppedAt(stage), ctx);
    assert.deepEqual([resumed.stage, review(resumed)], ["sync", KEPT_REVIEW]);
  }
});

test("an edit since the review changes the patch id, so the restart goes back to review", () => {
  const resumed = startState(
    stoppedAt("checks"),
    startWith({ patchId: EDITED }),
  );
  assert.deepEqual(
    [resumed.stage, review(resumed)],
    ["review", DROPPED_REVIEW],
  );
  assert.doesNotMatch(lastLogLine(resumed), KEPT);
});

test("a patch id that can't be computed goes back to review", () => {
  const resumed = startState(stoppedAt("merge"), startWith({ patchId: null }));
  assert.deepEqual(
    [resumed.stage, review(resumed)],
    ["review", DROPPED_REVIEW],
  );
});

test("a review saved with no patch id doesn't stand on a missing one", () => {
  const state = stoppedAt("checks", { reviewedPatchId: null });
  const resumed = startState(state, startWith({ patchId: null }));
  assert.equal(resumed.stage, "review");
});

test("an open finding leaves no review standing, whatever the patch id", () => {
  const open = [{ id: "f1", status: "open" }];
  const resumed = startState(stoppedAt("checks", { findings: open }), ctx);
  assert.equal(resumed.stage, "review");
});

test("a head that didn't move needs no patch id and logs no kept review", () => {
  const resumed = startState(
    stoppedAt("checks"),
    startWith({ remote: REVIEWED, patchId: null }),
  );
  assert.deepEqual([resumed.stage, review(resumed)], ["checks", KEPT_REVIEW]);
  assert.doesNotMatch(lastLogLine(resumed), KEPT);
});

test("a restart of a finished issue on a rebased branch goes on to sync, carrying the review and acceptance", () => {
  const done = { ...stoppedAt("merge"), stage: "done", stoppedStage: null };
  const resumed = startState(done, ctx);
  assert.deepEqual([resumed.stage, review(resumed)], ["sync", KEPT_REVIEW]);
  assert.match(lastLogLine(resumed), KEPT);
});

test("answered questions leave no review standing, whatever the patch id", () => {
  const resumed = startState(
    stoppedAt("checks"),
    startWith({ answered: true }),
  );
  const { stage, reviewedPatchId } = resumed;
  assert.deepEqual([stage, reviewedPatchId ?? null], ["review", null]);
});
