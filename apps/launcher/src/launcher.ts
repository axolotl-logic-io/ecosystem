// One buddy discovers starts and launches registered subprocesses. Claims belong to children.
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { childEnvironment } from "@ecosystem/task-runtime/child-env";
import {
  observeAll,
  unreadable,
} from "@ecosystem/task-runtime/issue/github-observation";
import { issueInvocation } from "@ecosystem/task-runtime/issue/invocation";
import { wire } from "@ecosystem/task-runtime/issue/wire";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";

import {
  type BuddyFile,
  type BuddyRepository,
  type LaunchedTask,
  readBuddyFile,
  sharingAccount,
} from "./buddy-file.ts";
import { accountOf } from "./identity.ts";
import { readManifest } from "./manifest.ts";
import { pause } from "./stop.ts";

const MS_PER_SECOND = 1000;
const STDERR = 2;
const LISTED_ISSUE = wire(
  z.looseObject({
    number: z.number().int().positive(),
    pullRequest: z.unknown().optional(),
  }),
);

// What `buddy --check` prints for a launcher buddy it accepts.
interface Checked {
  buddy: string;
  account: string;
  tasks: readonly LaunchedTask[];
  repositories: { config: string; repo: string; base: string }[];
  apps: Record<string, string>;
}
interface Ended {
  buddy: string;
  kind: "stopped";
  reason: string;
}

function log(line: object): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`,
  );
}

function programFor(
  programs: ReadonlyMap<string, string>,
  task: string,
): string {
  const program = programs.get(task);
  if (program === undefined) {
    throw new OpsError(`task ${task} has no installed task app registration`);
  }
  return program;
}

// The launcher buddy file at `file`, refused unless it is the only one in
// its folder with its account and every one of its tasks has an app.
function launcherOf(
  file: string,
  manifest: string,
): { buddy: BuddyFile; programs: ReadonlyMap<string, string> } {
  const buddy = readBuddyFile(file);
  const programs = readManifest(manifest);
  const other = sharingAccount(buddy);
  if (other !== null) {
    throw new OpsError(
      `buddy config ${buddy.file}: buddy config ${other} is configured with the same account @${buddy.account}; each buddy needs its own`,
    );
  }
  for (const task of buddy.tasks) {
    if (!programs.has(task)) {
      throw new OpsError(`task ${task} has no installed task app registration`);
    }
  }
  return { buddy, programs };
}

// Validates the launcher buddy at `file` without contacting GitHub.
function checkLauncher(file: string, manifest: string): Checked {
  const { buddy, programs } = launcherOf(file, manifest);
  return {
    buddy: buddy.name,
    account: buddy.account,
    tasks: buddy.tasks,
    repositories: buddy.repositories.map(({ config, repo, base }) => ({
      config,
      repo,
      base,
    })),
    apps: Object.fromEntries(
      buddy.tasks.map((task) => [task, programFor(programs, task)]),
    ),
  };
}

// Runs the launcher buddy at `file` until `stop` aborts, then waits for the
// task apps it launched to end. Each app ends on its own terms; the stop
// only ends the polling.
async function runLauncher(
  file: string,
  manifest: string,
  stop: AbortSignal,
): Promise<Ended> {
  const { buddy, programs } = launcherOf(file, manifest);
  const { env } = accountOf(buddy);
  // Each app still running, with its end.
  const live = new Map<ChildProcess, Promise<void>>();

  function launch(
    task: LaunchedTask,
    repository: BuddyRepository,
    number: number,
  ): void {
    const issue = `${repository.repo}#${number}`;
    const invocation = issueInvocation.parse({
      version: 1,
      task,
      issue: { repo: repository.repo, number },
      settings: {
        config: repository.config,
        base: repository.base,
        claimWaitsMs: buddy.claimWaitsMs,
      },
      account: buddy.account,
    });
    // The app's stdout joins the buddy's stderr, keeping stdout for the
    // buddy's own final line.
    const child = spawn(
      process.execPath,
      [programFor(programs, task), "--invocation"],
      {
        env: childEnvironment(process.env),
        stdio: ["pipe", STDERR, STDERR, "pipe"],
      },
    );
    // Credentials travel on a separate inherited pipe, never argv, files or invocation JSON.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(invocation));
    const [, , , channel] = child.stdio;
    if (channel !== null && channel !== undefined && "end" in channel) {
      channel.on("error", () => undefined);
      channel.end(
        JSON.stringify({
          account: buddy.account,
          env: [...env],
          hiddenVariables: [buddy.credentials.variable],
        }),
      );
    }
    const ended = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        log({ buddy: buddy.name, task, issue, error: error.message });
        live.delete(child);
        resolve();
      });
      child.once("close", (exit, signal) => {
        log({ buddy: buddy.name, task, issue, pid: child.pid, exit, signal });
        live.delete(child);
        resolve();
      });
    });
    live.set(child, ended);
  }

  // The open issues, not pull requests, that carry `start:TASK` in `repo`.
  function started(repo: string, task: LaunchedTask): number[] {
    const listed = observeAll(
      env,
      `repos/${repo}/issues?state=open&labels=${encodeURIComponent(`start:${task}`)}`,
      LISTED_ISSUE,
    );
    if (listed.status !== "ok") {
      log({
        buddy: buddy.name,
        repo,
        task,
        state: "warning",
        reason: `cannot list issues with start:${task}: ${unreadable(listed)}`,
      });
      return [];
    }
    return listed.value
      .filter((row) => row.pullRequest === undefined)
      .map((row) => row.number);
  }

  async function poll(): Promise<void> {
    for (const repository of buddy.repositories) {
      const { repo } = repository;
      for (const task of buddy.tasks) {
        if (!stop.aborted) {
          for (const number of started(repo, task)) {
            if (!stop.aborted) {
              launch(task, repository, number);
            }
          }
        }
      }
    }
    await pause(buddy.pollSeconds * MS_PER_SECOND, stop);
    if (!stop.aborted) {
      await poll();
    }
  }

  await poll();
  await Promise.all(live.values());
  return { buddy: buddy.name, kind: "stopped", reason: String(stop.reason) };
}

export type { Checked, Ended };
export { checkLauncher, runLauncher };
