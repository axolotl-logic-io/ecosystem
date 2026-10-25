// Declared access-profile networks and model-child environment isolation.
// These settings grant no task, account or filesystem authority. Network
// declarations are metadata, not an enforced sandbox.
import { childEnvironment } from "../child-env.ts";
import type { JobRolesConfig } from "../config-schema.ts";
import type { AccessProfile } from "../domain.ts";
import { COMMIT_SCOPE_ENV } from "./pipeline-commit.ts";

interface RoleSettings {
  tokenEnv: string | undefined;
  network: readonly string[];
}
type Roles = Readonly<Record<AccessProfile, RoleSettings>>;
type EnvSource = Readonly<Record<string, string | undefined>>;

const DEFAULT_ROLES: Roles = {
  reader: { tokenEnv: undefined, network: ["api.anthropic.com"] },
  writer: {
    tokenEnv: undefined,
    network: ["api.anthropic.com", "registry.npmjs.org"],
  },
  lander: {
    tokenEnv: undefined,
    network: ["api.github.com", "api.anthropic.com", "registry.npmjs.org"],
  },
};

function mergedRole(
  base: RoleSettings,
  entry: JobRolesConfig["reader"],
): RoleSettings {
  return {
    tokenEnv: entry?.tokenEnv ?? base.tokenEnv,
    network: entry?.network ?? base.network,
  };
}

function rolesOf(config: JobRolesConfig | null | undefined): Roles {
  return {
    reader: mergedRole(DEFAULT_ROLES.reader, config?.reader),
    writer: mergedRole(DEFAULT_ROLES.writer, config?.writer),
    lander: mergedRole(DEFAULT_ROLES.lander, config?.lander),
  };
}

// Remove credentials and any inherited commit scope. Only the current
// session's explicit commit boundary may later supply its own scope.
function agentEnvOf(roles: Roles, from: EnvSource): Record<string, string> {
  const hidden = new Set([COMMIT_SCOPE_ENV]);
  for (const settings of Object.values(roles)) {
    if (settings.tokenEnv !== undefined) {
      hidden.add(settings.tokenEnv);
    }
  }
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(childEnvironment(from))) {
    if (value !== undefined && !hidden.has(name)) {
      env.set(name, value);
    }
  }
  return Object.fromEntries(env);
}

export { agentEnvOf, rolesOf };
