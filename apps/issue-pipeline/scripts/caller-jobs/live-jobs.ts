// The stage jobs running on this machine, and whether one more may start
// beside them. A job counts while its pid is a job.mjs process, whether the
// caller's receipts or a job.json under the pipeline's runs/ names it. A
// task job (#186) counts like any job, under its task's own stage cap and
// attempts: it bypasses no cap, exclusion or serialization.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../../src/config.ts";
import { readStatus } from "../../src/job/status.ts";
import type { JobTask } from "../../src/job/task-request.ts";
import { ROOT } from "../../src/pipeline-root.ts";
import { run } from "../../src/process.ts";
import type { Stage } from "../../src/stages.ts";

const JOB_ENTRY = "job.mjs";
const ISSUE_FOLDER = /^issue-\d+$/u;
const PS_TIMEOUT_MS = 10_000;

// A live stage job, and what it works on: its stage, or its task. Only a
// receipt names its branch; job.json doesn't.
interface LiveJob {
  slug: string;
  issue: number;
  stage: string;
  work: string;
  pid: number;
  branch: string | null;
}

// The run's caps and exclusions, as run.json sets them.
interface Caps {
  maxJobs: number;
  maxStageJobs: Partial<Record<Stage | JobTask, number>>;
  maxAttempts: number;
  excludedIssues: Record<string, number[]>;
}

// The job a caller asks to start, what it works on (its stage, or its
// task), and its attempt at that.
interface Request {
  cfg: Config;
  issue: number;
  stage: Stage;
  work: Stage | JobTask;
  branch: string;
  attempt: number;
}

// Whether process `pid` exists, even one this user can't signal.
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

// True while `pid` runs a stage job: it exists and its command names job.mjs,
// so a reused pid doesn't count. When ps can't say, because the process
// ended meanwhile or ps failed, a process that still exists does.
function isStageJob(pid: number): boolean {
  if (!exists(pid)) {
    return false;
  }
  const ps = run("ps", ["-o", "command=", "-p", String(pid)], {
    allowFail: true,
    timeoutMs: PS_TIMEOUT_MS,
  });
  if (ps.code !== 0) {
    return exists(pid);
  }
  return ps.stdout.includes(JOB_ENTRY);
}

// The folders in `dir`, or none when it can't be read.
function folders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Jobs whose job.json under the pipeline's runs/ names a live pid.
function statusFileJobs(): LiveJob[] {
  return folders(path.join(ROOT, "runs")).flatMap((repoDir) =>
    folders(repoDir)
      .filter((dir) => ISSUE_FOLDER.test(path.basename(dir)))
      .flatMap((dir): LiveJob[] => {
        const status = readStatus(dir);
        if (status === null || !isStageJob(status.pid)) {
          return [];
        }
        const { issue, stage, pid } = status;
        const slug = path.basename(repoDir);
        const work = status.task?.task.toLowerCase() ?? stage;
        return [{ slug, issue, stage, work, pid, branch: null }];
      }),
  );
}

// The live jobs among `receipts`, then every other live job a job.json names.
function liveJobs(receipts: readonly LiveJob[]): LiveJob[] {
  const live = receipts.filter((job) => isStageJob(job.pid));
  const known = new Set(live.map((job) => job.pid));
  const others = statusFileJobs().filter((job) => !known.has(job.pid));
  return [...live, ...others];
}

// Why `request` mustn't start beside `live` under `caps`, or null when it
// may: an excluded issue, a stage or task out of attempts, a full cap, a
// live job on the same issue or branch, or a second merge in one repo. A
// task counts under its own stage cap, and a merge stage job alone writes
// the target.
function refusalOf(
  caps: Caps,
  request: Request,
  live: readonly LiveJob[],
): string | null {
  const { cfg, issue, work, branch, attempt } = request;
  const sameRepo = live.filter((job) => job.slug === cfg.slug);
  const atStage = live.filter((job) => job.work === work).length;
  const stageCap = caps.maxStageJobs[work] ?? Number.POSITIVE_INFINITY;
  const refusals: [boolean, string][] = [
    [
      (caps.excludedIssues[cfg.repo] ?? []).includes(issue),
      `#${issue} is excluded this run`,
    ],
    [
      attempt > caps.maxAttempts,
      `#${issue} ${work} has used its ${caps.maxAttempts} attempts`,
    ],
    [
      live.length >= caps.maxJobs,
      `${live.length} jobs are live; the cap is ${caps.maxJobs}`,
    ],
    [
      atStage >= stageCap,
      `${atStage} ${work} jobs are live; the cap is ${stageCap}`,
    ],
    [
      sameRepo.some((job) => job.issue === issue),
      `#${issue} already has a live job`,
    ],
    [
      sameRepo.some((job) => job.branch === branch),
      `branch ${branch} already has a live job`,
    ],
    [
      work === "merge" && sameRepo.some((job) => job.work === "merge"),
      `${cfg.repo} already has a live merge job`,
    ],
  ];
  return refusals.find(([refused]) => refused)?.[1] ?? null;
}

export type { Caps, LiveJob, Request };
export { folders, isStageJob, JOB_ENTRY, liveJobs, refusalOf };
