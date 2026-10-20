import { OpsError } from "../ops-error.ts";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import type { Work } from "./plan.ts";
import type { Coordination } from "./schema.ts";
import { emptyCoordination } from "./schema.ts";
import type { JobResult } from "./worker-state.ts";
import { requiredState, saveCoordination } from "./worker-state.ts";

const MS_PER_SECOND = 1000;
const DEFAULT_BACKOFF_SECONDS = 3600;
function prepareStage(work: Work, stage: Stage): IssueState | null {
  const { deps, worker, state } = work;
  if (state === null) {
    return null;
  }
  const initial = state.coordination ?? emptyCoordination();
  let next = { ...state, coordination: initial };
  if (stage === "author" && state.stage !== "author") {
    next = {
      ...state,
      stage: "author",
      resumeStage: "implement",
      hardened: null,
      integration: null,
      security: null,
      coordination: {
        ...initial,
        handoff: null,
      },
    };
  }
  const coord = next.coordination;
  let { handoff } = coord;
  if (worker.roles === "review" && handoff !== null) {
    handoff = { ...handoff, phase: "accepted" };
  }
  return saveCoordination(deps, next, {
    ...coord,
    worker: worker.id,
    status: "active",
    reason: null,
    heartbeat: deps.now().toISOString(),
    handoff,
  });
}
function checkpointStatus(
  state: IssueState,
  result: JobResult,
): Coordination["status"] {
  if (state.stage === "done") {
    return "completed";
  }
  if (["wait", "ask", "stop"].includes(result.end)) {
    return "blocked";
  }
  return "queued";
}
function finishStage(work: Work, result: JobResult): IssueState {
  const { cfg, deps, worker, issue } = work;
  const state = requiredState(deps, issue.number);
  const coord = state.coordination ?? emptyCoordination();
  if (
    result.localRecovery ||
    coord.localRecovery ||
    coord.pending !== null ||
    result.end === "unclaimed"
  ) {
    saveCoordination(deps, state, {
      ...coord,
      worker: worker.id,
      status: "stalled",
      localRecovery: result.localRecovery || coord.localRecovery,
      reason:
        result.reason ?? "uncertain stage outcome; reconcile before resuming",
    });
    throw new OpsError(
      "local recovery or uncertain outcome: exclusive execution retained",
    );
  }
  let retryAt: string | null = null;
  if (result.end === "deferred" || result.end === "wait") {
    retryAt = new Date(
      deps.now().getTime() +
        (cfg.assignment?.maxBackoffSeconds ?? DEFAULT_BACKOFF_SECONDS) *
          MS_PER_SECOND,
    ).toISOString();
  }
  return saveCoordination(
    deps,
    { ...state, lease: null },
    {
      ...coord,
      worker: worker.id,
      status: checkpointStatus(state, result),
      reason: result.reason,
      retryAt,
      heartbeat: deps.now().toISOString(),
    },
  );
}

export { finishStage, prepareStage };
