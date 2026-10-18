// @ts-check
import { commentWriteReplies } from "./gh-mutation-fixtures.mjs";
import {
  CLAIM_ID,
  claimListing,
  ISSUE,
  REPO,
  stateListing,
} from "./ops-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

// A genuine saved state and this lane's claim, with their explicit patch effects.
/** @param {object} state @returns {GhReply[]} */
function releaseReplies(state) {
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
