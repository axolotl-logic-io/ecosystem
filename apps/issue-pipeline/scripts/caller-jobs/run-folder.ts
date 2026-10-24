// The caller's run folder: the run's limits, which caller-jobs/run-limits.ts
// reads, and one receipt folder per job it starts,
// `jobs/SLUG/issue-N/STAGE-ATTEMPT/`, or `TASK-ATTEMPT/` for a task job. A receipt holds the job's pid and
// command (`launch.json`), its stdout, whose last line is the job's result,
// and its stderr. The first report that finds the job ended copies its
// `job.json`, which the next job on the issue would replace, and marks it
// reported (`ended.json`). This module alone knows the receipts' layout.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readStatus } from "../../src/job/status.ts";
import type { TaskReport } from "../../src/job/task-request.ts";
import { JOB_TASKS, TASK_VERDICTS } from "../../src/job/task-request.ts";
import { ROOT } from "../../src/pipeline-root.ts";
import { STAGES } from "../../src/stages.ts";
import { folders, isStageJob } from "./live-jobs.ts";
import { COUNT } from "./run-limits.ts";

const LAUNCH_FILE = "launch.json";
const STDOUT_FILE = "stdout.log";
const STDERR_FILE = "stderr.log";
const JOB_FILE = "job.json";
const ENDED_FILE = "ended.json";
// How much of a failed job's stderr its report shows.
const STDERR_TAIL_CHARS = 2000;

const LAUNCH = z.object({
  repo: z.string(),
  slug: z.string(),
  issue: COUNT,
  stage: z.enum(STAGES),
  // A task job's task and the binding it was asked to run (#186).
  task: z.enum(JOB_TASKS).optional(),
  binding: z.unknown().optional(),
  branch: z.string(),
  lane: z.string(),
  attempt: COUNT,
  jobId: z.string(),
  pid: COUNT,
  startedAt: z.string(),
  argv: z.array(z.string()),
});
// The line a job prints as it ends (docs/reference/coordination.md): a task
// job's adds `task`, its run's report, and a waiting stage's `request`.
const RESULT = z.looseObject({
  issue: z.number(),
  stage: z.string(),
  end: z.string(),
  task: z.looseObject({ verdict: z.enum(TASK_VERDICTS) }).optional(),
  request: z.unknown().optional(),
});

// How a task job's task stands, apart from how its job ended: running;
// completed with a determined verdict (passed, failed or refused); held for
// a person; or unknown, when the job ended with no verdict at all. Unknown
// and held are never completed.
type TaskState = "running" | "completed" | "unknown" | "held";

type Launch = z.infer<typeof LAUNCH>;
type JobResult = z.infer<typeof RESULT>;
type StatusFile = NonNullable<ReturnType<typeof readStatus>>;

// A receipt folder made for one attempt, and where the job's output goes.
interface Receipt {
  dir: string;
  attempt: number;
  stdout: string;
  stderr: string;
}

