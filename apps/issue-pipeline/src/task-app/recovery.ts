// What earlier runs left on GitHub, read fresh by each run so it can
// continue from there: the issue and its comments, the issue's branch and
// its commits, the pull request (PR) from that branch with its reviews,
// review threads and required checks, and the task's own earlier comments,
// found by their hidden markers. Nothing is saved between runs; this is
// the whole record.
import { z } from "zod";
import { startLabel } from "./claims.ts";
import type { Issue, IssueComment, IssueGitHub } from "./issue-github.ts";
import { markOf } from "./markers.ts";

const REF = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const COMPARE = z.looseObject({
  commits: z.array(
    z.looseObject({
      sha: z.string(),
      commit: z.looseObject({ message: z.string() }),
    }),
  ),
});
const PULLS = z.array(
  z.looseObject({
    number: z.number().int().positive(),
    state: z.string(),
    isDraft: z.boolean(),
    headRefName: z.string(),
    headRefOid: z.string(),
    baseRefName: z.string(),
    title: z.string(),
    body: z.string(),
  }),
);
const REVIEW = z.looseObject({
  id: z.number().int().positive(),
  user: z.looseObject({ login: z.string() }).nullable(),
  state: z.string(),
  commit_id: z.string().nullable(),
  body: z.string().nullable(),
});
const REVIEW_COMMENT = z.looseObject({
  id: z.number().int().positive(),
  in_reply_to_id: z.number().int().positive().optional(),
  user: z.looseObject({ login: z.string() }).nullable(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  body: z.string(),
});
const CHECKS = z.array(
  z.looseObject({ name: z.string(), state: z.string(), bucket: z.string() }),
);
const NO_CHECKS = /no (?:required )?checks reported/iu;

interface Branch {
  name: string;
  head: string;
  // The branch's commits that its base doesn't have, oldest first.
  commits: { sha: string; message: string }[];
}
interface Review {
  id: number;
  author: string | null;
  state: string;
  commit: string | null;
  body: string;
}
interface ThreadComment {
  id: number;
  author: string | null;
  body: string;
}
interface Thread {
  path: string;
  line: number | null;
  comments: ThreadComment[];
}
interface Check {
  name: string;
  state: string;
  bucket: string;
}
interface PullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  head: string;
  headSha: string;
  base: string;
  title: string;
  body: string;
  reviews: Review[];
  threads: Thread[];
  checks: Check[];
}
// One of the task's earlier comments, with its marker's kind and payload.
interface EarlierComment {
  comment: IssueComment;
  kind: string;
  payload: unknown;
}
interface Recovery {
  issue: () => Issue;
  comments: () => IssueComment[];
  branch: () => Branch | null;
  pullRequest: () => PullRequest | null;
  earlierComments: (kind?: string) => EarlierComment[];
}

function branchName(issue: number): string {
  return `agent/issue-${issue}`;
}

function threadsOf(rows: z.output<typeof REVIEW_COMMENT>[]): Thread[] {
  const threads = new Map<number, Thread>();
  for (const row of rows) {
    const comment = {
      id: row.id,
      author: row.user?.login ?? null,
      body: row.body,
    };
    const root = row.in_reply_to_id;
    const thread = threads.get(root ?? row.id);
    if (thread !== undefined) {
      thread.comments.push(comment);
    } else if (root === undefined) {
      threads.set(row.id, {
        path: row.path,
        line: row.line ?? null,
        comments: [comment],
      });
    }
  }
  return [...threads.values()];
}

// gh exits 0 when every required check passed, 8 while some are pending
// and 1 when some failed, printing them each time.
function checksOf(github: IssueGitHub, pull: number): Check[] {
  const args = [
    "pr",
    "checks",
    String(pull),
    "-R",
    github.issue.repo,
    "--required",
    "--json",
    "name,state,bucket",
  ];
  const result = github.readResult(args);
  if (result.code !== 0 && NO_CHECKS.test(result.stderr)) {
    return [];
  }
  let printed: unknown = null;
  try {
    printed = JSON.parse(result.stdout);
  } catch {
    printed = null;
  }
  const checks = CHECKS.safeParse(printed);
  if (!checks.success) {
    throw github.failure(args, result);
  }
  return checks.data;
}

// Readers of issue `github.issue` for task `task`, whose base branch is
// `base`.
function recovery(github: IssueGitHub, task: string, base: string): Recovery {
  const { repo, number } = github.issue;
  const name = branchName(number);
  return {
    issue: (): Issue => github.issueNow(),
    comments: (): IssueComment[] => github.comments(),
    branch: (): Branch | null => {
      const ref = github.readJson([
        "api",
        `repos/${repo}/git/ref/heads/${name}`,
      ]);
      if (ref === null) {
        return null;
      }
      const head = REF.parse(ref).object.sha;
      const compared = COMPARE.parse(
        github.readJson([
          "api",
          `repos/${repo}/compare/${encodeURIComponent(base)}...${name}`,
        ]),
      );
      return {
        name,
        head,
        commits: compared.commits.map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message,
        })),
      };
    },
    pullRequest: (): PullRequest | null => {
      const pulls = PULLS.parse(
        github.readJson([
          "pr",
          "list",
          "-R",
          repo,
          "--head",
          name,
          "--state",
          "all",
          "--json",
          "number,state,isDraft,headRefName,headRefOid,baseRefName,title,body",
        ]) ?? [],
      ).sort((a, b) => b.number - a.number);
      const pull =
        pulls.find((candidate) => candidate.state === "OPEN") ?? pulls[0];
      if (pull === undefined) {
        return null;
      }
      const path = `repos/${repo}/pulls/${pull.number}`;
      return {
        number: pull.number,
        state: pull.state,
        isDraft: pull.isDraft,
        head: pull.headRefName,
        headSha: pull.headRefOid,
        base: pull.baseRefName,
        title: pull.title,
        body: pull.body,
        reviews: github.list(`${path}/reviews`, REVIEW).map((review) => ({
          id: review.id,
          author: review.user?.login ?? null,
          state: review.state,
          commit: review.commit_id,
          body: review.body ?? "",
        })),
        threads: threadsOf(github.list(`${path}/comments`, REVIEW_COMMENT)),
        checks: checksOf(github, pull.number),
      };
    },
    // Comments with this task's markers, by accounts that have claimed
    // this task on the issue: only they could have run it.
    earlierComments: (kind?: string): EarlierComment[] => {
      const label = startLabel(task);
      const claimers = new Set(
        github
          .labelEvents()
          .filter(
            (event) => event.kind === "unlabeled" && event.label === label,
          )
          .flatMap((event) => event.actor?.toLowerCase() ?? []),
      );
      return github.comments().flatMap((comment): EarlierComment[] => {
        const mark = markOf(comment.body);
        if (
          mark === null ||
          mark.task !== task ||
          (kind !== undefined && mark.kind !== kind) ||
          !claimers.has(comment.author?.toLowerCase() ?? "")
        ) {
          return [];
        }
        return [{ comment, kind: mark.kind, payload: mark.payload }];
      });
    },
  };
}

export type {
  Branch,
  Check,
  EarlierComment,
  PullRequest,
  Recovery,
  Review,
  Thread,
};
export { branchName, recovery };
