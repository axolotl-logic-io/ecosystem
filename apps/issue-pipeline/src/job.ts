#!/usr/bin/env node
// The stage job: one sweep pinned to one issue that begins only one stage.
//
//   node job.mjs --config <path> --issue N --stage <stage> [--lane L] [--resume]
//     [--merge-queue n1,n2,…] [--stack-on P]
//   node job.mjs --config <path> --issue N --steer <launch key> --message <text>
//   node job.mjs --config <path> --issue N --stage <stage> --print-boundary
//
// It claims #N, begins only <stage> (an issue saved at another stage is
// released untouched as "wrong-stage"), then closes parents, releases or
// posts, and cleans up as a sweep does. Each batch the sweep's driver asks
// for runs in parallel, up to the config's spawn cap: ops requests run the
// installed ops.mjs and model sessions run `pi --mode rpc`
// (src/job/launch.ts). While it runs it keeps the issue's job.json current
// (src/job/status.ts) and listens for steers (src/job/control.ts). It prints
// the sweep's summary as one JSON line and exits 0, even when the stage stops
// the issue; it exits 1, with the reason on stderr, only when the job itself
// fails: bad arguments, a config loadConfig refuses, or a failed sweep op.
//
// SIGTERM or SIGINT stops it: it aborts its sessions, saves a claimed open
// issue at its stage with no lease, and exits 128 + the signal's number with
// nothing on stdout. --resume carries on the sessions an earlier stopped job
// left in job.json. --steer sends a message to a live session of the job
// running for #N, exiting 0 once pi accepted it and 1 otherwise. --stack-on P
// starts an issue with no branch of its own on #P's branch (#268).
//
// Each pi session runs with the env of its role (src/job/roles.ts): no gh
// token but its role's own; ops keep the job's env. --print-boundary prints
// the stage job's boundary as one JSON line and starts nothing.
//
// A stage registered with a role (src/roles/registry.ts) runs that role on
// the role runner instead of the sweep (src/job/role-run.ts) and prints
// { issue, stage, end }; --resume is refused for it.
//
// The job works in its own checkout, cloned from a bare mirror of the repo
// (src/job/checkout.ts), where every pi session runs. On every exit it
// records and drops what the checkout left uncommitted (lostChanges), a
// writer pushes what the remote lacks (src/job/exit-push.ts), and the
// checkout is removed.

import os from "node:os";
import process from "node:process";
import { z } from "zod";
import type { Config } from "./config.ts";
import { loadConfig, paths } from "./config.ts";
import type { RunArgs, SteerArgs } from "./job/args.ts";
import { jobArgsOf } from "./job/args.ts";
import { closeJobCheckout, openJobCheckout } from "./job/checkout.ts";
import type { Control, LiveLaunch } from "./job/control.ts";
import { openControl, steerJob } from "./job/control.ts";
import { exitPushOf } from "./job/exit-push.ts";
import type { LaunchHooks } from "./job/launch.ts";
import { runLaunch } from "./job/launch.ts";
import { runAll } from "./job/pool.ts";
import type { OpsRaw, SessionRaw } from "./job/raw-results.ts";
import type { RoleLine } from "./job/role-run.ts";
import { runRoleStage } from "./job/role-run.ts";
import { agentEnvOf, boundaryOf, rolesOf, sessionRoleOf } from "./job/roles.ts";
import type {
  JobOutcome,
  JobStatus,
  LaunchStart,
  StopSignal,
} from "./job/status.ts";
import { openStatus, resumePoints, socketOf } from "./job/status.ts";
import { roleOf } from "./roles/registry.ts";
import type { LaunchSpec } from "./workflow/launches.ts";
import { opsFrame } from "./workflow/launches.ts";
import type { SweepSummary } from "./workflow/stages/types.ts";
import type { Sweep } from "./workflow/sweep.ts";
import { startSweep } from "./workflow/sweep.ts";
import { laneOf, spawnLimitOf } from "./workflow/sweep-config.ts";

// A sweep's id is "s" and the start time in base 36, as workflow.js makes it.
const SWEEP_ID_RADIX = 36;
// A process a signal ended exits with 128 + the signal's number.
const SIGNAL_EXIT_BASE = 128;
const SPAWN_CAP = z.number().nullish().catch(null);
// A stage that runs a role always restarts from what is done (#301).
const RESUME_REFUSED = "--resume doesn't apply to stage";

type Resume = LaunchHooks["resumePoint"];

// How a run ended: finished with the sweep's summary (or a role stage's
// line), or stopped by a signal.
type RunEnd =
  | { kind: "finished"; summary: SweepSummary | RoleLine }
  | { kind: "stopped"; signal: StopSignal };

// What the job's launches tell its status file and its control.
function hooksOf(
  cfg: Config,
  args: RunArgs,
  watch: { status: JobStatus; control: Control; resumePoint: Resume },
  cwd: string,
): LaunchHooks {
  const { status, control, resumePoint } = watch;
  const roles = rolesOf(cfg.jobRoles);
  return {
    sessionFile: (key: string): string => paths.session(cfg, args.issue, key),
    resumePoint,
    started: (launch: LaunchStart, live: LiveLaunch | null): void => {
      status.started(launch);
      if (live !== null) {
        control.register(live);
      }
    },
    record: status.record,
    ended: status.ended,
    contextLimits: cfg.contextLimits,
    contextStopped: status.contextStopped,
    env: (agent: string): Readonly<Record<string, string>> =>
      agentEnvOf(sessionRoleOf(agent), roles, process.env),
    cwd,
  };
}

