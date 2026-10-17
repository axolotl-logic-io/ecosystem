// The role runner's usage bookkeeping (src/job/runner.ts): how a session
// ended, the stages a run went through and the tokens its sessions spent,
// as the usage log's entries (src/job/usage-log.ts). It does no I/O.

import type { SessionEffect } from "../roles/machine.ts";
import type { State } from "../state.ts";
import type { JsonSchema } from "../workflow/schemas.ts";
import { isRecord } from "../workflow/stages/reply-guards.ts";
import type { Usage } from "./raw-results.ts";
import { addUsage, ZERO_USAGE } from "./raw-results.ts";
import type { Outcome, RunEnd } from "./runner.ts";
import type { Ended } from "./usage-log.ts";
import type { LaunchUsage } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;

// What the runner knows of a finished session.
interface SessionEntry {
  kind: "session";
  at: string;
  stage: string;
  state: string;
  name: string;
  agent: string;
  model: string;
  attempt: number;
  taskChars: number;
  schema: JsonSchema;
  ended: Ended;
  reply: unknown;
  launch: LaunchUsage;
}

// What the runner knows of a finished run.
interface JobEntry {
  kind: "job";
  at: string;
  stages: readonly string[];
  outcome: RunEnd["kind"];
  seconds: number;
  tokens: Usage;
  issueTokens: number;
}

type UsageEntry = SessionEntry | JobEntry;

// A session as it finished: when, at which stage and state, its effect, its
// outcome and usage, and whether a signal came while it ran.
interface FinishedSession {
  at: Date;
  stage: string;
  state: string;
  effect: SessionEffect;
  outcome: Outcome;
  launch: LaunchUsage;
  signalled: boolean;
}

// One run's bookkeeping.
interface RunUsage {
  // The entry of a finished session, whose tokens the run's job entry adds.
  session: (finished: FinishedSession) => SessionEntry;
  // The run moved on to `stage`.
  moved: (stage: string) => void;
  // The run's entry once it ended as `end`, having last saved `saved`.
  job: (end: RunEnd, saved: State, at: Date) => JobEntry;
}

// How a session ended: aborted by a signal, stopped by the context watch, or
// with its reply, a handoff reply or a failure.
function endedOf(finished: FinishedSession): Ended {
  const { outcome, launch, signalled } = finished;
  if (signalled) {
    return "aborted";
  }
  if (launch.stopped) {
    return "context-stop";
  }
  if (!outcome.ok) {
    return "error";
  }
  if (isRecord(outcome.reply)) {
    const { status } = outcome.reply;
    if (status === "handoff") {
      return "handoff";
    }
  }
  return "reply";
}

function reportedTokens(saved: State): number {
  const { reportedTokens: tokens } = saved;
  if (typeof tokens === "number") {
    return tokens;
  }
  return 0;
}

// The bookkeeping of a run that starts at `stage` at `startedAt`.
function runUsage(stage: string, startedAt: Date): RunUsage {
  const stages = [stage];
  let tokens: Usage = ZERO_USAGE;
  return {
    session: (finished: FinishedSession): SessionEntry => {
      const { effect, outcome, launch } = finished;
      tokens = addUsage(tokens, launch.tokens);
      let reply: unknown = null;
      if (outcome.ok) {
        ({ reply } = outcome);
      }
      return {
        kind: "session",
        at: finished.at.toISOString(),
        stage: finished.stage,
        state: finished.state,
        name: effect.name,
        agent: effect.agent,
        model: effect.model,
        attempt: effect.attempt,
        taskChars: effect.task.length,
        schema: effect.schema,
        ended: endedOf(finished),
        reply,
        launch,
      };
    },
    moved: (next: string): void => {
      stages.push(next);
    },
    job: (end: RunEnd, saved: State, at: Date): JobEntry => ({
      kind: "job",
      at: at.toISOString(),
      stages: [...stages],
      outcome: end.kind,
      seconds: (at.getTime() - startedAt.getTime()) / MS_PER_SECOND,
      tokens,
      issueTokens: reportedTokens(saved),
    }),
  };
}

export type { FinishedSession, JobEntry, RunUsage, SessionEntry, UsageEntry };
export { runUsage };
