// A role run's steps as job.json shows them (src/job/status.ts): each effect
// the runner runs, by kind and name, when it started and ended, and the name
// of its result, or `failed`, or `interrupted` when a signal came.

import type { Effect } from "../roles/machine.ts";
import type { Outcome } from "./run-step.ts";

// One step as job.json shows it; endedAt and result are null while it runs.
interface StepReport {
  at: string;
  effect: Effect["kind"];
  name: string;
  startedAt: string;
  endedAt: string | null;
  result: string | null;
}

// Where a step's report goes, and the clock that times it.
interface StepSink {
  clock: () => Date;
  step: (step: StepReport) => void;
}

// What a step came to: its outcome, or a signal that came first.
type Stepped = { kind: "signal" } | { kind: "done"; outcome: Outcome };

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

function resultOf(done: Stepped): string {
  if (done.kind === "signal") {
    return "interrupted";
  }
  if (done.outcome.ok) {
    return done.outcome.name;
  }
  return "failed";
}

// Runs `act`, the step of `effect` at state `at`, reporting it to `sink`
// when it starts and when it ends.
async function reportedStep<P extends Stepped>(
  sink: StepSink,
  at: string,
  effect: Effect,
  act: () => Promise<P>,
): Promise<P> {
  const report = { at, effect: effect.kind, name: nameOf(effect) };
  const startedAt = sink.clock().toISOString();
  sink.step({ ...report, startedAt, endedAt: null, result: null });
  const done = await act();
  const endedAt = sink.clock().toISOString();
  sink.step({ ...report, startedAt, endedAt, result: resultOf(done) });
  return done;
}

function unreachable(value: never): never {
  throw new Error(`step report: unexpected ${JSON.stringify(value)}`);
}

export type { StepReport };
export { reportedStep };
