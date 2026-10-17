// A registered stage's run in a stage job (src/job.ts): it claims the issue
// through the claim op, then runs the stage's role (src/roles/registry.ts)
// on the role runner from the claim's state. This module alone knows how a
// role's effects run in a job: ops and sessions as the job's launches
// (src/job/launch.ts), saves through the save-state op, the stop from the
// job's control and each step in job.json. On a signal it saves the issue at
// the stage it last saved, with no lease, as a sweep's stop does.

import type { Config } from "../config.ts";
import { paths as configPaths } from "../config.ts";
import type { SessionEffect } from "../roles/machine.ts";
import type { Role } from "../roles/registry.ts";
import type { RoleContext } from "../roles/walk.ts";
import type { State } from "../state.ts";
import { STATE } from "../state.ts";
import { parseOps } from "../workflow/launch-results.ts";
import type { OpsFrame } from "../workflow/launches.ts";
import { childSpec, opsSpec } from "../workflow/launches.ts";
import type { LaunchMeta } from "../workflow/signing.ts";
import { claimLaunch, claimStep } from "../workflow/stages/entry.ts";
import { isSweepConfig } from "../workflow/stages/entry-replies.ts";
import type { ChildLaunch, OpLaunch } from "../workflow/stages/types.ts";
import { sweepSettings } from "../workflow/sweep-config.ts";
import type { ItemPaths, JobLayout } from "../workflow/types.ts";
import type { ContextStop } from "./context-watch.ts";
import type { Control } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import { runLaunch } from "./launch.ts";
import type { OpEffect, Outcome, ReplyCheck } from "./run-step.ts";
import { sessionOutcome } from "./run-usage.ts";
import type { RunEnd } from "./runner.ts";
import type { JobStatus, StopSignal } from "./status.ts";
import { usageAppender } from "./usage-append.ts";
import type { LaunchUsage, UsageTally } from "./usage-tally.ts";
import { usageTally } from "./usage-tally.ts";

const MS_PER_SECOND = 1000;

// What a role stage's job prints: the issue, the stage and how it ended.
interface RoleLine {
  issue: number;
  stage: string;
  end: RunEnd | { kind: "unclaimed"; outcome: string };
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
  frame: OpsFrame;
  // The job's code checkout.
  repo: string;
  // The job's folder, where every session runs, and its wiki access.
  layout: JobLayout;
  hooks: LaunchHooks;
  status: JobStatus;
  control: Control;
}

type Reply = Readonly<Record<string, unknown>>;

function succeeded(reply: Reply): boolean {
  const { ok } = reply;
  return ok === true;
}

function errorOf(reply: Reply): string {
  const { error } = reply;
  if (typeof error === "string") {
    return error;
  }
  return "the op failed with no error";
}

function opOutcome(reply: Reply): Outcome {
  if (succeeded(reply)) {
    return { ok: true, name: "ok", reply };
  }
  return { ok: false, error: errorOf(reply) };
}

function childOf(effect: SessionEffect): ChildLaunch {
  const { name, agent, model, schema, task, tokenBudget, budgetRole } = effect;
  const label = `Run ${name} session`;
  return {
    kind: "child",
    name,
    label,
    agent,
    model,
    schema,
    minutes: 0,
    task,
    tokenBudget,
    budgetRole,
  };
}

// The job's launches for the role: each op and session gets the next
// sequence number in its key, and its outcome in job.json. A session's reply
// check answers on the job's control socket while the session runs.
interface Launcher {
  op: (launch: OpLaunch) => Promise<Reply>;
  session: (
    effect: SessionEffect,
    replyCheck?: ReplyCheck,
  ) => Promise<{ outcome: Outcome; launch: LaunchUsage; key: string }>;
}

// The job's hooks, which also feed every record and stop to `tally`.
function tallied(hooks: LaunchHooks, tally: UsageTally): LaunchHooks {
  return {
    ...hooks,
    record: (key: string, record: unknown): void => {
      tally.record(key, record);
      hooks.record(key, record);
    },
    contextStopped: (key: string, stop: ContextStop): void => {
      tally.contextStopped(key);
      hooks.contextStopped(key, stop);
    },
  };
}

function launcherOf(job: RoleJob): Launcher {
  let seq = 0;
  const meta: Record<string, LaunchMeta> = {};
  function settled(key: string, ok: boolean): void {
    let outcome: "ok" | "failed" = "failed";
    if (ok) {
      outcome = "ok";
    }
    job.status.settled(key, outcome);
  }
  return {
    op: async (launch: OpLaunch): Promise<Reply> => {
      seq += 1;
      const spec = opsSpec(job.frame, seq, launch, null);
      const reply = parseOps(await runLaunch(spec, job.hooks));
      settled(spec.key, succeeded(reply));
      return reply;
    },
    session: async (
      effect: SessionEffect,
      replyCheck?: ReplyCheck,
    ): Promise<{ outcome: Outcome; launch: LaunchUsage; key: string }> => {
      seq += 1;
      const item = { n: job.issue, worktree: job.repo };
      const spec = childSpec(seq, item, childOf(effect), meta);
      const tally = usageTally(job.hooks.contextLimits.soft);
      const startedAt = Date.now();
      let release: (() => void) | null = null;
      if (replyCheck !== undefined) {
        release = job.control.checkReplies(spec.key, replyCheck);
      }
      const raw = await runLaunch(spec, tallied(job.hooks, tally));
      release?.();
      settled(spec.key, raw.ok);
      const seconds = (Date.now() - startedAt) / MS_PER_SECOND;
      const launch = tally.usage(seconds);
      return { outcome: sessionOutcome(raw), launch, key: spec.key };
    },
  };
}

function opLaunchOf(issue: number, op: string, payload: Reply): OpLaunch {
  return {
    kind: "op",
    name: `i${issue}-${op}`,
    op,
    payload: { ...payload, number: issue },
  };
}

// What the role's locate reads besides the claimed state: the claim's paths,
// with the job's code checkout as the worktree and its folder, and the
// config's settings. The
// loaded config always has them, from its defaults.
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
  };
}

// Runs the role from the claimed state, and on a signal saves the issue at
// the stage it last saved with no lease.
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
          await launcher.op(opLaunchOf(issue, effect.op, effect.payload)),
        ),
      session: launcher.session,
      usage,
      save,
      clock: (): Date => new Date(),
      stopping: control.stopping,
      step: status.step,
    },
    cfg,
  );
  if (end.kind === "interrupted") {
    const state = { ...last, lease: null };
    await launcher.op(opLaunchOf(issue, "save-state", { state }));
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
    if (claim.kind === "unclaimed") {
      ({ outcome } = claim);
    }
    return {
      kind: "finished",
      summary: { issue, stage, end: { kind: "unclaimed", outcome } },
    };
  }
  return await runClaimed(job, launcher, {
    state: parsed.data,
    paths: claim.paths,
  });
}

export type { RoleJob, RoleLine, RoleStageEnd };
export { runRoleStage, tallied };
