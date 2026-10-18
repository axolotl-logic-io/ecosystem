#!/usr/bin/env node
// The stage job: one sweep pinned to one issue that begins only one stage.
//
//   node job.mjs --config <path> --issue N --stage <stage> [--lane L] [--resume]
//     [--merge-queue n1,n2,…] [--stack-on P] [--job-id <uuid>]
//   node job.mjs --config <path> --issue N --steer <launch key> --message <text>
//   node job.mjs --config <path> --issue N --stage <stage> --print-boundary
//
// It claims #N, begins only <stage> (an issue saved at another stage is
// released untouched as "wrong-stage"), then closes parents, releases or
// posts, and cleans up as a sweep does. Each batch the sweep's driver asks
// for runs in parallel, up to the spawn cap: ops run the installed ops.mjs
// and model sessions `pi --mode rpc` (src/job/launch.ts). It keeps job.json
// current (status.ts), logs each ended session to context.jsonl
// (context-log.ts) and listens for steers (control.ts). It prints the
// sweep's summary as one JSON line and exits 0, even when the stage stops
// the issue; it exits 1, with the reason on stderr, only when the job itself
// fails: bad arguments, a config loadConfig refuses, or a failed sweep op.
//
// SIGTERM or SIGINT stops it: it aborts its sessions, saves a claimed open
// issue at its stage with no lease, and exits 128 + the signal's number with
// nothing on stdout. --resume carries on the sessions an earlier stopped job
// left in job.json. --steer sends a message to a live session of the job
// running for #N, exiting 0 once pi accepted it and 1 otherwise. --stack-on P
// starts an issue with no branch of its own on #P's branch (#268). --job-id
// names the job as the orchestrator logged its start; without it the job
// makes its own. Every stage's job appends a usage record for each session
// and one for itself (src/job/usage-append.ts), and each writer commit names
// its session and the job's start (src/job/pipeline-commit.ts).
//
// No pi session gets a gh token (src/job/roles.ts); ops keep the job's env.
// A writer session commits through pipeline_commit, which asks the job over
// its control socket to push (src/job/commit-push.ts). --print-boundary prints
// the stage job's boundary as one JSON line and starts nothing.
//
// A stage with a registered role (src/roles/registry.ts) runs it on the role
// runner (src/job/role-run.ts), printing { issue, stage, end }; no --resume.
// Any other stage drives the sweep (src/job/driven-run.ts).
//
// The job works in its own folder, where every pi session runs, holding its
// code checkout, cloned from a bare mirror of the repo, and its wiki checkout
// (src/job/checkout.ts). On every exit (src/job/teardown.ts) it saves what
// the checkouts left uncommitted as patches in the run folder
// (droppedPatches), records and drops it (lostChanges), a writer pushes what
// the remotes lack (src/job/exit-push.ts), and the folder is removed; a run
// that stopped with saved patches posts a comment saying so (#369).

import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";
import { z } from "zod";
import type { Config } from "./config.ts";
import { loadConfig, paths } from "./config.ts";
import type { RunArgs, SteerArgs } from "./job/args.ts";
import { jobArgsOf } from "./job/args.ts";
import { openJobCheckout } from "./job/checkout.ts";
import { pushServerOf } from "./job/commit-push.ts";
import type { Control } from "./job/control.ts";
import { openControl, socketPathOf } from "./job/control.ts";
import { steerJob } from "./job/control-protocol.ts";
import type { DrivenJob } from "./job/driven-run.ts";
import { runDriven } from "./job/driven-run.ts";
import { exitPushOf } from "./job/exit-push.ts";
import type { LaunchHooks } from "./job/launch.ts";
import { runRoleStage } from "./job/role-run.ts";
import { boundaryOf, STAGE_WIKI_ACCESS } from "./job/roles.ts";
import { hooksOf } from "./job/session-hooks.ts";
import type { JobOutcome, StopSignal } from "./job/status.ts";
import { openStatus, resumePoints, socketOf } from "./job/status.ts";
import type { ExitingJob, RunEnd } from "./job/teardown.ts";
import { jobKeyOf, tearDown } from "./job/teardown.ts";
import { roleOf } from "./roles/registry.ts";
import type { OpsFrame } from "./workflow/launches.ts";
import { opsFrame } from "./workflow/launches.ts";
import { claimErrorOf, rateLimitedRun } from "./workflow/stages/rate-limit.ts";
import { startSweep } from "./workflow/sweep.ts";
import { laneOf, spawnLimitOf } from "./workflow/sweep-config.ts";
import type { JobLayout } from "./workflow/types.ts";

// A sweep's id is "s" and the start time in base 36, as workflow.js makes it.
const SWEEP_ID_RADIX = 36;
// A process a signal ended exits with 128 + the signal's number.
const SIGNAL_EXIT_BASE = 128;
const SPAWN_CAP = z.number().nullish().catch(null);
// A stage that runs a role always restarts from what is done (#301).
const RESUME_REFUSED = "--resume doesn't apply to stage";

