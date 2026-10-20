import type { Config } from "../config.ts";
import { LABELS } from "../labels.ts";
import { OpsError } from "../ops-error.ts";
import { afterMarkOf } from "../orchestrator/inputs.ts";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import type { Worker } from "./schema.ts";
import type { IssueRow } from "./signal-schema.ts";
import { ISSUE } from "./signal-schema.ts";

import type { WorkerDeps } from "./worker-state.ts";

interface Work {
  cfg: Config;
  deps: WorkerDeps;
  worker: Worker;
  issue: IssueRow;
  state: IssueState | null;
  inputs: string;
}
function coordinationHold(work: Work): string | null {
  const { state, inputs, deps } = work;

  if (
    state?.coordination?.pending !== undefined &&
    state.coordination.pending !== null
  ) {
    return `uncertain ${state.coordination.pending.kind}: explicit reconciliation required`;
  }
  if (state?.coordination?.localRecovery === true) {
    return "local-only recovery evidence required; do not reset or reimplement";
  }
  const retry = state?.coordination?.retryAt;
  if (
    retry !== undefined &&
    retry !== null &&
    Date.parse(retry) > deps.now().getTime()
  ) {
    return `retry hold until ${retry}`;
  }
  if (state?.asked?.inputs === inputs) {
    return "questions unanswered on unchanged trusted inputs";
  }
  if (state !== null && state.coordination === null) {
    return "existing state needs an operator-coordinated assignment cutover";
  }
  return null;
}
function holdReason(work: Work): string | null {
  const { cfg, deps, issue, state } = work;
  const labels = issue.labels.map((label) => label.name);
  if (state?.stage === "stopped" || labels.some(isStopLabel)) {
    return "unresolved stop: reconcile its control before resuming";
  }
  if (labels.includes(LABELS.split.name)) {
    return "split parent is not a stage job";
  }
  const coordination = coordinationHold(work);
  if (coordination !== null) {
    return coordination;
  }
  for (const number of afterMarkOf(issue.body)) {
    const dependency = ISSUE.parse(deps.hub.read(`issues/${number}`));
    if (dependency.state !== "closed") {
      return `prerequisite #${number} is unsatisfied`;
    }
  }
  const { skipLabels, takeNewWork } = cfg;
  if (
    Array.isArray(skipLabels) &&
    skipLabels.some(
      (label: unknown) => typeof label === "string" && labels.includes(label),
    )
  ) {
    return "issue excluded by repository scope";
  }
  if (state === null && takeNewWork === false) {
    return "new work disabled";
  }
  return null;
}

function stageFor(
  worker: Worker,
  state: IssueState | null,
  inputs: string,
): Stage {
  if (worker.roles === "development") {
    if (
      state === null ||
      state.stage === "author" ||
      (state.gherkin?.inputs !== inputs && state.codeMerged === null)
    ) {
      return "author";
    }
    if (state.stage === "implement") {
      return "implement";
    }
    throw new OpsError("next action belongs to review, not development");
  }
  if (state === null) {
    throw new OpsError("review cannot initialize new issues");
  }
  if (state.gherkin?.inputs !== inputs && state.codeMerged === null) {
    throw new OpsError(
      "trusted inputs changed: development must reauthor before review",
    );
  }
  if (state.stage === "review") {
    return "review";
  }
  if (
    state.stage === "merge" ||
    (state.stage === "done" && state.merged !== null)
  ) {
    return "merge";
  }
  throw new OpsError("next action belongs to development, not review");
}

export type { Work };
export { holdReason, stageFor };
