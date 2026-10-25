#!/usr/bin/env node
// The stage job: one job pinned to one issue that runs only one stage, or
// one task requested for it (#186).
//
//   node job.mjs --config <path> --issue N --stage <stage> --branch <name>
//     [--lane L] [--merge-queue n1,n2,…] [--job-id <uuid>]
//     [--hardening-buddy lawd|hippy]
//   node job.mjs ... --stage <saved stage> --task sync|integration
//     --binding <task binding as JSON>
//   node job.mjs ... --assignment     (started for an assignment, #119)
//   node job.mjs --config <path> --issue N --steer <launch key> --message <text>
//   node job.mjs --config <path> --issue N --stage <stage> --branch <name>
//     --print-boundary
//
// Its caller assigns it the issue and the issue's branch; it never picks
// another issue. Before it claims or clones anything it refuses a branch git
// wouldn't take literally and one the repo protects: its base or the
// remote's default (src/job/branch.ts). Its checkout, every ops request and
// every push name that branch; the claim refuses one the
// issue's saved state isn't bound to. It then pins, from the installed
// release's prompts/ folder, the behavioral prompt page of each session its
// stage runs, failing on one it can't read (src/job/prompts.ts); pi appends a
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
// the job makes its own. Neither is authority: before it opens a checkout
// the job confirms ownership for a fresh invocation UUID (job/invocation.ts).
// Each implementor commit names its session and the
// job's start (src/job/pipeline-commit.ts).
//
// No pi session gets a gh token (src/job/roles.ts); ops keep the job's env.
// The sessions given commit authority commit through pipeline_commit, which
// asks the job over its control socket to push (src/job/commit-push.ts).
// --print-boundary checks the branch and the prompt pages as a run would,
// prints the stage job's boundary as one JSON line and starts nothing.
//
// A task job (src/job/task-request.ts) runs the requested task's role
// (src/roles/registry.ts) for exactly its binding, as its task's access
// profile (src/job/roles.ts): Hippy's Sync as a writer, Lawd's read-only
// Integration as a reader. Its binding must be this issue's in this repo on
// its base, and the task must run at the given saved stage; anything else
// is refused before the job claims, clones or records anything. Its stdout
// line adds `task`: the task, binding, run and verdict, apart from `end`. A
// stage job that needs a task ends `wait` with `request`: the task and the
// binding to run it for. A task job never exit-pushes: Sync pushes through
// its own op, and Integration writes nothing.
//
// The job works in its own folder, where every pi session runs, holding its
// code checkout, cloned from a bare mirror of the repo, with the repo's docs
// in its docs/ (src/job/checkout.ts). On every exit (src/job/teardown.ts) it
// saves what the checkout left uncommitted as patches in the run folder
// (droppedPatches), records and drops it (lostChanges), the implementor's
// job pushes what the remote lacks, nothing once the code is merged
// (src/job/exit-push.ts), and the folder is
// removed; a run that stopped with saved patches posts a comment saying so
// (#369).

import { randomUUID } from "node:crypto";
import os from "node:os";
import process from "node:process";
import type { Config } from "./config.ts";
import { loadConfig, paths } from "./config.ts";
import { authorizedIssue } from "./issue-context.ts";
import type { RunArgs, SteerArgs } from "./job/args.ts";
import { jobArgsOf } from "./job/args.ts";
import { assignedRun, grantedCheck } from "./job/assignment.ts";
import { branchRefusalOf } from "./job/branch.ts";
import { openJobCheckout } from "./job/checkout.ts";
import { pushServerOf } from "./job/commit-push.ts";
import { openControl, socketPathOf } from "./job/control.ts";
import { steerJob } from "./job/control-protocol.ts";
import { exitPushOf } from "./job/exit-push.ts";
import { ownedInvocation, ownerCheckOf } from "./job/invocation.ts";
import { opsFrameOf, opsRunnerOf } from "./job/ops-request.ts";
import type { StagePrompts } from "./job/prompts.ts";
import { PROMPTS_DIR, pinPrompts } from "./job/prompts.ts";
import { checkpointLedger } from "./job/release-predicate.ts";
import { runRoleStage } from "./job/role-run.ts";
import { boundaryOf } from "./job/roles.ts";
import { hooksOf } from "./job/session-hooks.ts";
import { settle } from "./job/settle.ts";
import type { StopSignal } from "./job/status.ts";
import { openStatus, readStatus } from "./job/status.ts";
import { requestRefusalOf } from "./job/task-request.ts";
import type { RunEnd } from "./job/teardown.ts";
import { jobKeyOf } from "./job/teardown.ts";
import { roleOf } from "./roles/registry.ts";
import type { IssueState } from "./state.ts";

