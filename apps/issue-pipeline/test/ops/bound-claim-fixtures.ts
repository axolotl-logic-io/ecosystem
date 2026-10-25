import type { Config } from "../../src/config.ts";
import type { IssueState, Revision } from "../../src/state.ts";
import type { GhReply } from "../fake-gh.ts";
import { claimMutationReplies, labelReplies } from "../gh-mutation-fixtures.ts";
import { issueReply } from "../ops-claim-test-kit.ts";
import { prView } from "../ops-v2-test-kit.ts";

const { writeState }: typeof import("../../src/saved-state.ts") = await import(
  "../../src/saved-state.ts"
);
const POLICY_WIDTH = 64;

function answeredReplies(issue: number, pr: number, head: string): GhReply[] {
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

function closedMergeReplies(
  issue: number,
  pr: number,
  head: string,
  result: string,
): GhReply[] {
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
function checkpointOwnMerge(
  cfg: Config,
  work: IssueState,
  receipt: {
    pr: number;
    result: string;
    authorized: Revision;
    commentId: number;
  },
): void {
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