// A receipt's job as status reports it. `newlyEnded` is true in the first
// report that finds it ended; `result` is the job's own line once it has
// printed one; `outcome`, `currentStage` and `droppedPatches` come from its
// job.json; `stderrTail` shows why a job that ended without a result failed.
// A task job's report adds `taskState`; `request` is the task a waiting
// stage job asked for, with its binding, for the caller to start next.
interface JobReport extends Omit<Launch, "argv" | "slug" | "jobId"> {
  receipt: string;
  running: boolean;
  newlyEnded: boolean;
  result: JobResult | null;
  taskState: TaskState | null;
  request: unknown;
  currentStage: string | null;
  outcome: StatusFile["outcome"];
  droppedPatches: string[];
  stderrTail: string | null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function launchOf(receiptDir: string): Launch | null {
  try {
    const text = fs.readFileSync(path.join(receiptDir, LAUNCH_FILE), "utf8");
    return LAUNCH.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

// Every receipt with its launch, in the order the jobs started.
function receipts(runDir: string): [string, Launch][] {
  return folders(path.join(runDir, "jobs"))
    .flatMap(folders)
    .flatMap(folders)
    .flatMap((dir): [string, Launch][] => {
      const launch = launchOf(dir);
      if (launch === null) {
        return [];
      }
      return [[dir, launch]];
    })
    .sort(([, a], [, b]) => a.startedAt.localeCompare(b.startedAt));
}

// Every launch, with what it works on: its task, else its stage.
function launches(runDir: string): (Launch & { work: string })[] {
  return receipts(runDir).map(([, launch]) => ({
    ...launch,
    work: launch.task ?? launch.stage,
  }));
}

// The job a receipt is for: a stage, or a task, of one issue in one repo.
interface JobKey {
  slug: string;
  issue: number;
  work: string;
}

// The folder of the receipts for `job`'s issue.
function issueFolder(runDir: string, job: JobKey): string {
  return path.join(runDir, "jobs", job.slug, `issue-${job.issue}`);
}

// Makes the next attempt's receipt folder for `launch`. Making it fails if
// another start took that attempt first.
function newReceipt(runDir: string, launch: JobKey): Receipt {
  const issueDir = issueFolder(runDir, launch);
  const attempt = attemptsAt(runDir, launch) + 1;
  const dir = path.join(issueDir, `${launch.work}-${attempt}`);
  fs.mkdirSync(issueDir, { recursive: true });
  fs.mkdirSync(dir);
  return {
    dir,
    attempt,
    stdout: path.join(dir, STDOUT_FILE),
    stderr: path.join(dir, STDERR_FILE),
  };
}

// How many receipts the run has made for `job`, the attempts it has used.
function attemptsAt(runDir: string, job: JobKey): number {
  const attempt = new RegExp(`^${job.work}-\\d+$`, "u");
  return folders(issueFolder(runDir, job)).filter((dir) =>
    attempt.test(path.basename(dir)),
  ).length;
}

// How a task job's task stands: its line's verdict once it ended, and
// unknown when it ended with none.
function taskStateOf(
  launch: Launch,
  running: boolean,
  result: JobResult | null,
): TaskState | null {
  if (launch.task === undefined) {
    return null;
  }
  if (running) {
    return "running";
  }
  const verdict: TaskReport["verdict"] = result?.task?.verdict ?? "unknown";
  switch (verdict) {
    case "passed":
    case "failed":
    case "refused":
      return "completed";
    case "held":
      return "held";
    default:
      return "unknown";
  }
}

function writeLaunch(receipt: Receipt, launch: Launch): void {
  fs.writeFileSync(
    path.join(receipt.dir, LAUNCH_FILE),
    `${JSON.stringify(launch, null, 2)}\n`,
  );
}

function resultOf(receiptDir: string): JobResult | null {
  const last = readText(path.join(receiptDir, STDOUT_FILE))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);
  try {
    return RESULT.parse(JSON.parse(last ?? "null"));
  } catch {
    return null;
  }
}

// Whether a report has already found the receipt's job ended.
function isReported(receiptDir: string): boolean {
  return fs.existsSync(path.join(receiptDir, ENDED_FILE));
}

// The launch's own job.json: the receipt's copy, else the issue's when its
// id is this launch's.
function jobStatusOf(receiptDir: string, launch: Launch): StatusFile | null {
  const copy = readStatus(receiptDir);
  if (copy !== null) {
    return copy;
  }
  const status = readStatus(issueRunDir(launch));
  if (status === null || status.id !== launch.jobId) {
    return null;
  }
  return status;
}

function issueRunDir(launch: Launch): string {
  return path.join(ROOT, "runs", launch.slug, `issue-${launch.issue}`);
}

// Keeps the ended job's job.json in its receipt and marks the job reported.
function markReported(receiptDir: string, launch: Launch): void {
  if (jobStatusOf(receiptDir, launch) !== null) {
    fs.copyFileSync(
      path.join(issueRunDir(launch), JOB_FILE),
      path.join(receiptDir, JOB_FILE),
    );
  }
  fs.writeFileSync(
    path.join(receiptDir, ENDED_FILE),
    `${JSON.stringify({ reportedAt: new Date().toISOString() })}\n`,
  );
}

function reportOf(receiptDir: string, launch: Launch): JobReport {
  const running = isStageJob(launch.pid);
  const newlyEnded = !(running || isReported(receiptDir));
  if (newlyEnded) {
    markReported(receiptDir, launch);
  }
  const job = jobStatusOf(receiptDir, launch);
  const result = resultOf(receiptDir);
  let stderrTail: string | null = null;
  if (!(running || result !== null)) {
    stderrTail = readText(path.join(receiptDir, STDERR_FILE)).slice(
      -STDERR_TAIL_CHARS,
    );
  }
  const { argv: _argv, slug: _slug, jobId: _jobId, ...shown } = launch;
  return {
    receipt: receiptDir,
    ...shown,
    running,
    newlyEnded,
    result,
    taskState: taskStateOf(launch, running, result),
    request: result?.request ?? null,
    currentStage: job?.currentStage ?? null,
    outcome: job?.outcome ?? null,
    droppedPatches: job?.droppedPatches ?? [],
    stderrTail,
  };
}

// Whether the run has a job that ended and no report has shown yet, and
// whether any of its jobs still runs.
function pending(runDir: string): { unreported: boolean; running: boolean } {
  let running = false;
  for (const [dir, launch] of receipts(runDir)) {
    if (isStageJob(launch.pid)) {
      running = true;
    } else if (!isReported(dir)) {
      return { unreported: true, running };
    }
  }
  return { unreported: false, running };
}

function reports(runDir: string): JobReport[] {
  return receipts(runDir).map(([dir, launch]) => reportOf(dir, launch));
}

export type { JobReport, Launch, Receipt, TaskState };
export { attemptsAt, launches, newReceipt, pending, reports, writeLaunch };
