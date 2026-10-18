// The reviewer role as a state machine (`role-state-machines`; the wiki's
// Pipeline-Roles-Reviewer, "Lifecycle"): its table, its limits and its pure
// transition. The prelude claims the issue and checks out its branch, then
// enters at the issue's stage: the `review` entry's states come from
// entries/review.ts and the `accept` entry's from entries/accept.ts. The
// stages it takes over are REVIEWER_STAGES, which the registry runs it for
// (src/roles/registry.ts).

import type { Limits, MachineState, Result, Step, Table } from "../machine.ts";
import { transitionOf } from "../machine.ts";
import type { Machine } from "../walk.ts";
import { END_STATES } from "./ends.ts";
import { ACCEPT_STATES } from "./entries/accept.ts";
import { REVIEW_STATES } from "./entries/review.ts";
import type { ReviewerData, ReviewerState } from "./locate.ts";
import { locate } from "./locate.ts";
import type { ReviewerResult } from "./states.ts";
import { check } from "./states.ts";

// The stages the reviewer machine runs, each with its entry.
const REVIEWER_STAGES: readonly string[] = ["review", "accept"];

// No edge loops, so no count bounds one.
const LIMITS: Limits = {};

const TABLE: Table<ReviewerState, ReviewerResult, ReviewerData> = {
  entries: ["claim"],
  states: {
    claim: check("claim", () => ({}), {
      ok: { to: "checkout" },
      "not-ours": { to: "released" },
    }),
    checkout: check(
      "checkout",
      (data: ReviewerData) => ({ entry: data.entry }),
      {
        review: { to: "prepare" },
        accept: { to: "prepare-accept" },
      },
    ),
    ...REVIEW_STATES,
    ...ACCEPT_STATES,
    ...END_STATES,
  },
};

const transition: (
  state: MachineState<ReviewerState, ReviewerData>,
  result: Result<ReviewerResult>,
) => Step<ReviewerState, ReviewerData> = transitionOf(TABLE, LIMITS);

const reviewerMachine: Machine<ReviewerState, ReviewerResult, ReviewerData> = {
  table: TABLE,
  limits: LIMITS,
  locate,
  handoff: [
    "headSha",
    "findings",
    "nextFindingId",
    "round",
    "reviewedSha",
    "reviewedPatchId",
    "testsOnly",
    "log",
    "acceptedSha",
    "acceptedPatchId",
    "acceptReason",
  ],
  checkpoints: [],
};

export type { ReviewerResult } from "./states.ts";
export { LIMITS, REVIEWER_STAGES, reviewerMachine, TABLE, transition };
