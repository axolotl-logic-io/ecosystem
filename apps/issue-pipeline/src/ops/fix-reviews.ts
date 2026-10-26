// What Fix answers on its PR, as GitHub reports it now (pr-reviews.ts): the
// reviews that request changes on exactly the head it fixes, each one's
// standing, and the blocking threads they opened. Only the landing account
// (Verify) and a qualified person direct Fix: a request from anyone else, or
// from someone who can't be qualified now, is neither given to the session
// nor answered. A thread whose first comment starts by calling itself a nit
// or non-blocking blocks nothing; Verify marks its nits so. Fix replies in
// each blocking thread through the development account, and each reply
// carries a hidden mark naming its run, so a later read finds what a run
// answered; a mark in anyone else's comment proves nothing.

import type { Config } from "../config.ts";
import { gh } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import type { ReviewComment, StandingReview } from "../pr-reviews.ts";
import { listReviewComments, listReviews, standingOn } from "../pr-reviews.ts";
import type { Observation } from "../signals/github-source.ts";
import { qualifyActor } from "../signals/qualification.ts";

const NIT = /^\W*(?:nit|non-blocking)\b/iu;

// A request for changes standing on the head: its review id, reviewer and
// body, which names the findings about the change as a whole.
interface ChangeRequest {
  id: number;
  author: string;
  landing: boolean;
  body: string;
}

// A blocking thread: its first comment, on the lines it names.
interface BlockingThread {
  id: number;
  path: string;
  line: number | null;
  author: string;
  body: string;
}

interface Requests {
  requests: ChangeRequest[];
  threads: BlockingThread[];
  // Every review comment of the PR, replies included.
  comments: ReviewComment[];
}

function whole<T>(observation: Observation<T>, what: string): T {
  if (observation.status === "ok") {
    return observation.value;
  }
  if (observation.status === "unknown") {
    throw new OpsError(`${what} can't be read whole: ${observation.reason}`);
  }
  throw new OpsError(`${what} can't be read whole: GitHub has none`);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Whether `review` may direct Fix: the landing account's, which is
// Verify's, or a person's who is an active member of the buddy's
// organization now.
function directs(cfg: Config, review: StandingReview): boolean {
  if (same(review.author.login, cfg.landingAccount)) {
    return true;
  }
  const organization = cfg.buddyAuthorization?.organization;
  if (organization === undefined) {
    return false;
  }
  const qualified = qualifyActor(cfg, organization, {
    ...review.author,
    viaApp: false,
  });
  return qualified.status === "qualified";
}

// The requests for changes standing on `head` of PR `pr` that may direct
// Fix, and the blocking threads they opened. A listing that can't be read
// whole throws.
function requestsOn(cfg: Config, pr: number, head: string): Requests {
  const reviews = whole(listReviews(cfg, pr), `PR #${pr}'s reviews`);
  const comments = whole(
    listReviewComments(cfg, pr),
    `PR #${pr}'s review comments`,
  );
  const standing = standingOn(reviews, head).filter(
    (review) => review.state === "CHANGES_REQUESTED" && directs(cfg, review),
  );
  const ids = new Set(standing.map((review) => review.id));
  return {
    requests: standing.map((review) => ({
      id: review.id,
      author: review.author.login,
      landing: same(review.author.login, cfg.landingAccount),
      body: review.body,
    })),
    threads: comments
      .filter(
        (comment) =>
          comment.inReplyTo === null &&
          comment.review !== null &&
          ids.has(comment.review) &&
          !NIT.test(comment.body),
      )
      .map((comment) => ({
        id: comment.id,
        path: comment.path,
        line: comment.line,
        author: comment.author?.login ?? "ghost",
        body: comment.body,
      })),
    comments,
  };
}

function replyMark(run: string): string {
  return `<!-- issue-pipeline:fix-reply run=${run} -->`;
}

// Whether run `run` already replied in `thread`: a reply of the development
// account's that carries the run's mark.
function answeredBy(
  cfg: Config,
  requests: Requests,
  thread: BlockingThread,
  run: string,
): boolean {
  const mark = replyMark(run);
  return requests.comments.some(
    (comment) =>
      comment.inReplyTo === thread.id &&
      comment.author !== null &&
      same(comment.author.login, cfg.devAccount) &&
      comment.body.includes(mark),
  );
}

// Replies `text` in `thread` of PR `pr` for run `run`, which answered it at
// commit `head`.
function replyIn(
  cfg: Config,
  pr: number,
  thread: BlockingThread,
  answer: { run: string; head: string; text: string },
): void {
  const body = [
    answer.text,
    "",
    `<sub>Answered by Fix in ${answer.head}.</sub>`,
    replyMark(answer.run),
  ].join("\n");
  gh(cfg, "dev", [
    "api",
    "-X",
    "POST",
    `repos/${cfg.repo}/pulls/${pr}/comments/${thread.id}/replies`,
    "-f",
    `body=${body}`,
    "--silent",
  ]);
}

export type { BlockingThread, ChangeRequest, Requests };
export { answeredBy, replyIn, requestsOn };
