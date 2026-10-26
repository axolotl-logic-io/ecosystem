// The canonical task ops a buddy action's ops child serves, each task's
// from its own list, and the authority each composes before it runs and
// again at each controlled mutation (task-guard.ts). Every one needs the action's execution binding
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
import { LAND_OPS } from "./land-task.ts";
import { pushOp } from "./push.ts";
import { taskAttempt, taskResult } from "./task-actions.ts";
import type { ActionSource, OpClass, TaskOpSpec } from "./task-guard.ts";
import { withTaskGuard } from "./task-guard.ts";
import { openTaskPr } from "./task-pr.ts";
import { prepareCheckout } from "./task-prepare.ts";
import { VERIFY_OPS } from "./verify-task.ts";
import { WRITER_OPS } from "./writer-ops.ts";

type Op = TaskOpSpec["op"];

// The ops every task action shares: its attempt and result records, its
// checkpoints, its checkout's setup, and a writer's push and PR.
const SHARED_OPS: readonly TaskOpSpec[] = [
  { name: "task-attempt", kind: "substantive", op: taskAttempt },
  { name: "task-result", kind: "finalization", op: taskResult },
  { name: "checkpoint-action", kind: "finalization", op: checkpointAction },
  { name: "prepare-checkout", kind: "substantive", op: prepareCheckout },
  { name: "push", kind: "substantive", op: pushOp },
  { name: "open-task-pr", kind: "substantive", op: openTaskPr },
];

// Every canonical task op by name. A name listed twice fails the ops
// program and the buddy as they load, rather than serving one of them.
function taskOps(): ReadonlyMap<string, TaskOpSpec> {
  const specs = [...SHARED_OPS, ...WRITER_OPS, ...VERIFY_OPS, ...LAND_OPS];
  const ops = new Map(specs.map((spec) => [spec.name, spec]));
  if (ops.size !== specs.length) {
    const repeated = specs.filter(
      (spec, at) => specs.findIndex((item) => item.name === spec.name) !== at,
    );
    throw new OpsError(
      `task ops are listed twice: ${repeated.map((spec) => spec.name).join(", ")}`,
    );
  }
  return ops;
}

const TASK_OPS = taskOps();

// The class of each canonical task op, which the ops child guards it by and
// the runtime checks before it spawns one.
const TASK_OP_CLASSES: ReadonlyMap<string, OpClass> = new Map(
  [...TASK_OPS].map(([name, spec]): [string, OpClass] => [name, spec.kind]),
);

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

export { guardedTaskConfig, TASK_OP_CLASSES, taskOp };
