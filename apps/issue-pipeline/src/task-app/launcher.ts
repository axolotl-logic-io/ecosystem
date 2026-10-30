// The buddy as a launcher of task apps. It polls the repositories in its
// scope for open issues with a `start:X` label, where X is one of its
// tasks, and for each one it sees runs X's task app with the issue:
//
//   node "$ISSUE_PIPELINE_ROOT/X.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
//
// It checks nothing else first, not `agent:X:running`, earlier results nor
// `agents:stop`: the app's claim decides which buddy runs a start, and the
// app handles the stop. So it runs every start it sees, and two runs of one
// task on one issue can overlap. An app that fails changes nothing here:
// the launcher logs each app's exit status and leaves the reporting to the
// app.
//
// It refuses to start, before any effect, when its buddy file doesn't
// settle (buddy-file.ts), another buddy file in the same folder names its
// account, one of its tasks has no installed task app, or GitHub doesn't
// confirm its credential is its account's.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { wire } from "../discovery/wire.ts";
import { observeAll, unreadable } from "../github-observation.ts";
import { ROOT } from "../pipeline-root.ts";
import {
  type BuddyFile,
  type LaunchedTask,
  readBuddyFile,
  sharingAccount,
} from "./buddy-file.ts";
import { accountOf } from "./identity.ts";
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

// The installed program of `task`'s app.
function programOf(task: LaunchedTask): string {
  return path.join(ROOT, `${task}.mjs`);
}

function log(line: object): void {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`,
  );
}

// The launcher buddy file at `file`, refused unless it is the only one in
// its folder with its account and every one of its tasks has an app.
function launcherOf(file: string): BuddyFile {
  const buddy = readBuddyFile(file);
  const other = sharingAccount(buddy);
  if (other !== null) {
    throw new OpsError(
      `buddy config ${buddy.file}: buddy config ${other} is configured with the same account @${buddy.account}; each buddy needs its own`,
    );
  }
  for (const task of buddy.tasks) {
    const program = programOf(task);
    if (!fs.statSync(program, { throwIfNoEntry: false })?.isFile()) {
      throw new OpsError(
        `buddy config ${buddy.file}: task ${task} has no installed task app at ${program}`,
      );
    }
  }
  return buddy;
}

// Validates the launcher buddy at `file` without contacting GitHub.
function checkLauncher(file: string): Checked {
  const buddy = launcherOf(file);
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
      buddy.tasks.map((task) => [task, programOf(task)]),
    ),
  };
}

// Runs the launcher buddy at `file` until `stop` aborts, then waits for the
// task apps it launched to end. Each app ends on its own terms; the stop
// only ends the polling.
async function runLauncher(file: string, stop: AbortSignal): Promise<Ended> {
  const buddy = launcherOf(file);
  const { env } = accountOf(buddy);
  // Each app still running, with its end.
  const live = new Map<ChildProcess, Promise<void>>();

  function launch(task: LaunchedTask, repo: string, number: number): void {
    const issue = `${repo}#${number}`;
    // The app's stdout joins the buddy's stderr, keeping stdout for the
    // buddy's own final line.
    const child = spawn(
      process.execPath,
      [programOf(task), "--config", buddy.file, "--issue", issue],
      { stdio: ["ignore", STDERR, STDERR] },
    );
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
    for (const { repo } of buddy.repositories) {
      for (const task of buddy.tasks) {
        if (!stop.aborted) {
          for (const number of started(repo, task)) {
            launch(task, repo, number);
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
