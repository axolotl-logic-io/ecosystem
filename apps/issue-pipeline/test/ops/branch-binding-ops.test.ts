// The branch binding's guards on the ops that ready, merge or delete an
// issue's branch (src/branch-binding.ts): each refuses, before it writes,
// a state bound to another branch than the one the issue is assigned, and
// each checks or deletes exactly the assigned branch, a custom one
// included, never the legacy agent/issue-<n> in its place.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../../src/config.ts";
import type { IssueState } from "../../src/state.ts";
import { effectNames, effectsOf } from "../gh-effects-test-kit.ts";
import { setCurrentRevision } from "./fake-ops-publish-revision.ts";
import { finishReplies } from "./ops-finish-fixtures.ts";
import type { World } from "./ops-publish-test-kit.ts";
import {
  approvedState,
  fakeGh,
  PR,
  prView,
  savedListing,
  securityOf,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.ts";

const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { readyPr }: typeof import("../../src/ops/ready-pr.ts") = await import(
  "../../src/ops/ready-pr.ts"
);
const { finishIssue }: typeof import("../../src/ops/finish.ts") = await import(
  "../../src/ops/finish.ts"
);
const { withCheckout }: typeof import("../../src/config.ts") = await import(
  "../../src/config.ts"
);

const ASSIGNED = "feature/seven";
const WORK_IS_ON =
  /#7's work is on agent\/issue-7, not the assigned feature\/seven/u;
const BOUND_ELSEWHERE =
  /#7's work is on x\/y, not the assigned agent\/issue-7/u;
const BOUND_TO_ASSIGNED =
  /#7's work is on feature\/seven, not the assigned agent\/issue-7/u;
const NOT_ASSIGNED_PR = /PR #50 is from agent\/issue-7, not feature\/seven/u;

// The world's config with issue #7 assigned ASSIGNED, its checkout the
// world's worktree.
function assignedCfg(w: World): Config {
  return withCheckout(w.cfg, { issue: 7, dir: w.worktree, branch: ASSIGNED });
}

function approvedOf(w: World): { code: string; inputs: string } {
  return { code: w.sha, inputs: "inputs-1" };
}

// The merge request these tests send; merge parses it from unknown.
interface MergeRequest {
  number: number;
  state: IssueState;
  expectedSha: string;
  expectedBase: string;
  revision: { code: string; inputs: string };
  mergeQueue: null;
  summary: string;
}

function mergeRequest(w: World, state: IssueState): MergeRequest {
  return {
    number: 7,
    state,
    expectedSha: w.sha,
    expectedBase: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    revision: approvedOf(w),
    mergeQueue: null,
    summary: "S",
  };
}

function openAt(w: World): void {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

test("merge refuses a state bound to another branch than the assigned one, writing nothing", () => {
  const w = world();
  openAt(w);
  const elsewhere = approvedState(approvedOf(w), { branch: "x/y" });
  fakeGh.reply([
    savedListing(approvedState(approvedOf(w))),
    prView({ headRefOid: w.sha }),
  ]);
  assert.throws(
    () => merge(w.cfg, mergeRequest(w, elsewhere)),
    BOUND_ELSEWHERE,
  );
  assert.deepEqual(writes(), []);
  // A legacy state (branch null) is on agent/issue-7, not a new assignment.
  const legacy = approvedState(approvedOf(w));
  fakeGh.reply([
    savedListing(approvedState(approvedOf(w))),
    prView({ headRefOid: w.sha }),
  ]);
  assert.throws(
    () => merge(assignedCfg(w), mergeRequest(w, legacy)),
    WORK_IS_ON,
  );
  assert.deepEqual(writes(), []);
});

test("merge of a state bound to its assigned branch refuses a PR from the legacy branch", () => {
  const w = world();
  openAt(w);
  const bound = approvedState(approvedOf(w), { branch: ASSIGNED });
  fakeGh.reply([
    savedListing(approvedState(approvedOf(w))),
    prView({ headRefOid: w.sha }),
  ]);
  assert.throws(
    () => merge(assignedCfg(w), mergeRequest(w, bound)),
    NOT_ASSIGNED_PR,
  );
  assert.deepEqual(writes(), []);
});

test("ready-pr refuses a saved state bound to another branch, writing nothing", () => {
  const w = world();
  openAt(w);
  const state = approvedState(approvedOf(w), { stage: "review" });
  fakeGh.reply([savedListing({ ...state, branch: "x/y" })]);
  assert.throws(() => readyPr(w.cfg, { number: 7, state }), BOUND_ELSEWHERE);
  assert.deepEqual(writes(), []);
});

// #7 saved done at its actual merge result, bound to `branch`, the security
// review of the merged result clear; GitHub shows the PR merged.
function doneOn(w: World, branch: string): IssueState {
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/integration ${w.mergeSha}`,
  );
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/${branch} ${w.sha}`,
  );
  const merged = { code: w.mergeSha, inputs: "inputs-1" };
  setCurrentRevision({
    revision: merged,
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: w.mergeSha,
      headSha: w.sha,
    },
  });
  return approvedState(approvedOf(w), {
    stage: "done",
    branch,
    merged,
    verifiedSha: w.mergeSha,
    security: securityOf(merged),
  });
}

test("finish deletes the assigned branch the state is bound to, and refuses another before any write", () => {
  const w = world();
  const done = doneOn(w, ASSIGNED);
  fakeGh.reply([savedListing(done), ...finishReplies(ASSIGNED)]);
  assert.equal(finishIssue(assignedCfg(w), { number: 7 }).finished, true);
  const deletes = effectNames(effectsOf(writes())).filter((effect) =>
    effect.startsWith("delete branch "),
  );
  assert.deepEqual(deletes, [`delete branch ${ASSIGNED}`]);
  fakeGh.reply([savedListing(doneOn(w, ASSIGNED))]);
  assert.throws(() => finishIssue(w.cfg, { number: 7 }), BOUND_TO_ASSIGNED);
  assert.deepEqual(writes(), []);
});
