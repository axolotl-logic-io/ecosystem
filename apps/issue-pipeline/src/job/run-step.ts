// One step of a role's run (src/job/runner.ts): the effects a job gives the
// runner, what an effect comes to, and how one runs: never started, or its
// result set aside, once a stop signal is pending.

import type { Effect, SessionEffect } from "../roles/machine.ts";
import type { State } from "../state.ts";
import type { UsageEntry } from "./run-usage.ts";
import type { StopSignal } from "./status.ts";
import type { StepReport } from "./step-report.ts";
import type { LaunchUsage } from "./usage-tally.ts";

type OpEffect = Extract<Effect, { kind: "op" }>;
type CheckEffect = Extract<Effect, { kind: "check" }>;

// What an effect came to: a named result with its reply, or a failure.
type Outcome =
  | { ok: true; name: string; reply: unknown }
  | { ok: false; error: string };

interface Effects {
  op: (effect: OpEffect) => Promise<Outcome>;
  check: (effect: CheckEffect) => Promise<Outcome>;
  // Runs the session, giving its outcome, its usage and its launch key.
  session: (
    effect: SessionEffect,
  ) => Promise<{ outcome: Outcome; launch: LaunchUsage; key: string }>;
  // Appends a usage entry; it never rejects.
  usage: (entry: UsageEntry) => Promise<void>;
  save: (state: State) => Promise<Outcome>;
  clock: () => Date;
  stopping: () => StopSignal | null;
  step: (step: StepReport) => void;
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

export type { CheckEffect, Effects, OpEffect, Outcome, Performed };
export { perform };