// A job's claimant id is "s" and its start time in base 36, as a sweep's
// was; its lease names it.
const SWEEP_ID_RADIX = 36;
// A process a signal ended exits with 128 + the signal's number.
const SIGNAL_EXIT_BASE = 128;

async function runStage(
  args: RunArgs,
  given: Config,
  prompts: StagePrompts,
): Promise<RunEnd> {
  const { issue, stage, branch, mergeQueue = null } = args;
  const task = args.task?.name ?? null;
  const assigned = assignedRun(given, args);
  if ("end" in assigned) {
    return assigned.end;
  }
  const { cfg, assignment } = assigned;
  const role = roleOf(stage, task);
  if (role === undefined) {
    throw new Error(`no role for stage ${stage}`);
  }
  // A task job's checkout and keys are its task's, so it never meets a
  // retained checkout of the stage job.
  const work = task ?? stage;
  const key = jobKeyOf(work, new Date());
  const sweepId = `s${Date.now().toString(SWEEP_ID_RADIX)}`;
  const claimant = { sweepId, lane: args.lane ?? sweepId };
  const invocation = ownedInvocation(cfg, args, { ...claimant, work });
  if ("end" in invocation) {
    return invocation.end;
  }
  const dirs = openJobCheckout(cfg, issue, { stage: work, branch });
  const { root, repo } = dirs;
  const runDir = paths.runDir(cfg, issue);
  const id = args.jobId ?? randomUUID();
  const identity = { id, startedAt: new Date().toISOString() };
  const lane = args.lane ?? null;
  const socket = socketPathOf(runDir);
  const { binding: execution } = invocation;
  const owner = ownerCheckOf(invocation);
  const writer = grantedCheck(owner, assignment);
  const job = {
    issue,
    stage,
    lane,
    socket,
    prompts: prompts.pinned,
    execution,
  };
  const info = { ...job, ...identity };
  if (args.task !== null) {
    const { task: name, binding } = args.task;
    Object.assign(info, { task: { task: name, binding } });
  }
  const status = openStatus(runDir, info, cfg.policyBinding);
  const control = await openControl(
    runDir,
    pushServerOf(
      cfg,
      { issue, stage, checkout: repo, branch, id, owner: writer },
      status,
    ),
    execution,
  );
  const from = process.env;
  const where = { cwd: root, repo, from, job: identity, execution };
  const sessions = { ...where, owner: writer };
  const hooks = hooksOf(cfg, args, { status, control }, sessions);
  const frame = opsFrameOf(
    cfg,
    args.config,
    { ...claimant, execution: invocation.binding },
    { issue, dir: repo, branch },
  );
  const ledger = checkpointLedger(opsRunnerOf(issue, frame, { hooks, status }));
  const { runOp } = ledger;
  let claimed: (() => IssueState) | null = null;
  const push = exitPushOf({ stage, task }, runOp, (): IssueState | null => {
    if (claimed === null) {
      return null;
    }
    return claimed();
  });
  const exiting = { issue, stage, key, dirs, push, runOp, status, owner };
  const ending = runRoleStage({
    role,
    cfg,
    issue,
    stage,
    mergeQueue,
    hardening: args.hardeningBuddy ?? "lawd",
    task: args.task,
    dirs,
    prompts,
    identity,
    runOp,
    hooks,
    status,
    control,
    paused: assignment?.paused ?? null,
    onClaimed: (last: () => IssueState): void => {
      claimed = last;
    },
  });
  const settling = { ...exiting, invocation, ledger, control };
  return await settle(cfg, ending, settling, (line: string): void => {
    process.stderr.write(line);
  });
}

async function steer(args: SteerArgs, cfg: Config): Promise<void> {
  const running = readStatus(paths.runDir(cfg, args.issue));
  if (running?.execution === undefined) {
    throw new Error(`no running job for #${args.issue}`);
  }
  const { socket, execution } = running;
  const steering = { key: args.steer, message: args.message };
  const error = await steerJob(socket, execution, steering);
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
    const refusal =
      branchRefusalOf(cfg, issue, branch, kind === "run") ??
      (args.task && requestRefusalOf(cfg, issue, args.task));
    if (refusal !== null) {
      throw new Error(refusal);
    }
    const task = args.task?.name ?? null;
    const prompts = pinPrompts(
      PROMPTS_DIR,
      args.stage,
      args.hardeningBuddy ?? "lawd",
      task,
    );
    if (args.kind === "boundary") {
      const job = { stage: args.stage, task };
      const boundary = boundaryOf(cfg, args.issue, job, process.env);
      process.stdout.write(`${JSON.stringify(boundary)}\n`);
      return;
    }
    authorizedIssue(cfg, args.issue);
    const end = await runStage(args, cfg, prompts);
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
