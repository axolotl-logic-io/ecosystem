// One orchestrator tick (#234): read the queue, add what the jobs spent to
// the ledger, decide with the scheduler, start the jobs it chose and log every
// decision. The process and the clock come from the caller.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { openLedger } from "./ledger.ts";
import { logDecisions } from "./log.ts";
import type { Decision } from "./schedule.ts";
import { schedule } from "./schedule.ts";
import { LANE, readQueue } from "./snapshot.ts";

// The config keys only the orchestrator reads; loadConfig applied their
// defaults.
const ORCHESTRATOR_SETTINGS = z.looseObject({
  maxJobs: z.number().int().positive(),
  stageCaps: z.record(z.string(), z.number().int().nonnegative()),
  tokensPerHour: z.number().positive(),
});

interface TickDeps {
  // The repo config's path, as the jobs are given it.
  configPath: string;
  now: () => Date;
  // Starts a detached job.mjs with `argv`, its stdout and stderr appended to
  // `log`, and returns its pid.
  spawn: (argv: readonly string[], log: string) => number;
}

type Start = Extract<Decision, { action: "started" }>;

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

// Runs one tick and returns its decisions.
function tick(cfg: Config, deps: TickDeps): Decision[] {
  const settings = ORCHESTRATOR_SETTINGS.parse(cfg);
  const ledger = openLedger(cfg);
  const now = deps.now();
  const { issues, jobs } = readQueue(cfg, ledger.started(), now);
  ledger.record(jobs, now);
  const snapshot = { issues, spentLastHour: ledger.spentLastHour(now) };
  const decisions = schedule(snapshot, settings, now);
  try {
    for (const decision of decisions) {
      if (decision.action === "started") {
        const log = paths.jobLog(cfg, decision.issue);
        const pid = deps.spawn(jobArgv(deps.configPath, decision), log);
        const { issue, stage, at } = decision;
        ledger.launched({ issue, stage, pid, at });
      }
    }
  } finally {
    ledger.save(now);
  }
  logDecisions(cfg, decisions);
  return decisions;
}

export type { TickDeps };
export { tick };
