// Submitting a planned review (ops/verify-review.ts) on a pull request's
// exact head commit, as the account a task run acts as. The review binds
// that head through its `commit_id`, so it never judges a later one.
import { z } from "zod";
import type { PlannedReview } from "../ops/verify-review.ts";
import { OpsError } from "../ops-error.ts";
import type { IssueGitHub } from "../task-app/issue-github.ts";

const SUBMITTED = z.looseObject({
  id: z.number().int().positive(),
  state: z.string(),
  commit_id: z.string(),
});

// A review GitHub took: its id and state.
interface Submitted {
  id: number;
  state: string;
}

// Submits `review.planned` on PR `review.pull` of `review.repo` against
// exactly `review.head`. An answer that doesn't confirm that review on that
// head throws.
function submitReview(
  github: IssueGitHub,
  review: { repo: string; pull: number; head: string; planned: PlannedReview },
): Submitted {
  const { repo, pull, head, planned } = review;
  const answer = SUBMITTED.safeParse(
    github.post(`repos/${repo}/pulls/${pull}/reviews`, {
      commit_id: head,
      event: planned.event,
      body: planned.body,
      comments: planned.comments,
    }),
  );
  let expected = "CHANGES_REQUESTED";
  if (planned.event === "APPROVE") {
    expected = "APPROVED";
  }
  if (
    !answer.success ||
    answer.data.commit_id !== head ||
    answer.data.state !== expected
  ) {
    throw new OpsError(
      `GitHub's answer doesn't confirm a ${expected} review of ${head} on PR #${pull}`,
    );
  }
  return { id: answer.data.id, state: answer.data.state };
}

export type { Submitted };
export { submitReview };
