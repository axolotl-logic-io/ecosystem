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
import { withTaskGuard } from "./task-guard.ts";
import { openTaskPr } from "./task-pr.ts";

type Op = (cfg: Config, request: unknown) => object;

const TASK_OPS: ReadonlyMap<string, { kind: OpClass; op: Op }> = new Map([
  ["task-attempt", { kind: "substantive", op: taskAttempt }],
  ["task-result", { kind: "finalization", op: taskResult }],
  ["checkpoint-action", { kind: "finalization", op: checkpointAction }],
  ["push", { kind: "substantive", op: pushOp }],
  ["open-task-pr", { kind: "substantive", op: openTaskPr }],
  ["integrate-task", { kind: "substantive", op: integrateTask }],
  ["sync-task", { kind: "substantive", op: syncTask }],
  ["sync-task-finish", { kind: "substantive", op: syncTaskFinish }],
  ["sync-reconcile", { kind: "finalization", op: syncReconcile }],
  ["land-task", { kind: "substantive", op: landTask }],
  ["land-reconcile", { kind: "finalization", op: landReconcile }],
  ["complete-task", { kind: "substantive", op: completeTask }],
  ["complete-reconcile", { kind: "finalization", op: completeReconcile }],
]);

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
