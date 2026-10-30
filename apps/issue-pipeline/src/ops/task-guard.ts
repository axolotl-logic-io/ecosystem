// The authority every canonical task op composes at each controlled
// mutation, not once before the child starts (domain-runtime-contract.md):
//
//   substantive    the buddy's trusted authorization reread
//                  (runtime/buddy-config.ts), no accepted or unknown stop
//                  (signals/inbox.ts), and the action's cause still
//                  authoritative: a determined v2 result still in the
//                  records, or else an accepted human signal (a start or a
//                  review) requalified now. Implement has a human
//                  cause, except a continuation, whose cause is the
//                  interrupted Implement result it follows and whose
//                  original person's start is requalified now too;
//   finalization   the buddy's authorization only, for evidence-only
//                  checkpoints, results and read-only reconciliation, which
//                  a stop or a revoked source must still let settle.
//
// Execution ownership and the uncertain-write journal stay the execution's
// own (execution.ts controlledMutation), which every write still crosses.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import type { ActionCause, Binding } from "../domain.ts";
import { INTERRUPTED_EVIDENCE } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import type { RunResult } from "../process.ts";
import { assertBuddyAuthorization } from "../runtime/buddy-config.ts";
import type { SignalScope } from "../signals/inbox.ts";
import { requalifyHumanNow, stopLatchNow } from "../signals/inbox.ts";
import type { Records } from "../tasks/records.ts";
import {
  determined,
  isAttempt,
  readRecords,
  TASK_ATTEMPTS,
} from "../tasks/records.ts";
import type { WriteIntent } from "../write-refusal.ts";

type OpClass = "substantive" | "finalization";

// One canonical task op: its name, the class the ops child guards it by and
// the runtime checks before it spawns one, and its handler. Each task
// module's ops export their own list, which ops/task-ops.ts serves.
interface TaskOpSpec {
  name: string;
  kind: OpClass;
  op: (cfg: Config, request: unknown) => object;
}

// The tasks whose every action a person's accepted signal causes.
const HUMAN_CAUSED: ReadonlySet<Binding["task"]> = new Set(["implement"]);
const RESULT_SIGNAL = /^result:\d+$/u;

// What the action acts for: its binding and cause, from the attempt it is
// about to record (task-attempt) or else its run's recorded attempt.
interface ActionSource {
  binding: Binding;
  cause: ActionCause;
}

interface TaskGuard {
  kind: OpClass;
  scope: SignalScope;
  number: number;
  // The attempt `task-attempt` would record; otherwise null.
  proposed: ActionSource | null;
}

function recordedSource(cfg: Config, number: number): ActionSource {
  const run = cfg.execution?.instance;
  const { rows } = readRecords(cfg, number, listComments(cfg, number));
  const attempt = rows.filter(isAttempt).find((row) => row.run.id === run);
  if (attempt === undefined) {
    throw new OpsError(`action ${String(run)} has no recorded attempt`);
  }
  return { binding: attempt.binding, cause: attempt.cause };
}

// The machine cause: a determined v2 result of this item, by its record id.
// Returns the result.
function assertResultCause(
  records: Records,
  cause: ActionCause,
): Extract<Records["rows"][number], { kind: "result" }> {
  const { rows } = records;
  const result = rows.find((row) => row.id === cause.recordId);
  if (
    result === undefined ||
    result.kind !== "result" ||
    cause.signal !== `result:${String(result.id)}` ||
    determined(rows, result.run.id)?.id !== result.id
  ) {
    throw new OpsError(`cause ${cause.signal} is not a current task result`);
  }
  return result;
}

// The person's start an Implement continuation goes back to: the cause of
// the run its interrupted result settled, followed through any earlier
// continuations. Only an interrupted Implement result may cause one.
function continuedStart(records: Records, cause: ActionCause): ActionCause {
  let current = cause;
  for (let hop = 0; hop < TASK_ATTEMPTS; hop += 1) {
    if (!RESULT_SIGNAL.test(current.signal)) {
      return current;
    }
    const result = assertResultCause(records, current);
    if (
      result.binding.task !== "implement" ||
      !INTERRUPTED_EVIDENCE.safeParse(result.receipt.evidence).success
    ) {
      throw new OpsError(
        `cause ${current.signal} is not an interrupted Implement result`,
      );
    }
    current = result.cause;
  }
  throw new OpsError(`cause ${cause.signal} continues too many runs`);
}

function assertCause(cfg: Config, guard: TaskGuard): void {
  const source = guard.proposed ?? recordedSource(cfg, guard.number);
  const { binding } = source;
  let { cause } = source;
  if (RESULT_SIGNAL.test(cause.signal)) {
    const records = readRecords(
      cfg,
      guard.number,
      listComments(cfg, guard.number),
    );
    if (!HUMAN_CAUSED.has(binding.task)) {
      assertResultCause(records, cause);
      return;
    }
    if (binding.task !== "implement") {
      throw new OpsError(`${binding.task} takes only a person's cause`);
    }
    cause = continuedStart(records, cause);
  }
  const human = requalifyHumanNow(cfg, guard.scope, {
    id: cause.signal,
    recordId: cause.recordId,
    workItem: binding.workItem,
  });
  if (human.status !== "qualified") {
    throw new OpsError(
      `signal ${cause.signal} is ${human.status}: ${human.reason}`,
    );
  }
}

function assertNoStop(cfg: Config, number: number): void {
  const latch = stopLatchNow(cfg, number);
  if (latch.state !== "clear") {
    throw new OpsError(`#${number}'s stop is ${latch.state}: ${latch.reason}`);
  }
}

// Throws unless `guard`'s authority holds now; the check each controlled
// mutation of a task op, or of the action's session push, crosses.
function checkGuard(cfg: Config, guard: TaskGuard): void {
  assertBuddyAuthorization(cfg);
  if (guard.kind === "substantive") {
    assertNoStop(cfg, guard.number);
    assertCause(cfg, guard);
  }
}

// `cfg`, whose every controlled mutation first checks `guard`'s authority
// again, at the mutation itself.
function guardedMutations(cfg: Config, guard: TaskGuard): Config {
  const inner = cfg.mutation;
  if (inner === undefined) {
    throw new OpsError(
      "a guarded write needs its execution's mutation boundary",
    );
  }
  return {
    ...cfg,
    mutation: (write: () => RunResult, intent: WriteIntent): RunResult => {
      checkGuard(cfg, guard);
      return inner(write, intent);
    },
  };
}

// `cfg`, checked now, whose every controlled mutation first checks the
// op's authority again.
function withTaskGuard(cfg: Config, guard: TaskGuard): Config {
  const guarded = guardedMutations(cfg, guard);
  checkGuard(cfg, guard);
  return guarded;
}

export type { ActionSource, OpClass, TaskGuard, TaskOpSpec };
export { checkGuard, guardedMutations, withTaskGuard };
