// A stage job's invocation binding on an ops request (#167): the request's
// issue, its checkout and the binding must agree, the binding must match the
// config's repo, base and the issue's assigned branch (execution.ts's
// bindingOf), and the binding must be the issue's confirmed owner on a fresh
// read, all before the request's queued comments or its op run. The op's own
// writes then pass straight through: rereading ownership before each one and
// journaling it, as execution.ts's controlledMutation does, is #169's.

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
  const bound: Config = {
    ...withExecution(cfg, execution),
    mutation: (write: () => RunResult): RunResult => write(),
  };
  assertExecution(bound, execution.issue);
  return bound;
}

export { boundOps };
