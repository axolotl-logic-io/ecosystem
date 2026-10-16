// The role runner (`role-state-machines` in the wiki's Pipeline-Roles-Shared
// page): it runs a role's locate over the issue's saved state, then each
// state's effect, then the role's transition, until an end, reporting every
// step. It alone decides how a failure the role doesn't list ends (held on a
// network error, stopped with the step-failure code otherwise), refuses a
// session from a non-session state, and decides what is saved and when: only
// the role's declared hand-off fields and checkpoints, saved at every end
// and as soon as a checkpoint changes, so a count is saved when it goes up.
// It reads nothing but the saved state it is given (`every-role-resumes`).

import type { Effect, End, Result, SessionEffect } from "../roles/machine.ts";
import type {
  LinearScript,
  Machine,
  Position,
  Walk,
  Writes,
} from "../roles/walk.ts";
import { linearWalk, machineWalk } from "../roles/walk.ts";
import type { State } from "../state.ts";
import { isNetworkError } from "../workflow/stages/network.ts";
import { checkpointsChanged, writtenState } from "./role-state.ts";
import type { StopSignal } from "./status.ts";

// The end of a failed step, with the step-failure stop code (src/stops.ts).
const STEP_FAILED: End = { kind: "stopped", code: "error" };

type OpEffect = Extract<Effect, { kind: "op" }>;
type CheckEffect = Extract<Effect, { kind: "check" }>;

// What an effect came to: a named result with its reply, or a failure.
type Outcome =
  | { ok: true; name: string; reply: unknown }
  | { ok: false; error: string };

// One step as job.json shows it; endedAt and result are null while it runs.
interface StepReport {
  at: string;
  effect: Effect["kind"];
  name: string;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
}

interface Effects {
  op: (effect: OpEffect) => Promise<Outcome>;
  check: (effect: CheckEffect) => Promise<Outcome>;
  session: (effect: SessionEffect) => Promise<Outcome>;
  save: (state: State) => Promise<Outcome>;
  clock: () => Date;
  stopping: () => StopSignal | null;
  step: (step: StepReport) => void;
}

// Where a run starts: the job's stage and the issue's saved state.
interface Entry {
  stage: string;
  saved: State;
}

type RunEnd = End | { kind: "interrupted"; signal: StopSignal };

// A run's durable side: its stage and the state it last saved.
interface Run<D> {
  writes: Writes<D>;
  effects: Effects;
  stage: string;
  saved: State;
}

type Performed =
  | { kind: "signal"; signal: StopSignal }
  | { kind: "done"; outcome: Outcome };

// Runs `act` unless a signal is pending, and gives the signal ahead of its
// result when one came while it ran.
async function perform(
  effects: Effects,
  act: () => Promise<Outcome>,
): Promise<Performed> {
  const before = effects.stopping();
  if (before !== null) {
    return { kind: "signal", signal: before };
  }
  const outcome = await act();
  const after = effects.stopping();
  if (after !== null) {
    return { kind: "signal", signal: after };
  }
  return { kind: "done", outcome };
}

async function save<D>(run: Run<D>, data: D, end: boolean): Promise<Performed> {
  const state = writtenState(run, data, end);
  const done = await perform(run.effects, () => run.effects.save(state));
  if (done.kind === "done" && done.outcome.ok) {
    run.saved = state;
  }
  return done;
}

function failedEnd(error: string): End {
  if (isNetworkError(error)) {
    return { kind: "held" };
  }
  return STEP_FAILED;
}

// Saves the issue at the end and ends the run, or ends it as a failed step
// when the save fails; a `next` end carries on at its stage's entry.
async function finish<S extends string, D>(
  run: Run<D>,
  walk: Walk<S, D>,
  data: D,
  end: End,
): Promise<RunEnd> {
  if (end.kind === "saved" || end.kind === "next") {
    run.stage = end.stage;
  }
  const done = await save(run, data, end.kind !== "next");
  if (done.kind === "signal") {
    return { kind: "interrupted", signal: done.signal };
  }
  if (!done.outcome.ok) {
    return failedEnd(done.outcome.error);
  }
  if (end.kind !== "next") {
    return end;
  }
  return await enter(run, walk, run.saved);
}

async function enter<S extends string, D>(
  run: Run<D>,
  walk: Walk<S, D>,
  saved: State,
): Promise<RunEnd> {
  let position: Position<S, D>;
  try {
    position = walk.start(saved);
  } catch {
    return STEP_FAILED;
  }
  return await advance(run, walk, position);
}

