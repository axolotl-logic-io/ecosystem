// The task app framework. A task is one command-line program:
//
//   node TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N
//
// The framework owns how a run starts, claims its work, reports and ends;
// a task supplies only its work. Every run goes through four steps:
//
//   1. Claim: remove `start:X` and confirm on the issue timeline that this
//      buddy's account removed it. A run that loses ends quietly.
//   2. Mark: add `agent:X:running`.
//   3. Work: the task's own work.
//   4. Unmark: post the run's end comment, then remove `agent:X:running`
//      unless another claim of X is still open.
//
// `agents:stop` holds claims and ends live runs: the framework checks it
// before the claim, between steps and before each write to GitHub. A run
// that won its claim always posts an end comment, which names the step and
// error when it failed, and never applies its start label again itself.
// The program exits 0 when the run ends normally, including when it loses
// the claim or is stopped, and 1 when it fails.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import { OpsError } from "../ops-error.ts";
import {
  claimStart,
  runningLabel,
  type Sleep,
  startLabel,
  unmark,
} from "./claims.ts";
import { type Identity, loadIdentity } from "./identity.ts";
import { IssueGitHub, type IssueRef } from "./issue-github.ts";
import { isTaskId, marked } from "./markers.ts";
import { type Recovery, recovery } from "./recovery.ts";
import { type Step, startRunRecord } from "./run-record.ts";
import { STOP_LABEL, Stopped } from "./stopped.ts";

const ISSUE_ARG = /^(?<repo>[\w.-]+\/[\w.-]+)#(?<number>[1-9]\d*)$/u;
const ERROR_LIMIT = 2000;
const USAGE = "usage: TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N";

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

function parseIssue(text: string | undefined): IssueRef {
  const { repo, number } = ISSUE_ARG.exec(text ?? "")?.groups ?? {};
  if (repo === undefined || number === undefined) {
    throw new OpsError(USAGE);
  }
  return { repo, number: Number(number) };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

// Runs `app` on the issue `argv` names, returning the program's exit
// status. `sleep` paces rereads of the timeline while it confirms a claim.
async function runTaskApp(
  app: TaskApp,
  argv: readonly string[],
  sleep: Sleep = wait,
): Promise<ExitStatus> {
  if (!isTaskId(app.id)) {
    throw new OpsError(`not a task id: ${app.id}`);
  }
  const { values } = parseArgs({
    args: [...argv],
    options: { config: { type: "string" }, issue: { type: "string" } },
    strict: true,
  });
  if (values.config === undefined) {
    throw new OpsError(USAGE);
  }
  const issue = parseIssue(values.issue);
  const identity = loadIdentity(values.config, issue.repo, app.id);
  const github = new IssueGitHub(issue, identity);
  if (github.stopped()) {
    return 0;
  }
  const claim = await claimStart(github, app.id, identity.claimWaitsMs, sleep);
  if (claim.state === "lost" || claim.state === "stopped") {
    return 0;
  }
  if (claim.state === "unconfirmed") {
    github.comment(
      marked(
        `Task ${code(app.id)} removed ${code(startLabel(app.id))} but couldn't confirm the claim: ${claim.reason}. If no run of ${code(app.id)} started, apply ${code(startLabel(app.id))} again.`,
        app.id,
        "end",
        {
          run: randomUUID(),
          start: claim.start,
          claim: null,
          outcome: "unconfirmed",
        },
      ),
      { ending: true },
    );
    return 1;
  }
  return runClaimed(app, github, identity, claim);
}

// The program's entry point: runs `app` with this process's arguments and
// sets its exit status.
async function main(app: TaskApp): Promise<void> {
  try {
    process.exitCode = await runTaskApp(app, process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`task app ${app.id}: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

export type { TaskApp, TaskRun };
export { main, runTaskApp };
