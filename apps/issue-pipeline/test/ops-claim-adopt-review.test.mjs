// A stage job's push adopted from checks (#447), followed through the sweep:
// ops' claim, run on a local bare repo, adopts the pushed head, and the
// built workflow (workflow-harness.mjs, with scripted sessions) reviews it
// before checks can pass, with no branch-changed stop. The second case is
// #416's: a CI fixer pushed its commit through pipeline_commit, then failed
// on a provider's rate limit, so the stage deferred with the state from
// before the fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimSaved,
  head,
  movedBranch,
  recordPush,
} from "./ops-claim-adopt-test-kit.mjs";
import { COOLING_DOWN, itemOf, opsOf } from "./rate-limit-test-kit.mjs";
import { releasedState, sessionAgents } from "./stage-outcome-test-kit.mjs";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { Scripted } from "./workflow-harness.mjs" */

// The issues: one whose stage job's exit push is adopted at checks, and one
// whose CI fixer's pipeline_commit push is.
const EXIT_PUSHED = 72;
const CI_FIXER_PUSHED = 73;
const READER = "issue-pipeline-reader";
const NO_FINDINGS = replyWith({ findings: [] });
// Room for the review and its save, with checks after it held by the cap.
const SPAWN_CAP = { maxSpawnsPerRun: 15 };
const REVIEW_LENSES = ["correctness", "tests", "scope"];

// The state of issue `n` saved at checks on `headSha`, its review behind it,
// as the workflow reads a claim of it.
/** @param {number} n @param {string} headSha @returns {object} */
function checksState(n, headSha) {
  return claimAt("checks", {
    number: n,
    pr: 42,
    headSha,
    reviewedSha: headSha,
    implemented: true,
    spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  }).state;
}

// A sweep of issue `n` claimed with `claim`, with the given ops and agents.
/**
 * @param {number} n
 * @param {object} claim
 * @param {Record<string, Scripted>} ops
 * @param {Record<string, Scripted>} agents
 * @returns {ReturnType<typeof runWorkflow>}
 */
function sweepOf(n, claim, ops, agents) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [n], config: SPAWN_CAP }),
      claim,
      ...ops,
    },
    agents,
  });
}

// A sweep of issue `n` from ops' claim reply `claim`, whose review of
// `remote` finds nothing.
/** @param {number} n @param {object} claim @param {string} remote @returns {ReturnType<typeof runWorkflow>} */
function reviewSweep(n, claim, remote) {
  const reviewers = REVIEW_LENSES.map((lens) => [
    `i${n}-review-${lens}`,
    NO_FINDINGS,
  ]);
  return sweepOf(
    n,
    claim,
    { "prepare-review": { ok: true, headSha: remote } },
    Object.fromEntries(reviewers),
  );
}

test("an exit push adopted at checks is reviewed before checks can pass", async () => {
  const { saved, remote } = movedBranch(EXIT_PUSHED);
  recordPush(EXIT_PUSHED, remote, "exit-push");
  const claim = claimSaved(
    EXIT_PUSHED,
    checksState(EXIT_PUSHED, saved.headSha),
  );
  assert.equal(head(EXIT_PUSHED), remote);
  const { trace, summary } = await reviewSweep(EXIT_PUSHED, claim, remote);
  const ops = opsOf(trace);
  assert.equal(ops.includes("stop"), false);
  assert.ok(ops.includes("prepare-review"));
  assert.equal(ops.includes("verify"), false);
  assert.deepEqual(sessionAgents(trace), [READER, READER, READER]);
  const released = releasedState(trace);
  assert.deepEqual(
    [released.stage, released.headSha, released.reviewedSha],
    ["checks", remote, remote],
  );
  assert.deepEqual(itemOf(summary), {
    stage: "checks",
    outcome: "in-progress",
  });
});

// The checks that fail on the saved head, which send the CI fixer in.
/** @param {number} n @param {string} headSha @returns {Record<string, Scripted>} */
function checksFailOn(n, headSha) {
  const check = {
    id: "test",
    pass: false,
    detail: "1 failed",
    log: `/w/runs/o__r/issue-${n}/test.log`,
    tail: "expected 3, got 2",
  };
  return { verify: { ok: true, headSha, pass: false, checks: [check] } };
}

test("a CI fixer that pushed, then hit a rate limit, leaves its push resumable and reviewed", async () => {
  const n = CI_FIXER_PUSHED;
  const { saved, remote } = movedBranch(n);
  const atChecks = {
    ...claimAt("checks"),
    state: checksState(n, saved.headSha),
  };
  const fixer = Object.fromEntries([[`i${n}-cifix-1`, COOLING_DOWN]]);
  const first = await sweepOf(
    n,
    atChecks,
    checksFailOn(n, saved.headSha),
    fixer,
  );
  const deferred = releasedState(first.trace);
  assert.deepEqual(
    [deferred.stage, deferred.headSha, deferred.ciFixes],
    ["checks", saved.headSha, 0],
  );
  // The fixer's commit, pushed and recorded by the job before the 429.
  recordPush(n, remote, "pipeline-commit");
  const claim = claimSaved(n, deferred);
  const { trace, summary } = await reviewSweep(n, claim, remote);
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.equal(opsOf(trace).includes("verify"), false);
  const released = releasedState(trace);
  assert.deepEqual(
    [released.stage, released.headSha, released.reviewedSha, released.ciFixes],
    ["checks", remote, remote, 0],
  );
  assert.deepEqual(itemOf(summary), {
    stage: "checks",
    outcome: "in-progress",
  });
});
