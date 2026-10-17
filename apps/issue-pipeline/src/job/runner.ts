// The role runner (`role-state-machines` in the wiki's Pipeline-Roles-Shared
// page): it runs a role's locate over the issue's saved state, then each
// state's effect, then the role's transition, until an end, reporting every
// step. It alone decides how a failure the role doesn't list ends (held on a
// network error; held on a model provider's rate limit with the state it
// last saved, counting no attempt (`rate-limit-defers`); stopped with the
// step-failure code otherwise), refuses a session from a non-session state,
// and decides what is saved and when: only the role's declared hand-off
// fields and checkpoints, saved at every end and as soon as a checkpoint
// changes, so a count is saved when it goes up. An end's own op runs after
// the end's save, on the state just saved. It reads nothing but the saved
// state and context it is given (`every-role-resumes`). It appends a usage
// entry for every session that ends and for the run.

import type { Effect, End, Result, SessionEffect } from "../roles/machine.ts";
import type {
  LinearScript,
  Machine,
  Position,
  RoleContext,
  Walk,
  Writes,
} from "../roles/walk.ts";
import { linearWalk, machineWalk } from "../roles/walk.ts";
import type { State } from "../state.ts";
import { isNetworkError } from "../workflow/stages/network.ts";
import { isRateLimitError } from "../workflow/stages/rate-limit.ts";
import { checkpointsChanged, writtenState } from "./role-state.ts";
import type { Effects, Outcome, Performed } from "./run-step.ts";
import { perform } from "./run-step.ts";
import type { RunUsage } from "./run-usage.ts";
import { runUsage } from "./run-usage.ts";
import type { StopSignal } from "./status.ts";
import { reportedStep } from "./step-report.ts";

// The end of a failed step, with the step-failure stop code (src/stops.ts).
const STEP_FAILED: End = { kind: "stopped", code: "error" };

// Where a run starts: the job's stage, the issue's saved state and what
// the role's locate reads besides it.
interface Entry {
  stage: string;
  saved: State;
  context: RoleContext;
}

type RunEnd = End | { kind: "interrupted"; signal: StopSignal };

// A run's durable side: its stage and the state it last saved.
interface Run<D> {
  writes: Writes<D>;
  effects: Effects;
  context: RoleContext;
  stage: string;
  saved: State;
  usage: RunUsage;
}

async function save<D>(run: Run<D>, data: D, end: boolean): Promise<Performed> {
  const state = writtenState(run, data, end);
  const done = await perform(run.effects, () => run.effects.save(state));
  if (done.kind === "done" && done.outcome.ok) {
    run.saved = state;
  }
  return done;
}

// Saves the state the run last saved with no lease, dropping what the run
// did since, such as a count it took at its start.
function release<D>(run: Run<D>): Promise<Performed> {
  const state = { ...run.saved, lease: null };
  return perform(run.effects, () => run.effects.save(state));
}

function failedEnd(error: string): End {
  if (isRateLimitError(error)) {
    return { kind: "held", rateLimited: true };
  }
  if (isNetworkError(error)) {
    return { kind: "held" };
  }
  return STEP_FAILED;
}

// The end as the run returns it, without its own op.
function bareEnd(end: End): End {
  if (end.kind === "stopped") {
    return { kind: "stopped", code: end.code };
  }
  if (end.kind === "released") {
    return { kind: "released" };
  }
  return end;
}

// Runs the end's own op, if it has one, on the state just saved, reported
// as a step at `end`; its failure ends the run as a failed step would.
async function settle<D>(run: Run<D>, end: End): Promise<RunEnd> {
  if (!(end.kind === "stopped" || end.kind === "released")) {
    return end;
  }
  const { after } = end;
  if (after === undefined) {
    return end;
  }
  const payload = { ...after.payload, state: run.saved };
  const effect: Effect = { kind: "op", op: after.op, payload };
  const done = await stepOf(run, { at: "end", effect });
  if (done.kind === "signal") {
    return { kind: "interrupted", signal: done.signal };
  }
  if (!done.outcome.ok) {
    return failedEnd(done.outcome.error);
  }
  return bareEnd(end);
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
  let done: Performed;
  if (end.kind === "held" && end.rateLimited === true) {
    done = await release(run);
  } else {
    done = await save(run, data, end.kind !== "next");
  }
  if (done.kind === "signal") {
    return { kind: "interrupted", signal: done.signal };
  }
  if (!done.outcome.ok) {
    return failedEnd(done.outcome.error);
  }
  if (end.kind !== "next") {
    return await settle(run, end);
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
    position = walk.start(saved, run.context);
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

// Runs the position's effect, reported as a step, unless a signal is
// pending, and gives its outcome or the signal.
function stepOf<D>(
  run: Run<D>,
  position: { at: string; effect: Effect },
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
  const { stage, saved, context } = entry;
  const usage = runUsage(stage, effects.clock());
  const run: Run<D> = { writes, effects, context, stage, saved, usage };
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

export type { Entry, RunEnd };
export { runLinear, runMachine };