type Resume = LaunchHooks["resumePoint"];

// What a stage's run is given besides its args: the job's launches' hooks,
// status and control, its ops frame and sweep id, its code checkout and
// folder, the issue's run folder, and the job's random id and start.
interface StageRun {
  watched: Pick<DrivenJob, "hooks" | "status" | "control">;
  frame: OpsFrame;
  sweepId: string;
  checkout: { issue: number; dir: string };
  layout: JobLayout;
  runDir: string;
  identity: { id: string; startedAt: string };
}

// The sweep's run of the stage `args` names, for a stage with no role.
function drivenRun(cfg: Config, args: RunArgs, run: StageRun): Promise<RunEnd> {
  const { checkout, layout, sweepId, identity } = run;
  const sweep = startSweep(
    { ...args, checkout, job: layout },
    { sweepId, now: (): Date => new Date() },
  );
  const { maxSpawnsPerRun } = cfg;
  const limit = spawnLimitOf(SPAWN_CAP.parse(maxSpawnsPerRun));
  const usage = {
    repo: cfg.repo,
    issue: args.issue,
    job: identity.id,
    jobStartedAt: identity.startedAt,
    limits: cfg.contextLimits,
  };
  return runDriven(sweep, {
    ...run.watched,
    stage: args.stage,
    limit,
    frame: run.frame,
    usage,
    runDir: run.runDir,
  });
}

async function runStage(args: RunArgs, cfg: Config): Promise<RunEnd> {
  const { issue, stage, lane = null, stackOn = null } = args;
  const key = jobKeyOf(stage, new Date());
  const role = roleOf(stage);
  if (role !== undefined && args.resume === true) {
    throw new Error(
      `${RESUME_REFUSED} ${stage}; it restarts from what is done`,
    );
  }
  const wiki = STAGE_WIKI_ACCESS[stage];
  const dirs = openJobCheckout(cfg, issue, { stage, stackOn });
  const { root, repo } = dirs;
  const checkout = { issue, dir: repo };
  const layout = { dir: root, docs: wiki };
  const sweepId = `s${Date.now().toString(SWEEP_ID_RADIX)}`;
  const runDir = paths.runDir(cfg, args.issue);
  // Read before openStatus replaces the earlier job's file.
  let resumePoint: Resume = (): null => null;
  if (args.resume === true) {
    resumePoint = resumePoints(runDir);
  }
  const id = args.jobId ?? randomUUID();
  const identity = { id, startedAt: new Date().toISOString() };
  const job = { issue, stage, lane, socket: socketPathOf(runDir) };
  const status = openStatus(runDir, { ...job, ...identity });
  const control = await openControl(
    runDir,
    pushServerOf(cfg, { issue, stage, checkout: repo, id }, status.pushed),
  );
  const watch = { status, control, resumePoint };
  const where = { cwd: root, repo, from: process.env, job: identity };
  const hooks = hooksOf(cfg, args, watch, where);
  const frame = opsFrame({ ...args, checkout }, sweepId, laneOf(args, sweepId));
  const push = exitPushOf(args, frame, hooks);
  const exiting = { issue, key, dirs, wiki, push, frame, hooks, status };
  const watched = { hooks, status, control };
  let ending: Promise<RunEnd>;
  if (role === undefined) {
    const run = { watched, frame, sweepId, checkout, layout, runDir };
    ending = drivenRun(cfg, args, { ...run, identity });
  } else {
    const roleJob = { role, cfg, issue, stage, stackOn, frame, repo, layout };
    const jobStartedAt = identity.startedAt;
    ending = runRoleStage({ ...roleJob, ...watched, jobId: id, jobStartedAt });
  }
  return await settle(cfg, ending, { ...exiting, control });
}

// Waits for the run's end and records it in job.json, then, whatever
// happened, tears the job down and closes its control socket.
async function settle(
  cfg: Config,
  ending: Promise<RunEnd>,
  job: ExitingJob & { control: Control },
): Promise<RunEnd> {
  const { status, control } = job;
  let end: RunEnd | null = null;
  try {
    end = await ending;
    status.finish(outcomeOf(end));
    return end;
  } catch (error: unknown) {
    status.finish({ kind: "failed", error: messageOf(error) });
    throw error;
  } finally {
    try {
      await tearDown(cfg, job, end);
    } finally {
      control.close();
    }
  }
}

function outcomeOf(end: RunEnd): JobOutcome {
  if (end.kind === "finished") {
    const rateLimited = rateLimitedRun(end.summary);
    const claimError = claimErrorOf(end.summary);
    if (claimError === null) {
      return { kind: "finished", rateLimited };
    }
    return { kind: "finished", rateLimited, claimError };
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
