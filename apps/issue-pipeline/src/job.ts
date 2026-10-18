#!/usr/bin/env node
// The stage job: one job pinned to one issue that runs only one stage.
//
//   node job.mjs --config <path> --issue N --stage <stage> --branch <name>
//     --brain-path <wiki clone> [--lane L] [--merge-queue n1,n2,…]
//     [--job-id <uuid>]
//   node job.mjs --config <path> --issue N --steer <launch key> --message <text>
//   node job.mjs --config <path> --issue N --stage <stage> --branch <name>
//     --brain-path <wiki clone> --print-boundary
//
// Its caller assigns it the issue and the issue's branch; it never picks
// another issue. Before it claims or clones anything it refuses a branch git
// wouldn't take literally and one the repo protects: its base, its wiki's
// branch, the remote's default (src/job/branch.ts). Both checkouts, every
// ops request and every push name that branch; the claim refuses one the
// issue's saved state isn't bound to. It then pins, from the wiki clone
// --brain-path names, the behavioral prompt page of each session its stage
// runs, failing on one it can't read (src/job/brain.ts); pi appends a
// session's page to its agent's system prompt, and it grants nothing. It
// claims #N and runs the stage's role (src/roles/registry.ts) on the role
// runner (src/job/role-run.ts), always fresh: a restarted job starts the
// stage again from what is saved. An issue saved at another stage is released
// untouched, but a merge job finishes a done issue's recorded completion.
// Ops run the installed ops.mjs and model sessions
// `pi --mode rpc` (src/job/launch.ts), bounded only by their timeouts. It
// keeps job.json current (status.ts), logs each ended session to
// context.jsonl (context-log.ts), appends a usage record for each session and
// one for itself (src/job/usage-append.ts), and listens for steers
// (control.ts). It prints one JSON line, the role run's JobLine
// {issue, stage, end, reason?, claimError?}, and exits 0, even when the stage
// stops the issue; it exits 1, with the reason on stderr, only when the job
// itself fails: bad arguments, a config loadConfig refuses, a refused
// branch, a prompt page it can't pin, a stage with no role, or an op of its
// own that failed.
//
// SIGTERM or SIGINT stops it: it aborts its sessions, saves a claimed issue
// at its last saved state with no lease, and exits 128 + the signal's number
// with nothing on stdout. --steer sends a message to a live session of the
// job running for #N, exiting 0 once pi accepted it and 1 otherwise.
// --job-id names the job as the orchestrator logged its start; without it
// the job makes its own. Each implementor commit names its session and the
// job's start (src/job/pipeline-commit.ts).
//
// No pi session gets a gh token (src/job/roles.ts); ops keep the job's env.
// The sessions given commit authority commit through pipeline_commit, which
// asks the job over its control socket to push (src/job/commit-push.ts).
// --print-boundary checks the branch and the prompt pages as a run would,
// prints the stage job's boundary as one JSON line and starts nothing.
//
// The job works in its own folder, where every pi session runs, holding its
// code checkout, cloned from a bare mirror of the repo, and its wiki checkout
// (src/job/checkout.ts). On every exit (src/job/teardown.ts) it saves what
// the checkouts left uncommitted as patches in the run folder
// (droppedPatches), records and drops it (lostChanges), the implementor's
// job pushes what the remotes lack, only the wiki once the code is merged
// (src/job/exit-push.ts), and the folder is
// removed; a run that stopped with saved patches posts a comment saying so
// (#369).

import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";
import type { Config } from "./config.ts";
import { loadConfig, paths } from "./config.ts";
import type { RunArgs, SteerArgs } from "./job/args.ts";
import { jobArgsOf } from "./job/args.ts";
import type { Brain } from "./job/brain.ts";
import { openBrain } from "./job/brain.ts";
import { branchRefusalOf } from "./job/branch.ts";
import { openJobCheckout } from "./job/checkout.ts";
import { pushServerOf } from "./job/commit-push.ts";
import type { Control } from "./job/control.ts";
import { openControl, socketPathOf } from "./job/control.ts";
import { steerJob } from "./job/control-protocol.ts";
import { exitPushOf } from "./job/exit-push.ts";
import { opsRunnerOf } from "./job/ops-request.ts";
import { runRoleStage } from "./job/role-run.ts";
import { boundaryOf, STAGE_WIKI_ACCESS } from "./job/roles.ts";
import { hooksOf } from "./job/session-hooks.ts";
import type { JobOutcome, StopSignal } from "./job/status.ts";
import { openStatus, socketOf } from "./job/status.ts";
import type { ExitingJob, RunEnd } from "./job/teardown.ts";
import { jobKeyOf, tearDown } from "./job/teardown.ts";
import { isTransientSessionError } from "./job/transient.ts";
import { roleOf } from "./roles/registry.ts";
import type { IssueState } from "./state.ts";

