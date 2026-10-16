// The issue as its agents read it: issue.md in the run dir holds the issue and
// the comments of the pipeline and of allowed users only (Autumn, 2026-10-14),
// and spec.md beside it holds a spec too long for the saved state (#280).

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import { listComments, pipelineRole } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { ghJson, isAllowedUser } from "./github.ts";

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

// How issue.md shows a comment: under a heading naming its author, hidden
// (the state and claim comments), or withheld because its author isn't trusted.
type Shown =
  | { kind: "shown"; heading: string }
  | { kind: "hidden" }
  | { kind: "withheld" };

function shownAs(cfg: Config, item: IssueComment): Shown {
  const login = item.user?.login;
  const role = pipelineRole(cfg, item);
  const at = item.created_at;
  if (role === "state" || role === "claim") {
    return { kind: "hidden" };
  }
  if (role !== null) {
    const heading = `Comment by the pipeline's ${role} agent at ${at}:`;
    return { heading, kind: "shown" };
  }
  if (isAllowedUser(cfg, login)) {
    const heading = `Comment by @${String(login)} (a person) at ${at}:`;
    return { heading, kind: "shown" };
  }
  return { kind: "withheld" };
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
    const shown = shownAs(cfg, item);
    if (shown.kind === "shown") {
      parts.push("---", shown.heading, "", item.body ?? "", "");
    } else if (shown.kind === "withheld") {
      dropped += 1;
    }
  }
  return { dropped, parts };
}

// Writes issue.md for issue `number` and returns its path, the issue and its
// comments.
function writeIssueContext(cfg: Config, number: number): IssueContext {
  const issue = ISSUE.parse(
    ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${number}`]),
  );
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

// Writes issue `number`'s full spec to spec.md in its run dir and returns the
// file's absolute path.
function writeSpecFile(cfg: Config, number: number, spec: string): string {
  const file = path.resolve(paths.runDir(cfg, number), "spec.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, spec);
  return file;
}

export type { Issue, IssueContext };
export { writeIssueContext, writeSpecFile };
