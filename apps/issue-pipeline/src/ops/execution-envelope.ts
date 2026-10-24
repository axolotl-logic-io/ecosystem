// A stage job's invocation binding on an ops request (#167): the request's
// issue, its checkout and the binding must agree, the binding must match the
// config's repo, base and the issue's assigned branch (execution.ts's
// bindingOf), and the binding must be the issue's confirmed owner on a fresh
// read, all before the request's queued comments or its op run. Each of the
// op's credentialed writes then rereads ownership and journals its intent
// first (execution.ts's controlledMutation, #169). A request with no binding
// may read but never write: the job always sends one.

import type { Config } from "../config.ts";
import type { InvocationBinding } from "../coordination.ts";
import { assertExecution, withExecution } from "../execution.ts";
import { OpsError } from "../ops-error.ts";
import type { RunResult } from "../process.ts";

function boundOps(
  cfg: Config,
  execution: InvocationBinding,
  request: { number?: number | undefined },
): Config {
  if (
    request.number !== execution.issue ||
    cfg.checkout?.issue !== execution.issue
  ) {
    throw new OpsError("ops request differs from its execution binding");
  }
  const bound = withExecution(cfg, execution);
  assertExecution(bound, execution.issue);
  return bound;
}

// `cfg` for a request with no binding: every credentialed write refuses.
function unboundOps(cfg: Config): Config {
  return {
    ...cfg,
    mutation: (): RunResult => {
      throw new OpsError(
        "an ops request without an execution binding cannot write",
      );
    },
  };
}

export { boundOps, unboundOps };
