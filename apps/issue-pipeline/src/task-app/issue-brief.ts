// The issue as a task run's model sessions read it: the issue, the latest
// Gherkin, its comments and the discussion on its pull request (PR), all
// read fresh from GitHub. A start label endorses the issue's own text.
// Comments, reviews and review threads show only when their author is one
// of the repository's collaborators; the rest are withheld and counted,
// since a session must treat other people's words as untrusted data.
import { z } from "zod";
import type { IssueComment } from "./issue-github.ts";
import { type PullRequest, recovery, type Thread } from "./recovery.ts";
import type { TaskRun } from "./task-app.ts";

// The task whose marked comments hold the issue's Gherkin.
const GHERKIN_TASK = "gherkin";
const PR_COMMENT = z.looseObject({
  user: z.looseObject({ login: z.string() }).nullable(),
  body: z.string().nullable(),
  created_at: z.string(),
});

// Whether `login` is a collaborator, asked once per login.
function collaborators(run: TaskRun): (login: string | null) => boolean {
  const known = new Map<string, boolean>();
  return (login: string | null): boolean => {
    if (login === null) {
      return false;
    }
    const key = login.toLowerCase();
    const seen = known.get(key);
    if (seen !== undefined) {
      return seen;
    }
    const answer =
      run.github.read([
        "api",
        `repos/${run.issue.repo}/collaborators/${login}`,
        "--silent",
      ]) !== null;
    known.set(key, answer);
    return answer;
  };
}

// `entries` by trusted authors as sections, and a note of how many others
// were withheld.
function shown<T>(
  entries: readonly T[],
  author: (entry: T) => string | null,
  section: (entry: T) => string[],
  trusted: (login: string | null) => boolean,
): string[] {
  const lines: string[] = [];
  let withheld = 0;
  for (const entry of entries) {
    if (trusted(author(entry))) {
      lines.push(...section(entry));
    } else {
      withheld += 1;
    }
  }
  if (withheld > 0) {
    lines.push(
      `(${withheld} more by people who aren't collaborators were withheld.)`,
      "",
    );
  }
  if (lines.length === 0) {
    return ["(none)", ""];
  }
  return lines;
}

function commentSection(comment: IssueComment): string[] {
  return [
    "---",
    `@${comment.author ?? "ghost"} at ${comment.at}:`,
    "",
    comment.body,
    "",
  ];
}

// The latest Gherkin comment, written by an account that ran Gherkin.
function gherkinLines(run: TaskRun, base: string): string[] {
  const latest = recovery(run.github, GHERKIN_TASK, base)
    .earlierComments()
    .filter((earlier) => earlier.kind !== "end")
    .at(-1);
  if (latest === undefined) {
    return ["(none)", ""];
  }
  const { comment } = latest;
  return [
    `From @${comment.author ?? "ghost"} at ${comment.at}:`,
    "",
    comment.body,
    "",
  ];
}

function threadHeading(thread: Thread): string {
  if (thread.line === null) {
    return `#### \`${thread.path}\``;
  }
  return `#### \`${thread.path}\` line ${thread.line}`;
}

function pullLines(
  run: TaskRun,
  pull: PullRequest,
  trusted: (login: string | null) => boolean,
): string[] {
  const conversation = run.github
    .list(`repos/${run.issue.repo}/issues/${pull.number}/comments`, PR_COMMENT)
    .map(
      (row): IssueComment => ({
        id: 0,
        author: row.user?.login ?? null,
        body: row.body ?? "",
        at: row.created_at,
      }),
    );
  let status = "ready for review";
  if (pull.isDraft) {
    status = "a draft";
  }
  return [
    `## Pull request #${pull.number}: ${pull.title}`,
    "",
    `It is ${pull.state.toLowerCase()} and ${status}, from \`${pull.head}\` at ${pull.headSha} into \`${pull.base}\`.`,
    "",
    "### Reviews",
    "",
    ...shown(
      pull.reviews.filter((review) => review.body !== ""),
      (review) => review.author,
      (review) => [
        "---",
        `@${review.author ?? "ghost"}, ${review.state} on ${review.commit ?? "an unknown commit"}:`,
        "",
        review.body,
        "",
      ],
      trusted,
    ),
    "### Review threads",
    "",
    ...pull.threads.flatMap((thread) => [
      threadHeading(thread),
      "",
      ...shown(
        thread.comments,
        (comment) => comment.author,
        (comment) => [`@${comment.author ?? "ghost"}:`, "", comment.body, ""],
        trusted,
      ),
    ]),
    "### Conversation",
    "",
    ...shown(
      conversation,
      (comment) => comment.author,
      commentSection,
      trusted,
    ),
  ];
}

// The brief of `run`'s issue, whose repository's base branch is `base`,
// with `pull`'s discussion when the issue has a PR.
function issueBrief(
  run: TaskRun,
  base: string,
  pull: PullRequest | null,
): string {
  const trusted = collaborators(run);
  const issue = run.recovery.issue();
  const comments = run.recovery.comments();
  const lines = [
    `# #${issue.number}: ${issue.title}`,
    "",
    `Opened by @${issue.author ?? "ghost"}.`,
    "",
    issue.body || "(no body)",
    "",
    "## Gherkin",
    "",
    ...gherkinLines(run, base),
    "## Comments",
    "",
    ...shown(comments, (comment) => comment.author, commentSection, trusted),
  ];
  if (pull !== null) {
    lines.push(...pullLines(run, pull, trusted));
  }
  return lines.join("\n");
}

export { issueBrief };
