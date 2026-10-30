// The issue as a task app's model session reads it: one Markdown file with
// the issue and the comments a session may treat as input. A person's words
// are shown only when the repository config's `allowedUsers` names them and
// GitHub still lists them as a collaborator. A task run's comment is shown
// when it carries the marker of a task whose start its author claimed on
// the issue, as `recovery.earlierComments` counts them; end comments are
// left out. Everything else is withheld, so other people's words never
// reach a session.
import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { IssueComment, IssueGitHub } from "./issue-github.ts";
import { markOf } from "./markers.ts";

const START = /^start:(?<task>[a-z][a-z0-9-]*)$/u;

// Who may speak in the file: the people the operator allows, and the
// accounts that are the pipeline's and so never count as a person.
interface Trust {
  allowedUsers: readonly string[];
  pipeline: readonly string[];
}

function lower(login: string): string {
  return login.toLowerCase();
}

// Each task's claimers: the accounts that removed its start label.
function claimersOf(github: IssueGitHub): Map<string, Set<string>> {
  const claimers = new Map<string, Set<string>>();
  for (const event of github.labelEvents()) {
    const { task } = START.exec(event.label)?.groups ?? {};
    if (event.kind === "unlabeled" && task !== undefined) {
      const accounts = claimers.get(task) ?? new Set<string>();
      accounts.add(lower(event.actor ?? ""));
      claimers.set(task, accounts);
    }
  }
  return claimers;
}

// Whether `login` is a trusted person: allowed, not the pipeline's, and a
// collaborator now. Asks GitHub at most once per login.
function personCheck(
  github: IssueGitHub,
  trust: Trust,
): (login: string | null) => boolean {
  const allowed = new Set(trust.allowedUsers.map(lower));
  const pipeline = new Set(trust.pipeline.map(lower));
  const known = new Map<string, boolean>();
  return (login: string | null): boolean => {
    if (login === null || login === "") {
      return false;
    }
    const name = lower(login);
    if (!allowed.has(name) || pipeline.has(name)) {
      return false;
    }
    let found = known.get(name);
    if (found === undefined) {
      const endpoint = `repos/${github.issue.repo}/collaborators/${login}`;
      found = github.read(["api", endpoint, "--silent"]) !== null;
      known.set(name, found);
    }
    return found;
  };
}

// The heading of `comment` in the file, or null when it is withheld.
function headingOf(
  comment: IssueComment,
  isPerson: (login: string | null) => boolean,
  claimers: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const mark = markOf(comment.body);
  if (mark !== null) {
    const claimed = claimers.get(mark.task)?.has(lower(comment.author ?? ""));
    if (claimed === true && mark.kind !== "end") {
      return `Comment by the pipeline's \`${mark.task}\` task at ${comment.at}:`;
    }
    return null;
  }
  if (isPerson(comment.author)) {
    return `Comment by @${String(comment.author)} (a person) at ${comment.at}:`;
  }
  return null;
}

// Returns trusted issue context. Rejects an untrusted issue author because
// the issue body is the request. Storage and model execution remain host-owned.
function issueContext(github: IssueGitHub, trust: Trust): string {
  const isPerson = personCheck(github, trust);
  const issue = github.issueNow();
  if (!isPerson(issue.author)) {
    throw new OpsError(
      `issue author @${String(issue.author)} is not on allowedUsers or not a collaborator`,
    );
  }
  const claimers = claimersOf(github);
  const lines = [
    `# #${issue.number}: ${issue.title}`,
    "",
    `Author: @${String(issue.author)}`,
    "",
    issue.body || "(no body)",
    "",
  ];
  let withheld = 0;
  for (const comment of github.comments()) {
    const heading = headingOf(comment, isPerson, claimers);
    if (heading === null) {
      withheld += 1;
    } else {
      lines.push("---", heading, "", comment.body, "");
    }
  }
  if (withheld > 0) {
    lines.push(
      "---",
      `(${withheld} other comment(s) were withheld: they are from people not on the pipeline's allow list, or the pipeline's own records.)`,
    );
  }
  return lines.join("\n");
}

function writeIssueFile(github: IssueGitHub, trust: Trust, file: string): void {
  const context = issueContext(github, trust);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, context);
}

export type { Trust };
export { issueContext, writeIssueFile };
