// The issue as its agents read it: issue.md in the run dir holds the issue
// and the comments of the pipeline and of allowed users only (Autumn,
// 2026-10-14). This module also owns the trusted-inputs revision: the hash of
// the inputs only an allowed person can change.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import { listComments } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { ghJson, isAllowedUser } from "./github.ts";
import { trustedInputBytes } from "./trusted-inputs.ts";

// An issue as GitHub's REST API gives it.
const ISSUE = z.looseObject({
  body: z.string().nullish(),
  title: z.string(),
  user: z.looseObject({ login: z.string() }),
});

type Issue = z.infer<typeof ISSUE>;

interface IssueContext {
  file: string;
  issue: Issue;
  comments: IssueComment[];
}

// The comments section of issue.md, and how many comments from users not on
// the allow list were left out.
function commentParts(
  cfg: Config,
  comments: readonly IssueComment[],
): { parts: string[]; dropped: number } {
  const parts: string[] = [];
  let dropped = 0;
  for (const item of comments) {
    const login = item.user?.login;
    if (isAllowedUser(cfg, login)) {
      const heading = `Comment by @${String(login)} (a person) at ${item.created_at}:`;
      parts.push("---", heading, "", item.body ?? "", "");
    } else {
      dropped += 1;
    }
  }
  return { dropped, parts };
}

// Explicit assignment is not a trust override. Recheck at each input boundary,
// before exposing requirements or creating any issue/claim artifacts.
function assertIssueAuthor(cfg: Config, issue: Pick<Issue, "user">): void {
  if (!isAllowedUser(cfg, issue.user.login)) {
    throw new OpsError(
      `issue author @${issue.user.login} is not on allowedUsers or not a collaborator`,
    );
  }
}

// Reads fresh issue requirements only when the actual author is still an
// allowed collaborator. Creates no checkout, claim, lease or issue file.
function authorizedIssue(cfg: Config, number: number): Issue {
  const issue = ISSUE.parse(
    ghJson(cfg, "landing", ["api", `repos/${cfg.repo}/issues/${number}`]),
  );
  assertIssueAuthor(cfg, issue);
  return issue;
}

// Writes issue.md for issue `number` and returns its path, the issue and its
// comments.
function writeIssueContext(cfg: Config, number: number): IssueContext {
  const issue = authorizedIssue(cfg, number);
  const comments = listComments(cfg, number);
  const { dropped, parts } = commentParts(cfg, comments);
  const lines = [
    `# #${number}: ${issue.title}`,
    "",
    `Author: @${issue.user.login}`,
    "",
    issue.body || "(no body)",
    "",
    ...parts,
  ];
  if (dropped > 0) {
    lines.push(
      "---",
      `(${dropped} comment(s) from users not on the pipeline's allow list were withheld.)`,
    );
  }
  const file = path.join(paths.runDir(cfg, number), "issue.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return { comments, file, issue };
}

// The trusted-inputs revision: sha256 over the issue's title and body and the
// bodies of its trusted comments, in id order. Visitor and pipeline comments
// never change it, so they can't send an issue back to the author.
function trustedInputsHash(
  cfg: Config,
  issue: Pick<Issue, "title" | "body" | "user">,
  comments: readonly IssueComment[],
): string {
  assertIssueAuthor(cfg, issue);
  const hash = createHash("sha256");
  hash.update(
    trustedInputBytes(
      issue,
      comments.filter((item) => isAllowedUser(cfg, item.user?.login)),
    ),
  );
  return hash.digest("hex");
}

export type { Issue, IssueContext };
export { authorizedIssue, ISSUE, trustedInputsHash, writeIssueContext };
