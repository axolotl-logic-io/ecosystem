// The escalation agent (#282): an optional, read-only pi agent that reads
// the escalations a tick raised and recommends one action for each escalated
// issue: steer its live session, resume its stage job, stop it, or nothing.
// It runs at most once per tick, only when the tick raised escalations and
// `escalationAgent` names an installed agent definition
// (escalation-consult.ts runs it). Each recommendation is logged as
// `recommended`; with `escalationAgentActs` on, it is carried out through the
// watchdog's own commands, which the tick passes in. Every failure is logged
// as `agent-failed`, and the tick goes on.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { State } from "../state.ts";
import type { Escalation } from "./escalate.ts";
import { escalate } from "./escalate.ts";
import type { Action, Reply, RunAgent } from "./escalation-consult.ts";
import { consult } from "./escalation-consult.ts";
import type { LogEntry } from "./log.ts";
import { logDecisions, logEscalations } from "./log.ts";
import type { WatchedJob } from "./watchdog.ts";
import { budgetStopped } from "./watchdog-budget.ts";
import type { WatchMemory } from "./watchdog-memory.ts";
import { saveWatchMemory } from "./watchdog-memory.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

// The agent's config keys and their defaults, kept with the one module that
// reads them, as config.ts is at its line limit.
const ESCALATION_SETTINGS = z.looseObject({
  escalationAgent: z.string().min(1).nullish(),
  escalationAgentActs: z.boolean().default(false),
  escalationAgentTimeoutSeconds: z
    .number()
    .positive()
    .default(DEFAULT_TIMEOUT_SECONDS),
  escalationAgentModel: z.string().min(1).default(DEFAULT_MODEL),
});

// A restart: held for `reason`, or started as job `job`, process `pid`.
type Resumed =
  | { kind: "held"; reason: string }
  | { kind: "started"; pid: number; job: string };

// The watchdog's commands a recommendation is carried out through.
interface AgentActs {
  // Sends `message` to session `key` of the job listening on `socket`.
  steer: (socket: string, key: string, message: string) => void;
  // Restarts the issue's `stage` job with --resume, giving the job's pid
  // and id, or gives why the start gate (or the job being live) holds it.
  resume: (issue: number, stage: string) => Resumed;
  // Stops the issue with stop `code`, giving `reason`.
  stop: (issue: number, code: string, reason: string) => void;
}

interface AdviceContext {
  watched: readonly WatchedJob[];
  states: ReadonlyMap<number, State | null>;
  now: Date;
  runAgent: RunAgent;
  act: AgentActs;
}

// One escalated issue, at the stage of its first escalation this tick.
interface Escalated {
  issue: number;
  stage: string;
}
// Where a log line is: its time, issue and stage.
type Where = Escalated & { at: string };

function issuesOf(escalations: readonly Escalation[]): Escalated[] {
  const issues: Escalated[] = [];
  for (const { issue, stage } of escalations) {
    if (!issues.some((seen) => seen.issue === issue)) {
      issues.push({ issue, stage });
    }
  }
  return issues;
}

// The first recommendation for `issue`, or none.
function actionFor(reply: Reply, issue: number): Action {
  const found = reply.recommendations.find((r) => r.issue === issue);
  return found?.action ?? { kind: "none" };
}

function reasonOf(action: Action): string {
  if (action.kind === "stop") {
    return `stop:${action.code}`;
  }
  return action.kind;
}

// The latest session launch of the issue's running job with no outcome.
function liveLaunch(
  watched: readonly WatchedJob[],
  issue: number,
): { socket: string; key: string } | null {
  const job = watched.find((w) => w.issue === issue);
  if (job === undefined || !job.running) {
    return null;
  }
  const launch = job.status.launches.findLast(
    ({ kind, outcome }) => kind === "session" && outcome === null,
  );
  if (launch === undefined) {
    return null;
  }
  return { socket: job.status.socket, key: launch.key };
}

function resumeOf(where: Where, ctx: AdviceContext): LogEntry {
  const job = ctx.watched.find((w) => w.issue === where.issue);
  if (job === undefined) {
    return { ...where, action: "held", reason: "no-job" };
  }
  if (job.live) {
    return { ...where, action: "held", reason: "live" };
  }
  const { stage } = job.status;
  const resumed = ctx.act.resume(where.issue, stage);
  if (resumed.kind === "held") {
    return { ...where, action: "held", reason: resumed.reason };
  }
  const { pid, job: id } = resumed;
  return { ...where, stage, action: "resumed", reason: "agent", pid, job: id };
}

