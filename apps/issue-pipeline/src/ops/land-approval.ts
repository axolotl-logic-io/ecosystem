// Whether a PR head is approved for Land, read fresh from GitHub
// (docs/decisions/pr-review.md `land-merges-the-pr`). The head needs a
// passed Verify of the revision, whatever approves it, since its Security
// review must pass before the merge (`verify-reviews-the-pr`,
// security-before-merge). It then needs an approval that still stands on
// it, from the landing account through that Verify or from a qualified
// person, and no request for changes from either. The landing account's approval counts only as
// the very review its passed Verify result submitted. A person's review
// counts only while they are a person and an active member of the buddy's
// organization, qualified now; one whose request for changes can't be
// qualified blocks, since it may stand.

import type { Config } from "../config.ts";
import type { TaskResult } from "../domain.ts";
import { VERIFY_EVIDENCE } from "../domain.ts";
import type { StandingReview } from "../pr-reviews.ts";
import { listReviews, standingOn } from "../pr-reviews.ts";
import { qualifyActor } from "../signals/qualification.ts";

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Why the landing account's reviews keep `head` from landing, or null; and
// whether its standing approval is the one Verify's pass submitted.
function landingVerdict(
  head: string,
  verify: TaskResult | undefined,
  landing: StandingReview | undefined,
): { blocked: string | null; approves: boolean } {
  if (verify === undefined) {
    return {
      blocked: `Verify, and so its Security review, has not passed ${head}`,
      approves: false,
    };
  }
  if (verify.verdict === "refused") {
    return { blocked: `Verify requested changes on ${head}`, approves: false };
  }
  if (landing?.state === "CHANGES_REQUESTED") {
    return {
      blocked: `the landing account's review ${landing.id} requests changes on ${head}`,
      approves: false,
    };
  }
  if (verify.verdict !== "passed" || landing === undefined) {
    return { blocked: null, approves: false };
  }
  const evidence = VERIFY_EVIDENCE.safeParse(verify.receipt.evidence);
  return {
    blocked: null,
    approves:
      evidence.success &&
      evidence.data.review.state === "APPROVED" &&
      evidence.data.review.commit === head &&
      evidence.data.review.id === landing.id,
  };
}

// Why the people's standing reviews keep `head` from landing, or null; and
// whether a qualified person approves it.
function peopleVerdict(
  cfg: Config,
  head: string,
  people: readonly StandingReview[],
): { blocked: string | null; approves: boolean } {
  if (people.length === 0) {
    return { blocked: null, approves: false };
  }
  const organization = cfg.buddyAuthorization?.organization;
  if (organization === undefined) {
    return {
      blocked: "no buddy is bound, so no reviewer qualifies",
      approves: false,
    };
  }
  let approves = false;
  for (const review of people) {
    const { login } = review.author;
    const qualified = qualifyActor(cfg, organization, {
      ...review.author,
      viaApp: false,
    });
    if (review.state === "CHANGES_REQUESTED") {
      if (qualified.status === "qualified") {
        return { blocked: `@${login} requested changes on ${head}`, approves };
      }
      if (qualified.status === "unknown") {
        return {
          blocked: `@${login}'s request for changes can't be qualified: ${qualified.reason}`,
          approves,
        };
      }
    } else if (qualified.status === "qualified") {
      approves = true;
    }
  }
  return { blocked: null, approves };
}

// Why PR `pr`'s head `head` is not approved for Land now, or null. `verify`
// is the latest determined Verify result of the revision.
function unapproved(
  cfg: Config,
  pr: number,
  head: string,
  verify: TaskResult | undefined,
): string | null {
  const listed = listReviews(cfg, pr);
  if (listed.status === "absent") {
    return `PR #${pr}'s reviews are not found`;
  }
  if (listed.status === "unknown") {
    return `PR #${pr}'s reviews are unreadable: ${listed.reason}`;
  }
  const standing = standingOn(listed.value, head);
  const landing = landingVerdict(
    head,
    verify,
    standing.find((review) => same(review.author.login, cfg.landingAccount)),
  );
  if (landing.blocked !== null) {
    return landing.blocked;
  }
  const people = peopleVerdict(
    cfg,
    head,
    standing.filter((review) => !same(review.author.login, cfg.landingAccount)),
  );
  if (people.blocked !== null) {
    return people.blocked;
  }
  if (!(landing.approves || people.approves)) {
    return `no approval stands on ${head}`;
  }
  return null;
}

export { unapproved };