function execute(effects: Effects, effect: Effect): Promise<Outcome> {
  switch (effect.kind) {
    case "op":
      return effects.op(effect);
    case "check":
      return effects.check(effect);
    case "session":
      return effects.session(effect);
    case "end":
      return Promise.resolve({ ok: false, error: "an end isn't run" });
    default:
      return unreachable(effect);
  }
}

function resultName(outcome: Outcome): string {
  if (outcome.ok) {
    return outcome.name;
  }
  return "failed";
}

function nameOf(effect: Effect): string {
  switch (effect.kind) {
    case "op":
      return effect.op;
    case "check":
      return effect.check;
    case "session":
      return effect.name;
    case "end":
      return effect.end.kind;
    default:
      return unreachable(effect);
  }
}

// Runs the position's effect, reported as a step, and its result's name.
async function stepOf<S extends string, D>(
  run: Run<D>,
  position: Position<S, D>,
): Promise<Performed> {
  const { effects } = run;
  const { at, effect } = position;
  const report = { at, effect: effect.kind, name: nameOf(effect) };
  const startedAt = effects.clock().toISOString();
  effects.step({ ...report, startedAt, endedAt: null, result: null });
  const done = await perform(effects, () => execute(effects, effect));
  let result = "interrupted";
  if (done.kind === "done") {
    result = resultName(done.outcome);
  }
  const endedAt = effects.clock().toISOString();
  effects.step({ ...report, startedAt, endedAt, result });
  return done;
}

async function advance<S extends string, D>(
  run: Run<D>,
  walk: Walk<S, D>,
  position: Position<S, D>,
): Promise<RunEnd> {
  const { effect, data } = position;
  if (effect.kind === "end") {
    return await finish(run, walk, data, effect.end);
  }
  if (effect.kind === "session" && position.kind !== "session") {
    return await finish(run, walk, data, STEP_FAILED);
  }
  const done = await stepOf(run, position);
  if (done.kind === "signal") {
    return { kind: "interrupted", signal: done.signal };
  }
  const { outcome } = done;
  let result: Result<string> = { name: "failed", reply: null };
  if (outcome.ok) {
    result = { name: outcome.name, reply: outcome.reply };
  } else if (walk.takesFailure(position)) {
    result = { name: "failed", reply: outcome.error };
  } else {
    return await finish(run, walk, data, failedEnd(outcome.error));
  }
  let next: Position<S, D>;
  try {
    next = walk.next(position, result);
  } catch {
    return await finish(run, walk, data, STEP_FAILED);
  }
  return await checkpoint(run, walk, next);
}

// Saves the issue when a declared checkpoint changed, then goes on.
async function checkpoint<S extends string, D>(
  run: Run<D>,
  walk: Walk<S, D>,
  next: Position<S, D>,
): Promise<RunEnd> {
  const { data } = next;
  if (
    next.effect.kind !== "end" &&
    checkpointsChanged(data, run.writes, run.saved)
  ) {
    const done = await save(run, data, false);
    if (done.kind === "signal") {
      return { kind: "interrupted", signal: done.signal };
    }
    if (!done.outcome.ok) {
      return await finish(run, walk, data, failedEnd(done.outcome.error));
    }
  }
  return await advance(run, walk, next);
}

function runOf<D>(writes: Writes<D>, entry: Entry, effects: Effects): Run<D> {
  const { handoff, checkpoints } = writes;
  const { stage, saved } = entry;
  return { writes: { handoff, checkpoints }, effects, stage, saved };
}

// Runs a machine role from `entry` to its end, or to a signal.
async function runMachine<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
  entry: Entry,
  effects: Effects,
): Promise<RunEnd> {
  const run = runOf(machine, entry, effects);
  return await enter(run, machineWalk(machine), entry.saved);
}

// Runs a linear role from `entry` to its end, or to a signal.
async function runLinear<D>(
  script: LinearScript<D>,
  entry: Entry,
  effects: Effects,
): Promise<RunEnd> {
  const run = runOf(script, entry, effects);
  return await enter(run, linearWalk(script), entry.saved);
}

function unreachable(value: never): never {
  throw new Error(`runner: unexpected ${JSON.stringify(value)}`);
}

export type {
  CheckEffect,
  Effects,
  Entry,
  OpEffect,
  Outcome,
  RunEnd,
  StepReport,
};
export { runLinear, runMachine };
