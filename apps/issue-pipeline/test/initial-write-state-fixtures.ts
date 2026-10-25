// A saved initial premerge state, before a caller records a PR or any merge.
// Never derive receipts from a request or mutable remote head. Tests needing
// later authority must serve their actual saved state instead.

import type { GhReply } from "./fake-gh.ts";
import { commentLines, githubComment } from "./fake-gh.ts";
import { stateAt } from "./job-fixtures.ts";

function initialWriteStateReply(
  number: number,
  branch = `agent/issue-${number}`,
): GhReply {
  const state = stateAt("implement", { number, branch, lease: null });
  const comment = githubComment({
    id: number,
    login: "a",
    created: "2026-10-18T00:00:00Z",
    body: `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  });
  return {
    when: `issues/${number}/comments`,
    stdout: commentLines([comment]),
    keep: true,
    persistState: true,
  };
}

function savedDraftReply(number: number, pr: number): GhReply {
  const reply = initialWriteStateReply(number);
  const comment = JSON.parse(reply.stdout ?? "{}");
  const state = stateAt("implement", {
    number,
    branch: `agent/issue-${number}`,
    lease: null,
    pr,
  });
  comment.body = `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  return { ...reply, stdout: JSON.stringify(comment) };
}

function historyReply(
  number: number,
  prs: number[] = [],
  branch = `agent/issue-${number}`,
): GhReply {
  return {
    when: `--head ${branch} --state all`,
    stdout: JSON.stringify(prs.map((pr) => ({ number: pr }))),
    keep: true,
  };
}

function openDraftReply(
  number: number,
  pr: number,
  origin: string,
): GhReply & { stdout: string } {
  return {
    when: `pr view ${pr} `,
    stdout: JSON.stringify({
      number: pr,
      state: "OPEN",
      headRefName: `agent/issue-${number}`,
      headRefOid: "",
      baseRefName: "integration",
      isCrossRepository: false,
      mergeCommit: null,
    }),
    headRef: { repo: origin, ref: `refs/heads/agent/issue-${number}` },
    keep: true,
  };
}

export {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
};
