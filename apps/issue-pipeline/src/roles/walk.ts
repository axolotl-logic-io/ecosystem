// How a role's run moves, whatever the role's shape: a machine's table and
// transition, or a linear role's ordered steps, both seen by the runner
// (src/job/runner.ts) as positions: a state's name, kind, data and effect.
// Pure, with no I/O.

import type { State } from "../state.ts";
import type {
  Effect,
  End,
  Limits,
  MachineState,
  Result,
  StateKind,
  Table,
} from "./machine.ts";
import { transitionOf } from "./machine.ts";

// The `data` keys a role may write to the issue's state.
interface Writes<D> {
  handoff: readonly (keyof D & string)[];
  checkpoints: readonly (keyof D & string)[];
}

interface Machine<S extends string, R extends string, D> extends Writes<D> {
  table: Table<S, R, D>;
  limits: Limits;
  locate: (saved: State) => MachineState<S, D>;
}

// A linear role's step: what it runs, and how its reply changes `data`.
interface LinearStep<D> {
  name: string;
  kind: "script" | "session";
  effect: (data: D) => Effect;
  apply?: (data: D, reply: unknown) => D;
}

// A linear role: its locate picks the step to start at (a name no step has
// starts at the end), then the steps run in order, then `end`.
interface LinearScript<D> extends Writes<D> {
  locate: (saved: State) => MachineState<string, D>;
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
// and whether a position lists the failed result.
interface Walk<S extends string, D> {
  start: (saved: State) => Position<S, D>;
  next: (position: Position<S, D>, result: Result<string>) => Position<S, D>;
  takesFailure: (position: Position<S, D>) => boolean;
}

// Whether the state lists result `name`.
function listed<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
  at: S,
  name: string,
): name is R {
  return Object.hasOwn(machine.table.states[at].on, name);
}

function machineWalk<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
): Walk<S, D> {
  const { states } = machine.table;
  const transition = transitionOf(machine.table, machine.limits);
  function positionOf({ at, data }: MachineState<S, D>): Position<S, D> {
    return { at, kind: states[at].kind, data, effect: states[at].effect(data) };
  }
  return {
    start: (saved: State): Position<S, D> => positionOf(machine.locate(saved)),
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
    takesFailure: (position: Position<S, D>): boolean =>
      listed(machine, position.at, "failed"),
  };
}

function linearWalk<D>(script: LinearScript<D>): Walk<string, D> {
  const { steps } = script;
  function indexOf(at: string): number {
    return steps.findIndex((step: LinearStep<D>): boolean => step.name === at);
  }
  function positionAt(index: number, data: D): Position<string, D> {
    const step = steps[index];
    if (step === undefined) {
      const effect: Effect = { kind: "end", end: script.end(data) };
      return { at: "end", kind: "end", data, effect };
    }
    return { at: step.name, kind: step.kind, data, effect: step.effect(data) };
  }
  return {
    start: (saved: State): Position<string, D> => {
      const { at, data } = script.locate(saved);
      return positionAt(indexOf(at), data);
    },
    next: (
      position: Position<string, D>,
      result: Result<string>,
    ): Position<string, D> => {
      const index = indexOf(position.at);
      let { data } = position;
      const apply = steps[index]?.apply;
      if (apply !== undefined) {
        data = apply(data, result.reply);
      }
      return positionAt(index + 1, data);
    },
    takesFailure: (): boolean => false,
  };
}

export type { LinearScript, LinearStep, Machine, Position, Walk, Writes };
export { linearWalk, machineWalk };
