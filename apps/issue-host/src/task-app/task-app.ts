// A task program's entry point, `TASK.mjs --invocation`: read the launcher's
// invocation from stdin and the buddy's credentials from fd 3, claim the
// issue's start label and run the claimed lifecycle (issue-execution.ts).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { hideCredentialVariable } from "@ecosystem/task-runtime/child-env";
import {
  claimStart,
  type Sleep,
  startLabel,
} from "@ecosystem/task-runtime/issue/claims";
import {
  type Identity,
  issueCredentials,
  issueInvocation,
} from "@ecosystem/task-runtime/issue/invocation";
import { isTaskId, marked } from "@ecosystem/task-runtime/issue/markers";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import {
  code,
  messageOf,
  runClaimed,
  type TaskApp,
} from "./issue-execution.ts";
import { issueGitHub } from "./issue-github.ts";

const CREDENTIAL_FD = 3;
const USAGE = "usage: TASK.mjs --invocation";
type ExitStatus = 0 | 1;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Runs `app` on the issue its invocation names, returning the program's
// exit status. `sleep` paces rereads of the timeline while it confirms a claim.
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
    options: { invocation: { type: "boolean", default: false } },
    strict: true,
  });
  if (!values.invocation) {
    throw new OpsError(USAGE);
  }
  const invocation = issueInvocation.parse(
    JSON.parse(fs.readFileSync(0, "utf8")),
  );
  if (invocation.task !== app.id) {
    throw new OpsError(`invocation task does not match ${app.id}`);
  }
  const credentials = issueCredentials.parse(
    JSON.parse(fs.readFileSync(CREDENTIAL_FD, "utf8")),
  );
  fs.closeSync(CREDENTIAL_FD);
  if (credentials.account !== invocation.account) {
    throw new OpsError("invocation account does not match provisioned account");
  }
  for (const name of credentials.hiddenVariables) {
    hideCredentialVariable(name);
  }
  const { issue } = invocation;
  const identity: Identity = {
    ...invocation.settings,
    account: invocation.account,
    env: new Map(credentials.env),
  };
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
