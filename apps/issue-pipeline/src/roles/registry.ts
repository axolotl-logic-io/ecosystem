// Which stages run a role on the role runner (src/job/runner.ts), and the
// builders that make a role from a machine or a linear script. It registers
// each built role as it loads, triage, the spec writer and the implementor
// so far; a stage
// with no role runs the sweep as before (src/job.ts).
// A role keeps its own types inside its `run`, so the registry holds one
// non-generic shape for every role.

import type { Config } from "../config.ts";
import type { CheckEffect, Effects, Outcome } from "../job/run-step.ts";
import type { Entry, RunEnd } from "../job/runner.ts";
import { runLinear, runMachine } from "../job/runner.ts";
import { implementorChecks } from "./implementor/checks.ts";
import {
  IMPLEMENTOR_STAGES,
  implementorMachine,
} from "./implementor/implementor.ts";
import { specWriterChecks } from "./spec-writer/checks.ts";
import { specWriterMachine } from "./spec-writer/machine.ts";
import { triageScript } from "./triage/script.ts";
import type { LinearScript, Machine } from "./walk.ts";

// The effects a job gives a role: all but the script checks, which are the
// role's own.
type JobEffects = Omit<Effects, "check">;

// A role's script checks, by name.
type Checks = Readonly<
  Record<string, (payload: CheckEffect["payload"]) => Promise<Outcome>>
>;

// A role's script checks for one run: they may read the run's entry, run
// ops through its effects, and read the job's config (its git, wiki and
// command settings).
type ChecksOf = (entry: Entry, effects: JobEffects, cfg: Config) => Checks;

// The pipeline's roles (the wiki's Pipeline-Roles page).
type RoleName =
  | "triage"
  | "spec-writer"
  | "implementor"
  | "reviewer"
  | "finalizer";

const ROLE_NAMES: readonly RoleName[] = [
  "triage",
  "spec-writer",
  "implementor",
  "reviewer",
  "finalizer",
];

interface Role {
  name: RoleName;
  kind: "machine" | "linear";
  run: (entry: Entry, effects: JobEffects, cfg: Config) => Promise<RunEnd>;
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
  name: RoleName,
  machine: Machine<S, R, D>,
  checksOf: ChecksOf = (): Checks => ({}),
): Role {
  return {
    name,
    kind: "machine",
    run: (entry: Entry, effects: JobEffects, cfg: Config): Promise<RunEnd> => {
      const check = checkOf(checksOf(entry, effects, cfg));
      return runMachine(machine, entry, { ...effects, check });
    },
  };
}

function linearRole<D>(
  name: RoleName,
  script: LinearScript<D> & { checks?: Checks },
): Role {
  const check = checkOf(script.checks ?? {});
  return {
    name,
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

registerRole("triage", linearRole("triage", triageScript));
registerRole(
  "spec",
  machineRole("spec-writer", specWriterMachine, specWriterChecks),
);

const implementor = machineRole(
  "implementor",
  implementorMachine,
  implementorChecks,
);
for (const stage of IMPLEMENTOR_STAGES) {
  registerRole(stage, implementor);
}

export type { Checks, ChecksOf, JobEffects, Role, RoleName };
export { linearRole, machineRole, ROLE_NAMES, registerRole, roleOf };
