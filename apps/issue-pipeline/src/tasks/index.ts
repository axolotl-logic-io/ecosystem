// The tasks component's public API for the buddy runtime: every task's
// definition, the work item's task view, and the action recording helpers.
// Recording runs in the fresh ops child through the action's own `op`, so
// every attempt and result is checked there against fresh reads and the
// child's own trusted configuration; nothing here grants a retry.

import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import type {
  ActionCause,
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Receipt,
  TaskDefinition,
  TaskId,
  TaskView,
} from "../domain.ts";
import { MAX_SUMMARY } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import { MODULES } from "./modules.ts";
import { attemptsOf, isAttempt, isResult, readRecords } from "./records.ts";
import { taskEvidence } from "./view.ts";

const ADMISSION = z.union([
  z.looseObject({ admitted: z.literal(true) }),
  z.looseObject({
    admitted: z.literal(false),
    state: z.enum(["waiting", "held"]),
    reason: z.string().min(1),
  }),
]);

// A new attempt the ops child would not record: nothing was recorded and
// no task effect may follow. `waiting` may change with new evidence; `held`
// needs a person.
class ActionNotAdmitted extends OpsError {
  readonly state: "waiting" | "held";

  constructor(state: "waiting" | "held", reason: string) {
    super(reason);
    this.state = state;
  }
}

const TASKS: Readonly<Record<TaskId, TaskDefinition>> = {
  author: MODULES.author.definition,
  implement: MODULES.implement.definition,
  verify: MODULES.verify.definition,
  fix: MODULES.fix.definition,
  land: MODULES.land.definition,
  "refactor-safely": MODULES["refactor-safely"].definition,
};

// Runs a synchronous read so that its throw rejects the promise.
function read<T>(reader: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(reader());
  });
}

function readTaskView(cfg: Config, number: number): Promise<TaskView> {
  return read(() => taskEvidence(cfg, number, ensureClone(cfg)).view);
}

// Validates prerequisites and budget and records the attempt, in the ops
// child, before the action's first effect. Throws ActionNotAdmitted when
// nothing was recorded.
async function beginAction(ctx: ActionContext): Promise<void> {
  const reply = ADMISSION.parse(
    await ctx.op("task-attempt", {
      number: ctx.workItem.number,
      binding: ctx.binding,
      run: ctx.run,
      buddyRun: ctx.buddyRun,
      cause: ctx.cause,
    }),
  );
  if (!reply.admitted) {
    throw new ActionNotAdmitted(reply.state, reply.reason);
  }
}

// Records the action's end for its own attempt. An effect op that already
// recorded the run's verdict makes this a confirmation; an uncertain end
// stays unknown.
async function finishAction(ctx: ActionContext, end: ActionEnd): Promise<void> {
  const receipt: Receipt = { summary: end.reason.slice(0, MAX_SUMMARY) };
  if (end.produced !== undefined) {
    receipt.produced = end.produced;
  }
  await ctx.op("task-result", {
    number: ctx.workItem.number,
    binding: ctx.binding,
    run: { id: ctx.run.id },
    verdict: end.verdict,
    receipt,
  });
}

// The latest action of `binding`, to link as a new attempt's predecessor.
// It authorizes nothing.
function previousAction(cfg: Config, binding: Binding): Promise<string | null> {
  return read(() => {
    const { number } = binding.workItem;
    const { rows } = readRecords(cfg, number, listComments(cfg, number));
    return attemptsOf(rows, binding).at(-1)?.run.id ?? null;
  });
}

function actionCauses(
  cfg: Config,
  number: number,
): Promise<readonly { binding: Binding; cause: ActionCause }[]> {
  return read(() =>
    readRecords(cfg, number, listComments(cfg, number))
      .rows.filter(isAttempt)
      .map((row) => ({ binding: row.binding, cause: row.cause })),
  );
}

// Every determined v2 result of the item as a result signal: evidence for
// matching, never permission.
function machineSignals(
  cfg: Config,
  number: number,
): Promise<readonly QualifiedSignal[]> {
  return read(() =>
    readRecords(cfg, number, listComments(cfg, number))
      .rows.filter(isResult)
      .filter((row) => row.verdict !== "unknown")
      .map(
        (row): QualifiedSignal => ({
          kind: "result",
          id: `result:${String(row.id)}`,
          workItem: row.binding.workItem,
          binding: row.binding,
          recordId: row.id,
          producerRun: row.buddyRun,
        }),
      ),
  );
}

export {
  ActionNotAdmitted,
  actionCauses,
  beginAction,
  finishAction,
  machineSignals,
  previousAction,
  readTaskView,
  TASKS,
};
