import type { IssueComment } from "../comments.ts";
import { commentByKey, keyMark, listComments, signed } from "../comments.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { readClaimState, writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { hubOf } from "./github.ts";
import type { Execution } from "./schema.ts";
import { repositoryScope } from "./scope.ts";
import type { IssueRow } from "./signal-schema.ts";
import { workerOf } from "./signals.ts";
import { runJob } from "./worker-process.ts";
import type { JobResult, WorkerDeps } from "./worker-state.ts";
import { productionInputs } from "./worker-state.ts";

const NOTICE_LENGTH = 3000;

interface RuntimeRepository {
  manifest: string;
  config: string;
  brainPath: string;
  cfg: Config;
}

function notice(
  cfg: Config,
  worker: string,
  issue: number,
  reason: string,
): void {
  const key = `assignment-${worker}`;
  const body = `Assignment worker \`${worker}\`: ${reason.slice(0, NOTICE_LENGTH)}\n\nInspect signed state, claims and execution refs before recovery. This observation grants no work.`;
  const expected = `${signed({ role: "assignment-observer" }, body)}\n${keyMark(issue, key)}`;
  if (
    listComments(cfg, issue).some(
      (comment) =>
        comment.user?.login.toLowerCase() === cfg.mergeAccount.toLowerCase() &&
        comment.body === expected,
    )
  ) {
    return;
  }
  commentByKey(cfg, issue, { role: "assignment-observer" }, { body, key });
}

// The worker owns a stage child only while awaiting it. SIGTERM and failed
// grant/heartbeat checks terminate it and await bounded process cleanup;
// an uncertain exit deliberately retains durable execution authority.
function runtimeDeps(
  repository: RuntimeRepository,
  worker: string,
  signal: AbortSignal,
): WorkerDeps {
  const { cfg } = repository;
  return {
    scope: (): void => {
      const fresh = repositoryScope(cfg, repository);
      if (fresh.assignment === undefined) {
        throw new OpsError("assignment worker scope withdrawn");
      }
      workerOf(fresh, worker);
    },
    hub: hubOf(cfg),
    now: (): Date => new Date(),
    comments: (issue: number) => listComments(cfg, issue),
    state: (issue: number, comments: readonly IssueComment[] | undefined) =>
      readClaimState(cfg, issue, comments ?? listComments(cfg, issue)),
    save: (issue: number, state: IssueState): void =>
      writeState(cfg, issue, state),
    inputs: (issue: IssueRow, comments: readonly IssueComment[]): string =>
      productionInputs(cfg, issue, comments),
    notice: (issue: number, reason: string): void =>
      notice(cfg, worker, issue, reason),
    job: (execution: Execution, branch: string): Promise<JobResult> =>
      runJob(repository, execution, branch, signal),
  };
}

export type { RuntimeRepository };
export { notice, runtimeDeps };
