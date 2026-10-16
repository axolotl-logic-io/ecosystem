// A stage job's status file, `job.json` in the issue's run folder. While the
// job runs it holds the job's pid, issue, stage, lane, start time and steer
// socket, and a record of every launch it started: its pid, session file,
// last event, consecutive tool failures, token usage and outcome. On exit it
// holds the job's outcome, and the uncommitted paths its checkout dropped
// (lostChanges). Each change rewrites the whole file atomically, so
// a reader never sees part of one; a write that fails is reported on stderr
// and the job goes on. This module alone knows the file's name and layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Usage } from "./raw-results.ts";
import { addUsage, recordFacts, USAGE, ZERO_USAGE } from "./raw-results.ts";

const STATUS_FILE = "job.json";
const SIGNAL = z.enum(["SIGTERM", "SIGINT"]);
const LAUNCH_OUTCOME = z.enum(["ok", "failed"]);
const LAUNCH = z.object({
  key: z.string(),
  kind: z.enum(["session", "ops"]),
  pid: z.number().nullable(),
  session: z.string().nullable(),
  startedAt: z.string(),
  lastEventAt: z.string().nullable(),
  toolFailures: z.number(),
  usage: USAGE,
  resumed: z.boolean(),
  outcome: LAUNCH_OUTCOME.nullable(),
});
const JOB_OUTCOME = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("finished") }),
  z.object({ kind: z.literal("stopped"), signal: SIGNAL }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
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
});

type StopSignal = z.infer<typeof SIGNAL>;
type LaunchOutcome = z.infer<typeof LAUNCH_OUTCOME>;
type JobOutcome = z.infer<typeof JOB_OUTCOME>;
type LaunchRecord = z.infer<typeof LAUNCH>;
type StatusFile = z.infer<typeof STATUS>;

// The job as its file names it.
interface JobInfo {
  issue: number;
  stage: string;
  lane: string | null;
  socket: string;
}

// A launch as it starts: a pi session with its file, or an ops child, and
// the usage it starts from (a resumed session's earlier usage).
interface LaunchStart {
  key: string;
  kind: "session" | "ops";
  pid: number | null;
  session: string | null;
  resumed: boolean;
  usage: Usage;
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
  // Launch `key`'s result went back to the sweep.
  settled: (key: string, outcome: LaunchOutcome) => void;
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

function withRecord(launch: LaunchRecord, record: unknown): LaunchRecord {
  const { usage, toolFailed } = recordFacts(record);
  let { toolFailures } = launch;
  if (toolFailed !== null) {
    toolFailures = 0;
  }
  if (toolFailed === true) {
    toolFailures = launch.toolFailures + 1;
  }
  return {
    ...launch,
    lastEventAt: new Date().toISOString(),
    toolFailures,
    usage: addUsage(launch.usage, usage ?? ZERO_USAGE),
  };
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
  function update(
    key: string,
    change: (l: LaunchRecord) => LaunchRecord,
  ): void {
    status.launches = status.launches.map(
      (launch: LaunchRecord): LaunchRecord => {
        if (launch.key === key) {
          return change(launch);
        }
        return launch;
      },
    );
    writeStatus(file, status);
  }
  writeStatus(file, status);
  return {
    started: (launch: LaunchStart): void => {
      const startedAt = new Date().toISOString();
      const fields = { startedAt, lastEventAt: null, toolFailures: 0 };
      status.launches.push({ ...launch, ...fields, outcome: null });
      writeStatus(file, status);
    },
    record: (key: string, record: unknown): void =>
      update(key, (launch) => withRecord(launch, record)),
    ended: (key: string): void => update(key, (launch) => launch),
    settled: (key: string, outcome: LaunchOutcome): void =>
      update(key, (launch) => ({ ...launch, outcome })),
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
// launch with no outcome whose file is still on disk. Nothing, when there is
// no earlier file or it is malformed.
function resumePoints(runDir: string): (key: string) => ResumePoint | null {
  const earlier = readStatus(runDir);
  return (key: string): ResumePoint | null => {
    const launch = earlier?.launches.find((l) => l.key === key);
    if (
      launch?.kind !== "session" ||
      launch.outcome !== null ||
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
  LaunchOutcome,
  LaunchStart,
  ResumePoint,
  StopSignal,
};
export { openStatus, resumePoints, socketOf };
