import type { Config } from "../config.ts";
import { isTransientOpError } from "../job/transient.ts";
import { OpsError } from "../ops-error.ts";
import { execute, observe } from "./executor.ts";
import { pages } from "./github.ts";
import { RetryHold } from "./retry.ts";
import type { Worker } from "./schema.ts";
import type { IssueRow } from "./signal-schema.ts";
import { ISSUE, PR } from "./signal-schema.ts";
import { workerOf } from "./signals.ts";
import type { SweepResult, WorkerDeps } from "./worker-state.ts";

interface Discovery {
  cfg: Config;
  deps: WorkerDeps;
  worker: Worker;
  requests: Set<number>;
  seen: Set<number>;
}
function candidate(discovery: Discovery, issue: IssueRow): boolean {
  const { worker, deps, requests, seen } = discovery;
  if (worker.roles === "development") {
    return true;
  }
  const state = deps.state(issue.number, deps.comments(issue.number));
  if (state?.pr !== null && state?.pr !== undefined) {
    seen.add(state.pr);
    if (requests.has(state.pr) && state.coordination?.handoff === null) {
      throw new OpsError("pending PR request has no signed handoff");
    }
  }
  return (
    state?.coordination?.handoff !== null &&
    state?.coordination?.handoff !== undefined &&
    !(state.stage === "done" && issue.state === "closed")
  );
}
async function reconsider(
  work: Discovery,
  issue: IssueRow,
  result: SweepResult,
): Promise<void> {
  const { cfg, deps, worker } = work;
  try {
    if (
      candidate(work, issue) &&
      (await execute(observe(cfg, deps, worker, issue.number)))
    ) {
      result.executed += 1;
    }
  } catch (error: unknown) {
    if (error instanceof RetryHold) {
      throw error;
    }
    if (error instanceof Error && isTransientOpError(error.message)) {
      throw new RetryHold(error.message, {
        until: deps.now().getTime(),
        cause: error,
      });
    }
    result.held += 1;
    let reason = "unreadable work authority";
    if (error instanceof Error) {
      reason = error.message;
    }
    deps.notice(issue.number, reason);
  }
}
// Complete listings reconstruct the queue; local process records never
// select work. A budget exhaustion is a failed sweep, not an empty queue.
async function sweep(
  cfg: Config,
  workerId: string,
  deps: WorkerDeps,
): Promise<SweepResult> {
  if (cfg.assignment === undefined) {
    throw new OpsError("assignment operation is not enabled");
  }
  deps.scope();
  const worker = workerOf(cfg, workerId);
  let query = `issues?state=open&assignee=${encodeURIComponent(worker.login)}`;
  if (worker.roles === "review") {
    query = "issues?state=all";
  }
  const issues = pages(
    deps.hub,
    query,
    ISSUE,
    cfg.assignment.pageBudget,
  ).filter((issue) => issue.pull_request === undefined);
  const requests = new Set<number>();
  if (worker.roles === "review") {
    for (const pr of pages(
      deps.hub,
      "pulls?state=open",
      PR,
      cfg.assignment.pageBudget,
    )) {
      if (
        pr.requested_reviewers.some(
          (user) => user.login.toLowerCase() === worker.login.toLowerCase(),
        )
      ) {
        requests.add(pr.number);
      }
    }
  }
  const discovery = { cfg, deps, worker, requests, seen: new Set<number>() };
  const result = { discovered: issues.length, executed: 0, held: 0 };
  for await (const issue of issues) {
    await reconsider(discovery, issue, result);
  }
  for (const pr of requests) {
    if (!discovery.seen.has(pr)) {
      deps.notice(
        pr,
        "ignored review request: no recorded issue PR and signed handoff",
      );
    }
  }
  return result;
}

export { sweep };