// A job's claimant id is "s" and its start time in base 36, as a sweep's
// was; its lease names it.
const SWEEP_ID_RADIX = 36;
// A process a signal ended exits with 128 + the signal's number.
const SIGNAL_EXIT_BASE = 128;

async function runStage(
  args: RunArgs,
  cfg: Config,
  brain: Brain,
): Promise<RunEnd> {
  const { issue, stage, branch, mergeQueue = null } = args;
  const role = roleOf(stage);
  if (role === undefined) {
    throw new Error(`no role for stage ${stage}`);
  }
  const key = jobKeyOf(stage, new Date());
  const wiki = STAGE_WIKI_ACCESS[stage];
  const dirs = openJobCheckout(cfg, issue, { stage, branch });
  const { root, repo } = dirs;
  const sweepId = `s${Date.now().toString(SWEEP_ID_RADIX)}`;
  const runDir = paths.runDir(cfg, issue);
  const id = args.jobId ?? randomUUID();
  const identity = { id, startedAt: new Date().toISOString() };
  const lane = args.lane ?? null;
  const socket = socketPathOf(runDir);
  const job = { issue, stage, lane, socket, prompts: brain.pinned };
  const status = openStatus(runDir, { ...job, ...identity });
  const control = await openControl(
    runDir,
    pushServerOf(cfg, { issue, stage, checkout: repo, branch, id }, status),
  );
  const where = { cwd: root, repo, from: process.env, job: identity };
  const hooks = hooksOf(cfg, args, { status, control }, where);
  const frame = {
    config: args.config,
    sweepId,
    lane: args.lane ?? sweepId,
    checkout: { issue, dir: repo, branch },
  };
  const runOp = opsRunnerOf(issue, frame, { hooks, status });
  let claimed: (() => IssueState) | null = null;
  const push = exitPushOf(stage, runOp, (): IssueState | null => {
    if (claimed === null) {
      return null;
    }
    return claimed();
  });
  const exiting = { issue, key, dirs, wiki, push, runOp, status };
  const ending = runRoleStage({
    role,
    cfg,
    issue,
    stage,
    mergeQueue,
    dirs,
    brain,
    identity,
    runOp,
    hooks,
    status,
    control,
    onClaimed: (last: () => IssueState): void => {
      claimed = last;
    },
  });
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

// job.json's outcome of a run that ended as `end`: a finished run's end,
// whether it deferred on a model provider's rate limit or transport error
// (for the orchestrator's backoff), and its claim's error, if any.
function outcomeOf(end: RunEnd): JobOutcome {
  if (end.kind === "stopped") {
    return { kind: "stopped", signal: end.signal };
  }
  const { summary } = end;
  const rateLimited =
    summary.end === "deferred" &&
    isTransientSessionError(summary.reason ?? null);
  if (summary.claimError === undefined) {
    return { kind: "finished", end: summary.end, rateLimited };
  }
  const { claimError } = summary;
  return { kind: "finished", end: summary.end, rateLimited, claimError };
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
    const { issue, branch, kind } = args;
    const refusal = branchRefusalOf(cfg, issue, branch, kind === "run");
    if (refusal !== null) {
      throw new Error(refusal);
    }
    const brain = openBrain(args.brainPath, args.stage);
    if (args.kind === "boundary") {
      const boundary = boundaryOf(cfg, args.issue, args.stage, process.env);
      process.stdout.write(`${JSON.stringify(boundary)}\n`);
      return;
    }
    const end = await runStage(args, cfg, brain);
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
