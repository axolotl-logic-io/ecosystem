// Append bounded session measures to context.jsonl in the action folder.
// Records contain no prompt, reply or tool text. A cooperative interruption
// is not a process kill; missing launch evidence stays unrecorded. Legacy
// job/stage field names remain local log labels, not workflow authority.
// A failed append reports its error without changing the action outcome.

import path from "node:path";
import type { ModelRole } from "../config-legacy.ts";
import type { Control } from "./control.ts";
import type { LaunchRecord } from "./launch-record.ts";
import { appendRunLine } from "./run-log.ts";
import type { JobStatus } from "./status.ts";
import type { Usage } from "./token-usage.ts";
import { ZERO_USAGE } from "./token-usage.ts";

// How a session ended as its launch saw it: its result.
type SessionEnded = "ok" | "failed";

// The steers the job sent a session through the steer socket, the
// watchdog's or one sent by hand with `--steer`.
interface Steers {
  socket: number;
}

// What the launch knows of a session as it ends: its model role, agent,
// model and end, its steers, the code checkout's head as it ended, and for a session
// that can't commit, the head it ran on, which it reviewed (null for a
// writer, and either is null with no head to read).
interface SessionEnd {
  role: ModelRole;
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
  job: string;
  role: ModelRole;
  agent: string;
  model: string;
  ended: SessionEnded | "interrupted" | "unrecorded";
  // The highest turn context, the latest message's token total and the
  // first turn's context (null with no turn), as job.json counts them.
  peakContext: number;
  contextTokens: number;
  firstContext: number | null;
  turns: number;
  usage: Usage;
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
  | "peakContext"
  | "contextTokens"
  | "firstContext"
  | "turns"
  | "usage"
>;

// What a session with no launch record measured: nothing.
const UNRECORDED: Measures = {
  session: null,
  peakContext: 0,
  contextTokens: 0,
  firstContext: null,
  turns: 0,
  usage: ZERO_USAGE,
};

// Preserve missing measures as unknown; interruption describes the local
// session outcome, not an accepted human stop or a durable signal.
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
      peakContext: launch.peakContext,
      contextTokens: launch.contextTokens,
      firstContext: launch.firstContext,
      turns: launch.turns,
      usage: launch.usage,
    };
  }
  if (job.stopping) {
    ended = "interrupted";
  }
  return {
    at: at.toISOString(),
    issue: job.issue,
    stage: job.stage,
    key,
    session: measured.session,
    job: job.id,
    role: end.role,
    agent: end.agent,
    model: end.model,
    ended,
    peakContext: measured.peakContext,
    contextTokens: measured.contextTokens,
    firstContext: measured.firstContext,
    turns: measured.turns,
    usage: measured.usage,
    steers: end.steers,
    headSha: end.headSha,
    reviewedSha: end.reviewedSha,
  };
}

// Read measures from the current action's launch observations. The runtime
// supplies the task ID through the legacy-labelled currentStage accessor.
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
