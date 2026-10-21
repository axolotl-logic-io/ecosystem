// @ts-check
// Supported exact POST and signed merge-comment effects for the strict op fixture.
const REPO = "o/r";

/** @typedef {import("./fake-gh.mjs").GhReply} GhReply */

/** @returns {GhReply[]} */
function mergeCommentReplies() {
  return [
    { when: "issues/50/comments?per_page", stdout: "", keep: true },
    {
      when: "api -X POST repos/o/r/issues/50/comments -f",
      stdout: "",
      keep: true,
    },
  ];
}

/** @param {{ sha: string }} w @returns {GhReply} */
function approvalReply(w) {
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
