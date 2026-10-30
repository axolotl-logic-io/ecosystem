// Compatibility CLI: resolve operator identity, claim work and invoke the issue adapter.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  claimStart,
  type Sleep,
  startLabel,
} from "@ecosystem/task-runtime/issue/claims";
import type { IssueRef } from "@ecosystem/task-runtime/issue/issue-github";
import { isTaskId, marked } from "@ecosystem/task-runtime/issue/markers";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { loadIdentity } from "./identity.ts";
import {
  code,
  messageOf,
  runClaimed,
  type TaskApp,
} from "./issue-execution.ts";
import { issueGitHub } from "./issue-github.ts";

const ISSUE_ARG = /^(?<repo>[\w.-]+\/[\w.-]+)#(?<number>[1-9]\d*)$/u;
const USAGE = "usage: TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N";
type ExitStatus = 0 | 1;
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
  const github = issueGitHub(issue, identity);
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

export type { TaskApp, TaskRun } from "./issue-execution.ts";
export { main, runTaskApp };
