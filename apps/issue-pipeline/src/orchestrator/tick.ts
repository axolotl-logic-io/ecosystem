// One orchestrator tick (#234): read the queue, add what the jobs spent to
// the ledger, note a rate-limited job's backoff, let the watchdog act on the
// jobs and write the escalations (#235), ask the escalation agent about them
// (#282), decide with the scheduler, hold every start during a backoff, start
// the jobs it chose (start-job.ts), log every action and decision, then close
// the split parents that are done (#378). The processes, the steers, the agent's run
// and the clock come from the caller.

import { z } from "zod";
import type { Config } from "../config.ts";
import { stop } from "../ops/stop.ts";
import type { State } from "../state.ts";
import type { AdviceContext, Resumed } from "./escalation-agent.ts";
import { escalateOpenIssues } from "./escalation-agent.ts";
import type { RunAgent } from "./escalation-consult.ts";
import type { Ledger } from "./ledger.ts";
import { openLedger } from "./ledger.ts";
import type { LogEntry } from "./log.ts";
import { logDecisions } from "./log.ts";
import type { ParentOutcome } from "./parents.ts";
import { closeParents } from "./parents.ts";
import type { SnapshotIssue } from "./queue.ts";
import { openBackoff } from "./rate-limit-backoff.ts";
import type { Decision, StartGate } from "./schedule.ts";
import { schedule, startGate } from "./schedule.ts";
import { readQueue } from "./snapshot.ts";
import type { StartedJob } from "./start-job.ts";
import { decisionLines, startJob } from "./start-job.ts";
import type { WatchAction } from "./watchdog.ts";
import { watch } from "./watchdog.ts";
import { readWatchMemory } from "./watchdog-memory.ts";

// The config keys only the orchestrator reads; loadConfig applied their
// defaults.
const ORCHESTRATOR_SETTINGS = z.looseObject({
  maxJobs: z.number().int().positive(),
  stageCaps: z.record(z.string(), z.number().int().nonnegative()),
  // An optional throttle; null or 0 means no hourly limit.
  tokensPerHour: z.number().nonnegative().nullable(),
});
// The watchdog's keys (#235) and their defaults, kept with the one module
// that reads them, as config.ts is at its line limit.
const DEFAULT_MAX_RESUMES = 2;
const DEFAULT_SILENT_MINUTES = 30;
const DEFAULT_FAILURE_STREAK = 3;
const WATCH_SETTINGS = z.looseObject({
  maxResumes: z.number().int().nonnegative().default(DEFAULT_MAX_RESUMES),
  silentMinutes: z.number().positive().default(DEFAULT_SILENT_MINUTES),
  failureStreak: z.number().int().positive().default(DEFAULT_FAILURE_STREAK),
});

interface TickDeps {
  // The repo config's path, as the jobs are given it.
  configPath: string;
  now: () => Date;
  // Starts a detached job.mjs with `argv`, its stdout and stderr appended to
  // `log`, and returns its pid.
  spawn: (argv: readonly string[], log: string) => number;
  // Sends `message` to session `key` of the job listening on `socket`.
  steer: (socket: string, key: string, message: string) => void;
  // Sends SIGTERM to job process `pid`.
  terminate: (pid: number) => void;
  // Runs the escalation agent's `pi` to its end or its timeout.
  runAgent: RunAgent;
}

// What a tick acts with: the config, the caller's processes and the ledger.
interface TickRun {
  cfg: Config;
  deps: TickDeps;
  ledger: Ledger;
}

// Starts a job for `start` with the tick's processes and ledger.
function startOf(
  { cfg, deps, ledger }: TickRun,
  start: Parameters<typeof startJob>[1],
): StartedJob {
  const { configPath, spawn } = deps;
  return startJob({ cfg, configPath, spawn, ledger }, start);
}

// The stop code and the comment's reason for a watchdog stop.
function stopOf(action: WatchAction & { action: "stopped" }): {
  code: "job" | "budget";
  reason: string;
} {
  switch (action.reason) {
    case "max-resumes":
      return {
        code: "job",
        reason: `the stage job kept dying: its ${action.stage} job died with no outcome after the most restarts allowed`,
      };
    case "budget":
      return { code: "budget", reason: action.detail };
    default: {
      const unknown: never = action;
      throw new Error(`unknown watchdog stop ${JSON.stringify(unknown)}`);
    }
  }
}