// Carries out `action` through the watchdog's commands, and the line that
// logs it, or null for `none`.
function carryOut(
  where: Where,
  action: Action,
  ctx: AdviceContext,
): LogEntry | null {
  switch (action.kind) {
    case "steer": {
      const live = liveLaunch(ctx.watched, where.issue);
      if (live === null) {
        return { ...where, action: "held", reason: "no-live-session" };
      }
      ctx.act.steer(live.socket, live.key, action.message);
      return { ...where, action: "steered", reason: `agent:${live.key}` };
    }
    case "resume":
      return resumeOf(where, ctx);
    case "stop":
      ctx.act.stop(where.issue, action.code, action.reason);
      return { ...where, action: "stopped", reason: `agent:${action.code}` };
    case "none":
      return null;
    default: {
      const unknown: never = action;
      throw new Error(`unknown recommendation ${JSON.stringify(unknown)}`);
    }
  }
}

function carriedOut(
  where: Where,
  action: Action,
  ctx: AdviceContext,
): LogEntry | null {
  try {
    return carryOut(where, action, ctx);
  } catch {
    return { ...where, action: "agent-failed", reason: "failed" };
  }
}

// Asks the escalation agent, if one is set, about this tick's new
// `escalations`, logs its recommendations and, with acting on, carries them
// out. It never throws: a failure is logged for each escalated issue.
function adviseOnEscalations(
  cfg: Config,
  escalations: readonly Escalation[],
  ctx: AdviceContext,
): void {
  const settings = ESCALATION_SETTINGS.parse(cfg);
  const agent = settings.escalationAgent ?? null;
  if (agent === null || escalations.length === 0) {
    return;
  }
  const at = ctx.now.toISOString();
  const issues: Where[] = issuesOf(escalations).map((issue) => ({
    ...issue,
    at,
  }));
  const run = {
    name: agent,
    model: settings.escalationAgentModel,
    timeoutSeconds: settings.escalationAgentTimeoutSeconds,
  };
  const consulted = consult(cfg, run, escalations, ctx);
  if (consulted.kind === "failed") {
    const { reason } = consulted;
    logDecisions(
      cfg,
      issues.map((where) => ({ ...where, action: "agent-failed", reason })),
    );
    return;
  }
  const chosen = issues.map((where) => ({
    where,
    action: actionFor(consulted.reply, where.issue),
  }));
  logDecisions(
    cfg,
    chosen.map(({ where, action }) => ({
      ...where,
      action: "recommended",
      reason: reasonOf(action),
    })),
  );
  if (settings.escalationAgentActs) {
    const done = chosen.map(({ where, action }) =>
      carriedOut(where, action, ctx),
    );
    logDecisions(
      cfg,
      done.filter((line) => line !== null),
    );
  }
}

// The open issues the tick's escalations are raised over: each one's number,
// the stage its saved state names, and its label names.
interface Escalating {
  issues: readonly { number: number; stage: string | null }[];
  labels: ReadonlyMap<number, readonly string[]>;
}

// The attempt issue `issue` is at in the stage it runs, or for an issue
// saved at `stopped` the stage it stopped in: the watchdog's restarts of it
// there, plus 1.
function attemptOf(
  memory: WatchMemory,
  issue: number,
  state: State | null | undefined,
): number {
  let ran = state?.stage;
  if (ran === "stopped") {
    ran = state?.stoppedStage ?? ran;
  }
  return (memory.resumes[`${issue} ${ran}`] ?? 0) + 1;
}

// Raises the escalations `open` holds that the watchdog's `memory` doesn't
// hold yet, logs them, asks the escalation agent about them, then saves the
// memory with what is escalated now: kept only once every step is done, so a
// failed one is tried again on the next tick.
function escalateOpenIssues(
  cfg: Config,
  open: Escalating,
  memory: WatchMemory,
  ctx: AdviceContext,
): void {
  const flagged = open.issues.map(({ number, stage }) => {
    const job = ctx.watched.find((w) => w.issue === number);
    return {
      issue: number,
      stage,
      labels: open.labels.get(number) ?? [],
      budgetStopped: job !== undefined && budgetStopped(memory, job.status),
    };
  });
  const raised = escalate(flagged, memory.escalated, ctx.now);
  logEscalations(
    cfg,
    raised.escalations.map((escalation) => {
      const state = ctx.states.get(escalation.issue);
      const attempt = attemptOf(memory, escalation.issue, state);
      const issueTokens = state?.reportedTokens ?? 0;
      return { ...escalation, attempt, issueTokens };
    }),
  );
  adviseOnEscalations(cfg, raised.escalations, ctx);
  saveWatchMemory(cfg, { ...memory, escalated: raised.escalated });
}

export type { AdviceContext, AgentActs, Resumed };
export { escalateOpenIssues };
