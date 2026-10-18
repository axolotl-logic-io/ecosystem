// How a role's run moves, whatever the role's shape: a machine's table and
// transition, or a linear role's ordered steps, both seen by the runner
// (src/job/runner.ts) as positions: a state's name, kind, data and effect.
// Pure, with no I/O.

import type { State } from "../state.ts";
import type { Budgets } from "../workflow/budget.ts";
import { isTransientSessionError } from "../workflow/stages/rate-limit.ts";
import type { ModelRole, SweepConfig } from "../workflow/stages/types.ts";
import type { ItemPaths } from "../workflow/types.ts";
import type {
  Edge,
  Effect,
  End,
  Limits,
  MachineState,
  Result,
  StateKind,
  StateSpec,
  Table,
} from "./machine.ts";
import { transitionOf } from "./machine.ts";

// What a role's locate reads besides the saved state: the issue, the job's
// random id, which signs the role's comments, the repo config, the token
// budgets and models, the claim's paths with the job's checkout as the
// worktree, the time the run started and the merge queue.
// `mergeQueue` is the merge queue the orchestrator passed (`--merge-queue`),
// or null when it passed none.
interface RoleContext {
  issue: number;
  jobId: string;
  cfg: SweepConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  paths: ItemPaths;
  now: Date;
  mergeQueue: readonly number[] | null;
}

// The `data` keys a role may write to the issue's state.
interface Writes<D> {
  handoff: readonly (keyof D & string)[];
  checkpoints: readonly (keyof D & string)[];
}

// A machine role: its table, its limits, the limits the repo config sets
// over them, if any, where locate starts it, and what it writes.
interface Machine<S extends string, R extends string, D> extends Writes<D> {
  table: Table<S, R, D>;
  limits: Limits;
  limitsOf?: (cfg: SweepConfig) => Limits;
  locate: (saved: State, context: RoleContext) => MachineState<S, D>;
}

// A linear role's step: what it runs, how its reply changes `data`, and,
// for a step whose failure the role takes, how the error changes `data`
// before the run goes on: `recover` for any failure but a session's
// transient provider error, and `defer` for that one, for a session step
// that must undo work before the run is held (without it, the runner holds
// the run at once, `rate-limit-defers`). A step whose `skip` holds for the `data` the run
// reaches it with is passed over; one whose `again` holds for the `data` its
// result left runs once more, which the role bounds.
interface LinearStep<D> {
  name: string;
  kind: "script" | "session";
  effect: (data: D) => Effect;
  apply?: (data: D, reply: unknown) => D;
  recover?: (data: D, error: string) => D;
  defer?: (data: D, error: string) => D;
  skip?: (data: D) => boolean;
  again?: (data: D) => boolean;
}

// A linear role: its locate picks the step to start at (a name no step has
// starts at the end), then the steps run in order, each skipped or repeated
// as it says, then `end`.
interface LinearScript<D> extends Writes<D> {
  locate: (saved: State, context: RoleContext) => MachineState<string, D>;
  steps: readonly LinearStep<D>[];
  end: (data: D) => End;
}

// Where a run is: its state's name, kind, data and effect.
interface Position<S extends string, D> {
  at: S;
  kind: StateKind;
  data: D;
  effect: Effect;
}

// How a run moves: where locate starts it, the position after a result,
// whether the role takes a position's failure with `error` itself (a
// session's transient provider error never reaches a machine's `failed`
// edge, and reaches only a linear step's `defer`), and the `data` fields
// the role counts in.
interface Walk<S extends string, D> {
  start: (saved: State, context: RoleContext) => Position<S, D>;
  next: (position: Position<S, D>, result: Result<string>) => Position<S, D>;
  takesFailure: (position: Position<S, D>, error: string) => boolean;
  counts: readonly string[];
}

// Whether the state lists result `name`.
function listed<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
  at: S,
  name: string,
): name is R {
  return Object.hasOwn(machine.table.states[at].on, name);
}

// Whether `position` failed with a session's transient provider error: a
// rate limit, an overload or a transport error (`rate-limit-defers`).
function transientAt<S extends string, D>(
  position: Position<S, D>,
  error: unknown,
): boolean {
  return position.kind === "session" && isTransientSessionError(String(error));
}

