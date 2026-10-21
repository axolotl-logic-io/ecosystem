// A stage's run in a stage job (src/job.ts): it claims the issue through the
// claim op, reads the issue's trusted inputs from the claim's snapshot, runs
// the stage's role (src/roles/registry.ts) with a RoleContext
// (src/job/role-context.ts), and applies the role's end through the job's
// own ops: release for next and wait, ask then release, stop, and release
// of the last saved state for a deferral. This module alone knows how a
// role's effects become the job's launches and how an end is applied. On a
// signal it saves the last saved state with no lease and applies no end. A
// signal while an end is applied does the same, except that an interrupted
// stop retains its reconciliation evidence without overwriting signed state.
// An issue at another stage is released untouched, but a merge job runs its
// role on a done issue with its merge recorded, to finish its completion.

import { z } from "zod";
import { paths } from "../config.ts";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { ISSUE_STATE } from "../state.ts";
import type { JobDirs } from "./checkout.ts";
import type { Control } from "./control.ts";
import { recoveryLines } from "./dropped-patch.ts";
import type { LaunchHooks } from "./launch.ts";
import type { StagePrompts } from "./prompts.ts";
import type {
  Role,
  RoleContext,
  RoleInputs,
  SessionResult,
  SessionSpec,
} from "./role-context.ts";
import type { Claimed, EndingJob, RoleStageEnd } from "./role-end.ts";
import {
  applyEnd,
  branchMoved,
  finished,
  release,
  thrownEnd,
} from "./role-end.ts";
import { inputsOf } from "./role-inputs.ts";
import { opRunnerOf, postOf } from "./role-ops.ts";
import { sessionRunnerOf } from "./role-session.ts";
import { STAGE_AGENTS, STAGE_ROLES } from "./roles.ts";
import { runUsage } from "./run-usage.ts";
import type { JobStatus, StopSignal } from "./status.ts";
import { usageAppender } from "./usage-append.ts";
import type { UsageRole } from "./usage-log.ts";

const BAD_STATE = "the claim's reply doesn't parse";
const WAITING = "the issue waits for an answer to its questions";
// The claim op's replies (shared-ops-contract.md): the claim won, with the
// issue's state after adopting the pipeline's own pushes and reconciling a
// merge, the PR branch's head and the issue file it wrote; lost to a live
// holder; or held while the issue waits for an answer.
const CLAIM_WON = z.looseObject({
  state: ISSUE_STATE,
  remoteHead: z.string().min(1).nullable(),
  issueFile: z.string().min(1),
});
const CLAIM_LOST = z.looseObject({
  lost: z.literal(true),
  holder: z.string().nullish(),
});
const CLAIM_WAITING = z.looseObject({ waiting: z.literal("answer") });

interface RoleJob extends EndingJob {
  role: Role;
  mergeQueue: readonly number[] | null;
  dirs: JobDirs;
  // The behavioral prompts the job pinned for its stage's sessions.
  prompts: StagePrompts;
  // The job's random id and start, which its usage records and commits'
  // trailers name.
  identity: { id: string; startedAt: string };
  hooks: LaunchHooks;
  status: JobStatus;
  control: Pick<Control, "stopping">;
  // Called once the claim won, with what reads the run's last saved state,
  // for the exit push (src/job/exit-push.ts).
  onClaimed: (last: () => IssueState) => void;
}

// Whether a `stage` job runs its role on an issue saved at another stage:
// only a merge job, on a done issue whose merge it recorded (`merged`), to
// reconcile the completion its finish didn't finish (the merge role's
// finish-only path).
function reconcilesCompletion(stage: Stage, state: IssueState): boolean {
  return stage === "merge" && state.stage === "done" && state.merged !== null;
}

// The role a stage's usage records name: its agent's model role, or the
// merger for a merge job, whose integration sessions' records name the
// reviewer as the session's `name`.
function usageRoleOf(stage: Stage): UsageRole {
  if (STAGE_ROLES[stage] === "merger") {
    return "merger";
  }
  return STAGE_AGENTS[stage].role;
}

// What one claimed run holds while it runs (Claimed in role-end.ts) and
// its usage effect.
interface Running extends Claimed {
  job: RoleJob;
  append: ReturnType<typeof usageAppender>;
}

