// Requests and matching revision observations for the merge op's real worlds.

import type { IssueState, Revision } from "../../src/state.ts";
import { setCurrentRevision } from "./fake-ops-publish-revision.ts";
import type { World } from "./ops-publish-test-kit.ts";
import { boundState, ISSUE, PR, sh } from "./ops-publish-test-kit.ts";

const { policyRevision }: typeof import("../../src/project-policy.ts") =
  await import("../../src/project-policy.ts");

function approvedOf(w: World): Revision & { code: string } {
  return { code: w.sha, inputs: "inputs-1", ...policyRevision(w.cfg) };
}

// The merge request these tests send; merge parses it from unknown.
interface MergeRequest {
  number: number;
  state: IssueState;
  expectedSha: string;
  expectedBase: string;
  revision: Revision & { code: string };
  mergeQueue: null;
  summary: string;
}

function request(w: World, extra: object = {}): MergeRequest {
  const approved = approvedOf(w);
  return {
    number: ISSUE,
    state: boundState(w, approved),
    expectedSha: w.sha,
    expectedBase: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    revision: approved,
    mergeQueue: null,
    summary: "All good.",
    ...extra,
  };
}

function current(w: World): void {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

export { approvedOf, current, request };