// Runs each batch the sweep asks for, feeding its results back, until the
// sweep asks for none or a signal stops the job. A stop starts no more
// launches and throws the batch's results away.
async function drive(
  sweep: Sweep,
  limit: number,
  job: { hooks: LaunchHooks; status: JobStatus; control: Control },
): Promise<StopSignal | null> {
  async function next(
    specs: readonly LaunchSpec[],
  ): Promise<StopSignal | null> {
    if (specs.length === 0) {
      return null;
    }
    const results = await runAll(
      specs,
      limit,
      async (spec: LaunchSpec): Promise<OpsRaw | SessionRaw | null> => {
        if (job.control.stopping() !== null) {
          return null;
        }
        return await runLaunch(spec, job.hooks);
      },
    );
    const signal = job.control.stopping();
    if (signal !== null) {
      return signal;
    }
    specs.forEach(({ key }: LaunchSpec, index: number): void => {
      let outcome: "ok" | "failed" = "failed";
      if (results[index]?.ok === true) {
        outcome = "ok";
      }
      job.status.settled(key, outcome);
    });
    return await next(sweep.next(results));
  }
  return await next(sweep.next([]));
}

async function runStage(args: RunArgs, cfg: Config): Promise<RunEnd> {
  const { issue, stage, lane = null, stackOn = null } = args;
  const role = roleOf(stage);
  if (role !== undefined && args.resume === true) {
    throw new Error(
      `${RESUME_REFUSED} ${stage}; it restarts from what is done`,
    );
  }
  const dir = openJobCheckout(cfg, issue, { stage, stackOn });
  const checkout = { issue, dir };
  const sweepId = `s${Date.now().toString(SWEEP_ID_RADIX)}`;
  const runDir = paths.runDir(cfg, args.issue);
  // Read before openStatus replaces the earlier job's file.
  let resumePoint: Resume = (): null => null;
  if (args.resume === true) {
    resumePoint = resumePoints(runDir);
  }
  const control = await openControl(runDir);
  const job = { issue, stage, lane, socket: control.socket };
  const status = openStatus(runDir, job);
  const watch = { status, control, resumePoint };
  const hooks = hooksOf(cfg, args, watch, checkout.dir);
  const frame = opsFrame({ ...args, checkout }, sweepId, laneOf(args, sweepId));
  const push = exitPushOf(args, frame, hooks);
  const watched = { hooks, status, control };
  let ending: Promise<RunEnd>;
  if (role === undefined) {
    const sweep = startSweep(
      { ...args, checkout },
      { sweepId, now: (): Date => new Date() },
    );
    const { maxSpawnsPerRun } = cfg;
    const limit = spawnLimitOf(SPAWN_CAP.parse(maxSpawnsPerRun));
    ending = runDriven(sweep, limit, watched);
  } else {
    const roleJob = { role, issue, stage, stackOn, frame, dir, ...watched };
    ending = runRoleStage(roleJob);
  }
  try {
    const end = await ending;
    status.finish(outcomeOf(end));
    return end;
  } catch (error: unknown) {
    status.finish({ kind: "failed", error: messageOf(error) });
    throw error;
  } finally {
    try {
      const lost = await closeJobCheckout(cfg, issue, checkout.dir, push);
      status.lostChanges(lost);
    } finally {
      control.close();
    }
  }
}

// Drives the sweep to its end, or to a stop, after which it saves the issue
// the stages held.
async function runDriven(
  sweep: Sweep,
  limit: number,
  job: { hooks: LaunchHooks; status: JobStatus; control: Control },
): Promise<RunEnd> {
  const signal = await drive(sweep, limit, job);
  if (signal === null) {
    return { kind: "finished", summary: sweep.summary() };
  }
  const save = sweep.interrupt();
  if (save !== null) {
    await runLaunch(save, job.hooks);
  }
  return { kind: "stopped", signal };
}

function outcomeOf(end: RunEnd): JobOutcome {
  if (end.kind === "finished") {
    return { kind: "finished" };
  }
  return { kind: "stopped", signal: end.signal };
}

async function steer(args: SteerArgs, cfg: Config): Promise<void> {
  const socket = socketOf(paths.runDir(cfg, args.issue));
  if (socket === null) {
    throw new Error(`no running job for #${args.issue}`);
  }
  const error = await steerJob(socket, args.steer, args.message);
  if (error !== null) {
    throw new Error(error);
  }
}

function exitCodeOf(signal: StopSignal): number {
  const { SIGTERM, SIGINT } = os.constants.signals;
  switch (signal) {
    case "SIGTERM":
      return SIGNAL_EXIT_BASE + SIGTERM;
    case "SIGINT":
      return SIGNAL_EXIT_BASE + SIGINT;
    default:
      return unreachable(signal);
  }
}

function unreachable(value: never): never {
  throw new Error(`job: unexpected ${JSON.stringify(value)}`);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  try {
    const args = jobArgsOf(process.argv.slice(2));
    const cfg = loadConfig(args.config);
    if (args.kind === "steer") {
      await steer(args, cfg);
      return;
    }
    if (args.kind === "boundary") {
      const boundary = boundaryOf(cfg, args.issue, args.stage, process.env);
      process.stdout.write(`${JSON.stringify(boundary)}\n`);
      return;
    }
    const end = await runStage(args, cfg);
    if (end.kind === "finished") {
      process.stdout.write(`${JSON.stringify(end.summary)}\n`);
      return;
    }
    process.stderr.write(`job: stopped by ${end.signal}\n`);
    process.exitCode = exitCodeOf(end.signal);
  } catch (error: unknown) {
    process.stderr.write(`job: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
