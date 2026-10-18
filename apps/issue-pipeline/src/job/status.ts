// A stage job's status file, `job.json` in the issue's run folder. While the
// job runs it holds the pipeline's version (`pipelineVersion: 2`, which a
// file the installed version wrote lacks, so its overlapping stage names
// are never taken for this pipeline's), the job's pid, id, issue, the stage
// it started at and the one it is at now, lane, start time and steer socket,
// and a record of every launch it started (src/job/launch-record.ts). On
// exit it holds the job's outcome: how the role's stage ended, whether the
// issue deferred on a transient provider or transport error for the
// orchestrator's backoff, the error of a claim that failed, the uncommitted
// paths its checkout dropped (lostChanges) and the patches that saved them
// (droppedPatches, relative to the run folder, #369). Each change rewrites
// the whole file atomically, so a reader never sees part of one; a write that
// fails is reported on stderr and the job goes on. This module alone knows
// the file's name and layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type {
  LaunchOutcome,
  LaunchPush,
  LaunchRecord,
} from "./launch-record.ts";
import { LAUNCH, startedRecord, withRecord } from "./launch-record.ts";

const STATUS_FILE = "job.json";
// The pipeline version a job of this pipeline records in its file.
const PIPELINE_VERSION = 2;
const SIGNAL = z.enum(["SIGTERM", "SIGINT"]);
// How a finished job's stage ended: a role's end (src/job/role-context.ts),
// or "unclaimed" when its claim didn't pass.
const JOB_END = z.enum([
  "next",
  "stop",
  "ask",
  "wait",
  "deferred",
  "unclaimed",
]);
const JOB_OUTCOME = z.discriminatedUnion("kind", [
  // end: how the stage ended; absent from a file the installed version
  // wrote. rateLimited: the issue deferred on a model provider's rate limit
  // or a transport error reaching it (end "deferred"). claimError: the error
  // of the issue's claim, when the claim failed; absent when it passed. The
  // orchestrator stops an issue on it once it repeats.
  z.object({
    kind: z.literal("finished"),
    end: JOB_END.optional(),
    rateLimited: z.boolean().optional(),
    claimError: z.string().optional(),
  }),
  z.object({ kind: z.literal("stopped"), signal: SIGNAL }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
const STATUS = z.object({
  version: z.literal(1),
  // 2 for this pipeline's jobs; absent from the installed version's files.
  pipelineVersion: z.literal(PIPELINE_VERSION).optional(),
  pid: z.number(),
  // The job's id; missing from a file written before it was recorded.
  id: z.string().optional(),
  issue: z.number(),
  // The stage the job started at (its `--stage`).
  stage: z.string(),
  // The stage the job is at now: the stage its role's `next` end saved.
  currentStage: z.string().optional(),
  lane: z.string().nullable(),
  startedAt: z.string(),
  socket: z.string(),
  outcome: JOB_OUTCOME.nullable(),
  endedAt: z.string().optional(),
  launches: z.array(LAUNCH),
  lostChanges: z.array(z.string()).optional(),
  droppedPatches: z.array(z.string()).optional(),
});

type StopSignal = z.infer<typeof SIGNAL>;
type JobEnd = z.infer<typeof JOB_END>;
type JobOutcome = z.infer<typeof JOB_OUTCOME>;
type StatusFile = z.infer<typeof STATUS>;

// The job as its file names it: its random id and its start, as its usage
// records and its commits' trailers name them, too.
interface JobInfo {
  id: string;
  issue: number;
  stage: string;
  lane: string | null;
  startedAt: string;
  socket: string;
}

// A launch as it starts: a pi session with its file, or an ops child.
interface LaunchStart {
  key: string;
  kind: "session" | "ops";
  pid: number | null;
  session: string | null;
}

// The job's status file, kept current as the job reports what happens.
interface JobStatus {
  // A launch started.
  started: (launch: LaunchStart) => void;
  // Session `key` printed `record`, one of pi's RPC records.
  record: (key: string, record: unknown) => void;
  // Launch `key`'s process ended.
  ended: (key: string) => void;
  // The job pushed `push` for session `key`'s commits.
  pushed: (key: string, push: LaunchPush) => void;
  // Launch `key`'s result went back to the role: sets its `outcome`.
  settled: (key: string, outcome: LaunchOutcome) => void;
  // The job saved the issue at `stage`.
  moved: (stage: string) => void;
  // Launch `key`'s record as it stands, or null with none.
  launch: (key: string) => LaunchRecord | null;
  // The stage the job is at now.
  currentStage: () => string;
  // The job ended.
  finish: (outcome: JobOutcome) => void;
  // The uncommitted paths the job's checkout held at exit, which it dropped,
  // and the patches, relative to the run folder, that saved them.
  lostChanges: (paths: readonly string[], patches: readonly string[]) => void;
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

// `launches` with launch `key` changed by `change`.
function withLaunch(
  launches: readonly LaunchRecord[],
  key: string,
  change: (l: LaunchRecord) => LaunchRecord,
): LaunchRecord[] {
  return launches.map((l: LaunchRecord): LaunchRecord => {
    if (l.key === key) {
      return change(l);
    }
    return l;
  });
}

// `launch` with `push` added.
function withPush(launch: LaunchRecord, push: LaunchPush): LaunchRecord {
  return { ...launch, pushes: [...launch.pushes, push] };
}

// Opens a fresh status file for the job in `runDir` and writes it.
function openStatus(runDir: string, job: JobInfo): JobStatus {
  const file = statusFileOf(runDir);
  const status: StatusFile = {
    version: 1,
    pipelineVersion: PIPELINE_VERSION,
    pid: process.pid,
    ...job,
    currentStage: job.stage,
    outcome: null,
    launches: [],
  };
  // Sets `fields` in the file.
  function set(fields: Partial<StatusFile>): void {
    Object.assign(status, fields);
    writeStatus(file, status);
  }
  // Changes launch `key`.
  function update(
    key: string,
    change: (l: LaunchRecord) => LaunchRecord,
  ): void {
    status.launches = withLaunch(status.launches, key, change);
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
    pushed: (key: string, push: LaunchPush): void =>
      update(key, (launch) => withPush(launch, push)),
    settled: (key: string, outcome: LaunchOutcome): void =>
      update(key, (launch) => ({ ...launch, outcome })),
    moved: (stage: string): void => set({ currentStage: stage }),
    launch: (key: string): LaunchRecord | null =>
      status.launches.find((l: LaunchRecord): boolean => l.key === key) ?? null,
    currentStage: (): string => currentStageOf(status),
    finish: (outcome: JobOutcome): void =>
      set({ outcome, endedAt: new Date().toISOString() }),
    lostChanges: (paths: readonly string[], patches: readonly string[]): void =>
      set({ lostChanges: [...paths], droppedPatches: [...patches] }),
  };
}

// Whether `status` is a job of this pipeline. A file the installed version
// wrote names stages (implement, review, merge) that overlap this
// pipeline's, so only the version marker says a job is this pipeline's.
function isPipelineJob(status: StatusFile): boolean {
  return status.pipelineVersion === PIPELINE_VERSION;
}

// The stage the job is at now, as its file names it.
function currentStageOf(status: StatusFile): string {
  return status.currentStage ?? status.stage;
}

// The steer socket the job in `runDir` recorded, or null with no file.
function socketOf(runDir: string): string | null {
  return readStatus(runDir)?.socket ?? null;
}

export type {
  JobEnd,
  JobOutcome,
  JobStatus,
  LaunchStart,
  StatusFile,
  StopSignal,
};
export {
  currentStageOf,
  isPipelineJob,
  openStatus,
  PIPELINE_VERSION,
  readStatus,
  socketOf,
};
