// How a role stage's job ends (src/job/role-run.ts): the role's end applied
// through the job's own ops, the end of a role that threw, the stop for a
// branch that moved outside the pipeline, and the job's stdout line. Every
// write of an end's state is the state the end names, so no stale state
// overwrites it (#457).

import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { stopRecovery } from "../stop-recovery.ts";
import type { AgentName, RoleEnd, RoleInputs } from "./role-context.ts";
import { OpsFailure } from "./role-context.ts";
import type { OpsJob } from "./role-ops.ts";
import type { RunUsage } from "./run-usage.ts";
import type { JobEnd, JobStatus, StopSignal } from "./status.ts";
import type { TaskReport, TaskRequest } from "./task-request.ts";
import { isTransientOpError } from "./transient.ts";

const BRANCH_MOVED = "the PR branch changed outside the pipeline";
const CHECKPOINT_MISSING = "the saved checkpoint is missing from GitHub";
// Who asks an ask's questions: the author, as its installed agent.
const ASKER: { role: "author"; agent: AgentName } = {
  role: "author",
  agent: "issue-pipeline-author",
};

// What a stage job prints as its one stdout line: the issue, the stage it
// started at, how the stage ended, why (a stop's, wait's or deferral's
// reason, or why the claim didn't pass), and a failed claim's error. A
// waiting stage that needs a task names it as `request`; a task job reports
// its run as `task` (task-request.ts), apart from `end`.
interface JobLine {
  issue: number;
  stage: Stage;
  end: JobEnd;
  reason?: string;
  claimError?: string;
  request?: TaskRequest;
  task?: TaskReport;
}

type RoleStageEnd =
  | { kind: "finished"; summary: JobLine }
  | { kind: "stopped"; signal: StopSignal };

// The job an end is applied for.
interface EndingJob extends OpsJob {
  stage: Stage;
  status: Pick<JobStatus, "moved">;
}

// A claimed run: its job, the last state it saved and its usage
// bookkeeping.
interface Claimed {
  job: EndingJob;
  last: IssueState;
  usage: RunUsage;
}

function finished(
  job: EndingJob,
  line: Omit<JobLine, "issue" | "stage">,
): RoleStageEnd {
  return {
    kind: "finished",
    summary: { issue: job.issue, stage: job.stage, ...line },
  };
}

// What finishes `job` with the line it's given, and the task's report when
// the role gave one.
function withTask(
  job: EndingJob,
  task: TaskReport | undefined,
): (line: Omit<JobLine, "issue" | "stage">) => RoleStageEnd {
  return (line: Omit<JobLine, "issue" | "stage">): RoleStageEnd => {
    if (task === undefined) {
      return finished(job, line);
    }
    return finished(job, { ...line, task });
  };
}

// Runs `op` through the job's runner, throwing OpsFailure when it fails.
async function jobOp(
  job: EndingJob,
  op: string,
  payload: object,
): Promise<void> {
  const reply = await job.runOp(op, payload);
  if (!reply.ok) {
    throw new Error(`the ${op} op failed: ${reply.error}`);
  }
}

// Releases `state` for the next job; a finished issue keeps no lease.
async function release(claimed: Claimed, state: IssueState): Promise<void> {
  let released = state;
  if (state.stage === "done") {
    released = { ...state, lease: null };
  }
  await jobOp(claimed.job, "release", { state: released });
  claimed.last = released;
}

// Applies `end` through the job's ops and returns the job's line. An ask
// records the inputs revision its questions were asked at in the state it
// asks and releases, so no later write loses it (#457): that state is the
// run's last saved one from before the ask op runs, so a stop during the ask
// saves it too.
async function applyEnd(
  claimed: Claimed,
  end: RoleEnd,
  inputs: RoleInputs,
): Promise<RoleStageEnd> {
  const { job } = claimed;
  const reported = withTask(job, end.task);
  switch (end.kind) {
    case "next":
      await release(claimed, end.state);
      job.status.moved(end.state.stage);
      claimed.usage.moved(end.state.stage);
      return reported({ end: "next" });
    case "wait": {
      await release(claimed, end.state);
      const line: Omit<JobLine, "issue" | "stage"> = {
        end: "wait",
        reason: end.reason,
      };
      if (end.request !== undefined) {
        line.request = end.request;
      }
      return reported(line);
    }
    case "ask": {
      const state: IssueState = {
        ...end.state,
        asked: { inputs: inputs.revision },
      };
      claimed.last = state;
      await jobOp(job, "ask", { questions: end.questions, by: ASKER, state });
      await release(claimed, state);
      return reported({ end: "ask" });
    }
    case "stop": {
      const recovery = stopRecovery(job.cfg, { number: job.issue, ...end });
      try {
        await jobOp(job, "stop", {
          code: end.code,
          reason: end.reason,
          state: end.state,
          recoveryId: recovery.id,
        });
      } catch (error: unknown) {
        let failure = String(error);
        if (error instanceof Error) {
          failure = error.message;
        }
        throw new Error(recovery.fail(failure), { cause: error });
      }
      claimed.last = end.state;
      return reported({ end: "stop", reason: end.reason });
    }
    case "deferred":
      await release(claimed, claimed.last);
      return reported({ end: "deferred", reason: end.error });
    default:
      return unreachable(end);
  }
}

// The end of a role that threw: a failed op deferred when its own reply
// error is transient, or stopped as an error; anything else fails the job.
function thrownEnd(error: unknown, state: IssueState): RoleEnd {
  if (!(error instanceof OpsFailure)) {
    throw error;
  }
  const reason = `the ${error.op} op failed: ${error.message}`;
  if (isTransientOpError(error.opError)) {
    return { kind: "deferred", error: reason };
  }
  return { kind: "stop", code: "error", reason, state };
}

// The stop for a PR branch whose head the pipeline didn't push, read after
// the claim adopted the pipeline's own pushes. After an attempted Land,
// only read-only reconciliation can establish the retained PR head/result;
// today's mutable branch tip must not prevent that recovery. A saved
// checkpoint missing from the remote stops too (#173): the run rebuilds only
// from the exact checkpoint GitHub holds, never from the base, so it never
// restarts or reimplements the work silently.
function branchMoved(
  state: IssueState,
  remoteHead: string | null,
): RoleEnd | null {
  const { headSha, codeMerged } = state;
  if (state.mergeAttempt !== null || codeMerged !== null || headSha === null) {
    return null;
  }
  if (remoteHead === headSha) {
    return null;
  }
  if (remoteHead === null) {
    const reason = `${CHECKPOINT_MISSING}: the branch no longer holds ${headSha}; restore it for explicit recovery`;
    return { kind: "stop", code: "branch-changed", reason, state };
  }
  const reason = `${BRANCH_MOVED}: expected ${headSha}, found ${remoteHead}`;
  return { kind: "stop", code: "branch-changed", reason, state };
}

function unreachable(value: never): never {
  throw new Error(`role run: unexpected ${JSON.stringify(value)}`);
}

export type { Claimed, EndingJob, JobLine, RoleStageEnd };
export { applyEnd, branchMoved, finished, release, thrownEnd };
