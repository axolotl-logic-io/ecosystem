// A registered stage's run in a stage job (src/job.ts): it claims the issue
// through the claim op, then runs the stage's role (src/roles/registry.ts)
// on the role runner from the claim's state. This module and its launcher
// alone know how a role's effects run in a job: ops and sessions as the job's
// launches (src/job/role-launcher.ts), saves through the save-state op, the
// stop from the job's control and each step in job.json. On a signal it saves
// the issue at the stage it last saved, with no lease, as a sweep's stop does,
// unless the run's end had saved it already.

import type { Config } from "../config.ts";
import { paths as configPaths } from "../config.ts";
import type { Role } from "../roles/registry.ts";
import type { RoleContext } from "../roles/walk.ts";
import type { State } from "../state.ts";
import { STATE } from "../state.ts";
import type { OpsFrame } from "../workflow/launches.ts";
import { claimLaunch, claimStep } from "../workflow/stages/entry.ts";
import { isSweepConfig } from "../workflow/stages/entry-replies.ts";
import { sweepSettings } from "../workflow/sweep-config.ts";
import type { ItemPaths, JobLayout } from "../workflow/types.ts";
import type { Control } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import type { Launcher } from "./role-launcher.ts";
import { launcherOf } from "./role-launcher.ts";
import { opLaunchOf, opOutcome, succeeded } from "./role-launches.ts";
import type { OpEffect, Outcome } from "./run-step.ts";
import type { RunEnd } from "./runner.ts";
import type { JobStatus, StopSignal } from "./status.ts";
import { usageAppender } from "./usage-append.ts";

// The reason of a claim that passed with a state the role can't run from.
const BAD_STATE = "the claim's state for the issue doesn't parse";

// What a role stage's job prints: the issue, the stage and how it ended. An
// unclaimed end's `reason` is why the claim failed, or null with none.
interface RoleLine {
  issue: number;
  stage: string;
  end: RunEnd | { kind: "unclaimed"; outcome: string; reason: string | null };
}

type RoleStageEnd =
  | { kind: "finished"; summary: RoleLine }
  | { kind: "stopped"; signal: StopSignal };

interface RoleJob {
  role: Role;
  cfg: Config;
  // The job's random id, which its usage records and its comments'
  // signatures carry, and its start, which its commits' trailers name.
  jobId: string;
  jobStartedAt: string;
  issue: number;
  stage: string;
  stackOn: number | null;
  // The merge order the orchestrator passed (`--merge-queue`), or null.
  mergeQueue: readonly number[] | null;
  frame: OpsFrame;
  // The job's code checkout.
  repo: string;
  // The job's folder, where every session runs, and its wiki access.
  layout: JobLayout;
  hooks: LaunchHooks;
  status: JobStatus;
  control: Control;
}

// What the role's locate reads besides the claimed state: the claim's paths,
// with the job's code checkout as the worktree and its folder, the config's
// settings and the job's merge queue. The loaded config always has the
// settings, from its defaults.
function contextOf(job: RoleJob, paths: ItemPaths): RoleContext {
  const { cfg } = job;
  if (!isSweepConfig(cfg)) {
    throw new Error("job: the config has none of the sweep's settings");
  }
  const { budgets, models } = sweepSettings(cfg);
  return {
    issue: job.issue,
    jobId: job.jobId,
    cfg,
    budgets,
    models,
    paths: { ...paths, worktree: job.repo, job: job.layout },
    now: new Date(),
    mergeQueue: job.mergeQueue,
  };
}

// Runs the role from the claimed state, and on a signal saves the issue at
// the stage it last saved with no lease, unless the role's end had saved it
// so before the signal came (#457).
async function runClaimed(
  job: RoleJob,
  launcher: Launcher,
  claimed: { state: State; paths: ItemPaths },
): Promise<RoleStageEnd> {
  const { issue, stage, control, status } = job;
  const { cfg, jobId, jobStartedAt, role } = job;
  const limits = job.hooks.contextLimits;
  const owner = { repo: cfg.repo, issue, job: jobId, jobStartedAt, limits };
  const usage = usageAppender(
    { ...owner, role: role.name },
    {
      send: async (line: string): Promise<boolean> =>
        succeeded(await launcher.op(opLaunchOf(issue, "usage", { line }))),
      runDir: configPaths.runDir(cfg, issue),
    },
  );
  let last = claimed.state;
  async function save(state: State): Promise<Outcome> {
    const reply = await launcher.op(opLaunchOf(issue, "save-state", { state }));
    if (succeeded(reply)) {
      last = state;
    }
    return opOutcome(reply);
  }
  const end = await job.role.run(
    { stage, saved: claimed.state, context: contextOf(job, claimed.paths) },
    {
      op: async (effect: OpEffect): Promise<Outcome> =>
        opOutcome(
          await launcher.op(
            opLaunchOf(issue, effect.op, effect.payload, effect.minutes),
          ),
        ),
      session: launcher.session,
      sessions: launcher.sessions,
      usage,
      save,
      clock: (): Date => new Date(),
      stopping: control.stopping,
      step: status.step,
    },
    cfg,
  );
  if (end.kind === "interrupted") {
    if (end.ended !== true) {
      const state = { ...last, lease: null };
      await launcher.op(opLaunchOf(issue, "save-state", { state }));
    }
    return { kind: "stopped", signal: end.signal };
  }
  return { kind: "finished", summary: { issue, stage, end } };
}

// Claims the issue and runs the stage's role to its end or to a signal.
async function runRoleStage(job: RoleJob): Promise<RoleStageEnd> {
  const { issue, stage } = job;
  const launcher = launcherOf(job);
  const reply = await launcher.op(claimLaunch(issue, job.stackOn));
  const signal = job.control.stopping();
  const claim = claimStep(issue, reply);
  const { state } = reply;
  const parsed = STATE.safeParse(state);
  if (claim.kind !== "claimed" || !parsed.success) {
    if (signal !== null) {
      return { kind: "stopped", signal };
    }
    let outcome = "claim-failed";
    let reason: string | null = null;
    if (claim.kind === "unclaimed") {
      ({ outcome, reason } = claim);
    } else if (claim.kind === "claimed") {
      reason = BAD_STATE;
    }
    return {
      kind: "finished",
      summary: { issue, stage, end: { kind: "unclaimed", outcome, reason } },
    };
  }
  return await runClaimed(job, launcher, {
    state: parsed.data,
    paths: claim.paths,
  });
}

export type { RoleJob, RoleLine, RoleStageEnd };
export { runRoleStage };
