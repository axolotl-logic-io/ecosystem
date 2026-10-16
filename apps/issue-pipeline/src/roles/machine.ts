// A role's state machine as data (`role-state-machines` in the wiki's
// Pipeline-Roles-Shared page): a table of states, each with its kind, its
// effect and the results it accepts, and one pure transition built from it.
// The runner (src/job/runner.ts) carries the effects out; this module does no
// I/O. checkTable checks a table's graph: kinds match effects, every cycle is
// bounded by a configured count, every state is reachable and can end.

import type { JsonSchema } from "../workflow/schemas.ts";
import type { Role as BudgetRole } from "../workflow/types.ts";

type StateKind = "script" | "session" | "end";

// How a run ends: the issue saved at `stage` (the job ends), saved at
// `stage` and carried on there in the same job, stopped with a stop code,
// released, or held for the next tick.
type End =
  | { kind: "saved"; stage: string }
  | { kind: "next"; stage: string }
  | { kind: "stopped"; code: string }
  | { kind: "released" }
  | { kind: "held" };

// A model session: its name, agent and model, the schema of its reply, its
// task, its token budget and the role it is charged as (its context log
// line's role).
interface SessionEffect {
  kind: "session";
  name: string;
  agent: string;
  model: string;
  schema: JsonSchema;
  task: string;
  tokenBudget: number;
  budgetRole: BudgetRole;
}

// What a state does: run an op or a script check with its payload, run a
// model session, or end the run.
type Effect =
  | { kind: "op"; op: string; payload: Readonly<Record<string, unknown>> }
  | { kind: "check"; check: string; payload: Readonly<Record<string, unknown>> }
  | SessionEffect
  | { kind: "end"; end: End };

// The `data` fields that hold a number: the only ones a count may name.
type CountField<D> = {
  [K in keyof D]-?: D[K] extends number ? K : never;
}[keyof D] &
  string;

// A count that bounds an edge: the `data` field it adds 1 to, the name of its
// limit in the config's limits, and where the edge goes once the count has
// reached that limit.
interface Guard<S extends string, D> {
  field: CountField<D>;
  limit: string;
  over: S;
}

// Where a result takes a state: the next state, how the result's reply
// changes `data`, and the count that bounds the edge, if any.
interface Edge<S extends string, D> {
  to: S;
  apply?: (data: D, reply: unknown) => D;
  count?: Guard<S, D>;
}

interface StateSpec<S extends string, R extends string, D> {
  kind: StateKind;
  effect: (data: D) => Effect;
  on: Readonly<Partial<Record<R, Edge<S, D>>>>;
}

// A machine: the states a job can enter at, and every state.
interface Table<S extends string, R extends string, D> {
  entries: readonly S[];
  states: Readonly<Record<S, StateSpec<S, R, D>>>;
}

interface MachineState<S extends string, D> {
  at: S;
  data: D;
}

// An effect's named result and its reply (a failed effect's reply is its
// error text).
interface Result<R extends string> {
  name: R;
  reply: unknown;
}

interface Step<S extends string, D> {
  state: MachineState<S, D>;
  effect: Effect;
}

type Limits = Readonly<Record<string, number>>;

function countOf<D>(data: D, field: CountField<D>): number {
  const value: unknown = data[field];
  if (typeof value === "number") {
    return value;
  }
  return 0;
}

// The edge's target and data once it is taken: past its guard's limit it
// goes to the guard's over-limit state, and otherwise adds 1 to the count.
function taken<S extends string, D>(
  edge: Edge<S, D>,
  data: D,
  limits: Limits,
): MachineState<S, D> {
  const { count } = edge;
  if (count === undefined) {
    return { at: edge.to, data };
  }
  const { [count.limit]: limit } = limits;
  if (limit === undefined) {
    throw new Error(`machine: no limit ${count.limit}`);
  }
  const done = countOf(data, count.field);
  if (done >= limit) {
    return { at: count.over, data };
  }
  return { at: edge.to, data: { ...data, [count.field]: done + 1 } };
}

