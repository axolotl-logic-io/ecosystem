// Compatibility CLI: resolve operator identity, claim work and invoke the issue adapter.

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
  issueCredentials,
  issueInvocation,
} from "@ecosystem/task-runtime/issue/invocation";
import type { IssueRef } from "@ecosystem/task-runtime/issue/issue-github";
import { isTaskId, marked } from "@ecosystem/task-runtime/issue/markers";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { loadIdentity } from "../../../launcher/src/identity.ts";
import {
  code,
  messageOf,
  runClaimed,
  type TaskApp,
} from "./issue-execution.ts";
import { issueGitHub } from "./issue-github.ts";

const CREDENTIAL_FD = 3;
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
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      invocation: { type: "boolean", default: false },
    },
    strict: true,
  });
  let issue: IssueRef;
  let identity: import("@ecosystem/task-runtime/issue/invocation").Identity;
  if (values.invocation) {
    if (values.config !== undefined || values.issue !== undefined) {
      throw new OpsError("invocation cannot include buddy CLI arguments");
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
      throw new OpsError(
        "invocation account does not match provisioned account",
      );
    }
    for (const name of credentials.hiddenVariables) {
      hideCredentialVariable(name);
    }
    ({ issue } = invocation);
    identity = {
      ...invocation.settings,
      account: invocation.account,
      env: new Map(credentials.env),
    };
  } else {
    if (values.config === undefined) {
      throw new OpsError(USAGE);
    }
    issue = parseIssue(values.issue);
    identity = loadIdentity(values.config, issue.repo, app.id);
  }
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
