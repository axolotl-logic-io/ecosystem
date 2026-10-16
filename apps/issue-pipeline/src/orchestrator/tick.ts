// One orchestrator tick (#234): read the queue, add what the jobs spent to
// the ledger, let the watchdog act on the jobs and write the escalations
// (#235), decide with the scheduler, start the jobs it chose and log every
// action and decision. The
// processes, the steers and the clock come from the caller.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { stop } from "../ops/stop.ts";
import type { State } from "../state.ts";
import { escalate } from "./escalate.ts";
import type { Ledger } from "./ledger.ts";
import { openLedger } from "./ledger.ts";
import { logDecisions, logEscalations } from "./log.ts";
import type { SnapshotIssue } from "./queue.ts";
import type { Decision } from "./schedule.ts";
import { schedule, startGate } from "./schedule.ts";
import { LANE, readQueue } from "./snapshot.ts";
import type { WatchAction } from "./watchdog.ts";
import { watch } from "./watchdog.ts";
import { budgetStopped } from "./watchdog-budget.ts";
import { readWatchMemory, saveWatchMemory } from "./watchdog-memory.ts";

// The config keys only the orchestrator reads; loadConfig applied their
// defaults.
const ORCHESTRATOR_SETTINGS = z.looseObject({
  maxJobs: z.number().int().positive(),
  stageCaps: z.record(z.string(), z.number().int().nonnegative()),
  tokensPerHour: z.number().positive(),
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
}

interface Start {
  issue: number;
  stage: string;
  mergeQueue: readonly number[] | null;
}

function jobArgv(configPath: string, start: Start): string[] {
  const argv = [
    "--config",
    configPath,
    "--issue",
    String(start.issue),
    "--stage",
    start.stage,
    "--lane",
    LANE,
  ];
  if (start.mergeQueue !== null) {
    argv.push("--merge-queue", start.mergeQueue.join(","));
  }
  return argv;
}

// What a tick acts with: the config, the caller's processes and the ledger.
interface TickRun {
  cfg: Config;
  deps: TickDeps;
  ledger: Ledger;
}

function startJob(
  { cfg, deps, ledger }: TickRun,
  start: Start & { at: string; resume: boolean },
): void {
  const argv = jobArgv(deps.configPath, start);
  if (start.resume) {
    argv.push("--resume");
  }
  const pid = deps.spawn(argv, paths.jobLog(cfg, start.issue));
  const { issue, stage, at } = start;
  ledger.launched({ issue, stage, pid, at });
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
// nothing; the tick leaves its issue to a later tick.
function act(
  run: TickRun,
  action: WatchAction,
  issue: { row: SnapshotIssue | undefined; state: State | null },
): void {
  switch (action.action) {
    case "resumed": {
      const { stage } = action;
      startJob(run, {
        ...action,
        mergeQueue: null,
        resume: true,
      });
      if (issue.row !== undefined) {
        issue.row.job = { live: true, stage };
      }
      return;
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
      return;
    }
    case "held":
      return;
    case "steered":
      run.deps.steer(action.socket, action.key, action.message);
      return;
    case "killed":
      run.deps.terminate(action.pid);
      return;
    default: {
      const unknown: never = action;
      throw new Error(`unknown watchdog action ${JSON.stringify(unknown)}`);
    }
  }
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

// Runs one tick and returns its decisions.
function tick(cfg: Config, deps: TickDeps): Decision[] {
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
  const watchdog = watch(watched, readWatchMemory(cfg), {
    ...WATCH_SETTINGS.parse(cfg),
    now,
    admit: startGate({ issues, spentLastHour }, settings),
  });
  const run: TickRun = { cfg, deps, ledger };
  const done: WatchAction[] = [];
  let decisions: Decision[] = [];
  try {
    for (const action of watchdog.actions) {
      const row = issues.find((issue) => issue.number === action.issue);
      act(run, action, {
        row,
        state: states.get(action.issue) ?? null,
      });
      done.push(action);
    }
    const flagged = issues.map(({ number, stage }) => {
      const job = watched.find((w) => w.issue === number);
      return {
        issue: number,
        stage,
        labels: labels.get(number) ?? [],
        budgetStopped:
          job !== undefined && budgetStopped(watchdog.memory, job.status),
      };
    });
    const raised = escalate(flagged, watchdog.memory.escalated, now);
    logEscalations(cfg, raised.escalations);
    // Kept only once every action is done, so a failed one is tried again.
    saveWatchMemory(cfg, { ...watchdog.memory, escalated: raised.escalated });
    decisions = withoutHeld(
      schedule({ issues, spentLastHour }, settings, now),
      done,
    );
    for (const decision of decisions) {
      if (decision.action === "started") {
        startJob(run, { ...decision, resume: false });
      }
    }
  } finally {
    ledger.save(now);
    logDecisions(cfg, done);
  }
  logDecisions(cfg, decisions);
  return decisions;
}

export type { TickDeps };
export { tick };