// The pure transition of `table`: the next state and its effect for a
// result. It throws on a result the table doesn't list for the state.
function transitionOf<S extends string, R extends string, D>(
  table: Table<S, R, D>,
  limits: Limits,
): (state: MachineState<S, D>, result: Result<R>) => Step<S, D> {
  return (state: MachineState<S, D>, result: Result<R>): Step<S, D> => {
    const edge = table.states[state.at].on[result.name];
    if (edge === undefined) {
      throw new Error(`machine: ${state.at} doesn't accept ${result.name}`);
    }
    let { data } = state;
    if (edge.apply !== undefined) {
      data = edge.apply(data, result.reply);
    }
    const next = taken(edge, data, limits);
    return { state: next, effect: table.states[next.at].effect(next.data) };
  };
}

// Each state's targets, with or without the edges a configured count guards.
interface Graph {
  all: ReadonlyMap<string, readonly string[]>;
  unguarded: ReadonlyMap<string, readonly string[]>;
}

function edgesOf<S extends string, D>(
  on: Readonly<Partial<Record<string, Edge<S, D>>>>,
): Edge<S, D>[] {
  return Object.values(on).filter(
    (edge): edge is Edge<S, D> => edge !== undefined,
  );
}

function graphOf<S extends string, R extends string, D>(
  table: Table<S, R, D>,
  limits: Limits,
  violations: string[],
): Graph {
  const all = new Map<string, string[]>();
  const unguarded = new Map<string, string[]>();
  for (const [name, spec] of Object.entries<StateSpec<S, R, D>>(table.states)) {
    const targets: string[] = [];
    const loose: string[] = [];
    for (const edge of edgesOf(spec.on)) {
      targets.push(edge.to);
      const { count } = edge;
      if (count === undefined) {
        loose.push(edge.to);
      } else {
        targets.push(count.over);
        loose.push(count.over);
        if (!Object.hasOwn(limits, count.limit)) {
          violations.push(`${name}: count limit ${count.limit} isn't set`);
          loose.push(edge.to);
        }
      }
    }
    all.set(name, targets);
    unguarded.set(name, loose);
  }
  return { all, unguarded };
}

function kindViolation(
  name: string,
  kind: StateKind,
  effect: Effect,
): string[] {
  const found: string[] = [];
  if ((effect.kind === "session") !== (kind === "session")) {
    found.push(`${name}: a ${kind} state with a ${effect.kind} effect`);
  }
  if ((effect.kind === "end") !== (kind === "end")) {
    found.push(`${name}: a ${kind} state with a ${effect.kind} effect`);
  }
  return found.slice(0, 1);
}

// The states reachable from `starts` along `edges`.
function reach(
  starts: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const seen = new Set<string>();
  const todo = [...starts];
  for (let name = todo.pop(); name !== undefined; name = todo.pop()) {
    if (!seen.has(name)) {
      seen.add(name);
      todo.push(...(edges.get(name) ?? []));
    }
  }
  return seen;
}

// The states that lie on a cycle of `edges`.
function cyclic(edges: ReadonlyMap<string, readonly string[]>): string[] {
  return [...edges.keys()].filter((name: string): boolean =>
    reach(edges.get(name) ?? [], edges).has(name),
  );
}

// What is wrong with `table`'s graph, empty when nothing is. `sample` is a
// `data` value to build each state's effect from.
function checkTable<S extends string, R extends string, D>(
  table: Table<S, R, D>,
  limits: Limits,
  sample: D,
): string[] {
  const violations: string[] = [];
  const graph = graphOf(table, limits, violations);
  const states = Object.entries<StateSpec<S, R, D>>(table.states);
  const ends = states
    .filter(([, spec]) => spec.kind === "end")
    .map(([name]) => name);
  const reached = reach(table.entries, graph.all);
  for (const [name, spec] of states) {
    violations.push(...kindViolation(name, spec.kind, spec.effect(sample)));
    if (!reached.has(name)) {
      violations.push(`${name}: no entry reaches it`);
    }
    const ahead = reach([name], graph.all);
    if (spec.kind !== "end" && !ends.some((end) => ahead.has(end))) {
      violations.push(`${name}: no end can be reached from it`);
    }
  }
  for (const name of cyclic(graph.unguarded)) {
    violations.push(`${name}: on a cycle no configured count bounds`);
  }
  return violations;
}

export type {
  Edge,
  Effect,
  End,
  Guard,
  Limits,
  MachineState,
  Result,
  SessionEffect,
  StateKind,
  StateSpec,
  Step,
  Table,
};
export { checkTable, transitionOf };
