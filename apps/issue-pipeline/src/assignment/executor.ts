import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import type { Stage } from "../stages.ts";
import {
  acquire,
  integrationLock,
  issueLock,
  releaseLock,
} from "./exclusion.ts";
import { finishStage, prepareStage } from "./execution-state.ts";
import { fixesFor, requestHandoff, returnForFixes } from "./handoff.ts";
import type { Work } from "./plan.ts";
import { holdReason, stageFor } from "./plan.ts";
import { RetryHold } from "./retry.ts";
import type { Execution, Worker } from "./schema.ts";
import { ISSUE } from "./signal-schema.ts";
import { developmentGrant, reviewGrant } from "./signals.ts";
import type { WorkerDeps } from "./worker-state.ts";

function observe(
  cfg: Config,
  deps: WorkerDeps,
  worker: Worker,
  number: number,
): Work {
  const issue = ISSUE.parse(deps.hub.read(`issues/${number}`));
  const comments = deps.comments(number);
  const state = deps.state(number, comments);
  return {
    cfg,
    deps,
    worker,
    issue,
    state,
    inputs: deps.inputs(issue, comments),
  };
}
function assertReady(work: Work): void {
  const { cfg, deps, worker, issue, state } = work;
  if (worker.roles === "development") {
    developmentGrant(deps.hub, cfg, issue, worker);
  } else {
    if (state === null) {
      throw new OpsError("review cannot initialize issues");
    }
    reviewGrant(deps.hub, cfg, issue, { state, worker });
  }
  const hold = holdReason(work);
  if (hold !== null) {
    throw new OpsError(hold);
  }
  if (worker.roles === "review") {
    stageFor(worker, state, work.inputs);
  } else if (
    state !== null &&
    !["author", "implement", "review"].includes(state.stage) &&
    fixesFor(cfg, deps, issue, state) === null
  ) {
    throw new OpsError(
      "work belongs to review/merge; development must not fence its owner",
    );
  }
}
function integrationTurn(
  work: Work,
  stage: Stage,
  token: string,
): string | null {
  if (stage !== "merge") {
    return null;
  }
  const { cfg, deps, worker, issue } = work;
  const turn = acquire(
    deps.hub,
    cfg,
    integrationLock(cfg.baseBranch),
    `${worker.id} issue ${issue.number}`,
  );
  if (turn === null) {
    releaseLock(deps.hub, issueLock(issue.number), token);
    throw new OpsError(
      "repository integration turn held; retry on bounded sweep",
    );
  }
  return turn;
}
async function runExclusive(work: Work, token: string): Promise<boolean> {
  const { cfg, deps, worker, issue, inputs } = work;
  let { state } = work;
  assertReady(work);
  if (state !== null && worker.roles === "development") {
    state = returnForFixes(cfg, deps, issue, state);
  }
  if (
    worker.roles === "development" &&
    state?.stage === "review" &&
    state.gherkin?.inputs === inputs
  ) {
    requestHandoff(cfg, deps, issue, state);
    releaseLock(deps.hub, issueLock(issue.number), token);
    return false;
  }
  const stage = stageFor(worker, state, inputs);
  const turn = integrationTurn(work, stage, token);
  state = prepareStage({ ...work, state }, stage);
  const execution: Execution = {
    issue: issue.number,
    worker: worker.id,
    stage,
    token,
    turn,
    handoff: state?.coordination?.handoff?.id ?? null,
  };
  const result = await deps.job(
    execution,
    state?.branch ?? `agent/issue-${issue.number}`,
  );
  state = finishStage(work, result);
  if (
    worker.roles === "development" &&
    state.stage === "review" &&
    result.end === "next"
  ) {
    requestHandoff(cfg, deps, issue, state);
  }
  if (turn !== null) {
    releaseLock(deps.hub, integrationLock(cfg.baseBranch), turn);
  }
  releaseLock(deps.hub, issueLock(issue.number), token);
  if (result.end === "deferred") {
    throw new RetryHold(result.reason ?? "execution deferred", {
      until: Date.parse(
        state.coordination?.retryAt ?? deps.now().toISOString(),
      ),
    });
  }
  return true;
}
async function execute(work: Work): Promise<boolean> {
  const { cfg, deps, worker, issue } = work;
  assertReady(work);
  const token = acquire(deps.hub, cfg, issueLock(issue.number), worker.id);
  if (token === null) {
    throw new OpsError(
      "active or stale exclusive executor; inspect claim heartbeat and reconcile recovery before takeover",
    );
  }
  // Never finally-unlock: an uncertain save/write or missing local evidence
  // remains durably fenced against automatic takeover, including after restart.
  return await runExclusive(observe(cfg, deps, worker, issue.number), token);
}

export { execute, observe };
