// A registered stage's run in a stage job (src/job.ts): it claims the issue
// through the claim op, then runs the stage's role (src/roles/registry.ts)
// on the role runner from the claim's state. This module alone knows how a
// role's effects run in a job: ops and sessions as the job's launches
// (src/job/launch.ts), saves through the save-state op, the stop from the
// job's control and each step in job.json. On a signal it saves the issue at
// the stage it last saved, with no lease, as a sweep's stop does.

import type { SessionEffect } from "../roles/machine.ts";
import type { Role } from "../roles/registry.ts";
import type { State } from "../state.ts";
import { STATE } from "../state.ts";
import { parseOps } from "../workflow/launch-results.ts";
import type { OpsFrame } from "../workflow/launches.ts";
import { childSpec, opsSpec } from "../workflow/launches.ts";
import type { LaunchMeta } from "../workflow/signing.ts";
import { claimLaunch, claimStep } from "../workflow/stages/entry.ts";
import type { ChildLaunch, OpLaunch } from "../workflow/stages/types.ts";
import type { Control } from "./control.ts";
import type { LaunchHooks } from "./launch.ts";
import { runLaunch } from "./launch.ts";
import type { OpEffect, Outcome, RunEnd } from "./runner.ts";
import type { JobStatus, StopSignal } from "./status.ts";

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
  issue: number;
  stage: string;
  stackOn: number | null;
  frame: OpsFrame;
  // The job's checkout, where every session runs.
  dir: string;
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
  const { name, agent, model, schema, task, tokenBudget } = effect;
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
  };
}

// The job's launches for the role: each op and session gets the next
// sequence number in its key, and its outcome in job.json.
interface Launcher {
  op: (launch: OpLaunch) => Promise<Reply>;
  session: (effect: SessionEffect) => Promise<Outcome>;
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
    session: async (effect: SessionEffect): Promise<Outcome> => {
      seq += 1;
      const item = { n: job.issue, worktree: job.dir };
      const spec = childSpec(seq, item, childOf(effect), meta);
      const raw = await runLaunch(spec, job.hooks);
      settled(spec.key, raw.ok);
      if ("structuredOutput" in raw && raw.ok) {
        return { ok: true, name: "replied", reply: raw.structuredOutput };
      }
      return { ok: false, error: raw.error ?? "the session failed" };
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

// Runs the role from the claimed state, and on a signal saves the issue at
// the stage it last saved with no lease.
async function runClaimed(
  job: RoleJob,
  launcher: Launcher,
  claimed: State,
): Promise<RoleStageEnd> {
  const { issue, stage, control, status } = job;
  let last = claimed;
  async function save(state: State): Promise<Outcome> {
    const reply = await launcher.op(opLaunchOf(issue, "save-state", { state }));
    if (succeeded(reply)) {
      last = state;
    }
    return opOutcome(reply);
  }
  const end = await job.role.run(
    { stage, saved: claimed },
    {
      op: async (effect: OpEffect): Promise<Outcome> =>
        opOutcome(
          await launcher.op(opLaunchOf(issue, effect.op, effect.payload)),
        ),
      session: launcher.session,
      save,
      clock: (): Date => new Date(),
      stopping: control.stopping,
      step: status.step,
    },
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
  return await runClaimed(job, launcher, parsed.data);
}

export type { RoleJob, RoleLine, RoleStageEnd };
export { runRoleStage };
