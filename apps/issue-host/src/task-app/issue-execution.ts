// GitHub issue lifecycle adapter. CLI identity provisioning stays in task-app.ts.
import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  runningLabel,
  startLabel,
  unmark,
} from "@ecosystem/task-runtime/issue/claims";
import type { Identity } from "@ecosystem/task-runtime/issue/invocation";
import type {
  IssueGitHub,
  IssueRef,
} from "@ecosystem/task-runtime/issue/issue-github";
import { marked } from "@ecosystem/task-runtime/issue/markers";
import {
  type Recovery,
  recovery,
} from "@ecosystem/task-runtime/issue/recovery";
import { STOP_LABEL, Stopped } from "@ecosystem/task-runtime/issue/stopped";
import { type Step, startRunRecord } from "./run-record.ts";

const ERROR_LIMIT = 2000;
// What a task's work gets: the issue, GitHub as this buddy, the readers of
// what earlier runs left there, its own marked comments, and the
// repository config file the buddy file names for the issue's repository,
// for a task that needs the repository's settings. Every write
// through `github`, `comment` or `edit` throws Stopped while `agents:stop` is on
// the issue; `checkStop` lets long work check between its own steps.
interface TaskRun {
  task: string;
  run: string;
  account: string;
  issue: IssueRef;
  // Repository settings and the verified buddy transport for private checkouts.
  config: string;
  gitAccount: { account: string; env: ReadonlyMap<string, string> };
  github: IssueGitHub;
  recovery: Recovery;
  checkStop: () => void;
  // Posts `text` with this task's hidden marker of `kind`, which
  // `recovery.earlierComments(kind)` finds in later runs.
  comment: (text: string, kind: string, payload: object) => void;
  // Replaces the body of comment `id`, such as one that
  // `recovery.earlierComments` found, with `text` and a marker of `kind`.
  edit: (id: number, text: string, kind: string, payload: object) => void;
}
interface TaskApp {
  id: string;
  work: (run: TaskRun) => Promise<void> | void;
}
type Outcome = "succeeded" | "failed" | "stopped";
type ExitStatus = 0 | 1;

function messageOf(error: unknown): string {
  let text = String(error);
  if (error instanceof Error) {
    text = error.message;
  }
  if (text.length > ERROR_LIMIT) {
    return `${text.slice(0, ERROR_LIMIT)}…`;
  }
  return text;
}

function code(text: string): string {
  return `\`${text}\``;
}

function endText(
  task: string,
  outcome: Outcome,
  step: Step,
  reason: string | null,
): string {
  const start = code(startLabel(task));
  if (outcome === "succeeded") {
    return `Task ${code(task)} finished.`;
  }
  if (outcome === "stopped") {
    return `Task ${code(task)} stopped at its ${step} step because ${code(STOP_LABEL)} is on the issue. To run it again, remove ${code(STOP_LABEL)} and apply ${start}.`;
  }
  return `Task ${code(task)} failed at its ${step} step:\n\n\`\`\`text\n${reason ?? "unknown error"}\n\`\`\`\n\nTo retry, apply ${start} again.`;
}

// Steps 2 to 4 of a run that won claim `claim`.
async function runClaimed(
  app: TaskApp,
  github: IssueGitHub,
  identity: Identity,
  claim: { start: number | null; claim: number },
): Promise<ExitStatus> {
  const { id: task } = app;
  const run = randomUUID();
  const record = startRunRecord({
    id: run,
    task,
    repo: github.issue.repo,
    issue: github.issue.number,
    account: github.account,
    claim: { start: claim.start, removal: claim.claim },
  });
  let step: Step = "mark";
  let outcome: Outcome = "succeeded";
  let reason: string | null = null;
  try {
    github.addLabel(runningLabel(task));
    step = "work";
    record.step(step);
    github.checkStop();
    await app.work({
      task,
      run,
      account: github.account,
      issue: github.issue,
      config: identity.config,
      gitAccount: { account: identity.account, env: identity.env },
      github,
      recovery: recovery(github, task, identity.base),
      checkStop: (): void => github.checkStop(),
      comment: (text: string, kind: string, payload: object): void =>
        github.comment(marked(text, task, kind, payload)),
      edit: (id: number, text: string, kind: string, payload: object): void =>
        github.editComment(id, marked(text, task, kind, payload)),
    });
  } catch (error) {
    if (error instanceof Stopped) {
      outcome = "stopped";
      reason = error.message;
    } else {
      outcome = "failed";
      reason = messageOf(error);
    }
  }
  const ended = step;
  step = "unmark";
  record.step(step);
  try {
    github.comment(
      marked(endText(task, outcome, ended, reason), task, "end", {
        run,
        start: claim.start,
        claim: claim.claim,
        outcome,
      }),
      { ending: true },
    );
    unmark(github, task, claim.claim);
  } catch (error) {
    outcome = "failed";
    reason = messageOf(error);
    try {
      github.comment(endText(task, outcome, step, reason), { ending: true });
    } catch {
      // GitHub took neither comment; stderr and the run record keep it.
    }
  }
  record.end(outcome, reason);
  if (outcome === "failed") {
    process.stderr.write(`task app ${task}: failed: ${reason ?? ""}\n`);
    return 1;
  }
  return 0;
}

export type { TaskApp, TaskRun };
export { code, messageOf, runClaimed };
