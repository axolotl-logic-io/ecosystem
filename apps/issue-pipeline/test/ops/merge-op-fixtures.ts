// Supported exact POST and signed merge-comment effects for the strict op fixture.
import type { GhReply } from "../fake-gh.ts";

const REPO = "o/r";

function mergeCommentReplies(): GhReply[] {
  return [
    { when: "issues/50/comments?per_page", stdout: "", keep: true },
    {
      when: "api -X POST repos/o/r/issues/50/comments -f",
      stdout: "",
      keep: true,
    },
  ];
}

function approvalReply(w: { sha: string }): GhReply {
  return {
    when: `api repos/${REPO}/pulls/50/reviews --method POST -f event=APPROVE -f commit_id=${w.sha} --jq {state, commit: .commit_id, login: .user.login}`,
    stdout: JSON.stringify({
      state: "APPROVED",
      commit: w.sha,
      login: "bot",
    }),
  };
}

export { approvalReply, mergeCommentReplies };
