// @ts-check
import {
  claimMutationReplies,
  labelReplies,
} from "../gh-mutation-fixtures.mjs";
import { issueReply } from "../ops-claim-test-kit.mjs";
import { prView } from "../ops-v2-test-kit.mjs";

/** @import { GhReply } from '../fake-gh.mjs' */
/** @import { Config } from '../../src/config.ts' */
/** @import { IssueState, Revision } from '../../src/state.ts' */
const { writeState } = await import("../../src/saved-state.ts");
const POLICY_WIDTH = 64;

/** @param {number} issue @param {number} pr @param {string} head @returns {GhReply[]} */
function answeredReplies(issue, pr, head) {
  return [
    { when: "collaborators/alice", stdout: "", keep: true },
    {
      ...issueReply(issue, {
        title: "Answered",
        body: "answer",
        labels: [
          { name: "agent:needs-info" },
          { name: "agent:stopped-conflict" },
        ],
      }),
      keep: true,
    },
    prView(issue, pr, { headRefOid: head, isDraft: true }),
    {
      when: `api repos/o/r/issues/${pr}/labels`,
      stdout: JSON.stringify([{ name: "agent:stopped-conflict" }]),
      keep: true,
    },
    ...claimMutationReplies(issue, issue, pr, ["agent:stopped-conflict"]),
    ...labelReplies("o/r", pr, [], ["agent:stopped-conflict"]),
  ];
}

/** @param {number} issue @param {number} pr @param {string} head @param {string} result @returns {GhReply[]} */
function closedMergeReplies(issue, pr, head, result) {
  return [
    prView(issue, pr, {
      state: "MERGED",
      headRefOid: head,
      mergeCommit: { oid: result },
    }),
    { when: `issue reopen ${issue} `, stdout: "", keep: true },
    {
      when: `api repos/o/r/issues/${issue} --jq {state}`,
      stdout: JSON.stringify({ state: "open" }),
      keep: true,
    },
    ...claimMutationReplies(issue, issue, pr),
  ];
}

// Deterministic merge operations establish own receipts; role saves cannot.
/** @param {Config} cfg @param {IssueState} work @param {{pr: number, result: string, authorized: Revision, commentId: number}} receipt */
function checkpointOwnMerge(cfg, work, receipt) {
  const { pr, result, authorized, commentId } = receipt;
  const merged = { ...authorized, code: result };
  writeState(cfg, work.number, {
    ...work,
    codeMerged: { pr, sha: result },
    mergeAttempt: {
      repo: cfg.repo,
      pr,
      target: cfg.baseBranch,
      branch: work.branch ?? "",
      authorized,
      hardened: authorized,
      integration: null,
      result,
      reads: 1,
    },
    resultSecurity: {
      revision: { ...merged, policy: "e".repeat(POLICY_WIDTH) },
      target: { repo: cfg.repo, branch: cfg.baseBranch, sha: result },
      commentId,
      finding: null,
    },
  });
}

export { answeredReplies, checkpointOwnMerge, closedMergeReplies };
