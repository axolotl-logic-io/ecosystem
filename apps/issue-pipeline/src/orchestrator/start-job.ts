// How the orchestrator's tick (tick.ts) starts a stage job: the job's argv,
// with the random id it makes for the job (`--job-id`), which its usage
// records, context log and pushes carry too, the detached process, the
// ledger's note of it, and the start's log line, which names the job's pid
// and id. A start that lifts a stopped issue logs a `lifted` line before it.

import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { roleOf } from "../roles/registry.ts";
import type { State } from "../state.ts";
import type { Ledger } from "./ledger.ts";
import type { LogEntry } from "./log.ts";
import type { Decision } from "./schedule.ts";
import { LANE } from "./snapshot.ts";

interface Start {
  issue: number;
  stage: string;
  mergeQueue: readonly number[] | null;
  stackOn: number | null;
}

// A started job: its process and its id.
interface StartedJob {
  pid: number;
  job: string;
}

// What starting a job takes: the repo config's path, as the jobs are given
// it, the spawn of a detached job.mjs, and the ledger the start is noted in.
interface Starter {
  cfg: Config;
  configPath: string;
  spawn: (argv: readonly string[], log: string) => number;
  ledger: Ledger;
}

function jobArgv(configPath: string, start: Start, job: string): string[] {
  const argv = [
    "--config",
    configPath,
    "--issue",
    String(start.issue),
    "--stage",
    start.stage,
    "--lane",
    LANE,
    "--job-id",
    job,
  ];
  if (start.mergeQueue !== null) {
    argv.push("--merge-queue", start.mergeQueue.join(","));
  }
  if (start.stackOn !== null) {
    argv.push("--stack-on", String(start.stackOn));
  }
  return argv;
}

function startJob(
  starter: Starter,
  start: Start & { at: string; resume: boolean },
): StartedJob {
  const job = randomUUID();
  const argv = jobArgv(starter.configPath, start, job);
  // A stage that runs a role refuses --resume: it restarts from its state.
  if (start.resume && roleOf(start.stage) === undefined) {
    argv.push("--resume");
  }
  const { cfg } = starter;
  const pid = starter.spawn(argv, paths.jobLog(cfg, start.issue));
  const { issue, stage, at } = start;
  starter.ledger.launched({ issue, stage, pid, at });
  return { pid, job };
}

// The log lines of the scheduler's `decisions`, those it started with their
// job's pid and id from `started`, and each start of a lifted issue after a
// `lifted` line at its stopped stage, its reason the stop's code as the
// issue's saved state in `states` names it ("stopped" when it names none).
function decisionLines(
  decisions: readonly Decision[],
  started: ReadonlyMap<Decision, StartedJob>,
  states: ReadonlyMap<number, State | null>,
): LogEntry[] {
  return decisions.flatMap((decision): LogEntry[] => {
    const { at, issue, stage, action, reason } = decision;
    const line: LogEntry = { at, issue, stage, action, reason };
    const job = started.get(decision);
    if (job === undefined) {
      return [line];
    }
    const start = { ...line, ...job };
    if (reason !== "lifted") {
      return [start];
    }
    const stop = states.get(issue)?.stopCode ?? "stopped";
    return [{ at, issue, stage, action: "lifted", reason: stop }, start];
  });
}

export type { Start, StartedJob, Starter };
export { decisionLines, startJob };
