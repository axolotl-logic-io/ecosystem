// The issue's context log, `context.jsonl` in its run folder (Axlog,
// 2026-10-16): one JSON line appended as each model session launch ends,
// so the context sessions use outlives job.json, which the next job
// overwrites. A line holds numbers and names only, never a prompt, reply or
// tool text. A session the job's stop (SIGTERM or SIGINT, as the watchdog
// sends) ended is logged as `killed`. A write that fails is reported on
// stderr and the job goes on. This module alone knows the file's name and
// layout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Role } from "../workflow/types.ts";
import type { ContextStop } from "./context-watch.ts";
import type { Control } from "./control.ts";
import type { Usage } from "./raw-results.ts";
import type { JobStatus, StatusFile } from "./status.ts";

const CONTEXT_LOG = "context.jsonl";

type LaunchRecord = StatusFile["launches"][number];

// How a session ended as its launch saw it: its result, or a handoff.
type SessionEnded = "ok" | "failed" | "handoff";

// What the launch knows of a session as it ends.
interface SessionEnd {
  budgetRole: Role;
  agent: string;
  model: string;
  ended: SessionEnded;
}

// One line of the log.
interface ContextLine {
  at: string;
  issue: number;
  stage: string;
  key: string;
  role: Role;
  agent: string;
  model: string;
  ended: SessionEnded | "killed";
  // The highest turn context, the latest message's token total and the
  // first turn's context (null with no turn), as job.json counts them.
  peakContext: number;
  contextTokens: number;
  firstContext: number | null;
  turns: number;
  usage: Usage;
  contextStop: ContextStop | null;
}

// The line for session `launch` of the job on `job.issue`'s `job.stage`,
// ended as `end` says, or killed when the job is stopping.
function contextLineOf(
  job: { issue: number; stage: string; stopping: boolean },
  launch: LaunchRecord,
  end: SessionEnd,
  at: Date,
): ContextLine {
  let { ended }: { ended: ContextLine["ended"] } = end;
  if (job.stopping) {
    ended = "killed";
  }
  return {
    at: at.toISOString(),
    issue: job.issue,
    stage: job.stage,
    key: launch.key,
    role: end.budgetRole,
    agent: end.agent,
    model: end.model,
    ended,
    peakContext: launch.peakContext,
    contextTokens: launch.contextTokens,
    firstContext: launch.firstContext,
    turns: launch.turns,
    usage: launch.usage,
    contextStop: launch.contextStop,
  };
}

// Appends `line` to the context log in `runDir`.
function appendContextLine(runDir: string, line: ContextLine): void {
  const file = path.join(runDir, CONTEXT_LOG);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch (error: unknown) {
    process.stderr.write(`job: cannot append to ${file}: ${String(error)}\n`);
  }
}

// The log of the ends of `job`'s sessions, in `runDir`: each line reads the
// session's record from the job's status, and is `killed` while its control
// is stopping. A session with no record logs nothing.
function contextLogOf(
  runDir: string,
  job: { issue: number; stage: string },
  watch: {
    status: Pick<JobStatus, "launch">;
    control: Pick<Control, "stopping">;
  },
): (key: string, end: SessionEnd) => void {
  return (key: string, end: SessionEnd): void => {
    const launch = watch.status.launch(key);
    if (launch === null) {
      return;
    }
    const { issue, stage } = job;
    const stopping = watch.control.stopping() !== null;
    const ending = { issue, stage, stopping };
    appendContextLine(runDir, contextLineOf(ending, launch, end, new Date()));
  };
}

export type { SessionEnd, SessionEnded };
export { contextLogOf };
