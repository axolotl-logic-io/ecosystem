// The role runner (`role-state-machines` in the wiki's Pipeline-Roles-Shared
// page): it runs a role's locate over the issue's saved state, then each
// state's effect, then the role's transition, until an end, reporting every
// step. It alone decides how a failure the role doesn't list ends (held on a
// network error, stopped with the step-failure code otherwise), refuses a
// session from a non-session state, and decides what is saved and when: only
// the role's declared hand-off fields and checkpoints, saved at every end
// and as soon as a checkpoint changes, so a count is saved when it goes up.
// It reads nothing but the saved state it is given (`every-role-resumes`).
// It appends a usage entry for every session that ends and for the run.

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
import type { RunUsage, UsageEntry } from "./run-usage.ts";
import { runUsage } from "./run-usage.ts";
import type { StopSignal } from "./status.ts";
import type { StepReport } from "./step-report.ts";
import { reportedStep } from "./step-report.ts";
import type { LaunchUsage } from "./usage-tally.ts";

// The end of a failed step, with the step-failure stop code (src/stops.ts).
const STEP_FAILED: End = { kind: "stopped", code: "error" };

type OpEffect = Extract<Effect, { kind: "op" }>;
type CheckEffect = Extract<Effect, { kind: "check" }>;

// What an effect came to: a named result with its reply, or a failure.
type Outcome =
  | { ok: true; name: string; reply: unknown }
  | { ok: false; error: string };

interface Effects {
  op: (effect: OpEffect) => Promise<Outcome>;
  check: (effect: CheckEffect) => Promise<Outcome>;
  session: (
    effect: SessionEffect,
  ) => Promise<{ outcome: Outcome; launch: LaunchUsage }>;
  // Appends a usage entry; it never rejects.
  usage: (entry: UsageEntry) => Promise<void>;
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
  usage: RunUsage;
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
    run.usage.moved(end.stage);
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

// Runs session `effect` at `state` and appends its usage entry.
async function session<D>(
  run: Run<D>,
  state: string,
  effect: SessionEffect,
): Promise<Outcome> {
  const { effects } = run;
  const { outcome, launch } = await effects.session(effect);
  const signalled = effects.stopping() !== null;
  const { stage } = run;
  const finished = { at: effects.clock(), stage, state, effect, launch };
  await effects.usage(run.usage.session({ ...finished, outcome, signalled }));
  return outcome;
}

function execute<D>(run: Run<D>, at: string, effect: Effect): Promise<Outcome> {
  const { effects } = run;
  switch (effect.kind) {
    case "op":
      return effects.op(effect);
    case "check":
      return effects.check(effect);
    case "session":
      return session(run, at, effect);
    case "end":
      return Promise.resolve({ ok: false, error: "an end isn't run" });
    default:
      return unreachable(effect);
  }
}

// Runs the position's effect, reported as a step.
function stepOf<S extends string, D>(
  run: Run<D>,
  position: Position<S, D>,
): Promise<Performed> {
  const { at, effect } = position;
  return reportedStep(run.effects, at, effect, () =>
    perform(run.effects, () => execute(run, at, effect)),
  );
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

// Runs `walk` from `entry` to its end, or to a signal, saving `writes`,
// then appends the run's usage entry.
async function runWalk<S extends string, D>(
  walk: Walk<S, D>,
  writes: Writes<D>,
  entry: Entry,
  effects: Effects,
): Promise<RunEnd> {
  const { stage, saved } = entry;
  const usage = runUsage(stage, effects.clock());
  const run: Run<D> = { writes, effects, stage, saved, usage };
  const end = await enter(run, walk, saved);
  await effects.usage(usage.job(end, run.saved, effects.clock()));
  return end;
}

// Runs a machine role from `entry` to its end, or to a signal.
function runMachine<S extends string, R extends string, D>(
  machine: Machine<S, R, D>,
  entry: Entry,
  effects: Effects,
): Promise<RunEnd> {
  return runWalk(machineWalk(machine), machine, entry, effects);
}

// Runs a linear role from `entry` to its end, or to a signal.
function runLinear<D>(
  script: LinearScript<D>,
  entry: Entry,
  effects: Effects,
): Promise<RunEnd> {
  return runWalk(linearWalk(script), script, entry, effects);
}

function unreachable(value: never): never {
  throw new Error(`runner: unexpected ${JSON.stringify(value)}`);
}

export type { CheckEffect, Effects, Entry, OpEffect, Outcome, RunEnd };
export { runLinear, runMachine };