// Carries out one watchdog action, and notes its effect on `issue`: a
// restarted job is live, a stopped issue is stopped. A held restart does
// nothing; the tick leaves its issue to a later tick. Gives the restarted
// job's pid and id, or null for any other action.
function act(
  run: TickRun,
  action: WatchAction,
  issue: { row: SnapshotIssue | undefined; state: State | null },
): StartedJob | null {
  switch (action.action) {
    case "resumed": {
      const { stage } = action;
      const started = startOf(run, {
        ...action,
        mergeQueue: null,
        stackOn: null,
        resume: true,
      });
      if (issue.row !== undefined) {
        issue.row.job = { live: true, stage };
      }
      return started;
    }
    case "stopped": {
      stop(run.cfg, {
        ...stopOf(action),
        number: action.issue,
        state: { ...issue.state },
      });
      if (issue.row !== undefined) {
        issue.row.stopped = true;
      }
      return null;
    }
    case "held":
      return null;
    case "steered":
      run.deps.steer(action.socket, action.key, action.message);
      return null;
    case "killed":
      run.deps.terminate(action.pid);
      return null;
    default: {
      const unknown: never = action;
      throw new Error(`unknown watchdog action ${JSON.stringify(unknown)}`);
    }
  }
}

// What the escalation agent reads, and the watchdog's commands its
// recommendations go through: the steer, a restart behind the start gate,
// and the stop op.
function adviceOf(
  run: TickRun,
  issues: readonly SnapshotIssue[],
  view: Omit<AdviceContext, "act" | "runAgent"> & { admit: StartGate },
): AdviceContext {
  function rowOf(n: number): SnapshotIssue | undefined {
    return issues.find((issue) => issue.number === n);
  }
  const { admit, ...seen } = view;
  const commands: AdviceContext["act"] = {
    steer: run.deps.steer,
    resume: (issue: number, stage: string): Resumed => {
      const row = rowOf(issue);
      if (row?.job?.live === true) {
        return { kind: "held", reason: "live" };
      }
      const held = admit(issue, stage);
      if (held !== null) {
        return { kind: "held", reason: held };
      }
      const at = view.now.toISOString();
      const restart = { issue, stage, at, mergeQueue: null, stackOn: null };
      const started = startOf(run, { ...restart, resume: true });
      if (row !== undefined) {
        row.job = { live: true, stage };
      }
      return { kind: "started", ...started };
    },
    stop: (issue: number, code: string, reason: string): void => {
      const state = { ...view.states.get(issue) };
      stop(run.cfg, { code, reason, number: issue, state });
      const row = rowOf(issue);
      if (row !== undefined) {
        row.stopped = true;
      }
    },
  };
  return { ...seen, runAgent: run.deps.runAgent, act: commands };
}

// The scheduler's decisions less those for issues whose restart the watchdog
// held: such an issue waits for its restart rather than starting anew.
function withoutHeld(
  decisions: readonly Decision[],
  done: readonly WatchAction[],
): Decision[] {
  const waiting = new Set(
    done.filter(({ action }) => action === "held").map(({ issue }) => issue),
  );
  return decisions.filter(({ issue }) => !waiting.has(issue));
}

// What a tick did: the scheduler's decisions, and what became of each open
// split parent, for which the scheduler makes no decision.
interface TickResult {
  decisions: Decision[];
  parents: ParentOutcome[];
}

// Runs one tick and returns what it did.
function tick(cfg: Config, deps: TickDeps): TickResult {
  const settings = ORCHESTRATOR_SETTINGS.parse(cfg);
  const ledger = openLedger(cfg);
  const now = deps.now();
  const { issues, jobs, watched, states, labels } = readQueue(
    cfg,
    ledger.started(),
    now,
  );
  ledger.record(jobs, now);
  const spentLastHour = ledger.spentLastHour(now);
  const backoff = openBackoff(cfg, jobs, now);
  const admit = backoff.gate(startGate({ issues, spentLastHour }, settings));
  const watchdog = watch(watched, readWatchMemory(cfg), {
    ...WATCH_SETTINGS.parse(cfg),
    now,
    admit,
  });
  const run: TickRun = { cfg, deps, ledger };
  const done: WatchAction[] = [];
  const restarted: LogEntry[] = [];
  const started = new Map<Decision, StartedJob>();
  let decisions: Decision[] = [];
  try {
    for (const action of watchdog.actions) {
      const row = issues.find((issue) => issue.number === action.issue);
      const job = act(run, action, {
        row,
        state: states.get(action.issue) ?? null,
      });
      done.push(action);
      restarted.push({ ...action, ...job });
    }
    const view = { watched, states, admit, now };
    const advice = adviceOf(run, issues, view);
    escalateOpenIssues(cfg, { issues, labels }, watchdog.memory, advice);
    const scheduled = schedule({ issues, spentLastHour }, settings, now);
    decisions = backoff.hold(withoutHeld(scheduled, done));
    for (const decision of decisions) {
      if (decision.action === "started") {
        started.set(decision, startOf(run, { ...decision, resume: false }));
      }
    }
  } finally {
    ledger.save(now);
    logDecisions(cfg, restarted);
  }
  logDecisions(cfg, decisionLines(decisions, started, states));
  const split = issues.filter(({ verdict }) => verdict.kind === "parent");
  const parents = closeParents(
    cfg,
    split.map(({ number }) => number),
    now,
  );
  return { decisions, parents };
}

export type { TickDeps, TickResult };
export { tick };
