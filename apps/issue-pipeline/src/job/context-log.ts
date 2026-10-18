// The issue's context log, `context.jsonl` in its run folder (Axlog,
// 2026-10-16): one JSON line appended as each model session launch ends,
// so the context and spend of sessions outlive job.json, which the next job
// overwrites. A line holds numbers and names only, never a prompt, reply or
// tool text. A session the job's stop (SIGTERM or SIGINT, as the watchdog
// sends) ended is logged as `killed`, and one with no launch record in
// job.json as `unrecorded`, with no file and no measures. A write that fails
// is reported on stderr and the job goes on (run-log.ts). This module alone
// knows the line's layout.

import path from "node:path";
import type { Role } from "../workflow/types.ts";
import type { ContextStop } from "./context-watch.ts";
import type { Control } from "./control.ts";
import { appendRunLine } from "./run-log.ts";
import type { JobStatus, StatusFile } from "./status.ts";
import type { Usage } from "./token-usage.ts";
import { ZERO_USAGE } from "./token-usage.ts";

type LaunchRecord = StatusFile["launches"][number];

// How a session ended as its launch saw it: its result, or a handoff.
type SessionEnded = "ok" | "failed" | "handoff";

// The steers the job sent a session: the context watch's at the soft limit
// (context-watch.ts), and those through the steer socket, the watchdog's or
// one sent by hand with `--steer`.
interface Steers {
  context: number;
  socket: number;
}

// What the launch knows of a session as it ends: its role, agent, model and
// end, its steers, the code checkout's head as it ended, and for a session
// that can't commit, the head it ran on, which it reviewed (null for a
// writer, and either is null with no head to read).
interface SessionEnd {
  budgetRole: Role;
  agent: string;
  model: string;
  ended: SessionEnded;
  steers: Steers;
  headSha: string | null;
  reviewedSha: string | null;
}

// One line of the log: `session` is the session file's name, null with no
// file, and `job` the job's random id.
interface ContextLine {
  at: string;
  issue: number;
  stage: string;
  key: string;
  session: string | null;
  resumed: boolean | null;
  job: string;
  role: Role;
  agent: string;
  model: string;
  ended: SessionEnded | "killed" | "unrecorded";
  // The highest turn context, the latest message's token total and the
  // first turn's context (null with no turn), as job.json counts them.
  peakContext: number;
  contextTokens: number;
  firstContext: number | null;
  turns: number;
  usage: Usage;
  contextStop: ContextStop | null;
  steers: Steers;
  headSha: string | null;
  reviewedSha: string | null;
}

// The job a line is for: its issue and its random id.
interface ContextJob {
  issue: number;
  id: string;
}

// What a line takes from the session's launch record.
type Measures = Pick<
  ContextLine,
  | "session"
  | "resumed"
  | "peakContext"
  | "contextTokens"
  | "firstContext"
  | "turns"
  | "usage"
  | "contextStop"
>;

// What a session with no launch record measured: nothing.
const UNRECORDED: Measures = {
  session: null,
  resumed: null,
  peakContext: 0,
  contextTokens: 0,
  firstContext: null,
  turns: 0,
  usage: ZERO_USAGE,
  contextStop: null,
};

// The line for session `key` of `job` at its stage, measured as its
// `launch` record says (unrecorded when it is null), ended as `end` says, or
// killed when the job is stopping.
function contextLineOf(
  job: ContextJob & { stage: string; stopping: boolean },
  ending: { key: string; launch: LaunchRecord | null; end: SessionEnd },
  at: Date,
): ContextLine {
  const { key, launch, end } = ending;
  let { ended }: { ended: ContextLine["ended"] } = end;
  let measured = UNRECORDED;
  if (launch === null) {
    ended = "unrecorded";
  } else {
    measured = {
      session: launch.session && path.basename(launch.session),
      resumed: launch.resumed,
      peakContext: launch.peakContext,
      contextTokens: launch.contextTokens,
      firstContext: launch.firstContext,
      turns: launch.turns,
      usage: launch.usage,
      contextStop: launch.contextStop,
    };
  }
  if (job.stopping) {
    ended = "killed";
  }
  return {
    at: at.toISOString(),
    issue: job.issue,
    stage: job.stage,
    key,
    session: measured.session,
    resumed: measured.resumed,
    job: job.id,
    role: end.budgetRole,
    agent: end.agent,
    model: end.model,
    ended,
    peakContext: measured.peakContext,
    contextTokens: measured.contextTokens,
    firstContext: measured.firstContext,
    turns: measured.turns,
    usage: measured.usage,
    contextStop: measured.contextStop,
    steers: end.steers,
    headSha: end.headSha,
    reviewedSha: end.reviewedSha,
  };
}

// The log of the ends of `job`'s sessions, in `runDir`: each line reads the
// session's record and the stage the job is at now from the job's status,
// and is `killed` while its control is stopping.
function contextLogOf(
  runDir: string,
  job: ContextJob,
  watch: {
    status: Pick<JobStatus, "launch" | "currentStage">;
    control: Pick<Control, "stopping">;
  },
): (key: string, end: SessionEnd) => void {
  return (key: string, end: SessionEnd): void => {
    const launch = watch.status.launch(key);
    const stopping = watch.control.stopping() !== null;
    const stage = watch.status.currentStage();
    const line = contextLineOf(
      { ...job, stage, stopping },
      { key, launch, end },
      new Date(),
    );
    appendRunLine(runDir, "context.jsonl", line);
  };
}

export type { SessionEnd, SessionEnded, Steers };
export { contextLogOf };
