// The reviews and review comments on the item's PR, as GitHub reports them
// now, for the review loop's tasks: Verify reads its own earlier reviews,
// Fix the blocking comments it answers, Land the approvals and requests for
// changes that stand on the head it merges.
// Each listing is one complete, paged observation by the landing account;
// one that can't be read whole is unknown, never empty. Who may count as a
// qualified reviewer is not decided here: a review names its author as
// GitHub reports them, and the landing account's reviews are Verify's.

import { z } from "zod";
import type { Config } from "./config.ts";
import { wire } from "./discovery/wire.ts";
import type { ReviewState } from "./domain.ts";
import { SHA } from "./domain.ts";
import type { Observation } from "./signals/github-source.ts";
import { observeAll } from "./signals/github-source.ts";

const POSITIVE = z.number().int().positive();
const AUTHOR = z.looseObject({
  login: z.string().min(1),
  id: POSITIVE,
  type: z.string(),
});
const REVIEW = wire(
  z.looseObject({
    id: POSITIVE,
    user: AUTHOR.nullable(),
    body: z.string().nullable(),
    state: z.enum([
      "APPROVED",
      "CHANGES_REQUESTED",
      "COMMENTED",
      "DISMISSED",
      "PENDING",
    ]),
    commitId: SHA.nullable(),
    submittedAt: z.iso.datetime().nullish(),
  }),
);
const COMMENT = wire(
  z.looseObject({
    id: POSITIVE,
    pullRequestReviewId: POSITIVE.nullable(),
    inReplyToId: POSITIVE.optional(),
    user: AUTHOR.nullable(),
    path: z.string().min(1),
    line: POSITIVE.nullable(),
    commitId: SHA,
    body: z.string(),
    createdAt: z.iso.datetime(),
  }),
);
// A reviewer's latest review in one of these states is their standing one;
// a later comment-only review changes nothing (GitHub's own rule).
const STANDING_STATES: readonly string[] = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
];

// Who submitted a review or comment: null for a deleted account.
interface ReviewAuthor {
  login: string;
  id: number;
  type: string;
}

// One submitted (or still pending) review of the PR, against `commit`.
interface SubmittedReview {
  id: number;
  pr: number;
  author: ReviewAuthor | null;
  state: ReviewState | "COMMENTED" | "DISMISSED" | "PENDING";
  commit: string | null;
  body: string;
  submittedAt: string | null;
}

// A reviewer's standing approval or request for changes on one head.
type StandingReview = SubmittedReview & {
  author: ReviewAuthor;
  state: ReviewState;
  commit: string;
};

// One review comment on the PR's lines: a thread's first comment, which
// names its review, or a reply in that thread (`inReplyTo`).
interface ReviewComment {
  id: number;
  pr: number;
  review: number | null;
  inReplyTo: number | null;
  author: ReviewAuthor | null;
  path: string;
  line: number | null;
  commit: string;
  body: string;
  createdAt: string;
}

function mapped<T, U>(
  observation: Observation<T[]>,
  map: (row: T) => U,
): Observation<U[]> {
  if (observation.status !== "ok") {
    return observation;
  }
  return { status: "ok", value: observation.value.map(map) };
}

// Every review of PR `pr`, in GitHub's order (oldest first).
function listReviews(cfg: Config, pr: number): Observation<SubmittedReview[]> {
  return mapped(
    observeAll(cfg, `repos/${cfg.repo}/pulls/${pr}/reviews`, REVIEW),
    (row): SubmittedReview => ({
      id: row.id,
      pr,
      author: row.user,
      state: row.state,
      commit: row.commitId,
      body: row.body ?? "",
      submittedAt: row.submittedAt ?? null,
    }),
  );
}

// Every review comment of PR `pr`, threads and replies, oldest first.
function listReviewComments(
  cfg: Config,
  pr: number,
): Observation<ReviewComment[]> {
  return mapped(
    observeAll(cfg, `repos/${cfg.repo}/pulls/${pr}/comments`, COMMENT),
    (row): ReviewComment => ({
      id: row.id,
      pr,
      review: row.pullRequestReviewId,
      inReplyTo: row.inReplyToId ?? null,
      author: row.user,
      path: row.path,
      line: row.line,
      commit: row.commitId,
      body: row.body,
      createdAt: row.createdAt,
    }),
  );
}

function isStanding(review: SubmittedReview): review is StandingReview {
  return (
    review.author !== null &&
    review.commit !== null &&
    (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED")
  );
}

// Each reviewer's standing approval or request for changes that binds
// exactly `head`, from `reviews` in GitHub's order. A reviewer whose latest
// standing review was dismissed, or bound another head, has none.
function standingOn(
  reviews: readonly SubmittedReview[],
  head: string,
): StandingReview[] {
  const latest = new Map<number, SubmittedReview>();
  for (const review of reviews) {
    if (review.author !== null && STANDING_STATES.includes(review.state)) {
      latest.set(review.author.id, review);
    }
  }
  return [...latest.values()]
    .filter(isStanding)
    .filter((review) => review.commit === head);
}

export type { ReviewAuthor, ReviewComment, StandingReview, SubmittedReview };
export { listReviewComments, listReviews, standingOn };