// The `data` fields the guards of `table`'s edges count in.
function countsOf<S extends string, R extends string, D>(
  table: Table<S, R, D>,
): string[] {
  const fields = new Set<string>();
  for (const { on } of Object.values<StateSpec<S, R, D>>(table.states)) {
    for (const edge of Object.values<Edge<S, D> | undefined>(on)) {
      if (edge?.count !== undefined) {
        fields.add(edge.count.field);
      }
    }
  }
  return [...fields];
}

// How `machine` moves in a run whose config is `cfg`, under its limits with
// those the config sets over them.
function machineWalk<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
  { cfg }: RoleContext,
): Walk<S, D> {
  const { states } = machine.table;
  const limits = { ...machine.limits, ...machine.limitsOf?.(cfg) };
  const transition = transitionOf(machine.table, limits);
  function positionOf({ at, data }: MachineState<S, D>): Position<S, D> {
    return { at, kind: states[at].kind, data, effect: states[at].effect(data) };
  }
  return {
    start: (saved: State, context: RoleContext): Position<S, D> =>
      positionOf(machine.locate(saved, context)),
    next: (
      position: Position<S, D>,
      result: Result<string>,
    ): Position<S, D> => {
      const { name, reply } = result;
      if (!listed(machine, position.at, name)) {
        throw new Error(`runner: ${position.at} doesn't accept ${name}`);
      }
      const { state, effect } = transition(position, { name, reply });
      return { ...positionOf(state), effect };
    },
    takesFailure: (position: Position<S, D>, error: string): boolean =>
      !transientAt(position, error) && listed(machine, position.at, "failed"),
    counts: countsOf(machine.table),
  };
}

// How `step` takes `result` at `position`, if `result` is a failure it takes.
function failureHandler<D>(
  step: LinearStep<D> | undefined,
  position: Position<string, D>,
  result: Result<string>,
): ((data: D, error: string) => D) | undefined {
  if (result.name !== "failed") {
    return undefined;
  }
  if (transientAt(position, result.reply) && step?.defer !== undefined) {
    return step.defer;
  }
  return step?.recover;
}

function linearWalk<D>(script: LinearScript<D>): Walk<string, D> {
  const { steps } = script;
  function indexOf(at: string): number {
    return steps.findIndex((step: LinearStep<D>): boolean => step.name === at);
  }
  // The position at the first step from `from` that `data` doesn't skip.
  function positionAt(from: number, data: D): Position<string, D> {
    let index = from;
    while (steps[index]?.skip?.(data) === true) {
      index += 1;
    }
    const step = steps[index];
    if (step === undefined) {
      const effect: Effect = { kind: "end", end: script.end(data) };
      return { at: "end", kind: "end", data, effect };
    }
    return { at: step.name, kind: step.kind, data, effect: step.effect(data) };
  }
  return {
    start: (saved: State, context: RoleContext): Position<string, D> => {
      const { at, data } = script.locate(saved, context);
      return positionAt(indexOf(at), data);
    },
    next: (
      position: Position<string, D>,
      result: Result<string>,
    ): Position<string, D> => {
      const index = indexOf(position.at);
      const step = steps[index];
      let { data } = position;
      const failure = failureHandler(step, position, result);
      if (failure !== undefined) {
        data = failure(data, String(result.reply));
      } else if (step?.apply !== undefined) {
        data = step.apply(data, result.reply);
      }
      if (step?.again?.(data) === true) {
        return positionAt(index, data);
      }
      return positionAt(index + 1, data);
    },
    takesFailure: (position: Position<string, D>, error: string): boolean => {
      const step = steps[indexOf(position.at)];
      if (transientAt(position, error)) {
        return step?.defer !== undefined;
      }
      return step?.recover !== undefined;
    },
    counts: [],
  };
}

export type {
  LinearScript,
  LinearStep,
  Machine,
  Position,
  RoleContext,
  Walk,
  Writes,
};
export { linearWalk, machineWalk };
