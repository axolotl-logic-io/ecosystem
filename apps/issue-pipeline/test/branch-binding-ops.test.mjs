// @ts-check
// The branch binding's guards on the ops that ready, merge or delete an
// issue's branch (src/branch-binding.ts): each refuses, before it writes,
// a state bound to another branch than the one the issue is assigned, and
// each checks or deletes exactly the assigned branch, a custom one
// included, never the legacy agent/issue-<n> in its place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { finishReplies } from "./ops-finish-fixtures.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
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
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");
const { readyPr } = await import("../src/ops/ready-pr.ts");
const { finishWiki } = await import("../src/ops/finish.ts");
const { withCheckout } = await import("../src/config.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/config.ts").Config} Config */

const ASSIGNED = "feature/seven";
const WORK_IS_ON =
  /#7's work is on agent\/issue-7, not the assigned feature\/seven/u;
const BOUND_ELSEWHERE =
  /#7's work is on x\/y, not the assigned agent\/issue-7/u;
const BOUND_TO_ASSIGNED =
  /#7's work is on feature\/seven, not the assigned agent\/issue-7/u;
const NOT_ASSIGNED_PR = /PR #50 is from agent\/issue-7, not feature\/seven/u;
const DELETES_ASSIGNED =
  /^api -X DELETE repos\/o\/r\/git\/refs\/heads\/feature\/seven --silent$/u;

// The world's config with issue #7 assigned ASSIGNED, its checkout the
// world's worktree.
/** @param {World} w @returns {Config} */
function assignedCfg(w) {
  return withCheckout(w.cfg, { issue: 7, dir: w.worktree, branch: ASSIGNED });
}

/** @param {World} w @returns {{ code: string, inputs: string }} */
function approvedOf(w) {
  return { code: w.sha, inputs: "inputs-1" };
}

/** @param {World} w @param {IssueState} state @returns {object} */
function mergeRequest(w, state) {
  return {
    number: 7,
    state,
    expectedSha: w.sha,
    revision: approvedOf(w),
    mergeQueue: null,
    summary: "S",
  };
}

/** @param {World} w @returns {void} */
function openAt(w) {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: "base",
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
/** @param {World} w @param {string} branch @returns {IssueState} */
function doneOn(w, branch) {
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/integration ${w.mergeSha}`,
  );
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/${branch} ${w.sha}`,
  );
  const merged = { code: w.mergeSha, inputs: "inputs-1" };
  setCurrentRevision({
    revision: merged,
    baseSha: "base",
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

test("finish-wiki deletes the assigned branch the state is bound to, and refuses another before any write", () => {
  const w = world();
  const done = doneOn(w, ASSIGNED);
  fakeGh.reply([savedListing(done), ...finishReplies(ASSIGNED)]);
  assert.equal(finishWiki(assignedCfg(w), { number: 7 }).finished, true);
  assert.match(writes()[0]?.join(" ") ?? "", DELETES_ASSIGNED);
  fakeGh.reply([savedListing(doneOn(w, ASSIGNED))]);
  assert.throws(() => finishWiki(w.cfg, { number: 7 }), BOUND_TO_ASSIGNED);
  assert.deepEqual(writes(), []);
});
