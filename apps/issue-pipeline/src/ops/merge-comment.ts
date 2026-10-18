// The first line of the comment the merge op posts on a PR it merged. It
// keeps the review's provenance apart from what merged: when the Reviewer's
// own integration changed the approved revision after the final review, it
// names the reviewed head and the integrated, checked head separately, so it
// never says the review saw the integrated commit.

import type { IssueState } from "../state.ts";
import { approvedRevision, sameRevision } from "../state.ts";

const SHORT_SHA_LENGTH = 12;

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA_LENGTH) ?? "none";
}

// The merge comment's first line for `state`'s PR, whose head `head` merged
// as `mergeCommit`.
function mergedText(
  state: IssueState,
  head: string,
  mergeCommit: string,
): string {
  const merged = `Merged ${short(head)} as ${short(mergeCommit)}`;
  const reviewed = state.review.revision;
  const approved = approvedRevision(state);
  if (
    reviewed === null ||
    approved === null ||
    sameRevision(reviewed, approved)
  ) {
    return `${merged}: every blocking review finding is resolved and every check passed on this commit.`;
  }
  return `${merged}: the final review approved ${short(reviewed.code)} (wiki ${short(reviewed.wiki)}); the Reviewer then integrated it as ${short(approved.code)} (wiki ${short(approved.wiki)}) with no further review, and every check passed on ${short(head)}.`;
}

export { mergedText };
