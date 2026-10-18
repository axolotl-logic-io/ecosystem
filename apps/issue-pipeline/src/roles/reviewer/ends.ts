// The reviewer's end states (the wiki's Pipeline-Roles-Reviewer,
// "Lifecycle"): how each finished run ends, and the stop each failure posts.
// An end state routes nowhere, so it answers no result.

import type { End, StateSpec } from "../machine.ts";
import type { ReviewerData, ReviewerState } from "./locate.ts";

type EndSpec = StateSpec<ReviewerState, never, ReviewerData>;

function end(endOf: (data: ReviewerData) => End): EndSpec {
  return {
    kind: "end",
    effect: (data: ReviewerData) => ({ kind: "end", end: endOf(data) }),
    on: {},
  };
}

// An error stop for `reason`, with the run's failure as its detail.
function stopped(reason: string): EndSpec {
  return end((data: ReviewerData): End => {
    const { issue: number, failure: detail } = data;
    const payload = { number, code: "error", reason, detail };
    return { kind: "stopped", code: "error", after: { op: "stop", payload } };
  });
}

const END_STATES: Readonly<
  Record<
    | "released"
    | "prep-failed"
    | "nothing-to-review"
    | "lens-failed"
    | "clean"
    | "findings-stored"
    | "accept-deferred"
    | "accept-prep-failed"
    | "accept-moved"
    | "verifier-failed"
    | "accepted"
    | "acceptance-failed",
    EndSpec
  >
> = {
  released: end(() => ({ kind: "released" })),
  "prep-failed": stopped("could not prepare the review diff"),
  "nothing-to-review": stopped("nothing to review"),
  "lens-failed": stopped("a reviewer failed"),
  // A clean review goes to checks on the branch as it stands, with no sync
  // (#340).
  clean: end(() => ({ kind: "saved", stage: "checks" })),
  "findings-stored": end(() => ({ kind: "saved", stage: "fix" })),
  // The `accept` entry's ends (#423): a network failure holds the issue at
  // accept for the next tick; a kept verdict or a pass goes on to the
  // security review, and a fail to the fixer.
  "accept-deferred": end(() => ({ kind: "held" })),
  "accept-prep-failed": stopped("could not prepare the final diff"),
  "accept-moved": stopped("the branch changed after verification"),
  "verifier-failed": stopped("the acceptance verifier failed"),
  accepted: end(() => ({ kind: "saved", stage: "security" })),
  "acceptance-failed": end(() => ({ kind: "saved", stage: "fix" })),
};

export { END_STATES };
