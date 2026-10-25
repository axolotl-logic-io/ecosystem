// Authenticated history is not current ownership. Import this seam directly;
// execution.ts must not re-export it and create a transport/history cycle.
import type { Config } from "./config.ts";
import { assertReconciled } from "./coordination-journal.ts";
import { own, sameBinding } from "./coordination-records.ts";
import { issueExecution } from "./execution.ts";
import type { ExecutionReceipt } from "./execution-receipt.ts";
import { EXECUTION_RECEIPT } from "./execution-receipt.ts";
import { OpsError } from "./ops-error.ts";

function currentExecutionReceipt(cfg: Config, issue: number): ExecutionReceipt {
  assertReconciled(cfg, issue);
  const history = issueExecution(cfg, issue).read();
  const identity = cfg.execution;
  if (identity === undefined) {
    throw new OpsError("explicit execution binding required");
  }
  const owner = own(history, identity);
  return { protocol: 1, request: owner.id, instance: identity.instance };
}

function assertExecutionHistory(
  cfg: Config,
  issue: number,
  receipt: ExecutionReceipt | undefined,
  current = false,
): void {
  assertReconciled(cfg, issue);
  // The factory strictly validates UUID and full configured binding even when
  // inspecting history, rather than quietly accepting an unbound caller.
  const history = issueExecution(cfg, issue).read();
  const identity = cfg.execution;
  const parsed = EXECUTION_RECEIPT.safeParse(receipt);
  if (identity === undefined || !parsed.success) {
    throw new OpsError(
      "saved execution receipt missing or invalid; reconciliation required",
    );
  }
  const saved = parsed.data;
  const request = history.records.find(
    (row) => row.kind === "request" && row.id === saved.request,
  );
  if (
    request?.kind !== "request" ||
    request.binding.instance !== saved.instance ||
    request.binding.repo !== identity.repo ||
    request.binding.base !== identity.base ||
    request.binding.issue !== issue ||
    request.binding.branch !== identity.branch ||
    !history.records.some(
      (row) =>
        row.kind === "confirm" &&
        row.request === request.id &&
        row.instance === saved.instance,
    )
  ) {
    throw new OpsError(
      "saved execution history missing or incompatible; reconciliation required",
    );
  }
  if (current || saved.instance === identity.instance) {
    if (!sameBinding(request.binding, identity)) {
      throw new OpsError(
        "saved execution full binding changed; reconciliation required",
      );
    }
    if (current && own(history, identity).id !== saved.request) {
      throw new OpsError(
        "saved execution is not the current owner; reconciliation required",
      );
    }
  } else if (
    !history.records.some(
      (row) => row.kind === "release" && row.request === request.id,
    )
  ) {
    throw new OpsError(
      "previous execution is unreleased; reconciliation required",
    );
  }
}

export { assertExecutionHistory, currentExecutionReceipt };
