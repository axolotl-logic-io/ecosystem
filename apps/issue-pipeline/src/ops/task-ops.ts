// The canonical task ops a buddy action's ops child serves, and the
// authority each composes before it runs and again at each controlled
// mutation (task-guard.ts). Every one needs the action's execution binding
// and its buddy envelope, which `bindBuddyAuthorization` checks against the
// trusted buddy and repository files reread here, never the payload.

import { z } from "zod";
import type { Config } from "../config.ts";
import { ACTION_CAUSE, BINDING } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import {
  BUDDY_ENVELOPE,
  bindBuddyAuthorization,
  loadBuddy,
} from "../runtime/buddy-config.ts";
import { checkpointAction } from "./checkpoint-action.ts";
import { completeReconcile, completeTask } from "./complete-task.ts";
import { integrateTask } from "./integration-task.ts";
import { landReconcile, landTask } from "./land-task.ts";
import { pushOp } from "./push.ts";
import { syncReconcile, syncTask, syncTaskFinish } from "./sync-task.ts";
import { taskAttempt, taskResult } from "./task-actions.ts";
import type { ActionSource, OpClass } from "./task-guard.ts";
import { TASK_OP_CLASSES, withTaskGuard } from "./task-guard.ts";
import { openTaskPr } from "./task-pr.ts";
import { prepareCheckout } from "./task-prepare.ts";

type Op = (cfg: Config, request: unknown) => object;

const OPS: ReadonlyMap<string, Op> = new Map<string, Op>([
  ["task-attempt", taskAttempt],
  ["task-result", taskResult],
  ["checkpoint-action", checkpointAction],
  ["prepare-checkout", prepareCheckout],
  ["push", pushOp],
  ["open-task-pr", openTaskPr],
  ["integrate-task", integrateTask],
  ["sync-task", syncTask],
  ["sync-task-finish", syncTaskFinish],
  ["sync-reconcile", syncReconcile],
  ["land-task", landTask],
  ["land-reconcile", landReconcile],
  ["complete-task", completeTask],
  ["complete-reconcile", completeReconcile],
]);

// Each task op with its class from TASK_OP_CLASSES. The two maps must name
// the same ops: an op with no class, or a class with no op, fails the ops
// program as it loads rather than guarding some op by a guessed class.
function classifiedOps(): ReadonlyMap<string, { kind: OpClass; op: Op }> {
  const unclassified = [...OPS.keys()].filter(
    (name) => !TASK_OP_CLASSES.has(name),
  );
  const missing = [...TASK_OP_CLASSES.keys()].filter((name) => !OPS.has(name));
  if (unclassified.length > 0 || missing.length > 0) {
    throw new OpsError(
      `task op classes disagree: unclassified [${unclassified.join(", ")}], no op for [${missing.join(", ")}]`,
    );
  }
  return new Map(
    [...OPS].map(([name, op]): [string, { kind: OpClass; op: Op }] => [
      name,
      { kind: TASK_OP_CLASSES.get(name) ?? "substantive", op },
    ]),
  );
}

const TASK_OPS = classifiedOps();

const FRAME = z.looseObject({
  number: z.number().int().positive(),
  buddy: z.unknown(),
});
const PROPOSED = z.looseObject({ binding: BINDING, cause: ACTION_CAUSE });

function proposedOf(name: string, request: unknown): ActionSource | null {
  if (name !== "task-attempt") {
    return null;
  }
  const { binding, cause } = PROPOSED.parse(request);
  return { binding, cause };
}

// `cfg` bound to the action's buddy authorization and guarded for op
// `name`, or a refusal before any effect.
function guardedTaskConfig(
  cfg: Config,
  name: string,
  request: unknown,
  repositoryConfig: string | null,
): Config {
  const entry = TASK_OPS.get(name);
  if (entry === undefined) {
    throw new OpsError(`${name} is not a task op`);
  }
  if (cfg.execution === undefined || repositoryConfig === null) {
    throw new OpsError(`${name} runs only for a bound buddy action`);
  }
  const frame = FRAME.parse(request);
  const bound = bindBuddyAuthorization(cfg, repositoryConfig, frame.buddy);
  const { config } = BUDDY_ENVELOPE.parse(frame.buddy);
  const { organization } = loadBuddy(config).config.scope;
  return withTaskGuard(bound, {
    kind: entry.kind,
    scope: { organization },
    number: frame.number,
    proposed: proposedOf(name, request),
  });
}

function taskOp(name: string): Op | undefined {
  return TASK_OPS.get(name)?.op;
}

export { guardedTaskConfig, TASK_OPS, taskOp };
