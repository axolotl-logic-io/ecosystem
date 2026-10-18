// The first line of the comment the merge op posts on a PR it merged. It
// keeps provenance apart from what merged: when the Reviewer's own
// integration changed the hardened revision, it names the hardened head and
// the integrated, checked head separately, so it never says hardening saw
// the integrated commit. The security review of the merged result comes
// after the merge, and the comment says so.

import type { IssueState } from "../state.ts";
import { mergeAuthorization, sameRevision } from "../state.ts";

const SHORT_SHA_LENGTH = 12;
const SECURITY_FOLLOWS =
  "Exact-result deterministic checks and a read-only security review of the merged result follow; the issue completes only if it finds nothing.";

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
  const { hardened } = state;
  const authorized = mergeAuthorization(state);
  if (
    hardened === null ||
    authorized === null ||
    sameRevision(hardened, authorized)
  ) {
    return `${merged}: the Reviewer's hardening passed on this commit and every check passed on it. ${SECURITY_FOLLOWS}`;
  }
  return `${merged}: the Reviewer's hardening passed on ${short(hardened.code)} (wiki ${short(hardened.wiki)}); the Reviewer then integrated it as ${short(authorized.code)} (wiki ${short(authorized.wiki)}) with no further review, and every check passed on ${short(head)}. ${SECURITY_FOLLOWS}`;
}

export { mergedText };
