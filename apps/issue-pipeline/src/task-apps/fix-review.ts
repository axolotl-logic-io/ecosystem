// Fix answers standing requests from Verify or repository writers. Replies
// from its own account and GitHub's resolved threads are the recovery record.
import { z } from "zod";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { IssueGitHub } from "../task-app/issue-github.ts";
import type { PullRequest, Review, Thread } from "../task-app/recovery.ts";

const NIT = /^\W*(?:nit|non-blocking)\b/iu;
const PERMISSION = z.looseObject({ permission: z.string() });
const PAGE = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              comments: z.object({
                nodes: z
                  .array(z.object({ databaseId: z.number().int().positive() }))
                  .length(1),
              }),
            }),
          ),
          pageInfo: z.object({
            hasNextPage: z.boolean(),
            endCursor: z.string().nullable(),
          }),
        }),
      }),
    }),
  }),
});
const FIX_ROUNDS = 3;

function same(a: string | null, b: string): boolean {
  return a?.toLowerCase() === b.toLowerCase();
}

function canDirect(
  github: IssueGitHub,
  author: string | null,
  verify: string,
): boolean {
  if (author === null) {
    return false;
  }
  if (same(author, verify)) {
    return true;
  }
  const answer = github.readJson([
    "api",
    `repos/${github.issue.repo}/collaborators/${encodeURIComponent(author)}/permission`,
  ]);
  if (answer === null) {
    return false;
  }
  const found = PERMISSION.parse(answer);
  return ["admin", "maintain", "write"].includes(found.permission);
}

function unresolved(github: IssueGitHub, pull: number): Set<number> {
  const [owner, repo] = github.issue.repo.split("/");
  const ids = new Set<number>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const query: string = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(repo)}) { pullRequest(number:${pull}) { reviewThreads(first:100, after:${JSON.stringify(cursor)}) { nodes { isResolved comments(first:1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }`;
    const page = PAGE.parse(
      github.readJson(["api", "graphql", "-f", `query=${query}`]),
    ).data.repository.pullRequest.reviewThreads;
    for (const thread of page.nodes) {
      const [comment] = thread.comments.nodes;
      if (!thread.isResolved && comment !== undefined) {
        ids.add(comment.databaseId);
      }
    }
    if (!page.pageInfo.hasNextPage) {
      return ids;
    }
    cursor = page.pageInfo.endCursor;
    if (cursor === null || cursors.has(cursor)) {
      throw new OpsError("review thread listing did not advance");
    }
    cursors.add(cursor);
  }
}

interface FixReview {
  rounds: number;
  limit: boolean;
  requests: Review[];
  threads: Thread[];
}

function fixReview(
  github: IssueGitHub,
  pull: PullRequest,
  verify: string,
): FixReview {
  const rounds = pull.reviews.filter(
    (review) =>
      same(review.author, verify) && review.state === "CHANGES_REQUESTED",
  ).length;
  if (rounds > FIX_ROUNDS) {
    return { rounds, limit: true, requests: [], threads: [] };
  }
  const latest = new Map<string, Review>();
  for (const review of [...pull.reviews].sort((a, b) => a.id - b.id)) {
    if (
      review.author !== null &&
      ["CHANGES_REQUESTED", "APPROVED", "DISMISSED"].includes(review.state)
    ) {
      latest.set(review.author.toLowerCase(), review);
    }
  }
  const requests = [...latest.values()].filter(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      canDirect(github, review.author, verify),
  );
  const reviews = new Set(requests.map((review) => review.id));
  const open = unresolved(github, pull.number);
  const threads = pull.threads.filter((thread) => {
    const [root] = thread.comments;
    return (
      root !== undefined &&
      root.review !== null &&
      reviews.has(root.review) &&
      open.has(root.id) &&
      !NIT.test(root.body) &&
      !thread.comments
        .slice(1)
        .some((comment) => same(comment.author, github.account))
    );
  });
  // The third requested round is allowed; a fourth needs a person.
  return { rounds, limit: rounds > FIX_ROUNDS, requests, threads };
}

// Include only repository writers' issue text in the model's task.
function issueText(github: IssueGitHub, verify: string): string {
  const issue = github.issueNow();
  if (!canDirect(github, issue.author, verify)) {
    throw new OpsError("cannot establish the issue author's write access");
  }
  const comments = github
    .comments()
    .filter((comment) => canDirect(github, comment.author, verify));
  return JSON.stringify({ title: issue.title, body: issue.body, comments });
}

export type { FixReview };
export { FIX_ROUNDS, fixReview, issueText };
