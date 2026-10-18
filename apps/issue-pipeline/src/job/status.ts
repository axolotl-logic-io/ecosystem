// A stage job's status file, `job.json` in the issue's run folder. While the
// job runs it holds the job's pid, id, issue, stage, lane, start time and
// steer socket, a record of every launch it started (src/job/launch-record.ts),
// and for a stage that runs a role, each step of the role's run (#301). On
// exit it holds the job's outcome, which notes a sweep that deferred its
// issue on a transient provider error for the orchestrator's backoff, the
// error of a claim that failed, the uncommitted paths its checkout dropped (lostChanges) and the patches that
// saved them (droppedPatches, relative to the run folder, #369). Each change rewrites
// the whole file atomically, so a reader never sees part of one; a write that
// fails is reported on stderr and the job goes on. This module alone knows
// the file's name and layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { ContextStop } from "./context-watch.ts";
import type {
  LaunchOutcome,
  LaunchPush,
  LaunchRecord,
} from "./launch-record.ts";
import { LAUNCH, startedRecord, withRecord } from "./launch-record.ts";
import type { StepReport } from "./step-report.ts";
import type { Usage } from "./token-usage.ts";

const STATUS_FILE = "job.json";
const SIGNAL = z.enum(["SIGTERM", "SIGINT"]);
const JOB_OUTCOME = z.discriminatedUnion("kind", [
  // rateLimited: the issue deferred on a model provider's rate limit or a
  // transport error reaching it (src/workflow/stages/rate-limit.ts); absent before it was recorded.
  // claimError: the error of the issue's claim, when the claim failed; absent
  // when it passed. The orchestrator stops an issue on it once it repeats
  // (src/orchestrator/claim-failures.ts).
  z.object({
    kind: z.literal("finished"),
    rateLimited: z.boolean().optional(),
    claimError: z.string().optional(),
  }),
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
  // The job's id; missing from a file written before it was recorded.
  id: z.string().optional(),
  issue: z.number(),
  stage: z.string(),
  lane: z.string().nullable(),
  startedAt: z.string(),
  socket: z.string(),
  outcome: JOB_OUTCOME.nullable(),
  endedAt: z.string().optional(),
  launches: z.array(LAUNCH),
  lostChanges: z.array(z.string()).optional(),
  droppedPatches: z.array(z.string()).optional(),
  steps: z.array(STEP).optional(),
});

type StopSignal = z.infer<typeof SIGNAL>;
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
  // The job pushed `push` for session `key`'s commits.
  pushed: (key: string, push: LaunchPush) => void;
  // Launch `key`'s result went back to the sweep: sets its `outcome`.
  settled: (key: string, outcome: LaunchOutcome) => void;
  // A role's step started, or the step it last started ended.
  step: (step: StepReport) => void;
  // Launch `key`'s record as it stands, or null with none.
  launch: (key: string) => LaunchRecord | null;
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

// Opens a fresh status file for the job in `runDir` and writes it.
function openStatus(runDir: string, job: JobInfo): JobStatus {
  const file = statusFileOf(runDir);
  const status: StatusFile = {
    version: 1,
    pid: process.pid,
    ...job,
    outcome: null,
    launches: [],
  };
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
    contextStopped: (key: string, contextStop: ContextStop): void =>
      update(key, (launch) => ({ ...launch, contextStop })),
    pushed: (key: string, push: LaunchPush): void =>
      update(key, (launch) => ({
        ...launch,
        pushes: [...launch.pushes, push],
      })),
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
    lostChanges: (
      paths: readonly string[],
      patches: readonly string[],
    ): void => {
      status.lostChanges = [...paths];
      status.droppedPatches = [...patches];
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
