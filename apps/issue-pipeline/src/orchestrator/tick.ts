// One orchestrator tick: read the queue (snapshot.ts), stop each issue whose
// claim keeps failing (claim-failures.ts), note a backoff after a rate limit
// or transport error (rate-limit-backoff.ts), let the scheduler decide
// (schedule.ts), carry out its decisions, keep what it remembers and log
// every decision, then close the split parents that are done (parents.ts).
// A start on new trusted input first saves the issue at `author`, from its
// state read again just then, and is held instead when that state changed
// or another claimant's lease went live. The processes and the clock come
// from the caller.

import { z } from "zod";
import type { Config } from "../config.ts";
import { stop } from "../ops/stop.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import type { Stage } from "../stages.ts";
import { STAGES } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { newIssueState } from "../state.ts";
import { claimFailureStops } from "./claim-failures.ts";
import { reauthoredState } from "./issue-plan.ts";
import type { LogEntry } from "./log.ts";
import { logDecisions } from "./log.ts";
import type { ParentOutcome } from "./parents.ts";
import { closeParents, parentLines } from "./parents.ts";
import type { ScheduleSettings } from "./queue.ts";
import { openBackoff } from "./rate-limit-backoff.ts";
import type { Decision } from "./schedule.ts";
import { schedule } from "./schedule.ts";
import type { Queue } from "./snapshot.ts";
import { readQueue } from "./snapshot.ts";
import type { StartRecord } from "./start-job.ts";
import { readStarts, saveStarts, startJob } from "./start-job.ts";
import { readMemory, saveMemory } from "./watchdog-memory.ts";

const MS_PER_HOUR = 3_600_000;
const DEFAULT_MAX_RESUMES = 2;
const DEFAULT_CLAIM_FAILURE_STREAK = 3;
// The config keys only the orchestrator reads; loadConfig applied the
// defaults of those it knows.
const TICK_SETTINGS = z.looseObject({
  maxJobs: z.number().int().positive(),
  stageCaps: z.record(z.string(), z.number().int().nonnegative()),
  maxResumes: z.number().int().nonnegative().default(DEFAULT_MAX_RESUMES),
  claimFailureStreak: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_CLAIM_FAILURE_STREAK),
  skipLabels: z.array(z.string()).nullish(),
  takeNewWork: z.unknown().optional(),
  leaseHours: z.number().positive(),
});

interface TickDeps {
  // The repo config's path, as the jobs are given it.
  configPath: string;
  now: () => Date;
  // Starts a detached job.mjs with `argv`, its stdout and stderr appended to
  // `log`, and returns its pid.
  spawn: (argv: readonly string[], log: string) => number;
  // True while `pid` is a running stage job.
  alive: (pid: number) => boolean;
}

// What a tick did: the scheduler's decisions as carried out, and what became
// of each open split parent.
interface TickResult {
  decisions: Decision[];
  parents: ParentOutcome[];
}

function settingsOf(
  cfg: Config,
): ScheduleSettings & { claimFailureStreak: number } {
  const parsed = TICK_SETTINGS.parse(cfg);
  const stageCaps: Partial<Record<Stage, number>> = {};
  for (const stage of STAGES) {
    const { [stage]: cap } = parsed.stageCaps;
    if (cap !== undefined) {
      stageCaps[stage] = cap;
    }
  }
  return {
    maxJobs: parsed.maxJobs,
    stageCaps,
    maxResumes: parsed.maxResumes,
    claimFailureStreak: parsed.claimFailureStreak,
    skipLabels: parsed.skipLabels ?? [],
    takeNewWork: parsed.takeNewWork !== false,
    leaseMs: parsed.leaseHours * MS_PER_HOUR,
  };
}

// Stops issue `number` at `stage` with the stop op, from its saved state.
function stopAt(
  cfg: Config,
  number: number,
  state: IssueState | null,
  stopping: { code: "job" | "error"; reason: string; stage: Stage },
): void {
  const base = state ?? newIssueState(number);
  const { code, reason, stage } = stopping;
  stop(cfg, { code, reason, number, state: { ...base, stage } });
}

// What carrying out the decisions takes and gives.
interface Run {
  cfg: Config;
  deps: TickDeps;
  queue: Queue;
  settings: ScheduleSettings;
  now: Date;
  starts: StartRecord[];
  lines: LogEntry[];
}

