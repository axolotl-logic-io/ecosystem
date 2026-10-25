import type { GhReply } from "../fake-gh.ts";
import { commentWriteReplies } from "../gh-mutation-fixtures.ts";
import {
  CLAIM_ID,
  claimListing,
  ISSUE,
  REPO,
  stateListing,
} from "./ops-test-kit.ts";

// A genuine saved state and this lane's claim, with their explicit patch effects.
function releaseReplies(state: object): GhReply[] {
  const saved = stateListing(ISSUE, state);
  const claim = claimListing();
  return [
    {
      when: saved.when,
      stdout: [saved.stdout, claim.stdout].join("\n"),
      keep: true,
      persistState: true,
    },
    ...commentWriteReplies(REPO, ISSUE, [ISSUE, CLAIM_ID]),
  ];
}

export { releaseReplies };
