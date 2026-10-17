// The role runner's usage bookkeeping (src/job/runner.ts): how a session
// ended, the stages a run went through, the tokens its sessions spent, as
// the usage log's entries (src/job/usage-log.ts), and the issue's
// reportedTokens, which its sessions add to as the sweep's do
// (launch-results.ts). It does no I/O.

import type { SessionEffect } from "../roles/machine.ts";
import type { State } from "../state.ts";
import { rateTokens } from "../workflow/rate-tokens.ts";
import type { JsonSchema } from "../workflow/schemas.ts";
import { isRecord } from "../workflow/stages/reply-guards.ts";
import type { OpsRaw, SessionRaw } from "./raw-results.ts";
import type { Outcome } from "./run-step.ts";
import type { RunEnd } from "./runner.ts";
import type { Usage } from "./token-usage.ts";
import { addUsage, ZERO_USAGE } from "./token-usage.ts";
import type { Ended } from "./usage-log.ts";
import type { LaunchUsage } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;

// What the runner knows of a finished session.
interface SessionEntry {
  kind: "session";
  at: string;
  // The session's launch key, which its commits' trailers name.
  key: string;
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

// What a job knows of its finished run: its end, as a role run's end kind
// or the sweep's outcome for the issue.
interface JobEntry {
  kind: "job";
  at: string;
  stages: readonly string[];
  outcome: string;
  seconds: number;
  tokens: Usage;
  issueTokens: number;
}

type UsageEntry = SessionEntry | JobEntry;

// A session as it finished: when, its launch key, at which stage and state,
// its effect, its outcome and usage, and whether a signal came while it ran.
interface FinishedSession {
  at: Date;
  key: string;
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
  // `state` with the issue's reportedTokens: the saved state's at the run's
  // start and what the run's finished sessions spent since.
  counted: (state: State) => State;
  // The run's entry once it ended as `end`.
  job: (end: RunEnd, at: Date) => JobEntry;
}

// A session's result as the runner reads it: its reply, or its failure.
function sessionOutcome(raw: OpsRaw | SessionRaw): Outcome {
  if ("structuredOutput" in raw && raw.ok) {
    return { ok: true, name: "replied", reply: raw.structuredOutput };
  }
  return { ok: false, error: raw.error ?? "the session failed" };
}

// How a session ended: aborted by a signal, stopped by the context watch, or
// with its reply, a handoff reply or a failure.
function endedOf(
  finished: Pick<FinishedSession, "outcome" | "launch" | "signalled">,
): Ended {
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

// The bookkeeping of a run that starts at `stage` at `startedAt` from
// `saved`.
function runUsage(stage: string, startedAt: Date, saved: State): RunUsage {
  const stages = [stage];
  let tokens: Usage = ZERO_USAGE;
  let issueTokens = reportedTokens(saved);
  return {
    session: (finished: FinishedSession): SessionEntry => {
      const { effect, outcome, launch } = finished;
      tokens = addUsage(tokens, launch.tokens);
      issueTokens += rateTokens(launch.tokens);
      let reply: unknown = null;
      if (outcome.ok) {
        ({ reply } = outcome);
      }
      return {
        kind: "session",
        at: finished.at.toISOString(),
        key: finished.key,
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
    counted: (state: State): State => ({
      ...state,
      reportedTokens: issueTokens,
    }),
    job: (end: RunEnd, at: Date): JobEntry => ({
      kind: "job",
      at: at.toISOString(),
      stages: [...stages],
      outcome: end.kind,
      seconds: (at.getTime() - startedAt.getTime()) / MS_PER_SECOND,
      tokens,
      issueTokens,
    }),
  };
}

export type { FinishedSession, JobEntry, RunUsage, SessionEntry, UsageEntry };
export { endedOf, runUsage, sessionOutcome };