type Start = Extract<Decision, { action: "started" }>;

// Saves a re-authored issue at `author`; the decision as carried out.
function reauthorFirst(run: Run, start: Start): Decision {
  const { cfg, now } = run;
  const { reauthor, issue } = start;
  if (reauthor === null) {
    return start;
  }
  const fresh = readWriteState(cfg, issue);
  const seen = run.queue.states.get(issue) ?? null;
  const { leaseMs } = run.settings;
  const result = reauthoredState({ fresh, seen }, reauthor, { now, leaseMs });
  if (result.kind === "held") {
    const { at, stage } = start;
    return { action: "held", at, issue, stage, reason: result.reason };
  }
  writeState(cfg, issue, result.state);
  run.lines.push({
    at: start.at,
    issue,
    stage: start.stage,
    action: "reauthor",
    reason: reauthor.resumeStage ?? "none",
  });
  return start;
}

// Carries out one decision and logs it; the decision as carried out.
function carryOut(run: Run, decision: Decision): Decision {
  const { at, issue, stage, action, reason } = decision;
  const line: LogEntry = { at, issue, stage, action, reason };
  if (action === "held") {
    run.lines.push(line);
    return decision;
  }
  const state = run.queue.states.get(issue) ?? null;
  if (action === "stopped") {
    const why = `the stage job kept dying: its ${stage} job died or failed after the most restarts allowed`;
    stopAt(run.cfg, issue, state, { code: "job", reason: why, stage });
    run.lines.push(line);
    return decision;
  }
  const done = reauthorFirst(run, decision);
  if (done.action !== "started") {
    return carryOut(run, done);
  }
  if (reason === "lifted") {
    const code = state?.stopCode ?? "stopped";
    run.lines.push({ at, issue, stage, action: "lifted", reason: code });
  }
  const { configPath, spawn } = run.deps;
  const starter = { cfg: run.cfg, configPath, spawn };
  const started = startJob(starter, done);
  run.starts.push(started);
  run.lines.push({ ...line, pid: started.pid, job: started.job });
  return done;
}

// Runs one tick and returns what it did.
function tick(cfg: Config, deps: TickDeps): TickResult {
  const now = deps.now();
  const at = now.toISOString();
  const settings = settingsOf(cfg);
  const memory = readMemory(cfg);
  const starts = readStarts(cfg);
  const { alive } = deps;
  const { mergeWindow } = memory;
  const queue = readQueue(cfg, { alive, starts, mergeWindow });
  const { issues } = queue.snapshot;
  const run: Run = { cfg, deps, queue, settings, now, starts, lines: [] };
  const claims = claimFailureStops(
    issues,
    memory.claimFailures,
    settings.claimFailureStreak,
  );
  const decisions: Decision[] = [];
  try {
    for (const { issue, stage, detail } of claims.stops) {
      const state = queue.states.get(issue) ?? null;
      stopAt(cfg, issue, state, { code: "error", reason: detail, stage });
      run.lines.push({
        at,
        issue,
        stage,
        action: "stopped",
        reason: "claim-failed",
      });
    }
    const stopped = new Set(claims.stops.map(({ issue }) => issue));
    const gate = openBackoff(cfg, queue.ends, now);
    const scheduled = schedule(
      {
        issues: issues.filter(({ number }) => !stopped.has(number)),
        mergeWindow,
      },
      settings,
      { now, gate, resumes: memory.resumes },
    );
    memory.resumes = scheduled.memory.resumes;
    memory.mergeWindow = scheduled.memory.mergeWindow;
    for (const decision of scheduled.decisions) {
      decisions.push(carryOut(run, decision));
    }
  } finally {
    memory.claimFailures = claims.streaks;
    saveMemory(cfg, memory);
    saveStarts(cfg, starts, new Set(issues.map(({ number }) => number)));
    logDecisions(cfg, run.lines);
  }
  const parents = closeParents(cfg, queue.parents);
  logDecisions(
    cfg,
    parents.flatMap((outcome) => parentLines(outcome, at)),
  );
  return { decisions, parents };
}

export type { TickDeps, TickResult };
export { tick };
