// Which stages run a role on the role runner (src/job/runner.ts), and the
// builders that make a role from a machine or a linear script. The registry
// starts empty: a stage with no role runs the sweep as before (src/job.ts).
// A role keeps its own types inside its `run`, so the registry holds one
// non-generic shape for every role.

import type {
  CheckEffect,
  Effects,
  Entry,
  Outcome,
  RunEnd,
} from "../job/runner.ts";
import { runLinear, runMachine } from "../job/runner.ts";
import type { LinearScript, Machine } from "./walk.ts";

// The effects a job gives a role: all but the script checks, which are the
// role's own.
type JobEffects = Omit<Effects, "check">;

// A role's script checks, by name.
type Checks = Readonly<
  Record<string, (payload: CheckEffect["payload"]) => Promise<Outcome>>
>;

interface Role {
  kind: "machine" | "linear";
  run: (entry: Entry, effects: JobEffects) => Promise<RunEnd>;
}

const ROLES = new Map<string, Role>();

// The check effect over `checks`; a check the role doesn't have fails.
function checkOf(checks: Checks): Effects["check"] {
  return async (effect: CheckEffect): Promise<Outcome> => {
    const { [effect.check]: check } = checks;
    if (check === undefined) {
      return { ok: false, error: `no check named ${effect.check}` };
    }
    return await check(effect.payload);
  };
}

function machineRole<S extends string, R extends string, D>(
  machine: Machine<S, R, D> & { checks?: Checks },
): Role {
  const check = checkOf(machine.checks ?? {});
  return {
    kind: "machine",
    run: (entry: Entry, effects: JobEffects): Promise<RunEnd> =>
      runMachine(machine, entry, { ...effects, check }),
  };
}

function linearRole<D>(script: LinearScript<D> & { checks?: Checks }): Role {
  const check = checkOf(script.checks ?? {});
  return {
    kind: "linear",
    run: (entry: Entry, effects: JobEffects): Promise<RunEnd> =>
      runLinear(script, entry, { ...effects, check }),
  };
}

// Makes `stage` run `role`.
function registerRole(stage: string, role: Role): void {
  ROLES.set(stage, role);
}

// The role `stage` runs, or undefined when it runs the sweep.
function roleOf(stage: string): Role | undefined {
  return ROLES.get(stage);
}

export type { Checks, JobEffects, Role };
export { linearRole, machineRole, registerRole, roleOf };
