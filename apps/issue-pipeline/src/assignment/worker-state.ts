import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { trustedInputsHash } from "../issue-context.ts";
import { OpsError } from "../ops-error.ts";
import type { IssueState } from "../state.ts";
import type { Hub } from "./github.ts";
import type { Coordination, Execution } from "./schema.ts";
import type { IssueRow } from "./signal-schema.ts";

interface JobResult {
  end: "next" | "wait" | "ask" | "stop" | "deferred" | "done" | "unclaimed";
  reason: string | null;
  localRecovery: boolean;
}
interface WorkerDeps {
  scope: () => void;
  hub: Hub;
  now: () => Date;
  comments: (issue: number) => IssueComment[];
  state: (
    issue: number,
    comments?: readonly IssueComment[],
  ) => IssueState | null;
  save: (issue: number, state: IssueState) => void;
  inputs: (issue: IssueRow, comments: readonly IssueComment[]) => string;
  notice: (issue: number, reason: string) => void;
  job: (execution: Execution, branch: string) => Promise<JobResult>;
}
interface SweepResult {
  discovered: number;
  executed: number;
  held: number;
}

function productionInputs(
  cfg: Config,
  issue: IssueRow,
  comments: readonly IssueComment[],
): string {
  return trustedInputsHash(cfg, issue, comments);
}
function requiredState(deps: WorkerDeps, number: number): IssueState {
  const state = deps.state(number);
  if (state === null) {
    throw new OpsError("missing signed state after stage execution");
  }
  return state;
}
function saveCoordination(
  deps: WorkerDeps,
  state: IssueState,
  coordination: Coordination,
): IssueState {
  const saved = { ...state, coordination };
  deps.save(state.number, saved);
  const confirmed = requiredState(deps, state.number);
  if (JSON.stringify(confirmed.coordination) !== JSON.stringify(coordination)) {
    throw new OpsError("coordination save unconfirmed");
  }
  return confirmed;
}

export type { JobResult, SweepResult, WorkerDeps };
export { productionInputs, requiredState, saveCoordination };
