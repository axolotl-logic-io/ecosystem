// Exact Land on the task-result path (#185): when a `merge` request names a
// Land binding, Land needs passed Hardening, Integration and Security results
// for exactly that revision and target, on top of every installed check. A
// verifiedSha, a legacy state.integration or a result for any other binding
// never stands in. The Land attempt is recorded before the first PR write,
// and only a confirmed own Land of exactly R settles it; anything else stays
// uncertain and holds every writer (sync-task-gate.ts). Without a binding the
// `merge` op behaves as before #186; since then the merge stage always sends
// one.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import type { Binding, Result } from "../task-result-records.ts";
import { requestedBinding, sameBinding } from "../task-result-records.ts";
import { statusIn, taskRecords, unsettledAttempts } from "../task-results.ts";
import { isRevisionBinding } from "./task-gate.ts";
import { appendResult, startAttempt } from "./task-results.ts";

// The tasks whose current passed results Land consumes, in chain order
// (`sequential-tasks`).
const PREREQUISITES = ["Hardening", "Integration", "Security"] as const;

interface LandRequest {
  number: number;
  expectedSha: string;
  expectedBase: string;
  revision: { inputs: string; policy?: string | undefined };
}

// Why the Land binding can't authorize this Land, or undefined when it can.
function landRefusal(
  cfg: Config,
  req: LandRequest,
  requested: Binding,
): string | undefined {
  const binding = requestedBinding(cfg, req.number, requested);
  if (binding.task !== "Land" || !isRevisionBinding(binding)) {
    return "the binding is not a Land binding of a revision";
  }
  const { revision, target } = binding;
  if (
    revision.code !== req.expectedSha ||
    target.commit !== req.expectedBase ||
    revision.inputs !== req.revision.inputs ||
    revision.policy !== req.revision.policy
  ) {
    return "the Land binding is not the merge's exact revision and target";
  }
  const rows = taskRecords(cfg, req.number, listComments(cfg, req.number));
  for (const task of PREREQUISITES) {
    const status = statusIn(rows, { ...binding, task });
    if (status.status !== "passed") {
      return `${task} for this exact revision and target is ${status.status}, not passed`;
    }
  }
  const own = statusIn(rows, binding);
  if (own.status !== "missing") {
    return `Land of this binding is ${own.status}`;
  }
  return undefined;
}

// Records the Land attempt of `run` before any PR or target write.
function startLand(
  cfg: Config,
  number: number,
  binding: Binding,
  run: { id: string; previous: string | null },
): void {
  startAttempt(cfg, number, requestedBinding(cfg, number, binding), run);
}

// Settles the binding's unsettled Land attempt from a landing receipt: passed
// only for the confirmed own Land of exactly R. Anything else stays
// unsettled, so it holds until a read establishes the delivery.
function settleLand(
  cfg: Config,
  number: number,
  requested: Binding,
  receipt: {
    landed: boolean;
    byHand?: true;
    mergeCommit?: string;
    headSha?: string;
  },
): void {
  const binding = requestedBinding(cfg, number, requested);
  if (!isRevisionBinding(binding)) {
    return;
  }
  const rows = taskRecords(cfg, number, listComments(cfg, number));
  const run = unsettledAttempts(rows, "Land").find((row) =>
    sameBinding(row.binding, binding),
  );
  if (
    run === undefined ||
    !receipt.landed ||
    receipt.byHand === true ||
    receipt.headSha !== binding.revision.code ||
    receipt.mergeCommit === undefined
  ) {
    return;
  }
  const result: Omit<Result, "version" | "kind"> = {
    binding,
    run: { id: run.run.id },
    verdict: "passed",
    receipt: {
      summary: `landed ${binding.revision.code} on ${binding.target.branch} as ${receipt.mergeCommit}`,
      produced: { code: receipt.mergeCommit },
    },
  };
  appendResult(cfg, number, result);
}

// Completion on the task-result path consumes the exact Land result: a passed
// Land of this binding whose delivered commit is `sha`.
function landDeliveryRefusal(
  cfg: Config,
  number: number,
  requested: Binding,
  sha: string,
): string | undefined {
  const binding = requestedBinding(cfg, number, requested);
  if (binding.task !== "Land" || !isRevisionBinding(binding)) {
    return "the binding is not a Land binding of a revision";
  }
  const rows = taskRecords(cfg, number, listComments(cfg, number));
  const status = statusIn(rows, binding);
  if (status.status !== "passed") {
    return `Land of this binding is ${status.status}, not a confirmed delivery`;
  }
  if (status.result.receipt.produced?.code !== sha) {
    return `the Land result delivered ${String(status.result.receipt.produced?.code)}, not ${sha}`;
  }
  return undefined;
}

export { landDeliveryRefusal, landRefusal, settleLand, startLand };
