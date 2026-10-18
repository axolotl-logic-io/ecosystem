// The pipeline role that starts each stage, and the roles one orchestrator
// runs (#417): the --roles flag's, else the config's orchestratorRoles, else
// all of them. An issue whose next stage belongs to a role that isn't
// running is held `role-off:<role>`. Pure.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { RoleName } from "../roles/registry.ts";
import { ROLE_NAMES } from "../roles/registry.ts";
import type { StageName } from "../workflow/stages/types.ts";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";

// The wiki's Pipeline-Roles-Orchestrator table, "Run only the chosen roles".
const STAGE_ROLES: Readonly<Record<StageName, RoleName>> = {
  triage: "triage",
  spec: "spec-writer",
  implement: "implementor",
  "open-pr": "implementor",
  fix: "implementor",
  sync: "implementor",
  checks: "implementor",
  review: "reviewer",
  accept: "reviewer",
  security: "reviewer",
  merge: "finalizer",
  publish: "finalizer",
};

const ROLES_KEY = "orchestratorRoles";
const CONFIG_ROLES = z.looseObject({
  [ROLES_KEY]: z.array(z.string()).min(1).nullable().optional(),
});

function isRole(name: string): name is RoleName {
  return ROLE_NAMES.some((role) => role === name);
}

function isStage(stage: string): stage is StageName {
  return STAGE_ORDER.some((name) => name === stage);
}

// The role that starts `stage`, by the names in ROLE_NAMES.
function roleOfStage(stage: StageName): RoleName {
  return STAGE_ROLES[stage];
}

// `names` as roles in ROLE_NAMES order, less repeats; throws naming `source`
// and the first name that is no role, or when there is no name.
function chosenOf(names: readonly string[], source: string): RoleName[] {
  if (names.length === 0) {
    throw new Error(`${source} names no role`);
  }
  const unknown = names.find((name) => !isRole(name));
  if (unknown !== undefined) {
    const known = ROLE_NAMES.join(", ");
    throw new Error(
      `${source} names an unknown role ${JSON.stringify(unknown)}; the roles are ${known}`,
    );
  }
  const chosen = new Set(names);
  return ROLE_NAMES.filter((role) => chosen.has(role));
}

// The config's orchestratorRoles, or null when it is null or absent.
function configuredRoles(cfg: Config): RoleName[] | null {
  const parsed = CONFIG_ROLES.safeParse(cfg);
  if (!parsed.success) {
    throw new Error(`${ROLES_KEY}: ${z.prettifyError(parsed.error)}`);
  }
  const { [ROLES_KEY]: names } = parsed.data;
  if (names === null || names === undefined) {
    return null;
  }
  return chosenOf(names, ROLES_KEY);
}

// The roles to run, in ROLE_NAMES order: the flag's, else the config's
// orchestratorRoles, else all five. Throws, naming it, on an unknown or empty
// role name, or an orchestratorRoles that names no role, even when the flag
// overrides it.
function rolesOf(
  args: { roles?: readonly string[] | undefined },
  cfg: Config,
): RoleName[] {
  const configured = configuredRoles(cfg);
  if (args.roles !== undefined) {
    return chosenOf(args.roles, "--roles");
  }
  return configured ?? [...ROLE_NAMES];
}

// Why a job at `stage` may not start with only `roles` running:
// `role-off:<role>` when `roles` is set and leaves out the stage's role;
// null when `roles` is unset or `stage` is no stage.
function roleOffReason(
  roles: readonly RoleName[] | undefined,
  stage: string,
): string | null {
  if (roles === undefined || !isStage(stage)) {
    return null;
  }
  const role = roleOfStage(stage);
  if (roles.includes(role)) {
    return null;
  }
  return `role-off:${role}`;
}

export { roleOffReason, roleOfStage, rolesOf };
