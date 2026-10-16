// A stage job's status file, `job.json` in the issue's run folder. While the
// job runs it holds the job's pid, issue, stage, lane, start time and steer
// socket, a record of every launch it started (src/job/launch-record.ts),
// and for a stage that runs a role, each step of the role's run (#301). On
// exit it holds the job's outcome, and the
// uncommitted paths its checkout dropped (lostChanges). Each change rewrites
// the whole file atomically, so a reader never sees part of one; a write that
// fails is reported on stderr and the job goes on. This module alone knows
// the file's name and layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { ContextStop } from "./context-watch.ts";
import type { LaunchOutcome, LaunchRecord } from "./launch-record.ts";
import { LAUNCH, startedRecord, withRecord } from "./launch-record.ts";
import type { Usage } from "./raw-results.ts";
import type { StepReport } from "./runner.ts";

const STATUS_FILE = "job.json";
const SIGNAL = z.enum(["SIGTERM", "SIGINT"]);
const JOB_OUTCOME = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finished") }),
  z.object({ kind: z.literal("stopped"), signal: SIGNAL }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
// A step of a role's run (src/job/runner.ts); null fields while it runs.
const STEP = z.object({
  at: z.string(),
  effect: z.enum(["op", "check", "session", "end"]),
  name: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  result: z.string().nullable(),
});
const STATUS = z.object({
  version: z.literal(1),
  pid: z.number(),
  issue: z.number(),
  stage: z.string(),
  lane: z.string().nullable(),
  startedAt: z.string(),
  socket: z.string(),
  outcome: JOB_OUTCOME.nullable(),
  endedAt: z.string().optional(),
  launches: z.array(LAUNCH),
  lostChanges: z.array(z.string()).optional(),
  steps: z.array(STEP).optional(),
});

type StopSignal = z.infer<typeof SIGNAL>;
type JobOutcome = z.infer<typeof JOB_OUTCOME>;
type StatusFile = z.infer<typeof STATUS>;

// The job as its file names it.
interface JobInfo {
  issue: number;
  stage: string;
  lane: string | null;
  socket: string;
}

// A launch as it starts: a pi session with its file, or an ops child, the
// usage it starts from (a resumed session's) and its token budget (or null).
interface LaunchStart {
  key: string;
  kind: "session" | "ops";
  pid: number | null;
  session: string | null;
  resumed: boolean;
  usage: Usage;
  tokenBudget: number | null;
}

// Where an interrupted session can carry on: its file and what it spent.
interface ResumePoint {
  session: string;
  usage: Usage;
}

// The job's status file, kept current as the job reports what happens.
interface JobStatus {
  // A launch started.
  started: (launch: LaunchStart) => void;
  // Session `key` printed `record`, one of pi's RPC records.
  record: (key: string, record: unknown) => void;
  // Launch `key`'s process ended.
  ended: (key: string) => void;
  // Writer session `key` was stopped at the hard context limit.
  contextStopped: (key: string, stop: ContextStop) => void;
  // Launch `key`'s result went back to the sweep: sets its `outcome`.
  settled: (key: string, outcome: LaunchOutcome) => void;
  // A role's step started, or the step it last started ended.
  step: (step: StepReport) => void;
  // Launch `key`'s record as it stands, or null with none.
  launch: (key: string) => LaunchRecord | null;
  // The job ended.
  finish: (outcome: JobOutcome) => void;
  // The uncommitted paths the job's checkout held at exit, which it dropped.
  lostChanges: (paths: readonly string[]) => void;
}

function statusFileOf(runDir: string): string {
  return path.join(runDir, STATUS_FILE);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function writeStatus(file: string, status: StatusFile): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (error: unknown) {
    fs.rmSync(temp, { force: true });
    process.stderr.write(`job: cannot write ${file}: ${messageOf(error)}\n`);
  }
}

// The earlier job's file in `runDir`, or null when it is missing or
// malformed.
function readStatus(runDir: string): StatusFile | null {
  try {
    const text = fs.readFileSync(statusFileOf(runDir), "utf8");
    const parsed = STATUS.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

// Opens a fresh status file for the job in `runDir` and writes it.
function openStatus(runDir: string, job: JobInfo): JobStatus {
  const file = statusFileOf(runDir);
  const status: StatusFile = {
    version: 1,
    pid: process.pid,
    ...job,
    startedAt: new Date().toISOString(),
    outcome: null,
    launches: [],
  };
  // Changes launch `key`.
  function update(
    key: string,
    change: (l: LaunchRecord) => LaunchRecord,
  ): void {
    status.launches = status.launches.map((l: LaunchRecord): LaunchRecord => {
      if (l.key === key) {
        return change(l);
      }
      return l;
    });
    writeStatus(file, status);
  }
  writeStatus(file, status);
  return {
    started: (launch: LaunchStart): void => {
      status.launches.push(startedRecord(launch));
      writeStatus(file, status);
    },
    record: (key: string, record: unknown): void =>
      update(key, (launch) => withRecord(launch, record)),
    ended: (key: string): void => update(key, (launch) => launch),
    contextStopped: (key: string, contextStop: ContextStop): void =>
      update(key, (launch) => ({ ...launch, contextStop })),
    settled: (key: string, outcome: LaunchOutcome): void =>
      update(key, (launch) => ({ ...launch, outcome })),
    step: (step: StepReport): void => {
      const steps = status.steps ?? [];
      if (steps.at(-1)?.endedAt === null) {
        steps.pop();
      }
      status.steps = [...steps, step];
      writeStatus(file, status);
    },
    launch: (key: string): LaunchRecord | null =>
      status.launches.find((l: LaunchRecord): boolean => l.key === key) ?? null,
    finish: (outcome: JobOutcome): void => {
      status.outcome = outcome;
      status.endedAt = new Date().toISOString();
      writeStatus(file, status);
    },
    lostChanges: (paths: readonly string[]): void => {
      status.lostChanges = [...paths];
      writeStatus(file, status);
    },
  };
}

// Where the earlier job in `runDir` left each interrupted session: a session
// launch with no outcome and no stop at the hard context limit whose file is
// still on disk. Nothing, when there is no earlier file or it is malformed.
function resumePoints(runDir: string): (key: string) => ResumePoint | null {
  const earlier = readStatus(runDir);
  return (key: string): ResumePoint | null => {
    const launch = earlier?.launches.find((l) => l.key === key);
    if (
      launch?.kind !== "session" ||
      launch.outcome !== null ||
      launch.contextStop !== null ||
      launch.session === null ||
      !fs.existsSync(launch.session)
    ) {
      return null;
    }
    return { session: launch.session, usage: launch.usage };
  };
}

// The steer socket the job in `runDir` recorded, or null with no file.
function socketOf(runDir: string): string | null {
  return readStatus(runDir)?.socket ?? null;
}

export type {
  JobOutcome,
  JobStatus,
  LaunchStart,
  ResumePoint,
  StatusFile,
  StopSignal,
};
export { openStatus, readStatus, resumePoints, socketOf };