function contextOf(
  claimed: Running,
  inputs: RoleInputs,
  issueFile: string,
): RoleContext {
  const { job } = claimed;
  const op = opRunnerOf(job);
  const session = sessionRunnerOf({
    stage: job.stage,
    prompts: job.prompts,
    hooks: job.hooks,
    status: job.status,
    stopping: job.control.stopping,
    usage: claimed.usage,
    append: claimed.append,
  });
  return {
    cfg: job.cfg,
    issue: job.issue,
    stage: job.stage,
    state: claimed.last,
    dirs: { job: job.dirs.root, repo: job.dirs.repo, docs: job.dirs.docs },
    issueFile,
    inputs,
    mergeQueue: job.mergeQueue,
    op,
    session: async (spec: SessionSpec): Promise<SessionResult> => {
      if (spec.phase !== "hardening" || !spec.commits) {
        return await session(spec);
      }
      const recovery = recoveryLines(job.cfg, job.issue, job.dirs.branch);
      return await session({
        ...spec,
        task: [spec.task, ...recovery].join("\n"),
      });
    },
    post: postOf(job, () => claimed.last).post,
    save: async (state: IssueState): Promise<void> => {
      await op("save-state", { state });
      claimed.last = state;
    },
  };
}

// The end of a run a signal stopped: its last saved state, saved with no
// lease.
async function stoppedAt(
  claimed: Running,
  signal: StopSignal,
): Promise<RoleStageEnd> {
  const saved = { ...claimed.last, lease: null };
  const reply = await claimed.job.runOp("save-state", { state: saved });
  if (!reply.ok) {
    throw new Error(`the save-state op failed: ${reply.error}`);
  }
  return { kind: "stopped", signal };
}

// Runs the role from the claimed state to its applied end, or to a signal.
async function runClaimed(
  claimed: Running,
  claim: z.infer<typeof CLAIM_WON>,
): Promise<RoleStageEnd> {
  const { job } = claimed;
  const inputs = inputsOf(job.cfg, job.issue, claim);
  const ctx = contextOf(claimed, inputs, claim.issueFile);
  let end = branchMoved(claimed.last, claim.remoteHead);
  if (end === null) {
    try {
      end = await job.role(ctx);
    } catch (error: unknown) {
      end = thrownEnd(error, claimed.last);
    }
  }
  const signal = job.control.stopping();
  if (signal !== null) {
    return await stoppedAt(claimed, signal);
  }
  try {
    return await applyEnd(claimed, end, inputs);
  } catch (error: unknown) {
    const late = job.control.stopping();
    if (late === null) {
      throw error;
    }
    if (end.kind === "stop") {
      // Stop may already have saved signed state before its child was killed.
      // Its write-ahead evidence tracks that uncertainty; the old working
      // checkpoint must not erase the stop code, resume stage or cleared lease.
      return { kind: "stopped", signal: late };
    }
    return await stoppedAt(claimed, late);
  }
}

// Claims the issue and runs the stage's role to its end or to a signal.
// An issue saved at another stage is released untouched, except a done one
// a merge job reconciles (reconcilesCompletion).
async function runRoleStage(job: RoleJob): Promise<RoleStageEnd> {
  const reply = await job.runOp("claim", {});
  const signal = job.control.stopping();
  if (signal !== null) {
    return { kind: "stopped", signal };
  }
  if (!reply.ok) {
    return finished(job, {
      end: "unclaimed",
      reason: reply.error,
      claimError: reply.error,
    });
  }
  const lost = CLAIM_LOST.safeParse(reply.reply);
  if (lost.success) {
    const holder = lost.data.holder ?? "another claimant";
    return finished(job, { end: "unclaimed", reason: `claimed by ${holder}` });
  }
  if (CLAIM_WAITING.safeParse(reply.reply).success) {
    return finished(job, { end: "unclaimed", reason: WAITING });
  }
  const won = CLAIM_WON.safeParse(reply.reply);
  if (!won.success) {
    const claimError = `${BAD_STATE}: ${z.prettifyError(won.error)}`;
    return finished(job, { end: "unclaimed", reason: claimError, claimError });
  }
  const { state } = won.data;
  const startedAt = new Date(job.identity.startedAt);
  const claimed: Running = {
    job,
    last: state,
    usage: runUsage(job.stage, startedAt),
    append: usageAppender(
      {
        repo: job.cfg.repo,
        issue: job.issue,
        job: job.identity.id,
        jobStartedAt: job.identity.startedAt,
        role: usageRoleOf(job.stage),
      },
      {
        send: async (line: string): Promise<boolean> =>
          (await job.runOp("usage", { line })).ok,
        runDir: paths.runDir(job.cfg, job.issue),
      },
    ),
  };
  job.onClaimed((): IssueState => claimed.last);
  if (state.stage !== job.stage && !reconcilesCompletion(job.stage, state)) {
    await release(claimed, state);
    const reason = `the issue is at ${state.stage}, not ${job.stage}`;
    return finished(job, { end: "unclaimed", reason });
  }
  const end = await runClaimed(claimed, won.data);
  let outcome: string = end.kind;
  if (end.kind === "finished") {
    outcome = end.summary.end;
  }
  await claimed.append(claimed.usage.job(outcome, new Date()));
  return end;
}

export type { RoleJob };
export { runRoleStage };
